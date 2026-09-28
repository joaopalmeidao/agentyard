// Checkout parcial, submódulos e bisect (src/sparse.ts, src/bisect.ts). Uso: node test/sparse.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const SP = require('../out/sparse');
const B = require('../out/bisect');

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${e.stack || e}`);
  }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wtg-sparse-'));
const repo = path.join(root, 'repo');
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const w = (f, s) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), s);
};
fs.mkdirSync(repo);
g(repo, 'init', '-q', '-b', 'main');
g(repo, 'config', 'user.email', 't@t');
g(repo, 'config', 'user.name', 't');
g(repo, 'config', 'core.autocrlf', 'false');
w('README.md', 'x\n');
w('packages/api/index.js', 'api\n');
w('packages/web/index.js', 'web\n');
w('libs/shared/a.js', 'a\n');
w('.github/ci.yml', 'ci\n');
g(repo, 'add', '-A');
g(repo, 'commit', '-qm', 'inicial');

(async () => {
  await check('listDirs até 2 níveis, sem pastas ocultas', async () => {
    assert.deepStrictEqual((await SP.listDirs(repo, 'main')).sort(), ['libs', 'libs/shared', 'packages', 'packages/api', 'packages/web']);
    assert.deepStrictEqual(await SP.listDirs(repo, 'main', 1), ['libs', 'packages']);
  });

  await check('coneDirs normaliza e tira aninhadas', () => {
    assert.deepStrictEqual(SP.coneDirs([' packages/api/ ', 'packages', '\\libs\\shared', 'libs/shared', '']), ['libs/shared', 'packages']);
  });

  await check('worktree com checkout parcial só traz as pastas escolhidas (e a raiz)', async () => {
    const wt = path.join(root, 'wt-api');
    g(repo, 'worktree', 'add', '-q', '--no-checkout', '-b', 'ai/api', wt, 'main');
    await SP.applySparse(wt, ['packages/api']);
    assert.ok(fs.existsSync(path.join(wt, 'README.md')), 'raiz vem');
    assert.ok(fs.existsSync(path.join(wt, 'packages/api/index.js')));
    assert.ok(!fs.existsSync(path.join(wt, 'packages/web')), 'web fica de fora');
    assert.ok(!fs.existsSync(path.join(wt, 'libs')));
    assert.strictEqual(g(wt, 'status', '--porcelain'), '', 'worktree limpa');
    assert.deepStrictEqual(await SP.sparseDirs(wt), ['packages/api']);
    assert.strictEqual(await SP.sparseDirs(repo), undefined, 'a principal continua completa');
    await SP.setSparse(wt, ['packages/api', 'libs/shared']);
    assert.ok(fs.existsSync(path.join(wt, 'libs/shared/a.js')));
    await SP.setSparse(wt, []);
    assert.ok(fs.existsSync(path.join(wt, 'packages/web/index.js')), 'desligado: tudo');
    assert.strictEqual(SP.hasSubmodules(wt), false);
  });

  await check('bisect acha o primeiro commit ruim numa worktree temporária e limpa depois', async () => {
    const good = g(repo, 'rev-parse', 'HEAD');
    for (let i = 1; i <= 6; i++) {
      w(`f${i}.txt`, `${i}\n`);
      if (i === 4) w('broken', 'x');
      g(repo, 'add', '-A');
      g(repo, 'commit', '-qm', `c${i}`);
    }
    const bad = g(repo, 'rev-parse', 'HEAD');
    const tmp = path.join(root, 'bisect-tmp');
    const r = await B.bisectRun(repo, tmp, good, bad, 'test ! -f broken');
    assert.ok(r.sha, r.log);
    assert.strictEqual(g(repo, 'log', '-1', '--format=%s', r.sha), 'c4');
    assert.ok(!fs.existsSync(tmp), 'worktree temporária removida');
    assert.ok(!g(repo, 'worktree', 'list').includes('bisect-tmp'));
    assert.strictEqual(g(repo, 'rev-parse', 'HEAD'), bad, 'a principal não mexeu');
    assert.strictEqual(B.parseBisect('abc1234 is the first bad commit\ncommit abc'), 'abc1234');
    assert.strictEqual(B.parseBisect('nada'), undefined);
  });

  fs.rmSync(root, { recursive: true, force: true });
  if (failures) {
    console.log(`\n${failures} falha(s)`);
    process.exit(1);
  }
  console.log('\nsparse: tudo ok');
})();
