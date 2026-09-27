import * as vscode from 'vscode';
import * as actions from './actions';
import { AgentTerminals } from './agents';
import { AgentsTreeProvider, AgentGroupItem, terminalOf } from './agentsView';
import { registerPullRequests } from './prs/view';
import * as commits from './commits';
import { pushBranch, pushMany } from './push';
import { resolveConflict, ResolveOptions } from './conflicts';
import { generateCiWorkflow } from './ciTemplate';
import { Controller } from './controller';
import { GitShowProvider, SCHEME } from './diff';
import { GraphPanel } from './graphPanel';
import { registerGuards } from './guards';
import { registerAgentFlow } from './agentFlow/register';
import { registerSchedule } from './schedule/register';
import { registerCoord } from './coord/register';
import { ReadySummaryService } from './env/readySummary';
import { registerEnv } from './env/register';
import { registerMigrations } from './migrations/register';
import { registerTemplates } from './templates/register';
import { registerIssues } from './issues/register';
import { registerPipelines } from './hosting/pipelinesView';
import { registerActivity } from './activityPanel';
import { registerDelivery } from './delivery/register';
import { registerPromotion } from './promotion/register';
import { registerReview } from './review';
import { registerGitOps } from './gitops/register';
import { registerSummary } from './summary/register';
import { WorktreeDecorations } from './decorations';
import { configureFlow, promote } from './flow';
import { MergePanel } from './mergePanel';
import { Projects, ProjectsTreeProvider } from './projects';
import { AutoSync } from './sync';
import { registerClaudeConfig } from './claude/configView';
import { ClaudeService, ClaudeSessionsProvider, SessionItem, TRANSCRIPT_SCHEME, TranscriptProvider } from './claude/view';
import { WorktreeTreeProvider } from './treeView';

