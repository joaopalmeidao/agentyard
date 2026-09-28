// Testes de src/remote/core (acesso remoto pelo túnel do VS Code: link do túnel e ntfy).
// Uso: node test/remote.test.js
const assert = require('assert');
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

(async () => {
  await check('isTunnelLink reconhece o link do Remote Tunnels', () => {
    assert.ok(R.isTunnelLink('https://vscode.dev/tunnel/meu-pc/g:/worktree-graph'));
    assert.ok(R.isTunnelLink('https://insiders.vscode.dev/tunnel/meu-pc'));
    assert.ok(R.isTunnelLink('  https://vscode.dev/tunnel/meu-pc/home/eu/app\n'));
    assert.ok(!R.isTunnelLink('https://vscode.dev/tunnel/'));
    assert.ok(!R.isTunnelLink('https://vscode.dev/github/eu/app'));
    assert.ok(!R.isTunnelLink('https://evil.com/vscode.dev/tunnel/x'));
    assert.ok(!R.isTunnelLink('https://vscode.dev.evil.com/tunnel/x'));
    assert.ok(!R.isTunnelLink('agentyard-tunnel-123'));
    assert.ok(!R.isTunnelLink(undefined));
  });

  await check('ntfyRequest publica em JSON na raiz do servidor', () => {
    const r = R.ntfyRequest('https://ntfy.sh/agentyard-abc', 'Título', 'corpo', 'https://vscode.dev/tunnel/pc');
    assert.strictEqual(r.url, 'https://ntfy.sh/');
    assert.deepStrictEqual(r.json, { topic: 'agentyard-abc', title: 'Título', message: 'corpo', tags: ['robot'], click: 'https://vscode.dev/tunnel/pc' });
    assert.ok(!('click' in R.ntfyRequest('https://ntfy.sh/agentyard-abc', 't', 'b').json));
    assert.strictEqual(R.ntfyRequest('https://meu.host/ntfy/topico', 't', 'b').url, 'https://meu.host/ntfy/');
    assert.strictEqual(R.ntfyRequest('https://ntfy.sh/', 't', 'b'), undefined);
    assert.strictEqual(R.ntfyRequest('não é url', 't', 'b'), undefined);
    assert.strictEqual(R.ntfyRequest('file:///x/y', 't', 'b'), undefined);
  });

  if (failures) {
    console.log(`\n${failures} falha(s)`);
    process.exit(1);
  }
  console.log('\nremote: tudo ok');
})();
