import * as fs from 'fs';
import * as path from 'path';
import { gitDirOf } from '../git';

/**
 * Leituras baratas do estado de uma worktree, direto dos arquivos do git (sem processo: nesta
 * máquina cada `git` custa ~0,5 s).
 */

/** Sha do HEAD da worktree: resolve a ref em loose ref ou em packed-refs. */
export function readHead(worktreePath: string): string | undefined {
  const gd = gitDirOf(worktreePath);
  if (!gd) return undefined;
  let head: string;
  try {
    head = fs.readFileSync(path.join(gd, 'HEAD'), 'utf8').trim();
  } catch {
    return undefined;
  }
  if (!head.startsWith('ref: ')) return head || undefined;
  const ref = head.slice(5).trim();
  let common = gd;
  try {
    common = path.resolve(gd, fs.readFileSync(path.join(gd, 'commondir'), 'utf8').trim());
  } catch {
    // worktree principal: o próprio .git é o common dir
  }
  for (const dir of [gd, common]) {
    try {
      return fs.readFileSync(path.join(dir, ref), 'utf8').trim();
    } catch {
      // tenta o próximo
    }
  }
  try {
    const line = fs
      .readFileSync(path.join(common, 'packed-refs'), 'utf8')
      .split(/\r?\n/)
      .find(l => l.endsWith(` ${ref}`));
    return line?.split(' ')[0];
  } catch {
    return undefined;
  }
}

/** Última escrita no índice da worktree (git add/commit mexem nele). */
export function indexMtime(worktreePath: string): number {
  const gd = gitDirOf(worktreePath);
  if (!gd) return 0;
  try {
    return fs.statSync(path.join(gd, 'index')).mtimeMs;
  } catch {
    return 0;
  }
}

export const keyOf = (p: string) => path.normalize(p).toLowerCase();
