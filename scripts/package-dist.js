#!/usr/bin/env node
// Gera dist/<versão>/ com o .vsix e o material de publicação:
// README, CHANGELOG, notas da versão, LICENSE, logo, social preview, prints e vídeo.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const out = path.join(root, 'dist', pkg.version);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

execSync(`npx vsce package --out "${path.join(out, `${pkg.name}-${pkg.version}.vsix`)}"`, {
  cwd: root,
  stdio: 'inherit',
});

const copy = (from, to = path.basename(from)) => {
  const src = path.join(root, from);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(out, to), { recursive: true });
};
copy('README.md');
copy('CHANGELOG.md');
copy('LICENSE');
copy('media/logo.png');
copy('docs/social-preview.png');
copy('docs/prints', 'prints');
copy('docs/video', 'video');

// Notas só desta versão, tiradas da seção "## <versão>" do CHANGELOG.
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const section = changelog.split(/^## /m).find(s => s.split('\n')[0].trim() === pkg.version);
if (section) {
  fs.writeFileSync(path.join(out, 'RELEASE_NOTES.md'), `# ${pkg.displayName} ${pkg.version}\n\n${section.slice(section.indexOf('\n') + 1).trim()}\n`);
} else {
  console.warn(`Aviso: CHANGELOG.md não tem seção "## ${pkg.version}"; RELEASE_NOTES.md não foi gerado.`);
}

console.log(`\nPronto: ${path.relative(root, out)}`);
