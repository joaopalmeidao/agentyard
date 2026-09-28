// Projetos longos: plano, contexto injetado e o portão do Stop no bash. Uso: node test/longProject.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'vscode' ? 'vscode' : orig.call(this, r, ...a);
};
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: {} };
const core = require('../out/longProject/core');
const { writeHookSettings, projectHookCommand } = require('../out/claude/hooks');

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtg-lp-'));

const PLAN = [
  '# Plano',
  '',
  '## Objetivo',
  '- [ ] isto não é marco',
  '',
  '## [M1] Base do cliente',
  '- [x] criar módulo',
  '- [x] testes',
  '',
  '## [M2] Login',
  '### Detalhes',
  '- [ ] tela',
  '  * [X] rota',
  '',
  '## Riscos',
  '- [ ] fora de marco',
  '## [M3] Sem checklist',
  '',
].join('\n');

check('parsePlan: marcos pelo "## [id]", checklist até o próximo ##', () => {
  const plan = core.parsePlan(PLAN);
  assert.deepStrictEqual(plan.map(m => m.id), ['M1', 'M2', 'M3']);
  assert.strictEqual(plan[0].title, 'Base do cliente');
  assert.deepStrictEqual(plan[1].items, [{ text: 'tela', done: false }, { text: 'rota', done: true }]);
  assert.deepStrictEqual(plan[2].items, []);
  assert.ok(core.checklistDone(plan[0]));
  assert.ok(!core.checklistDone(plan[1]));
  assert.ok(!core.checklistDone(plan[2]), 'sem itens não conta como feito');
});

check('nextMilestone: estado da extensão manda; sem estado, vale o checklist', () => {
  const plan = core.parsePlan(PLAN);
  assert.strictEqual(core.nextMilestone(plan, { status: 'running', milestones: {} }).id, 'M2');
  const rt = { status: 'running', milestones: { M1: { ...core.emptyMilestone(), status: 'active' } } };
  assert.strictEqual(core.nextMilestone(plan, rt).id, 'M1');
  rt.milestones.M1.status = 'done';
  rt.milestones.M2 = { ...core.emptyMilestone(), status: 'done' };
  assert.strictEqual(core.nextMilestone(plan, rt).id, 'M3');
  rt.milestones.M3 = { ...core.emptyMilestone(), status: 'done' };
  assert.strictEqual(core.nextMilestone(plan, rt), undefined);
});

check('lastProgress: últimas entradas inteiras dentro do limite', () => {
  const md = ['# Progresso', 'intro', '## dia 1', 'a', 'b', '## dia 2', 'c', '## dia 3', 'd', ''].join('\n');
  assert.strictEqual(core.lastProgress(md, 4), '## dia 2\nc\n## dia 3\nd');
  assert.strictEqual(core.lastProgress(md, 2), '## dia 3\nd');
  assert.strictEqual(core.lastProgress('sem entradas\nlinha', 1), 'linha');
});

check('shellQuote e gateEnvFile', () => {
  assert.strictEqual(core.shellQuote("it's"), `'it'\\''s'`);
  const env = core.gateEnvFile({ projectDir: 'C:\\r\\.agentyard\\projects\\x', worktree: 'C:\\r', milestone: 'M2', verify: 'npm test', gate: true, maxRetries: 3 });
  assert.ok(env.includes("PROJECT_DIR='C:/r/.agentyard/projects/x'"));
  assert.ok(env.includes("GATE='1'"));
  assert.ok(env.includes("MILESTONE='M2'"));
});

