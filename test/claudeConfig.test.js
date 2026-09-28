// Testes de src/claude/config.ts com pastas sintéticas (nunca lê ~/.claude). Uso: node test/claudeConfig.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../out/claude/config');

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wtg-claude-config-'));
const claude = path.join(root, 'claude');
const proj = path.join(root, 'repo');
fs.mkdirSync(path.join(claude, 'skills', 'minha'), { recursive: true });
fs.writeFileSync(path.join(claude, 'skills', 'minha', 'SKILL.md'), '---\nname: minha\ndescription: "Faz: coisas"\n---\ncorpo\n');
fs.mkdirSync(path.join(claude, 'skills', 'synced', 'conta', 'pdf'), { recursive: true });
fs.writeFileSync(path.join(claude, 'skills', 'synced', 'conta', 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: PDFs\n---\n');
fs.mkdirSync(path.join(claude, 'skills', 'quebrada'), { recursive: true });
fs.writeFileSync(path.join(claude, 'skills', 'quebrada', 'SKILL.md'), 'sem frontmatter');
fs.mkdirSync(path.join(proj, '.claude', 'commands', 'git'), { recursive: true });
fs.writeFileSync(path.join(proj, '.claude', 'commands', 'git', 'pr.md'), '---\ndescription: Abre PR\n---\nFaça o PR.\n');

check('codificação da pasta do projeto (regra do Claude Code)', () => {
  assert.strictEqual(C.encodeProjectDir('C:\\Users\\jp-08'), 'C--Users-jp-08');
  assert.strictEqual(C.encodeProjectDir('E:\\Programacao\\cs2-hack\\.claude\\worktrees\\aimbot-vis-fix'), 'E--Programacao-cs2-hack--claude-worktrees-aimbot-vis-fix');
  assert.strictEqual(C.encodeProjectDir('e:\\projetos_leandro\\repositorios_git\\robo_protocolo'), 'e--projetos-leandro-repositorios-git-robo-protocolo');
  assert.strictEqual(C.encodeProjectDir('/home/ana/meu.app'), '-home-ana-meu-app');
});

check('memoryDirFor acha a pasta existente sem diferenciar maiúsculas', () => {
  const existing = path.join(claude, 'projects', 'e--proj-x', 'memory');
  fs.mkdirSync(existing, { recursive: true });
  assert.strictEqual(C.memoryDirFor(claude, 'E:\\proj\\x'), existing);
  assert.strictEqual(C.memoryDirFor(claude, 'F:\\novo'), path.join(claude, 'projects', 'F--novo', 'memory'));
});

check('frontmatter: aspas, aninhado e ausente', () => {
  const f = C.parseFrontmatter('---\nname: a\ndescription: "x: \\"y\\""\nmetadata:\n  type: user\n  modified: 2026\n---\ncorpo');
  assert.deepStrictEqual(f.data, { name: 'a', description: 'x: "y"', metadata: { type: 'user', modified: '2026' } });
  assert.strictEqual(f.body, 'corpo');
  assert.strictEqual(C.parseFrontmatter('nada').present, false);
});

check('skills: diretas, sincronizadas só leitura, inválida com aviso', () => {
  const s = C.listSkills('user', claude);
  const by = Object.fromEntries(s.map(x => [x.name, x]));
  assert.strictEqual(by.minha.description, 'Faz: coisas');
  assert.strictEqual(by.minha.readOnly, false);
  assert.strictEqual(by.pdf.readOnly, true);
  assert.ok(by.quebrada.error);
  assert.deepStrictEqual(C.listSkills('project', claude, proj), []);
});

check('comandos com subpasta viram pasta:nome', () => {
  const c = C.listCommands('project', claude, proj);
  assert.deepStrictEqual(c.map(x => [x.name, x.description]), [['git:pr', 'Abre PR']]);
});

check('criar, copiar para o projeto, renomear e excluir skill', () => {
  const file = C.createSkill('user', claude, proj, 'nova-skill', 'Quando usar: sempre');
  assert.ok(C.parseFrontmatter(fs.readFileSync(file, 'utf8')).data.description === 'Quando usar: sempre');
  assert.throws(() => C.createSkill('user', claude, proj, 'Nome Ruim', ''));
  const entry = C.listSkills('user', claude).find(x => x.name === 'nova-skill');
  const copied = C.copyToScope(entry, 'project', claude, proj);
  assert.ok(fs.existsSync(copied) && copied.includes(path.join('.claude', 'skills', 'nova-skill')));
  const renamed = C.renameEntry(C.listSkills('project', claude, proj)[0], 'outra');
  assert.strictEqual(C.parseFrontmatter(fs.readFileSync(renamed, 'utf8')).data.name, 'outra');
  C.deleteEntry(C.listSkills('project', claude, proj)[0]);
  assert.deepStrictEqual(C.listSkills('project', claude, proj), []);
  assert.throws(() => C.deleteEntry(C.listSkills('user', claude).find(x => x.readOnly)), /Synced skill/);
});

check('settings: permissões e modelo preservam chaves desconhecidas e fazem backup', () => {
  const file = path.join(claude, 'settings.json');
  fs.writeFileSync(file, '{\n  // comentário\n  "permissions": { "allow": ["Read"] },\n  "desconhecida": { "a": 1 },\n}\n');
  const bak = C.addPermission(file, 'deny', 'Bash(rm -rf *)');
  assert.ok(fs.existsSync(bak));
  C.addPermission(file, 'deny', 'Bash(rm -rf *)');
  C.setModel(file, 'opus');
  let d = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(d.permissions, { allow: ['Read'], deny: ['Bash(rm -rf *)'] });
  assert.deepStrictEqual(d.desconhecida, { a: 1 });
  assert.strictEqual(d.model, 'opus');
  C.removePermission(file, 'allow', 'Read');
  C.setModel(file, undefined);
  d = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(d.permissions.allow, []);
  assert.ok(!('model' in d));
});

check('settings inválido não é sobrescrito', () => {
  const file = path.join(root, 'ruim.json');
  fs.writeFileSync(file, '{ "a": ');
  assert.throws(() => C.addPermission(file, 'allow', 'Read'), /was not changed/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ "a": ');
});

check('hooks resumidos', () => {
  const file = path.join(root, 'hooks.json');
  fs.writeFileSync(file, JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'npm run lint' }] }] } }));
  assert.deepStrictEqual(C.listHooks(file), ['PostToolUse · Edit → npm run lint']);
});

