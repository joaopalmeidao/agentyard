import * as path from 'path';
import { Commit, MergePreview, pLimit, Ref, Repo, Worktree } from './git';

export type SyncKind =
  | 'uptodate'
  | 'merged'
  | 'behind'
  | 'waiting-dirty'
  | 'conflict'
  | 'testing'
  | 'test-failed'
  | 'paused'
  | 'error';

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
  upstream?: string;
  track?: string;
  subject: string;
  date: number;
  isCurrent: boolean;
  isBase: boolean;
  paused: boolean;
  sync?: SyncStatus;
  /** Agentes com terminal aberto nesta worktree. */
  agents: string[];
}

export interface BranchView {
  name: string;
  sha: string;
  upstream?: string;
  track?: string;
  ahead: number;
  behind: number;
  preview?: MergePreview;
  date: number;
  subject: string;
  isBase: boolean;
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
  worktrees: WorktreeView[];
  branches: BranchView[];
  commits: GraphCommit[];
  autoSync: { enabled: boolean; mode: string; testCommand: string; owner: boolean };
  /** Agentes configurados, na ordem das configurações (o primeiro é o do botão). */
  agentNames: string[];
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
}

const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase() : path.normalize(a) === path.normalize(b);

export async function resolveBase(repo: Repo, refs: Ref[], configured: string, useRemote: boolean) {
  const locals = refs.filter(r => r.kind === 'head').map(r => r.name);
  const base = await repo.detectBase(configured, locals);
  const remote = refs.find(r => r.kind === 'remote' && r.name === `origin/${base}`);
  const baseRef = (useRemote && remote) || !locals.includes(base) ? remote?.name ?? base : base;
  return { base, baseRef };
}

export async function buildState(repo: Repo, opts: BuildOptions): Promise<GraphState> {
  const [wts, refs] = await Promise.all([repo.worktrees(), repo.refs()]);
  const { base, baseRef } = await resolveBase(repo, refs, opts.configuredBase, opts.useRemoteBase);
  const byName = new Map(refs.filter(r => r.kind === 'head').map(r => [r.name, r]));
  const limit = pLimit(6);

  const compare = async (branch: string) => {
    const [behind, ahead] = await repo.aheadBehind(baseRef, branch);
    const preview = ahead > 0 && behind > 0 ? await repo.mergePreview(branch, baseRef) : undefined;
    return { ahead, behind, preview };
  };

  const worktrees = await Promise.all(
    wts.map(wt =>
      limit(async (): Promise<WorktreeView> => {
        const ref = wt.branch ? byName.get(wt.branch) : undefined;
        const isBase = wt.branch === base;
        const view: WorktreeView = {
          ...wt,
          name: wt.branch ?? (wt.bare ? '(bare)' : `(detached ${wt.head.slice(0, 7)})`),
          changes: 0,
          ahead: 0,
          behind: 0,
          upstream: ref?.upstream,
          track: ref?.track,
          subject: ref?.subject ?? '',
          date: ref?.date ?? 0,
          isCurrent: samePath(wt.path, repo.root),
          isBase,
          paused: !!wt.branch && opts.paused.includes(wt.branch),
          sync: wt.branch ? opts.statuses.get(wt.branch) : undefined,
          agents: opts.agentsRunning?.get(path.normalize(wt.path).toLowerCase()) ?? [],
        };
        if (wt.bare || wt.prunable) return view;
        const st = await repo.status(wt.path);
        view.changes = st.changes;
        view.operation = st.operation;
        if (wt.branch && !isBase) Object.assign(view, await compare(wt.branch));
        else if (isBase && baseRef !== base) {
          const [behind, ahead] = await repo.aheadBehind(baseRef, base);
          Object.assign(view, { ahead, behind });
        }
        return view;
      }),
    ),
  );

  const inWorktree = new Set(wts.map(w => w.branch).filter(Boolean) as string[]);
  const branches = await Promise.all(
    [...byName.values()]
      .filter(r => !inWorktree.has(r.name))
      .map(r =>
        limit(async (): Promise<BranchView> => ({
          name: r.name,
          sha: r.sha,
          upstream: r.upstream,
          track: r.track,
          date: r.date,
          subject: r.subject,
          isBase: r.name === base,
          ...(r.name === base ? { ahead: 0, behind: 0 } : await compare(r.name)),
        })),
      ),
  );
  branches.sort((a, b) => b.date - a.date);

  const revs = ['--branches', '--tags', ...(opts.showRemotes ? ['--remotes'] : []), ...wts.filter(w => w.head).map(w => w.head)];
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

  return {
    repoName: path.basename(wts[0]?.path ?? repo.root),
    root: repo.root,
    base,
    baseRef,
    worktrees,
    branches,
    commits: commits.map(c => ({ ...c, refs: badges.get(c.sha) ?? [] })),
    autoSync: opts.autoSync,
    agentNames: opts.agentNames ?? [],
  };
}
