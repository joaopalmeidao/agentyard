/**
 * Mapa de promoção entre ambientes (dev → QA → homologação → produção).
 *
 * Duas leituras do mesmo fluxo:
 * - por etapa: o que está num ambiente e falta no seguinte (e o contrário, hotfix), agrupado por
 *   feature — pelo merge que a trouxe (GitHub, GitLab, Bitbucket, merge local) ou pela branch viva;
 * - por branch: em quais ambientes cada branch já está inteira, e até onde ela chegou.
 *
 * Sem dependência do VS Code: test/promotion.test.js usa direto, contra repositórios de verdade.
 */
import type { Repo } from '../git';
import { parseMergeMessage } from '../delivery/core';

export interface Stage {
  branch: string;
  label: string;
  /** Ref usada na comparação ("qa" ou "origin/qa"); vazia se a branch não existe em lugar nenhum. */
  ref: string;
  sha: string;
  date: number;
  /** Local e remoto divergem: [commits só no local, commits só no remoto]. */
  drift?: [number, number];
}

export interface Candidate {
  name: string;
  /** Ref para o git: "feat/x" ou "origin/feat/x". */
  ref: string;
  sha: string;
  date: number;
  subject: string;
  /** Só existe no remoto. */
  remoteOnly: boolean;
}

export interface RawCommit {
  sha: string;
  parents: string[];
  author: string;
  /** ms */
  date: number;
  subject: string;
  body: string;
}

export interface ChangeGroup {
  /** merge: veio por um commit de merge; branch: alcançado pela ponta de uma branch viva; direct: commit solto. */
  kind: 'merge' | 'branch' | 'direct';
  branch?: string;
  /** "#12", "!5". */
  ref?: string;
  title?: string;
  /** Commits (sem os de merge), do mais novo ao mais antigo. */
  commits: RawCommit[];
  date: number;
  authors: string[];
  /** A branch ainda existe (local ou remota). */
  live: boolean;
}

export interface StepView {
  from: Stage;
  to: Stage;
  /** Em `from` e fora de `to`: esperando promoção. */
  forward: ChangeGroup[];
  /** Em `to` e fora de `from`: hotfix ou back-merge pendente. */
  backward: ChangeGroup[];
  forwardCount: number;
  backwardCount: number;
  /** A leitura parou no limite de commits. */
  truncated: boolean;
}

export interface MatrixRow {
  name: string;
  ref: string;
  sha: string;
  date: number;
  subject: string;
  remoteOnly: boolean;
  /** Por estágio: commits da branch que ainda não estão lá (0 = inteira); undefined = estágio inexistente. */
  missing: (number | undefined)[];
  /** Quantos estágios seguidos, a partir do primeiro, já têm a branch inteira. */
  reached: number;
  /** Estágios à frente de `reached` que já têm a branch (pulou etapa). */
  ahead: number[];
  /** A ponta está na linha principal de um ambiente: branch criada dali, sem commits próprios (ou merge fast-forward). */
  noOwnCommits: boolean;
}

export interface PromotionMap {
  stages: Stage[];
  steps: StepView[];
  rows: MatrixRow[];
  mode: 'local' | 'remote';
  remote: string;
}

const MAX_COMMITS = 3000;
const MAX_CANDIDATES = 400;

// ---------------------------------------------------------------------------------------------
// Leitura do log
// ---------------------------------------------------------------------------------------------

export const LOG_FORMAT = '--format=%x1e%H%x1f%P%x1f%an%x1f%at%x1f%s%x1f%b';

export function parseLog(out: string): RawCommit[] {
  const list: RawCommit[] = [];
  for (const rec of out.split('\x1e')) {
    if (!rec.includes('\x1f')) continue;
    const [sha, parents, author, at, subject, ...rest] = rec.replace(/^\r?\n/, '').split('\x1f');
    list.push({ sha: sha.trim(), parents: parents.trim() ? parents.trim().split(' ') : [], author, date: Number(at) * 1000, subject, body: rest.join('\x1f').trim() });
  }
  return list;
}

