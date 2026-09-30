import * as fs from 'fs';
import * as path from 'path';
import { STATUS_SUFFIX, statusLineSetting, StatusLineLabels, StatusLineMode, writeStatusLineFiles } from './statusLine';

/**
 * Estado dos Claude Code abertos pela extensão, contado pelos hooks do próprio Claude.
 *
 * Cada terminal recebe `claude --settings <arquivo>` com hooks que acrescentam o JSON do evento
 * (vem no stdin) a `<pasta>/<WTGRAPH_AGENT_ID>.jsonl`. A extensão acompanha esses arquivos. Nada
 * vai para o settings.json do usuário, e um Claude aberto fora da extensão não é afetado.
 */

export type AgentState = 'starting' | 'working' | 'waiting' | 'idle' | 'ended';

export interface HookEvent {
  hook_event_name: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  message?: string;
  notification_type?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

/**
 * Eventos acompanhados. PostToolUse marca a volta ao trabalho depois de uma permissão;
 * PermissionRequest chega na hora do pedido (a Notification só depois de uns segundos).
 */
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'SessionEnd'] as const;
const TOOL_EVENTS = new Set(['PostToolUse']);

/** Comando de cada hook: roda no shell do Claude (bash; no Windows, o Git Bash que ele exige). */
export function hookCommand(eventsDir: string): string {
  const dir = eventsDir.replace(/\\/g, '/');
  return `{ cat; echo; } >> "${dir}/\${WTGRAPH_AGENT_ID:-unknown}.jsonl"`;
}

/** Hooks de estado; `extra` acrescenta grupos por evento (os da ponte com o AgentYard, src/bridge). */
export function hookSettings(eventsDir: string, extra: Record<string, unknown[]> = {}, statusLine = false) {
  const hook = { type: 'command', command: hookCommand(eventsDir), timeout: 5 };
  const hooks: Record<string, unknown[]> = {};
  for (const e of HOOK_EVENTS) hooks[e] = [TOOL_EVENTS.has(e) ? { matcher: '*', hooks: [hook] } : { hooks: [hook] }];
  for (const [e, groups] of Object.entries(extra)) hooks[e] = [...(hooks[e] ?? []), ...groups];
  return statusLine ? { hooks, statusLine: statusLineSetting(eventsDir) } : { hooks };
}

/** Statusline que acompanha o settings (src/claude/statusLine.ts); sem ela, `statusLine` fica de fora. */
export interface StatusLineOptions {
  mode: StatusLineMode;
  userCommand?: string;
  labels: StatusLineLabels;
}

function writeIfChanged(file: string, text: string) {
  let old = '';
  try {
    old = fs.readFileSync(file, 'utf8');
  } catch {
    // ainda não existe
  }
  if (old !== text) fs.writeFileSync(file, text, 'utf8');
}

/**
 * Grava (só se mudou) o arquivo passado com --settings e o script da statusline;
 * devolve o caminho do settings.
 */
export function writeHookSettings(eventsDir: string, extra: Record<string, unknown[]> = {}, name = 'hooks.settings.json', statusLine?: StatusLineOptions): string {
  fs.mkdirSync(eventsDir, { recursive: true });
  const file = path.join(eventsDir, name);
  const withStatus = !!statusLine && statusLine.mode !== 'off';
  writeIfChanged(file, JSON.stringify(hookSettings(eventsDir, extra, withStatus), null, 2));
  if (statusLine && withStatus) writeStatusLineFiles(eventsDir, statusLine.mode, statusLine.userCommand, statusLine.labels, writeIfChanged);
  return file;
}

