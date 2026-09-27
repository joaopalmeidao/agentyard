// Revisão por agente: formato do review.json, linhas do diff e postagem no GitHub/GitLab (servidor falso).
// Uso: node test/review.test.js
const assert = require('assert');
const http = require('http');
const { parseRemote } = require('../out/hosting/core');
const { parseReviewFile, newSideLines, GitHubReviewPoster, GitLabReviewPoster } = require('../out/hosting/review');
const { parseCommitLog, buildActivity, costPerTask, rangeOf, costOf, branchOfSession } = require('../out/activity');

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

const PATCH = ['@@ -10,4 +10,5 @@ export function login(u, s) {', ' const a = 1;', '-const b = 2;', '+const b = 3;', '+const c = 4;', ' return a;', ' }'].join('\n');

(async () => {
  await check('review.json: aceita cerca de markdown, ignora comentário vazio, normaliza caminho', () => {
    const r = parseReviewFile('```json\n{"summary":"ok","comments":[{"path":".\\\\src\\\\a.ts","line":"12","body":"x","severity":"bug"},{"path":"b","body":"  "}]}\n```');
    assert.deepStrictEqual(r, { summary: 'ok', comments: [{ path: 'src/a.ts', line: 12, body: 'x', severity: 'bug' }] });
    assert.throws(() => parseReviewFile('{ quebrado'), /is not valid JSON/);
  });

  await check('linhas do lado novo do diff (adicionadas e de contexto)', () => {
    assert.deepStrictEqual([...newSideLines(PATCH)], [10, 11, 12, 13, 14]);
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
      if (u.startsWith('/gh/repos/dono/repo/pulls/5/files')) return send(200, [{ filename: 'src/auth.ts', patch: PATCH }]);
      if (u === '/gh/repos/dono/repo/pulls/5/reviews' && req.method === 'POST') return send(200, { id: 1, html_url: 'https://github.com/dono/repo/pull/5#pullrequestreview-1' });
      if (u === '/gl/projects/time%2Fapi/merge_requests/3/versions') return send(200, [{ base_commit_sha: 'b', start_commit_sha: 's', head_commit_sha: 'h' }]);
      if (u === '/gl/projects/time%2Fapi/merge_requests/3/changes') return send(200, { changes: [{ old_path: 'src/auth.ts', new_path: 'src/auth.ts', diff: PATCH }] });
      if (u === '/gl/projects/time%2Fapi/merge_requests/3/discussions' && req.method === 'POST') {
        const b = JSON.parse(body);
        if (b.position.new_line === 14) return send(400, { message: '400 (line_code) invalid' });
        return send(201, { id: 'd1' });
      }
      if (u === '/gl/projects/time%2Fapi/merge_requests/3/notes' && req.method === 'POST') return send(201, { id: 77 });
      send(404, { message: 'not found' });
    });
  });
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const review = {
    summary: 'Um bug e uma sugestão.',
    comments: [
      { path: 'src/auth.ts', line: 12, body: 'b mudou de valor sem teste', severity: 'bug' },
      { path: 'src/auth.ts', line: 40, body: 'fora do diff', severity: 'sugestao' },
      { path: 'README.md', body: 'sem linha', severity: 'nit' },
    ],
  };

  await check('GitHub: review COMMENT com comentário em linha; o resto vai no texto geral', async () => {
    const p = new GitHubReviewPoster(parseRemote('https://github.com/dono/repo.git'), 'tok', `${base}/gh`);
    const r = await p.post(5, review);
    assert.deepStrictEqual({ inline: r.inline, general: r.general }, { inline: 1, general: 2 });
    const post = seen.find(s => s.url.endsWith('/pulls/5/reviews'));
    assert.strictEqual(post.body.event, 'COMMENT');
    assert.deepStrictEqual(post.body.comments, [{ path: 'src/auth.ts', line: 12, side: 'RIGHT', body: '**🐞 bug** b mudou de valor sem teste' }]);
    assert.ok(post.body.body.includes('`src/auth.ts:40`') && post.body.body.includes('`README.md`'), post.body.body);
    assert.strictEqual(post.headers.authorization, 'Bearer tok');
  });

  await check('GitLab self-hosted: discussões com posição; posição recusada (400) cai para a nota geral', async () => {
    seen.length = 0;
    const p = new GitLabReviewPoster(parseRemote('git@git.empresa.local:time/api.git', ['git.empresa.local']), 'glpat', `${base}/gl`);
    const r = await p.post(3, { summary: 's', comments: [...review.comments, { path: 'src/auth.ts', line: 14, body: 'posição recusada' }] });
    assert.deepStrictEqual({ inline: r.inline, general: r.general }, { inline: 1, general: 3 });
    const disc = seen.filter(s => s.url.endsWith('/discussions'));
    assert.strictEqual(disc.length, 2);
    assert.deepStrictEqual(disc[0].body.position, { position_type: 'text', base_sha: 'b', start_sha: 's', head_sha: 'h', old_path: 'src/auth.ts', new_path: 'src/auth.ts', new_line: 12 });
    const note = seen.find(s => s.url.endsWith('/notes'));
    assert.ok(note.body.body.includes('posição recusada') && note.body.body.includes('fora do diff'));
    assert.strictEqual(note.headers['private-token'], 'glpat');
    assert.ok(r.url.endsWith('/time/api/-/merge_requests/3#note_77'), r.url);
  });
  server.close();

  // ---------- atividade e custo (sem VS Code) ----------
  await check('git log com --source e --numstat vira commits por branch', () => {
    const out = '\x1eabc\x1frefs/heads/ai/x\x1fAna\x1f1700000000\x1ffeat: a\n\n3\t1\tsrc/a.ts\n-\t-\timg.png\n\x1edef\x1frefs/heads/main\x1fBia\x1f1700000100\x1ffix: b\n\n1\t0\tREADME.md\n';
    const c = parseCommitLog(out);
    assert.deepStrictEqual(c.map(x => [x.branch, x.files.length, x.files[0].added]), [['ai/x', 2, 3], ['main', 1, 1]]);
    assert.strictEqual(c[0].date, 1700000000000);
  });

  const now = new Date(2026, 8, 27, 15, 30).getTime();
  const at = h => new Date(2026, 8, 27, h, 10).getTime();
  const wts = [{ path: 'G:/wt/ai-x', branch: 'ai/x' }, { path: 'G:/repo', branch: 'main' }];
  const sess = (id, cwd, events, usage, gitBranch) => ({ id, file: id, cwd, gitBranch, start: events[0]?.[0] ?? 0, end: 0, userMessages: 1, assistantMessages: 1, usage, models: [], events, daily: {} });
  const sessions = [
    sess('s1', 'G:\\wt\\ai-x', [[at(9), 1000], [at(14), 2000]], { input: 1000, output: 2000, cacheRead: 5000, cacheCreate: 0 }),
    sess('s2', 'G:/outra', [[at(10), 500]], { input: 500, output: 0, cacheRead: 0, cacheCreate: 0 }, 'ai/x'),
    sess('s3', 'G:/repo/sub', [[now - 3 * 86400000, 700]], { input: 700, output: 0, cacheRead: 0, cacheCreate: 0 }),
  ];

  await check('atividade de hoje: por branch, com sessões pela worktree ou pelo gitBranch, e por hora', () => {
    const commits = [{ sha: 'a', branch: 'ai/x', author: 'Ana', date: at(14), subject: 's', files: [{ path: 'src/a.ts', added: 3, deleted: 1 }] }];
    const r = buildActivity(rangeOf('today', now), commits, sessions, wts);
    const x = r.rows.find(row => row.branch === 'ai/x');
    assert.deepStrictEqual({ c: x.commits, f: x.files, s: x.sessions, t: x.tokens }, { c: 1, f: 1, s: 2, t: 3500 });
    assert.ok(!r.rows.some(row => row.branch === 'main'), 'sessão de 3 dias atrás fica fora de hoje');
    assert.deepStrictEqual([r.chart[9].tokens, r.chart[14].tokens, r.chart[14].commits], [1000, 2000, 1]);
    const w = buildActivity(rangeOf('week', now), [], sessions, wts);
    assert.strictEqual(w.rows.find(row => row.branch === 'main').tokens, 700);
  });

  await check('custo por tarefa soma todas as sessões da branch e liga à issue', () => {
    const prices = { input: 3, output: 15, cacheRead: 0.3 };
    const costs = costPerTask(sessions, wts, b => (b === 'ai/x' ? { key: '#12', title: 'Login', url: 'u', kind: 'issue' } : undefined), prices);
    const x = costs.find(c => c.branch === 'ai/x');
    assert.deepStrictEqual({ s: x.sessions, t: x.tokens, k: x.task.key }, { s: 2, t: 3500, k: '#12' });
    assert.strictEqual(x.usd.toFixed(4), ((1500 * 3 + 2000 * 15 + 5000 * 0.3) / 1e6).toFixed(4));
    assert.strictEqual(costPerTask(sessions, wts, () => undefined, { input: 0, output: 0, cacheRead: 0 })[0].usd, undefined);
    assert.strictEqual(costOf({ input: 1e6, output: 0, cacheRead: 0, cacheCreate: 0 }, prices), 3);
    assert.strictEqual(branchOfSession(sessions[2], wts), 'main', 'subpasta da worktree conta como a worktree');
  });

  if (failures) process.exit(1);
})();
