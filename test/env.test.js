// Ambiente por worktree e modelos de tarefa (sem VS Code). Uso: node test/env.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { allocatePort, portVars, rewriteEnv, detectSetup, dirSize, formatBytes } = require('../out/env/core');
const { renderTemplate, placeholdersOf, parseTemplateFile, defaultTemplates } = require('../out/templates/core');

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
  const cfg = { base: 3000, step: 10, vars: ['PORT', 'VITE_PORT'] };

  await check('portas: estável por branch, sem colisão, reaproveita buraco', () => {
    let a = {};
    let r = allocatePort(a, 'ai/x', cfg);
    assert.strictEqual(r.port, 3000);
    a = r.assigned;
    r = allocatePort(a, 'ai/y', cfg);
    assert.strictEqual(r.port, 3010);
    a = r.assigned;
    assert.strictEqual(allocatePort(a, 'ai/x', cfg).port, 3000, 'mesma branch, mesma porta');
    const semX = { 'ai/y': 3010 };
    assert.strictEqual(allocatePort(semX, 'ai/z', cfg).port, 3000, 'bloco livre é reaproveitado');
    assert.deepStrictEqual(portVars(3010, cfg.vars), { PORT: '3010', VITE_PORT: '3011' });
  });

  await check('.env: troca só as portas e preserva o resto (comentário, export, CRLF)', () => {
    const src = '# app\r\nexport PORT=8000\r\nDB_URL="postgres://x"\r\n\r\n';
    const out = rewriteEnv(src, { PORT: '3010', VITE_PORT: '3011' });
    assert.ok(out.includes('export PORT=3010\r\n'));
    assert.ok(out.includes('DB_URL="postgres://x"'));
    assert.ok(out.includes('# app'));
    assert.ok(out.includes('VITE_PORT=3011'), 'variável ausente vai para o fim');
    assert.strictEqual(rewriteEnv('', { PORT: '1' }).trim().split(/\r?\n/).pop(), 'PORT=1');
  });

  await check('setup: gerenciador pelo lockfile e Python', () => {
    assert.strictEqual(detectSetup(['package.json', 'pnpm-lock.yaml']).node.manager, 'pnpm');
    assert.strictEqual(detectSetup(['package.json', 'yarn.lock']).node.manager, 'yarn');
    assert.strictEqual(detectSetup(['package.json', 'package-lock.json']).node.install, 'npm ci');
    assert.strictEqual(detectSetup(['requirements.txt']).python.tool, 'pip');
    assert.strictEqual(detectSetup(['pyproject.toml', 'uv.lock']).python.tool, 'uv');
    assert.deepStrictEqual(detectSetup(['README.md']), {});
  });

  await check('espaço: soma arquivos e não segue link/junction', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ay-size-'));
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'ay-shared-'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'x'.repeat(1000));
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'y'.repeat(500));
    fs.writeFileSync(path.join(shared, 'grande.bin'), Buffer.alloc(100000));
    fs.symlinkSync(shared, path.join(root, 'node_modules'), 'junction');
    const r = await dirSize(root);
    assert.deepStrictEqual(r, { bytes: 1500, complete: true });
    const cut = await dirSize(root, Date.now() - 1);
    assert.strictEqual(cut.complete, false, 'limite de tempo devolve parcial');
    assert.strictEqual(formatBytes(1288490189), '1.2 GB');
    assert.strictEqual(formatBytes(512), '512 B');
  });

  await check('modelos: placeholders, arquivo do repositório e padrões', () => {
    assert.strictEqual(renderTemplate('Na ${branch} (base ${base}) ${x}', { branch: 'ai/a', base: 'master' }), 'Na ai/a (base master) ${x}');
    assert.strictEqual(renderTemplate('[${issue}]', { issue: undefined }), '[]');
    assert.deepStrictEqual(placeholdersOf('${file} e ${file} e ${selection}'), ['file', 'selection']);
    const t = parseTemplateFile('---\nname: Migrar API\ndescription: v1 → v2\n---\nMigre ${file}\n', 'migrar-api.md');
    assert.deepStrictEqual({ id: t.id, name: t.name, description: t.description, prompt: t.prompt, source: t.source }, {
      id: 'migrar-api', name: 'Migrar API', description: 'v1 → v2', prompt: 'Migre ${file}', source: 'repository',
    });
    assert.strictEqual(parseTemplateFile('só o prompt', 'x.md').name, 'x');
    const defaults = defaultTemplates();
    assert.strictEqual(defaults.length, 6);
    assert.ok(defaults.find(d => d.id === 'write-tests').prompt.includes('${file}'));
    assert.ok(defaults.find(d => d.id === 'investigate-error').prompt.includes('${selection}'));
  });

  if (failures) process.exit(1);
})();
