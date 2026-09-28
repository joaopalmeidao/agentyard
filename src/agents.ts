import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Controller } from './controller';
import { AGENT_FILE_SUFFIXES, AgentState, EventTail, HookEvent, insertArgs, instrumentCommand, isClaudeCommand, nextState, pruneEvents, withIdeFlag, withoutPermissionArgs, writeHookSettings, StatusLineOptions } from './claude/hooks';
import { describeToolRequest } from './claude/guard';
import { StatusLineMode, userStatusLineCommand } from './claude/statusLine';
import { t } from './i18n';
import { askTask } from './taskInput';

export interface AgentConfig {
  name: string;
  /** Linha de comando enviada ao terminal. "{prompt}" pede um texto antes de abrir. */
  command: string;
  /** Linha de comando para abrir já com uma tarefa; "{prompt}" vira o texto. */
  promptCommand?: string;
}

const DEFAULT_AGENTS: AgentConfig[] = [{ name: 'Claude Code', command: 'claude', promptCommand: 'claude {prompt}' }];

export function agents(ctl: Controller): AgentConfig[] {
  const list = ctl.cfg().get<AgentConfig[]>('agents', DEFAULT_AGENTS).filter(a => a && a.name && a.command);
  return list.length ? list : DEFAULT_AGENTS;
}

/** Nome do agente configurado que roda o Claude Code (o padrão se nenhum). */
export function claudeAgentName(ctl: Controller): string {
  return agents(ctl).find(a => isClaudeCommand(a.command))?.name ?? 'Claude Code';
}

/** Comando para abrir o agente com uma tarefa: o configurado, o padrão conhecido, ou `command {prompt}`. */
export function promptCommandOf(a: AgentConfig): string {
  if (a.promptCommand) return a.promptCommand;
  if (a.command.includes('{prompt}')) return a.command;
  const bin = a.command.trim().split(/\s+/)[0].toLowerCase();
  if (bin === 'gemini') return 'gemini -i {prompt}';
  return `${a.command} {prompt}`;
}

/**
 * Grava o texto num arquivo e devolve a expressão do shell que o lê como UM argumento. Passar o texto
 * direto no sendText quebraria na primeira linha (cada \n vira um Enter).
 */
export function promptArgument(prompt: string, shell = vscode.env.shell): { arg: string; file: string } {
  const dir = path.join(os.tmpdir(), 'worktree-graph-prompts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 7)}.md`);
  fs.writeFileSync(file, prompt, 'utf8');
  const sh = path.basename(shell || '').toLowerCase();
  let arg: string;
  if (/pwsh|powershell/.test(sh)) arg = `(Get-Content -Raw -LiteralPath '${file.replace(/'/g, "''")}')`;
  else if (sh.startsWith('cmd')) arg = `"${prompt.replace(/\r?\n/g, ' ').replace(/"/g, "'")}"`;
  else arg = `"$(cat '${file.replace(/\\/g, '/').replace(/'/g, `'\\''`)}')"`;
  return { arg, file };
}

/** Um agente acabou de ser aberto pela extensão (a frente "pronto para revisar" acompanha a partir daqui). */
export interface AgentLaunch {
  path: string;
  branch?: string;
  terminal: vscode.Terminal;
  agent: string;
  prompt?: string;
  /** Aberto por um projeto longo (chave do projeto): o projeto cuida do "terminou". */
  project?: string;
}

/** Um terminal de agente aberto pela extensão. */
export interface OpenAgent {
  terminal: vscode.Terminal;
  path: string;
  branch?: string;
  agent: string;
  started: number;
  /** Aberto já com uma tarefa (launchWithPrompt). */
  task?: boolean;
  /** Nome do arquivo de eventos dos hooks (WTGRAPH_AGENT_ID no env do terminal). */
  id: string;
  /** O comando abre o Claude Code. */
  claude?: boolean;
  /** Estado pelos hooks do Claude (só quando `claude.trackState` está ligado). */
  state?: AgentState;
  stateAt?: number;
  /** Mensagem do pedido que deixou o Claude esperando (ex.: permissão para uma ferramenta). */
  message?: string;
  /** Tipo do pedido (`permission_prompt`, por exemplo), quando o Claude está esperando. */
  notificationType?: string;
  /** Sessão do Claude Code deste terminal (vem do hook SessionStart). */
  sessionId?: string;
  /** Aberto com os hooks e o MCP da ponte (src/bridge). */
  bridged?: boolean;
  /** O pedido de permissão está sendo perguntado no VS Code (src/claude/integration.ts). */
  asking?: boolean;
  /** Projeto longo que abriu este terminal (chave do projeto). */
  project?: string;
}

