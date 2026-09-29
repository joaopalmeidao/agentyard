/**
 * Sessões do Claude Code lidas dos logs locais (`~/.claude/projects/<cwd codificado>/<id>.jsonl`),
 * sem depender da API do VS Code para poder ser testado com dados sintéticos
 * (test/sessions.test.js).
 *
 * Os arquivos só crescem (append), então a leitura é incremental: guardamos até onde já lemos e,
 * na próxima varredura, lemos só o final novo. Subagentes (`<id>/subagents/agent-*.jsonl`) somam
 * no uso da sessão que os disparou.
 *
 * Os limites oficiais (janela de 5 h e semanal) não ficam nos logs locais; o que se calcula aqui é
 * uma estimativa a partir dos tokens registrados em cada resposta.
 */
import * as fs from 'fs';
import * as path from 'path';
import { locale, t } from '../i18n';

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export interface SessionInfo {
  id: string;
  file: string;
  cwd?: string;
  gitBranch?: string;
  /** Título gerado pelo Claude Code (ai-title), se houver. */
  aiTitle?: string;
  /** Primeira mensagem digitada pelo usuário, truncada. */
  firstPrompt?: string;
  /** Última mensagem digitada pelo usuário, truncada. */
  lastPrompt?: string;
  /** Último texto do Claude (o fim do último turno), truncado. */
  lastReply?: string;
  lastReplyAt?: number;
  /** id da resposta de `lastReply`: blocos de texto da mesma resposta se juntam. */
  lastReplyId?: string;
  start: number;
  end: number;
  /** Mensagens do usuário (sem resultados de ferramenta) + respostas do assistente. */
  userMessages: number;
  assistantMessages: number;
  usage: TokenUsage;
  models: string[];
  /** [epoch ms, tokens ponderados] por resposta; só guardado para sessões recentes (janelas de uso). */
  events: [number, number][];
  /** Tokens ponderados por dia local (AAAA-MM-DD). */
  daily: Record<string, number>;
}

/** Estado para continuar a leitura de um arquivo de onde parou. */
interface FileState {
  size: number;
  mtimeMs: number;
  offset: number;
  lastMsgId?: string;
}

interface CacheEntry {
  main: FileState;
  subagents: Record<string, FileState>;
  info: SessionInfo;
}

export interface ScanCache {
  version: number;
  entries: Record<string, CacheEntry>;
}

const CACHE_VERSION = 2;
const TITLE_MAX = 90;
const PROMPT_MAX = 300;
const REPLY_MAX = 1500;
/** Eventos por resposta são mantidos só para sessões que terminaram há menos disso. */
const EVENTS_KEEP_MS = 9 * 24 * 3600_000;

export function emptyCache(): ScanCache {
  return { version: CACHE_VERSION, entries: {} };
}

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
}

/**
 * Tokens que pesam no uso: entrada, criação de cache e saída. Leitura de cache custa uma fração e
 * fica de fora da conta (mas aparece separada na UI).
 */
export function weighted(u: TokenUsage): number {
  return u.input + u.cacheCreate + u.output;
}

export function totalTokens(u: TokenUsage): number {
  return u.input + u.cacheCreate + u.output + u.cacheRead;
}

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const clipTo = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Todos os blocos de texto de uma linha de resposta do assistente, juntos. */
function replyText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  return content
    .filter(b => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim())
    .map(b => b.text as string)
    .join('\n\n');
}

function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const b of content) if (b && typeof b === 'object' && (b as any).type === 'text' && typeof (b as any).text === 'string') return (b as any).text;
  }
  return undefined;
}

/** Mensagens que não são algo que a pessoa digitou (comandos internos, lembretes do sistema). */
function isNoise(text: string): boolean {
  const s = text.trimStart();
  return s.startsWith('<command-') || s.startsWith('<local-command') || s.startsWith('<system-reminder>') || s.startsWith('Caveat:') || s.startsWith('[Request interrupted');
}

function newInfo(id: string, file: string): SessionInfo {
  return { id, file, start: 0, end: 0, userMessages: 0, assistantMessages: 0, usage: emptyUsage(), models: [], events: [], daily: {} };
}

