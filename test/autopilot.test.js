// Testes de src/autopilot/core.ts (piloto automático dos agentes). Uso: node test/autopilot.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../out/autopilot/core');

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${e.stack || e}`);
  }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wtg-autopilot-'));

(async () => {
  await check('gateCommands: os próprios, senão os de antes do merge, senão o testCommand', () => {
    assert.deepStrictEqual(A.gateCommands([' npm test '], ['lint'], 'x'), ['npm test']);
    assert.deepStrictEqual(A.gateCommands(['', ' '], ['lint', 'test'], 'x'), ['lint', 'test']);
    assert.deepStrictEqual(A.gateCommands([], [], 'npm test'), ['npm test']);
    assert.deepStrictEqual(A.gateCommands([], [], ''), []);
  });

  await check('gateVerdict: desligado, sem comando, projeto longo, headless e turno sem mudança pulam', () => {
    const base = { mode: 'changes', commands: ['npm test'], changed: true };
    assert.deepStrictEqual(A.gateVerdict(base), { action: 'run' });
    assert.strictEqual(A.gateVerdict({ ...base, mode: 'off' }).why, 'off');
    assert.strictEqual(A.gateVerdict({ ...base, commands: [] }).why, 'no-commands');
    assert.strictEqual(A.gateVerdict({ ...base, project: true }).why, 'project');
    assert.strictEqual(A.gateVerdict({ ...base, headless: true }).why, 'headless');
    assert.strictEqual(A.gateVerdict({ ...base, changed: false }).why, 'unchanged');
    assert.deepStrictEqual(A.gateVerdict({ ...base, mode: 'always', changed: false }), { action: 'run' });
  });

  await check('runCommands para no primeiro que falha e junta a saída', async () => {
    const ok = await A.runCommands(['node -e "console.log(1)"', 'node -e "console.log(2)"'], root, 30000);
    assert.ok(ok.ok);
    assert.match(ok.output, /1\n[\s\S]*2/);
    const bad = await A.runCommands(['node -e "console.error(\'quebrou\'); process.exit(3)"', 'node -e "console.log(\'nunca\')"'], root, 30000);
    assert.strictEqual(bad.ok, false);
    assert.match(bad.failed, /quebrou/);
    assert.match(bad.output, /quebrou/);
    assert.doesNotMatch(bad.output, /nunca/);
  });

  await check('gateBlockReason traz a tentativa e só o fim do log', () => {
    const log = Array.from({ length: 200 }, (_, i) => `linha ${i}`).join('\n');
    const r = A.gateBlockReason('npm test', log, 2, 3);
    assert.match(r, /npm test/);
    assert.match(r, /Attempt 2 of 3/);
    assert.match(r, /linha 199/);
    assert.doesNotMatch(r, /linha 100\n/);
  });

  await check('parseReview: OK, CHANGES com itens e resposta sem formato', () => {
    assert.deepStrictEqual(A.parseReview('VERDICT: OK\nSUMMARY: tudo certo\nISSUES:\n- none'), { ok: true, summary: 'tudo certo' });
    const r = A.parseReview('VERDICT: CHANGES\nSUMMARY: dois problemas\nISSUES:\n- src/a.ts:10 null não tratado\n* src/b.ts:3 teste não testa nada\n');
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.issues, ['src/a.ts:10 null não tratado', 'src/b.ts:3 teste não testa nada']);
    assert.strictEqual(A.parseReview('não sei').ok, true);
    // CHANGES sem nenhum item concreto não segura o trabalho
    assert.strictEqual(A.parseReview('VERDICT: CHANGES\nSUMMARY: hmm\nISSUES:\n').ok, true);
  });

  await check('reviewPrompt corta diff grande e inclui a tarefa', () => {
    const p = A.reviewPrompt({ branch: 'ai/x', base: 'main', task: 'fazer login', subjects: ['a'], diff: 'x'.repeat(100_000) });
    assert.match(p, /fazer login/);
    assert.match(p, /diff truncated/);
    assert.ok(p.length < 90_000);
  });

  await check('trackAction avisa uma vez ao repetir a mesma ação', () => {
    const tr = { repeats: 0, nudged: false };
    const sig = A.actionSignature('Bash', { command: 'npm   test' });
    assert.strictEqual(sig, 'Bash:npm test');
    assert.strictEqual(A.trackAction(tr, sig, 3), false);
    assert.strictEqual(A.trackAction(tr, sig, 3), false);
    assert.strictEqual(A.trackAction(tr, sig, 3), true);
    assert.strictEqual(A.trackAction(tr, sig, 3), false);
    const other = { repeats: 0, nudged: false };
    A.trackAction(other, sig, 3);
    A.trackAction(other, A.actionSignature('Bash', { command: 'ls' }), 3);
    assert.strictEqual(A.trackAction(other, sig, 3), false);
    assert.strictEqual(A.actionSignature('Read', { file_path: 'a' }), undefined);
    const e1 = A.actionSignature('Edit', { file_path: 'C:\\x\\a.ts', old_string: 'a', new_string: 'b' });
    assert.strictEqual(e1, A.actionSignature('Edit', { file_path: 'C:/x/a.ts', old_string: 'a', new_string: 'b' }));
    assert.notStrictEqual(e1, A.actionSignature('Edit', { file_path: 'C:/x/a.ts', old_string: 'a', new_string: 'c' }));
    assert.match(A.stuckNudge(sig, 5), /npm test/);
  });

  await check('usageBlocks', () => {
    assert.strictEqual(A.usageBlocks(95, 90), true);
    assert.strictEqual(A.usageBlocks(50, 90), false);
    assert.strictEqual(A.usageBlocks(95, 0), false);
    assert.strictEqual(A.usageBlocks(undefined, 90), false);
  });

  fs.rmSync(root, { recursive: true, force: true });
  if (failures) {
    console.log(`\n${failures} falha(s)`);
    process.exit(1);
  }
})();
