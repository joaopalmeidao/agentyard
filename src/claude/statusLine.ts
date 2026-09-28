import * as fs from 'fs';
import * as path from 'path';

/**
 * Statusline dos Claude Code abertos pela extensão. O `--settings` de cada terminal (src/claude/hooks.ts)
 * aponta `statusLine` para um script que grava o JSON que o Claude manda a cada atualização em
 * `<pasta>/<WTGRAPH_AGENT_ID>.status.json` (contexto, custo, limites de uso do plano) e depois desenha a
 * linha: a do usuário, se ele tem uma no settings.json dele (`statusline.user`), ou a da extensão.
 * Daqui sai a tela "Uso do Claude" (src/claude/usagePanel.ts). Sem VS Code (testado em test/claudeHooks.test.js).
 */

export const STATUSLINE_SCRIPT = 'statusline.sh';
/** Comando da statusline do usuário, repassado pelo script (só existe quando há um). */
export const USER_STATUSLINE = 'statusline.user';
export const STATUS_SUFFIX = '.status.json';

/** `keep`: a do usuário, se houver, senão a da extensão; `agentyard`: sempre a da extensão; `off`: não mexe. */
export type StatusLineMode = 'keep' | 'agentyard' | 'off';

export interface StatusLineLabels {
  session: string;
  week: string;
}

/**
 * Script da statusline, no bash do Claude (no Windows, o Git Bash que ele exige). A linha da extensão
 * sai do JSON com sed, sem jq: modelo · branch · contexto · custo · sessão (5 h) · semana.
 */
export function statusLineScript(labels: StatusLineLabels): string {
  const q = (s: string) => s.replace(/[^\p{L}\p{N} ]/gu, '');
  return `#!/usr/bin/env bash
# AgentYard: statusline do Claude Code. Uso: ${STATUSLINE_SCRIPT} <pasta>. Gerado pela extensão.
dir="$1"; id="\${WTGRAPH_AGENT_ID:-unknown}"
json=$(cat)
printf '%s' "$json" > "$dir/$id.status.tmp" 2>/dev/null && mv -f "$dir/$id.status.tmp" "$dir/$id${STATUS_SUFFIX}" 2>/dev/null
if [ -f "$dir/${USER_STATUSLINE}" ]; then printf '%s' "$json" | bash "$dir/${USER_STATUSLINE}"; exit 0; fi
export LC_ALL=C
flat=$(printf '%s' "$json" | tr -d '\\r\\n')
str() { printf '%s' "$flat" | sed -n "s/.*\\"$1\\"[[:space:]]*:[[:space:]]*\\"\\([^\\"]*\\)\\".*/\\1/p"; }
num() { printf '%s' "$flat" | sed -n "s/.*\\"$1\\"[[:space:]]*:[[:space:]]*{[^}]*\\"$2\\"[[:space:]]*:[[:space:]]*\\([0-9.]*\\).*/\\1/p"; }
color() { if [ "$1" -ge 80 ]; then printf '\\033[31m'; elif [ "$1" -ge 50 ]; then printf '\\033[33m'; else printf '\\033[32m'; fi; }
end=$'\\033[0m'; gray=$'\\033[90m'
out="$(printf '\\033[35m')$(str display_name)$end"
branch=$(git branch --show-current 2>/dev/null)
[ -n "$branch" ] && out="$out \${gray}·$end \\033[36m$branch$end"
ctx=$(num context_window used_percentage)
if [ -n "$ctx" ]; then n=$(printf '%.0f' "$ctx"); out="$out \${gray}·$end $(color "$n")ctx $n%$end"; fi
usd=$(num cost total_cost_usd)
[ -n "$usd" ] && out="$out \${gray}· \\$$(printf '%.2f' "$usd")$end"
five=$(num five_hour used_percentage)
if [ -n "$five" ]; then
  n=$(printf '%.0f' "$five"); out="$out \${gray}·$end $(color "$n")${q(labels.session)} $n%$end"
  at=$(num five_hour resets_at); [ -n "$at" ] && out="$out $gray↻$(date -d "@\${at%.*}" +%H:%M 2>/dev/null)$end"
fi
week=$(num seven_day used_percentage)
if [ -n "$week" ]; then n=$(printf '%.0f' "$week"); out="$out \${gray}·$end $(color "$n")${q(labels.week)} $n%$end"; fi
printf '%b' "$out"
`;
}

