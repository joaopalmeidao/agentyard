import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class GitError extends Error {
  constructor(readonly args: string[], readonly result: GitResult) {
    super(`git ${args.join(' ')} falhou (${result.code}): ${(result.stderr || result.stdout).trim()}`);
  }
}

export function runGit(cwd: string, args: string[], timeoutMs = 60_000): Promise<GitResult> {
  return new Promise(resolve => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        timeout: timeoutMs,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      },
      (err, stdout, stderr) => {
        let code = 0;
        let errText = '';
        if (err) {
          const c = (err as NodeJS.ErrnoException & { code?: unknown }).code;
          code = typeof c === 'number' ? c : 1;
          if (typeof c !== 'number') errText = err.message;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) || errText, code });
      },
    );
  });
}

export interface Worktree {
  path: string;
  head: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
  isMain: boolean;
}

export interface Ref {
  /** Nome curto: "feat/x", "origin/feat/x", "v1.0". */
  name: string;
  kind: 'head' | 'remote' | 'tag';
  sha: string;
  upstream?: string;
  /** "ahead 1, behind 2", "gone" ou vazio. */
  track?: string;
  date: number;
  subject: string;
}

export interface Commit {
  sha: string;
  parents: string[];
  author: string;
  date: number;
  subject: string;
}

export interface WorktreeStatus {
  changes: number;
  operation?: 'merge' | 'rebase' | 'cherry-pick';
}

export interface MergePreview {
  conflict: boolean;
  files: string[];
}

export class Repo {
  private constructor(readonly root: string, readonly commonDir: string) {}

  static async open(folder: string): Promise<Repo | undefined> {
    const r = await runGit(folder, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']);
    if (r.code !== 0) return undefined;
    const [top, common] = r.stdout.trim().split(/\r?\n/);
    if (!top || !common) return undefined;
    return new Repo(path.normalize(top), path.normalize(common));
  }

  run(args: string[], cwd = this.root, timeoutMs?: number): Promise<GitResult> {
    return runGit(cwd, args, timeoutMs);
  }

  async exec(args: string[], cwd = this.root, timeoutMs?: number): Promise<string> {
    const r = await runGit(cwd, args, timeoutMs);
    if (r.code !== 0) throw new GitError(args, r);
    return r.stdout;
  }

  async worktrees(): Promise<Worktree[]> {
    const out = await this.exec(['worktree', 'list', '--porcelain']);
    const list: Worktree[] = [];
    let cur: Worktree | undefined;
    for (const line of out.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        cur = {
          path: path.normalize(line.slice('worktree '.length)),
          head: '',
          detached: false,
          bare: false,
          locked: false,
          prunable: false,
          isMain: list.length === 0,
        };
        list.push(cur);
      } else if (!cur) {
        continue;
      } else if (line.startsWith('HEAD ')) {
        cur.head = line.slice(5);
      } else if (line.startsWith('branch ')) {
        cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
      } else if (line === 'detached') {
        cur.detached = true;
      } else if (line === 'bare') {
        cur.bare = true;
      } else if (line.startsWith('locked')) {
        cur.locked = true;
      } else if (line.startsWith('prunable')) {
        cur.prunable = true;
      }
    }
    return list;
  }

  async refs(): Promise<Ref[]> {
    const fields = [
      '%(refname)',
      '%(objectname)',
      '%(*objectname)',
      '%(upstream:short)',
      '%(upstream:track,nobracket)',
      '%(committerdate:unix)',
      '%(*committerdate:unix)',
      '%(contents:subject)',
    ];
    const out = await this.exec(['for-each-ref', `--format=${fields.join('%1f')}`, 'refs/heads', 'refs/remotes', 'refs/tags']);
    const refs: Ref[] = [];
    for (const line of out.split(/\r?\n/)) {
      if (!line) continue;
      const [full, sha, peeled, upstream, track, date, peeledDate, subject] = line.split('\x1f');
      let kind: Ref['kind'];
      let name: string;
      if (full.startsWith('refs/heads/')) {
        kind = 'head';
        name = full.slice(11);
      } else if (full.startsWith('refs/remotes/')) {
        kind = 'remote';
        name = full.slice(13);
        if (name.endsWith('/HEAD')) continue;
      } else {
        kind = 'tag';
        name = full.slice(10);
      }
      refs.push({
        name,
        kind,
        sha: peeled || sha,
        upstream: upstream || undefined,
        track: track || undefined,
        date: Number(peeledDate || date) || 0,
        subject: subject ?? '',
      });
    }
    return refs;
  }

