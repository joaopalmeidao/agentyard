// Testes de src/hosting/core.ts contra um servidor HTTP falso. Uso: node test/hosting.test.js
const assert = require('assert');
const http = require('http');
const { parseRemote, GitHubClient, GitLabClient, suggestTitle } = require('../out/hosting/core');

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
  await check('parseRemote: GitHub https e scp', () => {
    assert.deepStrictEqual(parseRemote('https://github.com/joaopalmeidao/worktree-graph.git'), {
      kind: 'github', host: 'github.com', webBase: 'https://github.com', projectPath: 'joaopalmeidao/worktree-graph',
    });
    assert.strictEqual(parseRemote('git@github.com:dono/repo.git').projectPath, 'dono/repo');
  });

  await check('parseRemote: GitLab self-hosted com subgrupo, ssh com porta e host configurado', () => {
    const a = parseRemote('ssh://git@git.empresa.local:2222/time/backend/api.git', ['https://git.empresa.local:8443']);
    assert.deepStrictEqual(a, { kind: 'gitlab', host: 'git.empresa.local', webBase: 'https://git.empresa.local:8443', projectPath: 'time/backend/api' });
    const b = parseRemote('http://usuario@gitlab.interno:8080/grupo/app');
    assert.deepStrictEqual(b, { kind: 'gitlab', host: 'gitlab.interno', webBase: 'http://gitlab.interno:8080', projectPath: 'grupo/app' });
    assert.strictEqual(parseRemote('git@gitlab.com:g/sub/p.git').projectPath, 'g/sub/p');
    assert.strictEqual(parseRemote('https://bitbucket.org/a/b.git'), undefined);
  });

  await check('parseRemote: GitLab em subcaminho (https://empresa.com/gitlab) e ssh com URL configurada', () => {
    const a = parseRemote('https://empresa.com/gitlab/time/api.git', ['https://empresa.com/gitlab']);
    assert.deepStrictEqual(a, { kind: 'gitlab', host: 'empresa.com', webBase: 'https://empresa.com/gitlab', projectPath: 'time/api' });
    const b = parseRemote('git@empresa.com:time/api.git', ['https://empresa.com/gitlab']);
    assert.deepStrictEqual(b, { kind: 'gitlab', host: 'empresa.com', webBase: 'https://empresa.com/gitlab', projectPath: 'time/api' });
  });

  await check('suggestTitle', () => {
    assert.strictEqual(suggestTitle('ai/refatorar-login', ['a', 'b']), 'Refatorar login');
    assert.strictEqual(suggestTitle('x', ['feat: único commit']), 'feat: único commit');
  });

  // servidor falso: registra as requisições e responde como as APIs reais
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : undefined });
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const u = req.url;
      if (u.startsWith('/gh/repos/dono/repo/pulls') && req.method === 'GET' && u.includes('head=')) return send(200, [{ number: 7, html_url: 'https://github.com/dono/repo/pull/7', title: 'X', state: 'closed', merged_at: '2026-01-01', draft: false, head: { ref: 'ai/x' }, base: { ref: 'main' } }]);
      if (u.startsWith('/gh/repos/dono/repo/pulls') && req.method === 'GET') return send(200, [
        { number: 3, html_url: 'h3', title: 'A', state: 'open', draft: true, head: { ref: 'ai/a', repo: { full_name: 'dono/repo' } }, base: { ref: 'main' } },
        { number: 4, html_url: 'h4', title: 'Fork', state: 'open', draft: false, head: { ref: 'ai/a', repo: { full_name: 'outro/repo' } }, base: { ref: 'main' } },
      ]);
      if (u === '/gh/repos/dono/repo/pulls' && req.method === 'POST') return send(201, { number: 9, html_url: 'h9', title: JSON.parse(body).title, state: 'open', draft: JSON.parse(body).draft, head: { ref: 'ai/b' }, base: { ref: 'main' } });
      if (u.startsWith('/gl/projects/time%2Fbackend%2Fapi/merge_requests') && req.method === 'GET') return send(200, [{ iid: 5, web_url: 'w5', title: 'Draft: M', state: 'opened', draft: true, source_branch: 'ai/c', target_branch: 'master' }]);
      if (u === '/gl/projects/time%2Fbackend%2Fapi/merge_requests' && req.method === 'POST') {
        if (req.headers['private-token'] !== 'glpat-x') return send(401, { message: '401 Unauthorized' });
        return send(201, { iid: 6, web_url: 'w6', title: JSON.parse(body).title, state: 'opened', draft: false, source_branch: 'ai/d', target_branch: 'master' });
      }
      if (u === '/gl/user') return send(200, { username: 'joao' });
      send(404, { message: '404 Not Found' });
    });
  });
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const ghRemote = parseRemote('https://github.com/dono/repo.git');
  const gh = new GitHubClient(ghRemote, 'tok', `${base}/gh`);
  await check('GitHub: lista PRs abertos ignorando forks e marca rascunho', async () => {
    const list = await gh.listOpen();
    assert.deepStrictEqual(list.map(p => [p.ref, p.state, p.source]), [['#3', 'draft', 'ai/a']]);
    assert.strictEqual(seen.at(-1).headers.authorization, 'Bearer tok');
  });
  await check('GitHub: PR mesclado de uma branch', async () => {
    const p = await gh.findForBranch('ai/x');
    assert.strictEqual(p.state, 'merged');
    assert.ok(seen.at(-1).url.includes('head=dono%3Aai%2Fx'));
  });
  await check('GitHub: cria PR rascunho', async () => {
    const p = await gh.create({ source: 'ai/b', target: 'main', title: 'T', body: 'B', draft: true });
    assert.strictEqual(p.ref, '#9');
    assert.deepStrictEqual(seen.at(-1).body, { title: 'T', head: 'ai/b', base: 'main', body: 'B', draft: true });
  });

  const glRemote = parseRemote('git@git.empresa.local:time/backend/api.git', ['git.empresa.local']);
  const gl = new GitLabClient(glRemote, 'glpat-x', `${base}/gl`);
  await check('GitLab self-hosted: lista MRs (subgrupo codificado) e rascunho', async () => {
    const list = await gl.listOpen();
    assert.deepStrictEqual(list.map(m => [m.ref, m.state, m.source]), [['!5', 'draft', 'ai/c']]);
  });
  await check('GitLab self-hosted: cria MR com "Draft:" e PRIVATE-TOKEN', async () => {
    const m = await gl.create({ source: 'ai/d', target: 'master', title: 'Novo', body: 'd', draft: true });
    assert.strictEqual(m.ref, '!6');
    assert.strictEqual(seen.at(-1).body.title, 'Draft: Novo');
    assert.strictEqual(seen.at(-1).body.source_branch, 'ai/d');
  });
  await check('GitLab: token inválido vira erro legível', async () => {
    const bad = new GitLabClient(glRemote, 'errado', `${base}/gl`);
    await assert.rejects(bad.create({ source: 'a', target: 'b', title: 't', body: '', draft: false }), /401/);
  });
  await check('GitLab: whoami', async () => assert.strictEqual(await gl.whoami(), 'joao'));

  server.close();
  if (failures) process.exit(1);
})();