/**
 * Lê um .jsonl a partir de `st.offset` (até a última quebra de linha completa) e acumula em `info`.
 * `isMain` = transcrição principal (conta mensagens, título, cwd); subagentes só somam uso.
 */
async function readIncremental(file: string, st: FileState, info: SessionInfo, isMain: boolean): Promise<FileState> {
  const stat = await fs.promises.stat(file);
  if (stat.size < st.offset) {
    // arquivo encolheu ou foi recriado: recomeçar (quem chama já zerou info se necessário)
    st = { size: 0, mtimeMs: 0, offset: 0 };
  }
  if (stat.size === st.offset) return { ...st, size: stat.size, mtimeMs: stat.mtimeMs };

  let lastMsgId = st.lastMsgId;
  let consumed = st.offset;
  let leftover = '';
  const models = new Set(info.models);

  const handle = (line: string) => {
    if (!line) return;
    const isAssistant = line.includes('"type":"assistant"');
    const isUser = isMain && line.includes('"type":"user"');
    const isTitle = isMain && line.includes('"type":"ai-title"');
    if (!isAssistant && !isUser && !isTitle) return;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
    if (isTitle && typeof o.aiTitle === 'string') {
      info.aiTitle = o.aiTitle;
      return;
    }
    if (!Number.isNaN(ts)) {
      if (!info.start || ts < info.start) info.start = ts;
      if (ts > info.end) info.end = ts;
    }
    if (isMain && !info.cwd && typeof o.cwd === 'string') info.cwd = o.cwd;
    if (isMain && typeof o.gitBranch === 'string' && o.gitBranch) info.gitBranch = o.gitBranch;

    if (o.type === 'user' && isMain) {
      if (o.toolUseResult !== undefined || o.isMeta) return;
      const text = textOf(o.message?.content);
      if (!text || isNoise(text)) return;
      info.userMessages++;
      const one = text.replace(/\s+/g, ' ').trim();
      if (!info.firstPrompt) info.firstPrompt = clipTo(one, TITLE_MAX);
      info.lastPrompt = clipTo(one, PROMPT_MAX);
      return;
    }
    if (o.type === 'assistant') {
      const msg = o.message ?? {};
      // Cada bloco de conteúdo de uma resposta vira uma linha com o mesmo id e o mesmo usage.
      const id = msg.id ?? o.requestId;
      if (isMain) {
        const text = replyText(msg.content).trim();
        if (text) {
          const joined = id && id === info.lastReplyId && info.lastReply ? `${info.lastReply}\n\n${text}` : text;
          info.lastReply = clipTo(joined, REPLY_MAX);
          info.lastReplyId = id;
          if (!Number.isNaN(ts)) info.lastReplyAt = ts;
        }
      }
      if (id && id === lastMsgId) return;
      lastMsgId = id;
      if (isMain) info.assistantMessages++;
      if (typeof msg.model === 'string' && msg.model !== '<synthetic>') models.add(msg.model);
      const u = msg.usage;
      if (!u) return;
      const add: TokenUsage = {
        input: Number(u.input_tokens) || 0,
        output: Number(u.output_tokens) || 0,
        cacheRead: Number(u.cache_read_input_tokens) || 0,
        cacheCreate: Number(u.cache_creation_input_tokens) || 0,
      };
      info.usage.input += add.input;
      info.usage.output += add.output;
      info.usage.cacheRead += add.cacheRead;
      info.usage.cacheCreate += add.cacheCreate;
      const w = weighted(add);
      if (!Number.isNaN(ts) && w) {
        info.events.push([ts, w]);
        const k = dayKey(ts);
        info.daily[k] = (info.daily[k] ?? 0) + w;
      }
    }
  };

  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file, { start: st.offset, encoding: 'utf8', highWaterMark: 1 << 20 });
    stream.on('data', (chunk: string | Buffer) => {
      const text = leftover + chunk;
      let from = 0;
      for (;;) {
        const nl = text.indexOf('\n', from);
        if (nl < 0) break;
        const line = text.slice(from, nl);
        handle(line.endsWith('\r') ? line.slice(0, -1) : line);
        consumed += Buffer.byteLength(line, 'utf8') + 1;
        from = nl + 1;
      }
      leftover = text.slice(from);
    });
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  info.models = [...models];
  return { size: stat.size, mtimeMs: stat.mtimeMs, offset: consumed, lastMsgId };
}