/** Branch de origem de um commit de merge: formatos do GitHub, GitLab, Bitbucket, Azure e merge local. */
export function mergeSource(subject: string, body: string): { branch?: string; ref?: string; title?: string } {
  const m = parseMergeMessage(subject, body);
  if (m.branch) return m;
  let r = /^Merged in (\S+) \(pull request #(\d+)\)/.exec(subject);
  if (r) return { branch: r[1], ref: `#${r[2]}`, title: body.split(/\r?\n/).find(l => l.trim())?.trim() };
  r = /^Merged PR (\d+): (.+)$/.exec(subject);
  if (r) return { ref: `!${r[1]}`, title: r[2] };
  r = /^Merge (?:branch |remote-tracking branch )?'?([^'\s]+)'? into /.exec(subject);
  if (r) return { branch: r[1] };
  r = /^Mescla (?:a branch )?'?([^'\s:]+)'?/.exec(subject);
  if (r) return { branch: r[1] };
  return {};
}

/** "origin/qa" e "remotes/origin/qa" contam como "qa". */
export function isStageName(name: string, stages: string[], remote = 'origin'): boolean {
  let n = name.replace(/^refs\//, '').replace(/^(heads|remotes)\//, '');
  if (n.startsWith(`${remote}/`)) n = n.slice(remote.length + 1);
  return stages.includes(n);
}

/** Commits alcançáveis a partir de `starts` sem sair de `set`. */
export function reachWithin(set: Map<string, { parents: string[] }>, starts: string[], skip?: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack = starts.filter(s => set.has(s));
  while (stack.length) {
    const sha = stack.pop()!;
    if (seen.has(sha) || skip?.has(sha)) continue;
    seen.add(sha);
    for (const p of set.get(sha)!.parents) if (set.has(p) && !seen.has(p)) stack.push(p);
  }
  return seen;
}

/**
 * Agrupa os commits de um intervalo (ex.: `dev --not qa`) por feature:
 * 1. merges de branches que não são de ambiente (o que a branch trouxe e o primeiro pai não tinha);
 * 2. o que sobrar e for alcançável por uma branch viva (merge fast-forward, branch ainda aberta);
 * 3. o resto são commits diretos no ambiente.
 * Merges de um ambiente em outro ("Merge dev into qa") não viram grupo: o conteúdo deles já cai nos itens acima.
 */
export function attribute(commits: RawCommit[], tips: { name: string; sha: string }[], stageNames: string[]): ChangeGroup[] {
  const set = new Map(commits.map(c => [c.sha, c]));
  const covered = new Set<string>();
  const groups = new Map<string, ChangeGroup>();
  const live = new Set(tips.map(t => t.name));
  const add = (key: string, init: Omit<ChangeGroup, 'commits' | 'date' | 'authors'>, shas: Iterable<string>) => {
    let g = groups.get(key);
    for (const s of shas) {
      const c = set.get(s)!;
      covered.add(s);
      if (c.parents.length > 1) continue;
      if (!g) groups.set(key, (g = { ...init, commits: [], date: 0, authors: [] }));
      if (!g.commits.includes(c)) g.commits.push(c);
    }
    if (g) {
      g.ref ??= init.ref;
      g.title ??= init.title;
    }
  };

  // 1. merges de feature, do mais antigo ao mais novo (o merge mais antigo leva os commits originais)
  const merges = commits.filter(c => c.parents.length > 1).sort((a, b) => a.date - b.date);
  for (const m of merges) {
    const src = mergeSource(m.subject, m.body);
    if (src.branch && isStageName(src.branch, stageNames)) continue;
    if (!src.branch && !src.ref) continue;
    const firstSide = reachWithin(set, [m.parents[0]]);
    const own = [...reachWithin(set, m.parents.slice(1), firstSide)].filter(s => !covered.has(s));
    const name = src.branch?.replace(/^origin\//, '');
    covered.add(m.sha);
    add(name ? `b:${name}` : `r:${src.ref}`, { kind: 'merge', branch: name, ref: src.ref, title: src.title, live: !!name && live.has(name) }, own);
  }

  // 2. branches vivas: as que alcançam menos commits primeiro (uma branch aberta a partir de outra fica só com o que é dela)
  const reach = tips
    .filter(t => set.has(t.sha) && !isStageName(t.name, stageNames))
    .map(t => ({ t, r: [...reachWithin(set, [t.sha], covered)] }))
    .sort((a, b) => a.r.length - b.r.length);
  for (const { t, r } of reach) {
    const own = r.filter(s => !covered.has(s));
    if (own.length) add(`b:${t.name}`, { kind: 'branch', branch: t.name, live: true }, own);
  }

  // 3. commits diretos
  const direct = commits.filter(c => !covered.has(c.sha) && c.parents.length < 2);
  if (direct.length) add('direct', { kind: 'direct', live: false }, direct.map(c => c.sha));

  for (const g of groups.values()) {
    g.commits.sort((a, b) => b.date - a.date);
    g.date = g.commits[0]?.date ?? 0;
    g.authors = [...new Set(g.commits.map(c => c.author))];
  }
  return [...groups.values()].filter(g => g.commits.length).sort((a, b) => Number(a.kind === 'direct') - Number(b.kind === 'direct') || b.date - a.date);
}

/** Estágios consecutivos já com a branch inteira, e os que ela pulou. Estágio inexistente não conta nem trava. */
export function classify(missing: (number | undefined)[]): { reached: number; ahead: number[] } {
  let reached = 0;
  while (reached < missing.length && (missing[reached] === 0 || missing[reached] === undefined)) reached++;
  const ahead: number[] = [];
  for (let i = reached + 1; i < missing.length; i++) if (missing[i] === 0) ahead.push(i);
  return { reached, ahead };
}

// ---------------------------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------------------------

interface RefInfo {
  name: string;
  kind: 'head' | 'remote';
  sha: string;
  date: number;
  subject: string;
}

async function readRefs(repo: Repo): Promise<RefInfo[]> {
  const r = await repo.run(['for-each-ref', '--format=%(refname)%1f%(objectname)%1f%(committerdate:unix)%1f%(contents:subject)', 'refs/heads', 'refs/remotes']);
  if (r.code !== 0) return [];
  const out: RefInfo[] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const [full, sha, date, subject] = line.split('\x1f');
    if (full.endsWith('/HEAD')) continue;
    const head = full.startsWith('refs/heads/');
    out.push({ name: full.slice(head ? 11 : 13), kind: head ? 'head' : 'remote', sha, date: Number(date) * 1000, subject: subject ?? '' });
  }
  return out;
}

/** Nomes de branch conhecidos (locais e do remoto, sem o prefixo), para o assistente do fluxo. */
export async function branchNames(repo: Repo, remote: string): Promise<string[]> {
  const refs = await readRefs(repo);
  const names = refs.map(r => (r.kind === 'head' ? r.name : r.name.startsWith(`${remote}/`) ? r.name.slice(remote.length + 1) : '')).filter(Boolean);
  return [...new Set(names)];
}

/** Modo "remote" usa `origin/<estágio>` quando existe (o que está publicado); "local", a branch local. */
export async function resolveStages(repo: Repo, stages: { branch: string; label: string }[], mode: 'local' | 'remote', remote: string, refs?: RefInfo[]): Promise<Stage[]> {
  refs ??= await readRefs(repo);
  const find = (kind: 'head' | 'remote', name: string) => refs!.find(r => r.kind === kind && r.name === name);
  const out: Stage[] = [];
  for (const s of stages) {
    const local = find('head', s.branch);
    const rem = find('remote', `${remote}/${s.branch}`);
    const pick = mode === 'remote' ? rem ?? local : local ?? rem;
    const st: Stage = { ...s, ref: pick ? (pick.kind === 'head' ? pick.name : `refs/remotes/${pick.name}`) : '', sha: pick?.sha ?? '', date: pick?.date ?? 0 };
    if (local && rem && local.sha !== rem.sha) st.drift = await repo.aheadBehind(local.name, `refs/remotes/${rem.name}`);
    out.push(st);
  }
  return out;
}

/** Branches que não são de ambiente: as locais e as do remoto sem cópia local. */
export function candidatesOf(refs: RefInfo[], stageNames: string[], remote: string): Candidate[] {
  const local = new Set(refs.filter(r => r.kind === 'head').map(r => r.name));
  const out: Candidate[] = [];
  for (const r of refs) {
    if (r.kind === 'head') {
      if (!isStageName(r.name, stageNames)) out.push({ name: r.name, ref: r.name, sha: r.sha, date: r.date, subject: r.subject, remoteOnly: false });
      continue;
    }
    if (!r.name.startsWith(`${remote}/`)) continue;
    const name = r.name.slice(remote.length + 1);
    if (local.has(name) || isStageName(name, stageNames)) continue;
    out.push({ name, ref: `refs/remotes/${r.name}`, sha: r.sha, date: r.date, subject: r.subject, remoteOnly: true });
  }
  return out.sort((a, b) => b.date - a.date).slice(0, MAX_CANDIDATES);
}

async function step(repo: Repo, from: Stage, to: Stage, tips: { name: string; sha: string }[], stageNames: string[]): Promise<StepView> {
  const view: StepView = { from, to, forward: [], backward: [], forwardCount: 0, backwardCount: 0, truncated: false };
  if (!from.ref || !to.ref) return view;
  const read = async (a: string, b: string) => {
    const r = await repo.run(['log', `-n${MAX_COMMITS}`, LOG_FORMAT, a, '--not', b, '--']);
    return r.code === 0 ? parseLog(r.stdout) : [];
  };
  const mainline = async (a: string, b: string) => {
    const r = await repo.run(['rev-list', '--first-parent', `-n${MAX_COMMITS}`, a, '--not', b, '--']);
    return new Set(r.code === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : []);
  };
  const [fw, bw, fwLine, bwLine] = await Promise.all([read(from.ref, to.ref), read(to.ref, from.ref), mainline(from.ref, to.ref), mainline(to.ref, from.ref)]);
  // Ponta na linha principal do ambiente = branch criada dali sem commits próprios: não "rouba" os commits diretos.
  const tipsOff = (line: Set<string>) => tips.filter(t => !line.has(t.sha));
  view.truncated = fw.length >= MAX_COMMITS || bw.length >= MAX_COMMITS;
  view.forward = attribute(fw, tipsOff(fwLine), stageNames);
  view.backward = attribute(bw, tipsOff(bwLine), stageNames);
  view.forwardCount = fw.filter(c => c.parents.length < 2).length;
  view.backwardCount = bw.filter(c => c.parents.length < 2).length;
  return view;
}

/**
 * Para cada estágio: um `rev-list` com tudo o que as branches têm e o estágio não, e a linha principal
 * do estágio. A contagem por branch sai em memória, sem um processo git por par branch × estágio.
 */
async function matrix(repo: Repo, stages: Stage[], cands: Candidate[]): Promise<MatrixRow[]> {
  if (!cands.length) return [];
  const refs = cands.map(c => c.ref);
  const perStage = await Promise.all(
    stages.map(async s => {
      if (!s.ref) return undefined;
      const [out, fp] = await Promise.all([
        repo.run(['rev-list', '--parents', ...refs, '--not', s.ref, '--']),
        repo.run(['rev-list', '--first-parent', '-n2000', s.ref, '--']),
      ]);
      const set = new Map<string, { parents: string[] }>();
      if (out.code === 0)
        for (const line of out.stdout.split(/\r?\n/)) {
          const [sha, ...parents] = line.trim().split(' ');
          if (sha) set.set(sha, { parents });
        }
      return { set, mainline: new Set(fp.code === 0 ? fp.stdout.split(/\r?\n/).filter(Boolean) : []) };
    }),
  );
  return cands.map(c => {
    const missing = perStage.map(p => {
      if (!p) return undefined;
      let n = 0;
      for (const s of reachWithin(p.set, [c.sha])) if (p.set.get(s)!.parents.length < 2) n++;
      return n;
    });
    const noOwnCommits = perStage.some(p => p?.mainline.has(c.sha));
    return { name: c.name, ref: c.ref, sha: c.sha, date: c.date, subject: c.subject, remoteOnly: c.remoteOnly, missing, noOwnCommits, ...classify(missing) };
  });
}

export async function computePromotion(repo: Repo, flow: { branch: string; label: string }[], mode: 'local' | 'remote', remote: string): Promise<PromotionMap> {
  const refs = await readRefs(repo);
  const names = flow.map(s => s.branch);
  const stages = await resolveStages(repo, flow, mode, remote, refs);
  const cands = candidatesOf(refs, names, remote);
  const tips = cands.map(c => ({ name: c.name, sha: c.sha }));
  const [steps, rows] = await Promise.all([
    Promise.all(stages.slice(0, -1).map((s, i) => step(repo, s, stages[i + 1], tips, names))),
    matrix(repo, stages, cands),
  ]);
  return { stages, steps, rows, mode, remote };
}
