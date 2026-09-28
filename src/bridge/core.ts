/**
 * Ponte Claude Code ↔ AgentYard, sem depender da API do VS Code (testada em test/bridge.test.js).
 *
 * Como funciona:
 * - cada janela do VS Code com a extensão abre um servidor HTTP em 127.0.0.1 (porta aleatória, token)
 *   e se anuncia em `<home>/bridges/<pid>.json` com as worktrees do repositório aberto;
 * - o servidor MCP (`agentyard-mcp.js`, stdio) e o hook (`agentyard-hook.js`) ficam em `<home>/bin`,
 *   acham a janela dona do cwd pelo prefixo de caminho mais longo e falam com ela por HTTP;
 * - home = AGENTYARD_HOME ou ~/.agentyard.
 *
 * Os Claude Code abertos pela extensão recebem os dois na linha de comando (`--settings` e
 * `--mcp-config`), rodando com o próprio executável do VS Code como node (ELECTRON_RUN_AS_NODE): não
 * precisa de Node.js instalado. Para sessões abertas fora da extensão, dá para instalar no projeto
 * (`.mcp.json` e `.claude/settings.json`, versionados): lá o comando é `node -e` com require relativo
 * ao home do usuário, sem caminho da máquina, e não faz nada quando a extensão não está instalada.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

export const SERVER_NAME = 'agentyard';
export const MCP_SCRIPT = 'agentyard-mcp.js';
export const HOOK_SCRIPT = 'agentyard-hook.js';
/** Marca que identifica os hooks instalados pela extensão. */
export const HOOK_MARK = HOOK_SCRIPT;

export function bridgeHome(): string {
  return process.env.AGENTYARD_HOME || path.join(os.homedir(), '.agentyard');
}

// ---------------------------------------------------------------- descoberta

export interface BridgeInfo {
  pid: number;
  port: number;
  token: string;
  /** Worktrees do repositório aberto na janela. */
  roots: string[];
  repo?: string;
  version?: string;
  started: number;
}

const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

