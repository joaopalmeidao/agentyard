// Regras de coordenação (src/coord/core.ts). Uso: node test/coord.test.js
const assert = require('assert');
const { isActive, findOverlaps, overlapSummary, processNext, resolveAwaiting, agentFinished, MAX_AGENT_TRIES, batchPlan, budgetLevel } = require('../out/coord/core');

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

const base = { agents: [], favorite: false, changes: 0, ahead: 0, compareKnown: true, date: 0, isBase: false, isMain: false, prunable: false, bare: false };
const now = 1_800_000_000;

(async () => {
  await check('ativa: agente, favorita, suja, ou commits fora da base com atividade em 24 h', () => {
    assert.strictEqual(isActive({ ...base }, now), false);
    assert.strictEqual(isActive({ ...base, agents: ['Claude'] }, now), true);
    assert.strictEqual(isActive({ ...base, favorite: true }, now), true);
    assert.strictEqual(isActive({ ...base, changes: 2 }, now), true);
    assert.strictEqual(isActive({ ...base, ahead: 3, date: now - 3600 }, now), true);
    assert.strictEqual(isActive({ ...base, ahead: 3, date: now - 3 * 86400 }, now), false, 'parada há dias');
    assert.strictEqual(isActive({ ...base, ahead: 3, date: now, compareKnown: false }, now), false, 'ainda sem comparação');
    assert.strictEqual(isActive({ ...base, isBase: true, changes: 5 }, now), false, 'base nunca');
  });

  await check('sobreposição: pares com arquivos em comum, mais sobreposto primeiro', () => {
    const t = new Map([
      ['A', new Set(['src/a.ts', 'src/b.ts', 'x.md'])],
      ['B', new Set(['src/b.ts', 'x.md'])],
      ['C', new Set(['src/c.ts', 'src/a.ts'])],
      ['D', new Set()],
    ]);
    const o = findOverlaps(t);
    assert.deepStrictEqual(o, [
      { a: 'A', b: 'B', files: ['src/b.ts', 'x.md'] },
      { a: 'A', b: 'C', files: ['src/a.ts'] },
    ]);
    const s = overlapSummary(o);
    assert.deepStrictEqual(s.get('A'), { with: ['B', 'C'], files: 3 });
    assert.deepStrictEqual(s.get('C'), { with: ['A'], files: 1 });
    assert.ok(!s.has('D'));
  });

  const steps = (over = {}) => ({
    log: [],
    async syncTarget(i) { this.log.push(`sync ${i.branch}`); return over.sync?.(i); },
    async checks(i) { this.log.push(`check ${i.branch}`); return over.checks ? over.checks(i) : true; },
    requiresPr: i => (over.pr ? over.pr(i) : false),
    async merge(i) { this.log.push(`merge ${i.branch}`); return over.merge?.(i); },
  });
  const item = (b, st = 'waiting') => ({ branch: b, target: 'main', status: st, added: 0 });

  await check('fila: um por vez, na ordem; sync → checagens → merge', async () => {
    const items = [item('a'), item('b')];
    const s = steps();
    assert.strictEqual((await processNext(items, s)).status, 'done');
    assert.strictEqual(items[1].status, 'waiting', 'b ainda não');
    await processNext(items, s);
    assert.deepStrictEqual(s.log, ['sync a', 'check a', 'merge a', 'sync b', 'check b', 'merge b']);
    assert.strictEqual(await processNext(items, s), undefined, 'nada mais a fazer');
  });

  await check('fila: conflito ou checagem falhando tira o item com motivo, sem mesclar', async () => {
    const items = [item('a'), item('b')];
    const s = steps({ sync: i => (i.branch === 'a' ? 'conflito ao trazer main' : undefined), checks: i => i.branch !== 'b' });
    const r1 = await processNext(items, s);
    assert.deepStrictEqual([r1.status, r1.reason], ['failed', 'conflito ao trazer main']);
    const r2 = await processNext(items, s);
    assert.deepStrictEqual([r2.status, r2.reason], ['failed', 'checks failed']);
    assert.ok(!s.log.some(l => l.startsWith('merge')));
  });

  await check('fila: destino que exige PR/MR fica esperando e segura a fila até o merge', async () => {
    const items = [item('a'), item('b')];
    const s = steps({ pr: () => true });
    assert.strictEqual((await processNext(items, s)).status, 'awaiting-pr');
    assert.strictEqual(await processNext(items, s), undefined, 'b espera');
    assert.strictEqual(resolveAwaiting(items, i => i.branch === 'a'), true);
    assert.strictEqual(items[0].status, 'done');
  });

  await check('fila: item que ficou "running" (janela fechou) é retomado primeiro', async () => {
    const items = [item('a', 'done'), item('b', 'running'), item('c')];
    const r = await processNext(items, steps());
    assert.strictEqual(r.branch, 'b');
  });

  await check('fila: conflito vai para o agente, a fila espera e retoma o mesmo item quando ele termina', async () => {
    const items = [item('a'), item('b')];
    let conflict = true;
    const handed = [];
    const s = { ...steps({ sync: () => (conflict ? 'conflito ao trazer main' : undefined) }), async handoff(i, r) { handed.push([i.branch, r]); return true; } };
    const r1 = await processNext(items, s);
    assert.deepStrictEqual([r1.branch, r1.status, r1.agentTries], ['a', 'agent', 1]);
    assert.deepStrictEqual(handed, [['a', 'conflito ao trazer main']]);
    assert.strictEqual(await processNext(items, s), undefined, 'b espera o agente');
    assert.strictEqual(agentFinished(items, 'b', true), undefined, 'b não estava com o agente');
    conflict = false;
    assert.strictEqual(agentFinished(items, 'a', true).status, 'waiting');
    assert.strictEqual((await processNext(items, s)).branch, 'a', 'a volta antes de b');
    assert.strictEqual(items[0].status, 'done');
    assert.strictEqual((await processNext(items, s)).branch, 'b');
  });

  await check('fila: agente que para sem commitar tira o item; limite de tentativas; sem agente, falha como antes', async () => {
    const items = [item('a'), item('b')];
    const s = { ...steps({ checks: () => false }), handoff: async () => true };
    await processNext(items, s);
    const f = agentFinished(items, 'a', false);
    assert.strictEqual(f.status, 'failed');
    assert.ok(f.reason.includes('checks failed'));
    // b: entregue MAX_AGENT_TRIES vezes, depois sai da fila
    for (let n = 0; n < MAX_AGENT_TRIES; n++) {
      assert.strictEqual((await processNext(items, s)).status, 'agent');
      agentFinished(items, 'b', true);
    }
    assert.strictEqual((await processNext(items, s)).status, 'failed');
    const lone = [item('c')];
    assert.strictEqual((await processNext(lone, { ...steps({ sync: () => 'x' }), handoff: async () => false })).status, 'failed', 'agente recusou');
  });

  await check('lote: respeita o limite de agentes simultâneos', () => {
    assert.deepStrictEqual(batchPlan(['a', 'b', 'c', 'd'], 3), { now: ['a', 'b', 'c'], later: ['d'] });
    assert.deepStrictEqual(batchPlan(['a', 'b'], 3, 2), { now: ['a'], later: ['b'] });
    assert.deepStrictEqual(batchPlan(['a'], 2, 5), { now: [], later: ['a'] });
  });

  await check('orçamento: 80% avisa, 100% estoura, vale o limite mais apertado', () => {
    assert.strictEqual(budgetLevel({ tokens: 500 }, {}).level, 'ok', 'sem limite');
    assert.deepStrictEqual(budgetLevel({ tokens: 800 }, { tokens: 1000 }), { ratio: 0.8, by: 'tokens', level: 'warn' });
    assert.strictEqual(budgetLevel({ tokens: 100, usd: 5 }, { tokens: 1000, usd: 4 }).level, 'over');
    assert.strictEqual(budgetLevel({ tokens: 100, usd: 5 }, { tokens: 1000, usd: 4 }).by, 'usd');
    assert.strictEqual(budgetLevel(undefined, { tokens: 10 }).level, 'ok');
  });

  if (failures) process.exit(1);
})();