export interface AgentHookEvent {
  open: OpenAgent;
  event: HookEvent;
}

export interface AgentStateChange {
  open: OpenAgent;
  previous?: AgentState;
}

export interface StartOptions {
  task?: boolean;
  prompt?: string;
  name?: string;
  /** Não acrescenta `claude.extraArgs` (o comando já traz os argumentos escolhidos). */
  noExtraArgs?: boolean;
  /** Id do terminal (nome dos arquivos dos hooks), quando quem abre precisa gravar algo antes. */
  id?: string;
  /** Projeto longo que abre o terminal. */
  project?: string;
  /** Modo de permissão do Claude (`--permission-mode`); vale sobre o de `claude.extraArgs`. */
  permissionMode?: string;
}

/** O que a ponte com o AgentYard (src/bridge) acrescenta ao Claude aberto: hooks e servidor MCP. */
export interface LaunchExtras {
  hooks: Record<string, unknown[]>;
  mcpConfig?: string;
}

/** Onde um terminal de agente abre: painel, aba no editor ativo, editor ao lado ou dividido com outro da worktree. */
export type Placement = 'panel' | 'editor' | 'beside' | 'split';

/**
 * Lugar do terminal pela configuração `agentTerminalLocation`. `auto`: tarefas no painel, sessões
 * interativas no editor ao lado. `split` sem outro terminal da worktree para dividir cai no painel.
 */
export function placementOf(pref: string | undefined, task: boolean, hasSibling: boolean): Placement {
  switch (pref) {
    case 'editor':
      return 'editor';
    case 'editorBeside':
      return 'beside';
    case 'split':
      return hasSibling ? 'split' : 'panel';
    case 'auto':
      return task ? 'panel' : 'beside';
  }
  return 'panel';
}

/** Terminais que abrem sem tirar o foco de onde você está (`agentTerminalFocus`). */
export function keepsFocus(pref: string | undefined, task: boolean): boolean {
  return pref === 'never' || (pref !== 'always' && task);
}

/** Nomes repetidos viram "Claude Code ×2". */
export function agentsLabel(names: string[]): string {
  const n = new Map<string, number>();
  for (const a of names) n.set(a, (n.get(a) ?? 0) + 1);
  return [...n].map(([a, c]) => (c > 1 ? `${a} ×${c}` : a)).join(', ');
}

/** "agora", "há 5 min", "há 2 h", "há 3 d". */
export function sinceText(since: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - since) / 60000));
  if (m < 1) return t('now');
  if (m < 60) return t('{0} min ago', m);
  const h = Math.floor(m / 60);
  return h < 24 ? t('{0} h ago', h) : t('{0} d ago', Math.floor(h / 24));
}

/** Estado do agente em poucas palavras. */
export function stateText(s: AgentState | undefined): string {
  switch (s) {
    case 'starting':
      return t('starting');
    case 'working':
      return t('working');
    case 'waiting':
      return t('waiting for you');
    case 'idle':
      return t('your turn');
    case 'ended':
      return t('session ended');
  }
  return '';
}

const keyOf = (p: string) => path.normalize(p).toLowerCase();

const TERMINAL_COLORS = ['terminal.ansiBlue', 'terminal.ansiGreen', 'terminal.ansiMagenta', 'terminal.ansiCyan', 'terminal.ansiYellow', 'terminal.ansiRed'];