/** O comando abre o Claude Code? (primeiro token é `claude`, `claude.exe` ou `claude.cmd`). */
export function isClaudeCommand(cmd: string): boolean {
  const first = cmd.trim().split(/\s+/)[0] ?? '';
  return /^claude(\.exe|\.cmd)?$/i.test(path.basename(first.replace(/^["']|["']$/g, '')));
}

/**
 * Põe `--settings "<arquivo>"` (e `--mcp-config="<arquivo>"`, se houver) logo depois do `claude`;
 * outros comandos ficam como estão.
 */
export function instrumentCommand(cmd: string, settingsFile: string, mcpConfig?: string): string {
  if (!isClaudeCommand(cmd)) return cmd;
  const flags: string[] = [];
  if (!/(^|\s)--settings(\s|=|$)/.test(cmd)) flags.push(`--settings "${settingsFile}"`);
  // Com `=`: `--mcp-config` é variádico e, separado por espaço, engoliria o prompt que vem depois como outro arquivo.
  if (mcpConfig && !/(^|\s)--mcp-config(\s|=|$)/.test(cmd)) flags.push(`--mcp-config="${mcpConfig}"`);
  if (!flags.length) return cmd;
  const m = cmd.match(/^(\s*\S+)([\s\S]*)$/);
  return m ? `${m[1]} ${flags.join(' ')}${m[2]}` : cmd;
}

/** Põe `args` logo depois do binário do `claude` (ex.: `--model opus`); outros comandos ficam como estão. */
export function insertArgs(cmd: string, args: string): string {
  if (!args.trim() || !isClaudeCommand(cmd)) return cmd;
  const m = cmd.match(/^(\s*\S+)([\s\S]*)$/);
  return m ? `${m[1]} ${args.trim()}${m[2]}` : cmd;
}

/**
 * Tira de `args` o que escolhe o modo de permissão (`--permission-mode x`, `--dangerously-skip-permissions`),
 * para um modo pedido por quem abre valer sobre o de `claude.extraArgs`.
 */
export function withoutPermissionArgs(args: string): string {
  return args
    .replace(/(^|\s)--permission-mode(?:=|\s+)\S+/g, ' ')
    .replace(/(^|\s)--dangerously-skip-permissions(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Argumentos do Claude escolhidos em "Abrir Claude com opções…". */
export function claudeArgs(o: { model?: string; permissionMode?: string; systemPrompt?: string }, quote: (s: string) => string): string {
  return [
    o.model ? `--model ${o.model}` : '',
    o.permissionMode && o.permissionMode !== 'default' ? `--permission-mode ${o.permissionMode}` : '',
    o.systemPrompt?.trim() ? `--append-system-prompt ${quote(o.systemPrompt.trim())}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Põe `--ide` logo depois do `claude` (conecta ao VS Code ao abrir); outros comandos ficam como estão. */
export function withIdeFlag(cmd: string): string {
  if (!isClaudeCommand(cmd) || /(^|\s)--ide(\s|$)/.test(cmd)) return cmd;
  const m = cmd.match(/^(\s*\S+)([\s\S]*)$/);
  return m ? `${m[1]} --ide${m[2]}` : cmd;
}

/**
 * Lê eventos de um pedaço do arquivo. Linhas que não fecham um JSON ficam em `rest` (o hook pode
 * estar no meio da escrita) e voltam na próxima leitura.
 */
export function parseEvents(text: string): { events: HookEvent[]; rest: string } {
  const events: HookEvent[] = [];
  let buf = '';
  const lines = text.split(/\r?\n/);
  const last = lines.pop() ?? '';
  for (const line of lines) {
    buf += line;
    if (!buf.trim()) {
      buf = '';
      continue;
    }
    try {
      const e = JSON.parse(buf);
      if (e && typeof e.hook_event_name === 'string') events.push(e);
      buf = '';
    } catch {
      buf += '\n';
    }
  }
  return { events, rest: buf + last };
}

/** Próximo estado a partir de um evento. */
export function nextState(cur: AgentState, e: HookEvent): AgentState {
  switch (e.hook_event_name) {
    case 'SessionStart':
      return 'idle';
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return 'working';
    case 'PermissionRequest':
      return 'waiting';
    case 'Notification':
      // "esperando sua mensagem" depois de um tempo parado não é pedido de permissão
      return e.notification_type === 'idle_prompt' || /waiting for your input/i.test(e.message ?? '') ? cur : 'waiting';
    case 'Stop':
      return 'idle';
    case 'SessionEnd':
      return 'ended';
  }
  return cur;
}

/** Leitura incremental de um arquivo de eventos. */
export class EventTail {
  private offset = 0;
  private rest = '';
  constructor(readonly file: string) {}

  read(): HookEvent[] {
    let fd: number | undefined;
    try {
      const size = fs.statSync(this.file).size;
      if (size < this.offset) {
        this.offset = 0;
        this.rest = '';
      }
      if (size === this.offset) return [];
      fd = fs.openSync(this.file, 'r');
      const buf = Buffer.alloc(size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = size;
      const r = parseEvents(this.rest + buf.toString('utf8'));
      this.rest = r.rest;
      return r.events;
    } catch {
      return [];
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}

/** Arquivos por terminal: os eventos e os da statusline. */
export const AGENT_FILE_SUFFIXES = ['.jsonl', STATUS_SUFFIX, '.status.tmp'];

/** Apaga arquivos de terminal (eventos e statusline) com mais de `maxAgeMs` que não estejam em `keep`. */
export function pruneEvents(eventsDir: string, keep: Set<string>, maxAgeMs = 2 * 86400_000, now = Date.now()) {
  let names: string[] = [];
  try {
    names = fs.readdirSync(eventsDir);
  } catch {
    return;
  }
  for (const n of names) {
    const suffix = AGENT_FILE_SUFFIXES.find(x => n.endsWith(x));
    if (!suffix || keep.has(n.slice(0, -suffix.length))) continue;
    const f = path.join(eventsDir, n);
    try {
      if (now - fs.statSync(f).mtimeMs > maxAgeMs) fs.unlinkSync(f);
    } catch {
      // em uso ou já apagado
    }
  }
}
