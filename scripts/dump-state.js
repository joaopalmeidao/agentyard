// Gera o estado que o painel recebe, a partir de um repositório real (usado nos testes, nos prints e
// para medir desempenho). Uso: node scripts/dump-state.js <repo> [status.json] [sync-on] [--timing]
const { Repo } = require('../out/git');
const { buildState, enrich, applyCache, RepoCache } = require('../out/model');
(async () => {
  const timing = process.argv.includes('--timing');
  const args = process.argv.slice(2).filter(a => a !== '--timing');
  const repo = await Repo.open(args[0]);
  const statuses = new Map(args[1] ? JSON.parse(require('fs').readFileSync(args[1], 'utf8')) : []);
  const cache = new RepoCache();
  const opts = {
    configuredBase: '', useRemoteBase: false, maxCommits: 400, showRemotes: true, paused: [], statuses,
    autoSync: { enabled: args[2] === 'sync-on', mode: 'merge', testCommand: 'npm test', owner: true, where: 'local' },
    agentNames: ['Claude Code', 'Codex CLI'],
  };
  let t = Date.now();
  const state = await buildState(repo, opts, cache);
  if (timing) console.error(`fase rápida: ${Date.now() - t} ms · ${state.worktrees.length} worktrees · pendentes ${state.pending}`);
  t = Date.now();
  let results = 0;
  await enrich(repo, state, cache, {
    activeSeconds: 30, idleSeconds: 600, concurrency: 8, isCancelled: () => false,
    onResult: () => {
      results++;
      if (timing && results % 50 === 0) {
        applyCache(state, cache);
        console.error(`  ${((Date.now() - t) / 1000).toFixed(1)} s: ${results} resultados, pendentes ${state.pending}`);
      }
    },
  });
  applyCache(state, cache);
  if (timing) {
    console.error(`detalhamento: ${Date.now() - t} ms · ${results} comandos · pendentes ${state.pending}`);
    t = Date.now();
    const again = await buildState(repo, opts, cache);
    console.error(`recarga com cache: ${Date.now() - t} ms · pendentes ${again.pending}`);
  }
  process.stdout.write(JSON.stringify(state, null, 1));
})();
