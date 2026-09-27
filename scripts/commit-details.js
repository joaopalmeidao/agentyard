// Detalhes reais de um commit da demo (mesmos comandos de src/commits.ts commitDetails), para o print
// do painel expandido. Uso: node scripts/commit-details.js <repo> <índice do commit no estado>
const { Repo } = require('../out/git');
const fs = require('fs');
(async () => {
  const repo = await Repo.open(process.argv[2]);
  const state = JSON.parse(fs.readFileSync('docs/.tmp/state.js', 'utf8').replace(/^window\.__STATE = /, '').replace(/;\s*$/, ''));
  const sha = state.commits[Number(process.argv[3] || 0)].sha;
  const [meta, numstat, names] = await Promise.all([
    repo.exec(['show', '-s', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B', sha]),
    repo.exec(['show', '--format=', '--numstat', '--no-renames', '-m', '--first-parent', sha]),
    repo.exec(['show', '--format=', '--name-status', '--no-renames', '-m', '--first-parent', sha]),
  ]);
  const [full, parents, an, ae, at, cn, ce, ct, ...msg] = meta.split('\x1f');
  const st = new Map(names.split(/\r?\n/).filter(Boolean).map(l => { const [s, ...r] = l.split('\t'); return [r.join('\t'), s[0]]; }));
  const files = numstat.split(/\r?\n/).filter(Boolean).map(l => { const [a, d, ...r] = l.split('\t'); const p = r.join('\t'); return { path: p, status: st.get(p) || 'M', added: a === '-' ? -1 : +a, deleted: d === '-' ? -1 : +d }; });
  const details = { sha: full.trim(), parents: parents.trim().split(' ').filter(Boolean), author: an, authorEmail: ae, authorDate: +at, committer: cn, committerEmail: ce, committerDate: +ct, message: msg.join('\x1f').trim(), files };
  fs.writeFileSync('docs/.tmp/details.js', `window.__DETAILS = ${JSON.stringify({ index: Number(process.argv[3] || 0), details })};`);
})();
