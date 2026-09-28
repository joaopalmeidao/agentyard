// Guarda da worktree (PreToolUse), descrição de pedidos de permissão e contexto do SessionStart.
// Uso: node test/claudeGuard.test.js
const assert = require('assert');
const path = require('path');
const { guardToolUse, shellCommands, describeToolRequest } = require('../out/claude/guard');
const { sessionContext } = require('../out/claude/sessionContext');
// reviewComments importa o vscode (só usa em tempo de execução): um módulo vazio basta para o reviewText
const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'vscode' ? 'vscode' : orig.call(this, r, ...a);
};
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: {} };
const { reviewText } = require('../out/claude/reviewComments');

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

const root = path.resolve('/repos');
const main = path.join(root, 'loja');
const wt = path.join(root, 'loja.worktrees', 'ai-login');
const other = path.join(root, 'loja.worktrees', 'ai-precos');
const ctx = { worktree: wt, others: [{ path: main, name: 'master' }, { path: other, name: 'ai/precos' }], protectedBranches: ['master', 'develop'] };
const strict = { ...ctx, strict: true };
const bash = (command, c = ctx, cwd = wt) => guardToolUse({ tool_name: 'Bash', tool_input: { command }, cwd }, c);

check('shellCommands separa comandos e respeita aspas', () => {
  assert.deepStrictEqual(shellCommands('cd "a b" && git status; echo x|wc -l'), [['cd', 'a b'], ['git', 'status'], ['echo', 'x'], ['wc', '-l']]);
  assert.deepStrictEqual(shellCommands("git commit -m 'a; b'"), [['git', 'commit', '-m', 'a; b']]);
});

check('edição dentro da própria worktree passa; em outra, não', () => {
  assert.strictEqual(guardToolUse({ tool_name: 'Edit', tool_input: { file_path: path.join(wt, 'src', 'a.ts') } }, ctx), undefined);
  assert.match(guardToolUse({ tool_name: 'Write', tool_input: { file_path: path.join(other, 'src', 'a.ts') } }, ctx), /ai\/precos/);
  assert.match(guardToolUse({ tool_name: 'Edit', tool_input: { file_path: path.join(main, 'package.json') } }, ctx), /master/);
  // fora do repositório (ex.: memória do Claude) fica com as permissões normais
  assert.strictEqual(guardToolUse({ tool_name: 'Write', tool_input: { file_path: path.resolve('/tmp/x.md') } }, ctx), undefined);
  // caminho relativo resolve pelo cwd
  assert.match(guardToolUse({ tool_name: 'Edit', tool_input: { file_path: '../ai-precos/x.ts' }, cwd: wt }, ctx), /ai\/precos/);
});

check('worktree aninhada na principal não é confundida com a principal', () => {
  const nested = path.join(main, '.worktrees', 'ai-x');
  const c = { worktree: nested, others: [{ path: main, name: 'master' }], protectedBranches: ['master'] };
  assert.strictEqual(guardToolUse({ tool_name: 'Edit', tool_input: { file_path: path.join(nested, 'a.ts') } }, c), undefined);
  assert.match(guardToolUse({ tool_name: 'Edit', tool_input: { file_path: path.join(main, 'a.ts') } }, c), /master/);
});

check('git perigoso', () => {
  assert.match(bash('git push --force'), /force push/);
  assert.match(bash('git push -f origin ai/login'), /force push/);
  assert.match(bash('git push origin +ai/login'), /force push/);
  assert.match(bash('git push origin HEAD:master'), /master/);
  assert.strictEqual(bash('git push -u origin ai/login'), undefined);
  assert.match(bash('git checkout master'), /master/);
  assert.match(bash('git switch develop'), /develop/);
  assert.strictEqual(bash('git checkout -- src/a.ts'), undefined);
  assert.strictEqual(bash('git checkout HEAD~1 -- src/a.ts'), undefined);
  assert.match(bash('git worktree remove ../ai-precos'), /worktree/i);
  assert.match(bash('git branch -D master'), /master/);
  assert.strictEqual(bash('git branch -D ai/velha'), undefined);
  assert.strictEqual(bash('git commit -am "msg" && git log --oneline'), undefined);
});

check('modo estrito: não troca a branch da worktree', () => {
  assert.strictEqual(bash('git checkout -b ai/outra'), undefined);
  assert.match(bash('git checkout -b ai/outra', strict), /branch/);
  assert.match(bash('git switch ai/outra', strict), /ai\/outra/);
  assert.strictEqual(bash('git switch ai/outra'), undefined);
});

check('comandos em outra worktree', () => {
  assert.match(bash(`cd ${other} && npm install`), /ai\/precos/);
  assert.match(bash(`git -C ${other} commit -am x`), /ai\/precos/);
  assert.strictEqual(bash(`git -C ${other} log --oneline`), undefined, 'leitura pode');
  assert.strictEqual(bash(`cat ${path.join(other, 'a.ts')}`), undefined, 'leitura pode');
  assert.match(bash(`rm -rf ${path.join(other, 'dist')}`), /ai\/precos/);
  assert.match(bash('cp a.ts ../ai-precos/a.ts'), /ai\/precos/);
  assert.strictEqual(bash('npm test && git add -A && git commit -m ok'), undefined);
  assert.strictEqual(bash('curl https://example.com/a/b'), undefined);
});

