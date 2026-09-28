/**
 * Coordenação de vários agentes: regras puras (sem VS Code) para sobreposição de arquivos, fila de
 * merge, tarefa em lote e orçamento. Testadas em test/coord.test.js.
 */

import { t } from '../i18n';

export interface ActiveInput {
  agents: string[];
  favorite: boolean;
  changes: number;
  ahead: number;
  compareKnown: boolean;
  /** Data (unix, s) do último commit da branch. */
  date: number;
  isBase: boolean;
  isMain: boolean;
  prunable: boolean;
  bare: boolean;
}

/**
 * Worktree "ativa" para o detector: agente aberto, favorita, com alterações não commitadas, ou com
 * commits fora da base e atividade nas últimas 24 h. A base e a principal nunca entram.
 */
export function isActive(w: ActiveInput, nowSec = Date.now() / 1000): boolean {
  if (w.isBase || w.isMain || w.prunable || w.bare) return false;
  if (w.agents.length || w.favorite || w.changes > 0) return true;
  return w.compareKnown && w.ahead > 0 && w.date > nowSec - 86400;
}

export interface Overlap {
  a: string;
  b: string;
  files: string[];
}

/** Pares de worktrees com arquivos em comum (caminhos relativos com "/"), mais sobreposto primeiro. */
export function findOverlaps(touched: Map<string, Set<string>>): Overlap[] {
  const names = [...touched.keys()].sort();
  const out: Overlap[] = [];
  for (let i = 0; i < names.length; i++) {
    const A = touched.get(names[i])!;
    if (!A.size) continue;
    for (let j = i + 1; j < names.length; j++) {
      const B = touched.get(names[j])!;
      const [small, big] = A.size <= B.size ? [A, B] : [B, A];
      const common = [...small].filter(f => big.has(f)).sort();
      if (common.length) out.push({ a: names[i], b: names[j], files: common });
    }
  }
  return out.sort((x, y) => y.files.length - x.files.length || x.a.localeCompare(y.a));
}

/** Resumo por worktree: com quem ela sobrepõe e quantos arquivos no total. */
export function overlapSummary(overlaps: Overlap[]): Map<string, { with: string[]; files: number }> {
  const m = new Map<string, { with: string[]; files: number }>();
  for (const o of overlaps) {
    for (const [me, other] of [
      [o.a, o.b],
      [o.b, o.a],
    ]) {
      const cur = m.get(me) ?? { with: [], files: 0 };
      cur.with.push(other);
      cur.files += o.files.length;
      m.set(me, cur);
    }
  }
  return m;
}

/** Chave estável do conjunto de sobreposições de um par (para avisar uma vez por conjunto novo). */
export const overlapKey = (o: Overlap) => `${o.a}|${o.b}|${o.files.join(',')}`;

// ---------- fila de merge ----------

export type MergeItemStatus = 'waiting' | 'running' | 'agent' | 'awaiting-pr' | 'done' | 'failed';

/** Quantas vezes a fila entrega o mesmo item ao agente antes de desistir dele. */
export const MAX_AGENT_TRIES = 2;

export interface MergeItem {
  branch: string;
  target: string;
  status: MergeItemStatus;
  reason?: string;
  added: number;
  finished?: number;
  /** Vezes que o item já foi entregue ao agente (conflito ou checagem falhando). */
  agentTries?: number;
  /** Worktree onde o agente está resolvendo o item. */
  agentPath?: string;
  /** O agente que resolver este item já abre autorizado (`mergeQueue.authorizedPermissionMode`), sem parar para perguntar. */
  authorized?: boolean;
}

/** Passos da fila; injetados para a regra ser testável sem git nem VS Code. */
export interface MergeSteps {
  /** Traz o destino atual para a branch; devolve o motivo se não der (conflito etc.). */
  syncTarget(item: MergeItem): Promise<string | undefined>;
  /** Checagens/testes da branch; false = falharam. */
  checks(item: MergeItem): Promise<boolean>;
  /** O destino exige PR/MR (branch protegida com require-pr)? */
  requiresPr(item: MergeItem): boolean;
  /** Mescla de verdade; devolve o motivo se não der. */
  merge(item: MergeItem): Promise<string | undefined>;
  /** Push do destino depois de mesclar (se configurado). */
  pushTarget?(item: MergeItem): Promise<void>;
  /** Entrega o problema ao agente na worktree da branch; true = ele assumiu e a fila espera. */
  handoff?(item: MergeItem, reason: string): Promise<boolean>;
}