check('renderContext: marco atual, diário e regras; planejamento só o essencial', () => {
  const plan = core.parsePlan(PLAN);
  const config = { title: 'Login OAuth', goal: 'Entrar com Google', verify: 'npm test', review: 'auto', gate: true, created: 0 };
  const txt = core.renderContext({ config, rel: '.agentyard/projects/login', status: 'running', milestone: plan[1], milestones: plan, progress: '## dia 1\nfeito X' });
  assert.ok(txt.includes('Login OAuth'));
  assert.ok(txt.includes('→ [M2] Login (1/2)'));
  assert.ok(txt.includes('- [ ] tela'));
  assert.ok(txt.includes('feito X'));
  assert.ok(txt.includes('`npm test`'));
  assert.ok(txt.includes('BLOCKED.md'));
  const planning = core.renderContext({ config, rel: 'x', status: 'planning', milestones: [], progress: '' });
  assert.ok(/PLANNING/.test(planning) && !planning.includes('BLOCKED.md'));
});

check('prompts citam os arquivos do projeto', () => {
  const config = { title: 'P', goal: 'G', verify: 'make check', review: 'auto', gate: true, created: 0 };
  assert.ok(core.planningPrompt(config, 'R').includes('R/PLAN.md') && core.planningPrompt(config, 'R').includes('## [M1]'));
  assert.ok(core.planningPrompt(config, 'R').includes('make check'));
  const m = { id: 'M4', title: 'T', items: [] };
  assert.ok(core.milestonePrompt(config, 'R', m, false).includes('[M4]'));
  assert.ok(core.milestonePrompt(config, 'R', m, true).includes('git log'));
});

