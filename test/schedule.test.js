// Núcleo dos agendamentos (cron, atalhos, perdidos). Uso: node test/schedule.test.js
const assert = require('assert');
const { parseCron, nextCron, parseWhen, nextRun, nextRuns, missedSince, renderTemplate, newBranchName, relativeTime } = require('../out/schedule/core');

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
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

check('cron: listas, faixas e passos', () => {
  const c = parseCron('0,30 9-11 * * *');
  assert.deepStrictEqual([...c.minutes], [0, 30]);
  assert.deepStrictEqual([...c.hours], [9, 10, 11]);
  assert.deepStrictEqual([...parseCron('*/15 * * * *').minutes], [0, 15, 30, 45]);
  assert.deepStrictEqual([...parseCron('0 8-18/4 * * *').hours], [8, 12, 16]);
  assert.throws(() => parseCron('61 * * * *'), /intervalo/);
  assert.throws(() => parseCron('* * *'), /5 campos/);
});

check('próximo horário: mesmo dia, dia seguinte, virada de mês e de ano', () => {
  const c = parseCron('0 9 * * *');
  assert.strictEqual(fmt(nextCron(c, at(2026, 9, 27, 8, 0))), '2026-09-27 09:00');
  assert.strictEqual(fmt(nextCron(c, at(2026, 9, 27, 9, 0))), '2026-09-28 09:00');
  assert.strictEqual(fmt(nextCron(c, at(2026, 9, 30, 10, 0))), '2026-10-01 09:00');
  assert.strictEqual(fmt(nextCron(c, at(2026, 12, 31, 23, 59))), '2027-01-01 09:00');
  assert.strictEqual(fmt(nextCron(parseCron('0 0 29 2 *'), at(2026, 3, 1))), '2028-02-29 00:00');
});

check('dia do mês E dia da semana restritos: vale qualquer um (regra do cron)', () => {
  // dia 1 ou toda segunda, às 10:00; 2026-09-27 é domingo
  const c = parseCron('0 10 1 * 1');
  assert.strictEqual(fmt(nextCron(c, at(2026, 9, 27, 12))), '2026-09-28 10:00'); // segunda
  assert.strictEqual(fmt(nextCron(c, at(2026, 9, 28, 11))), '2026-10-01 10:00'); // dia 1 (quinta)
  // domingo como 0 ou 7
  assert.strictEqual(fmt(nextCron(parseCron('0 8 * * 7'), at(2026, 9, 27, 9))), '2026-10-04 08:00');
});

check('dias úteis pulam o fim de semana', () => {
  const w = parseWhen('dias úteis às 08:30');
  assert.deepStrictEqual(w, { kind: 'cron', expr: '30 8 * * 1-5' });
  assert.strictEqual(fmt(nextRun(w, at(2026, 10, 2, 9))), '2026-10-05 08:30'); // sexta 9h → segunda
});

check('atalhos em português', () => {
  assert.deepStrictEqual(parseWhen('todo dia às 9h'), { kind: 'cron', expr: '0 9 * * *' });
  assert.deepStrictEqual(parseWhen('Toda segunda às 10:15'), { kind: 'cron', expr: '15 10 * * 1' });
  assert.deepStrictEqual(parseWhen('a cada 2 h'), { kind: 'cron', expr: '0 */2 * * *' });
  assert.deepStrictEqual(parseWhen('a cada 30 min'), { kind: 'cron', expr: '*/30 * * * *' });
  assert.deepStrictEqual(parseWhen('a cada minuto'), { kind: 'cron', expr: '* * * * *' });
  assert.deepStrictEqual(parseWhen('5 4 * * 0'), { kind: 'cron', expr: '5 4 * * 0' });
  const once = parseWhen('uma vez em 2026-10-01 14:00');
  assert.strictEqual(once.kind, 'once');
  assert.strictEqual(fmt(new Date(once.at)), '2026-10-01 14:00');
  assert.throws(() => parseWhen('quando der'), /campo|cron/);
});

check('uma vez: só antes do horário', () => {
  const w = parseWhen('uma vez em 2026-10-01 14:00');
  assert.ok(nextRun(w, at(2026, 9, 30)));
  assert.strictEqual(nextRun(w, at(2026, 10, 1, 15)), undefined);
});

check('próximos 3 horários (pré-visualização do assistente)', () => {
  const r = nextRuns(parseWhen('a cada 2 h'), at(2026, 9, 27, 9, 5), 3).map(fmt);
  assert.deepStrictEqual(r, ['2026-09-27 10:00', '2026-09-27 12:00', '2026-09-27 14:00']);
});

check('perdidos: fechado por 3 dias executa uma vez, com o último horário', () => {
  const w = parseWhen('todo dia às 09:00');
  const last = missedSince(w, at(2026, 9, 24, 12).getTime(), at(2026, 9, 27, 10).getTime());
  assert.strictEqual(fmt(last), '2026-09-27 09:00');
  assert.strictEqual(missedSince(w, at(2026, 9, 27, 9, 30).getTime(), at(2026, 9, 27, 10).getTime()), undefined);
});

check('cron impossível não trava', () => {
  const t = Date.now();
  assert.strictEqual(nextCron(parseCron('0 0 31 2 *'), at(2026, 1, 1)), undefined); // 31 de fevereiro
  assert.ok(Date.now() - t < 2000, 'rápido');
});

check('template, nome da branch nova e texto relativo', () => {
  assert.strictEqual(renderTemplate('Revise ${branch} contra ${base} em ${date} (${x})', { branch: 'ai/a', base: 'master', date: '2026-09-27' }), 'Revise ai/a contra master em 2026-09-27 (${x})');
  assert.strictEqual(newBranchName('agendado', 'Relatório semanal!', at(2026, 9, 27)), 'agendado/relatorio-semanal-2026-09-27');
  const now = at(2026, 9, 27, 8);
  assert.strictEqual(relativeTime(at(2026, 9, 27, 9), now), 'hoje 09:00');
  assert.strictEqual(relativeTime(at(2026, 9, 28, 9), now), 'amanhã 09:00');
  assert.strictEqual(relativeTime(at(2026, 9, 30, 9), now), 'qua 09:00');
});

if (failures) process.exit(1);
