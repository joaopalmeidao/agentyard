// Partes puras de src/gitops e o mecanismo do rebase sem editor, com git de verdade num repositório
// temporário. Uso: node test/gitOps.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildTodo, validatePlan, movePlan, parseStashList, stashTitle, parseNameStatus, parseStatusPaths } = require('../out/gitops/core');

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
  assert.match(validatePlan([{ sha: 'a', subject: 'A', action: 'squash' }]), /anterior/);
  assert.match(validatePlan([{ sha: 'a', subject: 'A', action: 'drop' }]), /descarta todos/);
  assert.match(validatePlan([{ sha: 'a', subject: 'A', action: 'reword', message: ' ' }]), /mensagem/);
  // drop no primeiro e squash no segundo: o squash junta com... nada. Inválido.
  assert.match(validatePlan([{ sha: 'a', subject: 'A', action: 'drop' }, { sha: 'b', subject: 'B', action: 'fixup' }]), /anterior/);
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

if (failures) process.exit(1);
