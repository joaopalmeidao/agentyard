// Branches empilhadas (src/stack/core.ts) num repositório de verdade. Uso: node test/stack.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('../out/stack/core');

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wtg-stack-'));
const repo = path.join(root, 'repo');
fs.mkdirSync(repo);
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const w = (cwd, f, s) => fs.writeFileSync(path.join(cwd, f), s);
const commit = (cwd, f, s, msg) => {
  w(cwd, f, s);
  g(cwd, 'add', '-A');
  g(cwd, 'commit', '-qm', msg);
};
g(repo, 'init', '-q', '-b', 'main');
g(repo, 'config', 'user.email', 't@t');
g(repo, 'config', 'user.name', 't');
g(repo, 'config', 'core.autocrlf', 'false');
commit(repo, 'a.txt', 'a\n', 'inicial');
const wtA = path.join(root, 'a');
const wtB = path.join(root, 'b');
g(repo, 'worktree', 'add', '-q', '-b', 'feat/a', wtA, 'main');
commit(wtA, 'a1.txt', '1\n', 'a1');
g(repo, 'worktree', 'add', '-q', '-b', 'feat/b', wtB, 'feat/a');
commit(wtB, 'b1.txt', '1\n', 'b1');

(async () => {
  await check('setParent/readStack guardam pai e ponta no config local', async () => {
    await S.setParent(repo, 'feat/b', 'feat/a');
    const links = await S.readStack(repo);
    assert.strictEqual(links.get('feat/b').parent, 'feat/a');
    assert.strictEqual(links.get('feat/b').tip, g(repo, 'rev-parse', 'feat/a'));
    assert.strictEqual(await S.stackState(repo, 'feat/b', links.get('feat/b'), 'main'), 'ok');
  });

  await check('descendants e stackOf', () => {
    const links = new Map([
      ['b', { parent: 'a' }],
      ['c', { parent: 'b' }],
      ['d', { parent: 'a' }],
      ['a', { parent: 'main' }],
    ]);
    assert.deepStrictEqual(S.descendants(links, 'a'), ['b', 'c', 'd']);
    assert.deepStrictEqual(S.stackOf(links, 'b'), ['main', 'a', 'b', 'c']);
  });

  await check('pai andou: behind; restack traz só os commits do filho para cima do pai', async () => {
    commit(wtA, 'a2.txt', '2\n', 'a2');
    const link = (await S.readStack(repo)).get('feat/b');
    assert.strictEqual(await S.stackState(repo, 'feat/b', link, 'main'), 'behind');
    const r = await S.restack(wtB, 'feat/b', link, 'main');
    assert.ok(r.ok, r.message);
    assert.strictEqual(g(wtB, 'log', '--format=%s', 'feat/a..feat/b'), 'b1');
    assert.strictEqual(g(repo, 'merge-base', 'feat/a', 'feat/b'), g(repo, 'rev-parse', 'feat/a'));
    const after = (await S.readStack(repo)).get('feat/b');
    assert.strictEqual(after.tip, g(repo, 'rev-parse', 'feat/a'));
    assert.strictEqual(await S.stackState(repo, 'feat/b', after, 'main'), 'ok');
  });

  await check('pai entrou na base: restack muda o pai para a base e tira da pilha', async () => {
    g(repo, 'merge', '-q', '--no-ff', 'feat/a', '-m', 'merge a');
    const link = (await S.readStack(repo)).get('feat/b');
    assert.strictEqual(await S.stackState(repo, 'feat/b', link, 'main'), 'parent-merged');
    const r = await S.restack(wtB, 'feat/b', link, 'main');
    assert.ok(r.ok, r.message);
    assert.strictEqual(r.parent, 'main');
    assert.strictEqual((await S.readStack(repo)).has('feat/b'), false);
    assert.strictEqual(g(wtB, 'log', '--format=%s', 'main..feat/b'), 'b1');
  });

  await check('conflito: desfaz o rebase e avisa; alterações não commitadas: não mexe', async () => {
    const wtC = path.join(root, 'c');
    g(repo, 'worktree', 'add', '-q', '-b', 'feat/c', wtC, 'feat/b');
    commit(wtC, 'b1.txt', 'c\n', 'c muda b1');
    await S.setParent(repo, 'feat/c', 'feat/b');
    commit(wtB, 'b1.txt', 'b2\n', 'b muda b1');
    const link = (await S.readStack(repo)).get('feat/c');
    const head = g(wtC, 'rev-parse', 'HEAD');
    const r = await S.restack(wtC, 'feat/c', link, 'main');
    assert.ok(!r.ok && r.conflict);
    assert.strictEqual(g(wtC, 'rev-parse', 'HEAD'), head, 'nada mudou');
    assert.strictEqual(g(wtC, 'status', '--porcelain'), '');
    w(wtC, 'b1.txt', 'sujo\n');
    const r2 = await S.restack(wtC, 'feat/c', link, 'main');
    assert.strictEqual(r2.message, 'uncommitted changes');
    await S.clearParent(repo, 'feat/c');
    assert.strictEqual((await S.readStack(repo)).has('feat/c'), false);
  });

  fs.rmSync(root, { recursive: true, force: true });
  if (failures) {
    console.log(`\n${failures} falha(s)`);
    process.exit(1);
  }
  console.log('\nstack: tudo ok');
})();
