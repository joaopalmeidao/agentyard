/**
 * Lê do git as migrations de uma branch e do destino e monta o plano (src/migrations/core.ts).
 * Sem VS Code, para os testes rodarem num repositório de verdade.
 */
import { spawn } from 'child_process';
import * as path from 'path';
import type { Repo } from '../git';
import { isMigrationPath, MigFile, needsContent, planRechain, RechainPlan } from './core';

export interface MigrationCheck {
  /** Branch cujas migrations seriam reencadeadas. */
  branch: string;
  /** Ref que ela passa a seguir. */
  onto: string;
  branchSha: string;
  plan: RechainPlan;
}

/** Conteúdo de vários blobs `<ref>:<caminho>` num processo só (`git cat-file --batch`). */
function catFiles(cwd: string, specs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!specs.length) return Promise.resolve(out);
  return new Promise(resolve => {
    const child = spawn('git', ['cat-file', '--batch'], { cwd, windowsHide: true });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => chunks.push(b));
    child.on('error', () => resolve(out));
    child.on('close', () => {
      const buf = Buffer.concat(chunks);
      let pos = 0;
      for (const spec of specs) {
        const nl = buf.indexOf(10, pos);
        if (nl < 0) break;
        const header = buf.subarray(pos, nl).toString();
        pos = nl + 1;
        const m = /^\S+ blob (\d+)$/.exec(header);
        if (!m) continue; // "<spec> missing"
        const size = Number(m[1]);
        out.set(spec, buf.subarray(pos, pos + size).toString('utf8'));
        pos += size + 1;
      }
      resolve(out);
    });
    child.stdin.end(specs.join('\n') + '\n');
  });
}

const lines = (s: string) => s.split('\0').filter(Boolean);

/**
 * Migrations que `branch` adicionou e que colidem com as de `onto`. Funciona antes e depois de a
 * base ter sido trazida para a branch: compara com a última migration de `onto`, não só com o arquivo.
 */
export async function checkMigrations(repo: Repo, branch: string, onto: string): Promise<MigrationCheck | undefined> {
  const sha = async (r: string) => (await repo.run(['rev-parse', '--verify', '--quiet', `${r}^{commit}`])).stdout.trim();
  const [branchSha, ontoSha] = await Promise.all([sha(branch), sha(onto)]);
  if (!branchSha || !ontoSha) return undefined;
  const mb = (await repo.run(['merge-base', ontoSha, branchSha])).stdout.trim();
  if (!mb) return undefined;
  const empty: MigrationCheck = { branch, onto, branchSha, plan: { groups: [], renames: [], writes: [] } };

  const addedOut = await repo.run(['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', mb, branchSha]);
  const addedPaths = lines(addedOut.stdout).filter(isMigrationPath);
  if (!addedPaths.length) return empty;

  const tree = await repo.run(['ls-tree', '-r', '--name-only', '-z', ontoSha]);
  const inOnto = new Set(lines(tree.stdout));
  const mine = addedPaths.filter(p => !inOnto.has(p));
  if (!mine.length) return empty;
  // Só as pastas onde a branch mexeu interessam.
  const dirs = new Set(mine.map(p => path.posix.dirname(p)));
  const targetPaths = [...inOnto].filter(p => dirs.has(path.posix.dirname(p)) && isMigrationPath(p));

  const blobs = await catFiles(repo.root, [...mine.map(p => `${branchSha}:${p}`), ...targetPaths.filter(needsContent).map(p => `${ontoSha}:${p}`)]);
  const target: MigFile[] = targetPaths.map(p => ({ path: p, content: blobs.get(`${ontoSha}:${p}`) }));
  const added: MigFile[] = mine.map(p => ({ path: p, content: blobs.get(`${branchSha}:${p}`) ?? '' }));
  return { ...empty, plan: planRechain(target, added) };
}
