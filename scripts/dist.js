#!/usr/bin/env node
// Gera o pacote (dist/<versão>/) a partir do worktree atual.
//   npm run dist                  → empacota a versão atual do package.json
//   npm run dist -- patch         → sobe a versão (patch|minor|major|x.y.z) e empacota
//   npm run dist -- --force       → empacota mesmo com alterações não commitadas
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const force = args.includes('--force');
const bump = args.find(a => !a.startsWith('--'));

const sh = (cmd, cwd) => execSync(cmd, { cwd, encoding: 'utf8' }).trim();
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });

// Raiz do worktree onde o script está (o de onde o npm run dist foi chamado).
const root = path.resolve(sh('git rev-parse --show-toplevel', __dirname));

if (!force) {
  const dirty = sh('git status --porcelain', root);
  if (dirty) {
    console.error(`O worktree (${root}) tem alterações não commitadas:\n${dirty}\n\nCommite/descarte ou use --force.`);
    process.exit(1);
  }
}

if (!fs.existsSync(path.join(root, 'node_modules'))) run('npm ci', root);

if (bump) {
  run(`npm version ${bump} --no-git-tag-version`, root);
  console.log('Versão alterada no package.json: lembre de adicionar a seção no CHANGELOG.md e commitar.');
}

run('npm run package', root);
