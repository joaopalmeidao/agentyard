import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { bridgeHome } from '../bridge/core';
import type { RegistryWindow } from '../claude/missionControl';

/**
 * Acesso remoto (sem VS Code): uma página para o celular com os agentes de todas as janelas, lidos do
 * registro do mission control. A página em si não tem dado nenhum; o estado sai de /api/state só com o
 * token, que vai no fragmento do link (#k=…) e por isso nunca chega a logs de túnel ou proxy.
 */

const TOKEN_FILE = 'remote.json';

/** Token do acesso remoto, compartilhado entre as janelas (~/.agentyard/remote.json); cria ou troca. */
export function remoteToken(home = bridgeHome(), reset = false): string {
  const file = path.join(home, TOKEN_FILE);
  if (!reset) {
    try {
      const tok = JSON.parse(fs.readFileSync(file, 'utf8')).token;
      if (typeof tok === 'string' && tok.length >= 32) return tok;
    } catch {
      // ainda não existe
    }
  }
  const token = crypto.randomBytes(24).toString('base64url');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ token, created: Date.now() }), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  return token;
}

/** Compara o cabeçalho Authorization com o token em tempo constante. */
export function authorized(header: string | undefined, token: string): boolean {
  if (!header || !token) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Link para abrir a página: o token vai no fragmento. */
export function remoteLink(base: string, token: string): string {
  return `${base.trim().replace(/\/+$/, '')}/#k=${token}`;
}

export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

export interface RemoteAgent {
  terminal: string;
  agent: string;
  branch: string;
  state?: string;
  message?: string;
  asking?: boolean;
  review?: boolean;
  /** Há quanto tempo está no estado atual (ms). */
  since: number;
  usd?: number;
  tokens?: number;
}

export interface RemoteState {
  now: number;
  repos: { repo: string; agents: RemoteAgent[] }[];
}

const ORDER: Record<string, number> = { waiting: 0, idle: 1, working: 2, starting: 3, ended: 4 };

/** O que a página mostra: sem caminhos absolutos, quem precisa de você primeiro. */
export function remoteState(windows: RegistryWindow[], now = Date.now()): RemoteState {
  const repos = windows
    .filter(w => w.agents.length)
    .map(w => ({
      repo: w.repo || (w.root ? path.basename(w.root) : '?'),
      agents: w.agents
        .map(a => ({
          terminal: a.terminal,
          agent: a.agent,
          branch: a.branch || path.basename(a.worktree),
          state: a.state,
          message: a.message,
          asking: a.asking,
          review: a.review,
          since: Math.max(0, now - (a.stateAt || a.started)),
          usd: a.usd,
          tokens: a.tokens,
        }))
        .sort((a, b) => (ORDER[a.state ?? ''] ?? 5) - (ORDER[b.state ?? ''] ?? 5)),
    }));
  return { now, repos };
}

export interface RemoteServerOptions {
  token: () => string;
  state: () => RemoteState;
  page: () => string;
}

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

/** Servidor da página: GET / (a página) e GET /api/state (com o token). Só leitura. */
export function createRemoteServer(o: RemoteServerOptions): http.Server {
  return http.createServer((req, res) => {
    const send = (status: number, type: string, body: string, extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': type, ...SECURITY_HEADERS, ...extra });
      res.end(body);
    };
    const url = (req.url ?? '/').split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', 'Method not allowed.', { allow: 'GET' });
    try {
      if (url === '/' || url === '/index.html') {
        return send(200, 'text/html; charset=utf-8', o.page(), {
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
        });
      }
      if (url === '/api/state') {
        if (!authorized(req.headers.authorization, o.token())) return send(401, 'application/json', JSON.stringify({ error: 'Access denied.' }));
        return send(200, 'application/json', JSON.stringify(o.state()));
      }
      return send(404, 'text/plain', 'Not found.');
    } catch (e) {
      return send(500, 'text/plain', (e as Error).message);
    }
  });
}

// ---------------------------------------------------------------- push (ntfy)

/**
 * Pedido de publicação no ntfy a partir da URL do tópico (https://ntfy.sh/meu-topico): vai em JSON
 * para a raiz do servidor, que aceita título e texto com acentos (cabeçalhos HTTP não aceitam).
 */
export function ntfyRequest(topicUrl: string, title: string, body: string, click?: string): { url: string; json: Record<string, unknown> } | undefined {
  let u: URL;
  try {
    u = new URL(topicUrl.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
  const parts = u.pathname.split('/').filter(Boolean);
  const topic = parts.pop();
  if (!topic) return undefined;
  const root = `${u.origin}/${parts.join('/')}`.replace(/\/+$/, '') + '/';
  return { url: root, json: { topic, title, message: body, tags: ['robot'], ...(click ? { click } : {}) } };
}

// ---------------------------------------------------------------- página

export interface PageTexts {
  title: string;
  states: Record<string, string>;
  empty: string;
  offline: string;
  denied: string;
  noToken: string;
  updated: string;
  answer: string;
  asking: string;
  review: string;
  yourTurn: string;
  running: string;
  ended: string;
  waitingCount: string;
}

export function remotePage(x: PageTexts, lang = 'en'): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  // dentro de <script>: sem "</" para o texto não fechar a tag
  const json = JSON.stringify(x).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="${esc(lang)}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>${esc(x.title)}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1c1e21;--muted:#65676b;--line:#e2e4e8;--warn:#b45309;--warnbg:#fef3c7;--blue:#2563eb;--green:#15803d}
@media (prefers-color-scheme: dark){:root{--bg:#111315;--card:#1b1e21;--fg:#e8eaed;--muted:#9aa0a6;--line:#2c3035;--warn:#fbbf24;--warnbg:#3a2e0b;--blue:#60a5fa;--green:#4ade80}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px;max-width:720px;margin-inline:auto}
header{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:12px}
h1{font-size:1.25rem;margin:0}
#upd{color:var(--muted);font-size:.8rem}
#sum{margin:0 0 12px;font-weight:600;color:var(--warn)}
h2{font-size:.85rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:18px 0 6px}
.a{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:8px}
.a.waiting{border-color:var(--warn);background:var(--warnbg)}
.top{display:flex;justify-content:space-between;gap:8px}
.br{font-weight:600;overflow-wrap:anywhere}
.st{white-space:nowrap;font-weight:600;font-size:.85rem}
.st.waiting{color:var(--warn)}.st.working,.st.starting{color:var(--blue)}.st.idle{color:var(--green)}.st.ended{color:var(--muted)}
.meta{color:var(--muted);font-size:.85rem;margin-top:2px}
.next{margin-top:4px;overflow-wrap:anywhere}
.msg{padding:24px 0;color:var(--muted);text-align:center}
.err{color:var(--warn)}
</style></head><body>
<header><h1>${esc(x.title)}</h1><span id="upd"></span></header>
<div id="sum"></div><div id="list"><div class="msg">…</div></div>
<script>
const T = ${json};
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f = (s, ...a) => s.replace(/\\{(\\d+)\\}/g, (_, i) => a[i]);
const ago = ms => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; };
const tok = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0);
let key = '';
try { key = localStorage.getItem('agentyard.k') || ''; } catch {}
const m = /[#&]k=([^&]+)/.exec(location.hash);
if (m) {
  key = decodeURIComponent(m[1]);
  try { localStorage.setItem('agentyard.k', key); } catch {}
  history.replaceState(null, '', location.pathname);
}
const list = document.getElementById('list');
const show = html => { list.innerHTML = html; };
function next(a) {
  if (a.state === 'waiting') return a.asking ? T.asking : f(T.answer, a.message || '');
  if (a.state === 'idle') return a.review ? T.review : T.yourTurn;
  if (a.state === 'working' || a.state === 'starting') return T.running;
  if (a.state === 'ended') return T.ended;
  return '';
}
function render(d) {
  const all = d.repos.flatMap(r => r.agents);
  const waiting = all.filter(a => a.state === 'waiting').length;
  document.getElementById('sum').textContent = waiting ? f(T.waitingCount, waiting) : '';
  document.title = (waiting ? '(' + waiting + ') ' : '') + T.title;
  document.getElementById('upd').textContent = f(T.updated, new Date(d.now).toLocaleTimeString());
  if (!all.length) return show('<div class="msg">' + esc(T.empty) + '</div>');
  show(d.repos.map(r => '<h2>' + esc(r.repo) + '</h2>' + r.agents.map(a => {
    const cost = a.usd ? '$' + a.usd.toFixed(2) : a.tokens ? tok(a.tokens) : '';
    return '<div class="a ' + esc(a.state) + '"><div class="top"><span class="br">' + esc(a.branch) + '</span><span class="st ' + esc(a.state) + '">' + esc(T.states[a.state] || '–') + '</span></div>' +
      '<div class="meta">' + esc(a.terminal) + ' · ' + ago(a.since) + (cost ? ' · ' + esc(cost) : '') + '</div>' +
      '<div class="next">' + esc(next(a)) + '</div></div>';
  }).join('')).join(''));
}
let timer;
async function load() {
  clearTimeout(timer);
  if (!key) return show('<div class="msg err">' + esc(T.noToken) + '</div>');
  try {
    const r = await fetch('api/state', { headers: { authorization: 'Bearer ' + key }, cache: 'no-store' });
    if (r.status === 401) return show('<div class="msg err">' + esc(T.denied) + '</div>');
    render(await r.json());
  } catch {
    document.getElementById('upd').innerHTML = '<span class="err">' + esc(T.offline) + '</span>';
  }
  timer = setTimeout(load, document.hidden ? 30000 : 3000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
load();
</script></body></html>`;
}