  async log(revs: string[], max: number): Promise<Commit[]> {
    if (revs.length === 0) return [];
    const r = await this.run(['log', '--date-order', `-n${max}`, '--format=%H%x1f%P%x1f%an%x1f%at%x1f%s%x1e', ...revs, '--']);
    if (r.code !== 0) return [];
    const commits: Commit[] = [];
    for (const rec of r.stdout.split('\x1e')) {
      const s = rec.replace(/^\r?\n/, '');
      if (!s) continue;
      const [sha, parents, author, date, subject] = s.split('\x1f');
      commits.push({ sha, parents: parents ? parents.split(' ') : [], author, date: Number(date), subject });
    }
    return commits;
  }

  /** [commits só em `left`, commits só em `right`]. */
  async aheadBehind(left: string, right: string): Promise<[number, number]> {
    const r = await this.run(['rev-list', '--left-right', '--count', `${left}...${right}`]);
    if (r.code !== 0) return [0, 0];
    const [a, b] = r.stdout.trim().split(/\s+/).map(Number);
    return [a || 0, b || 0];
  }

  /** Simula o merge de `theirs` em `ours` sem tocar em nenhuma worktree (git >= 2.38). */
  async mergePreview(ours: string, theirs: string): Promise<MergePreview | undefined> {
    const r = await this.run(['merge-tree', '--write-tree', '--name-only', '--no-messages', ours, theirs]);
    if (r.code === 0) return { conflict: false, files: [] };
    if (r.code !== 1) return undefined;
    const files: string[] = [];
    for (const l of r.stdout.split(/\r?\n/).slice(1)) {
      if (!l) break;
      files.push(l);
    }
    return { conflict: true, files: [...new Set(files)] };
  }

  async status(worktreePath: string): Promise<WorktreeStatus> {
    const [st, gp] = await Promise.all([
      runGit(worktreePath, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=normal']),
      runGit(worktreePath, [
        'rev-parse', '--path-format=absolute',
        '--git-path', 'MERGE_HEAD', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply', '--git-path', 'CHERRY_PICK_HEAD',
      ]),
    ]);
    const changes = st.code === 0 ? st.stdout.split('\0').filter(Boolean).length : 0;
    let operation: WorktreeStatus['operation'];
    if (gp.code === 0) {
      const [merge, rbm, rba, cp] = gp.stdout.trim().split(/\r?\n/);
      if (merge && fs.existsSync(merge)) operation = 'merge';
      else if ((rbm && fs.existsSync(rbm)) || (rba && fs.existsSync(rba))) operation = 'rebase';
      else if (cp && fs.existsSync(cp)) operation = 'cherry-pick';
    }
    return { changes, operation };
  }

  async conflictedFiles(worktreePath: string): Promise<string[]> {
    const r = await runGit(worktreePath, ['diff', '--name-only', '--diff-filter=U']);
    return r.code === 0 ? [...new Set(r.stdout.split(/\r?\n/).filter(Boolean))] : [];
  }

  async revParse(rev: string, cwd = this.root): Promise<string | undefined> {
    const r = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  async detectBase(configured: string, localBranches: string[]): Promise<string> {
    if (configured) return configured;
    const r = await this.run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (r.code === 0) {
      const n = r.stdout.trim().replace(/^origin\//, '');
      if (localBranches.includes(n)) return n;
    }
    for (const c of ['main', 'master', 'develop']) if (localBranches.includes(c)) return c;
    return localBranches[0] ?? 'main';
  }
}

/** Limita quantas promessas rodam ao mesmo tempo (várias worktrees = vários processos git). */
export function pLimit(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return <T>(fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const start = () => {
        active++;
        fn().then(resolve, reject).finally(next);
      };
      if (active < n) start();
      else queue.push(start);
    });
}

/** Glob de branch: "*" casa um segmento, "**" casa qualquer coisa. */
export function branchMatches(branch: string, patterns: string[]): boolean {
  return patterns.some(p => {
    const re = p
      .split('**')
      .map(part => part.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
      .join('.*');
    return new RegExp(`^${re}$`).test(branch);
  });
}
