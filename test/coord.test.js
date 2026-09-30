// Regras de coordenação (src/coord/core.ts). Uso: node test/coord.test.js
const assert = require('assert');
const { isActive, findOverlaps, overlapSummary, batchPlan, budgetLevel } = require('../out/coord/core');

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
