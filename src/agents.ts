import * as path from 'path';
import * as vscode from 'vscode';
import { Controller } from './controller';

export interface AgentConfig {
  name: string;
  /** Linha de comando enviada ao terminal. "{prompt}" pede um texto antes de abrir. */
  command: string;
}

const DEFAULT_AGENTS: AgentConfig[] = [{ name: 'Claude Code', command: 'claude' }];

export function agents(ctl: Controller): AgentConfig[] {
  const list = ctl.cfg().get<AgentConfig[]>('agents', DEFAULT_AGENTS).filter(a => a && a.name && a.command);
  return list.length ? list : DEFAULT_AGENTS;
}

/** Aspas para o shell padrão do terminal: PowerShell no Windows, sh nos demais. */
function quote(s: string): string {
  return process.platform === 'win32' ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Terminais de agente abertos pela extensão, por worktree. Um terminal por (worktree, agente):
 * chamar de novo só traz o terminal para frente.
 */
export class AgentTerminals implements vscode.Disposable {
  private readonly open = new Map<string, vscode.Terminal>();
  private readonly disposables: vscode.Disposable[] = [];

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
      out.set(p, [...(out.get(p) ?? []), name]);
    }
    return out;
  }

  async launch(worktreePath: string, branch: string | undefined, agentName?: string) {
    const list = agents(this.ctl);
    let agent = agentName ? list.find(a => a.name === agentName) : undefined;
    if (!agent && !agentName && list.length === 1) agent = list[0];
    if (!agent) {
      const pick = await vscode.window.showQuickPick(
        list.map(a => ({ label: a.name, description: a.command, agent: a })),
        { placeHolder: `Abrir qual agente em ${branch ?? path.basename(worktreePath)}?` },
      );
      if (!pick) return;
      agent = pick.agent;
    }

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
      command = command.replace(/\{prompt\}/g, prompt.trim() ? quote(prompt.trim()) : '').trim();
    }

    const { base } = await this.ctl.base().catch(() => ({ base: '' }));
    const location =
      this.ctl.cfg().get<string>('agentTerminalLocation', 'panel') === 'editor'
        ? vscode.TerminalLocation.Editor
        : vscode.TerminalLocation.Panel;
    const terminal = vscode.window.createTerminal({
      name: `${agent.name} · ${branch ?? path.basename(worktreePath)}`,
      cwd: worktreePath,
      iconPath: new vscode.ThemeIcon('sparkle'),
      location,
      env: { WTGRAPH_BRANCH: branch ?? '', WTGRAPH_BASE: base, WTGRAPH_WORKTREE: worktreePath },
    });
    this.open.set(key, terminal);
    terminal.show();
    terminal.sendText(command);
    this.ctl.log(`Agente ${agent.name} aberto em ${worktreePath}: ${command}`);
    this.ctl.scheduleRefresh(50);
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
  }
}
