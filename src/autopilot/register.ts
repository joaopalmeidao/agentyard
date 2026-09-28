import * as vscode from 'vscode';
import type { AgentTerminals } from '../agents';
import type { AgentFlow } from '../agentFlow/register';
import type { ClaudeBridge } from '../bridge/register';
import type { ClaudeIntegration } from '../claude/integration';
import type { Controller } from '../controller';
import { keyOf } from '../agentFlow/head';
import { t } from '../i18n';
import type { WorktreeView } from '../model';
import { AutoReviewer } from './reviewer';
import { StopGate } from './stopGate';
import { StuckWatch } from './stuck';

interface Deps {
  agentTerms: AgentTerminals;
  agentFlow: AgentFlow;
  bridge: ClaudeBridge;
  integration: ClaudeIntegration;
}

type WtArg = { path?: string; wtPath?: string; branch?: string } | string | undefined;

/** Worktree de item da árvore, card, caminho ou branch; sem nada, pergunta. */
export async function worktreeOf(ctl: Controller, arg: WtArg, placeHolder: string): Promise<WorktreeView | undefined> {
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
}

export interface Autopilot {
  gate: StopGate;
  reviewer: AutoReviewer;
}

/**
 * Piloto automático dos agentes: o que fecha o ciclo sem precisar de uma pessoa a cada passo
 * (portão no Stop, revisor automático), coordena os agentes entre si e os mantém rodando.
 */
export function registerAutopilot(ctx: vscode.ExtensionContext, ctl: Controller, guard: <T extends unknown[]>(fn: (...a: T) => unknown) => (...a: T) => Promise<void>, d: Deps): Autopilot {
  const reg = (id: string, fn: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(`worktreeGraph.${id}`, guard(fn)));

  const gate = new StopGate(ctl, d.bridge, d.integration, d.agentFlow, d.agentTerms);
  ctx.subscriptions.push(gate);
  reg('claude.configureStopGate', () => gate.configure());

  const reviewer = new AutoReviewer(ctl, d.bridge, d.integration, d.agentFlow, d.agentTerms);
  ctx.subscriptions.push(reviewer);
  reg('agents.configureAutoReview', () => reviewer.configure());
  reg('agents.autoReviewNow', async (arg?: WtArg) => {
    const w = await worktreeOf(ctl, arg, t('Review which worktree?'));
    if (w) await reviewer.reviewNow(w.path, w.branch);
  });
  reg('agents.showAutoReview', async (arg?: WtArg) => {
    const w = await worktreeOf(ctl, arg, t('Automatic review of which worktree?'));
    if (w) await reviewer.show(w.path);
  });

  ctx.subscriptions.push(new StuckWatch(ctl, d.bridge, d.integration, d.agentTerms));

  return { gate, reviewer };
}
