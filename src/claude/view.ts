import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Controller } from '../controller';
import type { GraphState } from '../model';
import {
  currentBlock,
  dailyTotals,
  emptyCache,
  formatTokens,
  listClaudeCommands,
  mapToWorktrees,
  renderTranscript,
  scanSessions,
  ScanCache,
  SessionInfo,
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
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  if (s < 86400 * 30) return `há ${Math.floor(s / 86400)} d`;
  return new Date(ms).toLocaleDateString('pt-BR');
}

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

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
  /** Terminais abertos por esta extensão para o Claude, por worktree (para mandar comandos). */
  private readonly terminals = new Map<string, vscode.Terminal>();
  loaded = false;

  constructor(readonly ctl: Controller) {
    this.status.command = 'worktreeGraph.claude.usage';
    this.status.name = 'Uso do Claude Code';
    this.loadCache();
    ctl.stateHooks.push(s => this.applyToState(s));
    this.disposables.push(
      vscode.window.onDidCloseTerminal(t => {
        for (const [k, v] of this.terminals) if (v === t) this.terminals.delete(k);
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
        this.ctl.log(`Sessões Claude: não consegui salvar o cache: ${(e as Error).message}`);
      }
    }, 2000);
  }

  scan(): Promise<void> {
    if (this.scanning) return this.scanning;
    const first = !this.loaded;
    if (first) {
      this.status.text = '$(loading~spin) Claude: lendo sessões…';
      this.status.show();
    }
    this.scanning = (async () => {
      const t0 = Date.now();
      try {
        const r = await scanSessions(this.claudeDir(), this.cache);
        this.sessions = r.sessions;
        if (r.filesRead) this.saveCache();
        if (first || r.filesRead) this.ctl.log(`Sessões Claude: ${r.sessions.length} sessões, ${r.filesRead} arquivo(s) lidos (${(r.bytesRead / 1e6).toFixed(1)} MB) em ${Date.now() - t0} ms`);
        const changed = first || r.filesRead > 0;
        this.loaded = true;
        this.updateStatus();
        if (changed) {
          this.changed.fire();
          this.ctl.scheduleRefresh(50);
        }
      } catch (e) {
        this.ctl.log(`Sessões Claude: ${(e as Error).message}`);
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
      w.claude = list?.length
        ? { sessions: list.length, tokens: list.reduce((n, x) => n + weighted(x.usage), 0), last: Math.max(...list.map(x => x.end)), lastId: list[0].id }
        : undefined;
    }
  }

  private budgets() {
    return { session: this.cfg().get<number>('sessionBudgetTokens', 0), week: this.cfg().get<number>('weeklyBudgetTokens', 0) };
  }

  private weekMode(): 'rolling' | 'monday' {
    return this.cfg().get<string>('weekStart', 'rolling') === 'monday' ? 'monday' : 'rolling';
  }

  private updateStatus() {
    if (!this.cfg().get<boolean>('showUsageInStatusBar', true) || !this.sessions.length) {
      this.status.hide();
      return;
    }
    const b = this.budgets();
    const block = currentBlock(this.sessions, Date.now(), this.cfg().get<number>('blockHours', 5));
    const week = weekWindow(this.sessions, this.weekMode());
    const pct = (n: number, of: number) => (of > 0 ? ` (${Math.round((n / of) * 100)}%)` : '');
    const blockText = block ? `${formatTokens(block.tokens)}${pct(block.tokens, b.session)}` : '—';
    this.status.text = `$(sparkle) 5h ${blockText} · sem ${formatTokens(week.tokens)}${pct(week.tokens, b.week)}`;
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown('**Uso do Claude Code** — estimativa a partir dos logs locais\n\n');
    md.appendMarkdown(
      block
        ? `Janela atual: **${formatTokens(block.tokens)}** tokens em ${block.responses} respostas, das ${hhmm(block.start)} até **${hhmm(block.end)}** (reinicia)\n\n`
        : 'Nenhuma janela de 5 h ativa agora.\n\n',
    );
    md.appendMarkdown(`${this.weekMode() === 'monday' ? 'Desde segunda' : 'Últimos 7 dias'}: **${formatTokens(week.tokens)}** tokens em ${week.responses} respostas\n\n`);
    md.appendMarkdown('Conta entrada + criação de cache + saída; leitura de cache fica de fora. Os limites oficiais do plano não ficam no disco: use `/usage` no Claude Code para os números exatos.\n\n');
    if (!b.session && !b.week) md.appendMarkdown('Defina `worktreeGraph.claude.sessionBudgetTokens` e `weeklyBudgetTokens` para ver a porcentagem.');
    this.status.tooltip = md;
    this.status.show();
  }

  // ---------- ações ----------

  private terminalFor(cwd: string, name: string): vscode.Terminal {
    const t = vscode.window.createTerminal({ name, cwd, iconPath: new vscode.ThemeIcon('sparkle') });
    this.terminals.set(norm(cwd), t);
    return t;
  }

  private existingDir(...candidates: (string | undefined)[]): string | undefined {
    return candidates.find(c => c && fs.existsSync(c));
  }

  resume(s: SessionInfo) {
    const cwd = this.existingDir(s.cwd, this.ctl.repo?.root);
    if (!cwd) {
      vscode.window.showWarningMessage(`A pasta da sessão não existe mais: ${s.cwd}`);
      return;
    }
    const t = this.terminalFor(cwd, `Claude · ${sessionTitle(s).slice(0, 30)}`);
    t.show();
    t.sendText(`claude --resume ${s.id}`);
  }

  newSession(cwd: string, label?: string) {
    const t = this.terminalFor(cwd, `Claude · ${label ?? path.basename(cwd)}`);
    t.show();
    t.sendText('claude');
  }

  async transcript(s: SessionInfo) {
    const uri = vscode.Uri.from({ scheme: TRANSCRIPT_SCHEME, path: `/${sessionTitle(s).replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 60)}.md`, query: s.id });
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  async renderById(id: string): Promise<string> {
    const s = this.sessions.find(x => x.id === id);
    return s ? renderTranscript(s) : `Sessão ${id} não encontrada.`;
  }

  async usagePanel() {
    await this.scan();
    const now = Date.now();
    const block = currentBlock(this.sessions, now, this.cfg().get<number>('blockHours', 5));
    const week = weekWindow(this.sessions, this.weekMode(), now);
    const days = dailyTotals(this.sessions, 7, now);
    const max = Math.max(1, ...days.map(d => d.tokens));
    const bar = (n: number) => '█'.repeat(Math.round((n / max) * 20)).padEnd(20, '·');
    const weekStart = week.start;
    const perWt = [...this.byWorktree()]
      .map(([p, list]) => ({
        p,
        tokens: list.reduce((sum, s) => sum + s.events.filter(e => e[0] >= weekStart).reduce((a, e) => a + e[1], 0), 0),
      }))
      .filter(x => x.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 8);
    const items: vscode.QuickPickItem[] = [
      { label: 'Janela de 5 h', kind: vscode.QuickPickItemKind.Separator },
      block
        ? { label: `$(pulse) ${formatTokens(block.tokens)} tokens`, description: `${hhmm(block.start)} → reinicia às ${hhmm(block.end)}`, detail: `${block.responses} respostas` }
        : { label: '$(circle-slash) Nenhuma janela ativa' },
      { label: this.weekMode() === 'monday' ? 'Desde segunda' : 'Últimos 7 dias', kind: vscode.QuickPickItemKind.Separator },
      { label: `$(calendar) ${formatTokens(week.tokens)} tokens`, detail: `${week.responses} respostas` },
      { label: 'Por dia', kind: vscode.QuickPickItemKind.Separator },
      ...days.map(d => ({ label: `${d.day.slice(5)}  ${bar(d.tokens)}`, description: formatTokens(d.tokens) })),
      ...(perWt.length ? [{ label: 'Worktrees que mais usaram na semana', kind: vscode.QuickPickItemKind.Separator } as vscode.QuickPickItem] : []),
      ...perWt.map(x => ({ label: `$(git-branch) ${this.ctl.state?.worktrees.find(w => w.path === x.p)?.name ?? path.basename(x.p)}`, description: formatTokens(x.tokens) })),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(gear) Configurar orçamentos e semana', description: 'worktreeGraph.claude' },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: 'Uso do Claude Code (estimativa a partir dos logs locais; /usage no Claude mostra os limites oficiais)',
    });
    if (pick?.label.startsWith('$(gear)')) vscode.commands.executeCommand('workbench.action.openSettings', 'worktreeGraph.claude');
  }

  /** Comandos de barra/skills e atalhos de sessão para uma worktree. */
  async commands(cwd: string, label: string) {
    const list = listClaudeCommands(cwd, this.claudeDir());
    const open = this.terminals.get(norm(cwd));
    const alive = open && open.exitStatus === undefined;
    const items: (vscode.QuickPickItem & { run?: () => void })[] = [
      { label: 'Sessão', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(debug-continue) Continuar a última sessão aqui', description: 'claude -c', run: () => this.send(cwd, label, 'claude -c', false) },
      { label: '$(history) Escolher uma sessão para retomar', description: 'claude --resume', run: () => this.send(cwd, label, 'claude --resume', false) },
      { label: '$(add) Nova sessão', description: 'claude', run: () => this.send(cwd, label, 'claude', false) },
      { label: alive ? 'Comandos (enviados ao Claude aberto nesta worktree)' : 'Comandos (abrem uma sessão nova)', kind: vscode.QuickPickItemKind.Separator },
      ...list.map(c => ({ label: c.name, description: c.source, detail: c.description || undefined, run: () => this.send(cwd, label, c.name, true) })),
    ];
    const pick = await vscode.window.showQuickPick(items, { title: `Claude Code em ${label}`, matchOnDescription: true, matchOnDetail: true });
    pick?.run?.();
  }

  /** `slash`: se já há um Claude aberto nesta worktree, digita o comando nele; senão abre com o comando. */
  private send(cwd: string, label: string, text: string, slash: boolean) {
    const t = this.terminals.get(norm(cwd));
    if (slash && t && t.exitStatus === undefined) {
      t.show();
      t.sendText(text);
      return;
    }
    const nt = this.terminalFor(cwd, `Claude · ${label}`);
    nt.show();
    nt.sendText(slash ? `claude "${text}"` : text);
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
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
  constructor(readonly session: SessionInfo) {
    super(sessionTitle(session), vscode.TreeItemCollapsibleState.None);
    this.id = `claude-session:${session.id}`;
    this.description = `${ago(session.end)} · ${formatTokens(weighted(session.usage))}`;
    this.iconPath = new vscode.ThemeIcon('comment-discussion');
    this.contextValue = 'claudeSession';
    const u = session.usage;
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${sessionTitle(session)}**\n\n`);
    if (session.firstPrompt && session.firstPrompt !== sessionTitle(session)) md.appendMarkdown(`> ${session.firstPrompt}\n\n`);
    md.appendMarkdown(`\`${session.id}\`\n\n${session.cwd ?? ''}${session.gitBranch ? ` · ${session.gitBranch}` : ''}\n\n`);
    md.appendMarkdown(`${new Date(session.start).toLocaleString('pt-BR')} → ${new Date(session.end).toLocaleString('pt-BR')}\n\n`);
    md.appendMarkdown(`${session.userMessages} mensagens suas · ${session.assistantMessages} respostas · ${session.models.join(', ')}\n\n`);
    md.appendMarkdown(
      `Tokens: entrada ${formatTokens(u.input)} · saída ${formatTokens(u.output)} · criação de cache ${formatTokens(u.cacheCreate)} · leitura de cache ${formatTokens(u.cacheRead)} (total ${formatTokens(totalTokens(u))})`,
    );
    this.tooltip = md;
    this.command = { command: 'worktreeGraph.claude.transcript', title: 'Ver transcrição', arguments: [this] };
  }
}

type ClaudeNode = WorktreeGroup | SessionItem | vscode.TreeItem;

export class ClaudeSessionsProvider implements vscode.TreeDataProvider<ClaudeNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly svc: ClaudeService, ctl: Controller) {
    svc.onDidChange(() => this.emitter.fire());
    ctl.onDidChange(() => this.emitter.fire());
  }

  getTreeItem(el: ClaudeNode) {
    return el;
  }

  getChildren(el?: ClaudeNode): ClaudeNode[] {
    if (!el) {
      if (!this.svc.loaded) {
        const t = new vscode.TreeItem('Lendo sessões do Claude Code…');
        t.iconPath = new vscode.ThemeIcon('loading~spin');
        return [t];
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
      if (others.length) groups.push(new WorktreeGroup(undefined, 'Outras pastas', others, false));
      if (!groups.length) groups.push(new vscode.TreeItem('Nenhuma sessão do Claude Code encontrada'));
      return groups;
    }
    if (el instanceof WorktreeGroup) {
      const max = this.svc.cfg().get<number>('maxSessionsPerGroup', 50);
      return el.sessions.slice(0, max).map(s => new SessionItem(s));
    }
    return [];
  }
}

export class TranscriptProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly svc: ClaudeService) {}
  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    return this.svc.renderById(uri.query);
  }
}
