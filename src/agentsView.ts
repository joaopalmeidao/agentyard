import * as path from 'path';
import * as vscode from 'vscode';
import { AgentTerminals, OpenAgent, groupByWorktree, sinceText, stateText } from './agents';
import type { Turn, TurnLog } from './claude/integration';
import { t } from './i18n';

/** Grupo da view: uma worktree com agentes abertos. */
export interface AgentGroupItem {
  kind: 'group';
  path: string;
  branch?: string;
  terminals: OpenAgent[];
}

/** Um turno do Claude de um terminal (checkpoints, src/claude/integration.ts). */
export interface TurnItem {
  kind: 'turn';
  log: TurnLog;
  turn: Turn;
}

type Node = AgentGroupItem | { kind: 'terminal'; open: OpenAgent } | TurnItem;

/** De onde vêm os turnos de cada terminal (preenchido na ativação). */
export interface TurnSource {
  turnsOf(o: OpenAgent): TurnLog | undefined;
  turnLabel(turn: Turn): { label: string; description: string; detail?: string };
  readonly onDidChangeTurns: vscode.Event<void>;
}

/** View "Agentes abertos": terminais de agente agrupados por worktree; clicar traz o terminal para frente. */
export class AgentsTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.changed];
  private turns?: TurnSource;

  constructor(private readonly terms: AgentTerminals) {
    this.disposables.push(
      terms.onDidChange(() => this.changed.fire()),
      // o nome muda quando o próprio agente renomeia o terminal (o Claude Code põe o assunto da conversa)
      vscode.window.onDidChangeTerminalState(() => this.changed.fire()),
      vscode.window.onDidChangeActiveTerminal(() => this.changed.fire()),
    );
  }

  setTurns(src: TurnSource) {
    this.turns = src;
    this.disposables.push(src.onDidChangeTurns(() => this.changed.fire()));
    this.changed.fire();
  }

  count() {
    return this.terms.list().length;
  }

  getChildren(node?: Node): Node[] {
    if (!node)
      return groupByWorktree(this.terms.list()).map(list => ({ kind: 'group', path: list[0].path, branch: list[0].branch, terminals: list }));
    if (node.kind === 'group') return node.terminals.map(open => ({ kind: 'terminal', open }));
    if (node.kind === 'terminal') {
      const log = this.turns?.turnsOf(node.open);
      return log ? [...log.turns].reverse().map(turn => ({ kind: 'turn', log, turn })) : [];
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.branch ?? path.basename(node.path), vscode.TreeItemCollapsibleState.Expanded);
      const waiting = node.terminals.filter(o => o.state === 'waiting').length;
      item.description = t('{0} terminal(s)', node.terminals.length) + (waiting ? ` · ${t('{0} waiting for you', waiting)}` : '');
      item.tooltip = node.path;
      item.iconPath = new vscode.ThemeIcon('git-branch');
      item.contextValue = 'agentGroup';
      return item;
    }
    if (node.kind === 'turn') {
      const l = this.turns!.turnLabel(node.turn);
      const item = new vscode.TreeItem(l.label, vscode.TreeItemCollapsibleState.None);
      item.description = l.description;
      item.tooltip = [l.detail, t('Click to see what changed in this turn.')].filter(Boolean).join('\n\n');
      item.iconPath = new vscode.ThemeIcon(node.turn.end ? 'history' : 'loading~spin');
      item.contextValue = node.turn.end ? 'agentTurn' : 'agentTurnRunning';
      item.command = { command: 'worktreeGraph.turns.show', title: t('See changes'), arguments: [node] };
      return item;
    }
    const o = node.open;
    const active = vscode.window.activeTerminal === o.terminal;
    const hasTurns = !!this.turns?.turnsOf(o)?.turns.length;
    const item = new vscode.TreeItem(o.terminal.name, hasTurns ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    const state = stateText(o.state);
    item.description = `${active ? '● ' : ''}${o.asking ? `${t('asking in VS Code')} · ` : ''}${state ? `${state} · ` : ''}${sinceText(o.started)}${o.task ? ` · ${t('task')}` : ''}`;
    const base = o.task
      ? t('{0} in {1}\nOpened {2}, with a task.\nClick to bring the terminal to the front.', o.agent, o.path, sinceText(o.started))
      : t('{0} in {1}\nOpened {2}.\nClick to bring the terminal to the front.', o.agent, o.path, sinceText(o.started));
    item.tooltip = [base, o.message && `⚠ ${o.message}`, o.sessionId && t('Session {0}', o.sessionId)].filter(Boolean).join('\n');
    item.iconPath = stateIcon(o);
    item.contextValue = (o.sessionId ? 'agentTerminalSession' : 'agentTerminal') + (o.claude ? '.claude' : '');
    item.command = { command: 'worktreeGraph.agents.show', title: t('Show terminal'), arguments: [node] };
    return item;
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
  }
}

/** Ícone pelo estado do Claude (hooks); sem estado, o do agente. */
function stateIcon(o: OpenAgent): vscode.ThemeIcon {
  switch (o.state) {
    case 'waiting':
      return new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('list.warningForeground'));
    case 'working':
      return new vscode.ThemeIcon('loading~spin');
    case 'idle':
      return new vscode.ThemeIcon('check', new vscode.ThemeColor('terminal.ansiGreen'));
    case 'ended':
      return new vscode.ThemeIcon('circle-slash');
  }
  return new vscode.ThemeIcon('sparkle');
}

/** Agente de um nó da view (ou undefined). */
export function openAgentOf(node: unknown): OpenAgent | undefined {
  const n = node as Node | undefined;
  return n && n.kind === 'terminal' ? n.open : undefined;
}

/** Terminal de um nó da view (ou undefined). */
export function terminalOf(node: unknown): vscode.Terminal | undefined {
  const n = node as Node | undefined;
  return n && n.kind === 'terminal' ? n.open.terminal : undefined;
}

/** Turno de um nó da view (ou undefined). */
export function turnOf(node: unknown): TurnItem | undefined {
  const n = node as Node | undefined;
  return n && n.kind === 'turn' ? n : undefined;
}
