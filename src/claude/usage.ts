import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentTerminals } from '../agents';
import type { UsagePause } from '../autopilot/core';
import type { Controller } from '../controller';
import { t } from '../i18n';
import { currentPct, emptyHistory, RateLimit, readStatuses, recordUsage, StatusSnapshot, UsageHistory } from './statusLine';

const POLL_MS = 3000;

export interface LiveLimits {
  /** Quando o Claude mandou (ms). */
  at: number;
  fiveHour?: RateLimit;
  sevenDay?: RateLimit;
}

/**
 * Uso real do Claude Code, vindo da statusline dos terminais abertos pela extensão
 * (src/claude/statusLine.ts): limites do plano (sessão de 5 h e semana), contexto e custo de cada
 * terminal. Guarda um histórico curto em disco para o gráfico e o custo por dia.
 */
export class ClaudeUsage implements vscode.Disposable {
  history: UsageHistory = emptyHistory();
  /** Última atualização de cada terminal (id → snapshot), de todas as janelas. */
  snapshots = new Map<string, StatusSnapshot>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly timer: NodeJS.Timeout;
  private saveTimer?: NodeJS.Timeout;
  private stamp = '';

  constructor(private readonly ctl: Controller, private readonly agentTerms: AgentTerminals) {
    this.load();
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.poll();
  }

  private file() {
    return path.join(this.ctl.ctx.globalStorageUri.fsPath, 'claude-usage.json');
  }

  private load() {
    try {
      const h = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as UsageHistory;
      if (h && Array.isArray(h.limits) && h.sessions) this.history = h;
    } catch {
      // primeira vez
    }
  }

  private save() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(this.file()), { recursive: true });
        fs.writeFileSync(this.file(), JSON.stringify(this.history));
      } catch (e) {
        this.ctl.log(t('Claude usage: could not save the history: {0}', (e as Error).message));
      }
    }, 2000);
  }

  poll() {
    const list = readStatuses(this.agentTerms.eventsDir());
    const stamp = list.map(s => `${s.id}:${s.at}`).sort().join('|');
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    // outra janela pode ter gravado depois: o histórico em disco é relido antes de somar
    this.load();
    this.snapshots = new Map(list.map(s => [s.id, s]));
    if (recordUsage(this.history, list, Date.now())) this.save();
    this.changed.fire();
  }

  /** Limites do plano mais recentes; uma janela que já renovou conta como 0%. */
  limits(now = Date.now()): LiveLimits | undefined {
    const l = this.history.latest;
    if (!l) return undefined;
    const cur = (r?: RateLimit) => (r ? { ...r, pct: currentPct(r, now)!, resetsAt: r.resetsAt !== undefined && r.resetsAt <= now ? undefined : r.resetsAt } : undefined);
    return { at: l.at, fiveHour: cur(l.fiveHour), sevenDay: cur(l.sevenDay) };
  }

  /**
   * A fila de tarefas deve esperar? Com os limites reais, eles decidem (`tasks.pauseAtUsage`);
   * sem eles, `undefined` e quem chama usa a estimativa pelos logs.
   */
  pause(now = Date.now()): UsagePause | undefined | 'unknown' {
    const l = this.limits(now);
    if (!l || (!l.fiveHour && !l.sevenDay)) return 'unknown';
    const limit = this.ctl.cfg().get<number>('tasks.pauseAtUsage', 90);
    if (limit <= 0) return undefined;
    if (l.sevenDay && l.sevenDay.pct >= limit) return { window: 'week', pct: Math.round(l.sevenDay.pct), until: l.sevenDay.resetsAt ?? now + 3600_000 };
    if (l.fiveHour && l.fiveHour.pct >= limit) return { window: '5h', pct: Math.round(l.fiveHour.pct), until: l.fiveHour.resetsAt ?? now + 1800_000 };
    return undefined;
  }

  dispose() {
    clearInterval(this.timer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.changed.dispose();
  }
}
