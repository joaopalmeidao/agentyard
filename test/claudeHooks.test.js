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
const { hookCommand, hookSettings, writeHookSettings, isClaudeCommand, instrumentCommand, insertArgs, claudeArgs, withIdeFlag, withoutPermissionArgs, parseEvents, nextState, EventTail, pruneEvents } = require('../out/claude/hooks');
const { mentionOf, selectionLines, diagnosticsText } = require('../out/claude/sendContext');
const { placementOf, keepsFocus } = require('../out/agents');
const { pickRelevant, insideFolders } = require('../out/claude/terminalUx');

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
  assert.strictEqual(instrumentCommand('claude -c', '/s.json', '/m.json'), 'claude --settings "/s.json" --mcp-config="/m.json" -c');
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

check('withoutPermissionArgs tira só o modo de permissão', () => {
  assert.strictEqual(withoutPermissionArgs('--model opus --permission-mode plan --verbose'), '--model opus --verbose');
  assert.strictEqual(withoutPermissionArgs('--permission-mode=acceptEdits'), '');
  assert.strictEqual(withoutPermissionArgs('--dangerously-skip-permissions --model opus'), '--model opus');
  assert.strictEqual(withoutPermissionArgs('--model opus'), '--model opus');
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
  assert.strictEqual(s.hooks.Stop[0].hooks.length, 1);
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

check('withIdeFlag põe --ide logo depois do claude', () => {
  assert.strictEqual(withIdeFlag('claude'), 'claude --ide');
  assert.strictEqual(withIdeFlag('claude --resume abc'), 'claude --ide --resume abc');
  assert.strictEqual(withIdeFlag('claude --ide -c'), 'claude --ide -c');
  assert.strictEqual(withIdeFlag('codex'), 'codex');
  assert.strictEqual(instrumentCommand(withIdeFlag('claude x'), '/s.json'), 'claude --settings "/s.json" --ide x');
});

check('diagnosticsText: uma linha, erros primeiro, mensagem cortada', () => {
  const root = path.resolve('/repo/wt');
  const file = path.join(root, 'src', 'a.ts');
  const text = diagnosticsText(file, root, [
    { line: 9, severity: 'warning', message: 'não usado' },
    { line: 3, severity: 'error', message: 'tipo\nerrado', source: 'ts' },
  ]);
  assert.strictEqual(text, '@src/a.ts#L3 (error, ts: tipo errado); @src/a.ts#L9 (warning: não usado)');
  assert.ok(!text.includes('\n'));
  const long = diagnosticsText(file, root, [{ line: 1, severity: 'info', message: 'x'.repeat(500) }]);
  assert.ok(long.length < 260 && long.endsWith('…)'));
  assert.strictEqual(diagnosticsText(file, root, Array.from({ length: 30 }, (_, i) => ({ line: i + 1, severity: 'error', message: 'e' })), 5).split('; ').length, 5);
});

check('placementOf e keepsFocus', () => {
  assert.strictEqual(placementOf(undefined, false, false), 'panel');
  assert.strictEqual(placementOf('editor', true, false), 'editor');
  assert.strictEqual(placementOf('editorBeside', false, false), 'beside');
  assert.strictEqual(placementOf('split', false, true), 'split');
  assert.strictEqual(placementOf('split', false, false), 'panel', 'sem outro terminal para dividir');
  assert.strictEqual(placementOf('auto', true, false), 'panel');
  assert.strictEqual(placementOf('auto', false, false), 'beside');
  assert.strictEqual(keepsFocus('interactive', true), true);
  assert.strictEqual(keepsFocus('interactive', false), false);
  assert.strictEqual(keepsFocus(undefined, true), true);
  assert.strictEqual(keepsFocus('always', true), false);
  assert.strictEqual(keepsFocus('never', false), true);
});

check('pickRelevant: esperando > trabalhando > sua vez; empate fica com o mais recente', () => {
  const a = { state: 'idle', started: 1 };
  const b = { state: 'working', started: 2 };
  const c = { state: 'waiting', started: 3 };
  const d = { state: 'ended', started: 9 };
  const e = { started: 5 };
  assert.strictEqual(pickRelevant([a, b, c, d]), c);
  assert.strictEqual(pickRelevant([a, b]), b);
  assert.strictEqual(pickRelevant([a, e]), a);
  assert.strictEqual(pickRelevant([{ state: 'idle', started: 1 }, a, { state: 'idle', started: 7 }]).started, 7);
  assert.strictEqual(pickRelevant([d]), undefined);
});

check('insideFolders', () => {
  const ws = path.resolve('/repo/app');
  assert.ok(insideFolders(ws, [ws]));
  assert.ok(insideFolders(path.join(ws, 'pkg'), [ws + path.sep]));
  assert.ok(!insideFolders(path.resolve('/repo/app-wt'), [ws]), 'prefixo não é pasta-mãe');
  assert.ok(!insideFolders(path.resolve('/repo/worktrees/x'), [ws]));
  assert.ok(insideFolders(ws.toUpperCase(), [ws]));
});

// ---------- statusline: métricas de uso ----------
const sl = require('../out/claude/statusLine');
const statusJson = {
  session_id: 'sess-1',
  cwd: 'C:\\repo\\wt',
  workspace: { current_dir: 'C:\\repo\\wt' },
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  cost: { total_cost_usd: 1.234, total_duration_ms: 90000, total_lines_added: 12, total_lines_removed: 3 },
  context_window: { total_input_tokens: 1, context_window_size: 200000, used_percentage: 42.4, remaining_percentage: 57.6, current_usage: { input_tokens: 5 } },
  rate_limits: { five_hour: { used_percentage: 81.2, resets_at: 1790000000 }, seven_day: { used_percentage: 23, resets_at: 1790500000 } },
};
const labels = { session: 'sessão', week: 'semana' };

check('hookSettings com statusLine; writeHookSettings grava o script e o repasse', () => {
  assert.strictEqual(hookSettings(dir).statusLine, undefined);
  const s = hookSettings('C:\\x\\ev', {}, true);
  assert.strictEqual(s.statusLine.command, 'bash "C:/x/ev/statusline.sh" "C:/x/ev"');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wtg-sl-'));
  const f = writeHookSettings(d, {}, 'a.json', { mode: 'keep', userCommand: 'python ~/.claude/statusline.py', labels });
  assert.ok(JSON.parse(fs.readFileSync(f, 'utf8')).statusLine);
  assert.strictEqual(fs.readFileSync(path.join(d, 'statusline.user'), 'utf8').trim(), 'python ~/.claude/statusline.py');
  writeHookSettings(d, {}, 'a.json', { mode: 'agentyard', userCommand: 'x', labels });
  assert.ok(!fs.existsSync(path.join(d, 'statusline.user')), 'agentyard: sem repasse');
  const off = writeHookSettings(d, {}, 'b.json', { mode: 'off', labels });
  assert.strictEqual(JSON.parse(fs.readFileSync(off, 'utf8')).statusLine, undefined);
  fs.rmSync(d, { recursive: true, force: true });
});

check('userStatusLineCommand lê o settings.json do usuário', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wtg-cfg-'));
  assert.strictEqual(sl.userStatusLineCommand(d), undefined);
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: ' meu.sh ' } }));
  assert.strictEqual(sl.userStatusLineCommand(d), 'meu.sh');
  fs.rmSync(d, { recursive: true, force: true });
});