export interface ScanResult {
  sessions: SessionInfo[];
  filesRead: number;
  bytesRead: number;
}

/**
 * Varre `<claudeDir>/projects`. Reaproveita o cache: arquivos sem mudança não são abertos; arquivos
 * que cresceram são lidos só no trecho novo.
 */
export async function scanSessions(claudeDir: string, cache: ScanCache, now = Date.now()): Promise<ScanResult> {
  if (cache.version !== CACHE_VERSION) {
    cache.version = CACHE_VERSION;
    cache.entries = {};
  }
  const root = path.join(claudeDir, 'projects');
  let dirs: string[] = [];
  try {
    dirs = await fs.promises.readdir(root);
  } catch {
    return { sessions: [], filesRead: 0, bytesRead: 0 };
  }
  const seen = new Set<string>();
  let filesRead = 0;
  let bytesRead = 0;

  for (const d of dirs) {
    const dir = path.join(root, d);
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const file = path.join(dir, n);
      const id = n.slice(0, -'.jsonl'.length);
      seen.add(file);
      let entry = cache.entries[file];
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(file);
      } catch {
        continue;
      }
      if (!entry || stat.size < entry.main.offset) {
        entry = { main: { size: 0, mtimeMs: 0, offset: 0 }, subagents: {}, info: newInfo(id, file) };
        cache.entries[file] = entry;
      }
      if (stat.size !== entry.main.size || stat.mtimeMs !== entry.main.mtimeMs) {
        bytesRead += stat.size - entry.main.offset;
        entry.main = await readIncremental(file, entry.main, entry.info, true);
        filesRead++;
      }
      // subagentes desta sessão
      const subDir = path.join(dir, id, 'subagents');
      let subs: string[] = [];
      try {
        subs = (await fs.promises.readdir(subDir)).filter(s => s.endsWith('.jsonl'));
      } catch {
        // sem subagentes
      }
      for (const s of subs) {
        const sf = path.join(subDir, s);
        let sst: fs.Stats;
        try {
          sst = await fs.promises.stat(sf);
        } catch {
          continue;
        }
        const prev = entry.subagents[s] ?? { size: 0, mtimeMs: 0, offset: 0 };
        if (sst.size !== prev.size || sst.mtimeMs !== prev.mtimeMs) {
          bytesRead += sst.size - Math.min(prev.offset, sst.size);
          entry.subagents[s] = await readIncremental(sf, prev, entry.info, false);
          filesRead++;
        }
      }
      entry.info.events.sort((a, b) => a[0] - b[0]);
      if (entry.info.end && now - entry.info.end > EVENTS_KEEP_MS) entry.info.events = [];
    }
  }
  for (const f of Object.keys(cache.entries)) if (!seen.has(f)) delete cache.entries[f];
  const sessions = Object.values(cache.entries)
    .map(e => e.info)
    .filter(s => s.userMessages > 0 || s.assistantMessages > 0)
    .sort((a, b) => b.end - a.end);
  return { sessions, filesRead, bytesRead };
}

export function sessionTitle(s: SessionInfo): string {
  return s.aiTitle || s.firstPrompt || s.id.slice(0, 8);
}

const norm = (p: string) => path.normalize(p).replace(/[\\/]+$/, '').toLowerCase();

/** Worktree (caminho) de cada sessão, pelo cwd: a worktree mais específica que contém o cwd. */
export function mapToWorktrees(sessions: SessionInfo[], worktreePaths: string[]): Map<string, SessionInfo[]> {
  const roots = worktreePaths.map(p => ({ p, n: norm(p) })).sort((a, b) => b.n.length - a.n.length);
  const out = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    if (!s.cwd) continue;
    const c = norm(s.cwd);
    const hit = roots.find(r => c === r.n || c.startsWith(r.n + path.sep.toLowerCase()) || c.startsWith(r.n + '/'));
    if (!hit) continue;
    const list = out.get(hit.p) ?? [];
    list.push(s);
    out.set(hit.p, list);
  }
  return out;
}

