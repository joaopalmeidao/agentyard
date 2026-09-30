/**
 * Coordenação de vários agentes: regras puras (sem VS Code) para sobreposição de arquivos, tarefa
 * em lote e orçamento. Testadas em test/coord.test.js.
 */

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

/** Chave do par (para avisar uma vez por par; arquivos novos em comum não avisam de novo). */
export const overlapKey = (o: Overlap) => `${o.a}|${o.b}`;

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