check('parseStatus e currentPct', () => {
  const s = sl.parseStatus('t1', JSON.stringify(statusJson), 5);
  assert.strictEqual(s.model, 'Opus 5.5');
  assert.strictEqual(s.contextPct, 42.4);
  assert.strictEqual(s.usd, 1.234);
  assert.strictEqual(s.fiveHour.resetsAt, 1790000000 * 1000);
  assert.strictEqual(s.sevenDay.pct, 23);
  assert.strictEqual(sl.parseStatus('t', 'meio json', 0), undefined);
  assert.strictEqual(sl.parseStatus('t', '{}', 0).fiveHour, undefined);
  assert.strictEqual(sl.currentPct(s.fiveHour, 1790000000 * 1000 + 1), 0, 'janela renovada');
  assert.strictEqual(sl.currentPct(s.fiveHour, 0), 81.2);
});

check('recordUsage: limites mais recentes, amostras e custo por dia', () => {
  const h = sl.emptyHistory();
  const day1 = new Date(2026, 8, 27, 10).getTime();
  const day2 = new Date(2026, 8, 28, 10).getTime();
  const snap = (at, usd, five) => ({ ...sl.parseStatus('t', JSON.stringify({ ...statusJson, cost: { total_cost_usd: usd }, rate_limits: { five_hour: { used_percentage: five } } }), at) });
  assert.ok(sl.recordUsage(h, [snap(day1, 2, 10)], day1));
  assert.ok(sl.recordUsage(h, [snap(day2, 5, 10)], day2));
  sl.recordUsage(h, [snap(day2 + 1000, 6, 30)], day2);
  assert.strictEqual(h.latest.fiveHour.pct, 30);
  assert.deepStrictEqual(h.limits.map(x => x.five), [10, 10, 30], 'amostra nova quando muda ou depois de 10 min');
  assert.ok(!sl.recordUsage(h, [snap(day2 + 1000, 6, 30)], day2), 'o mesmo snapshot não muda nada');
  const days = sl.costPerDay(h, 2, day2);
  assert.deepStrictEqual(days.map(d => d.usd), [2, 4], 'dia 2 conta só o que a sessão gastou nele');
  sl.recordUsage(h, [], day2 + 9 * 86400_000);
  assert.deepStrictEqual([h.limits.length, Object.keys(h.sessions).length], [0, 0], 'mais de 8 dias sai');
});

