// Hooks de estado do Claude Code e menções "@arquivo#L". Uso: node test/claudeHooks.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'vscode' ? 'vscode' : orig.call(this, r, ...a);
};
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: {} };
const { hookCommand, hookSettings, writeHookSettings, isClaudeCommand, instrumentCommand, insertArgs, claudeArgs, parseEvents, nextState, EventTail, pruneEvents } = require('../out/claude/hooks');
const { mentionOf, selectionLines } = require('../out/claude/sendContext');

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtg-hooks-'));

check('isClaudeCommand', () => {
  for (const c of ['claude', 'claude "oi"', '  claude --resume x', 'claude.exe', 'C:/bin/claude.cmd -c']) assert.ok(isClaudeCommand(c), c);
  for (const c of ['codex', 'gemini -i x', 'claude-dev', 'npx claude', '']) assert.ok(!isClaudeCommand(c), c);
});

check('instrumentCommand põe --settings logo depois do claude', () => {
  assert.strictEqual(instrumentCommand('claude', '/s.json'), 'claude --settings "/s.json"');
  assert.strictEqual(instrumentCommand('claude --resume abc', '/s.json'), 'claude --settings "/s.json" --resume abc');
  assert.strictEqual(instrumentCommand('claude (Get-Content -Raw x)', 'C:\\a b\\s.json'), 'claude --settings "C:\\a b\\s.json" (Get-Content -Raw x)');
  assert.strictEqual(instrumentCommand('codex', '/s.json'), 'codex');
  assert.strictEqual(instrumentCommand('claude --settings mine.json', '/s.json'), 'claude --settings mine.json');
  assert.strictEqual(instrumentCommand('claude -c', '/s.json', '/m.json'), 'claude --settings "/s.json" --mcp-config "/m.json" -c');
  assert.strictEqual(instrumentCommand('claude --mcp-config x.json', '/s.json', '/m.json'), 'claude --settings "/s.json" --mcp-config x.json');
  assert.strictEqual(instrumentCommand('codex', '/s.json', '/m.json'), 'codex');
});

check('hooks extras da ponte entram junto dos de estado', () => {
  const s = hookSettings(dir, { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }], Stop: [{ hooks: [{ type: 'command', command: 'y' }] }] });
  assert.strictEqual(s.hooks.PreToolUse.length, 1);
  assert.strictEqual(s.hooks.Stop.length, 2);
  const f = writeHookSettings(dir, { Stop: [] }, 'outro.settings.json');
  assert.ok(f.endsWith('outro.settings.json'));
});

check('insertArgs e claudeArgs', () => {
  assert.strictEqual(insertArgs('claude "tarefa"', '--model opus'), 'claude --model opus "tarefa"');
  assert.strictEqual(insertArgs('codex', '--model opus'), 'codex');
  assert.strictEqual(insertArgs('claude', '  '), 'claude');
  const q = s => `'${s}'`;
  assert.strictEqual(claudeArgs({ model: 'sonnet', permissionMode: 'plan', systemPrompt: ' seja breve ' }, q), "--model sonnet --permission-mode plan --append-system-prompt 'seja breve'");
  assert.strictEqual(claudeArgs({ permissionMode: 'default' }, q), '');
});

