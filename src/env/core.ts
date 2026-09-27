import * as fs from 'fs';
import * as path from 'path';

/**
 * Ambiente por worktree, sem depender do VS Code: portas, .env, setup e espaço em disco.
 * Testado em test/env.test.js.
 */

export interface PortsConfig {
  base: number;
  step: number;
  vars: string[];
}

/**
 * Bloco de portas estável por chave (a branch): quem já tem bloco mantém; quem não tem pega o
 * menor bloco livre (base, base+step, …). Assim recriar a mesma branch reaproveita a porta.
 */
export function allocatePort(assigned: Record<string, number>, key: string, cfg: PortsConfig): { port: number; assigned: Record<string, number> } {
  if (assigned[key] !== undefined) return { port: assigned[key], assigned };
  const used = new Set(Object.values(assigned));
  let port = cfg.base;
  for (let i = 0; used.has(port); i++) port = cfg.base + (i + 1) * cfg.step;
  return { port, assigned: { ...assigned, [key]: port } };
}

/** PORT=p, VITE_PORT=p+1, API_PORT=p+2… (uma porta por variável, dentro do bloco). */
export function portVars(port: number, vars: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  vars.forEach((v, i) => (out[v] = String(port + i)));
  return out;
}

/**
 * Troca o valor das variáveis no texto de um .env preservando o resto (comentários, ordem, aspas
 * de outras linhas, `export KEY=`). Variáveis que não existem vão para o fim.
 */
export function rewriteEnv(text: string, vars: Record<string, string>): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.length ? text.split(/\r?\n/) : [];
  const seen = new Set<string>();
  const out = lines.map(line => {
    const m = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/.exec(line);
    if (!m || !(m[2] in vars)) return line;
    seen.add(m[2]);
    return `${m[1]}${m[2]}${m[3]}${vars[m[2]]}`;
  });
  const missing = Object.keys(vars).filter(k => !seen.has(k));
  if (missing.length) {
    while (out.length && out[out.length - 1] === '') out.pop();
    if (out.length) out.push('');
    out.push('# portas desta worktree (AgentYard)');
    for (const k of missing) out.push(`${k}=${vars[k]}`);
  }
  return out.join(eol) + eol;
}

export interface SetupPlan {
  node?: { manager: 'npm' | 'pnpm' | 'yarn' | 'bun'; install: string };
  python?: { tool: 'pip' | 'poetry' | 'uv'; install: string };
}

/** O que instalar numa worktree, pelos arquivos da raiz. */
export function detectSetup(files: string[]): SetupPlan {
  const has = (f: string) => files.includes(f);
  const plan: SetupPlan = {};
  if (has('package.json')) {
    if (has('pnpm-lock.yaml')) plan.node = { manager: 'pnpm', install: 'pnpm install --frozen-lockfile' };
    else if (has('yarn.lock')) plan.node = { manager: 'yarn', install: 'yarn install --frozen-lockfile' };
    else if (has('bun.lockb') || has('bun.lock')) plan.node = { manager: 'bun', install: 'bun install' };
    else plan.node = { manager: 'npm', install: has('package-lock.json') ? 'npm ci' : 'npm install' };
  }
  if (has('uv.lock')) plan.python = { tool: 'uv', install: 'uv sync' };
  else if (has('poetry.lock')) plan.python = { tool: 'poetry', install: 'poetry install' };
  else if (has('requirements.txt'))
    plan.python = {
      tool: 'pip',
      install: process.platform === 'win32'
        ? 'python -m venv .venv; .\\.venv\\Scripts\\python -m pip install -r requirements.txt'
        : 'python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt',
    };
  else if (has('pyproject.toml'))
    plan.python = {
      tool: 'pip',
      install: process.platform === 'win32' ? 'python -m venv .venv; .\\.venv\\Scripts\\python -m pip install -e .' : 'python3 -m venv .venv && ./.venv/bin/pip install -e .',
    };
  return plan;
}

export interface SizeResult {
  bytes: number;
  /** false se o limite de tempo acabou antes de percorrer tudo (o valor é um mínimo). */
  complete: boolean;
}

/**
 * Tamanho de uma pasta sem seguir links: symlinks e junctions (node_modules compartilhado) não
 * contam. Para em `deadline` (ms de relógio) e devolve o parcial.
 */
export async function dirSize(root: string, deadline = Date.now() + 5000): Promise<SizeResult> {
  let bytes = 0;
  const stack = [root];
  let n = 0;
  while (stack.length) {
    if (Date.now() > deadline) return { bytes, complete: false };
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // junction no Windows aparece como pasta no Dirent; o lstat diz a verdade
        try {
          const st = await fs.promises.lstat(full);
          if (st.isSymbolicLink()) continue;
        } catch {
          continue;
        }
        stack.push(full);
      } else if (e.isFile()) {
        try {
          bytes += (await fs.promises.lstat(full)).size;
        } catch {
          // arquivo sumiu no meio da contagem
        }
      }
      // cede o laço de eventos de vez em quando: pastas grandes não travam a extensão
      if (++n % 500 === 0) await new Promise(r => setImmediate(r));
    }
  }
  return { bytes, complete: true };
}

/** "1,2 GB", "340 MB", "12 KB" (pt-BR). */
export function formatBytes(b: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const s = v >= 100 || i === 0 ? Math.round(v).toString() : v.toFixed(1).replace('.', ',');
  return `${s} ${units[i]}`;
}
