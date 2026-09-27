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

const CACHE_VERSION = 1;
const TITLE_MAX = 90;
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

function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const b of content) if (b && typeof b === 'object' && (b as any).type === 'text' && typeof (b as any).text === 'string') return (b as any).text;
  }
  return undefined;
}

/** Mensagens que não são algo que a pessoa digitou (comandos internos, lembretes do sistema). */
function isNoise(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<command-') || t.startsWith('<local-command') || t.startsWith('<system-reminder>') || t.startsWith('Caveat:') || t.startsWith('[Request interrupted');
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
      if (!info.firstPrompt) {
        const one = text.replace(/\s+/g, ' ').trim();
        info.firstPrompt = one.length > TITLE_MAX ? `${one.slice(0, TITLE_MAX - 1)}…` : one;
      }
      return;
    }
    if (o.type === 'assistant') {
      const msg = o.message ?? {};
      // Cada bloco de conteúdo de uma resposta vira uma linha com o mesmo id e o mesmo usage.
      const id = msg.id ?? o.requestId;
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
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} bi`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} mi`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} mil`;
  return String(n);
}

/**
 * Transcrição legível: só o texto trocado entre a pessoa e o Claude. Chamadas de ferramenta viram
 * uma linha curta; resultados de ferramenta são omitidos.
 */
export async function renderTranscript(s: SessionInfo, maxChars = 4000): Promise<string> {
  const lines: string[] = [`# ${sessionTitle(s)}`, '', `Sessão \`${s.id}\` · ${s.cwd ?? ''}${s.gitBranch ? ` · ${s.gitBranch}` : ''}`, ''];
  const clip = (t: string) => (t.length > maxChars ? `${t.slice(0, maxChars)}\n\n… (${t.length - maxChars} caracteres omitidos)` : t);
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
    const when = o.timestamp ? new Date(o.timestamp).toLocaleString('pt-BR') : '';
    if (o.type === 'user') {
      if (o.toolUseResult !== undefined || o.isMeta) return;
      const t = textOf(o.message?.content);
      if (!t || isNoise(t)) return;
      lines.push(`## Você · ${when}`, '', clip(t), '');
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

export interface ClaudeCommand {
  /** "/nome" como se digita no Claude Code. */
  name: string;
  description: string;
  source: 'projeto' | 'usuário' | 'skill' | 'embutido';
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

export const BUILTIN_COMMANDS: ClaudeCommand[] = [
  { name: '/resume', description: 'Escolher uma conversa anterior para continuar', source: 'embutido' },
  { name: '/compact', description: 'Resumir a conversa para liberar contexto', source: 'embutido' },
  { name: '/clear', description: 'Começar do zero nesta sessão', source: 'embutido' },
  { name: '/usage', description: 'Uso do plano e limites', source: 'embutido' },
  { name: '/review', description: 'Revisar as alterações', source: 'embutido' },
  { name: '/init', description: 'Criar o CLAUDE.md do projeto', source: 'embutido' },
  { name: '/memory', description: 'Editar memórias e CLAUDE.md', source: 'embutido' },
  { name: '/model', description: 'Trocar o modelo', source: 'embutido' },
];

/** Comandos de barra e skills disponíveis para uma pasta de projeto. */
export function listClaudeCommands(projectDir: string | undefined, claudeDir: string): ClaudeCommand[] {
  const all = [
    ...(projectDir ? listCommandDir(path.join(projectDir, '.claude', 'commands'), 'projeto') : []),
    ...(projectDir ? listSkills(path.join(projectDir, '.claude', 'skills')) : []),
    ...listCommandDir(path.join(claudeDir, 'commands'), 'usuário'),
    ...listSkills(path.join(claudeDir, 'skills')),
    ...BUILTIN_COMMANDS,
  ];
  const seen = new Set<string>();
  return all.filter(c => (seen.has(c.name) ? false : (seen.add(c.name), true)));
}
