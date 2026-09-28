import * as fs from 'fs';
import * as path from 'path';

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
}

/**
 * Eventos acompanhados. PostToolUse marca a volta ao trabalho depois de uma permissão; PreCompact
 * avisa que o contexto vai ser resumido (os projetos longos atualizam o que é reinjetado).
 */
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Notification', 'PreCompact', 'Stop', 'SessionEnd'] as const;
/** Eventos em que o script dos projetos longos age (injetar contexto, marcar o turno, portão). */
export const PROJECT_EVENTS = new Set<string>(['SessionStart', 'UserPromptSubmit', 'Stop']);
/** O portão do Stop roda a verificação do projeto: pode demorar. */
export const PROJECT_STOP_TIMEOUT = 1800;
const TOOL_EVENTS = new Set(['PostToolUse']);

/** Comando de cada hook: roda no shell do Claude (bash; no Windows, o Git Bash que ele exige). */
export function hookCommand(eventsDir: string): string {
  const dir = eventsDir.replace(/\\/g, '/');
  return `{ cat; echo; } >> "${dir}/\${WTGRAPH_AGENT_ID:-unknown}.jsonl"`;
}

export const PROJECT_SCRIPT = 'project-hook.sh';

/**
 * Comando do hook dos projetos longos: só roda o script quando o terminal tem um `<id>.project`
 * (sessões abertas por um projeto longo); nos outros sai na hora.
 */
export function projectHookCommand(eventsDir: string, event: string): string {
  const dir = eventsDir.replace(/\\/g, '/');
  return `[ -f "${dir}/\${WTGRAPH_AGENT_ID:-unknown}.project" ] || exit 0; bash "${dir}/${PROJECT_SCRIPT}" "${dir}" ${event}`;
}

export function hookSettings(eventsDir: string) {
  const hook = { type: 'command', command: hookCommand(eventsDir), timeout: 5 };
  const hooks: Record<string, unknown[]> = {};
  for (const e of HOOK_EVENTS) {
    const list: unknown[] = [hook];
    if (PROJECT_EVENTS.has(e)) list.push({ type: 'command', command: projectHookCommand(eventsDir, e), timeout: e === 'Stop' ? PROJECT_STOP_TIMEOUT : 10 });
    hooks[e] = [TOOL_EVENTS.has(e) ? { matcher: '*', hooks: list } : { hooks: list }];
  }
  return { hooks };
}


/**
 * Script dos projetos longos, no bash do Claude. Lê `<id>.project` (variáveis gravadas pela extensão
 * ao abrir a sessão) e:
 *  - SessionStart: imprime `<id>.context.md`, que o Claude recebe como contexto (também depois de
 *    compactar ou retomar);
 *  - UserPromptSubmit: marca o início do turno (`<id>.turn`) e zera as tentativas do portão;
 *  - Stop: o portão. Só deixa parar com o checklist do marco marcado no PLAN.md, o PROGRESS.md
 *    atualizado neste turno, tudo commitado e a verificação passando. Senão sai com 2 e o motivo no
 *    stderr, que o Claude recebe e continua. Um BLOCKED.md na pasta do projeto libera (precisa de
 *    uma pessoa); depois de MAX_RETRIES bloqueios seguidos, desiste e libera. O resultado vai para
 *    `<id>.gate` (running, pass, blocked, giveup ou "fail <motivo>").
 */
export const PROJECT_SCRIPT_BODY = `#!/usr/bin/env bash
# AgentYard: projetos longos. Uso: ${PROJECT_SCRIPT} <pasta> <evento>. Gerado pela extensão.
dir="$1"; ev="$2"; id="\${WTGRAPH_AGENT_ID:-unknown}"
cat > /dev/null
. "$dir/$id.project" 2>/dev/null || exit 0
case "$ev" in
  SessionStart) [ -f "$dir/$id.context.md" ] && cat "$dir/$id.context.md"; exit 0 ;;
  UserPromptSubmit) touch "$dir/$id.turn"; rm -f "$dir/$id.retries"; exit 0 ;;
  Stop) ;;
  *) exit 0 ;;
esac
[ "$GATE" = 1 ] || exit 0
status() { printf '%s\\n' "$1" > "$dir/$id.gate"; }
status running
if [ -f "$PROJECT_DIR/BLOCKED.md" ]; then status blocked; exit 0; fi
n=$(cat "$dir/$id.retries" 2>/dev/null); n=\${n:-0}
if [ "$n" -ge "\${MAX_RETRIES:-3}" ]; then status giveup; exit 0; fi
block() { echo $((n + 1)) > "$dir/$id.retries"; status "fail $1"; printf '%s\\n' "$2" >&2; exit 2; }
cd "$WORKTREE" 2>/dev/null || { status pass; exit 0; }
left=$(awk -v m="## [$MILESTONE]" 'index($0, m) == 1 { on = 1; next } on && /^## / { exit } on && /^[[:space:]]*[-*] \\[ \\]/ { c++ } END { print c + 0 }' "$PROJECT_DIR/PLAN.md" 2>/dev/null)
[ "\${left:-0}" -gt 0 ] && block checklist "$MSG_CHECKLIST ($left)"
[ "$PROJECT_DIR/PROGRESS.md" -nt "$dir/$id.turn" ] || block progress "$MSG_PROGRESS"
[ -z "$(git status --porcelain 2>/dev/null)" ] || block commit "$MSG_COMMIT"
if [ -n "$VERIFY" ]; then
  out=$(bash -c "$VERIFY" 2>&1); code=$?
  [ $code -eq 0 ] || block verify "$MSG_VERIFY
$(printf '%s\\n' "$out" | tail -n 60)"
fi
status pass
exit 0
`;

function writeIfChanged(file: string, text: string) {
  let old = '';
  try {
    old = fs.readFileSync(file, 'utf8');
  } catch {
    // ainda não existe
  }
  if (old !== text) fs.writeFileSync(file, text, 'utf8');
}

/** Grava (só se mudou) o arquivo passado com --settings e o script dos projetos; devolve o caminho do settings. */
export function writeHookSettings(eventsDir: string): string {
  fs.mkdirSync(eventsDir, { recursive: true });
  const file = path.join(eventsDir, 'hooks.settings.json');
  writeIfChanged(file, JSON.stringify(hookSettings(eventsDir), null, 2));
  writeIfChanged(path.join(eventsDir, PROJECT_SCRIPT), PROJECT_SCRIPT_BODY);
  return file;
}

/** O comando abre o Claude Code? (primeiro token é `claude`, `claude.exe` ou `claude.cmd`). */
export function isClaudeCommand(cmd: string): boolean {
  const first = cmd.trim().split(/\s+/)[0] ?? '';
  return /^claude(\.exe|\.cmd)?$/i.test(path.basename(first.replace(/^["']|["']$/g, '')));
}

/** Põe `--settings "<arquivo>"` logo depois do `claude`; outros comandos ficam como estão. */
export function instrumentCommand(cmd: string, settingsFile: string): string {
  if (!isClaudeCommand(cmd) || /(^|\s)--settings(\s|=|$)/.test(cmd)) return cmd;
  const m = cmd.match(/^(\s*\S+)([\s\S]*)$/);
  return m ? `${m[1]} --settings "${settingsFile}"${m[2]}` : cmd;
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

/** Arquivos por terminal além dos eventos: os dos projetos longos. */
export const AGENT_FILE_SUFFIXES = ['.jsonl', '.project', '.context.md', '.turn', '.retries', '.gate'];

/** Apaga arquivos de terminal (eventos e dos projetos) com mais de `maxAgeMs` que não estejam em `keep`. */
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
