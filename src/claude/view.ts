import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentTerminals, claudeAgentName, OpenAgent, promptArgument, stateText } from '../agents';
import { usagePause, UsagePause } from '../autopilot/core';
import type { Controller } from '../controller';
import type { GraphState } from '../model';
import { locale, t } from '../i18n';
import type { RateLimit } from './statusLine';
import type { LiveLimits } from './usage';
import { runHeadless } from './headless';
import {
  currentBlock,
  dailyTotals,
  emptyCache,
  formatTokens,
  listClaudeCommands,
  mapToWorktrees,
  MergePart,
  mergeSource,
  readTurns,
  recapSummaryPrompt,
  RecapGit,
  renderLastMessage,
  renderMergeRecap,
  renderRecap,
  renderTranscript,
  scanSessions,
  ScanCache,
  ClaudeCommand,
  SessionInfo,
  sessionsOfBranch,
  sessionTitle,
  totalTokens,
  weekWindow,
  weighted,
} from './sessions';

export const TRANSCRIPT_SCHEME = 'wtgraph-claude';
const RESCAN_MS = 60_000;

const norm = (p: string) => path.normalize(p).replace(/[\\/]+$/, '').toLowerCase();

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return t('now');
  if (s < 3600) return t('{0} min ago', Math.floor(s / 60));
  if (s < 86400) return t('{0} h ago', Math.floor(s / 3600));
  if (s < 86400 * 30) return t('{0} d ago', Math.floor(s / 86400));
  return new Date(ms).toLocaleDateString(locale());
}

function sourceLabel(source: ClaudeCommand['source']): string {
  if (source === 'project') return t('project');
  if (source === 'user') return t('user');
  if (source === 'builtin') return t('built-in');
  return source;
}

/** Citação em Markdown, cortada. */
function clipQuote(text: string, max: number): string {
  const s = text.length > max ? `${text.slice(0, max - 1)}…` : text;
  return s.split('\n').map(l => `> ${l}`).join('\n');
}

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

/**
 * Lê os logs do Claude Code em segundo plano (incremental, com cache em disco) e alimenta a view de
 * sessões, a barra de status de uso e os chips dos cards.
 */
export class ClaudeService implements vscode.Disposable {
  sessions: SessionInfo[] = [];
  private cache: ScanCache = emptyCache();
  private scanning?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private saveTimer?: NodeJS.Timeout;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  private readonly disposables: vscode.Disposable[] = [this.changed, this.status];
  private rescan?: NodeJS.Timeout;
  loaded = false;