/** `child` é `parent` ou está dentro dele (sem diferenciar maiúsculas, / ou \). */
export function isInside(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + path.sep) || c.startsWith(p + '/');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function writeBridgeInfo(info: BridgeInfo, home = bridgeHome()): string {
  const dir = path.join(home, 'bridges');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${info.pid}.json`);
  fs.writeFileSync(file, JSON.stringify(info, null, 2));
  return file;
}

export function removeBridgeInfo(pid: number, home = bridgeHome()) {
  fs.rmSync(path.join(home, 'bridges', `${pid}.json`), { force: true });
}

/** Janelas anunciadas e vivas; apaga os anúncios de processos que já morreram. */
export function listBridges(home = bridgeHome(), isAlive: (pid: number) => boolean = alive): BridgeInfo[] {
  const dir = path.join(home, 'bridges');
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter(n => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: BridgeInfo[] = [];
  for (const n of names) {
    const file = path.join(dir, n);
    try {
      const info = JSON.parse(fs.readFileSync(file, 'utf8')) as BridgeInfo;
      if (!info.port || !info.token) continue;
      if (!isAlive(info.pid)) {
        fs.rmSync(file, { force: true });
        continue;
      }
      out.push(info);
    } catch {
      /* anúncio sendo escrito ou corrompido: ignora */
    }
  }
  return out;
}

/** Janela cujo repositório contém `cwd` (a worktree de caminho mais longo vence). */
export function pickBridge(bridges: BridgeInfo[], cwd: string): BridgeInfo | undefined {
  let best: { b: BridgeInfo; len: number } | undefined;
  for (const b of bridges) {
    for (const r of b.roots) {
      if (isInside(cwd, r) && (!best || r.length > best.len || (r.length === best.len && b.started > best.b.started))) best = { b, len: r.length };
    }
  }
  return best?.b;
}

export function findBridge(cwd: string, home = bridgeHome()): BridgeInfo | undefined {
  return pickBridge(listBridges(home), cwd);
}

/** POST /<route> na janela; devolve o JSON da resposta. */
export function callBridge(info: BridgeInfo, route: 'tool' | 'hook' | 'ping', body: unknown, timeoutMs = 60_000): Promise<any> {
  const data = Buffer.from(JSON.stringify(body ?? {}));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: info.port,
        path: `/${route}`,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': data.length, authorization: `Bearer ${info.token}` },
        timeout: timeoutMs,
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: any;
          try {
            json = text ? JSON.parse(text) : {};
          } catch {
            return reject(new Error(`Resposta inválida da extensão (${res.statusCode}).`));
          }
          if ((res.statusCode ?? 500) >= 400) return reject(new Error(json?.error ?? `HTTP ${res.statusCode}`));
          resolve(json);
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('A extensão não respondeu a tempo.')));
    req.on('error', reject);
    req.end(data);
  });
}

// ---------------------------------------------------------------- ferramentas (MCP)

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  /** Só leitura: pode entrar na lista de permitidas sem risco. */
  readOnly?: boolean;
}

const wtArg = { type: 'string', description: 'Branch ou caminho da worktree. Vazio = a worktree onde o Claude está.' };

export const TOOLS: ToolDef[] = [
  {
    name: 'status',
    description:
      'Situação da worktree atual no AgentYard: branch, base, commits à frente/atrás da base, alterações não commitadas, PR/MR, fila de tarefas, outros agentes abertos e arquivos que outras worktrees também estão mexendo.',
    inputSchema: { type: 'object', properties: { worktree: wtArg } },
    readOnly: true,
  },
  {
    name: 'list_worktrees',
    description: 'Lista as worktrees do repositório (branch, caminho, à frente/atrás da base, alterações, agentes abertos, pronta para revisar).',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  },
  {
    name: 'overlaps',
    description: 'Arquivos que esta worktree tem em comum com outras worktrees ativas (risco de conflito no merge). Use antes de mexer em arquivos compartilhados.',
    inputSchema: { type: 'object', properties: { worktree: wtArg } },
    readOnly: true,
  },
  {
    name: 'list_tasks',
    description: 'Fila de tarefas do agente numa worktree (aguardando, rodando, feitas).',
    inputSchema: { type: 'object', properties: { worktree: wtArg } },
    readOnly: true,
  },
  {
    name: 'queue_task',
    description: 'Põe uma tarefa na fila do agente de uma worktree. Se nada estiver rodando lá, o AgentYard já abre um agente com ela.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'O que o agente deve fazer.' }, worktree: wtArg }, required: ['text'] },
  },
  {
    name: 'create_worktree',
    description:
      'Cria uma worktree nova (branch nova a partir da base ou de `from`). Com `task`, abre um agente nela já com essa tarefa — útil para delegar trabalho paralelo.',
    inputSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Nome da branch nova, ex.: ai/ajustar-login' },
        from: { type: 'string', description: 'Ponto de partida (branch/commit). Vazio = base do repositório.' },
        task: { type: 'string', description: 'Tarefa para o agente que será aberto na worktree nova.' },
      },
      required: ['branch'],
    },
  },
  {
    name: 'mark_ready',
    description:
      'Avisa o AgentYard que o trabalho desta worktree terminou e está pronto para revisar (mostra a notificação com Revisar / Analisar merge / Publicar PR e avança a fila). Faça commit antes.',
    inputSchema: { type: 'object', properties: { summary: { type: 'string', description: 'Resumo curto do que foi feito.' } } },
  },
  {
    name: 'notify',
    description: 'Mostra uma notificação no VS Code do usuário (ex.: precisa de uma decisão, algo bloqueou).',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' }, level: { type: 'string', enum: ['info', 'warning', 'error'] } },
      required: ['message'],
    },
  },
  {
    name: 'pr_feedback',
    description:
      'Comentários de revisão ainda não resolvidos no PR/MR desta branch (arquivo, linha, autor, texto). Use para corrigir o que os revisores pediram.',
    inputSchema: { type: 'object', properties: { worktree: wtArg } },
    readOnly: true,
  },
  {
    name: 'ci_status',
    description: 'Último pipeline/CI desta branch; com falha, traz os jobs que falharam e o fim do log.',
    inputSchema: { type: 'object', properties: { worktree: wtArg } },
    readOnly: true,
  },
  {
    name: 'review_comments',
    description: 'Comentários que o usuário deixou nas linhas do código desta worktree (revisão local no VS Code): arquivo, linha, o código e o que mudar.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  },
  {
    name: 'post_note',
    description:
      'Posts a note on the AgentYard board for the other agents working on this repository (they get it with their next prompt). Use it when you change something others depend on: an interface, a schema, a shared file, a decision.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'The note: what changed and what the others should do about it.' } }, required: ['text'] },
  },
  {
    name: 'read_notes',
    description: 'Notes on the AgentYard board from the other agents and from the user.',
    inputSchema: { type: 'object', properties: { all: { type: 'boolean', description: 'Include your own notes.' } } },
    readOnly: true,
  },
  {
    name: 'claim_files',
    description:
      'Reserves files or folders (globs allowed, relative to the worktree root) before a large change, so other agents are asked before editing them. Released when you finish (mark ready), expire, or with release_files.',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: 'e.g. ["src/auth/**", "package.json"]' },
        note: { type: 'string', description: 'Why (shown to the others).' },
        hours: { type: 'number', description: 'How long (default 4, max 24).' },
      },
      required: ['files'],
    },
  },
  {
    name: 'release_files',
    description: 'Releases your file reservations (all, or only the given patterns).',
    inputSchema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } } },
  },
  {
    name: 'list_claims',
    description: 'Files and folders reserved by the agents of this repository.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  },
  {
    name: 'auto_review',
    description: "Problems found by AgentYard's automatic review of this branch (another Claude reviews the diff against the base when you finish). Fix the real ones, commit and finish.",
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  },
  {
    name: 'turn_diff',
    description: 'O que mudou na worktree no último turno do agente (ou num turno anterior), como patch, pelos checkpoints do AgentYard.',
    inputSchema: { type: 'object', properties: { turn: { type: 'number', description: 'Número do turno (1 = o primeiro). Vazio = o último.' } } },
    readOnly: true,
  },
];

// ---------------------------------------------------------------- instalação nos arquivos do Claude

/** Código que o node roda: carrega o script do home do usuário; sem a extensão, não faz nada. */
function loader(script: string) {
  return `try{require(require('path').join(process.env.AGENTYARD_HOME||require('path').join(require('os').homedir(),'.agentyard'),'bin','${script}'))}catch(e){if(e&&e.code!=='MODULE_NOT_FOUND')throw e}`;
}

export function mcpServerEntry() {
  return { command: 'node', args: ['-e', loader(MCP_SCRIPT)] };
}

export function hookCommand() {
  return `node -e "${loader(HOOK_SCRIPT)}"`;
}

/** Ferramentas que o hook PreToolUse confere (guarda da worktree e plano do modo plan). */
export const GUARDED_TOOLS = 'Edit|MultiEdit|Write|NotebookEdit|Bash|ExitPlanMode';

/** Eventos do Claude Code que a ponte atende (matcher vazio = todos) e o tempo máximo de cada hook. */
export const HOOK_EVENTS: { event: string; matcher?: string; timeout: number }[] = [
  { event: 'SessionStart', timeout: 20 },
  { event: 'UserPromptSubmit', timeout: 20 },
  { event: 'PreToolUse', matcher: GUARDED_TOOLS, timeout: 20 },
  // espera você responder no VS Code; sem resposta, o Claude mostra o pedido no terminal
  { event: 'PermissionRequest', timeout: 600 },
  // o portão do Stop roda as checagens do projeto: pode demorar (src/autopilot/stopGate.ts)
  { event: 'Stop', timeout: 1800 },
];

/** Quanto o hook espera a janela responder, por evento (um pouco menos que o timeout do Claude). */
export function hookWaitMs(event: string): number {
  return ((HOOK_EVENTS.find(e => e.event === event)?.timeout ?? 20) - 2) * 1000;
}

const slash = (p: string) => p.replace(/\\/g, '/');

/**
 * Hook dos Claude abertos pela extensão: roda o script com o executável do VS Code como node, no
 * bash do Claude (no Windows, o Git Bash). `--launched` distingue do hook instalado no projeto.
 */
export function launchHookCommand(nodeExe: string, home = bridgeHome()): string {
  return `ELECTRON_RUN_AS_NODE=1 "${slash(nodeExe)}" "${slash(path.join(home, 'bin', HOOK_SCRIPT))}" --launched`;
}

/** Grupos de hooks da ponte para o `--settings` dos Claude abertos pela extensão. */
export function launchHooks(nodeExe: string, home = bridgeHome()): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const { event, matcher, timeout } of HOOK_EVENTS) {
    out[event] = [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: launchHookCommand(nodeExe, home), timeout }] }];
  }
  return out;
}

/** Conteúdo do `--mcp-config` dos Claude abertos pela extensão. */
export function launchMcpConfig(nodeExe: string, home = bridgeHome()) {
  return {
    mcpServers: {
      [SERVER_NAME]: { type: 'stdio', command: nodeExe, args: [path.join(home, 'bin', MCP_SCRIPT)], env: { ELECTRON_RUN_AS_NODE: '1' } },
    },
  };
}

/** Resposta da janela a um hook: o que o script escreve no stdout/stderr e com que código sai. */
export interface HookReply {
  stdout?: string;
  stderr?: string;
  exit?: number;
}

function readJson(file: string): { data: any; exists: boolean } {
  if (!fs.existsSync(file)) return { data: {}, exists: false };
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (!text.trim()) return { data: {}, exists: true };
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file} não é um objeto JSON.`);
  return { data, exists: true };
}

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

