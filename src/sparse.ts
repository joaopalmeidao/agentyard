import * as fs from 'fs';
import * as path from 'path';
import { runGit } from './git';

/**
 * Worktree com checkout parcial (sparse-checkout em modo cone) e submódulos. Em monorepos, a worktree
 * de um agente só precisa das pastas da tarefa: cria mais rápido e ocupa menos disco. Sem VS Code
 * (testado em test/sparse.test.js).
 */

async function git(cwd: string, args: string[], timeoutMs = 600_000) {
  const r = await runGit(cwd, args, timeoutMs);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

/** Pastas de `ref` até `depth` níveis (para escolher o que entra no checkout parcial). */
export async function listDirs(cwd: string, ref: string, depth = 2): Promise<string[]> {
  const out = await git(cwd, ['ls-tree', '-r', '-d', '--name-only', ref]);
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .filter(d => d.split('/').length <= depth && !d.split('/').some(p => p.startsWith('.')));
}

/** Pastas normalizadas para o modo cone (sem barra no começo/fim, sem duplicadas nem aninhadas). */
export function coneDirs(dirs: string[]): string[] {
  const clean = [...new Set(dirs.map(d => d.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).filter(Boolean))].sort();
  return clean.filter(d => !clean.some(o => o !== d && d.startsWith(`${o}/`)));
}

/**
 * Liga o checkout parcial numa worktree criada com `--no-checkout` e popula os arquivos. Os arquivos
 * da raiz sempre vêm (regra do modo cone).
 */
export async function applySparse(dir: string, dirs: string[]) {
  await git(dir, ['sparse-checkout', 'set', '--cone', '--', ...coneDirs(dirs)]);
  // a worktree veio sem checkout: o índice está vazio; read-tree -mu popula respeitando o sparse
  await git(dir, ['read-tree', '-mu', 'HEAD']);
}

/** Muda as pastas do checkout parcial de uma worktree que já existe (vazio = desliga). */
export async function setSparse(dir: string, dirs: string[]) {
  if (!dirs.length) {
    await git(dir, ['sparse-checkout', 'disable']);
    return;
  }
  await git(dir, ['sparse-checkout', 'set', '--cone', '--', ...coneDirs(dirs)]);
}

/** Pastas do checkout parcial atual (undefined = checkout completo). */
export async function sparseDirs(dir: string): Promise<string[] | undefined> {
  const on = await runGit(dir, ['config', '--get', 'core.sparseCheckout']);
  if (on.stdout.trim() !== 'true') return undefined;
  const r = await runGit(dir, ['sparse-checkout', 'list']);
  return r.code === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : undefined;
}

export function hasSubmodules(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.gitmodules'));
}

export async function initSubmodules(dir: string) {
  await git(dir, ['submodule', 'update', '--init', '--recursive'], 1_800_000);
}
