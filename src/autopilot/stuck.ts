import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentTerminals, OpenAgent } from '../agents';
import type { ClaudeIntegration } from '../claude/integration';
import { osNotify } from '../claude/osNotify';
import * as turns from '../claude/turns';
import type { Controller } from '../controller';
import { t } from '../i18n';

const TICK_MS = 60_000;

/**
 * Agente travado: um turno trabalhando há `claude.stuck.minutes` sem mudar nenhum arquivo gera um
 * aviso com Mostrar terminal e Interromper (Esc). Só avisa; nada é negado.
 */
export class StuckWatch implements vscode.Disposable {
  /** Turnos já avisados por tempo (chave do log + número do turno). */
  private readonly warned = new Set<string>();
  private readonly timer: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly ctl: Controller,
    private readonly integration: ClaudeIntegration,
    private readonly agentTerms: AgentTerminals,
  ) {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  private cfg() {
    return this.ctl.cfg();
  }

  private async tick() {
    const minutes = this.cfg().get<number>('claude.stuck.minutes', 20);
    if (minutes <= 0 || this.ticking) return;
    this.ticking = true;
    try {
      for (const o of this.agentTerms.list().filter(x => x.claude && x.state === 'working')) {
        const log = this.integration.turnsOf(o);
        const turn = log?.turns[log.turns.length - 1];
        if (!log || !turn || turn.end || Date.now() - turn.startedAt < minutes * 60_000) continue;
        const id = `${log.key}#${turn.n}`;
        if (this.warned.has(id)) continue;
        let same = false;
        try {
          same = await turns.sameTree(o.path, turn.start, await turns.snapshot(o.path));
        } catch {
          continue;
        }
        if (!same) continue;
        this.warned.add(id);
        const where = o.branch ?? path.basename(o.path);
        const mins = Math.round((Date.now() - turn.startedAt) / 60_000);
        this.ctl.log(t('Claude in {0} has been working for {1} min without changing any file.', where, mins));
        this.warn(t('Claude in {0} has been working for {1} min without changing any file. It may be stuck.', where, mins), o, o.path);
      }
    } finally {
      this.ticking = false;
    }
  }

  private warn(msg: string, open: OpenAgent | undefined, worktree: string) {
    if (!vscode.window.state.focused) osNotify(this.ctl, 'AgentYard', msg);
    const show = t('Show terminal');
    const stop = t('Interrupt');
    void vscode.window.showWarningMessage(msg, show, stop).then(pick => {
      const term = open?.terminal ?? this.agentTerms.claudeIn(worktree)[0]?.terminal;
      if (!pick || !term) return;
      term.show();
      // Esc interrompe o turno do Claude Code (o que ele fez até ali fica)
      if (pick === stop) term.sendText('\x1b', false);
    });
  }

  dispose() {
    clearInterval(this.timer);
  }
}
