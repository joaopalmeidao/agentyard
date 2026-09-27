// Testes das issues (GitHub, GitLab self-hosted, Redmine) contra um servidor HTTP falso.
// Uso: node test/issues.test.js
const assert = require('assert');
const http = require('http');
const { parseRemote, GitHubClient, GitLabClient, suggestBody } = require('../out/hosting/core');
const { RedmineClient, issueBranch, issueTrailer, renderPrompt, DEFAULT_ISSUE_PROMPT } = require('../out/issues/core');

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
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const u = req.url;
    if (u === '/gh/user') return send(200, { login: 'joao' });
    if (u.startsWith('/gh/repos/dono/repo/issues'))
      return send(200, [
        { number: 12, title: 'Corrigir login', body: 'Passos…', html_url: 'https://github.com/dono/repo/issues/12', labels: [{ name: 'bug' }], assignee: { login: 'joao' }, updated_at: '2026-09-20T10:00:00Z' },
        { number: 13, title: 'Um PR', html_url: 'x', labels: [], pull_request: { url: 'y' }, updated_at: '2026-09-20T10:00:00Z' },
      ]);
    if (u.startsWith('/gl/projects/time%2Fbackend%2Fapi/issues'))
      return send(200, [{ iid: 7, title: 'Tela de relatórios', description: 'd', web_url: 'https://git.empresa.local/time/backend/api/-/issues/7', labels: ['feature'], assignee: { username: 'joao' }, updated_at: '2026-09-21T10:00:00Z' }]);
    if (u === '/rm/users/current.json') {
      if (req.headers['x-redmine-api-key'] !== 'chave') return send(401, { errors: ['chave inválida'] });
      return send(200, { user: { login: 'joao.almeida' } });
    }
    if (u.startsWith('/rm/issues.json'))
      return send(200, {
        issues: [
          { id: 4512, subject: 'Relatório de prazos está lento', description: 'Demora 30 s', project: { name: 'Jurídico' }, tracker: { name: 'Bug' }, status: { name: 'Nova' }, priority: { name: 'Alta' }, assigned_to: { name: 'João' }, updated_on: '2026-09-22T10:00:00Z' },
        ],
      });
    if (u.startsWith('/rm/projects.json')) return send(200, { projects: [{ id: 1, identifier: 'juridico', name: 'Jurídico' }] });
    send(404, { message: 'not found' });
  });
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const gh = new GitHubClient(parseRemote('https://github.com/dono/repo.git'), 'tok', `${base}/gh`);
  await check('GitHub: minhas issues (assignee=login) sem os PRs', async () => {
    const list = await gh.listIssues('mine');
    assert.deepStrictEqual(list.map(i => [i.key, i.title, i.labels.join()]), [['#12', 'Corrigir login', 'bug']]);
    const q = seen.find(s => s.url.startsWith('/gh/repos/dono/repo/issues')).url;
    assert.ok(q.includes('assignee=joao') && q.includes('state=open'), q);
  });
  await check('GitHub: todas as issues sem filtro de responsável', async () => {
    seen.length = 0;
    await gh.listIssues('all');
    assert.ok(!seen.at(-1).url.includes('assignee='));
  });

  const gl = new GitLabClient(parseRemote('git@git.empresa.local:time/backend/api.git', ['git.empresa.local']), 'glpat', `${base}/gl`);
  await check('GitLab self-hosted: issues atribuídas a mim, subgrupo codificado', async () => {
    const list = await gl.listIssues('mine');
    assert.deepStrictEqual(list.map(i => [i.key, i.provider]), [['#7', 'gitlab']]);
    assert.ok(seen.at(-1).url.includes('scope=assigned_to_me'));
    assert.strictEqual(seen.at(-1).headers['private-token'], 'glpat');
  });

  const rm = new RedmineClient(`${base}/rm/`, 'chave');
  await check('Redmine: whoami com X-Redmine-API-Key', async () => {
    assert.strictEqual(await rm.whoami(), 'joao.almeida');
    assert.strictEqual(seen.at(-1).headers['x-redmine-api-key'], 'chave');
  });
  await check('Redmine: minhas issues abertas do projeto', async () => {
    const list = await rm.listIssues('mine', 'juridico');
    const q = seen.at(-1).url;
    assert.ok(q.includes('assigned_to_id=me') && q.includes('status_id=open') && q.includes('project_id=juridico'), q);
    assert.deepStrictEqual([list[0].key, list[0].url, list[0].labels], ['RM#4512', `${base}/rm/issues/4512`, ['Bug', 'Nova', 'Alta']]);
  });
  await check('Redmine: chave errada vira erro legível', async () => {
    await assert.rejects(new RedmineClient(`${base}/rm`, 'errada').whoami(), /401/);
  });

  await check('nome de branch, trailer do PR e prompt', () => {
    assert.strictEqual(issueBranch({ provider: 'github', id: 12, title: 'Corrigir login no Safari (iOS 17)!' }, 'issue'), 'issue/12-corrigir-login-no-safari-ios-17');
    assert.strictEqual(issueBranch({ provider: 'redmine', id: 4512, title: 'Relatório de prazos está lento' }, 'issue'), 'redmine/4512-relatorio-de-prazos-esta-lento');
    assert.strictEqual(issueTrailer({ provider: 'gitlab', id: 7 }), 'Closes #7');
    assert.strictEqual(issueTrailer({ provider: 'redmine', id: 4512 }), 'Refs #4512');
    assert.strictEqual(suggestBody(['a'], 'PR', ['Closes #12']), '## Commits in this PR\n\n- a\n\nCloses #12');
    const p = renderPrompt(DEFAULT_ISSUE_PROMPT, { key: '#12', title: 'T', body: 'B', url: 'U', branch: 'issue/12-t', base: 'main' });
    assert.ok(p.startsWith('Work on issue #12: T') && p.includes('issue/12-t') && p.includes('main') && !p.includes('${'));
  });

  server.close();
  if (failures) process.exit(1);
})();
