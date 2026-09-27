/**
 * Skills, comandos, configurações e memória do Claude Code, sem depender da API do VS Code
 * (testado em test/claudeConfig.test.js com pastas sintéticas).
 *
 * Onde fica cada coisa:
 * - usuário: `<config>/skills/<nome>/SKILL.md`, `<config>/commands/*.md`, `<config>/settings.json`,
 *   `<config>/CLAUDE.md` (config = CLAUDE_CONFIG_DIR ou ~/.claude). `skills/synced/**` é gerenciado
 *   pelo Claude (skills sincronizadas da conta) e fica só leitura.
 * - projeto: `<repo>/.claude/skills`, `<repo>/.claude/commands`, `<repo>/.claude/settings.json`,
 *   `<repo>/.claude/settings.local.json`, `<repo>/.mcp.json`, `<repo>/CLAUDE.md`, `<repo>/CLAUDE.local.md`.
 * - memória: `<config>/projects/<cwd codificado>/memory/`, com o índice MEMORY.md.
 */
import * as fs from 'fs';
import * as path from 'path';
import { t } from '../i18n';

export type Scope = 'user' | 'project';

export interface SkillEntry {
  kind: 'skill' | 'command';
  scope: Scope;
  name: string;
  description: string;
  /** SKILL.md ou o .md do comando. */
  file: string;
  /** Pasta da skill (só skills). */
  dir?: string;
  /** Skills sincronizadas da conta: gerenciadas pelo Claude, não editar. */
  readOnly: boolean;
  error?: string;
}

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface MemoryEntry {
  /** Nome do arquivo, sem pasta. */
  fileName: string;
  file: string;
  name: string;
  description: string;
  type: string;
  /** Tem linha no MEMORY.md. */
  indexed: boolean;
  error?: string;
}

export interface IndexCheck {
  /** Arquivos de memória sem linha no MEMORY.md. */
  missingInIndex: string[];
  /** Linhas do MEMORY.md apontando para arquivo que não existe. */
  dangling: string[];
}

export interface ConfigFile {
  scope: Scope;
  kind: 'settings' | 'settings-local' | 'mcp' | 'claude-md' | 'claude-local-md';
  label: string;
  file: string;
  exists: boolean;
}

// ---------------------------------------------------------------- caminhos

/**
 * Nome da pasta de um projeto em `<config>/projects`: todo caractere que não é letra, número ou
 * hífen vira hífen, sem mudar maiúsculas (C:\Users\jp-08 → C--Users-jp-08;
 * E:\a_b\.claude\x → E--a-b--claude-x).
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-');
}

/**
 * Pasta de memória de um diretório de trabalho. Procura a pasta existente sem diferenciar
 * maiúsculas (o Windows pode registrar "e:" ou "E:"); se não houver, devolve a codificada.
 */
export function memoryDirFor(claudeDir: string, cwd: string): string {
  const encoded = encodeProjectDir(cwd);
  const projects = path.join(claudeDir, 'projects');
  try {
    const hit = fs.readdirSync(projects).find(n => n.toLowerCase() === encoded.toLowerCase() && fs.existsSync(path.join(projects, n, 'memory')));
    if (hit) return path.join(projects, hit, 'memory');
  } catch {
    // sem pasta projects ainda
  }
  return path.join(projects, encoded, 'memory');
}

// ---------------------------------------------------------------- frontmatter

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
  /** false quando o arquivo não começa com "---". */
  present: boolean;
}