check('statusline de verdade no bash: grava o JSON e desenha a linha', () => {
  if (!bash) return console.log('     (sem bash, pulado)');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wtg-slrun-'));
  const script = path.join(d, 'statusline.sh');
  fs.writeFileSync(script, sl.statusLineScript(labels));
  const env = { ...process.env, WTGRAPH_AGENT_ID: 'term9' };
  const input = JSON.stringify(statusJson, null, 2);
  const out = execFileSync(bash, [script.replace(/\\/g, '/'), d.replace(/\\/g, '/')], { input, env, cwd: d }).toString('utf8');
  const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
  assert.ok(plain.includes('Opus 5.5'), plain);
  assert.ok(plain.includes('ctx 42%'), plain);
  assert.ok(plain.includes('$1.23'), plain);
  assert.ok(plain.includes('sessão 81%'), plain);
  assert.ok(plain.includes('semana 23%'), plain);
  assert.ok(out.includes('\x1b[31m'), 'acima de 80% em vermelho');
  const saved = sl.readStatuses(d);
  assert.deepStrictEqual(saved.map(s => [s.id, s.contextPct]), [['term9', 42.4]]);
  // com a statusline do usuário: o JSON vai para ela e a saída é a dela
  fs.writeFileSync(path.join(d, 'statusline.user'), 'cat > /dev/null; printf minha-linha\n');
  const mine = execFileSync(bash, [script.replace(/\\/g, '/'), d.replace(/\\/g, '/')], { input, env, cwd: d }).toString('utf8');
  assert.strictEqual(mine, 'minha-linha');
  fs.rmSync(d, { recursive: true, force: true });
});

fs.rmSync(dir, { recursive: true, force: true });
if (failures) {
  console.log(`${failures} falha(s)`);
  process.exit(1);
}
