// Testes de src/remote/core (acesso remoto: token, estado, servidor e ntfy) com home sintético.
// Uso: node test/remote.test.js
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wtg-remote-'));
process.env.AGENTYARD_HOME = path.join(root, 'home');
const R = require('../out/remote/core');

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

const get = (port, url, headers = {}, method = 'GET') =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers }, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });

(async () => {
  await check('token: cria uma vez, reaproveita e troca com reset', () => {
    const a = R.remoteToken();
    assert.ok(a.length >= 32 && /^[A-Za-z0-9_-]+$/.test(a));
    assert.strictEqual(R.remoteToken(), a);
    const b = R.remoteToken(undefined, true);
    assert.notStrictEqual(b, a);
    assert.strictEqual(R.remoteToken(), b);
  });

  await check('authorized compara o Bearer inteiro', () => {
    assert.ok(R.authorized('Bearer abc', 'abc'));
    assert.ok(!R.authorized('Bearer abd', 'abc'));
    assert.ok(!R.authorized('Bearer abcd', 'abc'));
    assert.ok(!R.authorized(undefined, 'abc'));
    assert.ok(!R.authorized('Bearer ', ''));
  });

  await check('remoteLink põe o token no fragmento', () => {
    assert.strictEqual(R.remoteLink('https://pc.ts.net/', 'xyz'), 'https://pc.ts.net/#k=xyz');
    assert.strictEqual(R.remoteLink('http://localhost:7420', 'xyz'), 'http://localhost:7420/#k=xyz');
    assert.ok(R.isLoopback('127.0.0.1') && R.isLoopback('localhost') && !R.isLoopback('0.0.0.0'));
  });

  await check('remoteState: sem caminhos absolutos e quem espera primeiro', () => {
    const now = 1_000_000;
    const s = R.remoteState(
      [
        { pid: 1, repo: 'app', updated: now, agents: [] },
        {
          pid: 2,
          root: '/src/api',
          updated: now,
          agents: [
            { id: 'a', terminal: 'Claude · x', agent: 'Claude Code', worktree: '/src/api.wt/x', branch: 'feat/x', state: 'working', started: now - 60_000 },
            { id: 'b', terminal: 'Claude · y', agent: 'Claude Code', worktree: '/src/api.wt/y', state: 'waiting', message: 'Allow Bash?', started: 0, stateAt: now - 120_000, usd: 0.5 },
          ],
        },
      ],
      now,
    );
    assert.strictEqual(s.repos.length, 1);
    assert.strictEqual(s.repos[0].repo, 'api');
    assert.deepStrictEqual(s.repos[0].agents.map(a => a.branch), ['y', 'feat/x']);
    assert.strictEqual(s.repos[0].agents[0].since, 120_000);
    assert.ok(!JSON.stringify(s).includes('/src/'));
  });

  await check('ntfyRequest publica em JSON na raiz do servidor', () => {
    const r = R.ntfyRequest('https://ntfy.sh/agentyard-abc', 'Título', 'corpo', 'https://pc.ts.net');
    assert.strictEqual(r.url, 'https://ntfy.sh/');
    assert.deepStrictEqual(r.json, { topic: 'agentyard-abc', title: 'Título', message: 'corpo', tags: ['robot'], click: 'https://pc.ts.net' });
    assert.strictEqual(R.ntfyRequest('https://meu.host/ntfy/topico', 't', 'b').url, 'https://meu.host/ntfy/');
    assert.strictEqual(R.ntfyRequest('https://ntfy.sh/', 't', 'b'), undefined);
    assert.strictEqual(R.ntfyRequest('não é url', 't', 'b'), undefined);
    assert.strictEqual(R.ntfyRequest('file:///x/y', 't', 'b'), undefined);
  });

  await check('página não carrega dados e escapa os textos', () => {
    const html = R.remotePage({ title: 'A<b>', states: {}, empty: '</script><x>', offline: '', denied: '', noToken: '', updated: '', answer: '', asking: '', review: '', yourTurn: '', running: '', ended: '', waitingCount: '' });
    assert.ok(html.includes('<title>A&lt;b&gt;</title>'));
    assert.ok(!html.includes('</script><x>'));
    assert.ok(html.includes("fetch('api/state'"));
  });

  const token = R.remoteToken();
  const server = R.createRemoteServer({ token: () => R.remoteToken(), state: () => ({ now: 1, repos: [] }), page: () => '<p>page</p>' });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  await check('servidor: página sem token, estado só com token', async () => {
    const page = await get(port, '/');
    assert.strictEqual(page.status, 200);
    assert.ok(page.headers['content-security-policy'].includes("default-src 'none'"));
    assert.strictEqual(page.headers['cache-control'], 'no-store');
    assert.strictEqual((await get(port, '/api/state')).status, 401);
    assert.strictEqual((await get(port, '/api/state', { authorization: 'Bearer errado' })).status, 401);
    assert.strictEqual((await get(port, `/api/state?k=${token}`)).status, 401);
    const ok = await get(port, '/api/state', { authorization: `Bearer ${token}` });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(JSON.parse(ok.body), { now: 1, repos: [] });
    assert.strictEqual((await get(port, '/api/state', { authorization: `Bearer ${token}` }, 'POST')).status, 405);
    assert.strictEqual((await get(port, '/x')).status, 404);
  });

  await check('servidor: token trocado derruba o link antigo', async () => {
    const novo = R.remoteToken(undefined, true);
    assert.strictEqual((await get(port, '/api/state', { authorization: `Bearer ${token}` })).status, 401);
    assert.strictEqual((await get(port, '/api/state', { authorization: `Bearer ${novo}` })).status, 200);
  });

  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  if (failures) {
    console.log(`\n${failures} falha(s)`);
    process.exit(1);
  }
  console.log('\nremote: tudo ok');
})();
