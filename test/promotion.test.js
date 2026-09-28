// Mapa de promoção (src/promotion/core.ts) contra um repositório de verdade. Uso: node test/promotion.test.js
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Repo } = require('../out/git');
const p = require('../out/promotion/core');

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtg-promo-'));
let clock = 1_700_000_000;
const git = (...args) => {
  clock += 60;
  const date = `${clock} +0000`;
  return execFileSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  }).toString();
};
const commit = (file, msg) => {
  fs.writeFileSync(path.join(dir, file), msg + '\n');
  git('add', file);
  git('commit', '-q', '-m', msg);
};
const merge = (branch, into, msg) => {
  git('checkout', '-q', into);
  git('merge', '-q', '--no-ff', branch, '-m', msg ?? `Merge branch '${branch}' into ${into}`);
};

const FLOW = [
  { branch: 'dev', label: 'Dev' },
  { branch: 'qa', label: 'QA' },
  { branch: 'hml', label: 'Homologação' },
  { branch: 'prd', label: 'Produção' },
];

(async () => {
  git('init', '-q', '-b', 'prd');
  commit('base.txt', 'inicial');
  for (const b of ['hml', 'qa', 'dev']) git('branch', b);

  // a: dev e QA, falta homologação
  git('checkout', '-q', '-b', 'feature/a', 'dev');
  commit('a.txt', 'feat: a');
  merge('feature/a', 'dev');
  merge('dev', 'qa');
  // b: só em dev, branch já apagada
  git('checkout', '-q', '-b', 'feature/b', 'dev');
  commit('b1.txt', 'feat: b1');
  commit('b2.txt', 'feat: b2');
  merge('feature/b', 'dev', 'Merge pull request #7 from dono/feature/b\n\nTela B');
  git('branch', '-q', '-D', 'feature/b');
  // commit direto em dev
  git('checkout', '-q', 'dev');
  commit('d.txt', 'chore: direto em dev');
  // c: fora do fluxo
  git('checkout', '-q', '-b', 'feature/c', 'dev');
  commit('c.txt', 'feat: c');
  // d: direto em homologação, pulando dev e QA
  git('checkout', '-q', '-b', 'feature/d', 'prd');
  commit('dd.txt', 'feat: d');
  merge('feature/d', 'hml');
  // hotfix só em produção
  git('checkout', '-q', 'prd');
  commit('hot.txt', 'fix: urgente em produção');
  // e: criada de dev, sem commits
  git('branch', 'feature/e', 'dev');
  // f: merge com mensagem própria (pt-BR), em dev
  git('checkout', '-q', '-b', 'feat/f', 'dev');
  commit('f.txt', 'feat: f');
  merge('feat/f', 'dev', 'Mescla feat/f: v1.2');
  git('checkout', '-q', 'prd');

  const repo = await Repo.open(dir);
  const map = await p.computePromotion(repo, FLOW, 'local', 'origin');
  const step = (from, to) => map.steps.find(s => s.from.branch === from && s.to.branch === to);
  const names = gs => gs.map(g => (g.kind === 'direct' ? '(direto)' : g.branch)).sort();
  const row = n => map.rows.find(r => r.name === n);

  await check('estágios resolvidos, na ordem', () => {
    assert.deepStrictEqual(map.stages.map(s => s.ref), ['dev', 'qa', 'hml', 'prd']);
    assert.ok(map.stages.every(s => s.sha && s.date));
  });

  await check('dev → qa: features pendentes, branch apagada, merge pt-BR e commit direto', () => {
    const s = step('dev', 'qa');
    assert.deepStrictEqual(names(s.forward), ['(direto)', 'feat/f', 'feature/b']);
    const b = s.forward.find(g => g.branch === 'feature/b');
    assert.strictEqual(b.kind, 'merge');
    assert.strictEqual(b.live, false);
    assert.strictEqual(b.ref, '#7');
    assert.strictEqual(b.title, 'Tela B');
    assert.strictEqual(b.commits.length, 2);
    assert.deepStrictEqual(s.forward.find(g => g.kind === 'direct').commits.map(c => c.subject), ['chore: direto em dev']);
    assert.strictEqual(s.forwardCount, 4);
    assert.deepStrictEqual(s.backward, []);
  });

  await check('qa → hml: feature/a a promover; feature/d só em hml (volta)', () => {
    const s = step('qa', 'hml');
    assert.deepStrictEqual(names(s.forward), ['feature/a']);
    assert.strictEqual(s.forward[0].live, true);
    assert.deepStrictEqual(names(s.backward), ['feature/d']);
  });

  await check('hml → prd: feature/d sobe; hotfix só em produção aparece como commit direto', () => {
    const s = step('hml', 'prd');
    assert.deepStrictEqual(names(s.forward), ['feature/d']);
    assert.deepStrictEqual(names(s.backward), ['(direto)']);
    assert.strictEqual(s.backward[0].commits[0].subject, 'fix: urgente em produção');
  });

  await check('matriz: até onde cada branch chegou', () => {
    assert.deepStrictEqual(row('feature/a').missing, [0, 0, 1, 1]);
    assert.strictEqual(row('feature/a').reached, 2);
    assert.strictEqual(row('feature/c').reached, 0);
    assert.strictEqual(row('feature/c').missing[0], 1);
    assert.strictEqual(row('feat/f').reached, 1);
  });

  await check('matriz: etapa pulada e branch sem commits próprios', () => {
    const d = row('feature/d');
    assert.strictEqual(d.reached, 0);
    assert.deepStrictEqual(d.ahead, [2]);
    assert.strictEqual(row('feature/e').noOwnCommits, true);
    assert.strictEqual(row('feature/c').noOwnCommits, false);
    assert.ok(!map.rows.some(r => ['dev', 'qa', 'hml', 'prd'].includes(r.name)));
  });

  await check('modo remoto: usa origin/<estágio> e acusa divergência com o local', async () => {
    const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtg-promo-remote-'));
    execFileSync('git', ['init', '-q', '--bare', remoteDir]);
    git('remote', 'add', 'origin', remoteDir);
    git('push', '-q', 'origin', 'dev', 'qa', 'hml', 'prd', 'feature/c');
    git('checkout', '-q', 'dev');
    commit('local.txt', 'feat: só local');
    git('branch', '-q', '-D', 'feature/c');
    git('checkout', '-q', 'prd');
    const m = await p.computePromotion(repo, FLOW, 'remote', 'origin');
    assert.strictEqual(m.stages[0].ref, 'refs/remotes/origin/dev');
    assert.deepStrictEqual(m.stages[0].drift, [1, 0]);
    const c = m.rows.find(r => r.name === 'feature/c');
    assert.ok(c && c.remoteOnly, 'feature/c só no remoto entra na matriz');
    assert.deepStrictEqual((await p.branchNames(repo, 'origin')).sort().filter(n => ['dev', 'feature/c'].includes(n)), ['dev', 'feature/c']);
    fs.rmSync(remoteDir, { recursive: true, force: true });
  });

  await check('mensagens de merge de outras plataformas', () => {
    assert.deepStrictEqual(p.mergeSource('Merged in feature/x (pull request #3)', 'Título'), { branch: 'feature/x', ref: '#3', title: 'Título' });
    assert.deepStrictEqual(p.mergeSource('Merged PR 42: Ajusta login', ''), { ref: '!42', title: 'Ajusta login' });
    assert.strictEqual(p.mergeSource("Merge remote-tracking branch 'origin/dev' into qa", '').branch, 'dev');
    assert.ok(p.isStageName('origin/dev', ['dev']));
    assert.ok(p.isStageName('remotes/origin/qa', ['dev', 'qa']));
    assert.ok(!p.isStageName('feature/dev', ['dev', 'qa']));
  });

  await check('classificação com estágio inexistente', () => {
    assert.deepStrictEqual(p.classify([0, undefined, 3, 0]), { reached: 2, ahead: [3] });
    assert.deepStrictEqual(p.classify([0, 0, undefined]), { reached: 3, ahead: [] });
    assert.deepStrictEqual(p.classify([2, 0]), { reached: 0, ahead: [1] });
  });

  await check('destinos de merge seguem o fluxo', () => {
    const heads = ['main', 'dev', 'qa', 'feat/a', 'feat/b'];
    const flow = ['dev', 'qa', 'main'];
    assert.deepStrictEqual(p.orderTargets(flow, 'main', ['feat/a'], heads), ['dev', 'qa', 'main', 'feat/b']);
    assert.deepStrictEqual(p.orderTargets(flow, 'main', ['dev'], heads), ['qa', 'main', 'feat/a', 'feat/b']);
    assert.deepStrictEqual(p.orderTargets(flow, 'main', ['qa'], heads), ['main', 'dev', 'feat/a', 'feat/b']);
    assert.deepStrictEqual(p.orderTargets(['develop', 'dev', 'main'], 'main', [], heads), ['dev', 'main', 'qa', 'feat/a', 'feat/b'], 'estágio sem branch local fica de fora');
    assert.deepStrictEqual(p.orderTargets([], 'main', ['feat/a'], heads), ['main', 'dev', 'qa', 'feat/b'], 'sem fluxo: base primeiro');
  });

  fs.rmSync(dir, { recursive: true, force: true });
  if (failures) {
    console.log(`${failures} falha(s)`);
    process.exit(1);
  }
})();
