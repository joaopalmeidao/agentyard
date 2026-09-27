// Gera o estado que o painel recebe, a partir de um repositório real (usado nos testes e nos prints).
// Uso: node scripts/dump-state.js <repo> [status.json] [sync-on]
const { Repo } = require('../out/git');
const { buildState } = require('../out/model');
(async () => {
  const repo = await Repo.open(process.argv[2]);
  const statuses = new Map(process.argv[3] ? JSON.parse(require('fs').readFileSync(process.argv[3], 'utf8')) : []);
  const state = await buildState(repo, { configuredBase: '', useRemoteBase: false, maxCommits: 400, showRemotes: true, paused: [], statuses,
    autoSync: { enabled: process.argv[4] === 'sync-on', mode: 'merge', testCommand: 'npm test', owner: true } });
  process.stdout.write(JSON.stringify(state, null, 1));
})();
