import * as vscode from 'vscode';
import * as actions from './actions';
import { agents, AgentTerminals, stateText } from './agents';
import { AgentsTreeProvider, AgentGroupItem, openAgentOf, terminalOf } from './agentsView';
import { registerPullRequests } from './prs/view';
import { registerPrFeedback } from './prs/feedback';
import { registerStack } from './stack/register';
import { registerGitExtras } from './gitExtras';
import * as commits from './commits';
import { pushBranch, pushMany, pushSelected, PullStatus, PushStatus } from './push';
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
import { registerLongProjects } from './longProject/register';
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
import { registerAgentAttention } from './claude/attention';
import { registerClaudeVoice } from './claude/voice';
import { registerSendToClaude, worktreeOfFile } from './claude/sendContext';
import { registerClaudeIntegration } from './claude/register';
import { registerRemoteAccess } from './remote/register';
import { registerAutopilot } from './autopilot/register';
import { pickRelevant, registerTerminalUx } from './claude/terminalUx';
import { ClaudeService, ClaudeSessionsProvider, SessionItem, TRANSCRIPT_SCHEME, TranscriptProvider } from './claude/view';
import { ClaudeUsage } from './claude/usage';
import { UsagePanel } from './claude/usagePanel';
import { WorktreeTreeProvider } from './treeView';
import { t } from './i18n';

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
    agentsView.badge = n ? { value: n, tooltip: t('{0} open agent terminal(s)', n) } : undefined;
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
      const picked = await actions.pickBranch(ctl, undefined, t('Open an agent in which worktree?'), true);
      if (!picked) return;
      branch = picked;
      wtPath = wts.find(w => w.branch === picked)?.path;
    }
    if (wtPath) await agentTerms.launch(wtPath, branch, agent, mode);
  };

  const projects = new Projects(ctl);
  ctx.subscriptions.push(projects, vscode.window.createTreeView('worktreeGraph.projects', { treeDataProvider: new ProjectsTreeProvider(projects) }));
  const decorations = new WorktreeDecorations(ctl);
  const claude = new ClaudeService(ctl, agentTerms);
  const usage = new ClaudeUsage(ctl, agentTerms);
  const usagePanel = new UsagePanel(ctx, ctl, agentTerms, usage, claude);
  claude.liveLimits = () => usage.limits();
  ctx.subscriptions.push(usage, usagePanel, usage.onDidChange(() => claude.updateStatus()));
  // com os limites reais da statusline, eles decidem; sem eles, a estimativa pelos logs
  ctl.taskDeferred = () => {
    const real = usage.pause();
    return real === 'unknown' ? claude.usagePause() : real;
  };
  const claudeTree = vscode.window.createTreeView('worktreeGraph.claudeSessions', { treeDataProvider: new ClaudeSessionsProvider(claude, ctl), showCollapseAll: true });
  ctx.subscriptions.push(claude, claudeTree, vscode.workspace.registerTextDocumentContentProvider(TRANSCRIPT_SCHEME, new TranscriptProvider(claude)));
  registerAgentAttention(ctx, ctl, agentTerms);
  registerLongProjects(ctx, ctl, agentTerms, claude);
  registerSendToClaude(ctx, ctl, agentTerms);
  registerClaudeVoice(ctx, ctl, agentTerms);
  registerTerminalUx(ctx, ctl, agentTerms);
  /** Worktree a partir de item da árvore, grupo de sessões, caminho ou nada (pergunta). */
  const claudeTarget = async (arg?: { path?: string; wtPath?: string; branch?: string }): Promise<{ cwd: string; label: string } | undefined> => {
    const p = arg?.wtPath ?? arg?.path;
    const wts = ctl.state?.worktrees.filter(w => !w.prunable && !w.bare) ?? [];
    const found = p ? wts.find(w => w.path.toLowerCase() === p.toLowerCase()) : arg?.branch ? wts.find(w => w.branch === arg.branch) : undefined;
    if (found) return { cwd: found.path, label: found.name };
    if (p) return { cwd: p, label: require('path').basename(p) };
    const pick = await vscode.window.showQuickPick(
      wts.map(w => ({ label: w.name, description: w.claude ? t('{0} session(s)', w.claude.sessions) : '', detail: w.path, w })),
      { placeHolder: t('In which worktree?') },
    );
    return pick && { cwd: pick.w.path, label: pick.w.name };
  };

  ctx.subscriptions.push(new PushStatus(ctl), new PullStatus(ctl));
  const sync = new AutoSync(ctl);
  ctl.beforePush = branch => sync.beforePush(branch);
  const tree = new WorktreeTreeProvider(ctl);
  const treeView = vscode.window.createTreeView('worktreeGraph.worktrees', { treeDataProvider: tree, showCollapseAll: true, canSelectMany: true });
  ctl.onDidChangeRepo(() => sync.reschedule());
  ctl.onDidChange(s => {
    if (s) treeView.description = s.repoName;
    const n = s?.pending ?? 0;
    treeView.message = n > 0 ? t('Loading details of {0} of {1} worktrees…', n, s!.worktrees.filter(w => !w.prunable && !w.bare).length) : undefined;
    treeView.badge = n > 0 ? { value: n, tooltip: t('Loading details of {0} worktrees', n) } : undefined;
  });
  ctx.subscriptions.push(sync);
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('worktreeGraph.autoSync') && sync.reschedule()),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new GitShowProvider()),
    vscode.window.registerFileDecorationProvider(decorations),
    treeView,
  );

  const analyzeMerge = async (source?: string, target?: string) => {
    const src = source ?? (await actions.pickBranch(ctl, undefined, t('Analyze the merge of which branch?')));
    if (!src) return;
    const dst = target ?? (await ctl.base()).base;
    await MergePanel.show(
      ctl,
      src,
      dst,
      async (x, y) => void (await actions.mergeBranches(ctl, x, y)),
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
        t('The "{0}" view is not available in this window yet. This happens when a previous version of AgentYard is still active after an update.', name),
        t('Reload window'),
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
        await promote(ctl, a.from, a.to, (x, y) => actions.mergeBranches(ctl, x, y), (x, y) => analyzeMerge(x, y));
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
      case 'historyOfBranch':
        // menu da branch: o histórico passa a mostrar só ela (volta pelo seletor "Branches:")
        await ctx.workspaceState.update('graphFilter', 'all');
        await ctx.workspaceState.update('graphBranches', [a.branch]);
        if (a.branch.includes('/') && !(await ctl.repo?.refs())?.some(r => r.kind === 'head' && r.name === a.branch)) await ctx.workspaceState.update('graphShowRemotes', true);
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
        const target = await claudeTarget({ path: a.path });
        if (target) await claude.commands(target.cwd, target.label);
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
  const claudeIntegration = registerClaudeIntegration(ctx, ctl, guard, { agentTerms, agentsTree, agentFlow, coord, openTranscript: id => claude.transcriptById(id) });
  // o Claude de um projeto da lista continua falando com a janela depois de trocar o projeto ativo
  claudeIntegration.bridge.setProjects(() => projects.list().filter(p => !p.missing).map(p => p.path), projects.onDidChange);
  registerRemoteAccess(ctx, ctl, guard);
  const autopilot = registerAutopilot(ctx, ctl, guard, { agentTerms, agentFlow, bridge: claudeIntegration.bridge, integration: claudeIntegration.integration, coord, claude });

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
  reg('showUncommitted', item => actions.showUncommitted(ctl, item));
  reg('newWorktreeWithTask', item => actions.newWorktreeWithTask(ctl, item));
  reg('newWorktreeWithTaskFrom', item => actions.newWorktreeWithTask(ctl, item));
  reg('newWorktreeWithTaskByVoice', () => actions.newWorktreeWithTask(ctl, { voice: true }));
  reg('openTerminal', item => actions.openTerminal(ctl, item));
  reg('launchAgent', (item, agent?: string) => launchAgent(item, agent));
  // botão da barra de status: o primeiro agente configurado, na worktree desta janela
  const here = () => ctl.state?.worktrees.find(w => w.isCurrent);
  // a worktree do arquivo aberto no editor; sem ele, a desta janela
  const focused = () => {
    const f = vscode.window.activeTextEditor?.document.uri;
    return (f?.scheme === 'file' && worktreeOfFile(ctl, f.fsPath)) || here();
  };
  reg('launchAgentHere', (mode?: 'new') => {
    const w = focused();
    const dir = w?.path ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return launchAgent(dir ? { path: dir, branch: w?.branch } : undefined, agents(ctl)[0]?.name, mode);
  });
  const agentStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 47);
  agentStatus.name = t('Open agent in this worktree');
  agentStatus.command = 'worktreeGraph.launchAgentHere';
  const updateAgentStatus = () => {
    const a = agents(ctl)[0];
    if (!a || !ctl.repo || !ctl.cfg().get<boolean>('agentStatusBar', true)) return agentStatus.hide();
    const w = focused();
    // já há um agente aqui: mostra o estado dele, e o clique traz o terminal
    const open = w && pickRelevant(agentTerms.list(w.path));
    if (open) {
      const icon = open.state === 'waiting' ? 'bell-dot' : open.state === 'working' ? 'loading~spin' : 'sparkle';
      const state = stateText(open.state);
      agentStatus.text = `$(${icon}) ${open.agent} · ${w!.branch ?? w!.name}${state ? ` · ${state}` : ''}`;
      agentStatus.tooltip = [open.terminal.name, open.message, t('Click to go to the terminal.')].filter(Boolean).join('\n');
      agentStatus.command = { command: 'worktreeGraph.agents.show', title: t('Show terminal'), arguments: [{ kind: 'terminal', open }] };
      agentStatus.show();
      return;
    }
    agentStatus.command = 'worktreeGraph.launchAgentHere';
    agentStatus.text = `$(sparkle) ${a.name}`;
    agentStatus.tooltip =
      (w ? t('Open {0} in a terminal in the {1} worktree', a.name, w.name) : t('Open {0} in a terminal in this folder', a.name)) +
      (w?.agents?.length ? ' ' + t('({0} already open)', w.agents.length) : '');
    agentStatus.show();
  };
  // onde estamos: pasta da worktree e branch desta janela; clique abre o painel
  const whereStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 52);
  whereStatus.name = t('Worktree and branch of this window');
  whereStatus.command = 'worktreeGraph.openGraph';
  const updateWhereStatus = () => {
    const w = here();
    if (!w || !ctl.cfg().get<boolean>('worktreeStatusBar', true)) return whereStatus.hide();
    const folder = require('path').basename(w.path);
    const branch = w.branch ?? `(${w.head.slice(0, 7)})`;
    whereStatus.text = `$(repo) ${folder} $(git-branch) ${branch}`;
    const kind = w.isMain ? t('main worktree') : 'worktree';
    whereStatus.tooltip = new vscode.MarkdownString(
      `**${ctl.state!.repoName}** · ${kind}\n\n` +
        t('Folder: {0}', `\`${w.path}\``) +
        `\n\nBranch: \`${branch}\`${w.isBase ? ' (base)' : ''}` +
        (w.changes ? '\n\n● ' + t('{0} uncommitted change(s)', w.changes) : '') +
        (w.compareKnown && !w.isBase ? '\n\n' + t('↓{0} ↑{1} compared to {2}', w.behind, w.ahead, `\`${ctl.state!.baseRef}\``) : '') +
        '\n\n' + t('Click to open the AgentYard panel.'),
    );
    whereStatus.show();
  };
  const updateStatusItems = () => {
    updateAgentStatus();
    updateWhereStatus();
  };
  ctx.subscriptions.push(
    agentStatus,
    whereStatus,
    ctl.onDidChange(updateStatusItems),
    agentTerms.onDidChange(updateAgentStatus),
    vscode.window.onDidChangeActiveTextEditor(updateAgentStatus),
    vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('worktreeGraph') && updateStatusItems()),
  );
  updateStatusItems();
  reg('launchAgentNew', (item?: AgentGroupItem | { path?: string; branch?: string }, agent?: string) => launchAgent(item, agent, 'new'));
  reg('agents.pick', (item?: { path?: string }) => agentTerms.pickOpen(item?.path));
  reg('agents.show', node => terminalOf(node)?.show());
  reg('agents.close', node => terminalOf(node)?.dispose());
  reg('agents.transcript', node => {
    const id = openAgentOf(node)?.sessionId;
    return id && claude.transcriptById(id);
  });
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
      vscode.window.showWarningMessage(branch ? t('No worktree for {0}.', branch) : t('No worktree for the task.'));
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
    const target = await claudeTarget(item);
    if (target) claude.newSession(target.cwd);
  });
  reg('claude.commands', async item => {
    const target = await claudeTarget(item);
    if (target) await claude.commands(target.cwd, target.label);
  });
  reg('claude.lastMessage', async (item?: SessionItem | { path?: string; wtPath?: string; branch?: string }) => {
    if (item instanceof SessionItem) return claude.lastMessage(item.session.cwd ?? '', item.session);
    const target = await claudeTarget(item);
    if (target) await claude.lastMessage(target.cwd);
  });
  reg('claude.recap', async item => {
    const target = await claudeTarget(item);
    if (target) await claude.recap(target.cwd);
  });
  reg('claude.recapSummary', async item => {
    const target = await claudeTarget(item);
    if (target) await claude.recap(target.cwd, true);
  });
  // item da árvore/grafo ({ branch }), commit de merge ({ sha }) ou nada (escolhe os merges da base)
  const mergeArg = (item?: { sha?: string; branch?: string } | string) => (typeof item === 'string' ? { branch: item } : { sha: item?.sha, branch: item?.branch });
  reg('claude.recapMerges', item => claude.recapMerges(mergeArg(item)));
  reg('claude.recapMergesSummary', item => claude.recapMerges(mergeArg(item), true));
  reg('claude.saveMergeRecap', (a: { branch: string; target: string }) => claude.saveMergeRecap(a.branch, a.target));
  reg('claude.usage', () => usagePanel.show());
  reg('publishRequest', async item => {
    const b = await actions.pickBranch(ctl, item, t('Publish a PR/MR for which branch?'));
    if (b) await ctl.requests.publish(b);
  });
  reg('connectHosting', () => ctl.requests.connect());
  reg('connectGitLab', () => ctl.requests.connectGitLab());
  reg('pushBranch', async item => {
    const b = await actions.pickBranch(ctl, item, t('Push which branch?'));
    if (b) await pushBranch(ctl, b);
  });
  reg('pushMany', () => pushMany(ctl));
  reg('pushSelected', () => pushSelected(ctl));
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
  registerPrFeedback(ctx, ctl, guard, { prs, bridge: claudeIntegration.bridge, integration: claudeIntegration.integration, agentFlow, pipelines });
  const stack = registerStack(ctx, ctl, guard, { prs, agentTerms });
  registerGitExtras(ctx, ctl, guard, { agentTerms });
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
  autopilot.trackTemplates(templates);
  const readySummary = new ReadySummaryService(ctl, agentFlow);
  ctx.subscriptions.push(readySummary);
  const delivery = registerDelivery(ctx, ctl, guard, { activity, pipelines: () => pipelines.pipelines, issueOf: b => issues.linkOf(b) });
  const promotion = registerPromotion(ctx, ctl, guard, {
    promote: (from, to) => promote(ctl, from, to, (x, y) => actions.mergeBranches(ctl, x, y), (x, y) => analyzeMerge(x, y)),
    merge: (x, y) => actions.mergeBranches(ctl, x, y),
    showCommit: sha => commits.showCommit(ctl, sha),
  });

  // Registra tudo antes de ler o repositório: a leitura pode levar segundos em repositórios grandes.
  const ready = ctl.init().then(() => {
    projects.scanWorkspace();
    issues.refresh(true);
  });

  // Usado pelos testes de integração (test/).
  const claudeConfig = registerClaudeConfig(ctx, ctl, { agentTerms, claude });

  const guards = registerGuards(ctx, ctl);
  registerMigrations(ctx, ctl);

  return { ctl, tree, treeView, agentTerms, actions, panelAction: handler, sync, GraphPanel, ready, decorations, projects, issues, claude, usage, claudeConfig, pipelines, guards, review, activity, agentFlow, gitOps, schedules, coord, env, templates, readySummary, delivery, prs, promotion, bridge: claudeIntegration.bridge, claudeIntegration: claudeIntegration.integration, stack };
}

export function deactivate() {}
