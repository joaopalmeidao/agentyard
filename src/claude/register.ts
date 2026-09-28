import * as vscode from 'vscode';
import { agents, AgentTerminals, promptArgument } from '../agents';
import type { AgentFlow } from '../agentFlow/register';
import { keyOf } from '../agentFlow/head';
import { AgentsTreeProvider, turnOf } from '../agentsView';
import { ClaudeBridge, registerClaudeBridge } from '../bridge/register';
import type { Controller } from '../controller';
import type { Coord } from '../coord/register';
import { t } from '../i18n';
import { claudeArgs, isClaudeCommand } from './hooks';
import { ClaudeIntegration } from './integration';
import { metricsReport, TaskRow } from './metrics';
import { MissionControl } from './missionControl';
import { registerAgentReview } from './reviewComments';
import { askTask } from '../taskInput';

interface Deps {
  agentTerms: AgentTerminals;
  agentsTree: AgentsTreeProvider;
  agentFlow: AgentFlow;
  coord: Coord;
  openTranscript: (sessionId: string) => Promise<void>;
}

type WtArg = { path?: string; wtPath?: string; branch?: string } | string | undefined;

const MODELS = ['opus', 'sonnet', 'haiku'];
const MODES = ['default', 'plan', 'acceptEdits', 'auto'];
const LAST_KEY = 'claude.lastLaunchOptions';

/**
 * Integração com o Claude Code: a ponte (hooks e MCP, src/bridge), o que a extensão faz com eles
 * (src/claude/integration.ts) e os comandos: turnos, autoria da linha, abrir com opções e métricas.
 */
