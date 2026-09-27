import * as vscode from 'vscode';
import * as actions from './actions';
import { AgentTerminals } from './agents';
import { generateCiWorkflow } from './ciTemplate';
import { Controller } from './controller';
import { GitShowProvider, SCHEME } from './diff';
import { GraphPanel } from './graphPanel';
import { AutoSync } from './sync';
import { WorktreeTreeProvider } from './treeView';

export async function activate(ctx: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel('Worktree Graph');
  const ctl = new Controller(ctx, out);
  ctx.subscriptions.push(out, ctl);

  const agentTerms = new AgentTerminals(ctl);
  ctl.agentsRunning = () => agentTerms.running();
  ctx.subscriptions.push(agentTerms);

  /** Worktree por caminho (webview/árvore) ou por branch; sem nada, pergunta. */
  const launchAgent = async (arg: { path?: string; branch?: string } | undefined, agent?: string) => {
    let wtPath = arg?.path;
    let branch = arg?.branch;
    const wts = ctl.repo ? await ctl.repo.worktrees() : [];
    if (!wtPath && branch) wtPath = wts.find(w => w.branch === branch)?.path;
    if (wtPath && !branch) branch = wts.find(w => w.path.toLowerCase() === wtPath!.toLowerCase())?.branch;
    if (!wtPath) {
      const picked = await actions.pickBranch(ctl, undefined, 'Abrir agente em qual worktree?', true);
      if (!picked) return;
      branch = picked;
      wtPath = wts.find(w => w.branch === picked)?.path;
    }
    if (wtPath) await agentTerms.launch(wtPath, branch, agent);
  };

  const sync = new AutoSync(ctl);
  const tree = new WorktreeTreeProvider(ctl);
  const treeView = vscode.window.createTreeView('worktreeGraph.worktrees', { treeDataProvider: tree, showCollapseAll: true, canSelectMany: true });
  ctl.onDidChange(s => {
    const n = s?.pending ?? 0;
    treeView.message = n > 0 ? `Detalhando ${n} de ${s!.worktrees.filter(w => !w.prunable && !w.bare).length} worktrees…` : undefined;
    treeView.badge = n > 0 ? { value: n, tooltip: `${n} worktrees sendo detalhadas` } : undefined;
  });
  ctx.subscriptions.push(sync);
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('worktreeGraph.autoSync') && sync.reschedule()),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new GitShowProvider()),
    treeView,
  );

  /** Ações vindas do webview: mesmos nomes dos comandos, argumentos simples. */
  const handler = async (action: string, a: Record<string, string>) => {
    switch (action) {
      case 'refresh':
        return ctl.refresh();
      case 'createWorktree':
        return actions.createWorktree(ctl, { startPoint: a.startPoint, existing: a.existing });
      case 'openWorktree':
        return actions.openWorktree(ctl, a.path ? { path: a.path } : a.branch);
      case 'launchAgent':
        return launchAgent({ path: a.path, branch: a.branch }, a.agent);
      case 'openFile':
        return actions.openFileInWorktree(ctl, a.path ? { path: a.path } : a.branch);
      case 'openTerminal':
        return actions.openTerminal(ctl, a.path ? { path: a.path } : a.branch);
      case 'mergeBaseInto':
        return actions.mergeBaseInto(ctl, a.branch);
      case 'mergeIntoBase':
        return actions.mergeIntoBase(ctl, a.branch);
      case 'mergeInto':
        return actions.mergeInto(ctl, a.branch);
      case 'mergeBranches':
        await actions.mergeBranches(ctl, a.source, a.target);
        return;
      case 'diffWithBase':
        return actions.diffWithBase(ctl, a.branch);
      case 'removeWorktree':
        return actions.removeWorktree(ctl, a.branch);
      case 'deleteBranch':
        return actions.deleteBranch(ctl, a.branch);
      case 'togglePause':
        await ctl.setPaused(a.branch, !ctl.paused().includes(a.branch));
        ctl.statuses.delete(a.branch);
        return ctl.refresh();
      case 'toggleAutoSync':
        return sync.toggle();
      case 'chooseSyncWhere':
        return sync.chooseWhere();
      case 'cleanupWorktrees':
        return actions.cleanupWorktrees(ctl);
      case 'toggleFavorite':
        return actions.toggleFavorite(ctl, a.path ? { path: a.path } : a.branch);
      case 'pruneWorktrees':
        return actions.pruneWorktrees(ctl);
      case 'syncNow':
        return sync.tick(true);
      case 'generateCi':
        return generateCiWorkflow(ctl);
      case 'copy':
        return actions.copyText(a.text);
      case 'showLog':
        return out.show();
    }
  };

  const guard =
    <T extends unknown[]>(fn: (...args: T) => unknown) =>
    async (...args: T) => {
      try {
        await fn(...args);
      } catch (e) {
        vscode.window.showErrorMessage(`Worktree Graph: ${(e as Error).message}`);
      }
    };

  const reg = (id: string, fn: (...args: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(`worktreeGraph.${id}`, guard(fn)));
  reg('openGraph', () => GraphPanel.show(ctl, handler));
  reg('refresh', () => ctl.refresh());
  reg('createWorktree', () => actions.createWorktree(ctl));
  reg('openWorktree', item => actions.openWorktree(ctl, item));
  reg('openTerminal', item => actions.openTerminal(ctl, item));
  reg('launchAgent', (item, agent?: string) => launchAgent(item, agent));
  reg('openFileInWorktree', item => actions.openFileInWorktree(ctl, item));
  reg('mergeBaseInto', item => actions.mergeBaseInto(ctl, item));
  reg('mergeIntoBase', item => actions.mergeIntoBase(ctl, item));
  reg('mergeInto', item => actions.mergeInto(ctl, item));
  reg('diffWithBase', item => actions.diffWithBase(ctl, item));
  // Com seleção múltipla na árvore, o segundo argumento traz todos os itens selecionados.
  reg('removeWorktree', (item, items?: { path?: string; kind?: string }[]) =>
    items && items.length > 1
      ? actions.cleanupWorktrees(ctl, items.filter(i => i.kind === 'worktree').map(i => i.path!))
      : actions.removeWorktree(ctl, item),
  );
  reg('cleanupWorktrees', () => actions.cleanupWorktrees(ctl));
  reg('toggleFavorite', item => actions.toggleFavorite(ctl, item));
  reg('deleteBranch', item => actions.deleteBranch(ctl, item));
  reg('togglePauseSync', item => item?.branch && handler('togglePause', { branch: item.branch }));
  reg('toggleAutoSync', () => sync.toggle());
  reg('syncNow', () => sync.tick(true));
  reg('chooseSyncWhere', () => sync.chooseWhere());
  reg('pruneWorktrees', () => actions.pruneWorktrees(ctl));
  reg('generateCiWorkflow', () => generateCiWorkflow(ctl));
  reg('showLog', () => out.show());

  // Registra tudo antes de ler o repositório: a leitura pode levar segundos em repositórios grandes.
  const ready = ctl.init().then(() => sync.reschedule());

  // Usado pelos testes de integração (test/).
  return { ctl, tree, treeView, agentTerms, actions, sync, GraphPanel, ready };
}

export function deactivate() {}
