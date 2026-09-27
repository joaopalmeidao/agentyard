/**
 * Atividade num período (hoje, ontem, 7 dias) e custo por tarefa: cruza commits do git com as
 * sessões do Claude Code. Sem dependência do VS Code (test/suite.js e testes unitários usam direto).
 */
import type { Repo } from './git';
import type { SessionInfo, TokenUsage } from './claude/sessions';

export type RangeId = 'today' | 'yesterday' | 'week';

export interface Range {
  id: RangeId;
  from: number;
  to: number;
  /** Buckets do gráfico: por hora (um dia) ou por dia (semana). */
  unit: 'hour' | 'day';
  label: string;
}

export function rangeOf(id: RangeId, now = Date.now()): Range {
  const d = new Date(now);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (id === 'yesterday') return { id, from: midnight - 86_400_000, to: midnight, unit: 'hour', label: 'ontem' };
  if (id === 'week') return { id, from: midnight - 6 * 86_400_000, to: now, unit: 'day', label: 'últimos 7 dias' };
  return { id: 'today', from: midnight, to: now, unit: 'hour', label: 'hoje' };
}

export interface CommitInfo {
  sha: string;
  branch: string;
  author: string;
  date: number;
  subject: string;
  files: { path: string; added: number; deleted: number }[];
}

/**
 * Commits das branches locais no período, num processo só. `--source` diz por qual branch cada
 * commit foi alcançado (um commit em várias branches conta para a primeira).
 */
export async function commitsIn(repo: Repo, from: number, to: number): Promise<CommitInfo[]> {
  const r = await repo.run([
    'log',
    '--branches',
    '--source',
    '--no-merges',
    `--since=${new Date(from).toISOString()}`,
    `--until=${new Date(to).toISOString()}`,
    '--format=%x1e%H%x1f%S%x1f%an%x1f%at%x1f%s',
    '--numstat',
    '--no-renames',
  ]);
  if (r.code !== 0) return [];
  return parseCommitLog(r.stdout);
}

