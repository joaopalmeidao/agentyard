// Roda o AutoSync de verdade contra um repositório, com um stub mínimo da API do VS Code.
// Uso: node scripts/test-sync.js <repo> [comando de teste] [arquivo para gravar os status]
const Module = require('module');
const orig = Module._resolveFilename;
const msgs = [];
const vscodeStub = {
  window: { createStatusBarItem: () => ({ show(){}, hide(){}, dispose(){} }),
    showWarningMessage: async (m) => { msgs.push('WARN ' + m); }, showInformationMessage: async (m) => { msgs.push('INFO ' + m); } },
  env: { sessionId: 'teste' }, StatusBarAlignment: { Left: 1 }, commands: { executeCommand(){} },
};
Module._resolveFilename = function (req, ...a) { return req === 'vscode' ? 'vscode' : orig.call(this, req, ...a); };
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeStub };
const { Repo } = require('../out/git');
const { AutoSync } = require('../out/sync');
(async () => {
  const repo = await Repo.open(process.argv[2]);
  const conf = { 'autoSync.mode': 'merge', 'autoSync.branches': ['ai/**'], 'autoSync.testCommand': process.argv[3] || '' };
  const ctl = { repo, statuses: new Map(), syncOwner: false, out: { show(){} },
    cfg: () => ({ get: (k, d) => (k in conf ? conf[k] : d) }), autoSyncEnabled: () => false, paused: () => [], syncWhere: () => process.env.WHERE || 'local',
    base: async () => ({ base: 'master', baseRef: 'master' }), log: m => console.log('  log:', m.split('\n')[0]), scheduleRefresh(){} };
  const s = new AutoSync(ctl);
  await s.tick(true);
  for (const [b, st] of ctl.statuses) console.log(b.padEnd(18), st.kind.padEnd(14), st.message);
  console.log(msgs.join('\n'));
  if (process.argv[4]) require('fs').writeFileSync(process.argv[4], JSON.stringify([...ctl.statuses]));
  s.dispose();
})();
