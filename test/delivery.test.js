// Linha do tempo, relatório do dia e changelog/versão. Uso: node test/delivery.test.js
const assert = require('assert');
const d = require('../out/delivery/core');
let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${e.stack || e}`);
  }
};

check('prefixo convencional: tipo, escopo, incompatível', () => {
  assert.deepStrictEqual(d.parseConventional('feat(auth): login OAuth'), { type: 'feat', scope: 'auth', breaking: false, text: 'login OAuth' });
  assert.strictEqual(d.parseConventional('fix!: troca API').breaking, true);
  assert.strictEqual(d.parseConventional('refactor: x', 'BREAKING CHANGE: y').breaking, true);
  assert.strictEqual(d.parseConventional('Ajusta README').type, 'other');
});

check('agrupamento em seções pt-BR, na ordem certa', () => {
  const g = d.groupEntries(['docs: a', 'fix: b', 'feat: c', 'ci: d', 'build: e', 'qualquer'].map(s => d.parseConventional(s)));
  assert.deepStrictEqual(g.map(x => x.title), ['Novidades', 'Correções', 'Documentação', 'Build e CI', 'Outras mudanças']);
  assert.strictEqual(g.find(x => x.title === 'Build e CI').entries.length, 2);
});

check('sugestão de versão (semver)', () => {
  const e = s => d.parseConventional(s);
  assert.strictEqual(d.suggestVersion('v1.1', [e('fix: x')]), '1.1.1');
  assert.strictEqual(d.suggestVersion('v1.1.0', [e('fix: x'), e('feat: y')]), '1.2.0');
  assert.strictEqual(d.suggestVersion('v1.4.2', [e('feat!: z')]), '2.0.0');
  assert.strictEqual(d.suggestVersion('0.3.0', [e('feat!: z')]), '0.4.0');
  assert.strictEqual(d.suggestVersion(undefined, [e('chore: x')]), '0.0.1');
  assert.strictEqual(d.tagName('1.2.0', 'v1.1'), 'v1.2.0');
  assert.strictEqual(d.tagName('1.2.0', '1.1.0'), '1.2.0');
});

check('mensagens de merge: GitHub, GitLab e local', () => {
  assert.deepStrictEqual(d.parseMergeMessage('Merge pull request #12 from dono/ai/login', 'feat: login OAuth\n\ncorpo'), { branch: 'ai/login', ref: '#12', title: 'feat: login OAuth' });
  const gl = d.parseMergeMessage("Merge branch 'ai/x' into 'master'", 'fix: corrige y\n\nCloses #3\n\nSee merge request grupo/app!5');
  assert.deepStrictEqual(gl, { branch: 'ai/x', ref: '!5', title: 'fix: corrige y' });
  assert.deepStrictEqual(d.parseMergeMessage("Merge branch 'fix/typo'", ''), { branch: 'fix/typo' });
});

check('changelog: bloco e inserção no topo sem apagar nada', () => {
  const block = d.renderChangelog('1.2.0', new Date(2026, 8, 27), [d.parseConventional('feat(api): nova rota'), { ...d.parseConventional('fix: erro'), ref: '#7' }]);
  assert.ok(block.startsWith('## 1.2.0 (2026-09-27)'));
  assert.ok(block.includes('### Novidades\n\n- **api:** nova rota'));
  assert.ok(block.includes('- erro (#7)'));
  const old = '# Changelog\n\nTexto de apresentação.\n\n## 1.1.0\n- antigo\n';
  const out = d.insertChangelog(old, block);
  assert.ok(out.indexOf('## 1.2.0') < out.indexOf('## 1.1.0'));
  assert.ok(out.includes('Texto de apresentação.') && out.includes('- antigo'));
  assert.ok(d.insertChangelog('', block).startsWith('# Changelog\n\n## 1.2.0'));
});

check('linha do tempo: commits por branch, merge pela ponta e filtro de período', () => {
  const commits = d.parseSourceLog('\x1erefs/heads/ai/a\x1f1700000000\n\x1erefs/heads/ai/a\x1f1700000600\n\x1erefs/heads/ai/b\x1f1600000000\n');
  assert.deepStrictEqual(commits.get('ai/a'), [1700000000000, 1700000600000]);
  const merges = d.parseMergeLog('\x1eaaa\x1f1700001000\x1fp1 tipA\x1fMerge branch \'ai/a\'\x1f\n');
  const rows = d.buildTimeline({
    now: 1700002000000,
    from: 1699000000000,
    branches: [{ name: 'ai/a', worktree: false, date: 1700000600000, head: 'tipA' }, { name: 'ai/b', worktree: true, date: 1600000000000 }],
    commits,
    merges,
    requests: [{ source: 'ai/a', ref: '#3', url: 'u', state: 'merged', createdAt: 1700000700000, approved: true }],
  });
  assert.deepStrictEqual(rows.map(r => r.branch), ['ai/a'], 'ai/b é antiga demais');
  assert.strictEqual(rows[0].merged, 1700001000000);
  assert.strictEqual(rows[0].prRef, '#3');
  assert.strictEqual(rows[0].born, 1700000000000);
});

check('relatório: resumo e seção por branch', () => {
  const md = d.renderReport({
    title: 'Relatório de hoje', repo: 'loja', base: 'master', generatedAt: Date.now(),
    branches: [
      { branch: 'ai/a', worktree: 'x', commits: [{ subject: 'feat: a', sha: '1234567890' }], files: 2, added: 10, deleted: 1, tokens: 12000, sessions: 1, pipelines: [{ name: 'CI', status: 'failed', url: 'p' }], request: { ref: '#4', title: 'A', url: 'r', state: 'open' } },
      { branch: 'ai/parada', commits: [], files: 0, added: 0, deleted: 0, tokens: 0, sessions: 0, pipelines: [] },
    ],
    merged: [{ branch: 'ai/z', ref: '#2', title: 'feat: z', date: 0 }],
    failedPipelines: [{ name: 'CI', branch: 'ai/a', url: 'p' }], passedPipelines: 3,
    totals: { commits: 1, files: 2, added: 10, deleted: 1, tokens: 12000, sessions: 1 },
  });
  assert.ok(md.startsWith('# Relatório de hoje — loja'));
  assert.ok(md.includes('**1** commit(s) em **1** branch(es)'));
  assert.ok(md.includes('#2 feat: z'));
  assert.ok(md.includes('3 passaram, 1 falharam'));
  assert.ok(md.includes('### `ai/a`') && md.includes('feat: a (`1234567`)'));
  assert.ok(!md.includes('ai/parada'), 'branch sem atividade fica de fora');
  assert.ok(md.includes('AgentYard'));
});

if (failures) process.exit(1);