export function parseCommitLog(out: string): CommitInfo[] {
  const list: CommitInfo[] = [];
  for (const rec of out.split('\x1e')) {
    const lines = rec.split(/\r?\n/);
    const head = lines.shift();
    if (!head || !head.includes('\x1f')) continue;
    const [sha, source, author, date, subject] = head.split('\x1f');
    const files = lines
      .filter(l => /^(\d+|-)\t(\d+|-)\t/.test(l))
      .map(l => {
        const [a, d, ...p] = l.split('\t');
        return { path: p.join('\t'), added: a === '-' ? 0 : Number(a), deleted: d === '-' ? 0 : Number(d) };
      });
    list.push({ sha, branch: source.replace(/^refs\/heads\//, ''), author, date: Number(date) * 1000, subject, files });
  }
  return list;
}

export interface Prices {
  /** US$ por milhão de tokens. Zero em todos = sem estimativa de custo. */
  input: number;
  output: number;
  cacheRead: number;
}

/** Criação de cache é cobrada como entrada nesta estimativa. */
export function costOf(u: TokenUsage, p: Prices): number {
  return ((u.input + u.cacheCreate) * p.input + u.output * p.output + u.cacheRead * p.cacheRead) / 1e6;
}

export const hasPrices = (p: Prices) => p.input > 0 || p.output > 0 || p.cacheRead > 0;

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheCreate: a.cacheCreate + b.cacheCreate };
}

const zero = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
const weightedOf = (u: TokenUsage) => u.input + u.cacheCreate + u.output;
const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Branch de uma sessão: pela worktree em que rodou; senão, pelo gitBranch gravado no log. */
export function branchOfSession(s: SessionInfo, worktrees: { path: string; branch?: string }[]): string | undefined {
  if (s.cwd) {
    const c = norm(s.cwd);
    const wt = worktrees
      .filter(w => w.branch && (c === norm(w.path) || c.startsWith(norm(w.path) + '/')))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (wt) return wt.branch;
  }
  return s.gitBranch || undefined;
}

/** Tokens (ponderados) de uma sessão dentro do período, pelos eventos; sem eventos, pelos totais diários. */
function tokensInRange(s: SessionInfo, r: Range): { total: number; buckets: Map<number, number> } {
  const buckets = new Map<number, number>();
  let total = 0;
  const bucketOf = (ms: number) => (r.unit === 'hour' ? new Date(ms).getHours() : Math.floor((ms - r.from) / 86_400_000));
  if (s.events?.length) {
    for (const [ms, t] of s.events) {
      if (ms < r.from || ms >= r.to) continue;
      total += t;
      buckets.set(bucketOf(ms), (buckets.get(bucketOf(ms)) ?? 0) + t);
    }
    return { total, buckets };
  }
  for (const [day, t] of Object.entries(s.daily ?? {})) {
    const [y, m, d] = day.split('-').map(Number);
    const ms = new Date(y, m - 1, d).getTime();
    if (ms + 86_400_000 <= r.from || ms >= r.to) continue;
    total += t;
    if (r.unit === 'day') buckets.set(bucketOf(Math.max(ms, r.from)), (buckets.get(bucketOf(Math.max(ms, r.from))) ?? 0) + t);
  }
  return { total, buckets };
}

export interface BranchActivity {
  branch: string;
  worktree?: string;
  commits: number;
  files: number;
  added: number;
  deleted: number;
  sessions: number;
  tokens: number;
  authors: string[];
}

export interface ActivityReport {
  range: Range;
  rows: BranchActivity[];
  /** Gráfico: um item por hora (0–23) ou por dia (0–6). */
  chart: { label: string; commits: number; tokens: number }[];
  totals: { commits: number; files: number; added: number; deleted: number; sessions: number; tokens: number };
}

export function buildActivity(
  range: Range,
  commits: CommitInfo[],
  sessions: SessionInfo[],
  worktrees: { path: string; branch?: string }[],
): ActivityReport {
  const rows = new Map<string, BranchActivity & { fileSet: Set<string> }>();
  const row = (b: string) => {
    let r = rows.get(b);
    if (!r) {
      const wt = worktrees.find(w => w.branch === b);
      r = { branch: b, worktree: wt?.path, commits: 0, files: 0, added: 0, deleted: 0, sessions: 0, tokens: 0, authors: [], fileSet: new Set() };
      rows.set(b, r);
    }
    return r;
  };
  const n = range.unit === 'hour' ? 24 : 7;
  const chart = Array.from({ length: n }, (_, i) => ({
    label: range.unit === 'hour' ? `${String(i).padStart(2, '0')}h` : new Date(range.from + i * 86_400_000).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit' }),
    commits: 0,
    tokens: 0,
  }));
  const bucketOf = (ms: number) => (range.unit === 'hour' ? new Date(ms).getHours() : Math.floor((ms - range.from) / 86_400_000));

  for (const c of commits) {
    if (c.date < range.from || c.date >= range.to) continue;
    const r = row(c.branch);
    r.commits++;
    for (const f of c.files) {
      r.fileSet.add(f.path);
      r.added += f.added;
      r.deleted += f.deleted;
    }
    if (!r.authors.includes(c.author)) r.authors.push(c.author);
    const b = bucketOf(c.date);
    if (chart[b]) chart[b].commits++;
  }

  for (const s of sessions) {
    const { total, buckets } = tokensInRange(s, range);
    if (!total) continue;
    const r = row(branchOfSession(s, worktrees) ?? '(fora de worktree)');
    r.sessions++;
    r.tokens += total;
    for (const [b, t] of buckets) if (chart[b]) chart[b].tokens += t;
  }

  const list = [...rows.values()]
    .map(({ fileSet, ...r }) => ({ ...r, files: fileSet.size }))
    .sort((a, b) => b.tokens - a.tokens || b.commits - a.commits);
  const totals = list.reduce(
    (t, r) => ({ commits: t.commits + r.commits, files: t.files + r.files, added: t.added + r.added, deleted: t.deleted + r.deleted, sessions: t.sessions + r.sessions, tokens: t.tokens + r.tokens }),
    { commits: 0, files: 0, added: 0, deleted: 0, sessions: 0, tokens: 0 },
  );
  return { range, rows: list, chart, totals };
}

export interface TaskCost {
  branch: string;
  /** Issue ou PR/MR ligado à branch, se houver. */
  task?: { key: string; title: string; url: string; kind: 'issue' | 'pr' };
  sessions: number;
  usage: TokenUsage;
  /** Tokens ponderados (entrada + criação de cache + saída). */
  tokens: number;
  /** Estimativa em US$ (só com preços configurados). */
  usd?: number;
}

/** Custo acumulado de cada branch (todas as sessões, não só o período), com a issue ou o PR/MR dela. */
export function costPerTask(
  sessions: SessionInfo[],
  worktrees: { path: string; branch?: string }[],
  links: (branch: string) => TaskCost['task'],
  prices: Prices,
): TaskCost[] {
  const by = new Map<string, TaskCost>();
  for (const s of sessions) {
    const b = branchOfSession(s, worktrees);
    if (!b) continue;
    const cur = by.get(b) ?? { branch: b, sessions: 0, usage: zero(), tokens: 0 };
    cur.sessions++;
    cur.usage = addUsage(cur.usage, s.usage);
    by.set(b, cur);
  }
  const out = [...by.values()].map(c => ({
    ...c,
    tokens: weightedOf(c.usage),
    task: links(c.branch),
    usd: hasPrices(prices) ? costOf(c.usage, prices) : undefined,
  }));
  return out.sort((a, b) => b.tokens - a.tokens);
}
