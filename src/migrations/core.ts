/**
 * Migrations que colidem num merge e o plano para reencadeá-las, sem depender do VS Code nem do git
 * (test/migrations.test.js). Quem chama entrega as migrations do destino e as que a branch adicionou.
 *
 * - Django (`app/migrations/0005_x.py`): renumera as da branch depois da última do destino e
 *   aponta a dependência para ela.
 * - Alembic (`…/versions/*.py`): troca o `down_revision` da primeira migration da branch pela head do destino.
 * - Numeradas (Flyway `V5__x.sql`, golang-migrate `000005_x.up.sql`, `005_x.sql` numa pasta de
 *   migrations): renumera depois da maior do destino. Timestamps (12+ dígitos) não colidem e ficam de fora.
 */

export type MigrationKind = 'django' | 'alembic' | 'numbered';

export interface MigFile {
  path: string;
  /** Conteúdo; no destino só é preciso para o Alembic. */
  content?: string;
}

export interface MigrationGroup {
  kind: MigrationKind;
  /** Pasta das migrations. */
  dir: string;
  /** 'ok': já vêm depois das do destino; 'rechain': dá para reencadear; 'manual': precisa de gente. */
  status: 'ok' | 'rechain' | 'manual';
  /** Última migration do destino (nome, revisão ou versão). */
  tip?: string;
  reason?: string;
  /** O que o reencadeamento faz, para mostrar antes. */
  changes: string[];
}

export interface RechainPlan {
  groups: MigrationGroup[];
  renames: { from: string; to: string }[];
  /** Conteúdo novo, pelo caminho final (depois dos renames). */
  writes: { path: string; content: string }[];
}

const DJANGO = /(^|\/)migrations\/(\d{4,})_(\w+)\.py$/;
const ALEMBIC = /(^|\/)versions\/[^/]+\.py$/;
const FLYWAY = /^V(\d+)__.+\.sql$/i;
const NUMBERED = /^(\d+)([_-].+\.(sql|ts|js|mjs|cjs|php|rb|go|py|cql|ya?ml|xml|json))$/i;
const MIGRATION_DIR = /migrat|flyway|changelog/i;

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

interface Classified {
  kind: MigrationKind;
  key: string;
  dir: string;
  /** Django: nome sem .py; numeradas: dígitos da versão. */
  id?: string;
  num?: number;
}

function classify(p: string, content?: string): Classified | undefined {
  const dir = dirOf(p);
  const name = baseOf(p);
  if (ALEMBIC.test(p) && content !== undefined && /^down_revision\b/m.test(content)) return { kind: 'alembic', key: `alembic:${dir}`, dir };
  const dj = DJANGO.exec(p);
  if (dj && (content === undefined || /\bMigration\b/.test(content))) return { kind: 'django', key: `django:${dir}`, dir, id: name.slice(0, -3), num: Number(dj[2]) };
  const fw = FLYWAY.exec(name);
  if (fw && fw[1].length < 12) return { kind: 'numbered', key: `numbered:${dir}:V`, dir, id: fw[1], num: Number(fw[1]) };
  const nb = NUMBERED.exec(name);
  if (nb && nb[1].length < 12 && MIGRATION_DIR.test(dir) && !dj) return { kind: 'numbered', key: `numbered:${dir}:`, dir, id: nb[1], num: Number(nb[1]) };
  return undefined;
}

/** Caminhos que podem ser migrations (para filtrar listagens do git antes de ler conteúdo). */
export function isMigrationPath(p: string): boolean {
  if (ALEMBIC.test(p)) return true;
  const c = classify(p);
  return !!c;
}

/** Arquivos em `versions/` cujo conteúdo precisa ser lido para saber se são do Alembic. */
export function needsContent(p: string): boolean {
  return ALEMBIC.test(p);
}

// ---------- Alembic ----------

const ALEMBIC_REV = /^revision\s*(?::[^=\n]+)?=\s*['"]([^'"]+)['"]/m;
const ALEMBIC_DOWN = /^(down_revision\s*(?::[^=\n]+)?=\s*)(\([^)]*\)|\[[^\]]*\]|[^\n#]+)/m;

export function alembicInfo(content: string): { revision?: string; down: string[] } {
  const revision = ALEMBIC_REV.exec(content)?.[1];
  const value = ALEMBIC_DOWN.exec(content)?.[2] ?? '';
  const down = [...value.matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]);
  return { revision, down };
}

function setAlembicDown(content: string, head: string): string {
  return content
    .replace(ALEMBIC_DOWN, (_m, lhs: string, value: string) => {
      const q = value.includes('"') ? '"' : "'";
      return `${lhs}${q}${head}${q}`;
    })
    .replace(/^(Revises:[ \t]*).*$/m, `$1${head}`);
}

