import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentTerminals, OpenAgent } from '../agents';
import { keyOf } from '../agentFlow/head';
import type { BridgeHookEvent, ClaudeBridge } from '../bridge/register';
import { hookJson } from '../bridge/register';
import type { Controller } from '../controller';
import type { Coord } from '../coord/register';
import { gitUri } from '../diff';
import { t } from '../i18n';
import type { WorktreeView } from '../model';
import { describeToolRequest, guardToolUse } from './guard';
import { osNotify } from './osNotify';
import { sessionContext } from './sessionContext';
import * as turns from './turns';

/** Um turno do agente: do prompt ao fim da resposta, com o estado da worktree nas duas pontas. */
export interface Turn {
  n: number;
  prompt?: string;
  /** Checkpoint no começo do turno. */
  start: string;
  /** Checkpoint no fim (sem ele, o turno ainda está rodando). */
  end?: string;
  headStart?: string;
  headEnd?: string;
  startedAt: number;
  endedAt?: number;
  files?: number;
  additions?: number;
  deletions?: number;
  commits?: number;
}

/** Turnos de um Claude (um terminal da extensão ou uma sessão aberta fora dela). */
export interface TurnLog {
  key: string;
  worktree: string;
  branch?: string;
  agent: string;
  session?: string;
  updated: number;
  turns: Turn[];
}

/** Contadores por worktree para o relatório de métricas das tarefas. */
export interface TaskCounters {
  since: number;
  turns: number;
  permissions: number;
  approvedInVsCode: number;
  deniedInVsCode: number;
  guardBlocks: number;
  plans: number;
  budgetBlocks: number;
}

const TURNS_KEY = 'claude.turns';
const COUNTERS_KEY = 'claude.counters';
const MAX_LOGS = 30;
const MAX_TURNS = 60;
/** Quanto o hook espera o checkpoint do começo do turno antes de liberar o Claude. */
const SNAPSHOT_WAIT_MS = 5000;

const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([p, new Promise<undefined>(r => setTimeout(() => r(undefined), ms))]);

/**
 * O que a extensão faz com os hooks do Claude Code (via src/bridge): guarda da worktree, contexto
 * no início da sessão, pedidos de permissão respondidos no VS Code, plano do modo plan, orçamento,
 * checkpoints por turno e a autoria dos commits.
 */
