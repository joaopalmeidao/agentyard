// Testes de src/bridge (ponte Claude Code ↔ AgentYard) com home e projeto sintéticos: roda o servidor
// MCP e o hook com os mesmos comandos gravados no projeto. Uso: node test/bridge.test.js
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wtg-bridge-'));
process.env.AGENTYARD_HOME = path.join(root, 'home');
process.env.AGENTYARD_NO_MAIN = '1';
const C = require('../out/bridge/core');
const M = require('../out/bridge/mcpServer');

/** Roda um comando no shell (como o Claude roda os hooks), sem travar o servidor falso deste processo. */
const runShell = (cmd, input, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true, ...opts });
    let out = '';
    child.stdout.on('data', d => (out += d));
    const timer = setTimeout(() => child.kill(), 10000);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(`saiu com ${code}`));
    });
    child.stdin.end(input);
  });

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

const repo = path.join(root, 'repo');
const wt = path.join(root, 'repo.worktrees', 'feat-x');
fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
fs.mkdirSync(path.join(wt, 'src'), { recursive: true });

(async () => {
  await check('isInside ignora maiúsculas e separador, e não confunde prefixo de nome', () => {
    assert.ok(C.isInside(path.join(wt, 'src'), wt));
    assert.ok(C.isInside(wt.toUpperCase(), wt));
    assert.ok(C.isInside(wt, wt + path.sep));
    assert.ok(!C.isInside(wt + '-2', wt));
  });

  await check('pickBridge escolhe a worktree de caminho mais longo', () => {
    const a = { pid: 1, port: 1, token: 'a', roots: [repo], started: 1 };
    const b = { pid: 2, port: 2, token: 'b', roots: [wt], started: 1 };
    assert.strictEqual(C.pickBridge([a, b], path.join(wt, 'src')).pid, 2);
    assert.strictEqual(C.pickBridge([a, b], repo).pid, 1);
    assert.strictEqual(C.pickBridge([a, b], root), undefined);
  });

  await check('pickBridge atende projeto da lista (não ativo), mas a janela com ele ativo vence', () => {
    const other = path.join(root, 'outro-repo');
    const lista = { pid: 3, port: 3, token: 'c', roots: [repo], others: [other], started: 5 };
    const ativo = { pid: 4, port: 4, token: 'd', roots: [other], started: 1 };
    assert.strictEqual(C.pickBridge([lista], path.join(other, 'src')).pid, 3);
    assert.strictEqual(C.pickBridge([lista, ativo], path.join(other, 'src')).pid, 4);
    assert.strictEqual(C.pickBridge([lista, ativo], repo).pid, 3);
    // anúncio antigo, sem `others`
    assert.strictEqual(C.pickBridge([{ pid: 5, port: 5, token: 'e', roots: [repo], started: 1 }], other), undefined);
  });

  await check('worktreePathsOf lê as worktrees do .git sem processo git', () => {
    const main = path.join(root, 'wt-repo');
    const linked = path.join(root, 'wt-repo.worktrees', 'feat');
    fs.mkdirSync(path.join(main, '.git', 'worktrees', 'feat'), { recursive: true });
    fs.mkdirSync(path.join(main, '.git', 'worktrees', 'sumiu'), { recursive: true });
    fs.mkdirSync(linked, { recursive: true });
    fs.writeFileSync(path.join(main, '.git', 'worktrees', 'feat', 'gitdir'), path.join(linked, '.git') + '\n');
    fs.writeFileSync(path.join(main, '.git', 'worktrees', 'sumiu', 'gitdir'), path.join(root, 'nao-existe', '.git') + '\n');
    assert.deepStrictEqual(C.worktreePathsOf(main), [path.normalize(main), path.normalize(linked)]);
    assert.deepStrictEqual(C.worktreePathsOf(path.join(root, 'sem-git')), [path.join(root, 'sem-git')]);
  });

  await check('listBridges apaga anúncios de processos mortos', () => {
    C.writeBridgeInfo({ pid: 999999, port: 5, token: 't', roots: [repo], started: 1 });
    C.writeBridgeInfo({ pid: 888888, port: 6, token: 't', roots: [repo], started: 1 });
    const list = C.listBridges(undefined, pid => pid === 888888);
    assert.deepStrictEqual(list.map(b => b.pid), [888888]);
    assert.ok(!fs.existsSync(path.join(process.env.AGENTYARD_HOME, 'bridges', '999999.json')));
    C.removeBridgeInfo(888888);
  });

  await check('instalação preserva o que já existe e é idempotente', () => {
    fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { outro: { command: 'x' } } }));
    fs.writeFileSync(
      C.settingsFile(repo),
      JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(npm test)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo meu' }] }] } }),
    );
    C.installMcp(repo);
    C.configureSettings(repo, { hooks: true, allowReadOnly: true });
    C.configureSettings(repo, { hooks: true, allowReadOnly: true });
    const mcp = JSON.parse(fs.readFileSync(C.mcpFile(repo), 'utf8'));
    assert.ok(mcp.mcpServers.outro && mcp.mcpServers.agentyard);
    assert.ok(!JSON.stringify(mcp).includes(os.homedir()), 'sem caminho da máquina no arquivo versionado');
    const s = JSON.parse(fs.readFileSync(C.settingsFile(repo), 'utf8'));
    assert.strictEqual(s.model, 'opus');
    assert.strictEqual(s.hooks.Stop.length, 2, 'hook do usuário + o nosso, sem duplicar');
    assert.strictEqual(s.permissions.allow.filter(r => r === 'mcp__agentyard__status').length, 1);
    const st = C.integrationStatus(repo);
    assert.ok(st.mcp && st.allowReadOnly);
    assert.deepStrictEqual(st.hooks.sort(), C.HOOK_EVENTS.map(e => e.event).sort());
  });

  await check('remoção tira só o que a extensão pôs', () => {
    C.uninstallMcp(repo);
    C.configureSettings(repo, { hooks: false, allowReadOnly: false });
    const mcp = JSON.parse(fs.readFileSync(C.mcpFile(repo), 'utf8'));
    assert.deepStrictEqual(Object.keys(mcp.mcpServers), ['outro']);
    const s = JSON.parse(fs.readFileSync(C.settingsFile(repo), 'utf8'));
    assert.deepStrictEqual(s.permissions.allow, ['Bash(npm test)']);
    assert.deepStrictEqual(s.hooks, { Stop: [{ hooks: [{ type: 'command', command: 'echo meu' }] }] });
    const st = C.integrationStatus(repo);
    assert.ok(!st.mcp && !st.hooks.length && !st.allowReadOnly);
  });

  await check('integrationStatus relata JSON inválido sem lançar', () => {
    const other = path.join(root, 'quebrado');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, '.mcp.json'), '{ nao é json');
    assert.ok(C.integrationStatus(other).error);
  });

  await check('MCP: initialize, tools/list e notificações', async () => {
    const init = await M.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    assert.strictEqual(init.result.protocolVersion, '2025-03-26');
    assert.ok(init.result.capabilities.tools);
    const list = await M.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepStrictEqual(list.result.tools.map(t => t.name), C.TOOLS.map(t => t.name));
    assert.strictEqual(await M.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
    assert.strictEqual((await M.handle({ jsonrpc: '2.0', id: 3, method: 'x/y' })).error.code, -32601);
  });

  await check('MCP sem janela aberta responde com erro legível', async () => {
    const r = await M.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'status', arguments: {} } }, root);
    assert.ok(r.result.isError);
    assert.match(r.result.content[0].text, /não está aberto/);
  });

  // ---------------------------------------------------------- ponta a ponta com uma "janela" falsa
  const got = [];
  const token = 'segredo';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(403);
        return res.end('{"error":"negado"}');
      }
      const j = JSON.parse(body);
      got.push({ route: req.url, body: j });
      res.writeHead(200, { 'content-type': 'application/json' });
      let reply = { ok: true };
      if (req.url === '/tool') reply = { text: `ok ${j.name} em ${path.basename(j.cwd)}` };
      else if (j.hook_event_name === 'PreToolUse') reply = { stdout: JSON.stringify({ decision: 'x', agent: j.agentId }) };
      else if (j.hook_event_name === 'UserPromptSubmit') reply = { stderr: 'bloqueado', exit: 2 };
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  C.writeBridgeInfo({ pid: process.pid, port: server.address().port, token, roots: [repo, wt], started: Date.now() });
  C.installScripts(path.join(__dirname, '..', 'out', 'bridge'));
  // rodando num terminal do AgentYard, as WTGRAPH_* dele calariam o hook (WTGRAPH_BRIDGE=1)
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('WTGRAPH_')));
  env.AGENTYARD_NO_MAIN = '';

  await check('servidor MCP instalado roda pelo comando do .mcp.json e repassa a chamada', async () => {
    const entry = C.mcpServerEntry();
    const child = spawn(process.execPath, entry.args, { cwd: path.join(wt, 'src'), env });
    const lines = [];
    let buf = '';
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
    const send = m => child.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'status', arguments: {} } });
    const deadline = Date.now() + 10000;
    while (lines.length < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    child.kill();
    assert.strictEqual(lines.length, 2, `respostas: ${JSON.stringify(lines)}`);
    assert.strictEqual(lines[1].id, 2);
    assert.strictEqual(lines[1].result.content[0].text, 'ok status em src');
  });

  await check('hook instalado roda pelo comando do settings.json (shell) e repassa o evento', async () => {
    got.length = 0;
    const payload = JSON.stringify({ hook_event_name: 'Stop', session_id: 'abc', cwd: wt });
    const cmd = C.hookCommand().replace(/^node /, `"${process.execPath}" `);
    await runShell(cmd, payload, { env, cwd: root });
    const hook = got.find(g => g.route === '/hook');
    assert.ok(hook, 'a janela recebeu o hook');
    assert.strictEqual(hook.body.hook_event_name, 'Stop');
    assert.strictEqual(hook.body.cwd, wt);
  });

  await check('hook fora de qualquer repositório não falha nem escreve nada', async () => {
    const cmd = C.hookCommand().replace(/^node /, `"${process.execPath}" `);
    assert.strictEqual(await runShell(cmd, JSON.stringify({ hook_event_name: 'Stop', cwd: os.tmpdir() }), { env }), '');
  });

  await check('comando do projeto sem a extensão instalada não faz nada', async () => {
    const cmd = C.hookCommand().replace(/^node /, `"${process.execPath}" `);
    assert.strictEqual(await runShell(cmd, '{}', { env: { ...env, AGENTYARD_HOME: path.join(root, 'nada') } }), '');
  });

  const runShellCode = (cmd, input, opts) =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, { shell: true, ...opts });
      let out = '';
      let err = '';
      child.stdout.on('data', d => (out += d));
      child.stderr.on('data', d => (err += d));
      const timer = setTimeout(() => child.kill(), 10000);
      child.on('error', reject);
      child.on('close', code => {
        clearTimeout(timer);
        resolve({ code, out, err });
      });
      child.stdin.end(input);
    });

  await check('hook dos terminais da extensão devolve ao Claude o que a janela respondeu', async () => {
    const cmd = C.launchHookCommand(process.execPath);
    assert.ok(cmd.startsWith('ELECTRON_RUN_AS_NODE=1 ') && cmd.endsWith('--launched') && !cmd.includes('\\'), cmd);
    // o shell do teste pode não ser bash: roda o mesmo executável e script direto
    const direct = `"${process.execPath}" "${path.join(process.env.AGENTYARD_HOME, 'bin', C.HOOK_SCRIPT)}" --launched`;
    const r = await runShellCode(direct, JSON.stringify({ hook_event_name: 'PreToolUse', cwd: wt, tool_name: 'Bash' }), { env: { ...env, WTGRAPH_AGENT_ID: 'ag-1', WTGRAPH_BRIDGE: '1' } });
    assert.strictEqual(r.code, 0);
    assert.deepStrictEqual(JSON.parse(r.out), { decision: 'x', agent: 'ag-1' });
    const b = await runShellCode(direct, JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: wt }), { env });
    assert.strictEqual(b.code, 2);
    assert.strictEqual(b.err, 'bloqueado');
  });

  await check('hook do projeto fica quieto nos terminais que já têm os hooks da extensão', async () => {
    got.length = 0;
    const cmd = C.hookCommand().replace(/^node /, `"${process.execPath}" `);
    assert.strictEqual(await runShell(cmd, JSON.stringify({ hook_event_name: 'PreToolUse', cwd: wt }), { env: { ...env, WTGRAPH_BRIDGE: '1' } }), '');
    assert.strictEqual(got.length, 0);
  });

  await check('launchHooks e launchMcpConfig', () => {
    const h = C.launchHooks('/x/Code.exe', '/home/u/.agentyard');
    assert.deepStrictEqual(Object.keys(h).sort(), ['PermissionRequest', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    assert.strictEqual(h.PreToolUse[0].matcher, C.GUARDED_TOOLS);
    assert.strictEqual(h.PermissionRequest[0].hooks[0].timeout, 600);
    assert.ok(C.hookWaitMs('PermissionRequest') > 500_000 && C.hookWaitMs('Stop') < 30_000 && C.hookWaitMs('SessionStart') < 30_000);
    const m = C.launchMcpConfig('/x/Code.exe', '/home/u/.agentyard');
    assert.strictEqual(m.mcpServers.agentyard.command, '/x/Code.exe');
    assert.strictEqual(m.mcpServers.agentyard.env.ELECTRON_RUN_AS_NODE, '1');
    assert.ok(m.mcpServers.agentyard.args[0].endsWith(C.MCP_SCRIPT));
  });

  server.close();
  C.removeBridgeInfo(process.pid);
  fs.rmSync(root, { recursive: true, force: true });
  if (failures) {
    console.log(`\n${failures} falha(s)`);
    process.exit(1);
  }
  console.log('\nbridge: tudo ok');
})();
