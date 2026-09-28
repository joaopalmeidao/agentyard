// Checkpoints por turno e autoria dos commits (notas). Uso: node test/turns.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const T = require('../out/claude/turns');

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtg-turns-'));
const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const w = (f, s) => {
  fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
  fs.writeFileSync(path.join(dir, f), s);
};
g('init', '-q', '-b', 'main');
g('config', 'user.email', 't@t');
g('config', 'user.name', 't');
g('config', 'core.autocrlf', 'false');
w('a.txt', 'a1\n');
w('.gitignore', 'ignorado.txt\n');
g('add', '-A');
g('commit', '-qm', 'inicial');

(async () => {
  let start;
  let end;
  await check('snapshot guarda rastreados e novos sem mexer no índice nem no HEAD', async () => {
    const headBefore = g('rev-parse', 'HEAD');
    w('b.txt', 'novo\n');
    w('ignorado.txt', 'x');
    g('add', 'b.txt');
    const statusBefore = g('status', '--porcelain');
    start = await T.snapshot(dir);
    assert.strictEqual(g('rev-parse', 'HEAD'), headBefore);
    assert.strictEqual(g('status', '--porcelain'), statusBefore);
    const files = g('ls-tree', '-r', '--name-only', start).split('\n');
    assert.deepStrictEqual(files.sort(), ['.gitignore', 'a.txt', 'b.txt']);
    assert.strictEqual(g('rev-parse', `${start}^`), headBefore);
  });

  await check('changesBetween e patchBetween', async () => {
    w('a.txt', 'a1\na2\n');
    w('c.txt', 'c\n');
    fs.rmSync(path.join(dir, 'b.txt'));
    end = await T.snapshot(dir);
    const ch = await T.changesBetween(dir, start, end);
    const by = Object.fromEntries(ch.map(c => [c.path, c]));
    assert.strictEqual(by['a.txt'].status, 'M');
    assert.strictEqual(by['a.txt'].additions, 1);
    assert.strictEqual(by['b.txt'].status, 'D');
    assert.strictEqual(by['c.txt'].status, 'A');
    const patch = await T.patchBetween(dir, start, end, ['a.txt']);
    assert.ok(patch.includes('+a2') && !patch.includes('c.txt'));
  });

  await check('restore volta ao checkpoint e dá para desfazer', async () => {
    const r = await T.restore(dir, start);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'a1\n');
    assert.ok(fs.existsSync(path.join(dir, 'b.txt')), 'b.txt volta');
    assert.ok(!fs.existsSync(path.join(dir, 'c.txt')), 'c.txt (criado depois) sai');
    assert.ok(fs.existsSync(path.join(dir, 'ignorado.txt')), 'ignorado fica');
    await T.restore(dir, r.before);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'a1\na2\n');
    assert.ok(fs.existsSync(path.join(dir, 'c.txt')));
  });

  await check('refs de checkpoint e limpeza', async () => {
    await T.keepRef(dir, `${T.TURN_REFS}/${T.refPart('ag/1 x')}/0001-start`, start);
    assert.ok(g('for-each-ref', T.TURN_REFS).includes('ag-1-x/0001-start'));
    assert.strictEqual(await T.pruneTurnRefs(dir, 7), 0, 'recentes ficam');
    assert.strictEqual(await T.pruneTurnRefs(dir, 0), 1);
    assert.strictEqual(g('for-each-ref', T.TURN_REFS), '');
  });

  await check('notas de autoria e blame', async () => {
    const from = g('rev-parse', 'HEAD');
    g('add', '-A');
    g('commit', '-qm', 'do agente');
    const shas = await T.newCommits(dir, from, g('rev-parse', 'HEAD'));
    assert.strictEqual(shas.length, 1);
    await T.addNotes(dir, shas, { session: 'sess-1', agent: 'Claude Code', turn: 2, prompt: 'Faça\no login' });
    const n = await T.noteOf(dir, shas[0]);
    assert.deepStrictEqual(n, { session: 'sess-1', agent: 'Claude Code', turn: 2, prompt: 'Faça o login' });
    const b = await T.blameLine(dir, 'a.txt', 2);
    assert.strictEqual(b.sha, shas[0]);
    assert.strictEqual(b.summary, 'do agente');
    assert.strictEqual(await T.noteOf(dir, from), undefined);
    w('a.txt', 'a1\na2\na3\n');
    assert.strictEqual(await T.blameLine(dir, 'a.txt', 3), undefined, 'linha não commitada');
  });

  fs.rmSync(dir, { recursive: true, force: true });
  if (failures) {
    console.log(`\n${failures} falha(s)`);
    process.exit(1);
  }
  console.log('\nturns: tudo ok');
})();
