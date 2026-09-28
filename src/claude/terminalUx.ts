import * as path from 'path';
import * as vscode from 'vscode';
import { AgentTerminals, OpenAgent } from '../agents';
import { openAgentOf } from '../agentsView';
import type { Controller } from '../controller';
import { t } from '../i18n';
import { worktreeOfFile } from './sendContext';

/** Extensão oficial do Claude Code: é com ela que o `claude` do terminal se conecta ao VS Code (`/ide`). */
export const CLAUDE_EXTENSION = 'anthropic.claude-code';

const RANK: Record<string, number> = { waiting: 0, working: 1, idle: 2, starting: 3 };

/** O agente que mais interessa numa worktree: esperando você, trabalhando, sua vez; empate fica com o mais recente. */
export function pickRelevant(list: OpenAgent[]): OpenAgent | undefined {
  return list
    .filter(o => o.state !== 'ended')
    .slice()
    .sort((a, b) => (RANK[a.state ?? ''] ?? 4) - (RANK[b.state ?? ''] ?? 4) || b.started - a.started)[0];
}

/** A pasta está dentro de alguma pasta do workspace? (é o que o Claude confere para conectar ao VS Code) */
export function insideFolders(dir: string, folders: string[]): boolean {
  const k = (p: string) => path.normalize(p).toLowerCase().replace(/[\\/]+$/, '') + path.sep;
  return folders.some(f => k(dir).startsWith(k(f)));
}

/**
 * Terminais do Claude no dia a dia: mover entre painel e editor, grade lado a lado, interromper,
 * seguir a worktree do arquivo aberto, o que fazer quando a sessão termina e a conexão com o VS Code
 * (`/ide`) para worktrees fora do workspace.
 */
