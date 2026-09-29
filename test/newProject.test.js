// Criação de projeto do zero (src/newProject.ts) com git de verdade numa pasta temporária.
// Uso: node test/newProject.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createProject, validateProjectName, checkTarget } = require('../out/newProject');

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
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'newproject-'));
  // Identidade só para estes commits, sem depender da configuração da máquina.
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Teste';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'teste@example.com';

  await check('validateProjectName: vazio, caracteres proibidos, nomes reservados', () => {
    assert.ok(validateProjectName('  '));
    assert.ok(validateProjectName('a/b'));
    assert.ok(validateProjectName('a:b'));
    assert.ok(validateProjectName('nome.'));
    assert.ok(validateProjectName('CON'));
    assert.ok(validateProjectName('nul.txt'));
    assert.strictEqual(validateProjectName('meu-app'), undefined);
    assert.strictEqual(validateProjectName('Meu App 2'), undefined);
  });

  await check('createProject: pasta, branch pedida, README, .gitignore e commit inicial', async () => {
    const r = await createProject(tmp, ' loja ', { branch: 'main', readme: true, gitignore: 'node', commit: true });
    assert.strictEqual(r.path, path.join(tmp, 'loja'));
    assert.strictEqual(r.committed, true);
    assert.strictEqual(git(r.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.strictEqual(git(r.path, 'log', '--format=%s'), 'Initial commit');
    assert.deepStrictEqual(git(r.path, 'ls-files').split('\n').sort(), ['.gitignore', 'README.md']);
    assert.match(fs.readFileSync(path.join(r.path, '.gitignore'), 'utf8'), /node_modules\//);
    assert.strictEqual(fs.readFileSync(path.join(r.path, 'README.md'), 'utf8'), '# loja\n');
    // Com commit, dá para criar worktrees logo em seguida.
    git(r.path, 'worktree', 'add', '-q', path.join(tmp, 'loja-wt'), '-b', 'ai/x');
  });

  await check('checkTarget/createProject: recusa pasta que já é repositório', async () => {
    assert.match(checkTarget(path.join(tmp, 'loja')), /already a git repository/);
    await assert.rejects(createProject(tmp, 'loja', { readme: true, gitignore: 'none', commit: true }), /already a git repository/);
  });

  await check('createProject: pasta existente sem git vira projeto sem sobrescrever arquivos', async () => {
    const dir = path.join(tmp, 'existente');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), 'meu readme\n');
    fs.writeFileSync(path.join(dir, 'app.py'), 'print(1)\n');
    const r = await createProject(tmp, 'existente', { branch: 'dev', readme: true, gitignore: 'python', commit: true });
    assert.strictEqual(r.branch, 'dev');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'meu readme\n');
    assert.deepStrictEqual(git(dir, 'ls-files').split('\n').sort(), ['.gitignore', 'README.md', 'app.py']);
  });

  await check('createProject: sem README/.gitignore o commit inicial sai vazio', async () => {
    const r = await createProject(tmp, 'vazio', { readme: false, gitignore: 'none', commit: true });
    assert.strictEqual(r.committed, true);
    assert.strictEqual(git(r.path, 'ls-files'), '');
    assert.ok(r.branch);
  });

  await check('createProject: sem commit quando não pedido', async () => {
    const r = await createProject(tmp, 'semcommit', { readme: true, gitignore: 'generic', commit: false });
    assert.strictEqual(r.committed, false);
    assert.throws(() => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r.path, stdio: 'ignore' }));
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  if (failures) {
    console.log(`${failures} falha(s)`);
    process.exit(1);
  }
})();
