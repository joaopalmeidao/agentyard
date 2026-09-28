import * as fs from 'fs';
import { runGit } from './git';

/**
 * `git bisect run` numa worktree temporária (a sua e a dos agentes ficam como estão): acha o primeiro
 * commit em que um comando de teste passou a falhar. Sem VS Code (testado em test/sparse.test.js).
 */

export interface BisectResult {
  /** Primeiro commit ruim (undefined se o bisect não chegou a um). */
  sha?: string;
  /** Saída do bisect, para mostrar. */
  log: string;
}

/** Primeiro commit ruim na saída do `git bisect run`. */
export function parseBisect(output: string): string | undefined {
  return output.match(/^([0-9a-f]{7,40}) is the first bad commit/m)?.[1];
}

async function git(cwd: string, args: string[], timeoutMs = 600_000) {
  const r = await runGit(cwd, args, timeoutMs);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

/** Cria a worktree temporária destacada em `bad` (o chamador remove com removeTemp). */
export async function addTemp(repoRoot: string, tmp: string, bad: string) {
  await git(repoRoot, ['worktree', 'add', '--detach', tmp, bad]);
}

export async function removeTemp(repoRoot: string, tmp: string) {
  await runGit(tmp, ['bisect', 'reset']);
  const r = await runGit(repoRoot, ['worktree', 'remove', '--force', tmp]);
  if (r.code !== 0 && fs.existsSync(tmp)) {
    fs.rmSync(tmp, { recursive: true, force: true });
    await runGit(repoRoot, ['worktree', 'prune']);
  }
}

/**
 * Roda o bisect entre `good` e `bad` com `cmd` (pelo shell do git: 0 = bom, 125 = pular, outro = ruim).
 * `timeoutMs` vale para o bisect inteiro.
 */
export async function bisectRun(repoRoot: string, tmp: string, good: string, bad: string, cmd: string, timeoutMs = 3_600_000): Promise<BisectResult> {
  await addTemp(repoRoot, tmp, bad);
  try {
    await git(tmp, ['bisect', 'start', bad, good]);
    // o bisect roda o primeiro argumento como programa: o comando inteiro vai pelo sh (o do git, no Windows)
    const r = await runGit(tmp, ['bisect', 'run', 'sh', '-c', cmd], timeoutMs);
    const log = `${r.stdout}\n${r.stderr}`.trim();
    return { sha: parseBisect(r.stdout), log };
  } finally {
    await removeTemp(repoRoot, tmp);
  }
}
