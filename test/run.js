// Roda test/suite.js dentro de um VS Code real, com perfil e extensões isolados.
// Uso: node test/run.js   (VSCODE_PATH aponta para o Code.exe; o padrão é a instalação do sistema)
const path = require('path');
const { execSync } = require('child_process');
const { runTests } = require('@vscode/test-electron');
(async () => {
  const root = path.resolve(__dirname, '..');
  const demo = path.join(root, 'docs', '.tmp', 'itest');
  execSync(`bash scripts/make-demo.sh "${demo}"`, { cwd: root, stdio: 'ignore' });
  // Segundo projeto, para os testes de vários projetos: uma worktree a mais para distinguir do primeiro.
  const demo2 = path.join(root, 'docs', '.tmp', 'itest2');
  execSync(`bash scripts/make-demo.sh "${demo2}"`, { cwd: root, stdio: 'ignore' });
  execSync(`git -C "${path.join(demo2, 'loja-app')}" worktree add -q "${path.join(demo2, 'worktrees', 'extra')}" -b ai/extra`, { stdio: 'ignore' });
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
  // Skill, comando, settings e memória sintéticos para a view "Claude: configuração".
  const fsx = require('fs');
  const lines = (...l) => l.join('\n') + '\n';
  fsx.mkdirSync(path.join(claudeDir, 'skills', 'revisar-pr'), { recursive: true });
  fsx.writeFileSync(path.join(claudeDir, 'skills', 'revisar-pr', 'SKILL.md'), lines('---', 'name: revisar-pr', 'description: Revisa um PR de teste', '---', '', '# revisar-pr'));
  fsx.mkdirSync(path.join(claudeDir, 'commands'), { recursive: true });
  fsx.writeFileSync(path.join(claudeDir, 'commands', 'ola.md'), lines('---', 'description: Comando de teste', '---', 'Diga olá.'));
  fsx.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(git status)'] }, chaveDesconhecida: 1 }, null, 2));
  const memDir = path.join(claudeDir, 'projects', path.join(demo, 'loja-app').replace(/[^A-Za-z0-9-]/g, '-'), 'memory');
  fsx.mkdirSync(memDir, { recursive: true });
  fsx.writeFileSync(path.join(memDir, 'preferencia-teste.md'), lines('---', 'name: preferencia-teste', 'description: "Memória sintética"', 'metadata:', '  type: feedback', '---', '', 'Use testes.'));
  fsx.writeFileSync(path.join(memDir, 'MEMORY.md'), lines('- [Preferência de teste](preferencia-teste.md) — memória sintética'));

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
