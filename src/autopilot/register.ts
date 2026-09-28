import * as vscode from 'vscode';
import type { AgentTerminals } from '../agents';
import type { AgentFlow } from '../agentFlow/register';
import type { ClaudeBridge } from '../bridge/register';
import type { ClaudeIntegration } from '../claude/integration';
import type { Controller } from '../controller';
import { StopGate } from './stopGate';

interface Deps {
  agentTerms: AgentTerminals;
  agentFlow: AgentFlow;
  bridge: ClaudeBridge;
  integration: ClaudeIntegration;
}

export interface Autopilot {
  gate: StopGate;
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

  return { gate };
}