export async function activate(ctx: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel('AgentYard');
  const ctl = new Controller(ctx, out);
  ctx.subscriptions.push(out, ctl);

  const agentTerms = new AgentTerminals(ctl);
  ctl.agentsRunning = () => agentTerms.running();
  ctx.subscriptions.push(agentTerms);
  const agentsTree = new AgentsTreeProvider(agentTerms);
  const agentsView = vscode.window.createTreeView('worktreeGraph.agents', { treeDataProvider: agentsTree });
  const agentsBadge = () => {
    const n = agentsTree.count();
    agentsView.badge = n ? { value: n, tooltip: `${n} terminal(is) de agente aberto(s)` } : undefined;
  };
  ctx.subscriptions.push(agentsTree, agentsView, agentTerms.onDidChange(agentsBadge));
  const agentFlow = registerAgentFlow(ctx, ctl, agentTerms);
  const schedules = registerSchedule(ctx, ctl, agentTerms, agentFlow.tasks);
  const coord = registerCoord(ctx, ctl, agentTerms, agentFlow);
  ctl.taskBlocked = p => coord.isBlocked(p);

  /** Worktree por caminho (webview/árvore) ou por branch; sem nada, pergunta. */
  const launchAgent = async (arg: { path?: string; branch?: string } | undefined, agent?: string, mode?: 'reuse' | 'new') => {
    let wtPath = arg?.path;
    let branch = arg?.branch;
    const wts = ctl.repo ? await ctl.repo.worktreesFast() : [];
    if (!wtPath && branch) wtPath = wts.find(w => w.branch === branch)?.path;
    if (wtPath && !branch) branch = wts.find(w => w.path.toLowerCase() === wtPath!.toLowerCase())?.branch;
    if (!wtPath) {
      const picked = await actions.pickBranch(ctl, undefined, 'Abrir agente em qual worktree?', true);
      if (!picked) return;
      branch = picked;
      wtPath = wts.find(w => w.branch === picked)?.path;
    }
    if (wtPath) await agentTerms.launch(wtPath, branch, agent, mode);
  };

  const projects = new Projects(ctl);
  ctx.subscriptions.push(projects, vscode.window.createTreeView('worktreeGraph.projects', { treeDataProvider: new ProjectsTreeProvider(projects) }));
  const decorations = new WorktreeDecorations(ctl);
  const claude = new ClaudeService(ctl);
  const claudeTree = vscode.window.createTreeView('worktreeGraph.claudeSessions', { treeDataProvider: new ClaudeSessionsProvider(claude, ctl), showCollapseAll: true });
  ctx.subscriptions.push(claude, claudeTree, vscode.workspace.registerTextDocumentContentProvider(TRANSCRIPT_SCHEME, new TranscriptProvider(claude)));
  /** Worktree a partir de item da árvore, grupo de sessões, caminho ou nada (pergunta). */
  const claudeTarget = async (arg?: { path?: string; wtPath?: string; branch?: string }): Promise<{ cwd: string; label: string } | undefined> => {
    const p = arg?.wtPath ?? arg?.path;
    const wts = ctl.state?.worktrees.filter(w => !w.prunable && !w.bare) ?? [];
    const found = p ? wts.find(w => w.path.toLowerCase() === p.toLowerCase()) : arg?.branch ? wts.find(w => w.branch === arg.branch) : undefined;
    if (found) return { cwd: found.path, label: found.name };
    if (p) return { cwd: p, label: require('path').basename(p) };
    const pick = await vscode.window.showQuickPick(
      wts.map(w => ({ label: w.name, description: w.claude ? `${w.claude.sessions} sessão(ões)` : '', detail: w.path, w })),
      { placeHolder: 'Em qual worktree?' },
    );
    return pick && { cwd: pick.w.path, label: pick.w.name };
  };

  const sync = new AutoSync(ctl);
  const tree = new WorktreeTreeProvider(ctl);
  const treeView = vscode.window.createTreeView('worktreeGraph.worktrees', { treeDataProvider: tree, showCollapseAll: true, canSelectMany: true });
  ctl.onDidChangeRepo(() => sync.reschedule());
  ctl.onDidChange(s => {
    if (s) treeView.description = s.repoName;
    const n = s?.pending ?? 0;
    treeView.message = n > 0 ? `Detalhando ${n} de ${s!.worktrees.filter(w => !w.prunable && !w.bare).length} worktrees…` : undefined;
    treeView.badge = n > 0 ? { value: n, tooltip: `${n} worktrees sendo detalhadas` } : undefined;
  });
  ctx.subscriptions.push(sync);
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('worktreeGraph.autoSync') && sync.reschedule()),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new GitShowProvider()),
    vscode.window.registerFileDecorationProvider(decorations),
    treeView,
  );

  const analyzeMerge = async (source?: string, target?: string) => {
    const src = source ?? (await actions.pickBranch(ctl, undefined, 'Analisar o merge de qual branch?'));
    if (!src) return;
    const dst = target ?? (await ctl.base()).base;
    await MergePanel.show(
      ctl,
      src,
      dst,
      async (s, t) => void (await actions.mergeBranches(ctl, s, t)),
      b => ctl.requests.publish(b),
    );
  };

  /** Arquivo de uma worktree (item da árvore) → diff contra o ponto em que a branch saiu da base. */
  const compareWithBase = async (item: { resourceUri?: vscode.Uri }) => {
    const file = item?.resourceUri?.fsPath;
    if (!file || !ctl.repo || !ctl.state) return;
    const wt = ctl.state.worktrees
      .filter(w => file.toLowerCase().startsWith(w.path.toLowerCase() + require('path').sep))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!wt) return;
    const rel = require('path').relative(wt.path, file).split(require('path').sep).join('/');
    const mb = (await ctl.repo.exec(['merge-base', ctl.state.baseRef, 'HEAD'], wt.path)).trim();
    const { gitUri } = await import('./diff');
    await vscode.commands.executeCommand('vscode.diff', gitUri(wt.path, mb, rel), vscode.Uri.file(file), `${rel.split('/').pop()} (${ctl.state.baseRef} ↔ ${wt.name})`);
  };

  /**
   * Foca uma view da barra lateral. Se o comando <view>.focus não existir (janela ainda com uma
   * versão anterior da extensão ativa), abre a barra do AgentYard e explica em vez de dar erro.
   */
  const focusView = async (id: string, name: string) => {
    try {
      await vscode.commands.executeCommand(`${id}.focus`);
    } catch {
      await vscode.commands.executeCommand('workbench.view.extension.worktreeGraph').then(undefined, () => undefined);
      const pick = await vscode.window.showWarningMessage(
        `A view "${name}" ainda não está disponível nesta janela. Isso acontece quando uma versão anterior do AgentYard continua ativa depois de atualizar.`,
        'Recarregar janela',
      );
      if (pick) await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  };

  /** Ações vindas do webview: mesmos nomes dos comandos, argumentos simples. */
  const handler = async (action: string, a: Record<string, string>) => {
    if (await agentFlow.handle(action, a)) return;
    switch (action) {
      case 'refresh':
        return ctl.refresh();
      case 'switchProject':
        return projects.switch(a.path);
      case 'createWorktree':
        await actions.createWorktree(ctl, { startPoint: a.startPoint, existing: a.existing });
        return;
      case 'openWorktree':
        return actions.openWorktree(ctl, a.path ? { path: a.path } : a.branch);
      case 'launchAgent':
        return launchAgent({ path: a.path, branch: a.branch }, a.agent, a.modifier === '1' ? 'new' : undefined);
      case 'launchAgentNew':
        return launchAgent({ path: a.path, branch: a.branch }, a.agent, 'new');
      case 'agents.pick':
        return agentTerms.pickOpen(a.path);
      case 'openFile':
        return actions.openFileInWorktree(ctl, a.path ? { path: a.path } : a.branch);
      case 'resolveConflict':
        return resolveConflict(ctl, agentTerms, a.branch);
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
      case 'removeMergedBranches':
        return actions.removeMergedBranches(ctl);
      case 'toggleFavorite':
        return actions.toggleFavorite(ctl, a.path ? { path: a.path } : a.branch);
      case 'pruneWorktrees':
        return actions.pruneWorktrees(ctl);
      case 'syncNow':
        return sync.tick(true);
      case 'generateCi':
        return generateCiWorkflow(ctl);
      case 'configureFlow':
        return configureFlow(ctl);
      case 'promotionMap':
        await vscode.commands.executeCommand('worktreeGraph.promotionMap');
        return;
      case 'promote':
        await promote(ctl, a.from, a.to, (s, t) => actions.mergeBranches(ctl, s, t), (s, t) => analyzeMerge(s, t));
        return;
      case 'push':
        await pushBranch(ctl, a.branch);
        return;
      case 'pushMany':
        return pushMany(ctl);
      case 'showCommit':
        return commits.showCommit(ctl, a.sha);
      case 'copyMessage':
        return commits.copyMessage(ctl, a.sha);
      case 'branchAt':
        return commits.branchAt(ctl, a.sha);
      case 'tagAt':
        return commits.tagAt(ctl, a.sha);
      case 'revertCommit':
        return commits.revertCommit(ctl, a.sha);
      case 'resetTo':
        return commits.resetTo(ctl, a.sha);
      case 'openCommitOnWeb':
        return commits.openCommitOnWeb(ctl, a.sha);
      case 'explainCommit':
        return commits.explainCommit(ctl, a.sha);
      case 'showPr':
        // chip de PR no painel: clique = view de PRs; ctrl/alt/cmd + clique = navegador
        if (a.modifier) return void (await vscode.env.openExternal(vscode.Uri.parse(a.url)));
        return void (await vscode.commands.executeCommand('worktreeGraph.pullRequests.reveal', a.ref));
      case 'focusPrs':
        return focusView('worktreeGraph.pullRequests', 'Pull requests');
      case 'setGraphOptions':
        // seletor "Branches:" e "Mostrar branches remotas" do histórico
        if (a.branches !== undefined) await ctx.workspaceState.update('graphBranches', a.branches ? a.branches.split('\n').filter(Boolean) : []);
        if (a.showRemotes !== undefined) await ctx.workspaceState.update('graphShowRemotes', a.showRemotes === 'true');
        return ctl.refresh();
      case 'openCiBranchesSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'worktreeGraph.ciBranches');
        return;
      case 'openCommitFile':
        return commits.openCommitFile(ctl, a.sha, a.parent, a.path, a.status);
      case 'setGraphFilter':
        {
          const f = a.value === 'unmerged' || a.value === 'ci' ? a.value : 'all';
          await ctx.workspaceState.update('graphFilter', f);
          await ctx.globalState.update('graphFilter', f);
        }
        return ctl.refresh();
      case 'publishRequest':
        return ctl.requests.publish(a.branch);
      case 'fixPipeline':
        await vscode.commands.executeCommand('worktreeGraph.pipelines.fix', a.id);
        return;
      case 'openUrl':
        await vscode.env.openExternal(vscode.Uri.parse(a.url));
        return;
      case 'connectHosting':
        return ctl.requests.connect();
      case 'analyzeMerge':
        return analyzeMerge(a.source ?? a.branch, a.target);
      case 'claudeResumeLast': {
        const s = claude.sessions.find(x => x.id === a.id);
        if (s) claude.resume(s);
        return;
      }
      case 'reviewWithAgent':
        await vscode.commands.executeCommand('worktreeGraph.reviewWithAgent', a.branch);
        return;
      case 'activity':
        await vscode.commands.executeCommand('worktreeGraph.activity');
        return;
      case 'claudeCommands': {
        const t = await claudeTarget({ path: a.path });
        if (t) await claude.commands(t.cwd, t.label);
        return;
      }
      case 'copy':
        return actions.copyText(a.text);
      case 'showLog':
        return out.show();
      default:
        // ações de módulos registrados à parte (ex.: src/gitops): mesmo nome do comando
        return vscode.commands.executeCommand(`worktreeGraph.${action}`, a) as Promise<void>;
    }
  };

  const guard =
    <T extends unknown[]>(fn: (...args: T) => unknown) =>
    async (...args: T) => {
      try {
        await fn(...args);
      } catch (e) {
        vscode.window.showErrorMessage(`AgentYard: ${(e as Error).message}`);
      }
    };

  const reg = (id: string, fn: (...args: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(`worktreeGraph.${id}`, guard(fn)));
  reg('openGraph', () => GraphPanel.show(ctl, handler));
  reg('refresh', () => ctl.refresh());
  reg('addProject', () => projects.add());
  reg('removeProject', item => projects.remove(typeof item === 'string' ? item : item?.path));
  reg('switchProject', (p?: string | { path?: string }) => projects.switch(typeof p === 'string' ? p : p?.path));
  reg('openProjectGraph', async (p?: string | { path?: string }) => {
    const target = typeof p === 'string' ? p : p?.path;
    if (target) await projects.switch(target);
    await vscode.commands.executeCommand('worktreeGraph.openGraph');
  });
  reg('openProjectWindow', (p?: { path?: string }) => p?.path && vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p.path), { forceNewWindow: true }));
  reg('createWorktree', () => actions.createWorktree(ctl));
  reg('openWorktree', item => actions.openWorktree(ctl, item));
  reg('openTerminal', item => actions.openTerminal(ctl, item));
  reg('launchAgent', (item, agent?: string) => launchAgent(item, agent));
  reg('launchAgentNew', (item?: AgentGroupItem | { path?: string; branch?: string }, agent?: string) => launchAgent(item, agent, 'new'));
  reg('agents.pick', (item?: { path?: string }) => agentTerms.pickOpen(item?.path));
  reg('agents.show', node => terminalOf(node)?.show());
  reg('agents.close', node => terminalOf(node)?.dispose());
  reg('resolveConflict', (branch?: string | { branch?: string }, opts?: ResolveOptions) => {
    const b = typeof branch === 'string' ? branch : branch?.branch;
    return b && resolveConflict(ctl, agentTerms, b, opts ?? {});
  });
  reg('launchAgentWithPrompt', async (a: { path?: string; branch?: string; prompt: string; agent?: string }) => {
    if (!a?.prompt) return;
    let p = a.path;
    let branch = a.branch;
    const wts = ctl.repo ? await ctl.repo.worktreesFast() : [];
    if (!p && branch) p = wts.find(w => w.branch === branch && !w.prunable)?.path;
    if (p && !branch) branch = wts.find(w => w.path.toLowerCase() === p!.toLowerCase())?.branch;
    if (!p) {
      vscode.window.showWarningMessage(`Nenhuma worktree para ${branch ?? 'a tarefa'}.`);
      return;
    }
    await agentTerms.launchWithPrompt(p, branch, a.prompt, a.agent);
  });
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
  reg('removeMerged', () => actions.removeMerged(ctl));
  reg('removeMergedBranches', () => actions.removeMergedBranches(ctl));
  reg('toggleFavorite', item => actions.toggleFavorite(ctl, item));
  reg('deleteBranch', item => actions.deleteBranch(ctl, item));
  reg('togglePauseSync', item => item?.branch && handler('togglePause', { branch: item.branch }));
  reg('toggleAutoSync', () => sync.toggle());
  reg('syncNow', () => sync.tick(true));
  reg('chooseSyncWhere', () => sync.chooseWhere());
  reg('pruneWorktrees', () => actions.pruneWorktrees(ctl));
  reg('generateCiWorkflow', () => generateCiWorkflow(ctl));
  reg('showLog', () => out.show());
  reg('claude.refreshSessions', () => claude.scan());
  reg('claude.resume', (item?: SessionItem) => item?.session && claude.resume(item.session));
  reg('claude.transcript', (item?: SessionItem) => item?.session && claude.transcript(item.session));
  reg('claude.copySessionId', (item?: SessionItem) => item?.session && actions.copyText(item.session.id));
  reg('claude.newSession', async item => {
    const t = await claudeTarget(item);
    if (t) claude.newSession(t.cwd, t.label);
  });
  reg('claude.commands', async item => {
    const t = await claudeTarget(item);
    if (t) await claude.commands(t.cwd, t.label);
  });
  reg('claude.usage', () => claude.usagePanel());
  reg('publishRequest', async item => {
    const b = await actions.pickBranch(ctl, item, 'Publicar PR/MR de qual branch?');
    if (b) await ctl.requests.publish(b);
  });
  reg('connectHosting', () => ctl.requests.connect());
  reg('connectGitLab', () => ctl.requests.connectGitLab());
  reg('pushBranch', async item => {
    const b = await actions.pickBranch(ctl, item, 'Enviar qual branch?');
    if (b) await pushBranch(ctl, b);
  });
  reg('pushMany', () => pushMany(ctl));
  reg('configureFlow', () => configureFlow(ctl));
  reg('disconnectHosting', () => ctl.requests.disconnect());
  reg('analyzeMerge', (source?: string | { branch?: string }, target?: string) =>
    analyzeMerge(typeof source === 'string' ? source : source?.branch, typeof target === 'string' ? target : undefined),
  );
  reg('openToSide', item => item?.resourceUri && vscode.commands.executeCommand('vscode.open', item.resourceUri, { viewColumn: vscode.ViewColumn.Beside }));
  reg('revealInOS', item => item?.resourceUri && vscode.commands.executeCommand('revealFileInOS', item.resourceUri));
  reg('copyPath', item => item?.resourceUri && actions.copyText(item.resourceUri.fsPath));
  reg('compareWithBase', item => compareWithBase(item));
  reg('addToExplorer', item => {
    const p = item?.path;
    if (!p) return;
    const n = vscode.workspace.workspaceFolders?.length ?? 0;
    vscode.workspace.updateWorkspaceFolders(n, 0, { uri: vscode.Uri.file(p), name: `wt: ${item.branch ?? require('path').basename(p)}` });
  });

  const issues = registerIssues(ctx, ctl, guard);
  const pipelines = registerPipelines(ctx, ctl, guard);
  const review = registerReview(ctx, ctl, guard);
  const prs = registerPullRequests(ctx, ctl, guard);
  const activity = registerActivity(ctx, ctl, guard, {
    claude,
    pipelines: () => pipelines.pipelines,
    issueOf: b => issues.linkOf(b),
  });
  const gitOps = registerGitOps(ctx, ctl, guard);
  registerSummary(ctx, ctl, guard);
  const env = registerEnv(ctx, ctl, guard);
  actions.worktreeCreatedHooks.push((dir, branch, quiet) => env.afterCreate(dir, branch, quiet));
  const templates = registerTemplates(ctx, ctl, guard, b => issues.linkOf(b)?.key);
  const readySummary = new ReadySummaryService(ctl, agentFlow);
  ctx.subscriptions.push(readySummary);
  const delivery = registerDelivery(ctx, ctl, guard, { activity, pipelines: () => pipelines.pipelines, issueOf: b => issues.linkOf(b) });
  const promotion = registerPromotion(ctx, ctl, guard, {
    promote: (from, to) => promote(ctl, from, to, (s, t) => actions.mergeBranches(ctl, s, t), (s, t) => analyzeMerge(s, t)),
    merge: (s, t) => actions.mergeBranches(ctl, s, t),
    showCommit: sha => commits.showCommit(ctl, sha),
  });

  // Registra tudo antes de ler o repositório: a leitura pode levar segundos em repositórios grandes.
  const ready = ctl.init().then(() => {
    projects.scanWorkspace();
    issues.refresh(true);
  });

  // Usado pelos testes de integração (test/).
  const claudeConfig = registerClaudeConfig(ctx, ctl);

  const guards = registerGuards(ctx, ctl);
  registerMigrations(ctx, ctl);

  return { ctl, tree, treeView, agentTerms, actions, sync, GraphPanel, ready, decorations, projects, issues, claude, claudeConfig, pipelines, guards, review, activity, agentFlow, gitOps, schedules, coord, env, templates, readySummary, delivery, prs, promotion };
}

export function deactivate() {}