export interface UsageWindow {
  /** Tokens ponderados no período. */
  tokens: number;
  start: number;
  end: number;
  /** Respostas no período. */
  responses: number;
}

/**
 * Janela de 5 h no estilo do plano de assinatura: começa na hora cheia da primeira resposta depois
 * que a janela anterior acabou, e dura 5 h. Devolve a janela ativa em `now`, se houver.
 */
export function currentBlock(sessions: SessionInfo[], now = Date.now(), hours = 5): UsageWindow | undefined {
  const len = hours * 3600_000;
  const events = sessions.flatMap(s => s.events).filter(e => e[0] > now - 2 * len && e[0] <= now).sort((a, b) => a[0] - b[0]);
  let block: UsageWindow | undefined;
  for (const [ts, w] of events) {
    if (!block || ts >= block.end) {
      const start = Math.floor(ts / 3600_000) * 3600_000;
      block = { tokens: 0, start, end: start + len, responses: 0 };
    }
    block.tokens += w;
    block.responses++;
  }
  return block && now < block.end ? block : undefined;
}

/** Semana: 7 dias corridos, ou desde segunda-feira 00:00 (hora local). */
export function weekWindow(sessions: SessionInfo[], mode: 'rolling' | 'monday', now = Date.now()): UsageWindow {
  let start: number;
  if (mode === 'monday') {
    const d = new Date(now);
    const back = (d.getDay() + 6) % 7;
    start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
  } else {
    start = now - 7 * 24 * 3600_000;
  }
  let tokens = 0;
  let responses = 0;
  for (const s of sessions) {
    if (s.end < start) continue;
    for (const [ts, w] of s.events) {
      if (ts >= start && ts <= now) {
        tokens += w;
        responses++;
      }
    }
  }
  return { tokens, start, end: mode === 'monday' ? start + 7 * 24 * 3600_000 : now, responses };
}

export function dailyTotals(sessions: SessionInfo[], days: number, now = Date.now()): { day: string; tokens: number }[] {
  const out: { day: string; tokens: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const k = dayKey(now - i * 24 * 3600_000);
    out.push({ day: k, tokens: sessions.reduce((sum, s) => sum + (s.daily[k] ?? 0), 0) });
  }
  return out;
}

export function formatTokens(n: number): string {
  if (n >= 1e9) return t('{0}B', (n / 1e9).toFixed(1));
  if (n >= 1e6) return t('{0}M', (n / 1e6).toFixed(1));
  if (n >= 1e3) return t('{0}K', Math.round(n / 1e3));
  return String(n);
}

/**
 * Transcrição legível: só o texto trocado entre a pessoa e o Claude. Chamadas de ferramenta viram
 * uma linha curta; resultados de ferramenta são omitidos.
 */
export async function renderTranscript(s: SessionInfo, maxChars = 4000): Promise<string> {
  const lines: string[] = [`# ${sessionTitle(s)}`, '', `${t('Session {0}', `\`${s.id}\``)} · ${s.cwd ?? ''}${s.gitBranch ? ` · ${s.gitBranch}` : ''}`, ''];
  const clip = (s: string) => (s.length > maxChars ? `${s.slice(0, maxChars)}\n\n… (${t('{0} characters omitted', s.length - maxChars)})` : s);
  let lastId: string | undefined;
  const stream = fs.createReadStream(s.file, { encoding: 'utf8', highWaterMark: 1 << 20 });
  let leftover = '';
  const handle = (line: string) => {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) return;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    const when = o.timestamp ? new Date(o.timestamp).toLocaleString(locale()) : '';
    if (o.type === 'user') {
      if (o.toolUseResult !== undefined || o.isMeta) return;
      const text = textOf(o.message?.content);
      if (!text || isNoise(text)) return;
      lines.push(`## ${t('You')} · ${when}`, '', clip(text), '');
      return;
    }
    const msg = o.message ?? {};
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const out: string[] = [];
    for (const b of blocks) {
      if (b?.type === 'text' && b.text) out.push(clip(b.text));
      else if (b?.type === 'tool_use') out.push(`> 🔧 ${b.name}`);
    }
    if (!out.length) return;
    if (msg.id && msg.id === lastId) {
      lines.push(...out, '');
    } else {
      lines.push(`## Claude · ${when}`, '', ...out, '');
    }
    lastId = msg.id;
  };
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: string | Buffer) => {
      const text = leftover + chunk;
      const parts = text.split('\n');
      leftover = parts.pop() ?? '';
      for (const p of parts) handle(p.endsWith('\r') ? p.slice(0, -1) : p);
    });
    stream.on('end', () => {
      if (leftover) handle(leftover);
      resolve();
    });
    stream.on('error', reject);
  });
  return lines.join('\n');
}

