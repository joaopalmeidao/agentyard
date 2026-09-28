// Testes de src/autopilot/core.ts (piloto automático dos agentes). Uso: node test/autopilot.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../out/autopilot/core');
const B = require('../out/autopilot/board');
const P = require('../out/autopilot/plan');

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

  await check('usagePause: semana antes da janela de 5 h, sem orçamento não pausa', () => {
    const base = { limitPct: 90, sessionBudget: 1000, weekBudget: 10000, weekRolling: false, now: 100, block: { tokens: 950, end: 5000 }, week: { tokens: 100, end: 90000 } };
    assert.deepStrictEqual(A.usagePause(base), { window: '5h', pct: 95, until: 5000 });
    assert.deepStrictEqual(A.usagePause({ ...base, week: { tokens: 9500, end: 90000 } }), { window: 'week', pct: 95, until: 90000 });
    assert.strictEqual(A.usagePause({ ...base, week: { tokens: 9500, end: 90000 }, weekRolling: true }).until, 100 + 3600_000);
    assert.strictEqual(A.usagePause({ ...base, sessionBudget: 0 }), undefined);
    assert.strictEqual(A.usagePause({ ...base, limitPct: 0 }), undefined);
    assert.strictEqual(A.usagePause({ ...base, block: undefined }), undefined);
  });

  await check('juiz: prompt com todas as tentativas e leitura do ranking', () => {
    const at = l => ({ letter: l, branch: `try/x-${l.toLowerCase()}`, variation: '', commits: 1, files: 2, added: 3, deleted: 1, testsOk: l !== 'B', testTail: 'erro X', diff: 'd'.repeat(200_000) });
    const p = A.judgePrompt('fazer login', [at('A'), at('B')]);
    assert.match(p, /fazer login/);
    assert.match(p, /Attempt B[\s\S]*FAILED[\s\S]*erro X/);
    assert.ok(p.length < 170_000);
    const r = A.parseJudge('RANKING: B, A\nA: simples\nB: completo\nRECOMMENDATION: fique com B.', ['A', 'B', 'C']);
    assert.deepStrictEqual(r.ranking, ['B', 'A', 'C']);
    assert.strictEqual(r.reasons.A, 'simples');
    assert.strictEqual(r.recommendation, 'fique com B.');
    assert.strictEqual(A.parseJudge('sem formato', ['A', 'B']), undefined);
  });

  await check('plano: JSON com cerca, ids, branches únicas, dependências e ciclo', () => {
    const text = 'Aqui está:\n```json\n' + JSON.stringify({
      title: 'Pagamentos',
      subtasks: [
        { id: 'API', title: 'API de pagamento', branch: 'ai/pay-api', task: 'criar a API', files: ['src/api/**'] },
        { id: 'ui', title: 'Tela', branch: 'ai/pay-api', task: 'criar a tela', dependsOn: ['api', 'nao-existe'] },
        { id: 'docs', title: 'Docs', branch: 'feat bad name', task: 'documentar', dependsOn: ['docs'] },
      ],
    }) + '\n```';
    const p = P.normalizePlan(P.extractJson(text), 'ai/', new Set(['ai/tela']));
    assert.strictEqual(p.title, 'Pagamentos');
    assert.deepStrictEqual(p.subtasks.map(s => s.id), ['api', 'ui', 'docs']);
    assert.deepStrictEqual(p.subtasks.map(s => s.branch), ['ai/pay-api', 'ai/pay-api-2', 'ai/docs']);
    assert.deepStrictEqual(p.subtasks[1].dependsOn, ['api']);
    assert.deepStrictEqual(p.subtasks[2].dependsOn, [], 'depender de si mesma sai');
    assert.deepStrictEqual(p.subtasks[0].files, ['src/api/**']);
    assert.throws(() => P.normalizePlan({ subtasks: [{ id: 'a', task: 'x', dependsOn: ['b'] }, { id: 'b', task: 'y', dependsOn: ['a'] }] }, 'ai/', new Set()), /cycle/);
    assert.throws(() => P.normalizePlan({ subtasks: [] }, 'ai/', new Set()), /no subtasks/);
    assert.throws(() => P.normalizePlan({ subtasks: [{ id: 'a' }] }, 'ai/', new Set()), /no instructions/);
    assert.throws(() => P.extractJson('nada'), /no JSON/);
  });

  await check('plano: o que começa, empilhamento, bloqueio e ordem da fila', () => {
    const s = (id, deps = [], status = 'waiting') => ({ id, title: id, branch: `ai/${id}`, task: id, dependsOn: deps, files: [], status });
    const o = { id: '1', title: 'x', task: 'x', base: 'main', created: 0, subtasks: [s('ui', ['api', 'db']), s('api'), s('db'), s('docs')] };
    assert.deepStrictEqual(P.startable(o, 2).map(x => x.id), ['api', 'db']);
    o.subtasks[1].status = 'running';
    assert.deepStrictEqual(P.startable(o, 2).map(x => x.id), ['db']);
    o.subtasks[1].status = 'ready';
    o.subtasks[2].status = 'ready';
    assert.deepStrictEqual(P.startable(o, 3).map(x => x.id), ['ui', 'docs']);
    assert.deepStrictEqual(P.startPoint(o, o.subtasks[0]), { from: 'ai/api', merge: ['ai/db'] });
    assert.deepStrictEqual(P.startPoint(o, o.subtasks[3]), { from: 'main', merge: [] });
    assert.deepStrictEqual(P.topoOrder(o.subtasks).map(x => x.id), ['api', 'db', 'ui', 'docs']);
    o.subtasks[1].status = 'failed';
    assert.deepStrictEqual(P.blockedBy(o).map(x => x.id), ['ui']);
    assert.strictEqual(P.finished(o), false);
    const prompt = P.subtaskPrompt(o, o.subtasks[0]);
    assert.match(prompt, /YOUR PART \(ui\)/);
    assert.match(prompt, /already contains the work of: ai\/api/);
    assert.match(prompt, /post_note/);
  });

  await check('lições: mensagens da pessoa na transcrição e leitura da resposta', () => {
    const lines = [
      { type: 'user', message: { role: 'user', content: 'Implemente o login' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'feito' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'saída' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'não use any, use os tipos do zod' }] } },
      { type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } },
      { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
      'linha quebrada {',
    ].map(x => (typeof x === 'string' ? x : JSON.stringify(x)));
    assert.deepStrictEqual(A.userMessages(lines.join('\n')), ['Implemente o login', 'não use any, use os tipos do zod']);
    const p = A.lessonsPrompt({ branch: 'ai/x', sessions: [['a', 'b']], interventions: ['1 negado'], review: ['bug'], claudeMd: '# Regras', diffStat: 'x | 1 +' });
    assert.match(p, /\[2\] b/);
    assert.match(p, /# Regras/);
    const r = A.parseLessons('LESSONS:\n- use zod\n- rode npm test\nCLAUDE_MD:\n```markdown\n- Use zod.\n```');
    assert.deepStrictEqual(r.lessons, ['use zod', 'rode npm test']);
    assert.strictEqual(r.append, '- Use zod.');
    assert.deepStrictEqual(A.parseLessons('LESSONS:\n- (none)\nCLAUDE_MD:\nqualquer'), { lessons: [], append: '' });
  });

  await check('glob das reservas: pasta, *, ** e ?', () => {
    assert.ok(B.matches('src/auth', 'src/auth/login.ts'));
    assert.ok(B.matches('src/auth/**', 'src/auth/a/b.ts'));
    assert.ok(B.matches('src/**/*.ts', 'src/x.ts'));
    assert.ok(B.matches('src/*.ts', 'src\\x.ts'));
    assert.ok(!B.matches('src/*.ts', 'src/a/x.ts'));
    assert.ok(B.matches('./package.json', 'package.json'));
    assert.ok(!B.matches('src/auth', 'src/authz.ts'));
    assert.ok(B.matches('a?.ts', 'ab.ts'));
  });

  await check('reservas: outra worktree não reserva o que já é de alguém; soltar e vencer', () => {
    const b = { notes: [], claims: [] };
    const wa = path.join(root, 'wt-a');
    const wb = path.join(root, 'wt-b');
    const r1 = B.claim(b, { worktree: wa, branch: 'ai/a', patterns: ['src/auth/**', 'package.json'], note: 'login', now: 1000, hours: 1 });
    assert.deepStrictEqual(r1.claimed, ['src/auth/**', 'package.json']);
    const r2 = B.claim(b, { worktree: wb, branch: 'ai/b', patterns: ['src/auth/login.ts', 'src/api/x.ts'], now: 1000, hours: 1 });
    assert.deepStrictEqual(r2.claimed, ['src/api/x.ts']);
    assert.strictEqual(r2.taken[0].by.branch, 'ai/a');
    assert.strictEqual(B.claimOn(b, wb, 'src/auth/login.ts', 2000).branch, 'ai/a');
    assert.strictEqual(B.claimOn(b, wa, 'src/auth/login.ts', 2000), undefined, 'a própria reserva não bloqueia');
    assert.strictEqual(B.claimOn(b, wb, 'src/auth/login.ts', 1000 + 3600_000 + 1), undefined, 'vencida');
    // reservar de novo o mesmo padrão renova em vez de duplicar
    B.claim(b, { worktree: wa, branch: 'ai/a', patterns: ['package.json'], now: 5000, hours: 2 });
    assert.strictEqual(b.claims.filter(c => c.pattern === 'package.json').length, 1);
    assert.strictEqual(B.release(b, wa, ['package.json']), 1);
    assert.strictEqual(B.release(b, wa), 1);
    assert.deepStrictEqual(b.claims.map(c => c.branch), ['ai/b']);
    B.pruneClaims(b, 2000, wt => wt !== wb);
    assert.strictEqual(b.claims.length, 0, 'worktree que sumiu');
  });

  await check('mural: notas dos outros desde a última vez, gravado no arquivo', () => {
    const file = path.join(root, B.BOARD_FILE);
    const wa = path.join(root, 'wt-a');
    B.updateBoard(file, b => B.addNote(b, { at: 10, from: 'ai/a', worktree: wa, text: 'mudei a API' }));
    B.updateBoard(file, b => B.addNote(b, { at: 20, from: 'o usuário', text: 'usem a v2' }));
    const b = B.readBoard(file);
    assert.deepStrictEqual(B.notesFor(b, wa, 0).map(n => n.text), ['usem a v2']);
    assert.deepStrictEqual(B.notesFor(b, path.join(root, 'wt-b'), 0).map(n => n.text), ['mudei a API', 'usem a v2']);
    assert.deepStrictEqual(B.notesFor(b, path.join(root, 'wt-b'), 10).map(n => n.text), ['usem a v2']);
    assert.match(B.formatNotes(b.notes), /ai\/a: mudei a API/);
    for (let i = 0; i < 250; i++) B.addNote(b, { at: 100 + i, from: 'x', text: String(i) });
    assert.strictEqual(b.notes.length, 200);
  });

  fs.rmSync(root, { recursive: true, force: true });
  if (failures) {
    console.log(`\n${failures} falha(s)`);
    process.exit(1);
  }
})();
