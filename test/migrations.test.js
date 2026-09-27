// Regras de src/migrations/core.ts (migrations que colidem num merge e o reencadeamento).
// Uso: node test/migrations.test.js
const assert = require('assert');
const m = require('../out/migrations/core');

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${e.stack || e}`);
  }
};

const dj = (deps, extra = '') =>
  `from django.db import migrations\n\nclass Migration(migrations.Migration):\n    dependencies = [\n${deps.map(([a, n]) => `        ('${a}', '${n}'),\n`).join('')}    ]\n${extra}`;

const alembic = (rev, down, annotated = false) =>
  `"""x\n\nRevision ID: ${rev}\nRevises: ${down ?? ''}\n"""\n` +
  (annotated
    ? `revision: str = '${rev}'\ndown_revision: Union[str, None] = ${down ? `'${down}'` : 'None'}\n`
    : `revision = "${rev}"\ndown_revision = ${down ? `"${down}"` : 'None'}\n`);

check('caminhos: Django, Alembic, Flyway, golang-migrate; timestamps ficam de fora', () => {
  assert.ok(m.isMigrationPath('blog/migrations/0005_post.py'));
  assert.ok(!m.isMigrationPath('blog/migrations/__init__.py'));
  assert.ok(m.isMigrationPath('alembic/versions/abc_x.py'));
  assert.ok(m.isMigrationPath('src/main/resources/db/migration/V12__x.sql'));
  assert.ok(m.isMigrationPath('db/migrations/000003_users.up.sql'));
  assert.ok(!m.isMigrationPath('db/migrate/20240101120000_create_users.rb'), 'timestamp do Rails');
  assert.ok(!m.isMigrationPath('src/001_util.ts'), 'numerado fora de pasta de migrations');
});

check('Django: mesma numeração nos dois lados → renumera e aponta para a última do destino', () => {
  const target = [
    { path: 'blog/migrations/0004_a.py' },
    { path: 'blog/migrations/0005_base.py' },
  ];
  const added = [
    { path: 'blog/migrations/0005_mine.py', content: dj([['blog', '0004_a']]) },
    { path: 'blog/migrations/0006_more.py', content: dj([['blog', '0005_mine']]) },
    { path: 'shop/migrations/0002_x.py', content: dj([['shop', '0001_initial'], ['blog', '0006_more']]) },
  ];
  const p = m.planRechain([...target, { path: 'shop/migrations/0001_initial.py' }], added);
  const blog = p.groups.find(g => g.dir === 'blog/migrations');
  assert.strictEqual(blog.status, 'rechain');
  assert.strictEqual(p.groups.find(g => g.dir === 'shop/migrations').status, 'ok');
  assert.deepStrictEqual(p.renames, [
    { from: 'blog/migrations/0005_mine.py', to: 'blog/migrations/0006_mine.py' },
    { from: 'blog/migrations/0006_more.py', to: 'blog/migrations/0007_more.py' },
  ]);
  const w = Object.fromEntries(p.writes.map(x => [x.path, x.content]));
  assert.match(w['blog/migrations/0006_mine.py'], /\('blog', '0005_base'\)/);
  assert.match(w['blog/migrations/0007_more.py'], /\('blog', '0006_mine'\)/);
  assert.match(w['shop/migrations/0002_x.py'], /\('blog', '0007_more'\)/, 'outro app que depende da renomeada');
  assert.match(w['shop/migrations/0002_x.py'], /\('shop', '0001_initial'\)/);
});

check('Django: base já trazida para a branch (duas 0005 no mesmo lugar) também é detectado', () => {
  const p = m.planRechain(
    [{ path: 'app/migrations/0004_a.py' }, { path: 'app/migrations/0005_base.py' }],
    [{ path: 'app/migrations/0005_mine.py', content: dj([['app', '0004_a']]) }],
  );
  assert.strictEqual(p.groups[0].status, 'rechain');
  assert.deepStrictEqual(p.renames, [{ from: 'app/migrations/0005_mine.py', to: 'app/migrations/0006_mine.py' }]);
});

check('Django: já depois da última → nada a fazer; label do app diferente do nome da pasta', () => {
  const p = m.planRechain(
    [{ path: 'apps/core/migrations/0005_base.py' }],
    [{ path: 'apps/core/migrations/0006_mine.py', content: dj([['mycore', '0005_base']]) }],
  );
  assert.strictEqual(p.groups[0].status, 'ok');
  assert.ok(!m.needsAttention(p));
  const q = m.planRechain(
    [{ path: 'apps/core/migrations/0005_base.py' }, { path: 'apps/core/migrations/0006_other.py' }],
    [{ path: 'apps/core/migrations/0006_mine.py', content: dj([['mycore', '0005_base']]) }],
  );
  assert.match(q.writes[0].content, /\('mycore', '0006_other'\)/);
  assert.strictEqual(q.writes[0].path, 'apps/core/migrations/0007_mine.py');
});

check('Django: destino com duas migrations no topo → manual', () => {
  const p = m.planRechain(
    [{ path: 'a/migrations/0005_x.py' }, { path: 'a/migrations/0005_y.py' }],
    [{ path: 'a/migrations/0005_z.py', content: dj([['a', '0004_w']]) }],
  );
  assert.strictEqual(p.groups[0].status, 'manual');
  assert.deepStrictEqual(p.renames, []);
});

check('Alembic: duas heads → down_revision da branch passa para a head do destino', () => {
  const target = [
    { path: 'alembic/versions/a1.py', content: alembic('a1', null) },
    { path: 'alembic/versions/b2.py', content: alembic('b2', 'a1') },
    { path: 'alembic/versions/c3.py', content: alembic('c3', 'b2') },
  ];
  const added = [
    { path: 'alembic/versions/m1.py', content: alembic('m1', 'b2', true) },
    { path: 'alembic/versions/m2.py', content: alembic('m2', 'm1') },
  ];
  const p = m.planRechain(target, added);
  assert.strictEqual(p.groups[0].status, 'rechain');
  assert.strictEqual(p.writes.length, 1);
  assert.strictEqual(p.writes[0].path, 'alembic/versions/m1.py');
  assert.deepStrictEqual(m.alembicInfo(p.writes[0].content), { revision: 'm1', down: ['c3'] });
  assert.match(p.writes[0].content, /down_revision: Union\[str, None\] = 'c3'/);
  assert.match(p.writes[0].content, /^Revises: c3$/m);
});

check('Alembic: já em cima da head → ok; várias heads no destino ou merge na branch → manual', () => {
  const target = [
    { path: 'v/versions/a1.py', content: alembic('a1', null) },
    { path: 'v/versions/b2.py', content: alembic('b2', 'a1') },
  ];
  assert.strictEqual(m.planRechain(target, [{ path: 'v/versions/m.py', content: alembic('m', 'b2') }]).groups[0].status, 'ok');
  const twoHeads = [...target, { path: 'v/versions/c3.py', content: alembic('c3', 'a1') }];
  assert.strictEqual(m.planRechain(twoHeads, [{ path: 'v/versions/m.py', content: alembic('m', 'a1') }]).groups[0].status, 'manual');
  const merge = `revision = 'm'\ndown_revision = (\n    'a1',\n    'x',\n)\n`;
  assert.deepStrictEqual(m.alembicInfo(merge).down, ['a1', 'x'], 'tupla em várias linhas');
  assert.strictEqual(m.planRechain(target, [{ path: 'v/versions/m.py', content: merge }]).groups[0].status, 'manual');
});

check('numeradas: Flyway e golang-migrate (up/down juntos, zeros à esquerda)', () => {
  const p = m.planRechain(
    [
      { path: 'db/migration/V1__init.sql' },
      { path: 'db/migration/V2__users.sql' },
      { path: 'db/migrations/000001_a.up.sql' },
      { path: 'db/migrations/000002_b.up.sql' },
    ],
    [
      { path: 'db/migration/V2__orders.sql', content: '' },
      { path: 'db/migrations/000002_c.up.sql', content: '' },
      { path: 'db/migrations/000002_c.down.sql', content: '' },
      { path: 'db/migrations/000003_d.up.sql', content: '' },
    ],
  );
  assert.deepStrictEqual(
    p.renames.map(r => `${r.from} → ${r.to}`),
    [
      'db/migration/V2__orders.sql → db/migration/V3__orders.sql',
      'db/migrations/000002_c.up.sql → db/migrations/000003_c.up.sql',
      'db/migrations/000002_c.down.sql → db/migrations/000003_c.down.sql',
      'db/migrations/000003_d.up.sql → db/migrations/000004_d.up.sql',
    ],
  );
  assert.ok(m.describePlan(p).some(l => l.includes('V2__orders.sql → V3__orders.sql')));
});

check('numeradas: já depois da maior → ok', () => {
  const p = m.planRechain([{ path: 'migrations/001_a.sql' }], [{ path: 'migrations/002_b.sql', content: '' }]);
  assert.strictEqual(p.groups[0].status, 'ok');
  assert.ok(!m.needsRechain(p));
});

// ---------- num repositório git de verdade (src/migrations/scan.ts) ----------

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Repo } = require('../out/git');
const { checkMigrations } = require('../out/migrations/scan');

async function gitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtg-mig-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  const write = (p, c) => {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'core.autocrlf', 'false');
  write('app/migrations/__init__.py', '');
  write('app/migrations/0001_initial.py', dj([]));
  write('alembic/versions/a1.py', alembic('a1', null));
  git('add', '-A');
  git('commit', '-qm', 'init');
  git('checkout', '-qb', 'feat');
  write('app/migrations/0002_mine.py', dj([['app', '0001_initial']]));
  write('alembic/versions/m1.py', alembic('m1', 'a1'));
  git('add', '-A');
  git('commit', '-qm', 'feat');
  git('checkout', '-q', 'main');
  write('app/migrations/0002_base.py', dj([['app', '0001_initial']]));
  write('alembic/versions/b2.py', alembic('b2', 'a1'));
  git('add', '-A');
  git('commit', '-qm', 'base');
  return { dir, git, repo: await Repo.open(dir) };
}

const checks = [];
const acheck = (name, fn) => checks.push([name, fn]);

acheck('git: colisão antes e depois de trazer a base para a branch', async () => {
  const { dir, git, repo } = await gitRepo();
  try {
    const before = await checkMigrations(repo, 'feat', 'main');
    assert.deepStrictEqual(before.plan.groups.map(g => [g.kind, g.status]), [['alembic', 'rechain'], ['django', 'rechain']]);
    assert.deepStrictEqual(before.plan.renames, [{ from: 'app/migrations/0002_mine.py', to: 'app/migrations/0003_mine.py' }]);
    assert.deepStrictEqual(m.alembicInfo(before.plan.writes.find(w => w.path.endsWith('m1.py')).content).down, ['b2']);
    // O git mescla sem conflito (arquivos diferentes), mas a cadeia continua quebrada.
    git('checkout', '-q', 'feat');
    git('merge', '-q', '--no-edit', 'main');
    const after = await checkMigrations(repo, 'feat', 'main');
    assert.ok(m.needsRechain(after.plan));
    assert.deepStrictEqual(after.plan.renames, before.plan.renames);
    assert.strictEqual((await checkMigrations(repo, 'main', 'main')).plan.groups.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

(async () => {
  for (const [name, fn] of checks) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (e) {
      failures++;
      console.log(`FAIL ${name}: ${e.stack || e}`);
    }
  }
  if (failures) {
    console.log(`\n${failures} falha(s)`);
    process.exit(1);
  }
  console.log('\nmigrations: tudo ok');
})();