const isOurHook = (h: any) => typeof h?.command === 'string' && h.command.includes(HOOK_MARK);

export function mcpFile(projectDir: string) {
  return path.join(projectDir, '.mcp.json');
}

export function settingsFile(projectDir: string) {
  return path.join(projectDir, '.claude', 'settings.json');
}

export function installMcp(projectDir: string) {
  const file = mcpFile(projectDir);
  const { data } = readJson(file);
  data.mcpServers = data.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers : {};
  data.mcpServers[SERVER_NAME] = mcpServerEntry();
  writeJson(file, data);
}

export function uninstallMcp(projectDir: string) {
  const file = mcpFile(projectDir);
  const { data, exists } = readJson(file);
  if (!exists || !data.mcpServers?.[SERVER_NAME]) return;
  delete data.mcpServers[SERVER_NAME];
  writeJson(file, data);
}

/**
 * Hooks e permissões da extensão em `.claude/settings.json`, sem mexer no resto: tira os que a
 * extensão tinha posto e põe de novo o que foi pedido (`allowReadOnly` libera as ferramentas de leitura).
 */
export function configureSettings(projectDir: string, opts: { hooks: boolean; allowReadOnly: boolean }) {
  const file = settingsFile(projectDir);
  const { data, exists } = readJson(file);
  if (!exists && !opts.hooks && !opts.allowReadOnly) return;
  removeOurs(data);
  if (opts.hooks) {
    data.hooks = data.hooks && typeof data.hooks === 'object' ? data.hooks : {};
    for (const { event, matcher, timeout } of HOOK_EVENTS) {
      const groups: any[] = Array.isArray(data.hooks[event]) ? data.hooks[event] : [];
      groups.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: hookCommand(), timeout }] });
      data.hooks[event] = groups;
    }
  }
  if (opts.allowReadOnly) {
    data.permissions = data.permissions && typeof data.permissions === 'object' ? data.permissions : {};
    const allow: string[] = Array.isArray(data.permissions.allow) ? data.permissions.allow : [];
    allow.push(...readOnlyRules());
    data.permissions.allow = allow;
  }
  writeJson(file, data);
}

