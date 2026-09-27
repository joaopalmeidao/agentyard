// Partes puras de src/gitops e o mecanismo do rebase sem editor, com git de verdade num repositório
// temporário. Uso: node test/gitOps.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildTodo, validatePlan, movePlan, parseStashList, stashTitle, parseNameStatus, parseStatusPaths, parseUncommitted, parseNumstat, discardEffect, discardSummary } = require('../out/gitops/core');

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

check('validatePlan: squash no primeiro, tudo descartado, reword sem mensagem', () => {
  assert.match(validatePlan([{ sha: 'a', subject: 'A', action: 'squash' }]), /earlier commit/);
  assert.match(validatePlan([{ sha: 'a', subject: 'A', action: 'drop' }]), /drops every commit/);
  assert.match(validatePlan([{ sha: 'a', subject: 'A', action: 'reword', message: ' ' }]), /new message/);
  // drop no primeiro e squash no segundo: o squash junta com... nada. Inválido.
  assert.match(validatePlan([{ sha: 'a', subject: 'A', action: 'drop' }, { sha: 'b', subject: 'B', action: 'fixup' }]), /earlier commit/);
  assert.strictEqual(validatePlan([{ sha: 'a', subject: 'A', action: 'pick' }, { sha: 'b', subject: 'B', action: 'fixup' }]), undefined);
});

check('buildTodo: ações e reword via exec com arquivo de mensagem', () => {
  const todo = buildTodo(
    [
      { sha: 'aaa', subject: 'A', action: 'pick' },
      { sha: 'bbb', subject: 'B\nquebra', action: 'reword', message: 'B nova' },
      { sha: 'ccc', subject: 'C', action: 'fixup' },
    ],
    i => `C:/tmp/msg-${i}.txt`,
  );
  assert.strictEqual(todo, 'pick aaa A\npick bbb B quebra\nexec git commit --amend --no-verify -F "C:/tmp/msg-1.txt"\nfixup ccc C\n');
});

check('movePlan: troca vizinhos e ignora as pontas', () => {
  const p = [{ sha: 'a' }, { sha: 'b' }, { sha: 'c' }];
  assert.deepStrictEqual(movePlan(p, 1, -1).map(x => x.sha), ['b', 'a', 'c']);
  assert.deepStrictEqual(movePlan(p, 2, 1).map(x => x.sha), ['a', 'b', 'c']);
});

check('stash: lista, branch de origem e título', () => {
  const list = parseStashList('stash@{0}\x1fs0\x1fOn ai/x: minha mensagem\x1f100\nstash@{1}\x1fs1\x1fWIP on feat/y: abc123 assunto\x1f90\n');
  assert.deepStrictEqual(list.map(e => [e.ref, e.branch]), [['stash@{0}', 'ai/x'], ['stash@{1}', 'feat/y']]);
  assert.strictEqual(stashTitle(list[0]), 'minha mensagem');
  assert.strictEqual(stashTitle(list[1]), 'abc123 assunto');
});

check('diff e status: caminhos e letras', () => {
  assert.deepStrictEqual([...parseNameStatus('M\tsrc/a.ts\nA\tnovo.ts\n')], [['src/a.ts', 'M'], ['novo.ts', 'A']]);
  assert.deepStrictEqual(parseStatusPaths(' M src/a.ts\0?? tmp/\0?? b.txt\0'), ['src/a.ts', 'b.txt']);
});

check('rebase sem editor (git real): reordena, junta com fixup e troca mensagem', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtgraph-rebase-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@t');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  for (const n of ['um', 'dois', 'tres']) {
    fs.writeFileSync(path.join(dir, `${n}.txt`), `${n}\n`);
    git('add', '.');
    git('commit', '-qm', `commit ${n}`);
  }
  const [c1, c2, c3] = git('log', '--reverse', '--format=%H', `${base}..HEAD`).split('\n');
  // novo roteiro: tres primeiro (com nova mensagem), um, e dois juntando em um (fixup)
  const msgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtgraph-msg-'));
  const msgFile = i => path.join(msgDir, `msg-${i}.txt`).replace(/\\/g, '/');
  const plan = [
    { sha: c3, subject: 'commit tres', action: 'reword', message: 'três, agora primeiro' },
    { sha: c1, subject: 'commit um', action: 'pick' },
    { sha: c2, subject: 'commit dois', action: 'fixup' },
  ];
  plan.forEach((s, i) => s.action === 'reword' && fs.writeFileSync(msgFile(i), s.message + '\n'));
  const todo = path.join(msgDir, 'todo.txt');
  fs.writeFileSync(todo, buildTodo(plan, msgFile));
  execFileSync('git', ['rebase', '-i', base], {
    cwd: dir,
    env: { ...process.env, GIT_SEQUENCE_EDITOR: `cp "${todo.replace(/\\/g, '/')}"`, GIT_EDITOR: 'true' },
    stdio: 'pipe',
  });
  const log = git('log', '--reverse', '--format=%s', `${base}..HEAD`).split('\n');
  assert.deepStrictEqual(log, ['três, agora primeiro', 'commit um']);
  // o conteúdo final continua com os três arquivos
  for (const n of ['um', 'dois', 'tres']) assert.ok(fs.existsSync(path.join(dir, `${n}.txt`)), n);
  assert.strictEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort().join(','), 'dois.txt,um.txt');
});