export function registerClaudeIntegration(ctx: vscode.ExtensionContext, ctl: Controller, guard: <T extends unknown[]>(fn: (...a: T) => unknown) => (...a: T) => Promise<void>, d: Deps) {
  const bridge = registerClaudeBridge(ctx, ctl, { agentTerms: d.agentTerms, agentFlow: d.agentFlow, coord: d.coord });
  const integration = new ClaudeIntegration(ctx, ctl, bridge, d.agentTerms, d.coord, d.openTranscript);
  ctx.subscriptions.push(integration);
  d.agentsTree.setTurns(integration);
  const review = registerAgentReview(ctx, ctl, bridge, integration);

  /** Worktree de item da árvore, card, sessão, caminho ou branch; sem nada, a da janela ou pergunta. */
  const worktreeOf = async (arg: WtArg, placeHolder: string) => {
    const wts = (ctl.state?.worktrees ?? []).filter(w => !w.bare && !w.prunable);
    const p = typeof arg === 'string' ? undefined : arg?.wtPath ?? arg?.path;
    const b = typeof arg === 'string' ? arg : arg?.branch;
    const hit = p ? wts.find(w => keyOf(w.path) === keyOf(p)) : b ? wts.find(w => w.branch === b) : undefined;
    if (hit) return hit;
    const pick = await vscode.window.showQuickPick(
      wts.map(w => ({ label: w.name, description: w.branch, detail: w.path, w })),
      { placeHolder },
    );
    return pick?.w;
  };

  const reg = (id: string, fn: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(`worktreeGraph.${id}`, guard(fn)));

  const mission = new MissionControl(ctx, ctl, d.agentTerms);
  ctx.subscriptions.push(mission);
  reg('missionControl', () => mission.show());

  // hooks que nunca responderam (Git Bash ausente no Windows, host remoto…): avisa uma vez por terminal
  const warned = new Set<string>();
  const hooksCheck = setInterval(() => {
    for (const o of d.agentTerms.list()) {
      if (o.state !== 'starting' || warned.has(o.id) || Date.now() - o.started < 60_000) continue;
      warned.add(o.id);
      const diag = t('Diagnostics');
      void vscode.window
        .showWarningMessage(t('The Claude Code hooks in {0} did not answer yet: state, guard, permissions in VS Code and checkpoints are off for this terminal.', o.terminal.name), diag)
        .then(p => p && vscode.commands.executeCommand('worktreeGraph.claudeIntegration.status'));
    }
  }, 20_000);
  ctx.subscriptions.push({ dispose: () => clearInterval(hooksCheck) });

  reg('turns.show', async node => {
    const n = turnOf(node);
    if (n) await integration.showTurn(n.log, n.turn);
  });
  reg('turns.restore', async node => {
    const n = turnOf(node);
    if (n) await integration.restoreTurn(n.log, n.turn, 'start');
  });
  reg('turns.restoreAfter', async node => {
    const n = turnOf(node);
    if (n) await integration.restoreTurn(n.log, n.turn, 'end');
  });
  reg('turns.pick', async (arg: WtArg) => {
    const w = await worktreeOf(arg, t('Agent turns of which worktree?'));
    if (w) await integration.pickTurn(w.path);
  });
  reg('claude.whoWrote', () => integration.whoWrote());

  reg('claude.launchWithOptions', async (arg: WtArg) => {
    const w = await worktreeOf(arg, t('Open Claude Code in which worktree?'));
    if (!w) return;
    const agent = agents(ctl).find(a => isClaudeCommand(a.command)) ?? { name: 'Claude Code', command: 'claude' };
    const last = ctx.globalState.get<{ model?: string; permissionMode?: string }>(LAST_KEY, {});
    const where = w.branch ?? w.name;
    const model = await vscode.window.showQuickPick(
      [
        { label: t('Default model'), value: '' },
        ...MODELS.map(m => ({ label: m, value: m })),
        { label: t('Other…'), value: '?' },
      ].map(i => ({ ...i, description: i.value && i.value === last.model ? t('last used') : undefined })),
      { title: t('Claude Code in {0} (1/3): model', where), placeHolder: t('Model for this session') },
    );
    if (!model) return;
    let modelId = model.value;
    if (modelId === '?') {
      const typed = await vscode.window.showInputBox({ title: t('Model'), prompt: t('Alias or full model id (e.g. opus, claude-opus-5-5)'), value: last.model });
      if (!typed) return;
      modelId = typed.trim();
    }
    const modeLabels: Record<string, string> = {
      default: t('Ask before editing and running commands (default)'),
      plan: t('Plan first: Claude only reads and proposes a plan for you to approve'),
      acceptEdits: t('Accept edits automatically, ask for commands'),
      auto: t('Auto: a classifier approves safe actions'),
    };
    const mode = await vscode.window.showQuickPick(
      MODES.map(m => ({ label: m, detail: modeLabels[m], description: m === (last.permissionMode ?? 'default') ? t('last used') : undefined })),
      { title: t('Claude Code in {0} (2/3): permission mode', where) },
    );
    if (!mode) return;
    const task = await askTask({
      title: t('Claude Code in {0} (3/3): task', where),
      prompt: t('Initial task for the agent (empty = open without a task)'),
    });
    if (task === undefined) return;
    await ctx.globalState.update(LAST_KEY, { model: modelId || undefined, permissionMode: mode.label });
    const system = ctl.cfg().get<string>('claude.appendSystemPrompt', '');
    const args = [ctl.cfg().get<string>('claude.extraArgs', ''), claudeArgs({ model: modelId, permissionMode: mode.label, systemPrompt: system }, s => promptArgument(s).arg)]
      .filter(Boolean)
      .join(' ');
    const bin = agent.command.trim().split(/\s+/)[0];
    let command = `${bin}${args ? ` ${args}` : ''}`;
    if (task.trim()) command += ` ${promptArgument(task.trim()).arg}`;
    await d.agentTerms.start(w.path, w.branch, agent.name, command, { task: !!task.trim(), prompt: task.trim() || undefined, noExtraArgs: true });
  });

  reg('claude.taskMetrics', async () => {
    const rows: TaskRow[] = [];
    const counters = integration.counters();
    for (const w of (ctl.state?.worktrees ?? []).filter(x => !x.bare && !x.prunable)) {
      const c = counters[keyOf(w.path)];
      const logs = integration.logsFor(w.path);
      const done = logs.flatMap(l => l.turns).filter(x => x.end);
      if (!c && !w.claude && !logs.length) continue;
      rows.push({
        name: w.branch ?? w.name,
        tokens: w.claude?.tokens,
        usd: w.claude?.usd,
        sessions: w.claude?.sessions,
        turns: Math.max(c?.turns ?? 0, done.length),
        additions: done.reduce((a, x) => a + (x.additions ?? 0), 0),
        deletions: done.reduce((a, x) => a + (x.deletions ?? 0), 0),
        commits: done.reduce((a, x) => a + (x.commits ?? 0), 0),
        permissions: c?.permissions ?? 0,
        approvedInVsCode: c?.approvedInVsCode ?? 0,
        deniedInVsCode: c?.deniedInVsCode ?? 0,
        guardBlocks: c?.guardBlocks ?? 0,
        plans: c?.plans ?? 0,
        budgetBlocks: c?.budgetBlocks ?? 0,
        status: w.request ? `${w.request.ref} ${w.request.state}` : w.review ? t('ready for review') : undefined,
        since: c?.since,
      });
    }
    const md = metricsReport(rows, {
      title: t('Agent task metrics · {0}', ctl.state?.repoName ?? ''),
      headers: [t('Worktree'), t('Tokens'), 'US$', t('Turns'), t('Tokens/turn'), t('Lines'), t('Commits'), t('Interventions'), t('Plans')],
      totals: t('Total'),
      empty: t('No agent activity recorded yet.'),
      note: t(
        'Interventions = permission requests (✓ allowed / ✗ denied in VS Code) + actions blocked by the worktree guard (⛔) or the budget. Turns, lines and commits come from the checkpoints of Claude opened by AgentYard; tokens and US$ from the Claude Code session logs.',
      ),
    });
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
    await vscode.commands.executeCommand('markdown.showPreview', doc.uri).then(undefined, () => vscode.window.showTextDocument(doc));
  });

  return { bridge, integration, mission, review };
}

export type { ClaudeBridge };
