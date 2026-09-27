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
  /** Commit de fronteira (--boundary): o ponto da base de onde uma branch saiu. */
  boundary?: boolean;
}

export interface WorktreeStatus {
  changes: number;
  /** [código XY do porcelain, caminho relativo com "/"]. */
  files?: [string, string][];
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
    const r = await this.run(['log', '--date-order', `-n${max}`, '--format=%H%x1f%P%x1f%an%x1f%at%x1f%m%x1f%s%x1e', ...revs, '--']);
    if (r.code !== 0) return [];
    const commits: Commit[] = [];
    for (const rec of r.stdout.split('\x1e')) {
      const s = rec.replace(/^\r?\n/, '');
      if (!s) continue;
      const [sha, parents, author, date, mark, subject] = s.split('\x1f');
      commits.push({ sha, parents: parents ? parents.split(' ') : [], author, date: Number(date), subject, boundary: mark === '-' });
    }
    return commits;
  }

  /** Branches locais com commits que `base` não tem (um processo só, sem depender do cache). */
  async unmerged(base: string): Promise<string[]> {
    const r = await this.run(['for-each-ref', `--no-merged=${base}`, '--format=%(refname:short)', 'refs/heads']);
    return r.code === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
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
    const st = await runGit(worktreePath, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=normal']);
    const entries = st.code === 0 ? st.stdout.split('\0').filter(Boolean) : [];
    const changes = entries.length;
    const files = entries.map((e): [string, string] => [e.slice(0, 2), e.slice(3)]);
    // Lido direto do diretório git da worktree: no Windows cada processo git custa ~0,5 s.
    let operation: WorktreeStatus['operation'];
    const gitDir = gitDirOf(worktreePath);
    if (gitDir) {
      const has = (f: string) => fs.existsSync(path.join(gitDir, f));
      if (has('MERGE_HEAD')) operation = 'merge';
      else if (has('rebase-merge') || has('rebase-apply')) operation = 'rebase';
      else if (has('CHERRY_PICK_HEAD')) operation = 'cherry-pick';
    }
    return { changes, operation, files };
  }

  /**
   * Lista as worktrees lendo `<common dir>/worktrees/*` em vez de rodar `git worktree list`
   * (que, com centenas de worktrees, leva segundos). Branch worktrees vêm com `head` vazio: quem
   * chama resolve pelo sha da ref. Cai para o git se o formato não for o esperado.
   */
  async worktreesFast(): Promise<Worktree[]> {
    try {
      if (path.basename(this.commonDir).toLowerCase() !== '.git') return this.worktrees();
      const readHead = (dir: string) => {
        const h = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim();
        return h.startsWith('ref: ') ? { branch: h.slice(5).replace(/^refs\/heads\//, ''), head: '' } : { branch: undefined, head: h };
      };
      const main = readHead(this.commonDir);
      const list: Worktree[] = [
        { path: path.dirname(this.commonDir), ...main, detached: !main.branch, bare: false, locked: false, prunable: false, isMain: true },
      ];
      const wtDir = path.join(this.commonDir, 'worktrees');
      const names = fs.existsSync(wtDir) ? fs.readdirSync(wtDir) : [];
      for (const n of names) {
        const dir = path.join(wtDir, n);
        let gitdirFile: string;
        try {
          gitdirFile = fs.readFileSync(path.join(dir, 'gitdir'), 'utf8').trim();
        } catch {
          continue;
        }
        const wtPath = path.normalize(path.dirname(path.resolve(dir, gitdirFile)));
        const h = readHead(dir);
        list.push({
          path: wtPath,
          ...h,
          detached: !h.branch,
          bare: false,
          locked: fs.existsSync(path.join(dir, 'locked')),
          prunable: !fs.existsSync(wtPath),
          isMain: false,
        });
      }
      return list;
    } catch {
      return this.worktrees();
    }
  }

  async conflictedFiles(worktreePath: string): Promise<string[]> {
    const r = await runGit(worktreePath, ['diff', '--name-only', '--diff-filter=U']);
    return r.code === 0 ? [...new Set(r.stdout.split(/\r?\n/).filter(Boolean))] : [];
  }

  async upstream(branch: string): Promise<string | undefined> {
    const r = await this.run(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`]);
    return r.code === 0 ? r.stdout.trim() : undefined;
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

/** Diretório git de uma worktree: `.git` da principal, ou o apontado pelo arquivo `.git` das demais. */
export function gitDirOf(worktreePath: string): string | undefined {
  const dotGit = path.join(worktreePath, '.git');
  try {
    const st = fs.statSync(dotGit);
    if (st.isDirectory()) return dotGit;
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    return m ? path.resolve(worktreePath, m[1].trim()) : undefined;
  } catch {
    return undefined;
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
