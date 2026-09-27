import { Repo } from './git';

export interface IncomingCommit {
  sha: string;
  subject: string;
  author: string;
  date: number;
}

export interface ChangedFile {
  path: string;
  added: number;
  deleted: number;
  binary: boolean;
  /** O destino também mexeu neste arquivo desde o ponto em comum. */
  bothSides: boolean;
  conflict: boolean;
}

export interface MergeAnalysis {
  source: string;
  target: string;
  sourceSha: string;
  targetSha: string;
  mergeBase: string;
  /** Commits que entram no destino. */
  incoming: IncomingCommit[];
  /** Commits que o destino tem e a origem não. */
  behind: number;
  files: ChangedFile[];
  /** Árvore resultante do merge simulado; nela os arquivos em conflito têm os marcadores <<<<<<<. */
  resultTree?: string;
  conflicts: { path: string; hunks: number }[];
  fastForward: boolean;
}

/** Simula `git merge source` em `target` sem tocar em nenhuma worktree (git >= 2.38). */
export async function analyzeMerge(repo: Repo, source: string, target: string): Promise<MergeAnalysis> {
  const rev = async (r: string) => (await repo.exec(['rev-parse', '--verify', `${r}^{commit}`])).trim();
  const [sourceSha, targetSha] = await Promise.all([rev(source), rev(target)]);
  const mergeBase = (await repo.exec(['merge-base', targetSha, sourceSha])).trim();

  const [log, behindOut, numstat, targetSide, mt] = await Promise.all([
    repo.exec(['log', '--format=%H%x1f%s%x1f%an%x1f%at', '-n', '300', `${targetSha}..${sourceSha}`]),
    repo.exec(['rev-list', '--count', `${sourceSha}..${targetSha}`]),
    repo.exec(['diff', '--numstat', '--no-renames', mergeBase, sourceSha]),
    repo.exec(['diff', '--name-only', '--no-renames', mergeBase, targetSha]),
    // Nomes em vez de SHAs para os marcadores de conflito ficarem legíveis.
    repo.run(['merge-tree', '--write-tree', '--no-messages', target, source]),
  ]);

  const incoming = log
    .split(/\r?\n/)
    .filter(Boolean)
    .map(l => {
      const [sha, subject, author, date] = l.split('\x1f');
      return { sha, subject, author, date: Number(date) };
    });

  let resultTree: string | undefined;
  const conflictPaths = new Set<string>();
  if (mt.code === 0 || mt.code === 1) {
    const lines = mt.stdout.split(/\r?\n/);
    resultTree = lines[0]?.trim() || undefined;
    if (mt.code === 1) {
      // "<modo> <objeto> <estágio>\t<caminho>" até a primeira linha vazia
      for (const l of lines.slice(1)) {
        if (!l) break;
        const tab = l.indexOf('\t');
        if (tab > 0) conflictPaths.add(l.slice(tab + 1));
      }
    }
  }

  const conflicts = await Promise.all(
    [...conflictPaths].map(async p => {
      let hunks = 0;
      if (resultTree) {
        const r = await repo.run(['cat-file', '-p', `${resultTree}:${p}`]);
        if (r.code === 0) hunks = (r.stdout.match(/^<{7}( |$)/gm) ?? []).length;
      }
      return { path: p, hunks };
    }),
  );

  const touchedByTarget = new Set(targetSide.split(/\r?\n/).filter(Boolean));
  const files = numstat
    .split(/\r?\n/)
    .filter(Boolean)
    .map(l => {
      const [a, d, ...rest] = l.split('\t');
      const p = rest.join('\t');
      return {
        path: p,
        added: a === '-' ? 0 : Number(a),
        deleted: d === '-' ? 0 : Number(d),
        binary: a === '-',
        bothSides: touchedByTarget.has(p),
        conflict: conflictPaths.has(p),
      };
    })
    .sort((x, y) => Number(y.conflict) - Number(x.conflict) || Number(y.bothSides) - Number(x.bothSides) || x.path.localeCompare(y.path));

  return {
    source,
    target,
    sourceSha,
    targetSha,
    mergeBase,
    incoming,
    behind: Number(behindOut.trim()) || 0,
    files,
    resultTree,
    conflicts,
    fastForward: mergeBase === targetSha,
  };
}
