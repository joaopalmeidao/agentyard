import * as path from 'path';
import { Commit, MergePreview, parseTrack, pLimit, Ref, RemoteTrack, Repo, Worktree, WorktreeStatus } from './git';
import type { FlowStep } from './flow';
import type { ChangeRequest } from './hosting/core';

export type SyncKind =
  | 'uptodate'
  | 'merged'
  | 'behind'
  | 'waiting-dirty'
  | 'conflict'
  | 'testing'
  | 'test-failed'
  | 'paused'
  | 'remote'
  | 'error';

/** Onde o sync da base roda: só na extensão, só no GitHub Actions, dividido por branch publicada, ou ambos. */
export type SyncWhere = 'local' | 'github' | 'split' | 'both';

export interface SyncStatus {
  kind: SyncKind;
  message: string;
  at: number;
}

export interface WorktreeView extends Worktree {
  name: string;
  changes: number;
  operation?: string;
  /** Commits da branch que a base não tem. */
  ahead: number;
  /** Commits da base que a branch não tem. */
  behind: number;
  preview?: MergePreview;
  /** false enquanto o git status desta worktree ainda não rodou. */
  statusKnown: boolean;
  /** false enquanto ahead/behind e a previsão de conflito ainda não foram calculados. */
  compareKnown: boolean;
  upstream?: string;
  track?: string;
  /** Situação em relação ao remoto: publicada, commits a enviar/receber. */
  remote: RemoteTrack;
  subject: string;
  date: number;
  isCurrent: boolean;
  isBase: boolean;
  paused: boolean;
  sync?: SyncStatus;
  /** Agentes com terminal aberto nesta worktree. */
  agents: string[];
  favorite: boolean;
  /** Sessões do Claude Code cujo cwd está nesta worktree (preenchido em segundo plano). */
  claude?: { sessions: number; tokens: number; last: number; lastId: string; /** custo estimado em US$ (preços configurados) */ usd?: number };
  /** O agente terminou e deixou commits: "pronto para revisar" (src/agentFlow). */
  review?: { at: number; commits: number };
  /** Fila de tarefas do agente nesta worktree. */
  tasks?: { waiting: number; running?: string };
  /** PR/MR aberto desta branch. */
  request?: ChangeRequest;
}

export interface BranchView {
  name: string;
  sha: string;
  upstream?: string;
  track?: string;
  remote: RemoteTrack;
  ahead: number;
  behind: number;
  preview?: MergePreview;
  compareKnown: boolean;
  date: number;
  subject: string;
  isBase: boolean;
  request?: ChangeRequest;
}

export interface RefBadge {
  name: string;
  kind: 'head' | 'remote' | 'tag' | 'detached';
  worktree: boolean;
  current: boolean;
}

export interface GraphCommit extends Commit {
  refs: RefBadge[];
}

export interface GraphState {
  repoName: string;
  root: string;
  base: string;
  baseRef: string;
  baseSha: string;
  worktrees: WorktreeView[];
  branches: BranchView[];
  commits: GraphCommit[];
  autoSync: { enabled: boolean; mode: string; testCommand: string; owner: boolean; where: SyncWhere };
  /** Agentes configurados, na ordem das configurações (o primeiro é o do botão). */
  agentNames: string[];
  /** Quantas worktrees ainda faltam detalhar (status/comparação). 0 = tudo em dia. */
  pending: number;
  /** Fluxo de ambientes (dev → QA → homologação → produção), se configurado. */
  flow?: FlowStep[];
  /** Filtro do histórico: tudo, ou só o que ainda não entrou na base. */
  graphFilter: 'all' | 'unmerged';
  /** Branches locais com commits fora da base. */
  unmerged: string[];
  /** Branches protegidas (src/guards.ts): merge e push direto pedem confirmação ou PR/MR. */
  protectedBranches?: string[];
  /** Remoto reconhecido (GitHub/GitLab) e se há credencial. */
  hosting?: { kind: 'github' | 'gitlab'; label: 'PR' | 'MR'; host: string; connected: boolean; error?: string };
  /** Último pipeline (GitHub Actions/GitLab CI) de cada branch, se houver dados. */
  pipelines?: Record<string, { id: number; status: string; name: string; url: string; updatedAt: number }>;
  error?: string;
}

export interface BuildOptions {
  configuredBase: string;
  useRemoteBase: boolean;
  maxCommits: number;
  showRemotes: boolean;
  paused: string[];
  statuses: Map<string, SyncStatus>;
  autoSync: GraphState['autoSync'];
  agentNames?: string[];
  /** Caminho da worktree em minúsculas → agentes com terminal aberto. */
  agentsRunning?: Map<string, string[]>;
  /** Caminhos (minúsculos) das worktrees favoritas. */
  favorites?: Set<string>;
  graphFilter?: 'all' | 'unmerged';
}

export interface CompareResult {
  ahead: number;
  behind: number;
  preview?: MergePreview;
}

interface CachedStatus extends WorktreeStatus {
  at: number;
}