const readOnlyRules = () => TOOLS.filter(x => x.readOnly).map(t => `mcp__${SERVER_NAME}__${t.name}`);

function removeOurs(data: any) {
  if (data.hooks && typeof data.hooks === 'object') {
    for (const [event, groups] of Object.entries<any>(data.hooks)) {
      if (!Array.isArray(groups)) continue;
      const kept = groups
        .map(g => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h: any) => !isOurHook(h)) } : g))
        .filter(g => !Array.isArray(g?.hooks) || g.hooks.length);
      if (kept.length) data.hooks[event] = kept;
      else delete data.hooks[event];
    }
    if (!Object.keys(data.hooks).length) delete data.hooks;
  }
  const allow = data.permissions?.allow;
  if (Array.isArray(allow)) {
    const ours = new Set(readOnlyRules());
    data.permissions.allow = allow.filter((r: unknown) => typeof r !== 'string' || !ours.has(r));
    if (!data.permissions.allow.length) delete data.permissions.allow;
    if (!Object.keys(data.permissions).length) delete data.permissions;
  }
}

export interface IntegrationStatus {
  mcp: boolean;
  /** Ferramentas de leitura liberadas em permissions.allow. */
  allowReadOnly: boolean;
  /** Eventos com o hook da extensão. */
  hooks: string[];
  /** Algum dos arquivos existe mas não é JSON válido. */
  error?: string;
}

export function integrationStatus(projectDir: string): IntegrationStatus {
  try {
    const mcp = !!readJson(mcpFile(projectDir)).data.mcpServers?.[SERVER_NAME];
    const settings = readJson(settingsFile(projectDir)).data;
    const hooks = settings.hooks ?? {};
    const allow: unknown[] = Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : [];
    const events = Object.entries<any>(hooks)
      .filter(([, groups]) => Array.isArray(groups) && groups.some(g => Array.isArray(g?.hooks) && g.hooks.some(isOurHook)))
      .map(([e]) => e);
    return { mcp, hooks: events, allowReadOnly: readOnlyRules().every(r => allow.includes(r)) };
  } catch (e) {
    return { mcp: false, hooks: [], allowReadOnly: false, error: (e as Error).message };
  }
}

/** Copia os scripts para `<home>/bin` quando mudaram (a pasta da extensão muda a cada versão). */
export function installScripts(fromDir: string, home = bridgeHome()): string[] {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const copied: string[] = [];
  for (const [src, dst] of [
    ['core.js', 'agentyard-core.js'],
    ['mcpServer.js', MCP_SCRIPT],
    ['hook.js', HOOK_SCRIPT],
  ]) {
    const from = path.join(fromDir, src);
    const to = path.join(bin, dst);
    let text = fs.readFileSync(from, 'utf8');
    text = text.replace(/require\("\.\/core"\)/g, 'require("./agentyard-core")');
    if (fs.existsSync(to) && fs.readFileSync(to, 'utf8') === text) continue;
    fs.writeFileSync(to, text);
    copied.push(to);
  }
  return copied;
}