  /** Os terminais do Claude são os mesmos dos agentes (AgentTerminals): estado, hooks e "pronto para revisar". */
  constructor(readonly ctl: Controller, readonly agentTerms: AgentTerminals) {
    this.status.command = 'worktreeGraph.claude.usage';
    this.status.name = t('Claude Code usage');
    this.loadCache();
    ctl.stateHooks.push(s => this.applyToState(s));
    this.disposables.push(
      // fim de turno: tokens e título novos no log; relê logo em vez de esperar o minuto
      agentTerms.onDidChangeState(({ open }) => {
        if (open.state !== 'idle' && open.state !== 'ended') return;
        if (this.rescan) clearTimeout(this.rescan);
        this.rescan = setTimeout(() => this.scan(), 1500);
      }),
      vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('worktreeGraph.claude') && this.updateStatus()),
    );
    // Primeira leitura depois que a extensão já desenhou o resto; depois, a cada minuto com a janela em foco.
    setTimeout(() => this.scan(), 2500);
    this.timer = setInterval(() => vscode.window.state.focused && this.scan(), RESCAN_MS);
  }

  cfg() {
    return vscode.workspace.getConfiguration('worktreeGraph.claude');
  }

  claudeDir(): string {
    return this.cfg().get<string>('configDir', '') || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  }

  private cacheFile() {
    return vscode.Uri.joinPath(this.ctl.ctx.globalStorageUri, 'claude-sessions.json').fsPath;
  }

  private loadCache() {
    try {
      const c = JSON.parse(fs.readFileSync(this.cacheFile(), 'utf8')) as ScanCache;
      if (c && c.entries) this.cache = c;
    } catch {
      // primeira vez
    }
  }

  private saveCache() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(this.cacheFile()), { recursive: true });
        fs.writeFileSync(this.cacheFile(), JSON.stringify(this.cache));
      } catch (e) {
        this.ctl.log(t('Claude sessions: couldn\'t save the cache: {0}', (e as Error).message));
      }
    }, 2000);
  }

  scan(): Promise<void> {
    if (this.scanning) return this.scanning;
    const first = !this.loaded;
    if (first) {
      this.status.text = '$(loading~spin) ' + t('Claude: reading sessions…');
      this.status.show();
    }
    this.scanning = (async () => {
      const t0 = Date.now();
      try {
        const r = await scanSessions(this.claudeDir(), this.cache);
        this.sessions = r.sessions;
        if (r.filesRead) this.saveCache();
        if (first || r.filesRead) this.ctl.log(t('Claude sessions: {0} sessions, {1} file(s) read ({2} MB) in {3} ms', r.sessions.length, r.filesRead, (r.bytesRead / 1e6).toFixed(1), Date.now() - t0));
        const changed = first || r.filesRead > 0;
        this.loaded = true;
        this.updateStatus();
        if (changed) {
          this.changed.fire();
          this.ctl.scheduleRefresh(50);
        }
      } catch (e) {
        this.ctl.log(t('Claude sessions: {0}', (e as Error).message));
      }
    })().finally(() => (this.scanning = undefined));
    return this.scanning;
  }

  /** Sessões por worktree do repositório ativo. */
  byWorktree(): Map<string, SessionInfo[]> {
    const paths = this.ctl.state?.worktrees.filter(w => !w.prunable && !w.bare).map(w => w.path) ?? [];
    return mapToWorktrees(this.sessions, paths);
  }

  /** Chip dos cards: preenchido a partir do que já foi lido, sem custo. */
  private applyToState(s: GraphState) {
    if (!this.loaded) return;
    const m = mapToWorktrees(
      this.sessions,
      s.worktrees.filter(w => !w.prunable && !w.bare).map(w => w.path),
    );
    for (const w of s.worktrees) {
      const list = m.get(w.path);
      const replied = list?.find(x => x.lastReply);
      w.claude = list?.length
        ? {
            sessions: list.length,
            tokens: list.reduce((n, x) => n + weighted(x.usage), 0),
            last: Math.max(...list.map(x => x.end)),
            lastId: list[0].id,
            lastReply: replied?.lastReply,
            lastReplyAt: replied?.lastReplyAt,
            lastPrompt: replied?.lastPrompt,
          }
        : undefined;
    }
  }

  private budgets() {
    return { session: this.cfg().get<number>('sessionBudgetTokens', 0), week: this.cfg().get<number>('weeklyBudgetTokens', 0) };
  }

  /** A fila de tarefas deve esperar? (uso estimado perto do orçamento, `tasks.pauseAtUsage`) */
  usagePause(now = Date.now()): UsagePause | undefined {
    if (!this.loaded) return undefined;
    const b = this.budgets();
    const block = currentBlock(this.sessions, now, this.cfg().get<number>('blockHours', 5));
    return usagePause({
      limitPct: this.ctl.cfg().get<number>('tasks.pauseAtUsage', 90),
      block,
      sessionBudget: b.session,
      week: weekWindow(this.sessions, this.weekMode(), now),
      weekBudget: b.week,
      weekRolling: this.weekMode() === 'rolling',
      now,
    });
  }

  private weekMode(): 'rolling' | 'monday' {
    return this.cfg().get<string>('weekStart', 'rolling') === 'monday' ? 'monday' : 'rolling';
  }

  /** Limites reais do plano, vindos da statusline (src/claude/usage.ts); preenchido no registro. */
  liveLimits?: () => LiveLimits | undefined;

  updateStatus() {
    if (!this.cfg().get<boolean>('showUsageInStatusBar', true)) {
      this.status.hide();
      return;
    }
    const live = this.liveLimits?.();
    if (live && (live.fiveHour || live.sevenDay)) {
      const pctText = (r?: RateLimit) => (r ? `${Math.round(r.pct)}%` : '—');
      const worst = Math.max(live.fiveHour?.pct ?? 0, live.sevenDay?.pct ?? 0);
      this.status.text = `$(sparkle) ${t('session {0} · week {1}', pctText(live.fiveHour), pctText(live.sevenDay))}`;
      this.status.backgroundColor = worst >= 80 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      const md = new vscode.MarkdownString(undefined, true);
      md.appendMarkdown(t('**Claude Code usage** — plan limits reported by Claude Code') + '\n\n');
      const line = (label: string, r?: RateLimit) =>
        r ? `${label}: **${Math.round(r.pct)}%**${r.resetsAt ? ` · ${t('resets {0}', new Date(r.resetsAt).toLocaleString(locale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' }))}` : ''}\n\n` : '';
      md.appendMarkdown(line(t('Session (5 h)'), live.fiveHour) + line(t('Week'), live.sevenDay));
      md.appendMarkdown(t('Updated {0}. Click for the usage screen.', ago(live.at)));
      this.status.tooltip = md;
      this.status.show();
      return;
    }
    this.status.backgroundColor = undefined;
    if (!this.sessions.length) {
      this.status.hide();
      return;
    }
    const b = this.budgets();
    const block = currentBlock(this.sessions, Date.now(), this.cfg().get<number>('blockHours', 5));
    const week = weekWindow(this.sessions, this.weekMode());
    const pct = (n: number, of: number) => (of > 0 ? ` (${Math.round((n / of) * 100)}%)` : '');
    const blockText = block ? `${formatTokens(block.tokens)}${pct(block.tokens, b.session)}` : '—';
    this.status.text = '$(sparkle) ' + t('5h {0} · wk {1}', blockText, `${formatTokens(week.tokens)}${pct(week.tokens, b.week)}`);
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(t('**Claude Code usage** — estimate from local logs') + '\n\n');
    md.appendMarkdown(
      block
        ? t('Current window: **{0}** tokens in {1} responses, from {2} to **{3}** (resets)', formatTokens(block.tokens), block.responses, hhmm(block.start), hhmm(block.end)) + '\n\n'
        : t('No active 5 h window right now.') + '\n\n',
    );
    md.appendMarkdown(t('{0}: **{1}** tokens in {2} responses', this.weekMode() === 'monday' ? t('Since Monday') : t('Last 7 days'), formatTokens(week.tokens), week.responses) + '\n\n');
    md.appendMarkdown(t('Counts input + cache creation + output; cache reads are left out. The plan\'s official limits aren\'t stored on disk: use `/usage` in Claude Code for the exact numbers.') + '\n\n');
    if (!b.session && !b.week) md.appendMarkdown(t('Set `worktreeGraph.claude.sessionBudgetTokens` and `weeklyBudgetTokens` to see the percentage.'));
    this.status.tooltip = md;
    this.status.show();
  }

  // ---------- ações ----------

  private agentName(): string {
    return claudeAgentName(this.ctl);
  }

  private branchOf(cwd: string): string | undefined {
    return this.ctl.state?.worktrees.find(w => norm(w.path) === norm(cwd))?.branch;
  }

  private start(cwd: string, command: string, name?: string) {
    return this.agentTerms.start(cwd, this.branchOf(cwd), this.agentName(), command, { name });
  }

  private existingDir(...candidates: (string | undefined)[]): string | undefined {
    return candidates.find(c => c && fs.existsSync(c));
  }

  /** Terminal aberto com esta sessão, se houver. */
  openFor(s: SessionInfo): OpenAgent | undefined {
    return this.agentTerms.findBySession(s.id);
  }

  /** Se a sessão já está aberta num terminal, traz ele para frente; senão abre com --resume. */
  async resume(s: SessionInfo): Promise<OpenAgent | undefined> {
    const open = this.openFor(s);
    if (open) {
      open.terminal.show();
      return open;
    }
    const cwd = this.existingDir(s.cwd, this.ctl.repo?.root);
    if (!cwd) {
      vscode.window.showWarningMessage(t('The session folder no longer exists: {0}', s.cwd ?? ''));
      return undefined;
    }
    return this.start(cwd, `claude --resume ${s.id}`, `${this.agentName()} · ${sessionTitle(s).slice(0, 30)}`);
  }

  newSession(cwd: string) {
    void this.start(cwd, 'claude');
  }

  async transcriptById(id: string) {
    const s = this.sessions.find(x => x.id === id);
    if (s) return this.transcript(s);
    await this.scan();
    const again = this.sessions.find(x => x.id === id);
    if (again) return this.transcript(again);
    vscode.window.showInformationMessage(t('Session {0} not found.', id));
  }

  async transcript(s: SessionInfo) {
    const uri = vscode.Uri.from({ scheme: TRANSCRIPT_SCHEME, path: `/${sessionTitle(s).replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 60)}.md`, query: s.id });
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  async renderById(id: string): Promise<string> {
    const s = this.sessions.find(x => x.id === id);
    return s ? renderTranscript(s) : t('Session {0} not found.', id);
  }

  /** Documentos gerados (última mensagem, recap), servidos pelo TranscriptProvider. */
  readonly docs = new Map<string, string>();
  readonly docChanged = new vscode.EventEmitter<vscode.Uri>();

  private async showDoc(key: string, name: string, content: string) {
    this.docs.set(key, content);
    const uri = vscode.Uri.from({ scheme: TRANSCRIPT_SCHEME, path: `/${name.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80)}.md`, query: `doc=${key}` });
    this.docChanged.fire(uri);
    try {
      await vscode.commands.executeCommand('markdown.showPreview', uri);
    } catch {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
    }
  }

  /** Sessões de uma worktree, da mais recente para a mais antiga (relê os logs antes). */
  private async sessionsIn(cwd: string): Promise<SessionInfo[]> {
    await this.scan();
    return mapToWorktrees(this.sessions, [cwd]).get(cwd) ?? [];
  }

  private wtName(cwd: string) {
    return this.ctl.state?.worktrees.find(w => norm(w.path) === norm(cwd))?.name ?? path.basename(cwd);
  }

  /** Última mensagem do agente na worktree (da sessão mais recente), com o pedido que ela responde. */
  async lastMessage(cwd: string, session?: SessionInfo) {
    const s = session ?? (await this.sessionsIn(cwd))[0];
    if (!s) {
      vscode.window.showInformationMessage(t('No Claude Code session in {0} yet.', this.wtName(cwd)));
      return;
    }
    const md = renderLastMessage(s, await readTurns(s.file), s.cwd ?? cwd);
    await this.showDoc(`last:${s.id}`, t('Last message · {0}', this.wtName(cwd)), md);
  }

  private async gitRecap(cwd: string): Promise<RecapGit | undefined> {
    const repo = this.ctl.repo;
    if (!repo) return undefined;
    const wt = this.ctl.state?.worktrees.find(w => norm(w.path) === norm(cwd));
    const lines = (s: string) => s.split(/\r?\n/).filter(l => l.trim());
    try {
      const { base } = await this.ctl.base();
      const isBase = wt?.isBase || wt?.branch === base;
      const none = Promise.resolve({ stdout: '' });
      const [log, status, stat] = await Promise.all([
        isBase ? none : repo.run(['log', '--oneline', '--no-decorate', `${base}..HEAD`], cwd),
        repo.run(['status', '--short'], cwd),
        isBase ? none : repo.run(['diff', '--shortstat', `${base}...HEAD`], cwd),
      ]);
      return { branch: wt?.branch, base: isBase ? undefined : base, commits: lines(log.stdout), uncommitted: lines(status.stdout), stat: stat.stdout.trim() || undefined };
    } catch (e) {
      this.ctl.log(t('Recap: could not read git: {0}', (e as Error).message));
      return undefined;
    }
  }

  /**
   * Recapitula o que foi feito na worktree: git (commits, não commitados) e cada pedido com os
   * arquivos editados e a resposta final. `summarize` pede ao Claude (sem terminal) um resumo disso.
   */
  async recap(cwd: string, summarize = false) {
    const list = (await this.sessionsIn(cwd)).slice(0, 10).reverse();
    const [git, sessions] = await Promise.all([this.gitRecap(cwd), Promise.all(list.map(async info => ({ info, turns: await readTurns(info.file) })))]);
    const name = this.wtName(cwd);
    const md = renderRecap(name, cwd, sessions, git);
    if (!summarize) return this.showDoc(`recap:${norm(cwd)}`, t('Recap · {0}', name), md);
    if (!sessions.length && !git?.commits.length && !git?.uncommitted.length) {
      vscode.window.showInformationMessage(t('Nothing to recap in {0} yet.', name));
      return;
    }
    await this.summarizeDoc(`summary:${norm(cwd)}`, name, md, cwd);
  }

  /** Pede ao Claude (sem terminal) um resumo de `md` e mostra o resumo em cima e `md` inteiro embaixo. */
  private async summarizeDoc(key: string, name: string, md: string, cwd: string) {
    const lang = locale().toLowerCase().startsWith('pt') ? 'Brazilian Portuguese' : 'English';
    try {
      const r = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t('Claude is recapping {0}…', name), cancellable: true },
        (_p, token) => {
          const ac = new AbortController();
          token.onCancellationRequested(() => ac.abort());
          return runHeadless(recapSummaryPrompt(md, lang), {
            cwd,
            bin: this.ctl.cfg().get<string>('claude.headlessCommand', 'claude'),
            model: this.ctl.cfg().get<string>('claude.headlessModel', 'haiku') || undefined,
            timeoutMs: 5 * 60_000,
            signal: ac.signal,
          });
        },
      );
      // o resumo em cima e o recap completo embaixo, um nível de título abaixo
      const details = md.replace(/^# .*\n/, `## ${t('Details')}\n`).replace(/^(#{2,}) /gm, (m, h: string, i: number) => (i === 0 ? m : `#${h} `));
      await this.showDoc(key, t('Summary · {0}', name), [`# ${t('Summary: {0}', name)}`, '', r.text, '', '---', '', details].join('\n'));
    } catch (e) {
      if ((e as Error).message === 'canceled') return;
      vscode.window.showErrorMessage(t('Could not summarize: {0}', (e as Error).message));
    }
  }

  // ---------- recapitulação dos merges ----------

  /** Pastas onde as sessões deste repositório podem ter rodado: a principal e as pastas-mãe das worktrees. */
  private async repoRoots(): Promise<{ roots: string[]; wts: { path: string; branch?: string }[] }> {
    const repo = this.ctl.repo!;
    const wts = await repo.worktreesFast().catch(() => []);
    const roots = new Set<string>();
    for (const w of wts) roots.add(w.isMain ? w.path : path.dirname(w.path));
    if (!roots.size) roots.add(repo.root);
    return { roots: [...roots], wts };
  }

  private recapFile(branch: string): string | undefined {
    const dir = this.ctl.repo?.commonDir;
    return dir && path.join(dir, 'agentyard', 'recaps', `${branch.replace(/[^\w.-]+/g, '_')}.json`);
  }

  private async branchSessions(branch: string, ctx: { roots: string[]; wts: { path: string; branch?: string }[] }) {
    const wt = ctx.wts.find(w => w.branch === branch);
    const list = sessionsOfBranch(this.sessions, branch, ctx.roots, wt?.path).slice(-10);
    // removida a worktree, a pasta onde a primeira sessão começou faz as vezes dela
    return { wt: wt?.path ?? list[0]?.cwd, sessions: await Promise.all(list.map(async info => ({ info, turns: await readTurns(info.file) }))) };
  }

  /**
   * Guarda, no momento do merge, o que a IA fez na branch (pedidos, arquivos e respostas finais) em
   * `.git/agentyard/recaps`: a worktree costuma ser removida logo depois e os logs do Claude são limpos com o tempo.
   */
  async saveMergeRecap(branch: string, target: string) {
    const file = this.recapFile(branch);
    if (!file) return;
    try {
      await this.scan();
      const { wt, sessions } = await this.branchSessions(branch, await this.repoRoots());
      if (!sessions.length) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ branch, target, at: Date.now(), md: renderRecap(branch, wt, sessions) }));
    } catch (e) {
      this.ctl.log(t('Recap: could not save the recap of {0}: {1}', branch, (e as Error).message));
    }
  }

  private savedRecap(branch: string): { md: string; at: number } | undefined {
    const file = this.recapFile(branch);
    try {
      const o = file && JSON.parse(fs.readFileSync(file, 'utf8'));
      return o && typeof o.md === 'string' ? { md: o.md, at: o.at } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Merges recentes na base (primeiro pai), para escolher quais recapitular. */
  private async pickMerges(base: string): Promise<string[] | undefined> {
    const r = await this.ctl.repo!.run(['log', '--merges', '--first-parent', '-n', '80', '--format=%H%x1f%ct%x1f%s', base]);
    const items = r.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map(l => l.split('\x1f'))
      .map(([sha, ct, subject]) => ({
        label: mergeSource(subject) ?? subject,
        description: new Date(Number(ct) * 1000).toLocaleString(locale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
        detail: `${sha.slice(0, 8)} · ${subject}`,
        sha,
      }));
    if (!items.length) {
      vscode.window.showInformationMessage(t('No merge commits on {0}.', base));
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(items, { title: t('Recap which merges into {0}?', base), canPickMany: true, matchOnDetail: true });
    return pick?.length ? pick.map(p => p.sha) : undefined;
  }

  /**
   * Recapitula o que a IA fez nas branches trazidas por merge: num commit de merge, tudo o que ele
   * trouxe (inclusive os merges de dentro dele, a cadeia inteira); numa branch, os merges que ela
   * recebeu desde a base e ela mesma; sem nada (ou na base), escolhe entre os merges recentes da base.
   */
  async recapMerges(arg: { sha?: string; branch?: string } = {}, summarize = false) {
    const repo = this.ctl.repo;
    if (!repo) return;
    const { base } = await this.ctl.base();
    const out = (r: { stdout: string }) => r.stdout.split(/\r?\n/).filter(l => l.trim());
    const subjectOf = async (sha: string) => (await repo.run(['log', '-1', '--format=%s', sha])).stdout.trim();
    const parents = arg.sha ? (await repo.run(['rev-list', '--parents', '-n', '1', arg.sha])).stdout.trim().split(/\s+/).slice(1) : [];
    let ranges: string[];
    let self: string | undefined;
    let title: string;
    if (arg.sha && parents.length > 1) {
      ranges = [`${arg.sha}^1..${arg.sha}`];
      title = mergeSource(await subjectOf(arg.sha)) ?? arg.sha.slice(0, 8);
    } else if (arg.branch && arg.branch !== base) {
      ranges = [`${base}..${arg.branch}`];
      self = title = arg.branch;
    } else if (arg.sha) {
      vscode.window.showInformationMessage(t('{0} is not a merge commit.', arg.sha.slice(0, 8)));
      return;
    } else {
      const shas = await this.pickMerges(base);
      if (!shas) return;
      ranges = shas.map(s => `${s}^1..${s}`);
      title = shas.length === 1 ? (mergeSource(await subjectOf(shas[0])) ?? shas[0].slice(0, 8)) : t('{0} merge(s) into {1}', shas.length, base);
    }

    const md = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: t('Gathering what the AI did in the merges…') }, async () => {
      const merges = new Map<string, { sha: string; p1: string; p2: string; at: number; subject: string }>();
      for (const range of ranges) {
        for (const l of out(await repo.run(['log', '--merges', '--format=%H%x1f%P%x1f%ct%x1f%s', range]))) {
          const [sha, ps, ct, subject] = l.split('\x1f');
          const [p1, p2] = ps.split(' ');
          if (p2) merges.set(sha, { sha, p1, p2, at: Number(ct) * 1000, subject });
        }
      }
      const parts = new Map<string, MergePart>();
      for (const m of [...merges.values()].sort((a, b) => a.at - b.at)) {
        const branch = mergeSource(m.subject) ?? m.sha.slice(0, 8);
        // a base trazida para dentro de uma branch não é trabalho da IA
        if (branch === base || branch.endsWith(`/${base}`)) continue;
        const into = /\binto '?([^'\s]+)'?\s*$/.exec(m.subject)?.[1] ?? (m.subject.startsWith('Merge branch') ? base : undefined);
        const commits = out(await repo.run(['log', '--oneline', '--no-decorate', '--first-parent', '-n', '60', `${m.p1}..${m.p2}`]));
        const p = parts.get(branch) ?? { branch, merges: [], commits: [], sessions: [] };
        p.merges.push({ sha: m.sha, at: m.at, into });
        p.commits.push(...commits.filter(c => !p.commits.includes(c)));
        parts.set(branch, p);
      }
      if (self && !parts.has(self)) {
        const commits = out(await repo.run(['log', '--oneline', '--no-decorate', '--first-parent', '-n', '60', `${base}..${self}`]));
        parts.set(self, { branch: self, merges: [], commits, sessions: [] });
      }
      await this.scan();
      const ctx = await this.repoRoots();
      for (const p of parts.values()) {
        const found = await this.branchSessions(p.branch, ctx);
        p.sessions = found.sessions;
        p.root = found.wt;
        if (!p.sessions.length) p.saved = this.savedRecap(p.branch);
      }
      return renderMergeRecap(title, repo.root, [...parts.values()]);
    });
    const key = `merges:${ranges.join(',')}`;
    if (!summarize) return this.showDoc(key, t('Merge recap · {0}', title), md);
    await this.summarizeDoc(`summary-${key}`, title, md, repo.root);
  }

  /** Uso estimado pelos logs para a tela "Uso do Claude": janela de 5 h, semana, por dia e por worktree. */
  async estimate() {
    await this.scan();
    const now = Date.now();
    const block = currentBlock(this.sessions, now, this.cfg().get<number>('blockHours', 5));
    const week = weekWindow(this.sessions, this.weekMode(), now);
    const perWt = [...this.byWorktree()]
      .map(([p, list]) => ({
        name: this.ctl.state?.worktrees.find(w => w.path === p)?.name ?? path.basename(p),
        tokens: list.reduce((sum, s) => sum + s.events.filter(e => e[0] >= week.start).reduce((a, e) => a + e[1], 0), 0),
      }))
      .filter(x => x.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 8);
    return {
      block: block ? { tokens: block.tokens, responses: block.responses, start: block.start, end: block.end } : undefined,
      week: { tokens: week.tokens, responses: week.responses, monday: this.weekMode() === 'monday' },
      days: dailyTotals(this.sessions, 7, now),
      perWt,
      budgets: this.budgets(),
    };
  }

  /** Comandos de barra/skills e atalhos de sessão para uma worktree. */
  async commands(cwd: string, label: string) {
    const list = listClaudeCommands(cwd, this.claudeDir());
    const alive = this.agentTerms.claudeIn(cwd).length > 0;
    const items: (vscode.QuickPickItem & { run?: () => void })[] = [
      { label: t('Session'), kind: vscode.QuickPickItemKind.Separator },
      { label: '$(debug-continue) ' + t('Continue the last session here'), description: 'claude -c', run: () => this.send(cwd, 'claude -c', false) },
      { label: '$(history) ' + t('Pick a session to resume'), description: 'claude --resume', run: () => this.send(cwd, 'claude --resume', false) },
      { label: '$(add) ' + t('New session'), description: 'claude', run: () => this.send(cwd, 'claude', false) },
      { label: alive ? t('Commands (sent to the Claude open in this worktree)') : t('Commands (open a new session)'), kind: vscode.QuickPickItemKind.Separator },
      ...list.map(c => ({ label: c.name, description: sourceLabel(c.source), detail: c.description || undefined, run: () => this.send(cwd, c.name, true) })),
    ];
    const pick = await vscode.window.showQuickPick(items, { title: t('Claude Code in {0}', label), matchOnDescription: true, matchOnDetail: true });
    pick?.run?.();
  }

  /**
   * `slash`: se já há um Claude aberto nesta worktree, digita o comando nele (o mais recente);
   * senão abre um com o comando como primeira mensagem.
   */
  private send(cwd: string, text: string, slash: boolean) {
    const open = slash ? this.agentTerms.claudeIn(cwd)[0] : undefined;
    if (open) return void this.agentTerms.type(open, text, true);
    void this.start(cwd, slash ? `claude ${promptArgument(text).arg}` : text);
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.rescan) clearTimeout(this.rescan);
    this.docChanged.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}