const key = (p: string) => path.normalize(p).toLowerCase();

/**
 * O que é caro de calcular. Comparações dependem só dos dois commits, então valem para sempre;
 * status envelhece e é refeito por prioridade (ver enrich).
 */
export class RepoCache {
  readonly compares = new Map<string, CompareResult>();
  readonly statuses = new Map<string, CachedStatus>();

  static compareKey(baseSha: string, sha: string) {
    return `${baseSha}..${sha}`;
  }

  exportCompares(max = 4000): [string, CompareResult][] {
    return [...this.compares].slice(-max);
  }

  importCompares(entries: [string, CompareResult][] | undefined) {
    for (const [k, v] of entries ?? []) this.compares.set(k, v);
  }
}

export async function resolveBase(repo: Repo, refs: Ref[], configured: string, useRemote: boolean) {
  const locals = refs.filter(r => r.kind === 'head').map(r => r.name);
  const base = await repo.detectBase(configured, locals);
  const remote = refs.find(r => r.kind === 'remote' && r.name === `origin/${base}`);
  const baseRef = (useRemote && remote) || !locals.includes(base) ? remote?.name ?? base : base;
  return { base, baseRef };
}

/** Recentes primeiro; a principal no topo; órfãs no fim. */
function sortWorktrees(list: WorktreeView[]) {
  const rank = (w: WorktreeView) => (w.isMain ? 0 : w.prunable ? 4 : w.favorite ? 1 : w.isCurrent || w.agents.length ? 2 : 3);
  return list.sort((a, b) => rank(a) - rank(b) || b.date - a.date || a.name.localeCompare(b.name));
}

/** Fase rápida: uns poucos processos git; o resto vem do cache. */
export async function buildState(repo: Repo, opts: BuildOptions, cache: RepoCache): Promise<GraphState> {
  const [wts, refs] = await Promise.all([repo.worktreesFast(), repo.refs()]);
  const { base, baseRef } = await resolveBase(repo, refs, opts.configuredBase, opts.useRemoteBase);
  const byName = new Map(refs.filter(r => r.kind === 'head').map(r => [r.name, r]));
  const baseSha = refs.find(r => (r.kind === 'head' || r.kind === 'remote') && r.name === baseRef)?.sha ?? '';
  for (const wt of wts) if (wt.branch && !wt.head) wt.head = byName.get(wt.branch)?.sha ?? '';

  const worktrees = wts.map((wt): WorktreeView => {
    const ref = wt.branch ? byName.get(wt.branch) : undefined;
    return {
      ...wt,
      name: wt.branch ?? (wt.bare ? '(bare)' : `(detached ${wt.head.slice(0, 7)})`),
      changes: 0,
      ahead: 0,
      behind: 0,
      statusKnown: false,
      compareKnown: false,
      upstream: ref?.upstream,
      track: ref?.track,
      remote: parseTrack(ref?.upstream, ref?.track),
      subject: ref?.subject ?? '',
      date: ref?.date ?? 0,
      isCurrent: key(wt.path) === key(repo.root),
      isBase: wt.branch === base,
      paused: !!wt.branch && opts.paused.includes(wt.branch),
      sync: wt.branch ? opts.statuses.get(wt.branch) : undefined,
      agents: opts.agentsRunning?.get(key(wt.path)) ?? [],
      favorite: !!opts.favorites?.has(key(wt.path)),
    };
  });

  const inWorktree = new Set(wts.map(w => w.branch).filter(Boolean) as string[]);
  const branches = [...byName.values()]
    .filter(r => !inWorktree.has(r.name))
    .map(
      (r): BranchView => ({
        name: r.name,
        sha: r.sha,
        upstream: r.upstream,
        track: r.track,
        remote: parseTrack(r.upstream, r.track),
        date: r.date,
        subject: r.subject,
        isBase: r.name === base,
        ahead: 0,
        behind: 0,
        compareKnown: r.name === base,
      }),
    )
    .sort((a, b) => b.date - a.date);

  const unmerged = baseSha ? await repo.unmerged(baseRef) : [];
  const graphFilter = opts.graphFilter ?? 'all';
  // "Só não mescladas": os commits das branches pendentes, mais o ponto da base de onde cada uma saiu.
  const revs =
    graphFilter === 'unmerged'
      ? unmerged.length
        ? ['--boundary', ...unmerged.map(b => `refs/heads/${b}`), `^${baseRef}`]
        : []
      : ['--branches', '--tags', ...(opts.showRemotes ? ['--remotes'] : []), ...new Set(wts.filter(w => w.detached && w.head).map(w => w.head))];
  const commits = await repo.log(revs, opts.maxCommits);
  const badges = new Map<string, RefBadge[]>();
  const add = (sha: string, b: RefBadge) => {
    const list = badges.get(sha) ?? [];
    list.push(b);
    badges.set(sha, list);
  };
  const current = worktrees.find(w => w.isCurrent);
  for (const r of refs) {
    if (r.kind === 'remote' && !opts.showRemotes) continue;
    add(r.sha, {
      name: r.name,
      kind: r.kind,
      worktree: r.kind === 'head' && inWorktree.has(r.name),
      current: r.kind === 'head' && current?.branch === r.name,
    });
  }
  for (const w of worktrees) {
    if (w.detached && w.head) add(w.head, { name: w.name, kind: 'detached', worktree: true, current: w.isCurrent });
  }
  const order: Record<RefBadge['kind'], number> = { head: 0, detached: 1, remote: 2, tag: 3 };
  for (const list of badges.values()) list.sort((a, b) => Number(b.current) - Number(a.current) || order[a.kind] - order[b.kind]);

  const state: GraphState = {
    repoName: path.basename(wts[0]?.path ?? repo.root),
    root: repo.root,
    base,
    baseRef,
    baseSha,
    worktrees: sortWorktrees(worktrees),
    branches,
    commits: commits.map(c => ({ ...c, refs: badges.get(c.sha) ?? [] })),
    autoSync: opts.autoSync,
    agentNames: opts.agentNames ?? [],
    pending: 0,
    graphFilter,
    unmerged,
  };
  applyCache(state, cache);
  return state;
}

