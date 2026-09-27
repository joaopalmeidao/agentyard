// Roda test/suite.js dentro de um VS Code real, com perfil e extensões isolados.
// Uso: node test/run.js   (VSCODE_PATH aponta para o Code.exe; o padrão é a instalação do sistema)
const path = require('path');
const { execSync } = require('child_process');
const { runTests } = require('@vscode/test-electron');
(async () => {
  const root = path.resolve(__dirname, '..');
  const demo = path.join(root, 'docs', '.tmp', 'itest');
  execSync(`bash scripts/make-demo.sh "${demo}"`, { cwd: root, stdio: 'ignore' });
  const tmp = path.join(root, 'docs', '.tmp', 'vscode-profile');
  require('fs').rmSync(tmp, { recursive: true, force: true });
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_PATH || 'C:/Program Files/Microsoft VS Code/Code.exe',
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(__dirname, 'suite.js'),
    launchArgs: [path.join(demo, 'loja-app'), '--user-data-dir', path.join(tmp, 'data'), '--extensions-dir', path.join(tmp, 'ext'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
  });
})().catch(e => {
  console.error(e);
  process.exit(1);
});
