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
  // Logs sintéticos do Claude Code: o VS Code de teste nunca lê os dados reais de ~/.claude.
  const claudeDir = path.join(root, 'docs', '.tmp', 'itest-claude');
  const proj = path.join(claudeDir, 'projects', 'demo');
  require('fs').rmSync(claudeDir, { recursive: true, force: true });
  require('fs').mkdirSync(proj, { recursive: true });
  const ts = new Date(Date.now() - 3600_000).toISOString();
  const cwd = path.join(demo, 'worktrees', 'ai-login-oauth');
  require('fs').writeFileSync(
    path.join(proj, 'sessao-teste.jsonl'),
    [
      JSON.stringify({ type: 'user', sessionId: 'sessao-teste', cwd, gitBranch: 'ai/login-oauth', timestamp: ts, message: { role: 'user', content: 'Implemente o login OAuth' } }),
      JSON.stringify({ type: 'assistant', sessionId: 'sessao-teste', cwd, timestamp: ts, message: { id: 'm1', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'Feito: cliente OAuth criado.' }], usage: { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 500 } } }),
    ].join('\n') + '\n',
  );
  await runTests({
    extensionTestsEnv: { CLAUDE_CONFIG_DIR: claudeDir },
    vscodeExecutablePath: process.env.VSCODE_PATH || 'C:/Program Files/Microsoft VS Code/Code.exe',
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(__dirname, 'suite.js'),
    launchArgs: [path.join(demo, 'loja-app'), '--user-data-dir', path.join(tmp, 'data'), '--extensions-dir', path.join(tmp, 'ext'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
  });
})().catch(e => {
  console.error(e);
  process.exit(1);
});
