// Remover uma worktree não pode apagar o destino de junctions/symlinks dentro dela
// (no Windows o git apaga o conteúdo do destino). Uso: node test/junction.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { Repo, unlinkExternalLinks } = require('../out/git');

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

const link = (target, at) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wtgraph-junction-'));
  const repoDir = path.join(tmp, 'repo');
  const git = (c, cwd = repoDir) => execSync(`git -c user.name=t -c user.email=t@t ${c}`, { cwd, stdio: 'pipe' }).toString();
  fs.mkdirSync(repoDir);
  git('init -q -b main');
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'a');
  git('add .');
  git('commit -q -m inicial');

  // "node_modules" da principal e um pacote de "npm link", ambos fora da worktree
  const sharedModules = path.join(repoDir, 'node_modules');
  fs.mkdirSync(path.join(sharedModules, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(sharedModules, 'lib', 'index.js'), 'module.exports = 1;');
  const linkedPkg = path.join(tmp, 'pacote-local');
  fs.mkdirSync(linkedPkg);
  fs.writeFileSync(path.join(linkedPkg, 'index.js'), 'fonte do pacote');

  await check('remover worktree preserva o destino das junctions (node_modules compartilhado e npm link)', async () => {
    const wt = path.join(tmp, 'wt');
    git(`worktree add -q -b feat/x "${wt}" main`);
    link(sharedModules, path.join(wt, 'node_modules'));
    fs.mkdirSync(path.join(wt, 'app', 'node_modules', '@escopo'), { recursive: true });
    link(linkedPkg, path.join(wt, 'app', 'node_modules', '@escopo', 'pacote'));
    // atalho para dentro da própria worktree: pode ficar (o git apaga junto, sem sair da pasta)
    link(path.join(wt, 'app'), path.join(wt, 'atalho-interno'));

    const repo = await Repo.open(repoDir);
    const r = await repo.removeWorktree(wt, true);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.ok(!fs.existsSync(wt), 'worktree removida');
    assert.ok(fs.existsSync(path.join(sharedModules, 'lib', 'index.js')), 'node_modules da principal intacto');
    assert.strictEqual(fs.readFileSync(path.join(linkedPkg, 'index.js'), 'utf8'), 'fonte do pacote', 'pacote do npm link intacto');
  });

  await check('unlinkExternalLinks só desfaz atalhos para fora e não entra no conteúdo dos pacotes', () => {
    const d = path.join(tmp, 'solto');
    fs.mkdirSync(path.join(d, 'node_modules', 'real', 'node_modules'), { recursive: true });
    link(linkedPkg, path.join(d, 'node_modules', 'ligado'));
    link(path.join(d, 'node_modules', 'real'), path.join(d, 'interno'));
    // atalho profundo dentro de um pacote real: fora do alcance de propósito (é conteúdo do pacote)
    link(linkedPkg, path.join(d, 'node_modules', 'real', 'node_modules', 'fundo'));
    const done = unlinkExternalLinks(d).map(p => path.relative(d, p).split(path.sep).join('/'));
    assert.deepStrictEqual(done, ['node_modules/ligado']);
    assert.ok(fs.existsSync(path.join(d, 'interno')), 'atalho interno fica');
    assert.ok(fs.existsSync(path.join(linkedPkg, 'index.js')));
  });

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // no Windows algum arquivo pode seguir aberto; é pasta temporária
  }
  if (failures) process.exit(1);
})();
