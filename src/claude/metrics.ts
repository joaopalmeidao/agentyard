/**
 * Relatório "Métricas das tarefas": por worktree, quanto o agente custou, quantos turnos levou e quanto
 * precisou de você. Sem VS Code (testado em test/claudeGuard.test.js).
 */

export interface TaskRow {
  name: string;
  tokens?: number;
  usd?: number;
  sessions?: number;
  turns: number;
  /** Turnos com checkpoint (arquivos/linhas por turno). */
  files?: number;
  additions?: number;
  deletions?: number;
  commits?: number;
  permissions: number;
  approvedInVsCode: number;
  deniedInVsCode: number;
  guardBlocks: number;
  plans: number;
  budgetBlocks: number;
  /** Situação: pronta para revisar, com PR, mesclada… */
  status?: string;
  since?: number;
}

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));

/** Intervenções manuais: pedidos de permissão que você respondeu e bloqueios que pararam o agente. */
export function interventions(r: TaskRow): number {
  return r.permissions + r.guardBlocks + r.budgetBlocks;
}

export function metricsReport(rows: TaskRow[], labels: { title: string; headers: string[]; totals: string; empty: string; note: string }, now = Date.now()): string {
  const lines = [`# ${labels.title}`, '', `_${new Date(now).toLocaleString()}_`, ''];
  if (!rows.length) return [...lines, labels.empty, ''].join('\n');
  lines.push(`| ${labels.headers.join(' | ')} |`, `|${labels.headers.map((_, i) => (i ? ' ---: ' : ' --- ')).join('|')}|`);
  const sorted = [...rows].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0) || (b.tokens ?? 0) - (a.tokens ?? 0));
  const tot = { tokens: 0, usd: 0, turns: 0, lines: 0, commits: 0, inter: 0 };
  for (const r of sorted) {
    const linesChanged = (r.additions ?? 0) + (r.deletions ?? 0);
    tot.tokens += r.tokens ?? 0;
    tot.usd += r.usd ?? 0;
    tot.turns += r.turns;
    tot.lines += linesChanged;
    tot.commits += r.commits ?? 0;
    tot.inter += interventions(r);
    const perTurn = r.turns && r.tokens ? fmt(r.tokens / r.turns) : '–';
    lines.push(
      `| ${r.name}${r.status ? ` (${r.status})` : ''} | ${r.tokens ? fmt(r.tokens) : '–'} | ${r.usd ? `$${r.usd.toFixed(2)}` : '–'} | ${r.turns} | ${perTurn} | ${linesChanged ? `+${r.additions ?? 0} −${r.deletions ?? 0}` : '–'} | ${r.commits ?? 0} | ${interventions(r)} (${r.approvedInVsCode}✓ ${r.deniedInVsCode}✗ · ${r.guardBlocks}⛔) | ${r.plans} |`,
    );
  }
  lines.push(
    `| **${labels.totals}** | **${fmt(tot.tokens)}** | **$${tot.usd.toFixed(2)}** | **${tot.turns}** | ${tot.turns && tot.tokens ? fmt(tot.tokens / tot.turns) : '–'} | ${tot.lines} | **${tot.commits}** | **${tot.inter}** | |`,
    '',
    labels.note,
    '',
  );
  return lines.join('\n');
}
