// Regras de src/guardsCore.ts (checagens, branches protegidas, lembrete de limpeza).
// Uso: node test/guards.test.js
const assert = require('assert');
const g = require('../out/guardsCore');

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

check('comandos: configurados; vazio cai no testCommand só se permitido', () => {
  assert.deepStrictEqual(g.checkCommands([' npm test ', ''], 'x', true), ['npm test']);
  assert.deepStrictEqual(g.checkCommands([], 'npm test', true), ['npm test']);
  assert.deepStrictEqual(g.checkCommands([], 'npm test', false), []);
  assert.deepStrictEqual(g.checkCommands([], '  ', true), []);
});

check('cache: só guarda o que passou com a worktree limpa; falha apaga', () => {
  const c = new g.CheckCache(2);
  const k = g.checkCacheKey('C:\\wt\\A', 'abc', ['npm test']);
  assert.strictEqual(k, g.checkCacheKey('c:\\WT\\a', 'abc', ['npm test']), 'caminho sem diferenciar maiúsculas');
  assert.notStrictEqual(k, g.checkCacheKey('c:\\wt\\a', 'abd', ['npm test']), 'outro commit');
  assert.notStrictEqual(k, g.checkCacheKey('c:\\wt\\a', 'abc', ['npm test', 'lint']), 'outros comandos');
  c.record(k, true, false);
  assert.strictEqual(c.has(k), false, 'suja não entra');
  c.record(k, false, true);
  assert.strictEqual(c.has(k), false, 'falha não entra');
  c.record(k, true, true);
  assert.strictEqual(c.has(k), true);
  c.record(k, false, true);
  assert.strictEqual(c.has(k), false, 'falha depois de passar invalida');
  c.record('a', true, true);
  c.record('b', true, true);
  c.record('c', true, true);
  assert.strictEqual(c.has('a'), false, 'limite de tamanho descarta o mais antigo');
});

check('checagem de merge: não roda quando é a base (ou remota) descendo', () => {
  assert.strictEqual(g.shouldCheckMerge('ai/x', 'master', 'master'), true);
  assert.strictEqual(g.shouldCheckMerge('master', 'master', 'master'), false);
  assert.strictEqual(g.shouldCheckMerge('origin/master', 'master', 'origin/master'), false);
  assert.strictEqual(g.shouldCheckMerge('origin/feat', 'master', 'master'), false);
});

check('lista protegida: automática (base + fluxo + main/master) ou configurada com glob', () => {
  assert.deepStrictEqual(g.protectedList([], 'develop', ['develop', 'qa', 'main']), ['develop', 'qa', 'main', 'master']);
  const list = g.protectedList(['release/*', 'prod'], 'master', []);
  assert.deepStrictEqual(list, ['release/*', 'prod']);
  assert.strictEqual(g.isProtected('release/1.0', list), true);
  assert.strictEqual(g.isProtected('refs/heads/prod', list), true);
  assert.strictEqual(g.isProtected('master', list), false, 'lista explícita substitui a automática');
});

check('decisão: confirm, require-pr, off, e force sempre bloqueado em protegida', () => {
  const list = ['master', 'qa'];
  assert.strictEqual(g.protectionDecision('confirm', 'merge', 'master', list), 'confirm');
  assert.strictEqual(g.protectionDecision('require-pr', 'push', 'qa', list), 'require-pr');
  assert.strictEqual(g.protectionDecision('require-pr', 'merge', 'ai/x', list), 'allow');
  assert.strictEqual(g.protectionDecision('confirm', 'force', 'master', list), 'block');
  assert.strictEqual(g.protectionDecision('require-pr', 'force', 'master', list), 'block');
  assert.strictEqual(g.protectionDecision('off', 'force', 'master', list), 'allow');
  assert.strictEqual(g.protectionDecision('confirm', 'force', 'ai/x', list), 'allow');
});

check('limpeza: só mescladas, limpas, paradas, sem agente/favorita; órfãs à parte', () => {
  const now = 1_800_000_000;
  const day = 86400;
  const base = { isMain: false, isBase: false, prunable: false, compareKnown: true, statusKnown: true, ahead: 0, changes: 0, agents: [], favorite: false };
  const wts = [
    { ...base, path: 'parada', date: now - 10 * day },
    { ...base, path: 'recente', date: now - 2 * day },
    { ...base, path: 'suja', date: now - 30 * day, changes: 3 },
    { ...base, path: 'nao-mesclada', date: now - 30 * day, ahead: 2 },
    { ...base, path: 'sem-comparacao', date: now - 30 * day, compareKnown: false },
    { ...base, path: 'com-agente', date: now - 30 * day, agents: ['Claude Code'] },
    { ...base, path: 'favorita', date: now - 30 * day, favorite: true },
    { ...base, path: 'principal', date: now - 30 * day, isMain: true },
    { ...base, path: 'orfa', date: now - 30 * day, prunable: true },
  ];
  const r = g.cleanupCandidates(wts, 7, now);
  assert.deepStrictEqual(r.stale.map(w => w.path), ['parada']);
  assert.deepStrictEqual(r.orphans.map(w => w.path), ['orfa']);
});

check('lembrete: limite, adiado, desligado e no máximo um por dia', () => {
  const now = Date.now();
  assert.strictEqual(g.shouldRemind(25, 20, {}, now), true);
  assert.strictEqual(g.shouldRemind(19, 20, {}, now), false);
  assert.strictEqual(g.shouldRemind(0, 0, {}, now), false, 'nada para limpar nunca avisa');
  assert.strictEqual(g.shouldRemind(25, 20, { disabled: true }, now), false);
  assert.strictEqual(g.shouldRemind(25, 20, { snoozeUntil: now + 1000 }, now), false);
  assert.strictEqual(g.shouldRemind(25, 20, { snoozeUntil: now - 1000 }, now), true);
  assert.strictEqual(g.shouldRemind(25, 20, { lastShown: now - 3600_000 }, now), false);
  assert.strictEqual(g.shouldRemind(25, 20, { lastShown: now - 25 * 3600_000 }, now), true);
});

check('final da saída sem cores', () => {
  const text = Array.from({ length: 200 }, (_, i) => `\x1b[31mlinha ${i}\x1b[0m`).join('\n');
  const t = g.tailLines(text, 150).split('\n');
  assert.strictEqual(t.length, 150);
  assert.strictEqual(t[0], 'linha 50');
  assert.ok(!t.join('').includes('\x1b'));
});

if (failures) process.exit(1);