function planAlembic(dir: string, target: MigFile[], added: MigFile[], out: RechainPlan): MigrationGroup {
  const g: MigrationGroup = { kind: 'alembic', dir, status: 'ok', changes: [] };
  const revs = new Map<string, string[]>();
  for (const f of target) {
    const i = alembicInfo(f.content ?? '');
    if (i.revision) revs.set(i.revision, i.down);
  }
  if (!revs.size) return g;
  const referenced = new Set([...revs.values()].flat());
  const heads = [...revs.keys()].filter(r => !referenced.has(r));
  const mine = added.map(f => ({ f, ...alembicInfo(f.content ?? '') })).filter(m => m.revision);
  const mineRevs = new Set(mine.map(m => m.revision!));
  const roots = mine.filter(m => !m.down.some(d => mineRevs.has(d)));
  g.tip = heads.join(', ');
  const stray = roots.filter(r => !(r.down.length === 1 && r.down[0] === heads[0] && heads.length === 1));
  if (!stray.length) return g;
  if (heads.length !== 1) {
    return { ...g, status: 'manual', reason: `o destino tem ${heads.length} heads em ${dir}; rode "alembic merge heads" nele antes` };
  }
  if (roots.length > 1) {
    return { ...g, status: 'manual', reason: `a branch tem ${roots.length} migrations sem ligação entre si em ${dir}; rode "alembic merge heads" nela` };
  }
  const root = roots[0];
  if (root.down.length !== 1) {
    return { ...g, status: 'manual', reason: `${baseOf(root.f.path)} ${root.down.length ? 'é um merge de revisões' : 'não tem down_revision'}; ajuste à mão` };
  }
  if (!revs.has(root.down[0])) {
    return { ...g, status: 'manual', reason: `${baseOf(root.f.path)} depende de ${root.down[0]}, que o destino não tem` };
  }
  const head = heads[0];
  out.writes.push({ path: root.f.path, content: setAlembicDown(root.f.content ?? '', head) });
  return { ...g, status: 'rechain', changes: [`${baseOf(root.f.path)}: down_revision ${root.down[0]} → ${head}`] };
}

// ---------- Django ----------

interface DjangoRename {
  label: string;
  map: Map<string, string>;
  /** Raízes da branch: dependências no app que apontam para o destino passam a apontar para `tip`. */
  roots: Set<string>;
  targetNames: Set<string>;
  tip: string;
}

const djangoTuple = (label: string, name: string) =>
  new RegExp(`(\\(\\s*['"]${esc(label)}['"]\\s*,\\s*['"])(${esc(name)})(['"]\\s*\\))`, 'g');