export function registerTerminalUx(ctx: vscode.ExtensionContext, ctl: Controller, agentTerms: AgentTerminals) {
  const where = (o: OpenAgent) => o.branch ?? path.basename(o.path);

  /** O agente do nó da view, o do terminal ativo, ou um escolhido na lista. */
  const agentOf = async (node: unknown, filter: (o: OpenAgent) => boolean = () => true): Promise<OpenAgent | undefined> => {
    const fromNode = openAgentOf(node);
    if (fromNode) return fromNode;
    const active = vscode.window.activeTerminal && agentTerms.byTerminal(vscode.window.activeTerminal);
    if (active && filter(active)) return active;
    const list = agentTerms.list().filter(filter);
    if (list.length <= 1) {
      if (!list.length) vscode.window.showInformationMessage(t('No agents open.'));
      return list[0];
    }
    const pick = await vscode.window.showQuickPick(
      list.map(o => ({ label: `$(terminal) ${o.terminal.name}`, description: agentTerms.describe(o), o })),
      { placeHolder: t('Which agent terminal?') },
    );
    return pick?.o;
  };

  // ---------- seguir a worktree do editor ----------
  let follow: NodeJS.Timeout | undefined;
  const followEditor = (editor: vscode.TextEditor | undefined) => {
    if (follow) clearTimeout(follow);
    if (!ctl.cfg().get<boolean>('agentFollowEditor', false) || editor?.document.uri.scheme !== 'file') return;
    const file = editor.document.uri.fsPath;
    follow = setTimeout(() => {
      const wt = worktreeOfFile(ctl, file);
      const list = wt ? agentTerms.list(wt.path) : [];
      const active = vscode.window.activeTerminal;
      if (!list.length || list.some(o => o.terminal === active)) return;
      const o = pickRelevant(list);
      // um terminal no editor tomaria o lugar do arquivo; só os do painel vêm para frente
      if (o && !agentTerms.inEditor(o.terminal)) o.terminal.show(true);
    }, 250);
  };

  // ---------- fim da sessão ----------
  const sessionEnded = async (o: OpenAgent) => {
    const mode = ctl.cfg().get<string>('claude.onSessionEnd', 'ask');
    if (mode === 'close') return o.terminal.dispose();
    // quem saiu com /exit está olhando para o terminal: não precisa perguntar
    if (mode !== 'ask' || (vscode.window.state.focused && vscode.window.activeTerminal === o.terminal)) return;
    const resume = t('Resume here');
    const close = t('Close terminal');
    const pick = await vscode.window.showInformationMessage(
      t('The {0} session in {1} ended.', o.agent, where(o)),
      ...(o.sessionId ? [resume, close] : [close]),
    );
    if (pick === resume) agentTerms.resumeInPlace(o);
    else if (pick === close) o.terminal.dispose();
  };

  // ---------- conexão com o VS Code (/ide) ----------
  const askedIde = new Set<string>();
  const offerIde = async (o: OpenAgent) => {
    if (!o.claude || ctl.cfg().get<string>('claude.ideWorkspace', 'ask') !== 'ask' || !vscode.extensions.getExtension(CLAUDE_EXTENSION)) return;
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const key = path.normalize(o.path).toLowerCase();
    if (insideFolders(o.path, folders) || askedIde.has(key)) return;
    askedIde.add(key);
    const add = t('Add to workspace');
    const never = t('Do not ask again');
    const pick = await vscode.window.showInformationMessage(
      t('Claude in {0} cannot connect to VS Code (diffs in the editor, selection, problems): the worktree is outside the workspace. Add it as a workspace folder? Then run /ide in Claude.', where(o)),
      add,
      never,
    );
    if (pick === add) vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri: vscode.Uri.file(o.path), name: where(o) });
    else if (pick === never) await ctl.cfg().update('claude.ideWorkspace', 'off', vscode.ConfigurationTarget.Global);
  };

  const reg = (id: string, fn: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(`worktreeGraph.${id}`, fn));

  reg('agents.moveToEditor', async node => {
    const o = await agentOf(node);
    if (o) await agentTerms.moveTo(o, 'editor');
  });
  reg('agents.moveToPanel', async node => {
    const o = await agentOf(node);
    if (o) await agentTerms.moveTo(o, 'panel');
  });
  reg('agents.interrupt', async node => {
    const o = await agentOf(node, x => !!x.claude && x.state !== 'ended');
    if (o) agentTerms.interrupt(o);
  });
  // /remote-control (/rc): a sessão passa a poder ser continuada pelo app do Claude ou por claude.ai/code
  reg('agents.remoteControl', async (node?: unknown) => {
    // pelo menu do terminal vem o próprio terminal: um `claude` aberto à mão também serve
    const term = node && typeof node === 'object' && 'sendText' in node ? (node as vscode.Terminal) : undefined;
    const o = term ? agentTerms.byTerminal(term) : await agentOf(node, x => !!x.claude && x.state !== 'ended');
    if (o) await agentTerms.type(o, '/remote-control', true);
    else if (term) {
      term.show();
      term.sendText('/remote-control', true);
    }
  });
  reg('agents.grid', async (group?: { path?: string }) => {
    let list = agentTerms.list(group?.path);
    if (!list.length) {
      vscode.window.showInformationMessage(t('No agents open.'));
      return;
    }
    // mais de 4: você escolhe quais; os que precisam de você já vêm marcados
    if (list.length > 4) {
      const sorted = list.slice().sort((a, b) => (RANK[a.state ?? ''] ?? 4) - (RANK[b.state ?? ''] ?? 4));
      const picks = await vscode.window.showQuickPick(
        sorted.map((o, i) => ({ label: o.terminal.name, description: agentTerms.describe(o), picked: i < 4, o })),
        { canPickMany: true, placeHolder: t('Up to 4 terminals side by side') },
      );
      if (!picks?.length) return;
      list = picks.map(p => p.o);
    }
    await agentTerms.arrangeGrid(list);
  });

  ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(followEditor),
    agentTerms.onDidChangeState(({ open }) => open.state === 'ended' && void sessionEnded(open)),
    agentTerms.onDidLaunch(l => {
      const o = agentTerms.byTerminal(l.terminal);
      if (o) void offerIde(o);
    }),
    { dispose: () => follow && clearTimeout(follow) },
  );
}
