// Criação de issues no GitHub, GitLab self-hosted e Redmine contra um servidor falso.
// Uso: node test/issuesCreate.test.js
const assert = require('assert');
const http = require('http');
const { parseRemote, GitHubClient, GitLabClient } = require('../out/hosting/core');
const { RedmineClient } = require('../out/issues/core');

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
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const b = body ? JSON.parse(body) : undefined;
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: b });
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'POST' && req.url === '/gh/repos/dono/repo/issues')
        return send(201, { number: 42, title: b.title, body: b.body, html_url: 'https://github.com/dono/repo/issues/42', labels: (b.labels || []).map(n => ({ name: n })), updated_at: '2026-09-27T10:00:00Z' });
      if (req.method === 'POST' && req.url === '/gl/projects/time%2Fapi/issues')
        return send(201, { iid: 7, title: b.title, description: b.description, web_url: 'https://git.empresa.local/time/api/-/issues/7', labels: (b.labels || '').split(',').filter(Boolean), updated_at: '2026-09-27T10:00:00Z' });
      if (req.method === 'POST' && req.url === '/rm/issues.json') {
        if (req.headers['x-redmine-api-key'] !== 'chave') return send(401, {});
        if (!b.issue.project_id) return send(422, { errors: ['Projeto não pode ficar em branco'] });
        return send(201, { issue: { id: 123, subject: b.issue.subject, description: b.issue.description, project: { name: 'Portal' }, updated_on: '2026-09-27T10:00:00Z' } });
      }
      send(404, { message: 'not found' });
    });
  });
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  await check('GitHub: cria issue com labels', async () => {
    const c = new GitHubClient(parseRemote('https://github.com/dono/repo.git'), 't', `${base}/gh`);
    const i = await c.createIssue({ title: 'Bug no login', body: 'passos…', labels: ['bug', 'login'] });
    assert.strictEqual(i.key, '#42');
    assert.deepStrictEqual(seen.at(-1).body, { title: 'Bug no login', body: 'passos…', labels: ['bug', 'login'] });
  });

  await check('GitLab self-hosted: cria issue (labels como texto separado por vírgula)', async () => {
    const c = new GitLabClient(parseRemote('git@git.empresa.local:time/api.git', ['git.empresa.local']), 'glpat', `${base}/gl`);
    const i = await c.createIssue({ title: 'Melhoria', body: 'desc', labels: ['a', 'b'] });
    assert.ok(i.key.includes('7'), i.key);
    assert.deepStrictEqual(seen.at(-1).body, { title: 'Melhoria', description: 'desc', labels: 'a,b' });
    assert.strictEqual(seen.at(-1).headers['private-token'], 'glpat');
  });

  await check('GitLab: sem labels não manda o campo', async () => {
    const c = new GitLabClient(parseRemote('git@gitlab.com:time/api.git'), 'glpat', `${base}/gl`);
    await c.createIssue({ title: 'X', body: '' });
    assert.ok(!('labels' in seen.at(-1).body));
  });

  await check('Redmine: cria issue no projeto com a chave de API', async () => {
    const c = new RedmineClient(`${base}/rm`, 'chave');
    const i = await c.createIssue({ projectId: 'portal', title: 'Relatório lento', body: 'detalhes' });
    assert.strictEqual(i.id, 123);
    assert.deepStrictEqual(seen.at(-1).body, { issue: { project_id: 'portal', subject: 'Relatório lento', description: 'detalhes' } });
  });

  await check('Redmine: erro de validação vira mensagem legível', async () => {
    const c = new RedmineClient(`${base}/rm`, 'chave');
    await assert.rejects(c.createIssue({ projectId: '', title: 'x', body: '' }), /422|Projeto/);
  });

  server.close();
  if (failures) process.exit(1);
})();
