#!/usr/bin/env node
// Gera o pacote (dist/<versão>/) a partir do worktree da main, de qualquer worktree.
//   npm run dist                  → empacota a versão atual do package.json da main
//   npm run dist -- patch         → sobe a versão (patch|minor|major|x.y.z) e empacota
//   npm run dist -- --force       → empacota mesmo com alterações não commitadas na main
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const force = args.includes('--force');
const bump = args.find(a => !a.startsWith('--'));

const sh = (cmd, cwd) => execSync(cmd, { cwd, encoding: 'utf8' }).trim();
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });

// Worktree com a main checada (o principal nem sempre é o da main).
const porcelain = sh('git worktree list --porcelain', __dirname);
const main = porcelain
  .split(/\r?\n\r?\n/)
  .map(block => ({
    dir: (block.match(/^worktree (.+)$/m) || [])[1],
    branch: (block.match(/^branch (.+)$/m) || [])[1],
  }))
  .find(w => w.branch === 'refs/heads/main');
if (!main) {
  console.error('Nenhum worktree com a branch main checada.');
  process.exit(1);
}
const root = path.resolve(main.dir);

if (!force) {
  const dirty = sh('git status --porcelain', root);
  if (dirty) {
    console.error(`A main (${root}) tem alterações não commitadas:\n${dirty}\n\nCommite/descarte ou use --force.`);
    process.exit(1);
  }
}

if (!fs.existsSync(path.join(root, 'node_modules'))) run('npm ci', root);

if (bump) {
  run(`npm version ${bump} --no-git-tag-version`, root);
  console.log('Versão alterada no package.json da main: lembre de adicionar a seção no CHANGELOG.md e commitar.');
}

run('npm run package', root);
