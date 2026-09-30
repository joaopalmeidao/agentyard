import * as path from 'path';
import * as vscode from 'vscode';
import { AgentTerminals, OpenAgent } from '../agents';
import type { Controller } from '../controller';
import { t } from '../i18n';
import { osNotify } from './osNotify';

const keyOf = (p: string) => path.normalize(p).toLowerCase();

/**
 * O que os hooks do Claude contam vira aviso: estado nos cards e na árvore, item na barra de status
 * ("2 esperando você") e notificação quando um Claude pede permissão ou termina o turno.
 */
export function registerAgentAttention(ctx: vscode.ExtensionContext, ctl: Controller, agentTerms: AgentTerminals) {
  const where = (o: OpenAgent) => o.branch ?? path.basename(o.path);

  ctl.stateHooks.push(s => {
    const by = new Map<string, OpenAgent[]>();
    for (const o of agentTerms.list()) if (o.state) by.set(keyOf(o.path), [...(by.get(keyOf(o.path)) ?? []), o]);
    for (const w of s.worktrees) {
      const list = by.get(keyOf(w.path));
      const n = (st: string) => list?.filter(o => o.state === st).length ?? 0;
      w.agentStates = list?.length ? { waiting: n('waiting'), working: n('working'), idle: n('idle'), message: list.find(o => o.state === 'waiting')?.message } : undefined;
    }
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 46);
  status.name = t('Claude Code waiting for you');
  status.command = 'worktreeGraph.agents.pickWaiting';
  const updateStatus = () => {
    const open = agentTerms.list().filter(o => o.state);
    const waiting = open.filter(o => o.state === 'waiting');
    const working = open.filter(o => o.state === 'working');
    if (!ctl.cfg().get<boolean>('agentStatusBar', true) || (!waiting.length && !working.length)) return status.hide();
    if (waiting.length) {
      status.text = `$(bell-dot) ${t('{0} waiting for you', waiting.length)}`;
      status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      status.text = `$(loading~spin) ${t('{0} working', working.length)}`;
      status.backgroundColor = undefined;
    }
    const md = new vscode.MarkdownString(undefined, true);
    for (const o of waiting) md.appendMarkdown(`$(bell-dot) **${where(o)}** · ${o.message ?? t('waiting for you')}\n\n`);
    for (const o of working) md.appendMarkdown(`$(loading~spin) **${where(o)}** · ${t('working')}\n\n`);
    md.appendMarkdown(t('Click to go to the terminal.'));
    status.tooltip = md;
    status.show();
  };

  const notify = async (o: OpenAgent, previous?: string) => {
    const mode = ctl.cfg().get<string>('claude.notify', 'waiting');
    if (mode === 'off') return;
    // já está olhando para esse terminal: não precisa avisar
    if (vscode.window.state.focused && vscode.window.activeTerminal === o.terminal) return;
    const show = t('Show terminal');
    let pick: string | undefined;
    if (o.state === 'waiting') {
      // o pedido de permissão chega também pela ponte, que pergunta com Permitir/Negar: espera um
      // instante para não avisar duas vezes
      await new Promise(r => setTimeout(r, 1500));
      if (o.asking || o.state !== 'waiting') return;
      // plano proposto agora há pouco: o aviso do plano já foi
      if (o.planAt && Date.now() - o.planAt < 120_000) return;
      if (!vscode.window.state.focused) osNotify(ctl, t('{0} in {1} needs you', o.agent, where(o)), o.message ?? t('waiting for your answer'));
      // pedido de permissão: dá para responder daqui (Enter aceita a opção marcada, Esc recusa)
      const answer = o.notificationType === 'permission_prompt' && ctl.cfg().get<boolean>('claude.answerFromNotification', false);
      const allow = t('Allow');
      const deny = t('Deny');
      const asked = o.stateAt;
      pick = await vscode.window.showWarningMessage(
        t('{0} in {1} needs you: {2}', o.agent, where(o), o.message ?? t('waiting for your answer')),
        ...(answer ? [allow, deny, show] : [show]),
      );
      if (pick === allow || pick === deny) {
        // a notificação pode ter ficado aberta enquanto você respondeu no terminal (ou veio outro pedido)
        if (o.stateAt !== asked || !agentTerms.answerPermission(o, pick === allow)) vscode.window.showInformationMessage(t('{0} in {1} is no longer waiting.', o.agent, where(o)));
        return;
      }
    } else if (mode === 'all' && o.state === 'idle' && previous === 'working') {
      if (!vscode.window.state.focused) osNotify(ctl, 'AgentYard', t('{0} in {1} finished and is waiting for your next message.', o.agent, where(o)));
      pick = await vscode.window.showInformationMessage(t('{0} in {1} finished and is waiting for your next message.', o.agent, where(o)), show);
    }
    if (pick === show) o.terminal.show();
  };

  let repaint: NodeJS.Timeout | undefined;
  ctx.subscriptions.push(
    status,
    agentTerms.onDidChange(updateStatus),
    agentTerms.onDidChangeState(({ open, previous }) => {
      void notify(open, previous);
      if (repaint) clearTimeout(repaint);
      repaint = setTimeout(() => ctl.repaint(), 100);
    }),
    vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('worktreeGraph.agentStatusBar') && updateStatus()),
    vscode.commands.registerCommand('worktreeGraph.agents.pickWaiting', () => {
      const waiting = agentTerms.list().some(o => o.state === 'waiting');
      return agentTerms.pickOpen(undefined, waiting ? o => o.state === 'waiting' : o => !!o.state);
    }),
    { dispose: () => repaint && clearTimeout(repaint) },
  );
  updateStatus();
}