check('hookSettings: um hook por evento, matcher só nos de ferramenta', () => {
  const s = hookSettings(dir);
  assert.deepStrictEqual(Object.keys(s.hooks).sort(), ['Notification', 'PermissionRequest', 'PostToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  assert.strictEqual(s.hooks.PostToolUse[0].matcher, '*');
  assert.strictEqual(s.hooks.Stop[0].matcher, undefined);
  assert.ok(!hookCommand('C:\\x\\y').includes('\\'), 'caminho com barras normais para o bash');
});

check('writeHookSettings só regrava quando muda', () => {
  const f = writeHookSettings(dir);
  const m = fs.statSync(f).mtimeMs;
  fs.utimesSync(f, new Date(0), new Date(0));
  writeHookSettings(dir);
  assert.strictEqual(fs.statSync(f).mtimeMs, 0);
  assert.ok(m > 0 && JSON.parse(fs.readFileSync(f, 'utf8')).hooks.Stop);
});

check('parseEvents: linhas inteiras, sobra incompleta volta', () => {
  const r = parseEvents('{"hook_event_name":"Stop"}\n\n{"hook_event_name":"Notif');
  assert.deepStrictEqual(r.events.map(e => e.hook_event_name), ['Stop']);
  assert.strictEqual(r.rest, '{"hook_event_name":"Notif');
  const r2 = parseEvents(r.rest + 'ication","message":"m"}\n');
  assert.deepStrictEqual(r2.events.map(e => e.message), ['m']);
  assert.strictEqual(r2.rest, '');
  assert.deepStrictEqual(parseEvents('{"x":1}\nlixo\n').events, []);
});

check('nextState', () => {
  const ev = (hook_event_name, extra = {}) => ({ hook_event_name, ...extra });
  assert.strictEqual(nextState('starting', ev('SessionStart')), 'idle');
  assert.strictEqual(nextState('idle', ev('UserPromptSubmit')), 'working');
  assert.strictEqual(nextState('working', ev('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })), 'waiting');
  assert.strictEqual(nextState('waiting', ev('PostToolUse')), 'working');
  assert.strictEqual(nextState('working', ev('Stop')), 'idle');
  assert.strictEqual(nextState('idle', ev('Notification', { notification_type: 'idle_prompt' })), 'idle');
  assert.strictEqual(nextState('idle', ev('Notification', { message: 'Claude is waiting for your input' })), 'idle');
  assert.strictEqual(nextState('idle', ev('SessionEnd')), 'ended');
  assert.strictEqual(nextState('working', ev('PreCompact')), 'working');
  assert.strictEqual(nextState('working', ev('PermissionRequest', { tool_name: 'Bash' })), 'waiting');
});

check('EventTail lê só o que é novo', () => {
  const f = path.join(dir, 'tail.jsonl');
  fs.writeFileSync(f, '{"hook_event_name":"SessionStart","session_id":"s1"}\n');
  const tail = new EventTail(f);
  assert.deepStrictEqual(tail.read().map(e => e.session_id), ['s1']);
  assert.deepStrictEqual(tail.read(), []);
  fs.appendFileSync(f, '{"hook_event_name":"Stop"}\n');
  assert.deepStrictEqual(tail.read().map(e => e.hook_event_name), ['Stop']);
  assert.deepStrictEqual(new EventTail(path.join(dir, 'nao-existe.jsonl')).read(), []);
});

check('pruneEvents apaga os velhos, mantém os em uso', () => {
  const p = path.join(dir, 'prune');
  fs.mkdirSync(p);
  for (const n of ['velho', 'novo', 'emuso']) fs.writeFileSync(path.join(p, `${n}.jsonl`), '');
  const old = new Date(Date.now() - 3 * 86400_000);
  fs.utimesSync(path.join(p, 'velho.jsonl'), old, old);
  fs.utimesSync(path.join(p, 'emuso.jsonl'), old, old);
  pruneEvents(p, new Set(['emuso']));
  assert.deepStrictEqual(fs.readdirSync(p).sort(), ['emuso.jsonl', 'novo.jsonl']);
});

// o comando do hook de verdade, no bash (no Windows, o Git Bash que o Claude Code usa)
let bash;
try {
  execFileSync('bash', ['-c', 'true']);
  bash = 'bash';
} catch {
  // sem bash: pula
}
check('comando do hook grava o evento no arquivo do terminal', () => {
  if (!bash) return console.log('     (sem bash, pulado)');
  const ev = path.join(dir, 'real');
  fs.mkdirSync(ev, { recursive: true });
  const payload = JSON.stringify({ hook_event_name: 'Notification', session_id: 'abc', message: 'precisa de permissão' });
  execFileSync(bash, ['-c', hookCommand(ev)], { input: payload, env: { ...process.env, WTGRAPH_AGENT_ID: 'term1' } });
  execFileSync(bash, ['-c', hookCommand(ev)], { input: JSON.stringify({ hook_event_name: 'Stop' }), env: { ...process.env, WTGRAPH_AGENT_ID: 'term1' } });
  const events = new EventTail(path.join(ev, 'term1.jsonl')).read();
  assert.deepStrictEqual(events.map(e => e.hook_event_name), ['Notification', 'Stop']);
  assert.strictEqual(events[0].message, 'precisa de permissão');
});

check('mentionOf', () => {
  const root = path.resolve('/repo/wt');
  assert.strictEqual(mentionOf(path.join(root, 'src', 'a.ts'), root), '@src/a.ts');
  assert.strictEqual(mentionOf(path.join(root, 'src', 'a.ts'), root, { start: 3, end: 3 }), '@src/a.ts#L3');
  assert.strictEqual(mentionOf(path.join(root, 'src', 'a.ts'), root, { start: 3, end: 9 }), '@src/a.ts#L3-9');
  assert.strictEqual(mentionOf(path.join(root, 'my docs', 'b.md'), root), '@"my docs/b.md"');
  const outside = path.resolve('/outro/c.ts');
  assert.strictEqual(mentionOf(outside, root), '@' + outside.split(path.sep).join('/'));
});

check('selectionLines', () => {
  const sel = (sl, el, ec, isEmpty = false) => ({ start: { line: sl }, end: { line: el, character: ec }, isEmpty });
  assert.strictEqual(selectionLines(sel(0, 0, 0, true)), undefined);
  assert.deepStrictEqual(selectionLines(sel(4, 4, 10)), { start: 5, end: 5 });
  assert.deepStrictEqual(selectionLines(sel(4, 8, 0)), { start: 5, end: 8 });
  assert.deepStrictEqual(selectionLines(sel(4, 8, 2)), { start: 5, end: 9 });
});

fs.rmSync(dir, { recursive: true, force: true });
if (failures) {
  console.log(`${failures} falha(s)`);
  process.exit(1);
}