function djangoDeps(content: string, names: Set<string>): { label: string; name: string }[] {
  const out: { label: string; name: string }[] = [];
  for (const m of content.matchAll(/\(\s*['"]([\w.]+)['"]\s*,\s*['"](\w+)['"]\s*\)/g)) if (names.has(m[2])) out.push({ label: m[1], name: m[2] });
  return out;
}

function planDjango(dir: string, target: Classified[], added: { f: MigFile; c: Classified }[], out: DjangoRename[]): MigrationGroup {
  const g: MigrationGroup = { kind: 'django', dir, status: 'ok', changes: [] };
  if (!target.length) return g;
  const max = Math.max(...target.map(t => t.num!));
  const tips = target.filter(t => t.num === max).map(t => t.id!);
  g.tip = tips.join(', ');
  const targetNames = new Set(target.map(t => t.id!));
  const mineNames = new Set(added.map(a => a.c.id!));
  const all = new Set([...targetNames, ...mineNames]);
  // O label do app vem das dependências (pode ser diferente do nome da pasta).
  const label = added.flatMap(a => djangoDeps(a.f.content ?? '', all))[0]?.label ?? baseOf(dirOf(dir));
  const sameApp = (a: { f: MigFile }) => djangoDeps(a.f.content ?? '', all).filter(d => d.label === label);
  const roots = added.filter(a => !sameApp(a).some(d => mineNames.has(d.name)));
  const needs = added.some(a => a.c.num! <= max) || roots.some(r => sameApp(r).some(d => d.name !== tips[0]));
  if (!needs) return g;
  if (tips.length > 1) {
    return { ...g, status: 'manual', reason: `o destino tem ${tips.length} migrations ${String(max).padStart(4, '0')} em ${dir}; rode "makemigrations --merge" nele antes` };
  }
  const nums = [...new Set(added.map(a => a.c.num!))].sort((a, b) => a - b);
  const map = new Map<string, string>();
  for (const a of added) {
    const digits = /^\d+/.exec(a.c.id!)![0];
    const n = max + 1 + nums.indexOf(a.c.num!);
    map.set(a.c.id!, String(n).padStart(Math.max(4, digits.length), '0') + a.c.id!.slice(digits.length));
  }
  out.push({ label, map, roots: new Set(roots.map(r => r.f.path)), targetNames, tip: tips[0] });
  const changes = [...map].filter(([a, b]) => a !== b).map(([a, b]) => `${a}.py → ${b}.py`);
  for (const r of roots) {
    const old = sameApp(r).filter(d => targetNames.has(d.name) && d.name !== tips[0]).map(d => d.name);
    if (old.length) changes.push(`${map.get(baseOf(r.f.path).slice(0, -3))}: depende de ${tips[0]} (era ${old.join(', ')})`);
  }
  return { ...g, status: 'rechain', changes };
}

// ---------- numeradas ----------

function planNumbered(dir: string, target: Classified[], added: { f: MigFile; c: Classified }[], out: RechainPlan): MigrationGroup {
  const g: MigrationGroup = { kind: 'numbered', dir, status: 'ok', changes: [] };
  if (!target.length) return g;
  const max = Math.max(...target.map(t => t.num!));
  g.tip = target.find(t => t.num === max)!.id;
  const nums = [...new Set(added.map(a => a.c.num!))].sort((a, b) => a - b);
  if (nums[0] > max) return g;
  for (const a of added) {
    const name = baseOf(a.f.path);
    const id = a.c.id!;
    const n = String(max + 1 + nums.indexOf(a.c.num!)).padStart(id.length, '0');
    const i = name.indexOf(id);
    const to = `${dir ? dir + '/' : ''}${name.slice(0, i)}${n}${name.slice(i + id.length)}`;
    out.renames.push({ from: a.f.path, to });
    g.changes.push(`${name} → ${baseOf(to)}`);
  }
  return { ...g, status: 'rechain' };
}

// ---------- plano ----------

/**
 * `target`: migrations do destino (as de `versions/` com conteúdo). `added`: as que a branch
 * adicionou desde o ponto em comum, com conteúdo, e que o destino ainda não tem.
 */
export function planRechain(target: MigFile[], added: MigFile[]): RechainPlan {
  const plan: RechainPlan = { groups: [], renames: [], writes: [] };
  const byKey = new Map<string, { t: { f: MigFile; c: Classified }[]; a: { f: MigFile; c: Classified }[] }>();
  const put = (f: MigFile, side: 't' | 'a') => {
    const c = classify(f.path, f.content);
    if (!c) return;
    if (!byKey.has(c.key)) byKey.set(c.key, { t: [], a: [] });
    byKey.get(c.key)![side].push({ f, c });
  };
  target.forEach(f => put(f, 't'));
  added.forEach(f => put(f, 'a'));

  const django: DjangoRename[] = [];
  for (const [, { t, a }] of [...byKey].sort(([x], [y]) => x.localeCompare(y))) {
    if (!a.length) continue;
    const { kind, dir } = a[0].c;
    const group =
      kind === 'alembic'
        ? planAlembic(dir, t.map(x => x.f), a.map(x => x.f), plan)
        : kind === 'django'
          ? planDjango(dir, t.map(x => x.c), a, django)
          : planNumbered(dir, t.map(x => x.c), a, plan);
    plan.groups.push(group);
  }

  // Django: renomeia e corrige as referências em todas as migrations Django da branch (outros apps
  // podem depender das renomeadas).
  if (django.length) {
    const files = added.filter(f => classify(f.path, f.content)?.kind === 'django');
    for (const f of files) {
      let content = f.content ?? '';
      for (const r of django) {
        for (const [from, to] of r.map) if (from !== to) content = content.replace(djangoTuple(r.label, from), `$1${to}$3`);
        if (r.roots.has(f.path)) {
          for (const old of r.targetNames) if (old !== r.tip) content = content.replace(djangoTuple(r.label, old), `$1${r.tip}$3`);
        }
      }
      const own = django.find(r => r.map.has(baseOf(f.path).slice(0, -3)));
      const newName = own?.map.get(baseOf(f.path).slice(0, -3));
      const to = newName ? `${dirOf(f.path)}/${newName}.py` : f.path;
      if (to !== f.path) plan.renames.push({ from: f.path, to });
      if (content !== (f.content ?? '')) plan.writes.push({ path: to, content });
    }
  }
  return plan;
}

export const needsRechain = (p: RechainPlan) => p.groups.some(g => g.status === 'rechain');
export const needsAttention = (p: RechainPlan) => p.groups.some(g => g.status !== 'ok');

const KIND_LABEL: Record<MigrationKind, string> = { django: 'Django', alembic: 'Alembic', numbered: 'numeradas' };

/** Linhas para diálogos e log. */
export function describePlan(p: RechainPlan): string[] {
  const lines: string[] = [];
  for (const g of p.groups) {
    if (g.status === 'ok') continue;
    lines.push(`${g.dir || '.'} (${KIND_LABEL[g.kind]}${g.tip ? `, última no destino: ${g.tip}` : ''})`);
    if (g.status === 'manual') lines.push(`  ⚠ ${g.reason}`);
    for (const c of g.changes) lines.push(`  ${c}`);
  }
  return lines;
}

function esc(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
