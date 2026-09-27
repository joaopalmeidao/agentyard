// Testes de src/hosting/pipelines.ts contra um servidor HTTP falso. Uso: node test/pipelines.test.js
const assert = require('assert');
const http = require('http');
const { parseRemote } = require('../out/hosting/core');
const { GitHubPipelines, GitLabPipelines, githubStatus, gitlabStatus, tailLog, formatDuration } = require('../out/hosting/pipelines');

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
  await check('status do GitHub (status + conclusion)', () => {
    assert.strictEqual(githubStatus('queued', null), 'queued');
    assert.strictEqual(githubStatus('in_progress', null), 'running');
    assert.strictEqual(githubStatus('completed', 'success'), 'success');
    assert.strictEqual(githubStatus('completed', 'failure'), 'failed');
    assert.strictEqual(githubStatus('completed', 'timed_out'), 'failed');
    assert.strictEqual(githubStatus('completed', 'cancelled'), 'canceled');
    assert.strictEqual(githubStatus('completed', 'skipped'), 'skipped');
    assert.strictEqual(githubStatus('waiting', 'action_required'), 'manual');
  });

  await check('status do GitLab', () => {
    assert.deepStrictEqual(
      ['pending', 'running', 'success', 'failed', 'canceled', 'skipped', 'manual', 'created', 'scheduled'].map(gitlabStatus),
      ['queued', 'running', 'success', 'failed', 'canceled', 'skipped', 'manual', 'queued', 'queued'],
    );
  });

  await check('tailLog tira cores e fica com o final; formatDuration', () => {
    const log = Array.from({ length: 300 }, (_, i) => `\x1b[31mlinha ${i}\x1b[0m`).join('\n');
    const t = tailLog(log, 150).split('\n');
    assert.strictEqual(t.length, 150);
    assert.strictEqual(t[0], 'linha 150');
    assert.strictEqual(t[149], 'linha 299');
    assert.deepStrictEqual([formatDuration(42), formatDuration(125), formatDuration(3725), formatDuration(undefined)], ['42s', '2m05s', '1h02m', '']);
  });

  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : undefined });
      const json = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(obj === undefined ? '' : JSON.stringify(obj));
      };
      const u = req.url;
      // GitHub
      if (u.startsWith('/gh/repos/dono/repo/actions/runs?')) {
        return json(200, {
          workflow_runs: [
            { id: 11, name: 'CI', head_branch: 'ai/x', head_sha: 'abc123', status: 'completed', conclusion: 'failure', event: 'push', html_url: 'https://gh/11', created_at: '2026-09-27T10:00:00Z', run_started_at: '2026-09-27T10:00:05Z', updated_at: '2026-09-27T10:02:10Z' },
            { id: 12, name: 'CI', head_branch: 'main', head_sha: 'def456', status: 'in_progress', conclusion: null, event: 'push', html_url: 'https://gh/12', created_at: '2026-09-27T11:00:00Z', updated_at: '2026-09-27T11:00:30Z' },
          ],
        });
      }
      if (u.startsWith('/gh/repos/dono/repo/actions/runs/11/jobs')) {
        return json(200, { jobs: [{ id: 101, name: 'test', status: 'completed', conclusion: 'failure', html_url: 'https://gh/j101', started_at: '2026-09-27T10:00:10Z', completed_at: '2026-09-27T10:01:40Z' }, { id: 102, name: 'lint', status: 'completed', conclusion: 'success', html_url: 'https://gh/j102' }] });
      }
      if (u === '/gh/repos/dono/repo/actions/jobs/101/logs') {
        // a API real responde 302 para um arquivo temporário
        res.writeHead(302, { Location: '/blob/log-101.txt' });
        return res.end();
      }
      if (u === '/blob/log-101.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('passo 1\nErro: esperado 2, veio 3\n');
      }
      if (/^\/gh\/repos\/dono\/repo\/actions\/runs\/11\/(rerun|rerun-failed-jobs|cancel)$/.test(u) && req.method === 'POST') return json(201);
      if (u.startsWith('/gh/repos/dono/repo/actions/workflows?')) return json(200, { workflows: [{ id: 7, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }, { id: 8, name: 'Velho', path: 'x.yml', state: 'disabled_manually' }] });
      if (u === '/gh/repos/dono/repo/actions/workflows/7/dispatches' && req.method === 'POST') return json(204);
      // GitLab self-hosted, subgrupo
      const P = '/gl/projects/time%2Fbackend%2Fapi';
      if (u.startsWith(`${P}/pipelines?`)) {
        return json(200, [
          { id: 900, iid: 45, ref: 'ai/y', sha: 'fff', status: 'failed', source: 'push', web_url: 'https://gl/900', created_at: '2026-09-27T09:00:00Z', updated_at: '2026-09-27T09:05:00Z' },
          { id: 901, iid: 46, ref: 'develop', sha: 'eee', status: 'manual', source: 'push', web_url: 'https://gl/901', created_at: '2026-09-27T09:10:00Z', updated_at: '2026-09-27T09:11:00Z' },
        ]);
      }
      if (u.startsWith(`${P}/pipelines/900/jobs`)) return json(200, [{ id: 5001, name: 'unit', stage: 'test', status: 'failed', web_url: 'https://gl/j5001', duration: 61.7 }]);
      if (u === `${P}/jobs/5001/trace`) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('$ npm test\nFAIL spec\n');
      }
      if (/^\/gl\/projects\/time%2Fbackend%2Fapi\/(pipelines\/900\/(retry|cancel)|pipeline|jobs\/5002\/play)$/.test(u) && req.method === 'POST') {
        if (req.headers['private-token'] !== 'glpat') return json(401, { message: '401 Unauthorized' });
        return json(201, { id: 999 });
      }
      json(404, { message: '404 Not Found' });
    });
  });
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const gh = new GitHubPipelines(parseRemote('https://github.com/dono/repo.git'), 'tok', `${base}/gh`);
  await check('GitHub: lista runs com status, duração e filtro de branch', async () => {
    const list = await gh.list('ai/x');
    assert.ok(seen.at(-1).url.includes('branch=ai%2Fx'));
    assert.strictEqual(seen.at(-1).headers.authorization, 'Bearer tok');
    assert.deepStrictEqual(list.map(p => [p.id, p.status, p.branch, p.durationSec]), [[11, 'failed', 'ai/x', 125], [12, 'running', 'main', undefined]]);
  });
  await check('GitHub: jobs', async () => {
    const jobs = await gh.jobs({ id: 11 });
    assert.deepStrictEqual(jobs.map(j => [j.name, j.status, j.durationSec]), [['test', 'failed', 90], ['lint', 'success', undefined]]);
  });
  await check('GitHub: log segue o redirect e devolve texto', async () => {
    const log = await gh.log({ id: 101 });
    assert.ok(log.includes('Erro: esperado 2, veio 3'), log);
  });
  await check('GitHub: re-run, re-run dos falhos e cancelar usam POST no caminho certo', async () => {
    await gh.retry({ id: 11 }, false);
    assert.deepStrictEqual([seen.at(-1).method, seen.at(-1).url], ['POST', '/gh/repos/dono/repo/actions/runs/11/rerun']);
    await gh.retry({ id: 11 }, true);
    assert.strictEqual(seen.at(-1).url, '/gh/repos/dono/repo/actions/runs/11/rerun-failed-jobs');
    await gh.cancel({ id: 11 });
    assert.strictEqual(seen.at(-1).url, '/gh/repos/dono/repo/actions/runs/11/cancel');
  });
  await check('GitHub: workflows ativos e workflow_dispatch com a ref', async () => {
    const wfs = await gh.workflows();
    assert.deepStrictEqual(wfs.map(w => w.id), [7]);
    await gh.trigger('ai/x', 7);
    assert.deepStrictEqual([seen.at(-1).method, seen.at(-1).url, seen.at(-1).body], ['POST', '/gh/repos/dono/repo/actions/workflows/7/dispatches', { ref: 'ai/x' }]);
    await assert.rejects(gh.trigger('ai/x'), /workflow_dispatch/);
  });

  const gl = new GitLabPipelines(parseRemote('git@git.empresa.local:time/backend/api.git', ['git.empresa.local']), 'glpat', `${base}/gl`);
  await check('GitLab self-hosted: pipelines com ref, status e nome', async () => {
    const list = await gl.list('ai/y');
    assert.ok(seen.at(-1).url.includes('ref=ai%2Fy'));
    assert.deepStrictEqual(list.map(p => [p.id, p.name, p.status, p.durationSec]), [[900, 'Pipeline #45', 'failed', 300], [901, 'Pipeline #46', 'manual', 60]]);
  });
  await check('GitLab: jobs com estágio e log (trace em texto)', async () => {
    const jobs = await gl.jobs({ id: 900 });
    assert.deepStrictEqual(jobs.map(j => [j.name, j.stage, j.status, j.durationSec]), [['unit', 'test', 'failed', 62]]);
    assert.ok((await gl.log(jobs[0])).includes('FAIL spec'));
  });
  await check('GitLab: retry, cancel, novo pipeline e job manual com PRIVATE-TOKEN', async () => {
    await gl.retry({ id: 900 });
    assert.deepStrictEqual([seen.at(-1).method, seen.at(-1).url], ['POST', '/gl/projects/time%2Fbackend%2Fapi/pipelines/900/retry']);
    await gl.cancel({ id: 900 });
    assert.strictEqual(seen.at(-1).url, '/gl/projects/time%2Fbackend%2Fapi/pipelines/900/cancel');
    await gl.trigger('develop');
    assert.deepStrictEqual([seen.at(-1).url, seen.at(-1).body], ['/gl/projects/time%2Fbackend%2Fapi/pipeline', { ref: 'develop' }]);
    await gl.play({ id: 5002 });
    assert.strictEqual(seen.at(-1).url, '/gl/projects/time%2Fbackend%2Fapi/jobs/5002/play');
    assert.strictEqual(seen.at(-1).headers['private-token'], 'glpat');
  });
  await check('GitLab: token inválido vira erro legível', async () => {
    const bad = new GitLabPipelines(parseRemote('git@git.empresa.local:time/backend/api.git', ['git.empresa.local']), 'errado', `${base}/gl`);
    await assert.rejects(bad.retry({ id: 900 }), /401/);
  });

  server.close();
  if (failures) process.exit(1);
})();
