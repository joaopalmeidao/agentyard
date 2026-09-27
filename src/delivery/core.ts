/**
 * Linha do tempo das branches, relatório do dia e preparação de versão (changelog + tag).
 * Sem dependência do VS Code: test/delivery.test.js usa direto.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Repo } from '../git';

// ---------------------------------------------------------------------------------------------
// Linha do tempo
// ---------------------------------------------------------------------------------------------

export interface TimelineRow {
  branch: string;
  /** Tem worktree agora. */
  worktree: boolean;
  /** Nascimento: criação da branch (reflog), senão o primeiro commit fora da base. */
  born?: number;
  /** Datas (ms) dos commits fora da base. */
  commits: number[];
  worktreeCreated?: number;
  prOpened?: number;
  prRef?: string;
  prUrl?: string;
  prState?: string;
  approved?: boolean;
  /** Merge na base (commit de merge no first-parent da base). */
  merged?: number;
  /** Última atividade conhecida. */
  last: number;
}

/**
 * `git log --branches --not <base> --source --no-merges --format=%x1e%S%x1f%at`: uma linha por commit,
 * com a branch que o alcançou. Devolve as datas (ms) por branch.
 */
export function parseSourceLog(out: string): Map<string, number[]> {
  const byBranch = new Map<string, number[]>();
  for (const rec of out.split('\x1e')) {
    const line = rec.trim();
    if (!line.includes('\x1f')) continue;
    const [src, at] = line.split('\x1f');
    const b = src.replace(/^refs\/heads\//, '');
    const list = byBranch.get(b) ?? [];
    list.push(Number(at) * 1000);
    byBranch.set(b, list);
  }
  return byBranch;
}

export interface MergeInfo {
  sha: string;
  date: number;
  subject: string;
  body: string;
  /** Segundo pai (a ponta da branch mesclada). */
  tip?: string;
  /** Nome da branch tirado da mensagem (GitHub, GitLab, merge local). */
  branch?: string;
  /** Título do PR/MR quando a mensagem traz (GitHub: 1ª linha do corpo; GitLab: parágrafo do título). */
  title?: string;
  /** "#12" / "!5" quando a mensagem traz. */
  ref?: string;
}

/** Nome da branch, título e número do PR/MR a partir de uma mensagem de merge. */
export function parseMergeMessage(subject: string, body: string): Pick<MergeInfo, 'branch' | 'title' | 'ref'> {
  let m = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)/.exec(subject);
  if (m) return { branch: m[2], ref: `#${m[1]}`, title: body.split(/\r?\n/).find(l => l.trim())?.trim() };
  m = /^Merge branch '([^']+)' into '[^']+'/.exec(subject);
  if (m) {
    const paras = body.split(/\r?\n\r?\n/).map(p => p.trim()).filter(Boolean);
    const mr = /See merge request \S+!(\d+)/.exec(body);
    const title = paras.find(p => !/^See merge request/.test(p) && !/^(Closes|Refs|Fixes) /i.test(p));
    return { branch: m[1], ref: mr ? `!${mr[1]}` : undefined, title };
  }
  m = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(subject);
  if (m) return { branch: m[1].replace(/^origin\//, '') };
  return {};
}

/** `git log --merges --first-parent <base> --format=%x1e%H%x1f%at%x1f%P%x1f%s%x1f%b` */
export function parseMergeLog(out: string): MergeInfo[] {
  const list: MergeInfo[] = [];
  for (const rec of out.split('\x1e')) {
    if (!rec.includes('\x1f')) continue;
    const [sha, at, parents, subject, ...rest] = rec.replace(/^\r?\n/, '').split('\x1f');
    const body = rest.join('\x1f').trim();
    const p = parents.trim().split(' ');
    list.push({ sha, date: Number(at) * 1000, subject, body, tip: p[1], ...parseMergeMessage(subject, body) });
  }
  return list;
}

/** Criação da branch pelo reflog (.git/logs/refs/heads/<b>), sem processo git. */
export function branchCreatedAt(commonDir: string, branch: string): number | undefined {
  try {
    const first = fs.readFileSync(path.join(commonDir, 'logs', 'refs', 'heads', ...branch.split('/')), 'utf8').split(/\r?\n/)[0];
    const m = /\s(\d{9,})\s[+-]\d{4}\t/.exec(first);
    return m ? Number(m[1]) * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export interface TimelineInput {
  now: number;
  from: number;
  branches: { name: string; worktree: boolean; date: number; worktreeCreated?: number; created?: number; head?: string }[];
  commits: Map<string, number[]>;
  merges: MergeInfo[];
  requests: { source: string; ref: string; url: string; state: string; createdAt?: number; mergedAt?: number; approved?: boolean }[];
}

/** Monta as linhas da linha do tempo; só entram branches com algo dentro do período. */
export function buildTimeline(i: TimelineInput): TimelineRow[] {
  const mergeOf = new Map<string, MergeInfo>();
  const tips = new Map(i.branches.filter(b => b.head).map(b => [b.head!, b.name]));
  for (const m of i.merges) {
    const name = (m.tip && tips.get(m.tip)) || m.branch;
    if (name && !mergeOf.has(name)) mergeOf.set(name, m);
  }
  const reqOf = new Map(i.requests.map(r => [r.source, r]));
  const rows: TimelineRow[] = [];
  const names = new Set([...i.branches.map(b => b.name), ...mergeOf.keys()]);
  for (const name of names) {
    const b = i.branches.find(x => x.name === name);
    const commits = (i.commits.get(name) ?? []).slice().sort((x, y) => x - y);
    const merge = mergeOf.get(name);
    const req = reqOf.get(name);
    const born = b?.created ?? commits[0] ?? b?.worktreeCreated;
    const events = [born, ...commits, b?.worktreeCreated, req?.createdAt, req?.mergedAt, merge?.date, b?.date].filter((x): x is number => !!x);
    if (!events.length) continue;
    const last = Math.max(...events);
    if (last < i.from) continue;
    rows.push({
      branch: name,
      worktree: !!b?.worktree,
      born,
      commits,
      worktreeCreated: b?.worktreeCreated,
      prOpened: req?.createdAt,
      prRef: req?.ref ?? merge?.ref,
      prUrl: req?.url,
      prState: req?.state ?? (merge ? 'merged' : undefined),
      approved: req?.approved,
      merged: req?.mergedAt ?? merge?.date,
      last,
    });
  }
  return rows.sort((a, b) => b.last - a.last);
}

// ---------------------------------------------------------------------------------------------
// Relatório do dia
// ---------------------------------------------------------------------------------------------

export interface ReportBranch {
  branch: string;
  worktree?: string;
  commits: { subject: string; sha: string }[];
  files: number;
  added: number;
  deleted: number;
  tokens: number;
  sessions: number;
  usd?: number;
  request?: { ref: string; title: string; url: string; state: string };
  issue?: { key: string; title: string; url: string };
  pipelines: { name: string; status: string; url: string }[];
}

export interface ReportInput {
  title: string;
  repo: string;
  base: string;
  generatedAt: number;
  branches: ReportBranch[];
  merged: { branch?: string; title?: string; ref?: string; date: number }[];
  failedPipelines: { name: string; branch: string; url: string }[];
  passedPipelines: number;
  totals: { commits: number; files: number; added: number; deleted: number; tokens: number; sessions: number; usd?: number };
}

const fmtTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** Markdown do relatório: resumo no topo, depois uma seção por branch com atividade. */
export function renderReport(r: ReportInput): string {
  const t = r.totals;
  const active = r.branches.filter(b => b.commits.length || b.tokens);
  const out: string[] = [];
  out.push(`# ${r.title} — ${r.repo}`, '');
  out.push(`_Gerado pelo AgentYard em ${new Date(r.generatedAt).toLocaleString('pt-BR')}. Base: \`${r.base}\`._`, '');
  out.push('## Resumo', '');
  out.push(`- **${t.commits}** commit(s) em **${active.filter(b => b.commits.length).length}** branch(es); ${t.files} arquivo(s), +${t.added} −${t.deleted}.`);
  if (r.merged.length) out.push(`- **${r.merged.length}** mesclada(s) em \`${r.base}\`: ${r.merged.map(m => `${m.ref ? `${m.ref} ` : ''}${m.title ?? m.branch ?? ''}`.trim()).join('; ')}.`);
  if (t.tokens) out.push(`- Claude: ${t.sessions} sessão(ões), ${fmtTok(t.tokens)} tokens${t.usd !== undefined ? ` (≈ US$ ${t.usd.toFixed(2)}, estimativa)` : ''}.`);
  if (r.failedPipelines.length || r.passedPipelines)
    out.push(`- Pipelines: ${r.passedPipelines} passaram, ${r.failedPipelines.length} falharam${r.failedPipelines.length ? ` (${r.failedPipelines.map(p => `[${p.name} · ${p.branch}](${p.url})`).join(', ')})` : ''}.`);
  const open = r.branches.filter(b => b.request && (b.request.state === 'open' || b.request.state === 'draft'));
  if (open.length) out.push(`- PRs/MRs abertos: ${open.map(b => `[${b.request!.ref}](${b.request!.url}) ${b.request!.title}`).join('; ')}.`);
  out.push('');
  if (!active.length) {
    out.push('_Nenhuma atividade no período._', '');
    return out.join('\n');
  }
  out.push('## Por branch', '');
  for (const b of active) {
    out.push(`### \`${b.branch}\`${b.worktree ? ' · worktree' : ''}`, '');
    const meta: string[] = [];
    if (b.commits.length) meta.push(`${b.commits.length} commit(s), ${b.files} arquivo(s), +${b.added} −${b.deleted}`);
    if (b.tokens) meta.push(`${fmtTok(b.tokens)} tokens em ${b.sessions} sessão(ões)${b.usd !== undefined ? ` (≈ US$ ${b.usd.toFixed(2)})` : ''}`);
    if (b.request) meta.push(`${b.request.state === 'merged' ? 'mesclado' : b.request.state}: [${b.request.ref}](${b.request.url})`);
    if (b.issue) meta.push(`issue [${b.issue.key}](${b.issue.url}) ${b.issue.title}`);
    for (const p of b.pipelines) meta.push(`pipeline ${p.status === 'success' ? '✓' : p.status === 'failed' ? '✗' : p.status} [${p.name}](${p.url})`);
    out.push(...meta.map(m => `- ${m}`));
    if (b.commits.length) {
      out.push('', ...b.commits.map(c => `  - ${c.subject} (\`${c.sha.slice(0, 7)}\`)`));
    }
    out.push('');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Changelog e versão
// ---------------------------------------------------------------------------------------------

export interface ChangeEntry {
  /** Tipo convencional (feat, fix, …) ou "other". */
  type: string;
  scope?: string;
  breaking: boolean;
  text: string;
  /** "#12" / "!5" quando veio de PR/MR. */
  ref?: string;
  sha?: string;
}

const SECTIONS: [string, string][] = [
  ['breaking', 'Mudanças incompatíveis'],
  ['feat', 'Novidades'],
  ['fix', 'Correções'],
  ['perf', 'Desempenho'],
  ['refactor', 'Refatoração'],
  ['docs', 'Documentação'],
  ['test', 'Testes'],
  ['build', 'Build e CI'],
  ['ci', 'Build e CI'],
  ['chore', 'Manutenção'],
  ['style', 'Manutenção'],
  ['other', 'Outras mudanças'],
];

/** "feat(auth)!: login OAuth" → { type: 'feat', scope: 'auth', breaking: true, text: 'login OAuth' } */
export function parseConventional(subject: string, body = ''): ChangeEntry {
  const m = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(subject.trim());
  const breaking = /BREAKING[ -]CHANGE/.test(body) || /BREAKING[ -]CHANGE/.test(subject);
  if (m && SECTIONS.some(([k]) => k === m[1].toLowerCase())) {
    return { type: m[1].toLowerCase(), scope: m[2], breaking: breaking || !!m[3], text: m[4].trim() };
  }
  return { type: 'other', breaking, text: subject.trim() };
}

/** Entradas agrupadas por seção, na ordem de SECTIONS (seções iguais, como build/ci, se juntam). */
export function groupEntries(entries: ChangeEntry[]): { title: string; entries: ChangeEntry[] }[] {
  const groups = new Map<string, ChangeEntry[]>();
  for (const e of entries) {
    const key = e.breaking ? 'breaking' : e.type;
    const title = (SECTIONS.find(([k]) => k === key) ?? SECTIONS[SECTIONS.length - 1])[1];
    const list = groups.get(title) ?? [];
    list.push(e);
    groups.set(title, list);
  }
  const order = [...new Set(SECTIONS.map(([, t]) => t))];
  return order.filter(t => groups.has(t)).map(title => ({ title, entries: groups.get(title)! }));
}

/** "v1.1" / "1.1.0" / "release-2.3.4" → [1,1,0]; sem tag → [0,0,0]. */
export function parseVersion(tag?: string): [number, number, number] {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(tag ?? '');
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : [0, 0, 0];
}

/** Semver: incompatível → major (ou minor antes de 1.0), feat → minor, resto → patch. */
export function suggestVersion(lastTag: string | undefined, entries: ChangeEntry[]): string {
  const [ma, mi, pa] = parseVersion(lastTag);
  if (entries.some(e => e.breaking)) return ma === 0 ? `0.${mi + 1}.0` : `${ma + 1}.0.0`;
  if (entries.some(e => e.type === 'feat')) return `${ma}.${mi + 1}.0`;
  return `${ma}.${mi}.${pa + 1}`;
}

/** Prefixo da tag seguindo o costume do repositório ("v1.2.0" ou "1.2.0"). */
export function tagName(version: string, lastTag?: string): string {
  return lastTag && !/^v/i.test(lastTag) && /^\d/.test(lastTag) ? version : `v${version}`;
}

export function renderChangelog(version: string, date: Date, entries: ChangeEntry[]): string {
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const out = [`## ${version} (${day})`, ''];
  for (const g of groupEntries(entries)) {
    out.push(`### ${g.title}`, '');
    for (const e of g.entries) out.push(`- ${e.scope ? `**${e.scope}:** ` : ''}${e.text}${e.ref ? ` (${e.ref})` : ''}`);
    out.push('');
  }
  if (!entries.length) out.push('_Sem mudanças registradas._', '');
  return out.join('\n');
}

/**
 * Coloca o bloco no topo do CHANGELOG sem apagar nada: logo depois do título "# …" (e do parágrafo
 * de apresentação, se houver), antes da primeira versão "## …".
 */
export function insertChangelog(existing: string, block: string): string {
  const b = block.trim() + '\n';
  if (!existing.trim()) return `# Changelog\n\n${b}`;
  const lines = existing.split(/\r?\n/);
  const firstVersion = lines.findIndex(l => /^## /.test(l));
  if (firstVersion >= 0) {
    return [...lines.slice(0, firstVersion), ...b.split('\n'), ...lines.slice(firstVersion)].join('\n');
  }
  const title = lines.findIndex(l => /^# /.test(l));
  if (title >= 0) return [...lines.slice(0, title + 1), '', ...b.split('\n'), ...lines.slice(title + 1)].join('\n');
  return `${b}\n${existing}`;
}

export interface ReleasePlan {
  lastTag?: string;
  base: string;
  entries: ChangeEntry[];
  version: string;
  tag: string;
  block: string;
}

/**
 * Da última tag até a base: merges no first-parent viram entradas com o título do PR/MR (quando a
 * mensagem traz); commits diretos na base viram entradas pela própria mensagem.
 */
export async function planRelease(repo: Repo, base: string, cwd = repo.root, titles: Map<string, string> = new Map()): Promise<ReleasePlan> {
  const d = await repo.run(['describe', '--tags', '--abbrev=0', base], cwd);
  const lastTag = d.code === 0 ? d.stdout.trim() : undefined;
  const range = lastTag ? `${lastTag}..${base}` : base;
  const out = await repo.exec(['log', '--first-parent', '--format=%x1e%H%x1f%P%x1f%s%x1f%b', range], cwd);
  const entries: ChangeEntry[] = [];
  for (const rec of out.split('\x1e')) {
    if (!rec.includes('\x1f')) continue;
    const [sha, parents, subject, ...rest] = rec.replace(/^\r?\n/, '').split('\x1f');
    const body = rest.join('\x1f').trim();
    if (parents.trim().split(' ').length > 1) {
      const m = parseMergeMessage(subject, body);
      const title = (m.branch && titles.get(m.branch)) || m.title || (m.branch ? m.branch : subject);
      const e = parseConventional(title, body);
      entries.push({ ...e, ref: m.ref, sha });
    } else {
      if (/^Vers[aã]o \d|^v?\d+\.\d+\.\d+$/.test(subject)) continue; // commits de versão anteriores
      entries.push({ ...parseConventional(subject, body), sha });
    }
  }
  entries.reverse();
  const version = suggestVersion(lastTag, entries);
  return { lastTag, base, entries, version, tag: tagName(version, lastTag), block: renderChangelog(version, new Date(), entries) };
}

/** Grava o bloco no CHANGELOG.md, faz o commit "Versão X" e cria a tag anotada, tudo local. */
export async function applyRelease(repo: Repo, cwd: string, version: string, tag: string, block: string): Promise<void> {
  const file = path.join(cwd, 'CHANGELOG.md');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.writeFileSync(file, insertChangelog(current, block));
  await repo.exec(['add', 'CHANGELOG.md'], cwd);
  await repo.exec(['commit', '-q', '-m', `Versão ${version}`], cwd);
  await repo.exec(['tag', '-a', tag, '-m', `Versão ${version}`], cwd);
}