function unquote(v: string): string {
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try {
      return s.startsWith('"') ? JSON.parse(s) : s.slice(1, -1).replace(/''/g, "'");
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

/** YAML simples do frontmatter: chave: valor, e um nível de mapa aninhado (metadata:). */
export function parseFrontmatter(text: string): Frontmatter {
  const src = text.replace(/^\uFEFF/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { data: {}, body: src, present: false };
  const data: Record<string, unknown> = {};
  let parent: Record<string, unknown> | undefined;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const nested = /^\s+([\w.-]+):\s*(.*)$/.exec(line);
    if (nested && parent) {
      parent[nested[1]] = unquote(nested[2]);
      continue;
    }
    const top = /^([\w.-]+):\s*(.*)$/.exec(line);
    if (!top) continue;
    if (top[2] === '') {
      parent = {};
      data[top[1]] = parent;
    } else {
      parent = undefined;
      data[top[1]] = unquote(top[2]);
    }
  }
  return { data, body: src.slice(m[0].length), present: true };
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? '' : String(v));
const yamlString = (s: string) => (/^[\w .,()\-áéíóúâêôãõçÁÉÍÓÚÂÊÔÃÕÇ]*$/.test(s) && !/^\s|\s$/.test(s) ? s : JSON.stringify(s));

// ---------------------------------------------------------------- skills e comandos

function skillBase(scope: Scope, claudeDir: string, projectDir?: string): string | undefined {
  return scope === 'user' ? claudeDir : projectDir ? path.join(projectDir, '.claude') : undefined;
}

function readSkill(file: string, scope: Scope, readOnly: boolean): SkillEntry {
  const dir = path.dirname(file);
  try {
    const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    return {
      kind: 'skill',
      scope,
      name: str(fm.data.name) || path.basename(dir),
      description: str(fm.data.description),
      file,
      dir,
      readOnly,
      error: fm.present ? undefined : t('SKILL.md has no frontmatter (--- name/description ---)'),
    };
  } catch (e) {
    return { kind: 'skill', scope, name: path.basename(dir), description: '', file, dir, readOnly, error: (e as Error).message };
  }
}

/** Skills diretas (`skills/<nome>/SKILL.md`) e sincronizadas (`skills/synced/**`, só leitura). */
export function listSkills(scope: Scope, claudeDir: string, projectDir?: string): SkillEntry[] {
  const base = skillBase(scope, claudeDir, projectDir);
  if (!base) return [];
  const root = path.join(base, 'skills');
  const out: SkillEntry[] = [];
  const walk = (dir: string, depth: number, readOnly: boolean) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some(e => e.isFile() && e.name === 'SKILL.md')) {
      out.push(readSkill(path.join(dir, 'SKILL.md'), scope, readOnly));
      return;
    }
    if (depth <= 0) return;
    for (const e of entries) if (e.isDirectory()) walk(path.join(dir, e.name), depth - 1, readOnly || e.name === 'synced');
  };
  walk(root, 4, false);
  return out.sort((a, b) => Number(a.readOnly) - Number(b.readOnly) || a.name.localeCompare(b.name));
}

/** Comandos (`commands/**.md`); subpastas viram prefixo "pasta:nome", como no Claude Code. */
export function listCommands(scope: Scope, claudeDir: string, projectDir?: string): SkillEntry[] {
  const base = skillBase(scope, claudeDir, projectDir);
  if (!base) return [];
  const root = path.join(base, 'commands');
  const out: SkillEntry[] = [];
  const walk = (dir: string, prefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, `${prefix}${e.name}:`);
      else if (e.name.endsWith('.md')) {
        let description = '';
        let error: string | undefined;
        try {
          const fm = parseFrontmatter(fs.readFileSync(full, 'utf8'));
          description = str(fm.data.description) || fm.body.trim().split(/\r?\n/)[0]?.slice(0, 120) || '';
        } catch (err) {
          error = (err as Error).message;
        }
        out.push({ kind: 'command', scope, name: prefix + e.name.slice(0, -3), description, file: full, readOnly: false, error });
      }
    }
  };
  walk(root, '');
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function validSkillName(name: string): string | undefined {
  if (!name.trim()) return t('Enter a name.');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return t('Use lowercase letters, numbers and hyphens (e.g. review-pr).');
  if (name.length > 64) return t('Up to 64 characters.');
  return undefined;
}