/** Copia do cache para as views o que já se sabe. Barato; roda a cada resultado novo. */
export function applyCache(state: GraphState, cache: RepoCache) {
  let pending = 0;
  for (const w of state.worktrees) {
    if (w.bare || w.prunable) {
      w.statusKnown = w.compareKnown = true;
      continue;
    }
    const st = cache.statuses.get(key(w.path));
    if (st) {
      w.changes = st.changes;
      w.operation = st.operation;
      w.statusKnown = true;
    }
    const target = w.isBase ? (state.baseRef !== state.base ? w.head : '') : w.head;
    if (!target || !state.baseSha) {
      w.compareKnown = true;
    } else {
      const c = cache.compares.get(RepoCache.compareKey(state.baseSha, target));
      if (c) Object.assign(w, c, { compareKnown: true });
    }
    if (!w.statusKnown || !w.compareKnown) pending++;
  }
  for (const b of state.branches) {
    if (b.isBase) continue;
    const c = cache.compares.get(RepoCache.compareKey(state.baseSha, b.sha));
    if (c) Object.assign(b, c, { compareKnown: true });
  }
  state.pending = pending;
}

export interface EnrichOptions {
  /** Idade máxima do status de uma worktree ativa (atual, com agente, suja ou com commit recente). */
  activeSeconds: number;
  /** Idade máxima do status das demais. */
  idleSeconds: number;
  concurrency: number;
  /** Chamado a cada resultado; o chamador decide quando redesenhar. */
  onResult: () => void;
  isCancelled: () => boolean;
}

/**
 * Fase lenta: status das worktrees vencidas e comparações que faltam, por prioridade.
 * Grava tudo no cache; quem desenha é o chamador (applyCache + onResult).
 */
export async function enrich(repo: Repo, state: GraphState, cache: RepoCache, o: EnrichOptions) {
  const limit = pLimit(o.concurrency);
  const now = Date.now();
  const dayAgo = now / 1000 - 86400;
  const jobs: { prio: number; run: () => Promise<void> }[] = [];

  const compareJob = (sha: string, prio: number) => {
    const k = RepoCache.compareKey(state.baseSha, sha);
    if (!state.baseSha || !sha || cache.compares.has(k)) return;
    jobs.push({
      prio,
      run: async () => {
        if (cache.compares.has(k)) return;
        const [behind, ahead] = await repo.aheadBehind(state.baseSha, sha);
        const preview = ahead > 0 && behind > 0 ? await repo.mergePreview(sha, state.baseSha) : undefined;
        cache.compares.set(k, { ahead, behind, preview });
      },
    });
  };

  for (const w of state.worktrees) {
    if (w.bare || w.prunable) continue;
    const active = w.isCurrent || w.favorite || w.agents.length > 0 || w.changes > 0 || !!w.operation || w.date > dayAgo;
    const st = cache.statuses.get(key(w.path));
    const maxAge = (active ? o.activeSeconds : o.idleSeconds) * 1000;
    if (!st || now - st.at > maxAge) {
      jobs.push({
        prio: w.isCurrent ? 0 : active ? 1 : st ? 4 : 2,
        run: async () => {
          const s = await repo.status(w.path);
          cache.statuses.set(key(w.path), { ...s, at: Date.now() });
        },
      });
    }
    if (!w.isBase) compareJob(w.head, active ? 1 : 3);
    else if (state.baseRef !== state.base) compareJob(w.head, 1);
  }
  for (const b of state.branches) if (!b.isBase) compareJob(b.sha, 5);

  jobs.sort((a, b) => a.prio - b.prio);
  await Promise.all(
    jobs.map(j =>
      limit(async () => {
        if (o.isCancelled()) return;
        try {
          await j.run();
        } catch {
          // uma worktree com problema não impede as outras
        }
        o.onResult();
      }),
    ),
  );
}