check('detectVerify', () => {
  const w = path.join(dir, 'detect');
  fs.mkdirSync(w);
  assert.strictEqual(core.detectVerify(w), '');
  assert.strictEqual(core.detectVerify(w, ' make test '), 'make test');
  fs.writeFileSync(path.join(w, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.strictEqual(core.detectVerify(w), '');
  fs.writeFileSync(path.join(w, 'package.json'), JSON.stringify({ scripts: { test: 'node t.js' } }));
  assert.strictEqual(core.detectVerify(w), 'npm test');
  fs.writeFileSync(path.join(w, 'pnpm-lock.yaml'), '');
  assert.strictEqual(core.detectVerify(w), 'pnpm test');
  const g = path.join(dir, 'go');
  fs.mkdirSync(g);
  fs.writeFileSync(path.join(g, 'go.mod'), '');
  assert.strictEqual(core.detectVerify(g), 'go test ./...');
});

check('parseGate, slugOf e durationText', () => {
  assert.deepStrictEqual(core.parseGate('pass\n'), { kind: 'pass' });
  assert.deepStrictEqual(core.parseGate('fail verify'), { kind: 'fail', why: 'verify' });
  assert.strictEqual(core.parseGate('lixo'), undefined);
  assert.strictEqual(core.slugOf('Migração do Login p/ OAuth!'), 'migracao-do-login-p-oauth');
  assert.strictEqual(core.durationText(42 * 60000), '42 min');
  assert.strictEqual(core.durationText(125 * 60000), '2 h 5 min');
});

// ---------- o portão de verdade, no bash que o Claude Code usa ----------
let bash;
try {
  execFileSync('bash', ['-c', 'true']);
  execFileSync('git', ['--version']);
  bash = 'bash';
} catch {
  // sem bash/git: pula
}

check('portão do Stop: checklist, diário, commit, verificação, BLOCKED e desistência', () => {
  if (!bash) return console.log('     (sem bash/git, pulado)');
  const events = path.join(dir, 'events');
  writeHookSettings(events);
  const wt = path.join(dir, 'wt');
  fs.mkdirSync(wt);
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: wt, stdio: 'pipe' });
  git('init', '-q');
  const paths = core.projectPaths(wt, 'proj');
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.plan, '## [M1] Um\n- [ ] item\n## [M2] Dois\n- [ ] outro\n');
  fs.writeFileSync(paths.progress, '# P\n');
  fs.writeFileSync(path.join(wt, 'ok.flag'), '');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const id = 'term1';
  fs.writeFileSync(
    path.join(events, `${id}.project`),
    core.gateEnvFile({ projectDir: paths.dir, worktree: wt, milestone: 'M1', verify: 'test -f ok.flag', gate: true, maxRetries: 5 }),
  );
  fs.writeFileSync(path.join(events, `${id}.context.md`), 'CONTEXTO DO PROJETO\n');
  const run = ev => spawnSync(bash, ['-c', projectHookCommand(events, ev)], { input: '{}', env: { ...process.env, WTGRAPH_AGENT_ID: id }, encoding: 'utf8' });
  const gate = () => fs.readFileSync(path.join(events, `${id}.gate`), 'utf8').trim();
  const later = () => {
    // mtime do PROGRESS.md precisa passar o do .turn
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(paths.progress, t, t);
  };

  // SessionStart injeta o contexto
  assert.strictEqual(run('SessionStart').stdout, 'CONTEXTO DO PROJETO\n');
  // terminal sem .project: sai sem fazer nada
  assert.strictEqual(spawnSync(bash, ['-c', projectHookCommand(events, 'Stop')], { input: '{}', env: { ...process.env, WTGRAPH_AGENT_ID: 'outro' } }).status, 0);

  run('UserPromptSubmit');
  let r = run('Stop');
  assert.strictEqual(r.status, 2);
  assert.strictEqual(gate(), 'fail checklist');
  assert.ok(r.stderr.includes('[M1]') && r.stderr.includes('(1)'), r.stderr);

  fs.writeFileSync(paths.plan, '## [M1] Um\n- [x] item\n## [M2] Dois\n- [ ] outro\n');
  r = run('Stop');
  assert.strictEqual(r.status, 2);
  assert.strictEqual(gate(), 'fail progress');

  fs.appendFileSync(paths.progress, '## hoje [M1]\nfeito\n');
  later();
  r = run('Stop');
  assert.strictEqual(r.status, 2);
  assert.strictEqual(gate(), 'fail commit');

  git('add', '-A');
  git('commit', '-qm', 'M1');
  fs.unlinkSync(path.join(wt, 'ok.flag'));
  git('commit', '-qam', 'quebra');
  r = run('Stop');
  assert.strictEqual(r.status, 2);
  assert.strictEqual(gate(), 'fail verify');
  assert.ok(r.stderr.includes('test -f ok.flag'), r.stderr);

  fs.writeFileSync(path.join(wt, 'ok.flag'), '');
  git('add', '-A');
  git('commit', '-qm', 'conserta');
  later();
  r = run('Stop');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(gate(), 'pass');

  // BLOCKED.md libera sem checar nada
  fs.writeFileSync(paths.plan, '## [M1] Um\n- [ ] de novo\n');
  fs.writeFileSync(paths.blocked, '# Bloqueado\nPreciso da chave da API\n');
  assert.strictEqual(run('Stop').status, 0);
  assert.strictEqual(gate(), 'blocked');
  fs.unlinkSync(paths.blocked);

  // depois de MAX_RETRIES bloqueios seguidos, desiste; UserPromptSubmit zera
  fs.writeFileSync(path.join(events, `${id}.retries`), '5');
  assert.strictEqual(run('Stop').status, 0);
  assert.strictEqual(gate(), 'giveup');
  run('UserPromptSubmit');
  assert.strictEqual(run('Stop').status, 2);
  assert.strictEqual(fs.readFileSync(path.join(events, `${id}.retries`), 'utf8').trim(), '1');

  // portão desligado (sessão de planejamento): Stop sempre libera
  fs.writeFileSync(path.join(events, `${id}.project`), core.gateEnvFile({ projectDir: paths.dir, worktree: wt, milestone: '', verify: 'false', gate: false, maxRetries: 3 }));
  assert.strictEqual(run('Stop').status, 0);
});

fs.rmSync(dir, { recursive: true, force: true });
if (failures) {
  console.log(`${failures} falha(s)`);
  process.exit(1);
}