export function createSkill(scope: Scope, claudeDir: string, projectDir: string | undefined, name: string, description: string): string {
  const err = validSkillName(name);
  if (err) throw new Error(err);
  const base = skillBase(scope, claudeDir, projectDir);
  if (!base) throw new Error(t('No active project to create the skill in the project scope.'));
  const dir = path.join(base, 'skills', name);
  if (fs.existsSync(dir)) throw new Error(t('Skill {0} already exists in {1}.', name, dir));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(
    file,
    [
      '---',
      `name: ${name}`,
      `description: ${yamlString(description || t('Describe when Claude should use this skill.'))}`,
      '---',
      '',
      `# ${name}`,
      '',
      t('## When to use'),
      '',
      '- ',
      '',
      t('## How to do it'),
      '',
      '1. ',
      '',
    ].join('\n'),
  );
  return file;
}

function copyDir(src: string, dst: string) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, e.name);
    const b = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

/** Copia a skill (pasta inteira) ou o comando para o outro escopo. Devolve o destino. */
export function copyToScope(entry: SkillEntry, target: Scope, claudeDir: string, projectDir?: string): string {
  const base = skillBase(target, claudeDir, projectDir);
  if (!base) throw new Error(t('No active project for the project scope.'));
  if (entry.kind === 'skill') {
    const dst = path.join(base, 'skills', path.basename(entry.dir!));
    if (fs.existsSync(dst)) throw new Error(t('{0} already exists.', dst));
    copyDir(entry.dir!, dst);
    return path.join(dst, 'SKILL.md');
  }
  const dst = path.join(base, 'commands', ...entry.name.split(':').slice(0, -1), path.basename(entry.file));
  if (fs.existsSync(dst)) throw new Error(t('{0} already exists.', dst));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(entry.file, dst);
  return dst;
}

/** Renomeia a pasta da skill e o `name:` do frontmatter (ou o arquivo do comando). */
export function renameEntry(entry: SkillEntry, newName: string): string {
  if (entry.readOnly) throw new Error(t('Synced skill: managed by Claude.'));
  if (entry.kind === 'skill') {
    const err = validSkillName(newName);
    if (err) throw new Error(err);
    const dst = path.join(path.dirname(entry.dir!), newName);
    if (fs.existsSync(dst)) throw new Error(t('{0} already exists.', dst));
    fs.renameSync(entry.dir!, dst);
    const file = path.join(dst, 'SKILL.md');
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text.replace(/^(---\r?\n[\s\S]*?)^name:.*$/m, `$1name: ${newName}`));
    return file;
  }
  const dst = path.join(path.dirname(entry.file), `${newName.replace(/\.md$/, '')}.md`);
  if (fs.existsSync(dst)) throw new Error(t('{0} already exists.', dst));
  fs.renameSync(entry.file, dst);
  return dst;
}

export function deleteEntry(entry: SkillEntry) {
  if (entry.readOnly) throw new Error(t('Synced skill: managed by Claude.'));
  if (entry.kind === 'skill') fs.rmSync(entry.dir!, { recursive: true, force: true });
  else fs.rmSync(entry.file, { force: true });
}

// ---------------------------------------------------------------- configurações

export function configFiles(claudeDir: string, projectDir?: string): ConfigFile[] {
  const f = (scope: Scope, kind: ConfigFile['kind'], label: string, file: string): ConfigFile => ({ scope, kind, label, file, exists: fs.existsSync(file) });
  const list = [f('user', 'settings', 'settings.json', path.join(claudeDir, 'settings.json')), f('user', 'claude-md', t('CLAUDE.md (all sessions)'), path.join(claudeDir, 'CLAUDE.md'))];
  if (projectDir) {
    list.push(
      f('project', 'settings', t('.claude/settings.json (shared)'), path.join(projectDir, '.claude', 'settings.json')),
      f('project', 'settings-local', t('.claude/settings.local.json (just you)'), path.join(projectDir, '.claude', 'settings.local.json')),
      f('project', 'mcp', t('.mcp.json (MCP servers)'), path.join(projectDir, '.mcp.json')),
      f('project', 'claude-md', t('CLAUDE.md (project instructions)'), path.join(projectDir, 'CLAUDE.md')),
      f('project', 'claude-local-md', t('CLAUDE.local.md (just you)'), path.join(projectDir, 'CLAUDE.local.md')),
    );
  }
  return list;
}