/** Um turno: o que a pessoa pediu, o que o Claude mexeu e o texto com que ele fechou. */
export interface SessionTurn {
  prompt: string;
  at: number;
  /** Último texto do Claude no turno (a mensagem final). */
  reply: string;
  replyAt?: number;
  /** Arquivos passados a Edit/Write/MultiEdit/NotebookEdit, na ordem em que apareceram. */
  files: string[];
  /** Chamadas de ferramenta no turno. */
  tools: number;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Lê a transcrição inteira e separa por turno (cada mensagem digitada abre um turno). */
export async function readTurns(file: string): Promise<SessionTurn[]> {
  const turns: SessionTurn[] = [];
  let cur: SessionTurn | undefined;
  let replyId: string | undefined;
  const handle = (line: string) => {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) return;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
    if (o.type === 'user') {
      if (o.toolUseResult !== undefined || o.isMeta) return;
      const text = textOf(o.message?.content);
      if (!text || isNoise(text)) return;
      cur = { prompt: text.trim(), at: Number.isNaN(ts) ? 0 : ts, reply: '', files: [], tools: 0 };
      replyId = undefined;
      turns.push(cur);
      return;
    }
    if (!cur) {
      // resposta antes de qualquer mensagem (sessão retomada/compactada): turno sem pedido
      cur = { prompt: '', at: Number.isNaN(ts) ? 0 : ts, reply: '', files: [], tools: 0 };
      turns.push(cur);
    }
    const msg = o.message ?? {};
    const id = msg.id ?? o.requestId;
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b?.type !== 'tool_use') continue;
      cur.tools++;
      const f = b.input?.file_path ?? b.input?.notebook_path;
      if (EDIT_TOOLS.has(b.name) && typeof f === 'string' && !cur.files.includes(f)) cur.files.push(f);
    }
    const text = replyText(msg.content).trim();
    if (!text) return;
    cur.reply = id && id === replyId && cur.reply ? `${cur.reply}\n\n${text}` : text;
    replyId = id;
    if (!Number.isNaN(ts)) cur.replyAt = ts;
  };
  await new Promise<void>((resolve, reject) => {
    let leftover = '';
    const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
    stream.on('data', (chunk: string | Buffer) => {
      const parts = (leftover + chunk).split('\n');
      leftover = parts.pop() ?? '';
      for (const p of parts) handle(p.endsWith('\r') ? p.slice(0, -1) : p);
    });
    stream.on('end', () => {
      if (leftover) handle(leftover);
      resolve();
    });
    stream.on('error', reject);
  });
  return turns;
}

/** Arquivos relativos à worktree, em `código`; os de fora dela (rascunhos, temporários) ficam de fora. */
function fileList(root: string | undefined, files: string[], sep = ', '): string {
  const inside = root
    ? files.map(f => path.relative(root, f)).filter(r => r && !r.startsWith('..') && !path.isAbsolute(r)).map(r => r.replace(/\\/g, '/'))
    : files;
  return inside.map(f => `\`${f}\``).join(sep);
}

