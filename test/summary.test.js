// Resumo de branch/worktree: log × base, markdown e prompt para o agente (repositório git temporário).
// Uso: node test/summary.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { LOG_FORMAT, parseLog, summaryMarkdown, askPrompt, askPresets } = require('../out/summary/core');

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-summary-'));
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Teste');
git('config', 'user.email', 't@t');
git('config', 'core.autocrlf', 'false');
fs.writeFileSync(path.join(dir, 'a.txt'), '1\n');
git('add', '.');
git('commit', '-qm', 'inicial');
git('checkout', '-qb', 'ai/login');
fs.writeFileSync(path.join(dir, 'login.ts'), 'export const x = 1;\n');
git('add', '.');
git('commit', '-qm', 'Cria login', '-m', 'Corpo com detalhe\n\nsegunda linha');
fs.appendFileSync(path.join(dir, 'a.txt'), '2\n');
git('commit', '-qam', 'Ajusta a.txt | com barra');

const commits = parseLog(git('log', LOG_FORMAT, 'main..ai/login', '--'));
const facts = {
  label: 'ai/login',
  ref: 'ai/login',
  baseRef: 'main',
  path: dir,
  commits,
  behind: 0,
  diffStat: git('diff', '--stat', 'main...ai/login'),
  uncommitted: [' M a.txt'],
};

check('parseLog: commits × base, mais recente primeiro, com corpo multilinha', () => {
  assert.deepStrictEqual(commits.map(c => c.subject), ['Ajusta a.txt | com barra', 'Cria login']);
  assert.strictEqual(commits[1].body, 'Corpo com detalhe\n\nsegunda linha');
  assert.strictEqual(commits[0].author, 'Teste');
  assert.match(commits[0].sha, /^[0-9a-f]{40}$/);
  assert.ok(commits[0].date > 1e9);
  assert.deepStrictEqual(parseLog(''), []);
});

check('summaryMarkdown: cabeçalho, commits, arquivos e não commitado', () => {
  const md = summaryMarkdown(facts);
  assert.match(md, /^# ai\/login/);
  assert.match(md, /2 commit\(s\) ahead, 0 behind/);
  assert.match(md, /`[0-9a-f]{7}` Cria login — Teste/);
  assert.match(md, /  > segunda linha/);
  assert.match(md, /login\.ts/);
  assert.match(md, /## Uncommitted[\s\S]* M a\.txt/);
});

check('summaryMarkdown: branch sem worktree não tem seção de não commitado; limite de commits', () => {
  const md = summaryMarkdown({ ...facts, path: undefined, uncommitted: [] }, 1);
  assert.doesNotMatch(md, /Uncommitted/);
  assert.match(md, /No worktree/);
  assert.match(md, /and 1 more older commit\(s\)/);
  assert.match(summaryMarkdown({ ...facts, commits: [], diffStat: '' }), /No commits beyond the base/);
});

check('askPrompt: tarefa pronta, pergunta livre e branch sem worktree', () => {
  assert.strictEqual(askPresets().length, 4);
  const p = askPrompt(facts, 'review');
  assert.match(p, /^Review the changes/);
  assert.match(p, /git log main\.\.ai\/login/);
  assert.match(p, /- [0-9a-f]{7} Cria login/);
  assert.match(p, /Uncommitted \(1\)/);
  assert.match(p, /Don't change any file\.$/);
  const free = askPrompt({ ...facts, path: undefined, uncommitted: [] }, 'free', '  Por que mudou o a.txt?  ');
  assert.match(free, /^Por que mudou o a\.txt\?\n/);
  assert.match(free, /don't check it out/);
  assert.match(free, /If the question doesn't ask for changes/);
});

fs.rmSync(dir, { recursive: true, force: true });
if (failures) {
  console.log(`${failures} falha(s)`);
  process.exit(1);
}