export interface SettingsRead {
  data: Record<string, any>;
  exists: boolean;
  error?: string;
}

/** Lê settings (aceita comentários // e /* *\/ e vírgula final, como o VS Code). */
export function readSettings(file: string): SettingsRead {
  if (!fs.existsSync(file)) return { data: {}, exists: false };
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  try {
    const data = raw.trim() ? JSON.parse(stripJsonComments(raw)) : {};
    if (typeof data !== 'object' || Array.isArray(data) || data === null) return { data: {}, exists: true, error: t('The file is not a JSON object.') };
    return { data, exists: true };
  } catch (e) {
    return { data: {}, exists: true, error: t('Invalid JSON: {0}', (e as Error).message) };
  }
}

export function stripJsonComments(text: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Grava settings sem perder nada: altera só o que `mutate` mexe, recusa se o arquivo atual é
 * inválido e deixa uma cópia `.bak` do anterior. Devolve o caminho do backup (se houve).
 */
export function updateSettings(file: string, mutate: (data: Record<string, any>) => void): string | undefined {
  const cur = readSettings(file);
  if (cur.error) throw new Error(t('{0} has an error and was not changed: {1}', path.basename(file), cur.error));
  const data = JSON.parse(JSON.stringify(cur.data));
  mutate(data);
  const text = JSON.stringify(data, null, 2) + '\n';
  JSON.parse(text);
  let backup: string | undefined;
  if (cur.exists) {
    backup = `${file}.bak`;
    fs.copyFileSync(file, backup);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  fs.writeFileSync(file, text);
  return backup;
}

export type PermissionList = 'allow' | 'deny' | 'ask';

export function listPermissions(file: string): Record<PermissionList, string[]> {
  const p = readSettings(file).data.permissions ?? {};
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
  return { allow: arr(p.allow), deny: arr(p.deny), ask: arr(p.ask) };
}

export function addPermission(file: string, list: PermissionList, rule: string) {
  const r = rule.trim();
  if (!r) throw new Error(t('Empty rule.'));
  return updateSettings(file, d => {
    d.permissions = d.permissions && typeof d.permissions === 'object' ? d.permissions : {};
    const cur: unknown[] = Array.isArray(d.permissions[list]) ? d.permissions[list] : [];
    if (!cur.includes(r)) cur.push(r);
    d.permissions[list] = cur;
  });
}

export function removePermission(file: string, list: PermissionList, rule: string) {
  return updateSettings(file, d => {
    const cur = d.permissions?.[list];
    if (!Array.isArray(cur)) return;
    d.permissions[list] = cur.filter((x: unknown) => x !== rule);
  });
}

/** `model` vazio remove a chave (volta ao padrão do Claude Code). */
export function setModel(file: string, model: string | undefined) {
  return updateSettings(file, d => {
    if (model) d.model = model;
    else delete d.model;
  });
}

/** Resumo dos hooks: "Evento · matcher → comando". */
export function listHooks(file: string): string[] {
  const hooks = readSettings(file).data.hooks;
  if (!hooks || typeof hooks !== 'object') return [];
  const out: string[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray((g as any)?.hooks) ? (g as any).hooks : []) {
        out.push(`${event}${(g as any).matcher ? ` · ${(g as any).matcher}` : ''} → ${h.command ?? h.type ?? JSON.stringify(h)}`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- memória

const INDEX = 'MEMORY.md';
const linkRe = /\]\(([^)]+\.md)\)/g;

function indexLinks(memDir: string): string[] {
  try {
    const text = fs.readFileSync(path.join(memDir, INDEX), 'utf8');
    return [...text.matchAll(linkRe)].map(m => decodeURIComponent(m[1]).replace(/^\.\//, ''));
  } catch {
    return [];
  }
}

export function listMemories(memDir: string): MemoryEntry[] {
  let files: string[];
  try {
    files = fs.readdirSync(memDir).filter(f => f.endsWith('.md') && f !== INDEX);
  } catch {
    return [];
  }
  const indexed = new Set(indexLinks(memDir).map(l => l.toLowerCase()));
  return files
    .map(fileName => {
      const file = path.join(memDir, fileName);
      try {
        const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
        const meta = (fm.data.metadata ?? {}) as Record<string, unknown>;
        return {
          fileName,
          file,
          name: str(fm.data.name) || fileName.slice(0, -3),
          description: str(fm.data.description),
          type: str(meta.type ?? fm.data.type) || '?',
          indexed: indexed.has(fileName.toLowerCase()),
          error: fm.present ? undefined : t('no frontmatter'),
        };
      } catch (e) {
        return { fileName, file, name: fileName.slice(0, -3), description: '', type: '?', indexed: indexed.has(fileName.toLowerCase()), error: (e as Error).message };
      }
    })
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

export function checkIndex(memDir: string): IndexCheck {
  const files = new Set(listMemories(memDir).map(m => m.fileName.toLowerCase()));
  const links = indexLinks(memDir);
  return {
    missingInIndex: listMemories(memDir).filter(m => !m.indexed).map(m => m.fileName),
    dangling: links.filter(l => !files.has(l.toLowerCase())),
  };
}

export function slugify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export interface NewMemory {
  type: MemoryType;
  /** Título legível; vira o slug do arquivo e o texto do link no índice. */
  title: string;
  description: string;
  body: string;
}

/** Cria o arquivo de memória (frontmatter no formato do Claude Code) e a linha no MEMORY.md. */
export function createMemory(memDir: string, m: NewMemory): string {
  const name = slugify(m.title);
  if (!name) throw new Error(t('Enter a title.'));
  fs.mkdirSync(memDir, { recursive: true });
  const fileName = `${name}.md`;
  const file = path.join(memDir, fileName);
  if (fs.existsSync(file)) throw new Error(t('{0} already exists.', fileName));
  fs.writeFileSync(
    file,
    ['---', `name: ${name}`, `description: ${JSON.stringify(m.description)}`, 'metadata:', `  type: ${m.type}`, '---', '', m.body.trim(), ''].join('\n'),
  );
  addIndexLine(memDir, fileName, m.title, m.description);
  return file;
}

export function addIndexLine(memDir: string, fileName: string, title: string, hook: string) {
  const index = path.join(memDir, INDEX);
  const cur = fs.existsSync(index) ? fs.readFileSync(index, 'utf8') : '';
  const line = `- [${title}](${fileName}) — ${hook.replace(/\r?\n/g, ' ').trim()}`;
  fs.writeFileSync(index, cur && !cur.endsWith('\n') ? `${cur}\n${line}\n` : `${cur}${line}\n`);
}

/** Apaga a memória e as linhas do índice que apontam para ela. */
export function deleteMemory(memDir: string, fileName: string) {
  fs.rmSync(path.join(memDir, fileName), { force: true });
  removeIndexLines(memDir, fileName);
}

export function removeIndexLines(memDir: string, fileName: string) {
  const index = path.join(memDir, INDEX);
  if (!fs.existsSync(index)) return;
  const lines = fs.readFileSync(index, 'utf8').split(/\r?\n/);
  const keep = lines.filter(l => ![...l.matchAll(linkRe)].some(m => decodeURIComponent(m[1]).replace(/^\.\//, '').toLowerCase() === fileName.toLowerCase()));
  fs.writeFileSync(index, keep.join('\n'));
}