/** Última mensagem do Claude numa sessão, com o pedido que ela responde (Markdown). */
export function renderLastMessage(s: SessionInfo, turns: SessionTurn[], root?: string): string {
  const when = (ms?: number) => (ms ? new Date(ms).toLocaleString(locale()) : '');
  const last = [...turns].reverse().find(x => x.reply) ?? turns[turns.length - 1];
  const lines = [`# ${sessionTitle(s)}`, '', `${t('Session {0}', `\`${s.id}\``)}${s.gitBranch ? ` · ${s.gitBranch}` : ''} · ${when(s.end)}`, ''];
  if (!last) return [...lines, t('No messages in this session yet.')].join('\n');
  if (last.prompt) lines.push(`## ${t('You')} · ${when(last.at)}`, '', quote(clipTo(last.prompt, 3000)), '');
  lines.push(`## Claude · ${when(last.replyAt ?? last.at)}`, '', last.reply || `_${t('No text reply in this turn yet.')}_`, '');
  const files = fileList(root, last.files);
  if (files) lines.push(`**${t('Files edited in this turn')}:** ${files}`, '');
  return lines.join('\n');
}

const quote = (s: string) => s.split('\n').map(l => `> ${l}`).join('\n');

export interface RecapGit {
  branch?: string;
  base?: string;
  /** `git log --oneline base..HEAD` */
  commits: string[];
  /** `git status --short` */
  uncommitted: string[];
  /** Última linha de `git diff --stat base...HEAD` */
  stat?: string;
}

/**
 * Recapitulação de uma worktree: estado no git e, por sessão (da mais antiga para a mais nova), cada
 * pedido, os arquivos editados e a resposta final do Claude. `replyMax` corta respostas longas.
 */
export function renderRecap(title: string, root: string | undefined, sessions: { info: SessionInfo; turns: SessionTurn[] }[], git?: RecapGit, replyMax = 1200): string {
  const when = (ms?: number) => (ms ? new Date(ms).toLocaleString(locale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const lines = [`# ${t('Recap: {0}', title)}`, ''];
  if (git) {
    lines.push(`## ${t('Where it stands')}`, '');
    if (git.base) lines.push(`- ${t('{0} commit(s) ahead of {1}', git.commits.length, `\`${git.base}\``)}${git.stat ? ` · ${git.stat}` : ''}`);
    lines.push(`- ${git.uncommitted.length ? t('{0} uncommitted file(s)', git.uncommitted.length) : t('No uncommitted changes')}`);
    if (git.commits.length) lines.push('', `### ${t('Commits')}`, '', ...git.commits.slice(0, 40).map(c => `- ${c}`), ...(git.commits.length > 40 ? [`- … ${t('{0} more', git.commits.length - 40)}`] : []));
    if (git.uncommitted.length) lines.push('', `### ${t('Uncommitted')}`, '', '```', ...git.uncommitted.slice(0, 40), '```');
    lines.push('');
  }
  if (!sessions.length) lines.push(t('No Claude Code session in this worktree.'));
  const touched = fileList(root, [...new Set(sessions.flatMap(x => x.turns.flatMap(tn => tn.files)))], ' · ');
  if (touched) lines.push(`## ${t('Files the agent edited')}`, '', touched, '');
  for (const { info, turns } of sessions) {
    lines.push(`## ${sessionTitle(info)}`, '', `_${when(info.start)} → ${when(info.end)} · ${t('{0} turn(s)', turns.length)} · \`${info.id.slice(0, 8)}\`_`, '');
    turns.forEach((tn, i) => {
      const head = tn.prompt ? clipTo(tn.prompt.replace(/\s+/g, ' '), 200) : t('(continued)');
      lines.push(`### ${i + 1}. ${head}`, '');
      const meta = [when(tn.at), tn.tools ? t('{0} tool call(s)', tn.tools) : '', fileList(root, tn.files) && `${t('edited')}: ${fileList(root, tn.files)}`].filter(Boolean).join(' · ');
      if (meta) lines.push(`_${meta}_`, '');
      if (tn.reply) lines.push(quote(clipTo(tn.reply, replyMax)), '');
    });
  }
  return lines.join('\n');
}

/** Prompt para o Claude (sem terminal) resumir a recapitulação. */
export function recapSummaryPrompt(recap: string, lang: string): string {
  const max = 80_000;
  const r = recap.length > max ? `${recap.slice(0, max)}\n… (truncated)` : recap;
  return [
    'Below is a log of what an AI coding agent did in a git worktree: the requests it got, the files it edited, its final replies, and the git state.',
    `Write, in ${lang}, a short recap for the developer who is coming back to this work. Use Markdown with these sections:`,
    '1. Goal (one or two lines)',
    '2. What was done (bullets; mention the main files)',
    '3. Current state (committed or not, tests, anything left broken)',
    '4. Open points / next steps (what the agent said is pending, or questions it asked)',
    'Be concrete and brief. Do not invent anything that is not in the log. No preamble.',
    '',
    r,
  ].join('\n');
}

export interface ClaudeCommand {
  /** "/nome" como se digita no Claude Code. */
  name: string;
  description: string;
  source: 'project' | 'user' | 'skill' | 'builtin';
}

function frontmatterDescription(file: string): string {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 4000);
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
    const d = fm && /^description:\s*(.+)$/m.exec(fm[1]);
    if (d) return d[1].replace(/^["']|["']$/g, '').trim();
    const firstLine = head.replace(/^---[\s\S]*?---/, '').split(/\r?\n/).find(l => l.trim());
    return firstLine ? firstLine.replace(/^#+\s*/, '').trim().slice(0, 120) : '';
  } catch {
    return '';
  }
}

function frontmatterName(file: string): string | undefined {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 2000);
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
    const n = fm && /^name:\s*(.+)$/m.exec(fm[1]);
    return n ? n[1].replace(/^["']|["']$/g, '').trim() : undefined;
  } catch {
    return undefined;
  }
}

function listCommandDir(dir: string, source: ClaudeCommand['source'], prefix = ''): ClaudeCommand[] {
  const out: ClaudeCommand[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listCommandDir(full, source, `${prefix}${e.name}:`));
    else if (e.name.endsWith('.md')) out.push({ name: `/${prefix}${e.name.slice(0, -3)}`, description: frontmatterDescription(full), source });
  }
  return out;
}

function listSkills(dir: string, depth = 3): ClaudeCommand[] {
  const out: ClaudeCommand[] = [];
  const walk = (d: string, level: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    const skill = entries.find(e => e.isFile() && e.name === 'SKILL.md');
    if (skill) {
      const f = path.join(d, 'SKILL.md');
      out.push({ name: `/${frontmatterName(f) ?? path.basename(d)}`, description: frontmatterDescription(f), source: 'skill' });
      return;
    }
    if (level >= depth) return;
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) walk(path.join(d, e.name), level + 1);
  };
  walk(dir, 0);
  return out;
}