// ---------- view ----------

class WorktreeGroup extends vscode.TreeItem {
  readonly kind = 'claudeGroup';
  constructor(readonly wtPath: string | undefined, readonly label2: string, readonly sessions: SessionInfo[], expanded: boolean) {
    super(label2, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `claude-group:${wtPath ?? 'outras'}`;
    const tokens = sessions.reduce((n, s) => n + weighted(s.usage), 0);
    this.description = `${sessions.length} · ${formatTokens(tokens)} tokens`;
    this.iconPath = new vscode.ThemeIcon(wtPath ? 'git-branch' : 'folder');
    this.contextValue = wtPath ? 'claudeGroup' : 'claudeGroupOther';
    this.tooltip = wtPath;
  }
}

export class SessionItem extends vscode.TreeItem {
  readonly kind = 'claudeSession';
  constructor(readonly session: SessionInfo, open?: OpenAgent) {
    super(sessionTitle(session), vscode.TreeItemCollapsibleState.None);
    this.id = `claude-session:${session.id}`;
    const live = open ? `${stateText(open.state) || t('open')} · ` : '';
    this.description = `${live}${ago(session.end)} · ${formatTokens(weighted(session.usage))}`;
    this.iconPath = open
      ? new vscode.ThemeIcon(open.state === 'waiting' ? 'bell-dot' : 'terminal', new vscode.ThemeColor(open.state === 'waiting' ? 'list.warningForeground' : 'terminal.ansiGreen'))
      : new vscode.ThemeIcon('comment-discussion');
    this.contextValue = 'claudeSession';
    const u = session.usage;
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${sessionTitle(session)}**\n\n`);
    if (session.firstPrompt && session.firstPrompt !== sessionTitle(session)) md.appendMarkdown(`> ${session.firstPrompt}\n\n`);
    md.appendMarkdown(`\`${session.id}\`\n\n${session.cwd ?? ''}${session.gitBranch ? ` · ${session.gitBranch}` : ''}\n\n`);
    if (session.lastReply) md.appendMarkdown(`**${t('Last message from Claude')}** (${ago(session.lastReplyAt ?? session.end)}):\n\n${clipQuote(session.lastReply, 500)}\n\n`);
    if (open) md.appendMarkdown(t('Open in the terminal **{0}**: "Resume" brings it to the front.', open.terminal.name) + '\n\n');
    md.appendMarkdown(`${new Date(session.start).toLocaleString(locale())} → ${new Date(session.end).toLocaleString(locale())}\n\n`);
    md.appendMarkdown(t('{0} messages from you · {1} responses · {2}', session.userMessages, session.assistantMessages, session.models.join(', ')) + '\n\n');
    md.appendMarkdown(
      t('Tokens: input {0} · output {1} · cache creation {2} · cache read {3} (total {4})', formatTokens(u.input), formatTokens(u.output), formatTokens(u.cacheCreate), formatTokens(u.cacheRead), formatTokens(totalTokens(u))),
    );
    this.tooltip = md;
    this.command = { command: 'worktreeGraph.claude.transcript', title: t('View transcript'), arguments: [this] };
  }
}

