// Bitbucket (Cloud e Server), Azure DevOps e Jira contra um servidor HTTP falso.
// Uso: node test/platforms.test.js
const assert = require('assert');
const http = require('http');
const { parseRemote } = require('../out/hosting/core');
const { BitbucketCloudClient, BitbucketServerClient, BitbucketCloudPipelines, BitbucketServerBuilds, bitbucketPipelineStatus } = require('../out/hosting/bitbucket');
const { AzureDevOpsClient, AzurePipelines, azureBuildStatus, htmlToText } = require('../out/hosting/azure');
const { JiraClient, jiraJql, adfToText } = require('../out/issues/jira');
const { issueBranch, issueTrailer } = require('../out/issues/core');
const { pipelineClient } = require('../out/hosting/pipelines');

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
  // ---------- reconhecimento de remotos ----------
  await check('parseRemote: Azure DevOps (https com usuário, visualstudio.com, ssh v3, vs-ssh)', () => {
    const a = parseRemote('https://joao@dev.azure.com/empresa/Portal%20Web/_git/api');
    assert.strictEqual(a.kind, 'azure');
    assert.deepStrictEqual(a.azure, { collection: 'https://dev.azure.com/empresa', organization: 'empresa', project: 'Portal Web', repo: 'api' });
    const b = parseRemote('https://empresa.visualstudio.com/DefaultCollection/Portal/_git/api');
    assert.strictEqual(b.azure.collection, 'https://empresa.visualstudio.com/DefaultCollection');
    assert.strictEqual(b.azure.project, 'Portal');
    const c = parseRemote('git@ssh.dev.azure.com:v3/empresa/Portal/api');
    assert.deepStrictEqual([c.kind, c.azure.collection, c.azure.repo], ['azure', 'https://dev.azure.com/empresa', 'api']);
    const d = parseRemote('empresa@vs-ssh.visualstudio.com:v3/empresa/Portal/api');
    assert.strictEqual(d.azure.collection, 'https://empresa.visualstudio.com');
  });

  await check('parseRemote: Azure DevOps Server com coleção', () => {
    const r = parseRemote('https://tfs.empresa.com/tfs/Colecao/Portal/_git/api', [], [], [], ['tfs.empresa.com']);
    assert.deepStrictEqual([r.kind, r.flavor, r.azure.collection, r.azure.project, r.azure.repo], ['azure', 'server', 'https://tfs.empresa.com/tfs/Colecao', 'Portal', 'api']);
  });

  await check('parseRemote: Bitbucket Cloud e Server (scm com contexto, ssh 7999, host configurado)', () => {
    const a = parseRemote('https://joao@bitbucket.org/equipe/loja.git');
    assert.deepStrictEqual([a.kind, a.flavor, a.projectPath], ['bitbucket', 'cloud', 'equipe/loja']);
    assert.strictEqual(parseRemote('git@bitbucket.org:equipe/loja.git').projectPath, 'equipe/loja');
    const s = parseRemote('https://git.empresa.com/bitbucket/scm/proj/loja.git', [], [], ['https://git.empresa.com/bitbucket']);
    assert.deepStrictEqual([s.kind, s.flavor, s.projectPath, s.webBase], ['bitbucket', 'server', 'PROJ/loja', 'https://git.empresa.com/bitbucket']);
    const t = parseRemote('ssh://git@bitbucket.empresa.com:7999/proj/loja.git');
    assert.deepStrictEqual([t.kind, t.flavor, t.projectPath, t.webBase], ['bitbucket', 'server', 'PROJ/loja', 'https://bitbucket.empresa.com']);
  });

  await check('parseRemote: GitHub/GitLab continuam iguais e o resto não é reconhecido', () => {
    assert.strictEqual(parseRemote('git@github.com:dono/repo.git').kind, 'github');
    assert.strictEqual(parseRemote('https://gitlab.empresa.com/g/sub/p.git').kind, 'gitlab');
    assert.strictEqual(parseRemote('https://git.qualquer.com/a/b.git'), undefined);
  });

  // ---------- servidor falso ----------
  const seen = [];
  const routes = [];
  const on = (method, re, fn) => routes.push({ method, re, fn });
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      let b;
      try {
        b = body ? JSON.parse(body) : undefined;
      } catch {
        b = body;
      }
      const u = new URL(req.url, 'http://x');
      seen.push({ method: req.method, path: u.pathname, query: u.searchParams, headers: req.headers, body: b });
      const r = routes.find(x => x.method === req.method && x.re.test(u.pathname));
      if (!r) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: `sem rota ${req.method} ${u.pathname}` }));
      }
      const [code, out, raw] = r.fn(u, b, req);
      res.writeHead(code, { 'Content-Type': raw ? 'text/plain' : 'application/json' });
      res.end(raw ? out : JSON.stringify(out));
    });
  });
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const last = () => seen[seen.length - 1];

  // Bitbucket Cloud
  const bbPR = (id, state, src) => ({ id, title: `PR ${id}`, state, draft: false, source: { branch: { name: src } }, destination: { branch: { name: 'main' } }, links: { html: { href: `https://bitbucket.org/equipe/loja/pull-requests/${id}` } } });
  on('GET', /^\/bbc\/repositories\/equipe\/loja\/pullrequests$/, u => [200, { values: u.searchParams.has('q') ? [bbPR(8, 'MERGED', 'feat/x')] : [bbPR(3, 'OPEN', 'feat/a')] }]);
  on('POST', /^\/bbc\/repositories\/equipe\/loja\/pullrequests$/, (u, b) => [201, { ...bbPR(9, 'OPEN', b.source.branch.name), title: b.title, draft: b.draft }]);
  on('GET', /^\/bbc\/user$/, () => [200, { uuid: '{u-1}', username: 'joao' }]);
  on('GET', /^\/bbc\/repositories\/equipe\/loja\/issues$/, () => [200, { values: [{ id: 5, title: 'Bug', content: { raw: 'desc' }, kind: 'bug', priority: 'major', state: 'open', links: { html: { href: 'h5' } }, updated_on: '2026-09-01T00:00:00Z' }] }]);
  on('GET', /^\/bbc\/repositories\/equipe\/sem-issues\/issues$/, () => [404, { error: { message: 'Repository has no issue tracker.' } }]);
  on('POST', /^\/bbc\/repositories\/equipe\/sem-issues\/issues$/, () => [404, { error: { message: 'Repository has no issue tracker.' } }]);
  on('GET', /^\/bbc\/repositories\/equipe\/loja\/pipelines\/$/, () => [200, { values: [{ uuid: '{p-42}', build_number: 42, state: { name: 'COMPLETED', result: { name: 'FAILED' } }, target: { ref_name: 'feat/a', commit: { hash: 'abc' } }, trigger: { name: 'PUSH' }, created_on: '2026-09-01T00:00:00Z', completed_on: '2026-09-01T00:02:00Z', duration_in_seconds: 120 }] }]);
  on('GET', /^\/bbc\/repositories\/equipe\/loja\/pipelines\/%7Bp-42%7D\/steps\/$/, () => [200, { values: [{ uuid: '{s-1}', name: 'Testes', state: { name: 'COMPLETED', result: { name: 'FAILED' } }, duration_in_seconds: 90 }] }]);
  on('GET', /^\/bbc\/repositories\/equipe\/loja\/pipelines\/%7Bp-42%7D\/steps\/%7Bs-1%7D\/log$/, () => [200, 'linha 1\nERRO no teste', true]);
  on('POST', /^\/bbc\/repositories\/equipe\/loja\/pipelines\/$/, (u, b) => [201, { uuid: '{p-43}', build_number: 43, target: b.target }]);
  on('POST', /^\/bbc\/repositories\/equipe\/loja\/pipelines\/%7Bp-42%7D\/stopPipeline$/, () => [204, '', true]);

  const bbRemote = parseRemote('git@bitbucket.org:equipe/loja.git');
  await check('Bitbucket Cloud: PRs (lista, por branch, criar) com Basic de app password', async () => {
    const c = new BitbucketCloudClient(bbRemote, 'joao:app-pass', `${base}/bbc`);
    const open = await c.listOpen();
    assert.deepStrictEqual(open.map(p => [p.ref, p.state, p.source, p.target]), [['#3', 'open', 'feat/a', 'main']]);
    assert.strictEqual(last().headers.authorization, `Basic ${Buffer.from('joao:app-pass').toString('base64')}`);
    const f = await c.findForBranch('feat/x');
    assert.strictEqual(f.state, 'merged');
    assert.strictEqual(last().query.get('q'), 'source.branch.name="feat/x"');
    assert.deepStrictEqual(last().query.getAll('state'), ['OPEN', 'MERGED', 'DECLINED']);
    const n = await c.create({ source: 'feat/b', target: 'main', title: 'T', body: 'B', draft: true });
    assert.strictEqual(n.state, 'draft');
    assert.deepStrictEqual(last().body, { title: 'T', description: 'B', source: { branch: { name: 'feat/b' } }, destination: { branch: { name: 'main' } }, draft: true });
  });

  await check('Bitbucket Cloud: issues (minhas pelo uuid) e tracker desativado', async () => {
    const c = new BitbucketCloudClient(bbRemote, 'token-de-acesso', `${base}/bbc`);
    const list = await c.listIssues('mine');
    assert.deepStrictEqual(list.map(i => [i.provider, i.key, i.body]), [['bitbucket', '#5', 'desc']]);
    assert.ok(last().query.get('q').includes('assignee.uuid="{u-1}"'));
    assert.strictEqual(last().headers.authorization, 'Bearer token-de-acesso');
    const off = new BitbucketCloudClient({ ...bbRemote, projectPath: 'equipe/sem-issues' }, 't', `${base}/bbc`);
    assert.deepStrictEqual(await off.listIssues('all'), []);
    await assert.rejects(off.createIssue({ title: 'x', body: '' }), /issue tracker is disabled/);
  });

  await check('Bitbucket Pipelines: lista, passos, log, disparar e parar', async () => {
    const p = new BitbucketCloudPipelines(bbRemote, 't', `${base}/bbc`);
    const [run] = await p.list();
    assert.deepStrictEqual([run.id, run.status, run.branch, run.durationSec], [42, 'failed', 'feat/a', 120]);
    const [job] = await p.jobs(run);
    assert.strictEqual(job.name, 'Testes');
    assert.ok((await p.log(job)).includes('ERRO no teste'));
    await p.retry(run);
    assert.deepStrictEqual(last().body, { target: { type: 'pipeline_ref_target', ref_type: 'branch', ref_name: 'feat/a' } });
    await p.cancel(run);
    assert.ok(last().path.endsWith('/stopPipeline'));
    assert.strictEqual(bitbucketPipelineStatus('IN_PROGRESS'), 'running');
    assert.strictEqual(bitbucketPipelineStatus('COMPLETED', 'STOPPED'), 'canceled');
    assert.ok(pipelineClient(bbRemote, 't') instanceof BitbucketCloudPipelines);
  });

  // Bitbucket Server
  on('GET', /^\/rest\/api\/1\.0\/projects\/PROJ\/repos\/loja\/pull-requests$/, u => [200, { values: [{ id: 11, title: 'S', state: u.searchParams.get('state') === 'ALL' ? 'DECLINED' : 'OPEN', fromRef: { displayId: 'feat/s' }, toRef: { displayId: 'master' }, links: { self: [{ href: 'hs11' }] } }] }]);
  on('POST', /^\/rest\/api\/1\.0\/projects\/PROJ\/repos\/loja\/pull-requests$/, (u, b) => [201, { id: 12, title: b.title, state: 'OPEN', fromRef: { displayId: 'feat/s' }, toRef: { displayId: 'master' }, links: { self: [{ href: 'hs12' }] } }]);
  on('GET', /^\/plugins\/servlet\/applinks\/whoami$/, () => [200, 'joao.silva', true]);
  on('GET', /^\/rest\/api\/1\.0\/projects\/PROJ\/repos\/loja\/branches$/, () => [200, { values: [{ displayId: 'feat/s', latestCommit: 'c0ffee' }] }]);
  on('GET', /^\/rest\/build-status\/1\.0\/commits\/c0ffee$/, () => [200, { values: [{ state: 'SUCCESSFUL', key: 'JENKINS-1', name: 'Jenkins', url: 'http://ci/1', dateAdded: 1757000000000 }] }]);

  const bbsRemote = parseRemote(`${base}/scm/proj/loja.git`, [], [], [base]);
  await check('Bitbucket Server: PRs com fromRef/toRef, whoami e builds (somente leitura)', async () => {
    assert.deepStrictEqual([bbsRemote.kind, bbsRemote.flavor, bbsRemote.projectPath], ['bitbucket', 'server', 'PROJ/loja']);
    const c = new BitbucketServerClient(bbsRemote, 'http-token');
    assert.deepStrictEqual((await c.listOpen()).map(p => [p.ref, p.state, p.source]), [['#11', 'open', 'feat/s']]);
    assert.strictEqual(last().headers.authorization, 'Bearer http-token');
    assert.strictEqual((await c.findForBranch('feat/s')).state, 'closed');
    assert.strictEqual(last().query.get('at'), 'refs/heads/feat/s');
    await c.create({ source: 'feat/s', target: 'master', title: 'Novo', body: 'b', draft: false });
    assert.deepStrictEqual(last().body, { title: 'Novo', description: 'b', fromRef: { id: 'refs/heads/feat/s' }, toRef: { id: 'refs/heads/master' } });
    assert.strictEqual(await c.whoami(), 'joao.silva');
    assert.deepStrictEqual(await c.listIssues(), []);
    const b = new BitbucketServerBuilds(bbsRemote, 'http-token');
    const [build] = await b.list('feat/s');
    assert.deepStrictEqual([build.name, build.status, build.sha, build.url], ['Jenkins', 'success', 'c0ffee', 'http://ci/1']);
    await assert.rejects(b.retry(build), /CI server/);
  });

  // Azure DevOps
  const azPR = (id, status, draft) => ({ pullRequestId: id, title: `PR ${id}`, status, isDraft: draft, sourceRefName: 'refs/heads/feat/az', targetRefName: 'refs/heads/main' });
  const azPath = '/azure/empresa/Portal/_apis';
  on('GET', /^\/azure\/empresa\/Portal\/_apis\/git\/repositories\/api\/pullrequests$/, u => [200, { value: u.searchParams.get('searchCriteria.status') === 'all' ? [azPR(21, 'completed', false)] : [azPR(20, 'active', true)] }]);
  on('POST', /^\/azure\/empresa\/Portal\/_apis\/git\/repositories\/api\/pullrequests$/, (u, b) => [201, { ...azPR(22, 'active', b.isDraft), title: b.title }]);
  on('GET', /^\/azure\/empresa\/_apis\/connectionData$/, () => [200, { authenticatedUser: { providerDisplayName: 'João Silva' } }]);
  on('POST', /^\/azure\/empresa\/Portal\/_apis\/wit\/wiql$/, () => [200, { workItems: [{ id: 101 }, { id: 102 }] }]);
  on('GET', /^\/azure\/empresa\/Portal\/_apis\/wit\/workitems$/, () => [200, { value: [
    { id: 101, fields: { 'System.Title': 'Erro no login', 'System.Description': '<div>Passos:<br>1. abrir</div>', 'System.WorkItemType': 'Bug', 'System.State': 'Active', 'System.Tags': 'login; urgente', 'System.ChangedDate': '2026-09-01T00:00:00Z' } },
    { id: 102, fields: { 'System.Title': 'Relatório', 'System.WorkItemType': 'Task', 'System.State': 'New' } },
  ] }]);
  on('POST', /^\/azure\/empresa\/Portal\/_apis\/wit\/workitems\/%24Task$/, (u, b) => [200, { id: 103, fields: { 'System.Title': b[0].value, 'System.WorkItemType': 'Task', 'System.State': 'New' } }]);
  on('GET', /^\/azure\/empresa\/Portal\/_apis\/build\/builds$/, () => [200, { value: [{ id: 900, buildNumber: '20260901.1', status: 'completed', result: 'failed', definition: { name: 'CI' }, sourceBranch: 'refs/heads/feat/az', sourceVersion: 'def', reason: 'individualCI', queueTime: '2026-09-01T00:00:00Z', startTime: '2026-09-01T00:00:10Z', finishTime: '2026-09-01T00:01:10Z', _links: { web: { href: 'hb900' } } }] }]);
  on('GET', /^\/azure\/empresa\/Portal\/_apis\/build\/builds\/900\/timeline$/, () => [200, { records: [{ type: 'Stage', name: 'x' }, { type: 'Job', name: 'Testes', state: 'completed', result: 'failed', log: { id: 7 } }] }]);
  on('GET', /^\/azure\/empresa\/Portal\/_apis\/build\/builds\/900\/logs\/7$/, () => [200, 'falhou aqui', true]);
  on('PATCH', /^\/azure\/empresa\/Portal\/_apis\/build\/builds\/900$/, () => [200, {}]);
  on('GET', /^\/azure\/empresa\/Portal\/_apis\/build\/definitions$/, () => [200, { value: [{ id: 3, name: 'CI', path: '\\' }] }]);
  on('POST', /^\/azure\/empresa\/Portal\/_apis\/build\/builds$/, () => [200, { id: 901 }]);

  const azRemote = parseRemote(`${base}/azure/empresa/Portal/_git/api`, [], [], [], [base]);
  await check('Azure DevOps: PRs (!id, rascunho, refs/heads) com PAT em Basic', async () => {
    assert.deepStrictEqual([azRemote.kind, azRemote.azure.collection], ['azure', `${base}/azure/empresa`]);
    const c = new AzureDevOpsClient(azRemote, 'meu-pat');
    const open = await c.listOpen();
    assert.deepStrictEqual(open.map(p => [p.ref, p.state, p.source, p.target]), [['!20', 'draft', 'feat/az', 'main']]);
    assert.strictEqual(last().headers.authorization, `Basic ${Buffer.from(':meu-pat').toString('base64')}`);
    assert.strictEqual(last().query.get('api-version'), '7.1');
    assert.strictEqual((await c.findForBranch('feat/az')).state, 'merged');
    assert.strictEqual(last().query.get('searchCriteria.sourceRefName'), 'refs/heads/feat/az');
    await c.create({ source: 'feat/az', target: 'main', title: 'T', body: 'B', draft: true });
    assert.deepStrictEqual(last().body, { sourceRefName: 'refs/heads/feat/az', targetRefName: 'refs/heads/main', title: 'T', description: 'B', isDraft: true });
    assert.strictEqual(await c.whoami(), 'João Silva');
  });

  await check('Azure DevOps: work items por WIQL (minhas = @Me) e criação com JSON Patch', async () => {
    const c = new AzureDevOpsClient(azRemote, 'pat', undefined, fetch, 'Task');
    const list = await c.listIssues('mine');
    const wiql = seen.filter(s => s.path.endsWith('/wit/wiql')).at(-1).body.query;
    assert.ok(wiql.includes('[System.AssignedTo] = @Me') && wiql.includes('@project'), wiql);
    assert.deepStrictEqual(list.map(i => [i.key, i.title]), [['AB#101', 'Erro no login'], ['AB#102', 'Relatório']]);
    assert.strictEqual(list[0].body, 'Passos:\n1. abrir');
    assert.ok(list[0].labels.includes('urgente'));
    const all = await c.listIssues('all');
    assert.strictEqual(all.length, 2);
    assert.ok(!seen.filter(s => s.path.endsWith('/wit/wiql')).at(-1).body.query.includes('@Me'));
    const created = await c.createIssue({ title: 'Nova tarefa', body: 'linha 1\nlinha 2', labels: ['api'] });
    assert.strictEqual(created.key, 'AB#103');
    assert.strictEqual(last().headers['content-type'], 'application/json-patch+json');
    assert.deepStrictEqual(last().body, [
      { op: 'add', path: '/fields/System.Title', value: 'Nova tarefa' },
      { op: 'add', path: '/fields/System.Description', value: 'linha 1<br>linha 2' },
      { op: 'add', path: '/fields/System.Tags', value: 'api' },
    ]);
  });

  await check('Azure Pipelines: builds, jobs da timeline, log, re-executar, cancelar e disparar', async () => {
    const p = new AzurePipelines(azRemote, 'pat');
    const [b] = await p.list('feat/az');
    assert.strictEqual(last().query.get('branchName'), 'refs/heads/feat/az');
    assert.deepStrictEqual([b.id, b.status, b.name, b.durationSec], [900, 'failed', 'CI', 60]);
    const jobs = await p.jobs(b);
    assert.deepStrictEqual(jobs.map(j => [j.id, j.name, j.status]), [[7, 'Testes', 'failed']]);
    assert.strictEqual(await p.log(jobs[0]), 'falhou aqui');
    await p.retry(b);
    assert.deepStrictEqual([last().method, last().query.get('retry')], ['PATCH', 'true']);
    await p.cancel(b);
    assert.deepStrictEqual(last().body, { status: 'cancelling' });
    assert.deepStrictEqual(await p.workflows(), [{ id: 3, name: 'CI', path: '\\' }]);
    await p.trigger('feat/az', 3);
    assert.deepStrictEqual(last().body, { definition: { id: 3 }, sourceBranch: 'refs/heads/feat/az' });
    assert.strictEqual(azureBuildStatus('inProgress'), 'running');
    assert.strictEqual(azureBuildStatus('completed', 'partiallySucceeded'), 'failed');
    assert.strictEqual(htmlToText('<p>a &amp; b</p>'), 'a & b');
  });

  // Jira
  on('GET', /^\/jira-cloud\/rest\/api\/2\/myself$/, () => [200, { displayName: 'João (Cloud)' }]);
  on('GET', /^\/jira-cloud\/rest\/api\/3\/search\/jql$/, () => [200, { issues: [{ key: 'PORT-7', fields: { summary: 'Tela lenta', description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Demora' }, { type: 'hardBreak' }, { type: 'text', text: '10s' }] }] }, labels: ['perf'], issuetype: { name: 'Bug' }, status: { name: 'To Do' }, updated: '2026-09-01T00:00:00.000+0000', project: { key: 'PORT' } } }] }]);
  on('POST', /^\/jira-cloud\/rest\/api\/2\/issue$/, (u, b) => [201, { id: '1', key: `${b.fields.project.key}-8` }]);
  on('GET', /^\/jira-server\/rest\/api\/2\/search$/, () => [200, { issues: [{ key: 'OPS-3', fields: { summary: 'Deploy', description: 'texto simples', status: { name: 'Open' } } }] }]);
  on('GET', /^\/jira-server\/rest\/api\/2\/myself$/, () => [200, { name: 'joao' }]);

  await check('Jira Cloud: e-mail + API token, busca em /search/jql e descrição ADF', async () => {
    const j = new JiraClient(`${base}/jira-cloud`, { kind: 'cloud', email: 'joao@empresa.com', token: 'tk' });
    assert.strictEqual(await j.whoami(), 'João (Cloud)');
    assert.strictEqual(last().headers.authorization, `Basic ${Buffer.from('joao@empresa.com:tk').toString('base64')}`);
    const [i] = await j.listIssues('mine', 'PORT');
    assert.strictEqual(last().query.get('jql'), 'assignee = currentUser() AND (project = "PORT" AND statusCategory != Done) ORDER BY updated DESC');
    assert.deepStrictEqual([i.provider, i.key, i.id, i.body, i.url], ['jira', 'PORT-7', 'PORT-7', 'Demora\n10s', `${base}/jira-cloud/browse/PORT-7`]);
    const c = await j.createIssue({ projectKey: 'PORT', issueType: 'Bug', title: 'Novo bug', body: 'passos', labels: ['a b'] });
    assert.strictEqual(c.key, 'PORT-8');
    assert.deepStrictEqual(last().body, { fields: { project: { key: 'PORT' }, summary: 'Novo bug', description: 'passos', issuetype: { name: 'Bug' }, labels: ['a-b'] } });
  });

  await check('Jira Server/DC: PAT em Bearer e busca em /rest/api/2/search; JQL customizada', async () => {
    const j = new JiraClient(`${base}/jira-server`, { kind: 'server', token: 'pat' });
    assert.strictEqual(await j.whoami(), 'joao');
    const [i] = await j.listIssues('all', undefined, 'project = OPS AND sprint in openSprints()');
    assert.strictEqual(last().headers.authorization, 'Bearer pat');
    assert.strictEqual(last().query.get('jql'), 'project = OPS AND sprint in openSprints() ORDER BY updated DESC');
    assert.deepStrictEqual([i.key, i.body], ['OPS-3', 'texto simples']);
    assert.strictEqual(jiraJql('all'), 'statusCategory != Done ORDER BY updated DESC');
    assert.strictEqual(adfToText({ type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }] }] }] }).trim(), '- item');
  });

  await check('branch e trailer por provedor (Jira, Azure, Bitbucket)', () => {
    assert.strictEqual(issueBranch({ provider: 'jira', id: 'PORT-7', title: 'Tela lenta' }, 'issue'), 'jira/PORT-7-tela-lenta');
    assert.strictEqual(issueTrailer({ provider: 'jira', id: 'PORT-7' }), 'PORT-7');
    assert.strictEqual(issueTrailer({ provider: 'azure', id: 101 }), 'AB#101');
    assert.strictEqual(issueTrailer({ provider: 'bitbucket', id: 5 }), 'Closes #5');
    assert.strictEqual(issueBranch({ provider: 'azure', id: 101, title: 'Erro no login' }, 'issue'), 'issue/101-erro-no-login');
  });

  server.close();
  if (failures) process.exit(1);
})();