export function builtinCommands(): ClaudeCommand[] {
  return [
    { name: '/resume', description: t('Pick a previous conversation to continue'), source: 'builtin' },
    { name: '/compact', description: t('Summarize the conversation to free up context'), source: 'builtin' },
    { name: '/clear', description: t('Start over in this session'), source: 'builtin' },
    { name: '/usage', description: t('Plan usage and limits'), source: 'builtin' },
    { name: '/review', description: t('Review the changes'), source: 'builtin' },
    { name: '/init', description: t('Create the project\'s CLAUDE.md'), source: 'builtin' },
    { name: '/memory', description: t('Edit memories and CLAUDE.md'), source: 'builtin' },
    { name: '/model', description: t('Switch the model'), source: 'builtin' },
  ];
}

/** Comandos de barra e skills disponíveis para uma pasta de projeto. */
export function listClaudeCommands(projectDir: string | undefined, claudeDir: string): ClaudeCommand[] {
  const all = [
    ...(projectDir ? listCommandDir(path.join(projectDir, '.claude', 'commands'), 'project') : []),
    ...(projectDir ? listSkills(path.join(projectDir, '.claude', 'skills')) : []),
    ...listCommandDir(path.join(claudeDir, 'commands'), 'user'),
    ...listSkills(path.join(claudeDir, 'skills')),
    ...builtinCommands(),
  ];
  const seen = new Set<string>();
  return all.filter(c => (seen.has(c.name) ? false : (seen.add(c.name), true)));
}