type ClaudeNode = WorktreeGroup | SessionItem | vscode.TreeItem;

export class ClaudeSessionsProvider implements vscode.TreeDataProvider<ClaudeNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly svc: ClaudeService, ctl: Controller) {
    svc.onDidChange(() => this.emitter.fire());
    ctl.onDidChange(() => this.emitter.fire());
    svc.agentTerms.onDidChange(() => this.emitter.fire());
  }

  getTreeItem(el: ClaudeNode) {
    return el;
  }

  getChildren(el?: ClaudeNode): ClaudeNode[] {
    if (!el) {
      if (!this.svc.loaded) {
        const item = new vscode.TreeItem(t('Reading Claude Code sessions…'));
        item.iconPath = new vscode.ThemeIcon('loading~spin');
        return [item];
      }
      const state = this.svc.ctl.state;
      const m = this.svc.byWorktree();
      const groups: ClaudeNode[] = [];
      const inRepo = new Set<string>();
      for (const w of state?.worktrees ?? []) {
        const list = m.get(w.path);
        if (!list?.length) continue;
        list.forEach(s => inRepo.add(s.id));
        groups.push(new WorktreeGroup(w.path, w.name, list, w.isCurrent || groups.length === 0));
      }
      const others = this.svc.sessions.filter(s => !inRepo.has(s.id));
      if (others.length) groups.push(new WorktreeGroup(undefined, t('Other folders'), others, false));
      if (!groups.length) groups.push(new vscode.TreeItem(t('No Claude Code sessions found')));
      return groups;
    }
    if (el instanceof WorktreeGroup) {
      const max = this.svc.cfg().get<number>('maxSessionsPerGroup', 50);
      return el.sessions.slice(0, max).map(s => new SessionItem(s, this.svc.openFor(s)));
    }
    return [];
  }
}

export class TranscriptProvider implements vscode.TextDocumentContentProvider {
  readonly onDidChange: vscode.Event<vscode.Uri>;
  constructor(private readonly svc: ClaudeService) {
    this.onDidChange = svc.docChanged.event;
  }
  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    if (uri.query.startsWith('doc=')) return Promise.resolve(this.svc.docs.get(uri.query.slice(4)) ?? '');
    return this.svc.renderById(uri.query);
  }
}