export class ClaudeIntegration implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTurns = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.changed];
  /** Promessas de checkpoint do começo do turno ainda gravando (por chave do log). */
  private readonly starting = new Map<string, Promise<void>>();
  private hasChanges?: boolean;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly ctl: Controller,
    private readonly bridge: ClaudeBridge,
    private readonly agentTerms: AgentTerminals,
    private readonly coord: Coord,
    private readonly openTranscript: (sessionId: string) => Promise<void>,
  ) {
    bridge.onHook('PreToolUse', e => this.onPreToolUse(e));
    bridge.onHook('PermissionRequest', e => this.onPermission(e));
    bridge.onHook('SessionStart', e => this.onSessionStart(e));
    bridge.onHook('UserPromptSubmit', e => this.onPrompt(e));
    bridge.onHook('Stop', e => this.onStop(e));
    bridge.addTool('turn_diff', async (args, { cwd, open }) => this.turnDiffTool(args, cwd, open));
    // checkpoints velhos saem na ativação (os commits soltos o gc leva depois)
    setTimeout(() => void this.pruneOld(), 30_000);
  }

  private cfg() {
    return this.ctl.cfg();
  }

  // ------------------------------------------------------------ guarda e plano

  private guardContext(w: WorktreeView) {
    const s = this.ctl.state;
    const others = (s?.worktrees ?? []).filter(x => !x.bare && !x.prunable && keyOf(x.path) !== keyOf(w.path)).map(x => ({ path: x.path, name: x.branch ?? x.name }));
    const prot = new Set([s?.base, ...(s?.protectedBranches ?? [])].filter(Boolean) as string[]);
    return { worktree: w.path, others, protectedBranches: [...prot], strict: this.cfg().get<string>('claude.guard', 'on') === 'strict' };
  }

  private async onPreToolUse(e: BridgeHookEvent) {
    const w = e.worktree;
    if (e.tool_name === 'ExitPlanMode') {
      this.showPlan(e);
      return undefined;
    }
    if (!w || this.cfg().get<string>('claude.guard', 'on') === 'off') return undefined;
    const why = guardToolUse({ tool_name: e.tool_name, tool_input: e.tool_input, cwd: e.cwd }, this.guardContext(w));
    if (!why) return undefined;
    this.ctl.log(t('Worktree guard blocked {0} in {1}: {2}', describeToolRequest(e.tool_name, e.tool_input), w.branch ?? w.name, why));
    void this.bump(w.path, 'guardBlocks');
    return hookJson({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } });
  }

  private showPlan(e: BridgeHookEvent) {
    const plan = typeof e.tool_input?.plan === 'string' ? e.tool_input.plan : '';
    if (!plan.trim()) return;
    const w = e.worktree;
    if (w) void this.bump(w.path, 'plans');
    const where = w?.branch ?? w?.name ?? path.basename(e.cwd);
    const view = t('View plan');
    const msg = t('Claude in {0} proposed a plan and is waiting for your approval in the terminal.', where);
    if (!vscode.window.state.focused) osNotify(this.ctl, 'AgentYard', msg);
    void vscode.window.showInformationMessage(msg, view, t('Show terminal')).then(async pick => {
      if (pick === view) {
        const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: `<!-- ${where} -->\n${plan}\n` });
        await vscode.commands.executeCommand('markdown.showPreview', doc.uri).then(undefined, () => vscode.window.showTextDocument(doc));
      } else if (pick) await this.bridge.focusAgent(e.open?.path ?? w?.path ?? e.cwd, e.open);
    });
  }

  // ------------------------------------------------------------ permissão

  private async onPermission(e: BridgeHookEvent) {
    const w = e.worktree;
    if (w) void this.bump(w.path, 'permissions');
    if (!this.cfg().get<boolean>('claude.approveInVsCode', true)) return undefined;
    const o = e.open;
    // olhando para o terminal: o pedido aparece lá, como sempre
    if (o && vscode.window.state.focused && vscode.window.activeTerminal === o.terminal) return undefined;
    const where = o?.branch ?? w?.branch ?? w?.name ?? path.basename(e.cwd);
    const agent = o?.agent ?? 'Claude Code';
    const what = describeToolRequest(e.tool_name, e.tool_input);
    const allow = t('Allow');
    const always = t('Allow for this session');
    const deny = t('Deny');
    const inTerm = t('Answer in the terminal');
    const suggestions = Array.isArray(e.permission_suggestions) ? (e.permission_suggestions as Record<string, unknown>[]) : [];
    const buttons = [allow, ...(suggestions.length ? [always] : []), deny, inTerm];
    if (o) o.asking = true;
    this.agentTerms.refresh();
    if (!vscode.window.state.focused) osNotify(this.ctl, t('{0} in {1} needs your permission', agent, where), what);
    const disposables: vscode.Disposable[] = [];
    try {
      const released = new Promise<string>(resolve => {
        // foi para o terminal: o pedido passa a ser respondido lá
        if (o) disposables.push(vscode.window.onDidChangeActiveTerminal(term => term === o.terminal && vscode.window.state.focused && resolve('')));
        const timer = setTimeout(() => resolve(''), 590_000);
        disposables.push({ dispose: () => clearTimeout(timer) });
      });
      const asked = vscode.window.showWarningMessage(t('{0} in {1} asks: {2}', agent, where, what), ...buttons).then(p => p ?? '');
      const pick = await Promise.race([asked, released]);
      if (pick === allow || pick === always) {
        if (w) void this.bump(w.path, 'approvedInVsCode');
        const decision: Record<string, unknown> = { behavior: 'allow' };
        if (pick === always) decision.updatedPermissions = suggestions.map(s => ({ ...s, destination: 'session' }));
        return hookJson({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
      }
      if (pick === deny) {
        if (w) void this.bump(w.path, 'deniedInVsCode');
        return hookJson({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'The user denied this request from VS Code.' } } });
      }
      if (pick === inTerm && o) o.terminal.show();
      return undefined;
    } finally {
      disposables.forEach(d => d.dispose());
      if (o) o.asking = false;
      this.agentTerms.refresh();
    }
  }

  // ------------------------------------------------------------ contexto da sessão

  private async onSessionStart(e: BridgeHookEvent) {
    const w = e.worktree;
    if (!w || !this.cfg().get<boolean>('claude.sessionContext', true)) return undefined;
    const s = this.ctl.state;
    await this.coord.recompute().catch(() => undefined);
    const overlaps = this.coord.overlaps
      .filter(o => keyOf(o.a) === keyOf(w.path) || keyOf(o.b) === keyOf(w.path))
      .map(o => ({ with: this.bridge.nameOf(keyOf(o.a) === keyOf(w.path) ? o.b : o.a), files: o.files }));
    const busy = [...(this.ctl.agentsRunning?.() ?? new Map<string, string[]>()).keys()].filter(k => k !== keyOf(w.path)).map(k => this.bridge.nameOf(k));
    const ci = w.branch ? s?.pipelines?.[w.branch] : undefined;
    const text = sessionContext({
      repo: s?.repoName ?? path.basename(this.ctl.repo?.root ?? w.path),
      worktree: w.path,
      branch: w.branch,
      base: s?.baseRef ?? s?.base ?? 'main',
      ahead: w.compareKnown ? w.ahead : undefined,
      behind: w.compareKnown ? w.behind : undefined,
      changes: w.statusKnown ? w.changes : undefined,
      conflicts: w.preview?.conflict ? w.preview.files : undefined,
      overlaps,
      busy,
      request: w.request ? { ref: w.request.ref, url: w.request.url, state: w.request.state, review: w.request.review?.state } : undefined,
      ci: ci ? { status: ci.status, name: ci.name } : undefined,
      guard: this.cfg().get<string>('claude.guard', 'on') !== 'off',
      mcp: this.cfg().get<boolean>('claude.mcp', true) && !!e.open,
      extra: this.cfg().get<string>('claude.extraContext', ''),
    });
    return hookJson({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } });
  }

  // ------------------------------------------------------------ turnos

  private logs(): Record<string, TurnLog> {
    return this.ctx.workspaceState.get<Record<string, TurnLog>>(TURNS_KEY, {});
  }

  private async saveLog(log: TurnLog) {
    const all = this.logs();
    log.updated = Date.now();
    log.turns = log.turns.slice(-MAX_TURNS);
    all[log.key] = log;
    const keep = Object.values(all)
      .sort((a, b) => b.updated - a.updated)
      .slice(0, MAX_LOGS);
    await this.ctx.workspaceState.update(TURNS_KEY, Object.fromEntries(keep.map(l => [l.key, l])));
    this.changed.fire();
  }

  private logKey(e: BridgeHookEvent): string | undefined {
    if (e.open) return e.open.id;
    return e.session_id ? `session-${e.session_id}` : undefined;
  }

  /** Turnos de um terminal aberto. */
  turnsOf(o: OpenAgent): TurnLog | undefined {
    return this.logs()[o.id];
  }

  /** Turnos das sessões de uma worktree, o mais recente primeiro. */
  logsFor(worktree: string): TurnLog[] {
    return Object.values(this.logs())
      .filter(l => keyOf(l.worktree) === keyOf(worktree))
      .sort((a, b) => b.updated - a.updated);
  }

  private async onPrompt(e: BridgeHookEvent) {
    const w = e.worktree;
    if (!w) return undefined;
    void this.bump(w.path, 'turns');
    // orçamento: com budget.action = block-prompts, o Claude não começa outro turno
    if (this.cfg().get<string>('budget.action', 'warn') === 'block-prompts' && w.budget?.level === 'over') {
      void this.bump(w.path, 'budgetBlocks');
      const reason = t('AgentYard: {0} went over its budget ({1}%). Raise worktreeGraph.budget.* or change budget.action to continue.', w.branch ?? w.name, w.budget.pct);
      return hookJson({ decision: 'block', reason });
    }
    const key = this.logKey(e);
    if (!key || !this.cfg().get<boolean>('claude.checkpoints', true)) return undefined;
    const job = (async () => {
      const [start, head] = await Promise.all([turns.snapshot(w.path), this.head(w.path)]);
      const log: TurnLog = this.logs()[key] ?? { key, worktree: w.path, branch: w.branch, agent: e.open?.agent ?? 'Claude Code', session: e.session_id, updated: 0, turns: [] };
      if (e.session_id) log.session = e.session_id;
      const n = (log.turns[log.turns.length - 1]?.n ?? 0) + 1;
      log.turns.push({ n, prompt: typeof e.prompt === 'string' ? e.prompt.slice(0, 500) : undefined, start, headStart: head, startedAt: Date.now() });
      await turns.keepRef(w.path, `${turns.TURN_REFS}/${turns.refPart(key)}/${String(n).padStart(4, '0')}-start`, start);
      await this.saveLog(log);
    })().catch(err => this.ctl.log(t('Checkpoint at the start of the turn failed in {0}: {1}', w.branch ?? w.name, (err as Error).message)));
    this.starting.set(key, job);
    await within(job, SNAPSHOT_WAIT_MS);
    return undefined;
  }

  private async head(p: string): Promise<string | undefined> {
    const r = await this.ctl.repo?.run(['rev-parse', '--verify', '-q', 'HEAD'], p);
    return r?.code === 0 ? r.stdout.trim() : undefined;
  }

  private async onStop(e: BridgeHookEvent) {
    const w = e.worktree;
    const key = this.logKey(e);
    if (!w || !key) return undefined;
    // não segura o Claude: grava o fim do turno em segundo plano
    void (async () => {
      await this.starting.get(key);
      this.starting.delete(key);
      const log = this.logs()[key];
      const turn = log?.turns[log.turns.length - 1];
      if (!log || !turn || turn.end) return;
      const end = await turns.snapshot(w.path);
      const headEnd = await this.head(w.path);
      const files = await turns.changesBetween(w.path, turn.start, end);
      turn.end = end;
      turn.headEnd = headEnd;
      turn.endedAt = Date.now();
      turn.files = files.length;
      turn.additions = files.reduce((a, f) => a + f.additions, 0);
      turn.deletions = files.reduce((a, f) => a + f.deletions, 0);
      const commits = turn.headStart && headEnd ? await turns.newCommits(w.path, turn.headStart, headEnd) : [];
      turn.commits = commits.length;
      await turns.keepRef(w.path, `${turns.TURN_REFS}/${turns.refPart(key)}/${String(turn.n).padStart(4, '0')}-end`, end);
      if (commits.length && this.cfg().get<boolean>('claude.commitNotes', true)) {
        await turns.addNotes(w.path, commits, { session: e.session_id ?? log.session, agent: log.agent, turn: turn.n, prompt: turn.prompt });
      }
      await this.saveLog(log);
    })().catch(err => this.ctl.log(t('Checkpoint at the end of the turn failed in {0}: {1}', w.branch ?? w.name, (err as Error).message)));
    return undefined;
  }

  private async pruneOld() {
    const days = this.cfg().get<number>('claude.checkpointDays', 7);
    if (!this.ctl.repo || days <= 0) return;
    try {
      const n = await turns.pruneTurnRefs(this.ctl.repo.root, days);
      if (n) this.ctl.log(t('{0} old checkpoint(s) removed.', n));
    } catch (err) {
      this.ctl.log(t('Could not clean the old checkpoints: {0}', (err as Error).message));
    }
  }

  private async hasChangesCommand() {
    if (this.hasChanges === undefined) this.hasChanges = (await vscode.commands.getCommands(true)).includes('vscode.changes');
    return this.hasChanges;
  }

  /** Abre o que mudou num turno: vários diffs numa aba (VS Code 1.86+) ou o patch. */
  async showTurn(log: TurnLog, turn: Turn) {
    const to = turn.end ?? (await turns.snapshot(log.worktree));
    const files = await turns.changesBetween(log.worktree, turn.start, to);
    const title = t('Turn {0} of {1}', turn.n, log.branch ?? path.basename(log.worktree));
    if (!files.length) {
      vscode.window.showInformationMessage(t('{0}: no file changed.', title));
      return;
    }
    if (await this.hasChangesCommand()) {
      const res = files.map(f => {
        const left = f.status === 'A' ? gitUri(log.worktree, '__empty__', f.path) : gitUri(log.worktree, turn.start, f.path);
        const right = f.status === 'D' ? gitUri(log.worktree, '__empty__', f.path) : gitUri(log.worktree, to, f.path);
        return [vscode.Uri.file(path.join(log.worktree, f.path)), left, right];
      });
      await vscode.commands.executeCommand('vscode.changes', title, res);
      return;
    }
    const patch = await turns.patchBetween(log.worktree, turn.start, to);
    const doc = await vscode.workspace.openTextDocument({ language: 'diff', content: `# ${title}${turn.prompt ? `\n# ${turn.prompt.replace(/\s+/g, ' ').slice(0, 200)}` : ''}\n\n${patch}` });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  /** Volta os arquivos da worktree ao começo (ou ao fim) de um turno, com desfazer. */
  async restoreTurn(log: TurnLog, turn: Turn, point: 'start' | 'end' = 'start') {
    const target = point === 'end' ? turn.end : turn.start;
    if (!target) return;
    const where = log.branch ?? path.basename(log.worktree);
    const running = this.agentTerms.list(log.worktree).some(o => o.state === 'working');
    const go = t('Restore');
    const ok = await vscode.window.showWarningMessage(
      point === 'start' ? t('Put the files of {0} back as they were before turn {1}?', where, turn.n) : t('Put the files of {0} back as they were after turn {1}?', where, turn.n),
      {
        modal: true,
        detail: [
          t('Only files change: commits, the index and the branch stay as they are. A checkpoint of the current state is saved first, so you can undo.'),
          running ? t('Warning: an agent is working in this worktree right now.') : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
      go,
    );
    if (ok !== go) return;
    const r = await turns.restore(log.worktree, target);
    await turns.keepRef(log.worktree, `${turns.TURN_REFS}/${turns.refPart(log.key)}/restore-${Date.now()}`, r.before);
    this.ctl.scheduleRefresh(50);
    const undo = t('Undo');
    const pick = await vscode.window.showInformationMessage(t('{0} file(s) of {1} restored.', r.files.length, where), undo);
    if (pick === undo) {
      await turns.restore(log.worktree, r.before);
      this.ctl.scheduleRefresh(50);
    }
  }

  /** Lista os turnos das sessões de uma worktree e abre/restaura o escolhido. */
  async pickTurn(worktree: string) {
    const logs = this.logsFor(worktree);
    const items: (vscode.QuickPickItem & { log?: TurnLog; turn?: Turn })[] = [];
    for (const log of logs) {
      items.push({ label: `${log.agent}${log.session ? ` · ${log.session.slice(0, 8)}` : ''}`, kind: vscode.QuickPickItemKind.Separator });
      for (const turn of [...log.turns].reverse()) items.push({ ...this.turnLabel(turn), log, turn });
    }
    if (!items.length) {
      vscode.window.showInformationMessage(t('No agent turns recorded in this worktree yet (checkpoints need Claude opened by AgentYard, or the project integration).'));
      return;
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: t('Agent turns in {0}', this.bridge.nameOf(worktree)), matchOnDetail: true });
    if (!pick?.log || !pick.turn) return;
    const see = t('See changes');
    const back = t('Restore files to before this turn');
    const after = t('Restore files to after this turn');
    const act = await vscode.window.showQuickPick([see, back, ...(pick.turn.end ? [after] : [])], { placeHolder: pick.label });
    if (act === see) await this.showTurn(pick.log, pick.turn);
    else if (act === back) await this.restoreTurn(pick.log, pick.turn, 'start');
    else if (act === after) await this.restoreTurn(pick.log, pick.turn, 'end');
  }

  turnLabel(turn: Turn): { label: string; description: string; detail?: string } {
    const when = new Date(turn.startedAt).toLocaleTimeString();
    const stats = turn.end
      ? `${t('{0} file(s)', turn.files ?? 0)} +${turn.additions ?? 0} −${turn.deletions ?? 0}${turn.commits ? ` · ${t('{0} commit(s)', turn.commits)}` : ''}`
      : t('running');
    return { label: t('Turn {0}', turn.n), description: `${when} · ${stats}`, detail: turn.prompt?.replace(/\s+/g, ' ').slice(0, 160) };
  }

  private async turnDiffTool(args: Record<string, any>, cwd: string, open?: OpenAgent): Promise<string | { text: string; isError?: boolean }> {
    const w = this.bridge.worktreeAt(open?.path ?? cwd);
    if (!w) return { text: `${cwd} is not a worktree of the repository open in AgentYard.`, isError: true };
    const log = (open && this.logs()[open.id]) ?? this.logsFor(w.path)[0];
    if (!log?.turns.length) return 'No turns recorded yet in this worktree.';
    const n = Number(args.turn);
    const done = log.turns.filter(x => x.end);
    const turn = n ? log.turns.find(x => x.n === n) : done[done.length - 1] ?? log.turns[log.turns.length - 1];
    if (!turn) return { text: `Turn ${n} not found. Turns: ${log.turns.map(x => x.n).join(', ')}.`, isError: true };
    const to = turn.end ?? (await turns.snapshot(w.path));
    const patch = await turns.patchBetween(w.path, turn.start, to);
    const max = 60_000;
    return `Turn ${turn.n}${turn.prompt ? ` (prompt: ${turn.prompt.replace(/\s+/g, ' ').slice(0, 200)})` : ''}:\n\n${patch.length > max ? `${patch.slice(0, max)}\n… (truncated)` : patch || '(no changes)'}`;
  }

  // ------------------------------------------------------------ tarefas

  /**
   * Manda uma tarefa para a worktree: se já há um Claude com a ponte parado ali, digita `oneLine` nele
   * (ele busca o resto pelas ferramentas MCP); senão, abre um agente novo com `full`.
   */
  /** Há um Claude com a ponte parado nesta worktree (pronto para receber uma tarefa de uma linha)? */
  hasIdleAgent(worktree: string): boolean {
    return this.cfg().get<boolean>('claude.mcp', true) && this.agentTerms.claudeIn(worktree).some(o => o.bridged && o.state === 'idle');
  }

  async sendTask(worktree: string, branch: string | undefined, oneLine: string, full: string): Promise<'typed' | 'launched'> {
    const idle = this.cfg().get<boolean>('claude.mcp', true) ? this.agentTerms.claudeIn(worktree).find(o => o.bridged && o.state === 'idle') : undefined;
    if (idle && (await this.agentTerms.type(idle, oneLine, true))) return 'typed';
    await this.agentTerms.launchWithPrompt(worktree, branch, full);
    return 'launched';
  }

  // ------------------------------------------------------------ autoria

  /** Quem escreveu a linha do editor: o commit, e a sessão do agente que o fez (nota de autoria). */
  async whoWrote(editor = vscode.window.activeTextEditor) {
    if (!editor || editor.document.uri.scheme !== 'file') return;
    const file = editor.document.uri.fsPath;
    const w = this.bridge.worktreeAt(file);
    const cwd = w?.path ?? path.dirname(file);
    const line = editor.selection.active.line + 1;
    const b = await turns.blameLine(cwd, path.relative(cwd, file), line);
    if (!b) {
      vscode.window.showInformationMessage(t('Line {0} is not committed yet.', line));
      return;
    }
    const note = await turns.noteOf(cwd, b.sha);
    const showCommit = t('Show commit');
    if (!note?.session) {
      const pick = await vscode.window.showInformationMessage(t('Line {0}: {1} ({2}, {3}). No agent session recorded for this commit.', line, b.summary, b.sha.slice(0, 8), b.author), showCommit);
      if (pick) await vscode.commands.executeCommand('worktreeGraph.showCommitSha', b.sha);
      return;
    }
    const transcript = t('Open transcript');
    const pick = await vscode.window.showInformationMessage(
      t('Line {0}: {1} ({2}) — written by {3}, turn {4}.', line, b.summary, b.sha.slice(0, 8), note.agent ?? 'Claude Code', note.turn ?? '?'),
      { detail: note.prompt },
      transcript,
      showCommit,
    );
    if (pick === transcript) await this.openTranscript(note.session);
    else if (pick === showCommit) await vscode.commands.executeCommand('worktreeGraph.showCommitSha', b.sha);
  }

  // ------------------------------------------------------------ contadores

  counters(): Record<string, TaskCounters> {
    return this.ctx.workspaceState.get<Record<string, TaskCounters>>(COUNTERS_KEY, {});
  }

  countersFor(p: string): TaskCounters | undefined {
    return this.counters()[keyOf(p)];
  }

  private async bump(p: string, field: Exclude<keyof TaskCounters, 'since'>) {
    const all = this.counters();
    const k = keyOf(p);
    const c = all[k] ?? { since: Date.now(), turns: 0, permissions: 0, approvedInVsCode: 0, deniedInVsCode: 0, guardBlocks: 0, plans: 0, budgetBlocks: 0 };
    c[field] = (c[field] ?? 0) + 1;
    all[k] = c;
    await this.ctx.workspaceState.update(COUNTERS_KEY, all);
  }

  async resetCounters(p: string) {
    const all = this.counters();
    delete all[keyOf(p)];
    await this.ctx.workspaceState.update(COUNTERS_KEY, all);
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
  }
}