check('memória: criar atualiza o índice; excluir remove a linha; verificar índice', () => {
  const mem = path.join(root, 'mem');
  const file = C.createMemory(mem, { type: 'feedback', title: 'Preferir testes reais', description: 'Rodar a suíte antes de fechar', body: 'Sempre.' });
  assert.ok(file.endsWith('preferir-testes-reais.md'));
  const list = C.listMemories(mem);
  assert.deepStrictEqual(list.map(m => [m.name, m.type, m.indexed]), [['preferir-testes-reais', 'feedback', true]]);
  assert.ok(fs.readFileSync(path.join(mem, 'MEMORY.md'), 'utf8').includes('- [Preferir testes reais](preferir-testes-reais.md) — Rodar a suíte antes de fechar'));
  fs.writeFileSync(path.join(mem, 'orfa.md'), '---\nname: orfa\ndescription: x\nmetadata:\n  type: user\n---\n');
  fs.appendFileSync(path.join(mem, 'MEMORY.md'), '- [Sumiu](sumiu.md) — link quebrado\n');
  assert.deepStrictEqual(C.checkIndex(mem), { missingInIndex: ['orfa.md'], dangling: ['sumiu.md'] });
  C.deleteMemory(mem, 'preferir-testes-reais.md');
  assert.ok(!fs.readFileSync(path.join(mem, 'MEMORY.md'), 'utf8').includes('preferir-testes-reais'));
  assert.ok(!fs.existsSync(file));
});

const L = require('../out/claude/learn');

check('aprender com o uso: bloco no CLAUDE.md entra uma vez e sai sem mexer no resto', () => {
  const orig = '# Minhas regras\n\n- responder em pt-BR\n';
  const on = L.withLearningBlock(orig);
  assert.ok(L.hasLearningBlock(on) && on.startsWith(orig.trimEnd() + '\n\n'));
  assert.strictEqual(L.withLearningBlock(on), on);
  assert.strictEqual(L.withoutLearningBlock(on), orig);
  assert.strictEqual(L.withoutLearningBlock(L.withLearningBlock('')), '');
  const middle = L.withLearningBlock('a\n') + '\n# depois\n';
  assert.strictEqual(L.withoutLearningBlock(middle), 'a\n\n# depois\n');
  assert.strictEqual(L.withoutLearningBlock(orig), orig);
});

check('aprender com o uso: pedidos citam onde gravar', () => {
  const x = { memoryDir: '/m/memory', userSkillsDir: '/c/skills', projectSkillsDir: '/r/.claude/skills' };
  for (const p of [L.learnPrompt(x), L.curateMemoryPrompt(x)]) for (const d of Object.values(x)) assert.ok(p.includes(d), d);
  assert.ok(!L.learnPrompt({ userSkillsDir: '/c/skills' }).includes('Memory folder'));
  assert.ok(L.improveSkillPrompt('/c/skills/x/SKILL.md').includes('/c/skills/x/SKILL.md'));
});

check('memória de worktree vai para o projeto com índice e nomes repetidos', () => {
  const wt = path.join(root, 'mem-wt');
  const proj = path.join(root, 'mem-proj');
  C.createMemory(wt, { type: 'project', title: 'Build lento', description: 'usar cache', body: 'x' });
  C.createMemory(wt, { type: 'user', title: 'Quem sou', description: 'dev', body: 'y' });
  C.createMemory(proj, { type: 'project', title: 'Build lento', description: 'antigo', body: 'z' });
  const moved = L.moveMemory(wt, 'build-lento.md', proj);
  assert.ok(moved.endsWith('build-lento-2.md'));
  assert.deepStrictEqual(C.checkIndex(proj), { missingInIndex: [], dangling: [] });
  assert.deepStrictEqual(C.checkIndex(wt), { missingInIndex: [], dangling: [] });
  L.moveAllMemories(wt, proj);
  assert.ok(!fs.existsSync(wt));
  assert.deepStrictEqual(C.listMemories(proj).map(m => m.fileName).sort(), ['build-lento-2.md', 'build-lento.md', 'quem-sou.md']);
  assert.ok(C.listMemories(proj).every(m => m.indexed));
});

fs.rmSync(root, { recursive: true, force: true });
if (failures) process.exit(1);
