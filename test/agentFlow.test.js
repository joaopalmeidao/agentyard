// Leituras baratas do HEAD (sem processo git) e nomes das tentativas. Uso: node test/agentFlow.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'vscode' ? 'vscode' : orig.call(this, r, ...a);
};
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: {} };
const { readHead, indexMtime } = require('../out/agentFlow/head');
const { slugify } = require('../out/agentFlow/attempts');

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtg-head-'));
const main = path.join(dir, 'repo');
const git = (args, cwd = main) => execSync(`git -c user.name=t -c user.email=t@t ${args}`, { cwd, stdio: 'pipe' }).toString().trim();
fs.mkdirSync(main);
git('init -q -b main');
git('commit -q --allow-empty -m um');
const wt = path.join(dir, 'wt');
git(`worktree add -q -b feat "${wt}"`);

check('HEAD da principal (ref solta)', () => assert.strictEqual(readHead(main), git('rev-parse HEAD')));
check('HEAD de uma worktree segue o commondir', () => {
  git('commit -q --allow-empty -m dois', wt);
  assert.strictEqual(readHead(wt), git('rev-parse HEAD', wt));
});
check('HEAD depois de git pack-refs (packed-refs)', () => {
  git('pack-refs --all');
  assert.ok(!fs.existsSync(path.join(main, '.git', 'refs', 'heads', 'feat')));
  assert.strictEqual(readHead(wt), git('rev-parse HEAD', wt));
});
check('HEAD destacado', () => {
  git('checkout -q --detach', wt);
  assert.strictEqual(readHead(wt), git('rev-parse HEAD', wt));
});
check('índice: mtime muda com git add', () => {
  const before = indexMtime(wt);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'x');
  git('add a.txt', wt);
  assert.ok(indexMtime(wt) >= before && indexMtime(wt) > 0);
});
check('pasta que não é worktree', () => assert.strictEqual(readHead(dir), undefined));
check('slugify dos nomes de tentativa', () => {
  assert.strictEqual(slugify('Implementar cache de preços!'), 'implementar-cache-de-precos');
  assert.strictEqual(slugify('#12 Ação: corrigir LOGIN com OAuth e SSO'), '12-acao-corrigir-login-com');
  assert.strictEqual(slugify('***'), 'tarefa');
});

fs.rmSync(dir, { recursive: true, force: true });
if (failures) process.exit(1);
