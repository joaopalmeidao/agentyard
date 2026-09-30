// Descrição de pedidos de permissão e contexto do SessionStart.
// Uso: node test/claudeGuard.test.js
const assert = require('assert');
const path = require('path');
const { describeToolRequest } = require('../out/claude/guard');
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
const wt = path.join(root, 'loja.worktrees', 'ai-login');

check('describeToolRequest', () => {
  assert.strictEqual(describeToolRequest('Bash', { command: 'npm   test' }), 'Bash: npm test');
  assert.strictEqual(describeToolRequest('Edit', { file_path: path.join(wt, 'src', 'a.ts') }), 'Edit: a.ts');
  assert.strictEqual(describeToolRequest('mcp__agentyard__mark_ready', {}), 'agentyard · mark_ready');
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