check('ler banco e copiar arquivos de outra worktree pode', () => {
  const db = path.join(main, 'backend', 'dev.db');
  assert.strictEqual(bash(`sqlite3 -readonly ${db} "delete from x"`), undefined);
  assert.strictEqual(bash(`sqlite3 "file:${db}?mode=ro" ".tables"`), undefined);
  assert.strictEqual(bash(`sqlite3 -header ${db} "select * from clientes where id = 2; pragma table_info(clientes)"`), undefined);
  assert.strictEqual(bash(`sqlite3 ${db} .schema`), undefined);
  assert.strictEqual(bash(`C:/tools/sqlite3.exe ${db} "select 'delete' from x"`), undefined);
  assert.match(bash(`sqlite3 ${db} "update clientes set nome = 'x'"`), /master/);
  assert.match(bash(`sqlite3 ${db} "select 1; drop table x"`), /master/);
  assert.match(bash(`sqlite3 ${db}`), /master/, 'sem SQL na linha não dá para saber');
  assert.match(bash(`sqlite3 ${db} "pragma journal_mode = wal"`), /master/);
  assert.match(bash(`sqlite3 ${db} ".read x.sql"`), /Reading is allowed|Ler pode/);
  assert.strictEqual(bash(`cp ${db} ./tmp/dev.db`), undefined);
  assert.strictEqual(bash(`Copy-Item ${db} -Destination ${path.join(wt, 'dev.db')}`), undefined);
  assert.match(bash(`cp ${db} ${path.join(other, 'dev.db')}`), /ai\/precos/);
  assert.match(bash(`cd ${other} && cp a.ts b.ts`), /ai\/precos/);
  assert.strictEqual(bash(`Select-String -Path ${path.join(other, 'a.ts')} -Pattern x`), undefined);
  assert.match(bash(`node ${path.join(other, 'x.js')}`), /ai\/precos/);
});

check('outras ferramentas passam', () => {
  assert.strictEqual(guardToolUse({ tool_name: 'Read', tool_input: { file_path: path.join(other, 'a.ts') } }, ctx), undefined);
  assert.strictEqual(guardToolUse({ tool_name: 'ExitPlanMode', tool_input: { plan: 'x' } }, ctx), undefined);
});

check('describeToolRequest', () => {
  assert.strictEqual(describeToolRequest('Bash', { command: 'npm   test' }), 'Bash: npm test');
  assert.strictEqual(describeToolRequest('Edit', { file_path: path.join(wt, 'src', 'a.ts') }), 'Edit: a.ts');
  assert.strictEqual(describeToolRequest('mcp__agentyard__queue_task', {}), 'agentyard · queue_task');
  assert.ok(describeToolRequest('Bash', { command: 'x'.repeat(500) }).length < 200);
});

check('sessionContext', () => {
  const s = sessionContext({
    repo: 'loja',
    worktree: wt,
    branch: 'ai/login',
    base: 'master',
    ahead: 2,
    behind: 5,
    changes: 1,
    conflicts: ['src/a.ts'],
    overlaps: [{ with: 'ai/precos', files: ['src/b.ts'] }],
    busy: ['ai/precos'],
    request: { ref: '#12', url: 'https://x/12', state: 'open', review: 'changes requested' },
    ci: { status: 'failed', name: 'build' },
    guard: true,
    mcp: true,
    extra: '  Rode npm test antes de commitar.  ',
  });
  for (const x of ['ai/login', 'master', '2 commit(s) ahead and 5 behind', 'src/a.ts', 'ai/precos is also changing: src/b.ts', '#12', 'failed', 'mark_ready', 'Rode npm test antes de commitar.']) assert.ok(s.includes(x), x);
  const min = sessionContext({ repo: 'r', worktree: wt, base: 'main' });
  assert.ok(!min.includes('undefined') && !min.includes('MCP'), min);
});

check('reviewText: arquivo:linha, o código e o comentário', () => {
  const txt = reviewText([
    { file: 'src/a.ts', line: 3, endLine: 3, code: '  const x = 1;  ', text: 'renomeie x' },
    { file: 'src/b.ts', line: 10, endLine: 12, code: '', text: 'extraia\numa função' },
  ]);
  assert.ok(txt.includes('- src/a.ts:3\n  `const x = 1;`\n  renomeie x'), txt);
  assert.ok(txt.includes('- src/b.ts:10-12\n  extraia\n  uma função'), txt);
  assert.strictEqual(reviewText([]), 'No review comments.');
});

if (failures) {
  console.log(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log('\nclaudeGuard: tudo ok');