/** `statusLine` do settings passado com --settings. */
export function statusLineSetting(eventsDir: string) {
  const dir = eventsDir.replace(/\\/g, '/');
  return { type: 'command', command: `bash "${dir}/${STATUSLINE_SCRIPT}" "${dir}"`, padding: 0 };
}

/** Comando da statusline do usuário no settings.json dele (só `type: command`). */
export function userStatusLineCommand(claudeDir: string): string | undefined {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    const cmd = s?.statusLine?.type === 'command' ? s.statusLine.command : undefined;
    return typeof cmd === 'string' && cmd.trim() ? cmd.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Grava o script e o repasse para a statusline do usuário (apagado quando não há ou em `agentyard`). */
export function writeStatusLineFiles(eventsDir: string, mode: StatusLineMode, userCommand: string | undefined, labels: StatusLineLabels, write: (file: string, text: string) => void) {
  write(path.join(eventsDir, STATUSLINE_SCRIPT), statusLineScript(labels));
  const user = path.join(eventsDir, USER_STATUSLINE);
  if (mode === 'keep' && userCommand) write(user, `${userCommand}\n`);
  else fs.rmSync(user, { force: true });
}

// ---------- o que o Claude manda ----------

export interface RateLimit {
  /** 0–100. */
  pct: number;
  /** Quando a janela renova (ms). */
  resetsAt?: number;
}

/** Uma atualização da statusline de um terminal. */
export interface StatusSnapshot {
  /** Id do terminal (nome do arquivo). */
  id: string;
  /** Quando o arquivo foi gravado (ms). */
  at: number;
  sessionId?: string;
  cwd?: string;
  model?: string;
  /** Contexto usado, 0–100. */
  contextPct?: number;
  contextSize?: number;
  /** Custo da sessão em US$ (equivalente à API). */
  usd?: number;
  durationMs?: number;
  added?: number;
  removed?: number;
  fiveHour?: RateLimit;
  sevenDay?: RateLimit;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function rateLimit(v: any): RateLimit | undefined {
  const pct = num(v?.used_percentage);
  if (pct === undefined) return undefined;
  const r = num(v?.resets_at);
  // segundos desde 1970 (o formato do Claude); em ms se já vier grande
  return { pct, resetsAt: r === undefined ? undefined : r < 1e12 ? r * 1000 : r };
}

export function parseStatus(id: string, text: string, at: number): StatusSnapshot | undefined {
  let d: any;
  try {
    d = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!d || typeof d !== 'object') return undefined;
  const cw = d.context_window ?? {};
  return {
    id,
    at,
    sessionId: typeof d.session_id === 'string' ? d.session_id : undefined,
    cwd: d.workspace?.current_dir ?? d.cwd,
    model: d.model?.display_name ?? d.model?.id,
    contextPct: num(cw.used_percentage),
    contextSize: num(cw.context_window_size),
    usd: num(d.cost?.total_cost_usd),
    durationMs: num(d.cost?.total_duration_ms),
    added: num(d.cost?.total_lines_added),
    removed: num(d.cost?.total_lines_removed),
    fiveHour: rateLimit(d.rate_limits?.five_hour),
    sevenDay: rateLimit(d.rate_limits?.seven_day),
  };
}

/** Lê os `<id>.status.json` da pasta. */
export function readStatuses(eventsDir: string): StatusSnapshot[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(eventsDir).filter(n => n.endsWith(STATUS_SUFFIX));
  } catch {
    return [];
  }
  const out: StatusSnapshot[] = [];
  for (const n of names) {
    const f = path.join(eventsDir, n);
    try {
      const s = parseStatus(n.slice(0, -STATUS_SUFFIX.length), fs.readFileSync(f, 'utf8'), fs.statSync(f).mtimeMs);
      if (s) out.push(s);
    } catch {
      // sendo trocado
    }
  }
  return out;
}

/** Janela que já renovou conta como 0%. */
export function currentPct(r: RateLimit | undefined, now: number): number | undefined {
  if (!r) return undefined;
  return r.resetsAt !== undefined && r.resetsAt <= now ? 0 : r.pct;
}

// ---------- histórico ----------

export interface LimitSample {
  at: number;
  five?: number;
  seven?: number;
}

export interface SessionCost {
  cwd?: string;
  model?: string;
  first: number;
  last: number;
  usd: number;
  added?: number;
  removed?: number;
  /** Custo acumulado da sessão no fim de cada dia (AAAA-MM-DD, hora local). */
  days: Record<string, number>;
}

export interface UsageHistory {
  limits: LimitSample[];
  /** Por sessão do Claude. */
  sessions: Record<string, SessionCost>;
  /** Último limite visto: vale para a conta toda, não para um terminal. */
  latest?: { at: number; fiveHour?: RateLimit; sevenDay?: RateLimit };
}

export const emptyHistory = (): UsageHistory => ({ limits: [], sessions: {} });

const KEEP_MS = 8 * 86400_000;
const MAX_SAMPLES = 3000;

export function dayOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Acrescenta ao histórico o que chegou; devolve se algo mudou. Amostra dos limites quando o valor
 * muda ou a cada 10 min; tira o que tem mais de 8 dias.
 */
export function recordUsage(h: UsageHistory, snaps: StatusSnapshot[], now: number): boolean {
  let changed = false;
  for (const s of [...snaps].sort((a, b) => a.at - b.at)) {
    if ((s.fiveHour || s.sevenDay) && (!h.latest || s.at > h.latest.at)) {
      h.latest = { at: s.at, fiveHour: s.fiveHour, sevenDay: s.sevenDay };
      const five = s.fiveHour ? Math.round(s.fiveHour.pct) : undefined;
      const seven = s.sevenDay ? Math.round(s.sevenDay.pct) : undefined;
      const last = h.limits[h.limits.length - 1];
      if (!last || last.five !== five || last.seven !== seven || s.at - last.at >= 600_000) h.limits.push({ at: s.at, five, seven });
      changed = true;
    }
    if (s.sessionId && s.usd !== undefined) {
      const c = h.sessions[s.sessionId] ?? { first: s.at, last: 0, usd: 0, days: {} };
      if (s.at > c.last) {
        Object.assign(c, { cwd: s.cwd ?? c.cwd, model: s.model ?? c.model, last: s.at, usd: s.usd, added: s.added, removed: s.removed });
        c.days[dayOf(s.at)] = s.usd;
        h.sessions[s.sessionId] = c;
        changed = true;
      }
    }
  }
  const cut = now - KEEP_MS;
  const before = h.limits.length;
  h.limits = h.limits.filter(x => x.at >= cut).slice(-MAX_SAMPLES);
  for (const [k, c] of Object.entries(h.sessions)) if (c.last < cut) delete h.sessions[k];
  return changed || h.limits.length !== before;
}

/** Custo gasto em cada um dos últimos `n` dias (o acumulado de cada sessão menos o do dia anterior dela). */
export function costPerDay(h: UsageHistory, n: number, now: number): { day: string; usd: number }[] {
  const days: string[] = [];
  for (let i = n - 1; i >= 0; i--) days.push(dayOf(now - i * 86400_000));
  const total = new Map(days.map(d => [d, 0]));
  for (const c of Object.values(h.sessions)) {
    let prev = 0;
    for (const d of Object.keys(c.days).sort()) {
      if (total.has(d)) total.set(d, total.get(d)! + Math.max(0, c.days[d] - prev));
      prev = c.days[d];
    }
  }
  return days.map(day => ({ day, usd: total.get(day)! }));
}
