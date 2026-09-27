import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Controller } from './controller';
import { t } from './i18n';

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

const keyOf = (p: string) => path.normalize(p).toLowerCase();

/**
 * Terminais de agente abertos pela extensão, por worktree. Pode haver vários do mesmo agente na
 * mesma worktree; abrir de novo pergunta se traz um deles para frente ou abre outro (`agentWhenOpen`).
 * Tarefas (launchWithPrompt) sempre abrem um novo.
 */
export class AgentTerminals implements vscode.Disposable {
  private readonly open: OpenAgent[] = [];
  private readonly launched = new vscode.EventEmitter<AgentLaunch>();
  readonly onDidLaunch = this.launched.event;
  private readonly changed = new vscode.EventEmitter<void>();
  /** A lista de terminais abertos mudou. */
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.launched, this.changed];
  /** Arquivo do último prompt enviado (usado pelos testes). */
  lastPromptFile?: string;

  constructor(private readonly ctl: Controller) {
    this.disposables.push(
      vscode.window.onDidCloseTerminal(term => {
        const i = this.open.findIndex(o => o.terminal === term);
        if (i >= 0) this.open.splice(i, 1);
        this.changed.fire();
        this.ctl.scheduleRefresh(50);
      }),
    );
  }

  /** Terminais abertos, opcionalmente só os de uma worktree (e de um agente). */
  list(worktreePath?: string, agentName?: string): OpenAgent[] {
    return this.open.filter(
      o => o.terminal.exitStatus === undefined && (!worktreePath || keyOf(o.path) === keyOf(worktreePath)) && (!agentName || o.agent === agentName),
    );
  }

  /** Agentes abertos em cada worktree (chave: caminho em minúsculas), um nome por terminal. */
  running(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const o of this.list()) out.set(keyOf(o.path), [...(out.get(keyOf(o.path)) ?? []), o.agent]);
    return out;
  }

  private track(o: Omit<OpenAgent, 'started'>) {
    this.open.push({ ...o, started: Date.now() });
    this.changed.fire();
  }

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

  private async createTerminal(worktreePath: string, branch: string | undefined, name: string) {
    const { base } = await this.ctl.base().catch(() => ({ base: '' }));
    const location =
      this.ctl.cfg().get<string>('agentTerminalLocation', 'panel') === 'editor' ? vscode.TerminalLocation.Editor : vscode.TerminalLocation.Panel;
    return vscode.window.createTerminal({
      name,
      cwd: worktreePath,
      iconPath: new vscode.ThemeIcon('sparkle'),
      location,
      env: { WTGRAPH_BRANCH: branch ?? '', WTGRAPH_BASE: base, WTGRAPH_WORKTREE: worktreePath },
    });
  }

  /** Nome do terminal; a partir do segundo do mesmo agente (e mesmo tipo) na worktree ganha "#n". */
  private terminalName(agent: string, worktreePath: string, branch: string | undefined, task = false) {
    const n = this.list(worktreePath, agent).filter(o => !!o.task === task).length;
    return `${agent} · ${branch ?? path.basename(worktreePath)}${task ? ` · ${t('task')}` : ''}${n ? ` #${n + 1}` : ''}`;
  }

  private describe(o: OpenAgent) {
    return o.task ? t('opened {0} · with a task', sinceText(o.started)) : t('opened {0}', sinceText(o.started));
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
      const prompt = await vscode.window.showInputBox({
        title: t('{0} in {1}', agent.name, branch ?? path.basename(worktreePath)),
        prompt: t('Initial task for the agent (empty = open without a task)'),
        ignoreFocusOut: true,
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

    const terminal = await this.createTerminal(worktreePath, branch, this.terminalName(agent.name, worktreePath, branch));
    this.track({ terminal, path: worktreePath, branch, agent: agent.name });
    terminal.show();
    terminal.sendText(command);
    this.launched.fire({ path: worktreePath, branch, terminal, agent: agent.name });
    this.ctl.log(t('Agent {0} opened in {1}: {2}', agent.name, worktreePath, command));
    this.ctl.scheduleRefresh(50);
  }

  /** Abre um terminal novo com o agente já recebendo `prompt` como tarefa. */
  async launchWithPrompt(worktreePath: string, branch: string | undefined, prompt: string, agentName?: string): Promise<void> {
    const agent = await this.pickAgent(worktreePath, branch, agentName ?? agents(this.ctl)[0]?.name);
    if (!agent) return;
    const p = promptArgument(prompt);
    this.lastPromptFile = p.file;
    const command = promptCommandOf(agent).replace(/\{prompt\}/g, () => p.arg).trim();
    const terminal = await this.createTerminal(worktreePath, branch, this.terminalName(agent.name, worktreePath, branch, true));
    this.track({ terminal, path: worktreePath, branch, agent: agent.name, task: true });
    terminal.show();
    terminal.sendText(command);
    this.launched.fire({ path: worktreePath, branch, terminal, agent: agent.name, prompt });
    this.ctl.log(t('Agent {0} with a task in {1} (prompt in {2})', agent.name, worktreePath, p.file));
    this.ctl.scheduleRefresh(50);
  }

  /** Lista os terminais de agente abertos, agrupados por worktree, e traz para frente o escolhido. */
  async pickOpen(worktreePath?: string) {
    const all = this.list(worktreePath);
    if (!all.length) {
      vscode.window.showInformationMessage(worktreePath ? t('No agents open in this worktree.') : t('No agents open.'));
      return;
    }
    const items: (vscode.QuickPickItem & { o?: OpenAgent })[] = [];
    for (const list of groupByWorktree(all)) {
      items.push({ label: list[0].branch ?? path.basename(list[0].path), kind: vscode.QuickPickItemKind.Separator });
      for (const o of list) items.push({ label: `$(terminal) ${o.terminal.name}`, description: this.describe(o), detail: o.path, o });
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: t('{0} open agent terminal(s)', all.length), matchOnDetail: true });
    pick?.o?.terminal.show();
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
  }
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
