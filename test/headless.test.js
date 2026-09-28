// Claude sem terminal (src/claude/headless.ts) com um "claude" falso, e as métricas das tarefas.
// Uso: node test/headless.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('../out/claude/headless');
const { metricsReport, interventions } = require('../out/claude/metrics');
const { osNotifyCommand } = require('../out/claude/osNotify');

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtg-headless-'));
// "claude" falso: devolve o JSON do -p com o prompt que recebeu no stdin e os argumentos
const fake = path.join(dir, 'fake-claude.js');
fs.writeFileSync(
  fake,
  `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
    if (d.includes('ERRO')) { process.stdout.write(JSON.stringify({type:'result',subtype:'error',is_error:true,result:'deu ruim'})); return; }
    process.stdout.write(JSON.stringify({type:'result',result:'\`\`\`\\nfeat: recebi ' + d.length + ' ' + process.argv.slice(2).join(' ') + '\\n\`\`\`',total_cost_usd:0.01,session_id:'s1'}));
  });`,
);
const bin = `"${process.execPath}" "${fake}"`;

(async () => {
  await check('runHeadless manda o prompt pelo stdin e lê o JSON', async () => {
    const r = await H.runHeadless('abc', { cwd: dir, bin, model: 'haiku' });
    assert.strictEqual(r.text, 'feat: recebi 3 -p --output-format json --model haiku');
    assert.strictEqual(r.costUsd, 0.01);
    assert.strictEqual(r.sessionId, 's1');
  });

  await check('runHeadless: erro do Claude vira exceção; binário inexistente também', async () => {
    await assert.rejects(H.runHeadless('ERRO', { cwd: dir, bin }), /deu ruim/);
    await assert.rejects(H.runHeadless('x', { cwd: dir, bin: 'nao-existe-claude-xyz', timeoutMs: 20000 }));
  });

  await check('parseHeadless, cleanOutput e parseTitleBody', () => {
    assert.strictEqual(H.parseHeadless('texto puro').text, 'texto puro');
    assert.strictEqual(H.cleanOutput('"fix: x"'), 'fix: x');
    assert.deepStrictEqual(H.parseTitleBody('TITLE: Login OAuth\nBODY:\n## Resumo\n- a'), { title: 'Login OAuth', body: '## Resumo\n- a' });
    assert.strictEqual(H.parseTitleBody('sem formato'), undefined);
  });

  await check('prompts de commit e de PR levam o diff, o estilo e o idioma', () => {
    const c = H.commitMessagePrompt('+linha', ['feat: a', 'fix: b'], 'Brazilian Portuguese');
    assert.ok(c.includes('- feat: a') && c.includes('+linha') && c.includes('Brazilian Portuguese'));
    const big = H.commitMessagePrompt('x'.repeat(70000), []);
    assert.ok(big.includes('truncated') && big.length < 65000);
    const p = H.prDescriptionPrompt('ai/x', 'main', ['feat: a'], '+d', 'MR');
    assert.ok(p.includes('MR from ai/x into main') && p.includes('TITLE:'));
  });

  await check('métricas: tabela ordenada por custo, totais e intervenções', () => {
    const base = { turns: 0, permissions: 0, approvedInVsCode: 0, deniedInVsCode: 0, guardBlocks: 0, plans: 0, budgetBlocks: 0 };
    const rows = [
      { ...base, name: 'ai/barato', tokens: 1000, usd: 0.1, turns: 2, permissions: 1, approvedInVsCode: 1 },
      { ...base, name: 'ai/caro', tokens: 2_000_000, usd: 5, turns: 10, additions: 30, deletions: 5, commits: 3, guardBlocks: 2, status: '#12 open' },
    ];
    assert.strictEqual(interventions(rows[1]), 2);
    const md = metricsReport(rows, { title: 'Métricas', headers: ['W', 'T', 'US$', 'Tu', 'T/t', 'L', 'C', 'I', 'P'], totals: 'Total', empty: 'nada', note: 'nota' }, 0);
    const lines = md.split('\n');
    const first = lines.findIndex(l => l.startsWith('| ai/'));
    assert.ok(lines[first].includes('ai/caro (#12 open)') && lines[first].includes('2.0M') && lines[first].includes('$5.00') && lines[first].includes('200.0k'), lines[first]);
    assert.ok(md.includes('| **Total** | **2.0M** | **$5.10** | **12**'), md);
    assert.ok(metricsReport([], { title: 'M', headers: [], totals: '', empty: 'nada', note: '' }).includes('nada'));
  });

  await check('notificação do sistema: texto por env/argumento, nunca no script', () => {
    const w = osNotifyCommand('win32', 'Tí"tulo', "cor'po; rm -rf");
    assert.strictEqual(w.file, 'powershell.exe');
    assert.ok(!w.args.join(' ').includes('rm -rf') && w.env.AGENTYARD_BODY === "cor'po; rm -rf");
    const m = osNotifyCommand('darwin', 'T', 'B');
    assert.deepStrictEqual(m.args.slice(-2), ['T', 'B']);
    assert.strictEqual(osNotifyCommand('linux', 'T', 'B').file, 'notify-send');
    assert.strictEqual(osNotifyCommand('aix', 'T', 'B'), undefined);
  });

  fs.rmSync(dir, { recursive: true, force: true });
  if (failures) {
    console.log(`\n${failures} falha(s)`);
    process.exit(1);
  }
  console.log('\nheadless: tudo ok');
})();
