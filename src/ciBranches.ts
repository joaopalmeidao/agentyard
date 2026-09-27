import * as fs from 'fs';
import * as path from 'path';
import { t } from './i18n';

/**
 * Descobre quais branches o CI do repositório usa, lendo os arquivos de configuração (GitHub
 * Actions, GitLab CI, Bitbucket Pipelines, Azure Pipelines). Sem dependências: um leitor de YAML
 * mínimo (mapas, listas, listas inline e strings) basta para o que esses arquivos costumam ter.
 */

export interface CiBranch {
  name: string;
  /** De onde veio: "fluxo", "base", ".github/workflows/ci.yml", "configuração"... */
  sources: string[];
}

type Yaml = string | Yaml[] | { [k: string]: Yaml } | null;

function stripComment(line: string): string {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function scalar(v: string): Yaml {
  const s = v.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    return inner ? splitInline(inner).map(scalar) : [];
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const out: { [k: string]: Yaml } = {};
    for (const part of splitInline(s.slice(1, -1))) {
      const i = part.indexOf(':');
      if (i > 0) out[unquote(part.slice(0, i))] = scalar(part.slice(i + 1));
    }
    return out;
  }
  return unquote(s);
}

function unquote(str: string): string {
  const s = str.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

/** Divide "a, 'b, c', [d]" respeitando aspas e colchetes. */
function splitInline(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let q: string | null = null;
  let cur = '';
  for (const c of s) {
    if (q) {
      if (c === q) q = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Leitor de YAML mínimo: mapas por indentação, listas com "-", listas/mapas inline. */
export function parseYaml(text: string): Yaml {
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .map(l => stripComment(l).replace(/\s+$/, ''))
    .filter(l => l.trim() && !/^\s*(---|\.\.\.)\s*$/.test(l));
  let i = 0;
  const indentOf = (l: string) => l.length - l.trimStart().length;

  function block(indent: number): Yaml {
    if (i >= lines.length) return null;
    const first = lines[i].trimStart();
    if (first.startsWith('- ') || first === '-') {
      const arr: Yaml[] = [];
      while (i < lines.length && indentOf(lines[i]) === indent && /^\s*-( |$)/.test(lines[i])) {
        const rest = lines[i].trimStart().slice(1).trim();
        i++;
        if (!rest) {
          arr.push(i < lines.length && indentOf(lines[i]) > indent ? block(indentOf(lines[i])) : null);
        } else if (/^[^'"[{][^:]*:(\s|$)/.test(rest)) {
          // "- chave: valor" abre um mapa cujas outras chaves vêm alinhadas depois do "- "
          const obj: { [k: string]: Yaml } = {};
          const k = rest.slice(0, rest.indexOf(':'));
          const v = rest.slice(rest.indexOf(':') + 1);
          obj[unquote(k)] = v.trim() ? scalar(v) : i < lines.length && indentOf(lines[i]) > indent ? block(indentOf(lines[i])) : null;
          if (i < lines.length && indentOf(lines[i]) > indent) {
            const more = block(indentOf(lines[i]));
            if (more && typeof more === 'object' && !Array.isArray(more)) Object.assign(obj, more);
          }
          arr.push(obj);
        } else arr.push(scalar(rest));
      }
      return arr;
    }
    const obj: { [k: string]: Yaml } = {};
    while (i < lines.length && indentOf(lines[i]) === indent) {
      const line = lines[i].trimStart();
      if (line.startsWith('- ')) break;
      const m = /^("[^"]*"|'[^']*'|[^:]+?):(\s+|$)(.*)$/.exec(line);
      i++;
      if (!m) continue;
      const key = unquote(m[1]);
      const v = m[3];
      if (v && !/^[|>][-+]?$/.test(v.trim())) obj[key] = scalar(v);
      else if (i < lines.length && indentOf(lines[i]) > indent) {
        if (/^[|>]/.test(v.trim())) {
          const base = indentOf(lines[i]);
          const buf: string[] = [];
          while (i < lines.length && indentOf(lines[i]) >= base) buf.push(lines[i++].slice(base));
          obj[key] = buf.join('\n');
        } else obj[key] = block(indentOf(lines[i]));
      } else if (i < lines.length && indentOf(lines[i]) === indent && /^\s*- /.test(lines[i])) {
        obj[key] = block(indent); // lista na mesma coluna da chave (estilo comum no YAML)
      } else obj[key] = null;
    }
    return obj;
  }
  return lines.length ? block(indentOf(lines[0])) : null;
}

const asObj = (y: Yaml | undefined): { [k: string]: Yaml } => (y && typeof y === 'object' && !Array.isArray(y) ? y : {});
const asList = (y: Yaml | undefined): string[] =>
  Array.isArray(y) ? y.filter((x): x is string => typeof x === 'string') : typeof y === 'string' ? [y] : [];

/** GitHub Actions: on.push.branches e on.pull_request(.target).branches. */
export function fromGithubWorkflow(text: string): string[] {
  const doc = asObj(parseYaml(text));
  const on = doc.on ?? doc.true ?? doc['"on"'];
  const events = asObj(on);
  const out: string[] = [];
  for (const ev of ['push', 'pull_request', 'pull_request_target', 'merge_group']) out.push(...asList(asObj(events[ev]).branches));
  return out;
}

const GITLAB_KEYWORDS = new Set(['branches', 'tags', 'merge_requests', 'pushes', 'web', 'schedules', 'triggers', 'api', 'external', 'pipelines', 'chat', 'external_pull_requests']);

/** GitLab CI: rules com $CI_COMMIT_BRANCH/$CI_COMMIT_REF_NAME == "x", e only/except com nomes. */
export function fromGitlabCi(text: string): string[] {
  const out = new Set<string>();
  const re = /\$(?:CI_COMMIT_BRANCH|CI_COMMIT_REF_NAME|CI_MERGE_REQUEST_TARGET_BRANCH_NAME)\s*==\s*["']([^"']+)["']/g;
  for (let m; (m = re.exec(text)); ) out.add(m[1]);
  const re2 = /["']([^"']+)["']\s*==\s*\$(?:CI_COMMIT_BRANCH|CI_COMMIT_REF_NAME)/g;
  for (let m; (m = re2.exec(text)); ) out.add(m[1]);
  const doc = asObj(parseYaml(text));
  for (const job of Object.values(doc)) {
    const j = asObj(job);
    for (const key of ['only', 'except']) {
      const v = j[key];
      const names = Array.isArray(v) ? asList(v) : asList(asObj(v).refs);
      if (key === 'only') for (const n of names) if (!GITLAB_KEYWORDS.has(n) && !n.startsWith('/')) out.add(n);
    }
  }
  return [...out];
}

/** Bitbucket Pipelines: pipelines.branches.<nome>. */
export function fromBitbucket(text: string): string[] {
  return Object.keys(asObj(asObj(asObj(parseYaml(text)).pipelines).branches));
}

/** Azure Pipelines: trigger: [a, b] | trigger.branches.include; e pr.branches.include. */
export function fromAzure(text: string): string[] {
  const doc = asObj(parseYaml(text));
  const out: string[] = [];
  for (const key of ['trigger', 'pr']) {
    const v = doc[key];
    if (Array.isArray(v)) out.push(...asList(v));
    else out.push(...asList(asObj(asObj(v).branches).include));
  }
  return out.map(b => b.replace(/^refs\/heads\//, ''));
}

/** Padrão de branch do CI (glob com * e **) contra as branches existentes. */
export function expandPattern(pattern: string, existing: string[]): string[] {
  if (!/[*?[]/.test(pattern)) return [pattern];
  const re = new RegExp(
    '^' +
      pattern
        .split('**')
        .map(p => p.split('*').map(s => s.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\?/g, '.')).join('[^/]*'))
        .join('.*') +
      '$',
  );
  return existing.filter(b => re.test(b));
}

export interface DiscoverOptions {
  base?: string;
  flow?: string[];
  extras?: string[];
  /** Branches existentes (locais e remotas sem o "origin/"), para expandir padrões. */
  existing: string[];
}

/** Junta as fontes, na ordem: fluxo, base, arquivos de CI, configuração. */
export function discoverCiBranches(root: string, o: DiscoverOptions): CiBranch[] {
  const found = new Map<string, Set<string>>();
  const add = (name: string, source: string) => {
    for (const n of expandPattern(name.trim(), o.existing)) {
      if (!n || n.startsWith('!')) continue;
      if (!found.has(n)) found.set(n, new Set());
      found.get(n)!.add(source);
    }
  };
  for (const b of o.flow ?? []) add(b, t('environment flow'));
  if (o.base) add(o.base, t('base'));
  const read = (rel: string) => {
    try {
      return fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      return undefined;
    }
  };
  const list = (dir: string) => {
    try {
      return fs.readdirSync(path.join(root, dir)).filter(f => /\.ya?ml$/i.test(f));
    } catch {
      return [];
    }
  };
  for (const f of list('.github/workflows')) {
    const text = read(`.github/workflows/${f}`);
    if (text) for (const b of fromGithubWorkflow(text)) add(b, `.github/workflows/${f}`);
  }
  for (const rel of ['.gitlab-ci.yml', ...list('.gitlab').map(f => `.gitlab/${f}`)]) {
    const text = read(rel);
    if (text) for (const b of fromGitlabCi(text)) add(b, rel);
  }
  const bb = read('bitbucket-pipelines.yml');
  if (bb) for (const b of fromBitbucket(bb)) add(b, 'bitbucket-pipelines.yml');
  for (const rel of ['azure-pipelines.yml', '.azure-pipelines.yml']) {
    const text = read(rel);
    if (text) for (const b of fromAzure(text)) add(b, rel);
  }
  for (const b of o.extras ?? []) add(b, t('settings (worktreeGraph.ciBranches)'));
  return [...found].map(([name, s]) => ({ name, sources: [...s] }));
}
