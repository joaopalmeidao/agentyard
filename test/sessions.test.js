// Testes de src/claude/sessions.ts com logs sintéticos. Uso: node test/sessions.test.js [--real]
// --real mede a varredura em ~/.claude (só imprime números).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../out/claude/sessions');

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

const H = 3600_000;
const iso = ms => new Date(ms).toISOString();
const user = (id, cwd, ts, text, extra = {}) => JSON.stringify({ type: 'user', sessionId: id, cwd, gitBranch: 'ai/x', timestamp: iso(ts), message: { role: 'user', content: text }, ...extra });
const asst = (id, ts, msgId, usage, text = 'ok') =>
  JSON.stringify({ type: 'assistant', sessionId: id, cwd: 'x', timestamp: iso(ts), message: { id: msgId, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text }], usage } });
const u = (i, o, cr = 0, cc = 0) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cc });

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wtgraph-claude-'));
  const proj = path.join(root, 'projects', 'G--repo');
  fs.mkdirSync(proj, { recursive: true });
  const now = Date.UTC(2026, 8, 30, 15, 30); // quarta 15:30 UTC
  const wtA = path.join(root, 'repo');
  const wtB = path.join(root, 'repo.worktrees', 'ai-x');

  // sessão A: na worktree principal, duas respostas; a primeira resposta tem 2 linhas (2 blocos) com o mesmo id
  const fa = path.join(proj, 'aaaa.jsonl');
  fs.writeFileSync(
    fa,
    [
      user('aaaa', wtA, now - 2 * H, '<command-name>/clear</command-name>'),
      user('aaaa', path.join(wtA, 'src'), now - 2 * H + 1000, 'Corrija o bug do login   por favor'),
      asst('aaaa', now - 2 * H + 2000, 'm1', u(10, 100, 5000, 1000)),
      asst('aaaa', now - 2 * H + 2100, 'm1', u(10, 100, 5000, 1000), 'segundo bloco'),
      user('aaaa', wtA, now - 2 * H + 3000, 'x', { toolUseResult: { stdout: 'muito texto' } }),
      asst('aaaa', now - 1 * H, 'm2', u(5, 50)),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Bug do login', sessionId: 'aaaa' }),
    ].join('\n') + '\n',
  );
  // subagente da sessão A
  fs.mkdirSync(path.join(proj, 'aaaa', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'aaaa', 'subagents', 'agent-1.jsonl'), asst('aaaa', now - 90 * 60_000, 's1', u(1, 9)) + '\n');
  // sessão B: numa worktree, há 3 dias
  const fb = path.join(proj, 'bbbb.jsonl');
  fs.writeFileSync(fb, [user('bbbb', wtB.toUpperCase(), now - 72 * H, 'Nova tela'), asst('bbbb', now - 72 * H + 5, 'b1', u(1000, 1000))].join('\n') + '\n');
  // sessão C: fora do repositório
  fs.writeFileSync(path.join(proj, 'cccc.jsonl'), [user('cccc', 'E:\\outro', now - 10 * 24 * H, 'antiga'), asst('cccc', now - 10 * 24 * H, 'c1', u(7, 7))].join('\n') + '\n');

  const cache = S.emptyCache();
  let r;
  await check('varredura: título, mensagens, uso sem contar blocos repetidos, subagente somado', async () => {
    r = await S.scanSessions(root, cache, now);
    const a = r.sessions.find(s => s.id === 'aaaa');
    assert.strictEqual(S.sessionTitle(a), 'Bug do login');
    assert.strictEqual(a.firstPrompt, 'Corrija o bug do login por favor');
    assert.strictEqual(a.userMessages, 1, 'comando interno e resultado de ferramenta não contam');
    assert.strictEqual(a.assistantMessages, 2);
    assert.deepStrictEqual(a.usage, { input: 16, output: 159, cacheRead: 5000, cacheCreate: 1000 });
    assert.strictEqual(a.cwd, wtA, 'cwd da primeira linha da sessão');
    assert.deepStrictEqual(a.models, ['claude-opus-5-5']);
    assert.strictEqual(r.sessions[0].id, 'aaaa', 'mais recente primeiro');
  });

  await check('varredura incremental: só lê o que foi acrescentado', async () => {
    const again = await S.scanSessions(root, cache, now);
    assert.strictEqual(again.filesRead, 0);
    fs.appendFileSync(fa, asst('aaaa', now - 30 * 60_000, 'm3', u(1, 1)) + '\n');
    const inc = await S.scanSessions(root, cache, now);
    assert.strictEqual(inc.filesRead, 1);
    assert.ok(inc.bytesRead < 400, `leu ${inc.bytesRead} bytes`);
    assert.strictEqual(inc.sessions.find(s => s.id === 'aaaa').assistantMessages, 3);
  });

  await check('mapeamento para worktree pelo cwd (subpasta, maiúsculas)', async () => {
    const m = S.mapToWorktrees(r.sessions, [wtA, wtB]);
    assert.deepStrictEqual(m.get(wtA).map(s => s.id), ['aaaa']);
    assert.deepStrictEqual(m.get(wtB).map(s => s.id), ['bbbb']);
    assert.ok(![...m.values()].flat().some(s => s.id === 'cccc'));
  });

  await check('janela de 5 h: começa na hora cheia da primeira resposta', async () => {
    const sessions = (await S.scanSessions(root, cache, now)).sessions;
    const b = S.currentBlock(sessions, now);
    assert.strictEqual(b.start, Math.floor((now - 2 * H + 2000) / H) * H);
    // m1 (1110) + subagente (10) + m2 (55) + m3 (2)
    assert.strictEqual(b.tokens, 1110 + 10 + 55 + 2);
    assert.strictEqual(S.currentBlock(sessions, now + 6 * H), undefined, 'sem atividade, sem janela ativa');
  });

  await check('semana: 7 dias corridos e desde segunda', async () => {
    const sessions = (await S.scanSessions(root, cache, now)).sessions;
    assert.strictEqual(S.weekWindow(sessions, 'rolling', now).tokens, 1177 + 2000);
    // now é quarta; segunda 00:00 local fica antes de "há 3 dias" (domingo) → B fica de fora
    const monday = S.weekWindow(sessions, 'monday', now);
    assert.ok(monday.start <= now - 2 * H && monday.start > now - 3 * 24 * H);
    assert.strictEqual(monday.tokens, 1177);
  });

  await check('totais por dia e formatação', async () => {
    const sessions = (await S.scanSessions(root, cache, now)).sessions;
    const d = S.dailyTotals(sessions, 4, now);
    assert.strictEqual(d.length, 4);
    assert.strictEqual(d.reduce((s, x) => s + x.tokens, 0), 3177);
    assert.strictEqual(S.formatTokens(1234567), '1.2M');
  });

  await check('transcrição: texto sem resultados de ferramenta', async () => {
    const a = (await S.scanSessions(root, cache, now)).sessions.find(s => s.id === 'aaaa');
    const md = await S.renderTranscript(a);
    assert.ok(md.startsWith('# Bug do login'));
    assert.ok(md.includes('Corrija o bug do login'));
    assert.ok(md.includes('segundo bloco'));
    assert.ok(!md.includes('muito texto'));
  });

  await check('comandos: projeto, usuário, skill e embutidos', async () => {
    const projDir = path.join(root, 'repo');
    fs.mkdirSync(path.join(projDir, '.claude', 'commands', 'git'), { recursive: true });
    fs.writeFileSync(path.join(projDir, '.claude', 'commands', 'git', 'pr.md'), '---\ndescription: Abre um PR\n---\nCorpo');
    fs.mkdirSync(path.join(root, 'skills', 'minha'), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills', 'minha', 'SKILL.md'), '---\nname: revisar\ndescription: Revisa o código\n---\n');
    const cmds = S.listClaudeCommands(projDir, root);
    const by = Object.fromEntries(cmds.map(c => [c.name, c]));
    assert.strictEqual(by['/git:pr'].description, 'Abre um PR');
    assert.strictEqual(by['/git:pr'].source, 'project');
    assert.strictEqual(by['/revisar'].source, 'skill');
    assert.ok(by['/resume']);
  });

  // última mensagem e recapitulação: raiz própria para não mexer nas contas acima
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wtgraph-recap-'));
  const proj2 = path.join(root2, 'projects', 'G--wt');
  fs.mkdirSync(proj2, { recursive: true });
  const wtR = path.join(root2, 'wt');
  const fr = path.join(proj2, 'rrrr.jsonl');
  const tool = (ts, msgId, name, input) =>
    JSON.stringify({ type: 'assistant', sessionId: 'rrrr', timestamp: iso(ts), message: { id: msgId, role: 'assistant', content: [{ type: 'tool_use', id: 'tu' + ts, name, input }] } });
  fs.writeFileSync(
    fr,
    [
      user('rrrr', wtR, now - H, 'Crie a tela de login'),
      asst('rrrr', now - H + 1000, 'r1', u(1, 1), 'Vou olhar o projeto.'),
      tool(now - H + 2000, 'r1', 'Edit', { file_path: path.join(wtR, 'src', 'login.ts') }),
      tool(now - H + 3000, 'r2', 'Write', { file_path: path.join(wtR, 'src', 'login.css') }),
      tool(now - H + 3500, 'r2', 'Bash', { command: 'npm test' }),
      user('rrrr', wtR, now - H + 3600, 'x', { toolUseResult: { stdout: 'ok' } }),
      asst('rrrr', now - H + 4000, 'r3', u(1, 1), 'Pronto: tela criada.'),
      asst('rrrr', now - H + 4100, 'r3', u(1, 1), 'Falta o teste do logout.'),
      user('rrrr', wtR, now - 10 * 60_000, 'Agora   o logout'),
      asst('rrrr', now - 9 * 60_000, 'r4', u(1, 1), 'Logout feito.'),
    ].join('\n') + '\n',
  );

  await check('última mensagem: último texto do Claude (blocos da mesma resposta juntos) e último pedido', async () => {
    const c = S.emptyCache();
    let s = (await S.scanSessions(root2, c, now)).sessions[0];
    assert.strictEqual(s.lastReply, 'Logout feito.');
    assert.strictEqual(s.lastPrompt, 'Agora o logout');
    assert.strictEqual(s.lastReplyAt, now - 9 * 60_000);
    // resposta nova só com ferramenta não apaga o último texto; texto novo com o mesmo id se junta
    fs.appendFileSync(fr, [tool(now - 8 * 60_000, 'r5', 'Edit', { file_path: path.join(wtR, 'a.ts') }), asst('rrrr', now - 7 * 60_000, 'r5', u(1, 1), 'Parte 1'), asst('rrrr', now - 7 * 60_000 + 1, 'r5', u(1, 1), 'Parte 2')].join('\n') + '\n');
    s = (await S.scanSessions(root2, c, now)).sessions[0];
    assert.strictEqual(s.lastReply, 'Parte 1\n\nParte 2');
  });

  await check('turnos: pedido, arquivos editados, ferramentas e resposta final', async () => {
    const turns = await S.readTurns(fr);
    assert.strictEqual(turns.length, 2, 'resultado de ferramenta não abre turno');
    assert.strictEqual(turns[0].prompt, 'Crie a tela de login');
    assert.strictEqual(turns[0].reply, 'Pronto: tela criada.\n\nFalta o teste do logout.');
    assert.deepStrictEqual(turns[0].files, [path.join(wtR, 'src', 'login.ts'), path.join(wtR, 'src', 'login.css')]);
    assert.strictEqual(turns[0].tools, 3);
    assert.strictEqual(turns[1].reply, 'Parte 1\n\nParte 2');
    assert.deepStrictEqual(turns[1].files, [path.join(wtR, 'a.ts')]);
  });

  await check('recap e última mensagem em Markdown', async () => {
    const info = (await S.scanSessions(root2, S.emptyCache(), now)).sessions[0];
    const turns = await S.readTurns(fr);
    const last = S.renderLastMessage(info, turns, wtR);
    assert.ok(last.includes('> Agora   o logout'), last);
    assert.ok(last.includes('Parte 1\n\nParte 2'));
    assert.ok(last.includes('`a.ts`'), 'caminho relativo à worktree');
    const md = S.renderRecap('ai/login', wtR, [{ info, turns }], { branch: 'ai/login', base: 'main', commits: ['abc123 Tela de login'], uncommitted: [' M src/a.ts'], stat: '2 files changed' });
    assert.ok(md.includes('abc123 Tela de login'));
    assert.ok(md.includes(' M src/a.ts'));
    assert.ok(md.includes('`src/login.ts`'));
    assert.ok(md.includes('### 1. Crie a tela de login'));
    assert.ok(md.includes('> Falta o teste do logout.'));
    assert.ok(S.recapSummaryPrompt(md, 'Brazilian Portuguese').includes('Falta o teste do logout.'));
    const outside = S.renderRecap('x', wtR, [{ info, turns: [{ prompt: 'p', at: now, reply: 'r', files: [path.join(root2, 'rascunho.js')], tools: 1 }] }]);
    assert.ok(!outside.includes('rascunho.js'), 'arquivo fora da worktree não aparece');
  });
  fs.rmSync(root2, { recursive: true, force: true });

  if (process.argv.includes('--real')) {
    const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const c = S.emptyCache();
    let t = Date.now();
    const full = await S.scanSessions(dir, c);
    const first = Date.now() - t;
    t = Date.now();
    const inc = await S.scanSessions(dir, c);
    const second = Date.now() - t;
    const json = JSON.stringify(c).length;
    console.log(`real: ${full.sessions.length} sessões, ${full.filesRead} arquivos, ${(full.bytesRead / 1e6).toFixed(0)} MB em ${first} ms; incremental ${second} ms (${inc.filesRead} arquivos); cache ${(json / 1e6).toFixed(1)} MB`);
  }

  fs.rmSync(root, { recursive: true, force: true });
  if (failures) process.exit(1);
})();