check('não commitadas: tipo, letra e efeito do descarte', () => {
  const list = parseUncommitted(' M src/a.ts\0M  b.ts\0MM c.ts\0A  novo.ts\0 D velho.ts\0?? tmp/x.txt\0UU conf.ts\0?? pasta/\0');
  assert.deepStrictEqual(
    list.map(u => [u.path, u.letter, u.kind]),
    [
      ['b.ts', 'M', 'staged'],
      ['c.ts', 'M', 'mixed'],
      ['conf.ts', '!', 'conflict'],
      ['novo.ts', 'A', 'staged'],
      ['src/a.ts', 'M', 'unstaged'],
      ['tmp/x.txt', '?', 'untracked'],
      ['velho.ts', 'D', 'unstaged'],
    ],
  );
  const num = parseNumstat('3\t1\tsrc/a.ts\0-\t-\timg.png\0');
  assert.deepStrictEqual(num.get('src/a.ts'), { added: 3, deleted: 1, binary: false });
  assert.strictEqual(num.get('img.png').binary, true);
  assert.strictEqual(discardEffect({ path: 'a', letter: 'M', kind: 'unstaged', added: 3, deleted: 1 }), 'back to the last commit (+3 −1)');
  assert.match(discardEffect({ path: 'a', letter: '?', kind: 'untracked', added: 20 }), /deleted \(new file, 20 line/);
  assert.match(discardEffect({ path: 'a', letter: 'D', kind: 'unstaged' }), /comes back/);
  const many = Array.from({ length: 20 }, (_, i) => ({ path: `f${i}`, letter: 'M', kind: 'unstaged' }));
  assert.match(discardSummary(many, 5), /… and 15 more file/);
});

check('descarte parcial (git real): stash push -u -- <arquivos> tira só os escolhidos e o apply devolve', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtgraph-discard-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const w = (f, t) => fs.writeFileSync(path.join(dir, f), t);
  const r = f => fs.readFileSync(path.join(dir, f), 'utf8');
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@t');
  git('config', 'core.autocrlf', 'false');
  w('a.txt', 'a\n');
  w('b.txt', 'b\n');
  w('c.txt', 'c\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  w('a.txt', 'a mudado\n'); // descartar
  w('b.txt', 'b mudado\n'); // manter
  fs.unlinkSync(path.join(dir, 'c.txt')); // descartar (volta a existir)
  w('novo.txt', 'novo\n'); // descartar (não rastreado)
  w('fica.txt', 'fica\n'); // manter (não rastreado)
  w('add.txt', 'add\n');
  git('add', 'add.txt'); // descartar (adicionado no stage)
  const before = parseUncommitted(execFileSync('git', ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' }));
  assert.strictEqual(before.length, 6);
  git('stash', 'push', '--include-untracked', '-m', 'worktree-graph: descartado', '--', 'a.txt', 'c.txt', 'novo.txt', 'add.txt');
  assert.strictEqual(r('a.txt'), 'a\n');
  assert.strictEqual(r('c.txt'), 'c\n');
  assert.ok(!fs.existsSync(path.join(dir, 'novo.txt')));
  assert.ok(!fs.existsSync(path.join(dir, 'add.txt')));
  assert.strictEqual(r('b.txt'), 'b mudado\n');
  assert.strictEqual(r('fica.txt'), 'fica\n');
  assert.match(git('stash', 'list', '--format=%gs'), /descartado$/);
  // desfazer
  git('stash', 'apply', git('rev-parse', 'stash@{0}'));
  assert.strictEqual(r('a.txt'), 'a mudado\n');
  assert.ok(!fs.existsSync(path.join(dir, 'c.txt')));
  assert.strictEqual(r('novo.txt'), 'novo\n');
  assert.strictEqual(r('add.txt'), 'add\n');
});

if (failures) process.exit(1);
