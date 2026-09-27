import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Controller } from './controller';

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

/**
 * Terminais de agente abertos pela extensão, por worktree. Um terminal por (worktree, agente):
 * chamar de novo só traz o terminal para frente. Tarefas (launchWithPrompt) sempre abrem um novo.
 */
export class AgentTerminals implements vscode.Disposable {
  private readonly open = new Map<string, vscode.Terminal>();
  private readonly disposables: vscode.Disposable[] = [];
  /** Arquivo do último prompt enviado (usado pelos testes). */
  lastPromptFile?: string;

  constructor(private readonly ctl: Controller) {
    this.disposables.push(
      vscode.window.onDidCloseTerminal(t => {
        for (const [k, v] of this.open) if (v === t) this.open.delete(k);
        this.ctl.scheduleRefresh(50);
      }),
    );
  }

  /** Nomes dos agentes com terminal aberto em cada worktree (chave: caminho em minúsculas). */
  running(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const k of this.open.keys()) {
      const [p, name] = k.split('|');
      const list = out.get(p) ?? [];
      if (!list.includes(name)) list.push(name);
      out.set(p, list);
    }
    return out;
  }

  private async pickAgent(worktreePath: string, branch: string | undefined, agentName?: string): Promise<AgentConfig | undefined> {
    const list = agents(this.ctl);
    let agent = agentName ? list.find(a => a.name === agentName) : undefined;
    if (!agent && !agentName && list.length === 1) agent = list[0];
    if (!agent) {
      const pick = await vscode.window.showQuickPick(
        list.map(a => ({ label: a.name, description: a.command, agent: a })),
        { placeHolder: `Abrir qual agente em ${branch ?? path.basename(worktreePath)}?` },
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

  async launch(worktreePath: string, branch: string | undefined, agentName?: string) {
    const agent = await this.pickAgent(worktreePath, branch, agentName);
    if (!agent) return;

    const key = `${path.normalize(worktreePath).toLowerCase()}|${agent.name}`;
    const existing = this.open.get(key);
    if (existing && existing.exitStatus === undefined) {
      existing.show();
      return;
    }

    let command = agent.command;
    if (command.includes('{prompt}')) {
      const prompt = await vscode.window.showInputBox({
        title: `${agent.name} em ${branch ?? path.basename(worktreePath)}`,
        prompt: 'Tarefa inicial para o agente (vazio = abrir sem tarefa)',
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

    const terminal = await this.createTerminal(worktreePath, branch, `${agent.name} · ${branch ?? path.basename(worktreePath)}`);
    this.open.set(key, terminal);
    terminal.show();
    terminal.sendText(command);
    this.ctl.log(`Agente ${agent.name} aberto em ${worktreePath}: ${command}`);
    this.ctl.scheduleRefresh(50);
  }

  /** Abre um terminal novo com o agente já recebendo `prompt` como tarefa. */
  async launchWithPrompt(worktreePath: string, branch: string | undefined, prompt: string, agentName?: string): Promise<void> {
    const agent = await this.pickAgent(worktreePath, branch, agentName ?? agents(this.ctl)[0]?.name);
    if (!agent) return;
    const p = promptArgument(prompt);
    this.lastPromptFile = p.file;
    const command = promptCommandOf(agent).replace(/\{prompt\}/g, () => p.arg).trim();
    const terminal = await this.createTerminal(worktreePath, branch, `${agent.name} · ${branch ?? path.basename(worktreePath)} · tarefa`);
    this.open.set(`${path.normalize(worktreePath).toLowerCase()}|${agent.name}|${Date.now()}`, terminal);
    terminal.show();
    terminal.sendText(command);
    this.ctl.log(`Agente ${agent.name} com tarefa em ${worktreePath} (prompt em ${p.file})`);
    this.ctl.scheduleRefresh(50);
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
  }
}

/** Troca ${nome} pelos valores; placeholders desconhecidos ficam como estão. */
export function fillTemplate(t: string, vars: Record<string, string>): string {
  return t.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}