/**
 * Processa o próximo item "waiting" (ou o que estava "running", se a janela fechou no meio).
 * Um por vez: devolve o item processado com o novo status, ou undefined se não há o que fazer.
 */
export async function processNext(items: MergeItem[], steps: MergeSteps, now = Date.now()): Promise<MergeItem | undefined> {
  if (items.some(i => i.status === 'awaiting-pr' || i.status === 'agent')) return undefined; // espera o PR/MR ou o agente antes de seguir
  const item = items.find(i => i.status === 'running') ?? items.find(i => i.status === 'waiting');
  if (!item) return undefined;
  item.status = 'running';
  item.reason = undefined;
  const fail = (reason: string) => {
    item.status = 'failed';
    item.reason = reason;
    item.finished = now;
    return item;
  };
  // Conflito ou checagem falhando: o agente resolve e a fila espera por ele (até MAX_AGENT_TRIES).
  const fix = async (reason: string) => {
    if (steps.handoff && (item.agentTries ?? 0) < MAX_AGENT_TRIES && (await steps.handoff(item, reason))) {
      item.status = 'agent';
      item.reason = reason;
      item.agentTries = (item.agentTries ?? 0) + 1;
      return item;
    }
    return fail(reason);
  };
  const sync = await steps.syncTarget(item);
  if (sync) return fix(sync);
  if (!(await steps.checks(item))) return fix(t('checks failed'));
  if (steps.requiresPr(item)) {
    item.status = 'awaiting-pr';
    item.reason = t('{0} requires a PR/MR: the queue waits for it to be merged', item.target);
    return item;
  }
  const merged = await steps.merge(item);
  if (merged) return fail(merged);
  if (steps.pushTarget) await steps.pushTarget(item);
  item.status = 'done';
  item.finished = now;
  return item;
}

/**
 * O agente com o item da `branch` terminou: se deixou commits, o item volta para a fila na mesma
 * posição (é o próximo a ser tentado); se parou sem resolver, sai da fila. Devolve o item, se havia.
 */
export function agentFinished(items: MergeItem[], branch: string, ready: boolean, now = Date.now()): MergeItem | undefined {
  const item = items.find(i => i.branch === branch && i.status === 'agent');
  if (!item) return undefined;
  if (ready) {
    item.status = 'waiting';
  } else {
    item.status = 'failed';
    item.reason = t('the agent stopped without resolving: {0}', item.reason ?? '');
    item.finished = now;
  }
  return item;
}

/** Item esperando PR/MR que já entrou no destino (a branch deixou de ter commits fora dele). */
export function resolveAwaiting(items: MergeItem[], isMerged: (i: MergeItem) => boolean, now = Date.now()): boolean {
  let changed = false;
  for (const i of items) {
    if (i.status === 'awaiting-pr' && isMerged(i)) {
      i.status = 'done';
      i.reason = undefined;
      i.finished = now;
      changed = true;
    }
  }
  return changed;
}

// ---------- tarefa em lote ----------

/** Quem abre agora e quem espera, respeitando o limite de agentes simultâneos. */
export function batchPlan<T>(targets: T[], maxParallel: number, running = 0): { now: T[]; later: T[] } {
  const free = Math.max(0, Math.floor(maxParallel) - running);
  return { now: targets.slice(0, free), later: targets.slice(free) };
}

// ---------- orçamento ----------

export interface BudgetLimits {
  tokens?: number;
  usd?: number;
}

export interface BudgetLevel {
  /** Fração do limite mais apertado (0..∞). */
  ratio: number;
  level: 'ok' | 'warn' | 'over';
  /** Qual limite pesou: tokens ou US$. */
  by?: 'tokens' | 'usd';
}

export function budgetLevel(used: { tokens?: number; usd?: number } | undefined, limits: BudgetLimits): BudgetLevel {
  const r: { ratio: number; by: 'tokens' | 'usd' }[] = [];
  if (limits.tokens && limits.tokens > 0 && used?.tokens != null) r.push({ ratio: used.tokens / limits.tokens, by: 'tokens' });
  if (limits.usd && limits.usd > 0 && used?.usd != null) r.push({ ratio: used.usd / limits.usd, by: 'usd' });
  if (!r.length) return { ratio: 0, level: 'ok' };
  const worst = r.sort((a, b) => b.ratio - a.ratio)[0];
  return { ratio: worst.ratio, by: worst.by, level: worst.ratio >= 1 ? 'over' : worst.ratio >= 0.8 ? 'warn' : 'ok' };
}