/** Cor do terminal: a mesma para todos os terminais de uma worktree. */
export function terminalColorOf(worktreePath: string): string {
  let h = 0;
  for (const c of keyOf(worktreePath)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TERMINAL_COLORS[h % TERMINAL_COLORS.length];
}

/** Colunas da grade de agentes, e o comando que foca cada uma. */
const GRID_MAX = 4;
const GROUP_FOCUS = ['First', 'Second', 'Third', 'Fourth'].map(n => `workbench.action.focus${n}EditorGroup`);

/** Espera máxima pela sessão antes de digitar mesmo assim (hooks que não rodam, por exemplo). */
const PENDING_MS = 10_000;
/** Sem hooks: tempo para o Claude abrir antes de digitar num terminal recém-aberto. */
const STARTUP_MS = 4000;

/**
 * Terminais de agente abertos pela extensão, por worktree. Pode haver vários do mesmo agente na
 * mesma worktree; abrir de novo pergunta se traz um deles para frente ou abre outro (`agentWhenOpen`).
 * Tarefas (launchWithPrompt) sempre abrem um novo.
 *
 * Os do Claude Code saem com os hooks de src/claude/hooks.ts, e daí vem o estado de cada um
 * (trabalhando, esperando você, sua vez). Depois de recarregar a janela, os terminais que o VS Code
 * restaura são reencontrados pelo env.
 */
export class AgentTerminals implements vscode.Disposable {
  private readonly open: OpenAgent[] = [];
  private readonly launched = new vscode.EventEmitter<AgentLaunch>();
  readonly onDidLaunch = this.launched.event;
  private readonly changed = new vscode.EventEmitter<void>();
  /** A lista de terminais abertos (ou o estado de um deles) mudou. */
  readonly onDidChange = this.changed.event;
  private readonly stateChanged = new vscode.EventEmitter<AgentStateChange>();
  /** Um Claude mudou de estado. */
  readonly onDidChangeState = this.stateChanged.event;
  private readonly hookEvent = new vscode.EventEmitter<AgentHookEvent>();
  /** Cada evento dos hooks de um Claude, na ordem em que chegou. */
  readonly onDidHookEvent = this.hookEvent.event;
  private readonly disposables: vscode.Disposable[] = [this.launched, this.changed, this.stateChanged, this.hookEvent];
  private readonly tails = new Map<string, EventTail>();
  private readonly pending = new Map<string, { text: string; submit: boolean }>();
  private watcher?: fs.FSWatcher;
  private poll?: NodeJS.Timeout;
  /** Arquivo do último prompt enviado (usado pelos testes). */
  lastPromptFile?: string;
  /** Preenchido pela ponte (src/bridge): hooks e MCP a mais para cada Claude aberto. */
  launchExtras?: () => LaunchExtras | undefined;

  constructor(private readonly ctl: Controller) {
    this.disposables.push(
      vscode.window.onDidCloseTerminal(term => {
        const i = this.open.findIndex(o => o.terminal === term);
        if (i >= 0) this.forget(this.open.splice(i, 1)[0]);
        this.changed.fire();
        this.ctl.scheduleRefresh(50);
      }),
      vscode.window.onDidOpenTerminal(term => this.attach(term) && this.changed.fire()),
    );
    let any = false;
    for (const term of vscode.window.terminals) any = this.attach(term) || any;
    pruneEvents(this.eventsDir(), new Set(this.open.map(o => o.id)));
    if (any) this.changed.fire();
  }

  /** Pasta dos arquivos de eventos e do settings com os hooks. */
  eventsDir(): string {
    return path.join(this.ctl.ctx.globalStorageUri.fsPath, 'claude-events');
  }

  /** Statusline que vai junto dos hooks (`claude.statusLine`): grava as métricas de uso de cada terminal. */
  statusLineOptions(): StatusLineOptions {
    const mode = this.ctl.cfg().get<StatusLineMode>('claude.statusLine', 'keep');
    const claudeDir = this.ctl.cfg().get<string>('claude.configDir', '') || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    return { mode, userCommand: mode === 'keep' ? userStatusLineCommand(claudeDir) : undefined, labels: { session: t('session'), week: t('week') } };
  }

  /** Terminal restaurado depois de recarregar a janela: volta a acompanhar se foi aberto pela extensão. */
  private attach(term: vscode.Terminal): boolean {
    if (term.exitStatus !== undefined || this.open.some(o => o.terminal === term)) return false;
    const env = ((term.creationOptions as vscode.TerminalOptions).env ?? {}) as Record<string, string | null | undefined>;
    const id = env.WTGRAPH_AGENT_ID;
    const wt = env.WTGRAPH_WORKTREE;
    if (!id || !wt) return false;
    const o: OpenAgent = {
      terminal: term,
      path: wt,
      branch: env.WTGRAPH_BRANCH || undefined,
      agent: env.WTGRAPH_AGENT || 'Claude Code',
      started: Date.now(),
      id,
      task: env.WTGRAPH_TASK === '1',
      claude: env.WTGRAPH_CLAUDE === '1',
      bridged: env.WTGRAPH_BRIDGE === '1',
      project: env.WTGRAPH_PROJECT || undefined,
    };
    this.open.push(o);
    if (env.WTGRAPH_HOOKS === '1') {
      o.state = 'starting';
      this.watchEvents(o);
    }
    return true;
  }

  /** Terminais abertos, opcionalmente só os de uma worktree (e de um agente). */
  list(worktreePath?: string, agentName?: string): OpenAgent[] {
    return this.open.filter(
      o => o.terminal.exitStatus === undefined && (!worktreePath || keyOf(o.path) === keyOf(worktreePath)) && (!agentName || o.agent === agentName),
    );
  }

  /** Claude Code abertos (numa worktree ou em todas), o mais recente primeiro. */
  claudeIn(worktreePath?: string): OpenAgent[] {
    return this.list(worktreePath)
      .filter(o => o.claude)
      .reverse();
  }

  /** Avisa que algo de um terminal mudou por fora (ex.: pedido de permissão aberto no VS Code). */
  refresh() {
    this.changed.fire();
  }

  byTerminal(term: vscode.Terminal): OpenAgent | undefined {
    return this.open.find(o => o.terminal === term);
  }

  stateOf(term: vscode.Terminal): AgentState | undefined {
    return this.byTerminal(term)?.state;
  }

  /** Terminal aberto com esta sessão do Claude Code. */
  findBySession(sessionId: string): OpenAgent | undefined {
    return this.list().find(o => o.sessionId === sessionId);
  }

  /** Agentes abertos em cada worktree (chave: caminho em minúsculas), um nome por terminal. */
  running(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const o of this.list()) out.set(keyOf(o.path), [...(out.get(keyOf(o.path)) ?? []), o.agent]);
    return out;
  }

  // ---------- eventos dos hooks ----------

  private watchEvents(o: OpenAgent) {
    this.tails.set(o.id, new EventTail(path.join(this.eventsDir(), `${o.id}.jsonl`)));
    this.ensureWatcher();
    this.readEvents(o);
  }

  private ensureWatcher() {
    const dir = this.eventsDir();
    if (!this.watcher) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        this.watcher = fs.watch(dir, (_e, name) => {
          const id = name?.toString().replace(/\.jsonl$/, '');
          const o = id ? this.open.find(x => x.id === id) : undefined;
          if (o) this.readEvents(o);
        });
        this.watcher.on('error', () => {
          this.watcher?.close();
          this.watcher = undefined;
        });
      } catch {
        // sem fs.watch: fica só a leitura periódica
      }
    }
    // fs.watch perde eventos em alguns sistemas de arquivos; uma leitura periódica barata cobre
    if (!this.poll) this.poll = setInterval(() => this.open.forEach(o => this.tails.has(o.id) && this.readEvents(o)), 3000);
  }

  private readEvents(o: OpenAgent) {
    const events = this.tails.get(o.id)?.read() ?? [];
    if (!events.length) return;
    const previous = o.state;
    const session = o.sessionId;
    for (const e of events) {
      o.state = nextState(o.state ?? 'starting', e);
      if (e.session_id) o.sessionId = e.session_id;
      if (e.hook_event_name === 'Notification' && o.state === 'waiting') {
        o.message = e.message;
        o.notificationType = e.notification_type;
      }
      if (e.hook_event_name === 'PermissionRequest') {
        o.message = t('Permission: {0}', describeToolRequest(e.tool_name, e.tool_input));
        o.notificationType = 'permission_prompt';
      }
      this.hookEvent.fire({ open: o, event: e });
    }
    if (o.state !== 'waiting') o.message = o.notificationType = undefined;
    if (o.state === previous) {
      if (o.sessionId !== session) this.changed.fire();
      return;
    }
    o.stateAt = Date.now();
    if (o.state === 'idle') this.flushPending(o);
    this.stateChanged.fire({ open: o, previous });
    this.changed.fire();
  }

  private forget(o: OpenAgent) {
    this.pending.delete(o.id);
    if (this.tails.delete(o.id)) {
      for (const suffix of AGENT_FILE_SUFFIXES) {
        try {
          fs.unlinkSync(path.join(this.eventsDir(), `${o.id}${suffix}`));
        } catch {
          // o hook nunca escreveu, ou já foi apagado
        }
      }
    }
    if (!this.tails.size) this.stopWatcher();
  }

  private stopWatcher() {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
  }

  /**
   * Digita `text` no terminal do agente e traz o terminal para frente. Se o Claude está esperando
   * uma resposta, confirma antes (o texto responderia o pedido); se ainda está abrindo, guarda até
   * a sessão começar.
   */
  async type(o: OpenAgent, text: string, submit: boolean): Promise<boolean> {
    if (!(await this.confirmIfWaiting(o))) return false;
    o.terminal.show();
    if (o.state === 'starting') {
      const prev = this.pending.get(o.id);
      this.pending.set(o.id, { text: prev ? `${prev.text}${text}` : text, submit: submit || !!prev?.submit });
      setTimeout(() => this.flushPending(o), PENDING_MS);
      return true;
    }
    // sem hooks não dá para saber quando o Claude abriu; num terminal recém-aberto, dá um tempo
    const early = o.state === undefined ? STARTUP_MS - (Date.now() - o.started) : 0;
    if (early > 0) {
      setTimeout(() => o.terminal.exitStatus === undefined && o.terminal.sendText(text, submit), early);
      return true;
    }
    o.terminal.sendText(text, submit);
    return true;
  }

  /** Com o Claude esperando uma resposta, o que for digitado responde o pedido: confirma antes. */
  async confirmIfWaiting(o: OpenAgent): Promise<boolean> {
    if (o.state !== 'waiting') return true;
    const go = t('Send anyway');
    const pick = await vscode.window.showWarningMessage(
      t('{0} in {1} is waiting for your answer: what you send now goes to that question.', o.agent, o.branch ?? path.basename(o.path)),
      { modal: true, detail: o.message },
      go,
    );
    return pick === go;
  }

  private flushPending(o: OpenAgent) {
    const p = this.pending.get(o.id);
    if (!p || o.terminal.exitStatus !== undefined) return;
    this.pending.delete(o.id);
    o.terminal.sendText(p.text, p.submit);
  }

  // ---------- controlar ----------

  /** O terminal está como aba no editor? (a API não diz; a aba de terminal tem o nome dele) */
  inEditor(term: vscode.Terminal): boolean {
    return vscode.window.tabGroups.all.some(g => g.tabs.some(tab => tab.input instanceof vscode.TabInputTerminal && tab.label === term.name));
  }

  /** Esc no Claude: interrompe o que ele está fazendo (ou recusa o pedido em aberto). */
  interrupt(o: OpenAgent) {
    o.terminal.sendText('\x1b', false);
  }

  /** Responde o pedido de permissão em aberto: Enter aceita a opção marcada ("Yes"), Esc recusa. */
  answerPermission(o: OpenAgent, allow: boolean): boolean {
    if (o.state !== 'waiting' || o.terminal.exitStatus !== undefined) return false;
    o.terminal.sendText(allow ? '\r' : '\x1b', false);
    return true;
  }

  /** Abre de novo, no mesmo terminal, a sessão que terminou (o shell dele continua aberto). */
  resumeInPlace(o: OpenAgent) {
    if (!o.sessionId || o.terminal.exitStatus !== undefined) return;
    // o comando do agente configurado (com as flags dele), não um `claude` qualquer
    const configured = agents(this.ctl).find(a => a.name === o.agent && isClaudeCommand(a.command))?.command.replace(/\{prompt\}/g, '').trim();
    let command = `${configured || 'claude'} --resume ${o.sessionId}`;
    if (this.ctl.cfg().get<boolean>('claude.connectIde', false)) command = withIdeFlag(command);
    if (this.tails.has(o.id)) {
      try {
        command = instrumentCommand(command, writeHookSettings(this.eventsDir(), undefined, undefined, this.statusLineOptions()));
        o.state = 'starting';
        o.stateAt = Date.now();
      } catch (e) {
        this.ctl.log(t('Could not prepare the Claude Code hooks: {0}', (e as Error).message));
      }
    }
    o.terminal.show();
    o.terminal.sendText(command);
    this.changed.fire();
  }

  /** Leva o terminal para o editor (ao lado) ou de volta ao painel, pelos comandos do próprio VS Code. */
  async moveTo(o: OpenAgent, where: 'editor' | 'panel') {
    const inEditor = this.inEditor(o.terminal);
    if ((where === 'editor') === inEditor) return o.terminal.show();
    o.terminal.show();
    await vscode.commands.executeCommand(where === 'editor' ? 'workbench.action.terminal.moveToEditor' : 'workbench.action.terminal.moveToTerminalPanel');
  }

  /**
   * Põe os terminais lado a lado no editor, um por coluna (até 4): primeiro volta todos ao painel,
   * depois monta as colunas e move cada um para a sua.
   */
  async arrangeGrid(list: OpenAgent[]) {
    const terms = list.slice(0, GRID_MAX);
    if (!terms.length) return;
    for (const o of terms) if (this.inEditor(o.terminal)) await this.moveTo(o, 'panel');
    await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: terms.map(() => ({})) });
    for (let i = 0; i < terms.length; i++) {
      await vscode.commands.executeCommand(GROUP_FOCUS[i]);
      terms[i].terminal.show(true);
      await vscode.commands.executeCommand('workbench.action.terminal.moveToEditor');
    }
  }

  // ---------- abrir ----------

  private async pickAgent(worktreePath: string, branch: string | undefined, agentName?: string): Promise<AgentConfig | undefined> {
    const list = agents(this.ctl);
    let agent = agentName ? list.find(a => a.name === agentName) : undefined;
    if (!agent && !agentName && list.length === 1) agent = list[0];
    if (!agent) {
      const pick = await vscode.window.showQuickPick(
        list.map(a => ({ label: a.name, description: a.command, agent: a })),
        { placeHolder: t('Open which agent in {0}?', branch ?? path.basename(worktreePath)) },
      );
      agent = pick?.agent;
    }
    return agent;
  }

  private async createTerminal(worktreePath: string, branch: string | undefined, name: string, env: Record<string, string>, task: boolean, preserveFocus: boolean) {
    const { base } = await this.ctl.base().catch(() => ({ base: '' }));
    const sibling = this.list(worktreePath).filter(o => !this.inEditor(o.terminal)).pop();
    const place = placementOf(this.ctl.cfg().get<string>('agentTerminalLocation', 'panel'), task, !!sibling);
    const location: vscode.TerminalOptions['location'] =
      place === 'editor'
        ? { viewColumn: vscode.ViewColumn.Active, preserveFocus }
        : place === 'beside'
          ? { viewColumn: vscode.ViewColumn.Beside, preserveFocus }
          : place === 'split' && sibling
            ? { parentTerminal: sibling.terminal }
            : vscode.TerminalLocation.Panel;
    return vscode.window.createTerminal({
      name,
      cwd: worktreePath,
      iconPath: new vscode.ThemeIcon('sparkle'),
      color: new vscode.ThemeColor(terminalColorOf(worktreePath)),
      location,
      env: { WTGRAPH_BRANCH: branch ?? '', WTGRAPH_BASE: base, WTGRAPH_WORKTREE: worktreePath, ...env },
    });
  }

  /** Nome do terminal; a partir do segundo do mesmo agente (e mesmo tipo) na worktree ganha "#n". */
  private terminalName(agent: string, worktreePath: string, branch: string | undefined, task = false) {
    const n = this.list(worktreePath, agent).filter(o => !!o.task === task).length;
    return `${agent} · ${branch ?? path.basename(worktreePath)}${task ? ` · ${t('task')}` : ''}${n ? ` #${n + 1}` : ''}`;
  }

  describe(o: OpenAgent) {
    const opened = o.task ? t('opened {0} · with a task', sinceText(o.started)) : t('opened {0}', sinceText(o.started));
    return o.state ? `${stateText(o.state)} · ${opened}` : opened;
  }

  /**
   * Abre um terminal novo na worktree rodando `command` e passa a acompanhá-lo. Comandos do Claude
   * Code ganham os hooks de estado (`claude.trackState`).
   */
  async start(worktreePath: string, branch: string | undefined, agent: string, command: string, opts: StartOptions = {}): Promise<OpenAgent> {
    const id = opts.id ?? newAgentId();
    const claude = isClaudeCommand(command);
    if (claude && !opts.noExtraArgs) {
      const extra = this.ctl.cfg().get<string>('claude.extraArgs', '');
      command = insertArgs(command, opts.permissionMode ? withoutPermissionArgs(extra) : extra);
    }
    if (claude && opts.permissionMode && !/(^|\s)--permission-mode(\s|=)/.test(command)) command = insertArgs(command, `--permission-mode ${opts.permissionMode}`);
    if (claude && this.ctl.cfg().get<boolean>('claude.connectIde', false)) command = withIdeFlag(command);
    const preserveFocus = keepsFocus(this.ctl.cfg().get<string>('agentTerminalFocus', 'interactive'), !!opts.task);
    let hooks = false;
    let bridged = false;
    if (claude && this.ctl.cfg().get<boolean>('claude.trackState', true)) {
      try {
        const extras = this.launchExtras?.();
        bridged = !!extras && Object.keys(extras.hooks).length > 0;
        // arquivos diferentes com e sem a ponte: um terminal restaurado não herda hooks que não pediu
        const settings = writeHookSettings(this.eventsDir(), extras?.hooks, bridged ? 'hooks.bridge.settings.json' : 'hooks.settings.json', this.statusLineOptions());
        command = instrumentCommand(command, settings, extras?.mcpConfig);
        hooks = true;
      } catch (e) {
        this.ctl.log(t('Could not prepare the Claude Code hooks: {0}', (e as Error).message));
      }
    }
    const terminal = await this.createTerminal(worktreePath, branch, opts.name ?? this.terminalName(agent, worktreePath, branch, !!opts.task), {
      WTGRAPH_AGENT_ID: id,
      WTGRAPH_AGENT: agent,
      WTGRAPH_TASK: opts.task ? '1' : '',
      WTGRAPH_CLAUDE: claude ? '1' : '',
      WTGRAPH_HOOKS: hooks ? '1' : '',
      WTGRAPH_BRIDGE: bridged ? '1' : '',
      WTGRAPH_PROJECT: opts.project ?? '',
    }, !!opts.task, preserveFocus);
    const o: OpenAgent = { terminal, path: worktreePath, branch, agent, started: Date.now(), id, task: opts.task, claude, bridged, state: hooks ? 'starting' : undefined, project: opts.project };
    this.open.push(o);
    if (hooks) this.watchEvents(o);
    this.changed.fire();
    terminal.show(preserveFocus);
    terminal.sendText(command);
    this.launched.fire({ path: worktreePath, branch, terminal, agent, prompt: opts.prompt, project: opts.project });
    this.ctl.scheduleRefresh(50);
    return o;
  }

  /**
   * Abre o agente na worktree. Se já houver terminal dele ali: `mode` 'reuse' traz o último para
   * frente, 'new' abre outro; sem `mode`, segue `agentWhenOpen` (padrão: perguntar).
   */
  async launch(worktreePath: string, branch: string | undefined, agentName?: string, mode?: 'reuse' | 'new') {
    const agent = await this.pickAgent(worktreePath, branch, agentName);
    if (!agent) return;

    const openHere = this.list(worktreePath, agent.name);
    if (openHere.length && mode !== 'new') {
      const pref = mode ?? this.ctl.cfg().get<string>('agentWhenOpen', 'ask');
      if (pref === 'reuse') {
        openHere[openHere.length - 1].terminal.show();
        return;
      }
      if (pref !== 'new') {
        const items: (vscode.QuickPickItem & { o?: OpenAgent })[] = [
          { label: `$(add) ${t('Open another {0}', agent.name)}`, description: t('new terminal, new session') },
          { label: t('Already open'), kind: vscode.QuickPickItemKind.Separator },
          ...openHere
            .slice()
            .reverse()
            .map(o => ({ label: `$(terminal) ${o.terminal.name}`, description: this.describe(o), o })),
        ];
        const pick = await vscode.window.showQuickPick(items, {
          placeHolder: t('{0} is already open in {1}: go to one of them or open another?', agent.name, branch ?? path.basename(worktreePath)),
        });
        if (!pick) return;
        if (pick.o) {
          pick.o.terminal.show();
          return;
        }
      }
    }

    let command = agent.command;
    if (command.includes('{prompt}')) {
      const prompt = await askTask({
        title: t('{0} in {1}', agent.name, branch ?? path.basename(worktreePath)),
        prompt: t('Initial task for the agent (empty = open without a task)'),
      });
      if (prompt === undefined) return;
      if (prompt.trim()) {
        const p = promptArgument(prompt.trim());
        this.lastPromptFile = p.file;
        command = command.replace(/\{prompt\}/g, () => p.arg).trim();
      } else {
        command = command.replace(/\{prompt\}/g, '').trim();
      }
    }

    await this.start(worktreePath, branch, agent.name, command);
    this.ctl.log(t('Agent {0} opened in {1}: {2}', agent.name, worktreePath, command));
  }

  /** Abre um terminal novo com o agente já recebendo `prompt` como tarefa. */
  async launchWithPrompt(worktreePath: string, branch: string | undefined, prompt: string, agentName?: string, opts: { permissionMode?: string } = {}): Promise<void> {
    const agent = await this.pickAgent(worktreePath, branch, agentName ?? agents(this.ctl)[0]?.name);
    if (!agent) return;
    const p = promptArgument(prompt);
    this.lastPromptFile = p.file;
    const command = promptCommandOf(agent).replace(/\{prompt\}/g, () => p.arg).trim();
    await this.start(worktreePath, branch, agent.name, command, { task: true, prompt, permissionMode: opts.permissionMode });
    this.ctl.log(t('Agent {0} with a task in {1} (prompt in {2})', agent.name, worktreePath, p.file));
  }

  /** Lista os terminais de agente abertos, agrupados por worktree, e traz para frente o escolhido. */
  async pickOpen(worktreePath?: string, filter?: (o: OpenAgent) => boolean) {
    const all = this.list(worktreePath).filter(o => !filter || filter(o));
    if (!all.length) {
      vscode.window.showInformationMessage(worktreePath ? t('No agents open in this worktree.') : t('No agents open.'));
      return;
    }
    if (filter && all.length === 1) return all[0].terminal.show();
    const items: (vscode.QuickPickItem & { o?: OpenAgent })[] = [];
    for (const list of groupByWorktree(all)) {
      items.push({ label: list[0].branch ?? path.basename(list[0].path), kind: vscode.QuickPickItemKind.Separator });
      for (const o of list) items.push({ label: `$(terminal) ${o.terminal.name}`, description: this.describe(o), detail: o.message ?? o.path, o });
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: t('{0} open agent terminal(s)', all.length), matchOnDetail: true });
    pick?.o?.terminal.show();
  }

  dispose() {
    this.stopWatcher();
    this.disposables.forEach(d => d.dispose());
  }
}

/** Id novo de terminal de agente (nome dos arquivos dos hooks). */
export function newAgentId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Terminais agrupados por worktree, na ordem em que cada worktree apareceu. */
export function groupByWorktree(list: OpenAgent[]): OpenAgent[][] {
  const groups = new Map<string, OpenAgent[]>();
  for (const o of list) groups.set(keyOf(o.path), [...(groups.get(keyOf(o.path)) ?? []), o]);
  return [...groups.values()];
}

/** Troca ${nome} pelos valores; placeholders desconhecidos ficam como estão. */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}
