// Navegador de PRs/MRs (src/prs/core.ts) contra um servidor falso. Uso: node test/prs.test.js
const assert = require('assert');
const http = require('http');
const { parseRemote } = require('../out/hosting/core');
const { GitHubPrBrowser, GitLabPrBrowser, ListOnlyPrBrowser, groupPrs, checkStatus, countDiff, fetchSpecFor, shortText } = require('../out/prs/core');

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
const iso = daysAgo => new Date(Date.now() - daysAgo * 86400000).toISOString();

(async () => {
  await check('agrupamento: meus, pedem minha revisão, abertos e mesclados na janela', () => {
    const pr = (id, author, reviewers = [], mergedDays) => ({ id, ref: `#${id}`, author, reviewers, mergedAt: mergedDays === undefined ? undefined : Date.now() / 1000 - mergedDays * 86400 });
    const g = groupPrs([pr(1, 'joao'), pr(2, 'ana', ['joao']), pr(3, 'ana')], [pr(4, 'joao', [], 2), pr(5, 'ana', [], 20)], 'Joao');
    assert.deepStrictEqual(g.mine.map(p => p.id), [1]);
    assert.deepStrictEqual(g.reviewRequested.map(p => p.id), [2]);
    assert.strictEqual(g.open.length, 3);
    assert.deepStrictEqual(g.recentlyMerged.map(p => p.id), [4]);
  });

  await check('status de check, contagem de diff, texto curto e ref para trazer fork', () => {
    assert.strictEqual(checkStatus('completed', 'failure'), 'failed');
    assert.strictEqual(checkStatus('in_progress', null), 'running');
    assert.strictEqual(checkStatus('success'), 'success');
    assert.strictEqual(checkStatus('manual'), 'pending');
    assert.deepStrictEqual(countDiff('--- a\n+++ b\n@@\n+x\n+y\n-z\n ctx'), { additions: 2, deletions: 1 });
    assert.strictEqual(shortText('a\n\n```js\ncode\n```\n b'), 'a [código] b');
    assert.deepStrictEqual(fetchSpecFor({ id: 7, source: 'feat/x', fork: true }, 'github'), { refspec: 'refs/pull/7/head:refs/heads/pr/7', localBranch: 'pr/7' });
    assert.strictEqual(fetchSpecFor({ id: 7, source: 'feat/x', fork: false }, 'github').localBranch, 'feat/x');
  });

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
      // ---------------- GitHub
      if (u === '/gh/user') return send(200, { login: 'joao' });
      if (u.startsWith('/gh/repos/dono/repo/pulls?state=open')) return send(200, [
        { number: 1, node_id: 'N1', title: 'Meu PR', state: 'open', draft: false, html_url: 'h1', user: { login: 'joao' }, head: { ref: 'ai/a', sha: 's1', repo: { full_name: 'dono/repo' } }, base: { ref: 'main' }, requested_reviewers: [], created_at: iso(2), updated_at: iso(1) },
        { number: 2, node_id: 'N2', title: 'Revisa pra mim', state: 'open', draft: true, html_url: 'h2', user: { login: 'ana' }, head: { ref: 'ana/b', sha: 's2', repo: { full_name: 'dono/repo' } }, base: { ref: 'main' }, requested_reviewers: [{ login: 'joao' }], created_at: iso(3), updated_at: iso(1) },
        { number: 3, node_id: 'N3', title: 'De fork', state: 'open', draft: false, html_url: 'h3', user: { login: 'ext' }, head: { ref: 'patch-1', sha: 's3', repo: { full_name: 'ext/repo' } }, base: { ref: 'main' }, requested_reviewers: [], created_at: iso(5), updated_at: iso(4) },
      ]);
      if (u.startsWith('/gh/repos/dono/repo/pulls?state=closed')) return send(200, [
        { number: 9, title: 'Mesclado', state: 'closed', merged_at: iso(1), html_url: 'h9', user: { login: 'joao' }, head: { ref: 'x' }, base: { ref: 'main' }, created_at: iso(3), updated_at: iso(1) },
        { number: 8, title: 'Fechado sem merge', state: 'closed', merged_at: null, html_url: 'h8', user: { login: 'ana' }, head: { ref: 'y' }, base: { ref: 'main' } },
      ]);
      if (u === '/gh/repos/dono/repo/pulls/1/reviews?per_page=100') return send(200, [{ user: { login: 'ana' }, state: 'APPROVED' }]);
      if (u === '/gh/repos/dono/repo/pulls/3/reviews?per_page=100') return send(200, []);
      if (u === '/gh/repos/dono/repo/pulls/1/files?per_page=100') return send(200, [{ filename: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 }, { filename: 'b.md', status: 'added', additions: 5, deletions: 0 }]);
      if (u === '/gh/repos/dono/repo/issues/1/comments?per_page=50') return send(200, [{ user: { login: 'ana' }, body: 'bom', created_at: iso(0.5), html_url: 'c1' }]);
      if (u === '/gh/repos/dono/repo/pulls/1/comments?per_page=50') return send(200, [{ user: { login: 'ana' }, body: 'aqui', path: 'src/a.ts', created_at: iso(0.2), html_url: 'c2' }]);
      if (u === '/gh/repos/dono/repo/commits/s1/check-runs?per_page=100') return send(200, { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', html_url: 'r1' }, { name: 'lint', status: 'in_progress', conclusion: null }] });
      if (u === '/gh/repos/dono/repo/commits/s1/status') return send(200, { statuses: [{ context: 'ci/legado', state: 'failure', target_url: 't' }] });
      if (u === '/gh/repos/dono/repo/pulls/1/merge' && req.method === 'PUT') return send(200, { merged: true });
      if (u === '/gh/graphql' && req.method === 'POST') return send(200, { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
      // ---------------- GitLab self-hosted
      if (u === '/gl/user') return send(200, { username: 'joao' });
      if (u.startsWith('/gl/projects/time%2Fapi/merge_requests?state=opened')) return send(200, [
        { iid: 5, title: 'Draft: MR meu', state: 'opened', draft: true, web_url: 'w5', author: { username: 'joao' }, reviewers: [], source_branch: 'ai/c', target_branch: 'master', sha: 'g5', has_conflicts: true, created_at: iso(2), updated_at: iso(1), source_project_id: 1, target_project_id: 1 },
        { iid: 6, title: 'Revisar', state: 'opened', draft: false, web_url: 'w6', author: { username: 'rui' }, reviewers: [{ username: 'joao' }], source_branch: 'rui/d', target_branch: 'master', sha: 'g6', detailed_merge_status: 'discussions_not_resolved', created_at: iso(2), updated_at: iso(1), source_project_id: 1, target_project_id: 1 },
      ]);
      if (u.startsWith('/gl/projects/time%2Fapi/merge_requests?state=merged')) return send(200, [{ iid: 4, title: 'Antigo', state: 'merged', merged_at: iso(3), web_url: 'w4', author: { username: 'joao' }, source_branch: 'e', target_branch: 'master' }]);
      if (u === '/gl/projects/time%2Fapi/merge_requests/6/approvals') return send(200, { approvals_left: 1, approved_by: [] });
      if (u === '/gl/projects/time%2Fapi/merge_requests/6/diffs?per_page=100') return send(404, { message: '404 Not Found' });
      if (u === '/gl/projects/time%2Fapi/merge_requests/6/changes') return send(200, { changes: [{ new_path: 'app.py', old_path: 'app.py', diff: '@@\n+a\n+b\n-c\n' }] });
      if (u.startsWith('/gl/projects/time%2Fapi/merge_requests/6/notes')) return send(200, [{ id: 1, system: true, body: 'mudou' }, { id: 2, author: { username: 'rui' }, body: 'olhe', created_at: iso(0.1) }]);
      if (u === '/gl/projects/time%2Fapi/merge_requests/6/pipelines?per_page=1') return send(200, [{ id: 77, status: 'running', web_url: 'p77' }]);
      if (u === '/gl/projects/time%2Fapi/pipelines/77/jobs?per_page=100') return send(200, [{ name: 'test', stage: 'test', status: 'failed', web_url: 'j1' }]);
      if (u === '/gl/projects/time%2Fapi/merge_requests/6/merge' && req.method === 'PUT') return send(200, { state: 'merged' });
      if (u === '/gl/projects/time%2Fapi/merge_requests/5' && req.method === 'PUT') return send(200, {});
      send(404, { message: 'not found ' + u });
    });
  });
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const find = (g, key, id) => g[key].find(p => p.id === id);

  const gh = new GitHubPrBrowser(parseRemote('https://github.com/dono/repo.git'), 'tok', `${base}/gh`);
  await check('GitHub: grupos, rascunho, fork, revisores pedidos e revisão', async () => {
    const me = await gh.whoami();
    const g = await gh.groups(me);
    assert.deepStrictEqual(g.mine.map(p => p.ref), ['#1']);
    assert.deepStrictEqual(g.reviewRequested.map(p => p.ref), ['#2']);
    assert.strictEqual(find(g, 'open', 2).state, 'draft');
    assert.strictEqual(find(g, 'open', 3).fork, true);
    assert.strictEqual(find(g, 'open', 1).review.state, 'approved');
    assert.strictEqual(find(g, 'open', 2).review, undefined, 'rascunho não busca revisão');
    assert.deepStrictEqual(g.recentlyMerged.map(p => p.ref), ['#9'], 'fechado sem merge fica de fora');
  });
  await check('GitHub: arquivos, comentários (mais recentes primeiro) e checks (runs + status)', async () => {
    const pr = { id: 1, headSha: 's1' };
    assert.deepStrictEqual((await gh.files(pr)).map(f => `${f.status}:${f.path}:+${f.additions}`), ['modified:src/a.ts:+3', 'added:b.md:+5']);
    const cm = await gh.comments(pr);
    assert.deepStrictEqual(cm.map(c => c.body), ['aqui', 'bom']);
    assert.strictEqual(cm[0].path, 'src/a.ts');
    assert.deepStrictEqual((await gh.checks(pr)).map(c => `${c.name}:${c.status}`), ['test:success', 'lint:running', 'ci/legado:failed']);
  });
  await check('GitHub: merge com método e "pronto para revisão" via GraphQL', async () => {
    await gh.merge({ id: 1 }, 'squash');
    assert.deepStrictEqual(seen.find(s => s.url.endsWith('/pulls/1/merge')).body, { merge_method: 'squash' });
    await gh.setDraft({ id: 2, nodeId: 'N2' }, false);
    const q = seen.at(-1);
    assert.strictEqual(q.url, '/gh/graphql');
    assert.ok(q.body.query.includes('markPullRequestReadyForReview'));
    assert.deepStrictEqual(q.body.variables, { id: 'N2' });
  });

  const gl = new GitLabPrBrowser(parseRemote('git@git.empresa.local:time/api.git', ['git.empresa.local']), 'glpat', `${base}/gl`);
  await check('GitLab self-hosted: grupos, conflito, conversas abertas', async () => {
    const g = await gl.groups(await gl.whoami());
    assert.deepStrictEqual(g.mine.map(p => p.ref), ['!5']);
    assert.deepStrictEqual(g.reviewRequested.map(p => p.ref), ['!6']);
    assert.strictEqual(find(g, 'open', 5).conflicts, true);
    assert.strictEqual(find(g, 'open', 6).review.state, 'discussions');
    assert.deepStrictEqual(g.recentlyMerged.map(p => p.ref), ['!4']);
  });
  await check('GitLab: arquivos pelo /changes quando /diffs não existe, notas sem as do sistema, jobs do pipeline', async () => {
    const pr = { id: 6, url: 'w6' };
    assert.deepStrictEqual(await gl.files(pr), [{ path: 'app.py', status: 'modified', additions: 2, deletions: 1, previousPath: undefined }]);
    const notes = await gl.comments(pr);
    assert.deepStrictEqual(notes.map(n => n.body), ['olhe']);
    assert.deepStrictEqual((await gl.checks(pr)).map(c => `${c.name}:${c.status}`), ['test: test:failed']);
  });
  await check('GitLab: merge com squash e rascunho pelo título', async () => {
    await gl.merge({ id: 6 }, 'squash');
    assert.deepStrictEqual(seen.find(s => s.url.endsWith('/merge_requests/6/merge')).body, { squash: true });
    await gl.setDraft({ id: 5, title: 'Draft: MR meu' }, false);
    assert.deepStrictEqual(seen.at(-1).body, { title: 'MR meu' });
    await gl.setDraft({ id: 5, title: 'MR meu' }, true);
    assert.deepStrictEqual(seen.at(-1).body, { title: 'Draft: MR meu' });
  });
  await check('Bitbucket/Azure: listagem pelo cliente existente; ações avisam que não há suporte', async () => {
    const fake = { kind: 'azure', label: 'PR', whoami: async () => 'eu', listOpen: async () => [{ id: 3, ref: '!3', url: 'u', title: 't', state: 'open', source: 's', target: 'main' }] };
    const b = new ListOnlyPrBrowser(fake);
    const g = await b.groups('eu');
    assert.deepStrictEqual(g.open.map(p => p.ref), ['!3']);
    assert.strictEqual(b.can.merge, false);
    await assert.rejects(b.files(g.open[0]), /navegador/);
  });

  server.close();
  if (failures) process.exit(1);
})();
