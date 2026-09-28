import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentTerminals, stateText } from '../agents';
import type { Controller } from '../controller';
import { locale, t } from '../i18n';
import { readRegistry } from './missionControl';
import { costPerDay, StatusSnapshot } from './statusLine';
import type { ClaudeUsage } from './usage';
import type { ClaudeService } from './view';

interface AgentRow {
  id: string;
  pid: number;
  local: boolean;
  terminal: string;
  where: string;
  state: string;
  model?: string;
  ctx?: number;
  usd?: number;
  added?: number;
  removed?: number;
  durationMs?: number;
  at?: number;
}

/**
 * Tela "Uso do Claude": limites do plano (sessão de 5 h e semana) com o histórico, contexto e custo de
 * cada Claude aberto (de todas as janelas), custo por dia e a estimativa pelos logs. Os números reais
 * vêm da statusline (src/claude/statusLine.ts); sem ela, só a estimativa.
 */
export class UsagePanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private estimate?: Awaited<ReturnType<ClaudeService['estimate']>>;
  private readonly disposables: vscode.Disposable[] = [];
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly ctl: Controller, private readonly agentTerms: AgentTerminals, private readonly usage: ClaudeUsage, private readonly claude: ClaudeService) {}

  private rows(): AgentRow[] {
    const snap = (id: string): Partial<StatusSnapshot> => this.usage.snapshots.get(id) ?? {};
    const row = (id: string, pid: number, terminal: string, worktree: string, branch: string | undefined, state: string | undefined): AgentRow => {
      const s = snap(id);
      return {
        id,
        pid,
        local: pid === process.pid,
        terminal,
        where: branch ?? path.basename(worktree),
        state: state ? stateText(state as never) : '–',
        model: s.model,
        ctx: s.contextPct,
        usd: s.usd,
        added: s.added,
        removed: s.removed,
        durationMs: s.durationMs,
        at: s.at,
      };
    };
    const local = this.agentTerms.list().filter(o => o.claude).map(o => row(o.id, process.pid, o.terminal.name, o.path, o.branch, o.state));
    const others = readRegistry()
      .filter(w => w.pid !== process.pid)
      .flatMap(w => w.agents.filter(a => this.usage.snapshots.has(a.id)).map(a => row(a.id, w.pid, a.terminal, a.worktree, a.branch, a.state)));
    return [...local, ...others];
  }

  private data() {
    const now = Date.now();
    const days = costPerDay(this.usage.history, 7, now);
    return {
      type: 'data',
      now,
      limits: this.usage.limits(now) ?? null,
      samples: this.usage.history.limits,
      agents: this.rows(),
      cost: { days, today: days[days.length - 1].usd, week: days.reduce((a, d) => a + d.usd, 0) },
      estimate: this.estimate ?? null,
      statusLine: this.ctl.cfg().get<string>('claude.statusLine', 'keep'),
    };
  }

  private send() {
    void this.panel?.webview.postMessage(this.data());
  }

  private async refreshEstimate() {
    try {
      this.estimate = await this.claude.estimate();
    } catch (e) {
      this.ctl.log(t('Claude usage: could not read the estimate: {0}', (e as Error).message));
    }
    this.send();
  }

  show() {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('agentyard.claudeUsage', t('Claude usage'), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: false });
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon.svg');
    panel.webview.html = this.html();
    const subs = [this.usage.onDidChange(() => this.send()), this.agentTerms.onDidChange(() => this.send())];
    this.timers = [setInterval(() => this.send(), 30_000), setInterval(() => void this.refreshEstimate(), 60_000)];
    panel.onDidDispose(() => {
      subs.forEach(d => d.dispose());
      this.timers.forEach(clearInterval);
      this.panel = undefined;
    });
    panel.webview.onDidReceiveMessage(async m => {
      if (m?.type === 'ready') {
        this.send();
        return void this.refreshEstimate();
      }
      if (m?.type === 'settings') return void vscode.commands.executeCommand('workbench.action.openSettings', m.query ?? 'worktreeGraph.claude');
      if (m?.type !== 'show') return;
      if (m.pid === process.pid) return this.agentTerms.list().find(o => o.id === m.id)?.terminal.show();
      const w = readRegistry().find(x => x.pid === m.pid);
      const a = w?.agents.find(x => x.id === m.id);
      if (w && a) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(w.root ?? a.worktree), { forceNewWindow: true });
    });
  }

  private html(): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const T = {
      title: t('Claude usage'),
      limits: t('Plan limits'),
      session: t('Session (5 h)'),
      week: t('Week'),
      resets: t('resets {0}'),
      inTime: t('in {0}'),
      updated: t('reported by Claude Code {0}'),
      noLimits: t('No plan limits yet. They arrive with the next response of a Claude Code opened by AgentYard (Pro and Max plans only).'),
      statusOff: t('The AgentYard status line is off (worktreeGraph.claude.statusLine): live usage is not collected.'),
      turnOn: t('Settings'),
      history: t('History'),
      h24: t('24 h'),
      d7: t('7 days'),
      noHistory: t('The chart fills in as Claude Code reports usage.'),
      agents: t('Open Claude Code'),
      agent: t('Agent'),
      worktree: t('Worktree'),
      state: t('State'),
      model: t('Model'),
      context: t('Context'),
      cost: t('Cost'),
      lines: t('Lines'),
      time: t('Time'),
      go: t('Go to'),
      other: t('open window'),
      noAgents: t('No Claude Code open by AgentYard.'),
      waiting: t('waiting for the first response'),
      spend: t('Cost (API-equivalent)'),
      today: t('Today'),
      last7: t('Last 7 days'),
      costNote: t('What these sessions would cost on the API. On Pro/Max plans the limits above are what counts.'),
      estimate: t('Estimate from local logs'),
      window: t('5 h window'),
      noWindow: t('No active window'),
      since: t('Since Monday'),
      tokens: t('{0} tokens'),
      responses: t('{0} responses'),
      perDay: t('Per day'),
      topWt: t('Worktrees that used the most this week'),
      budgets: t('Configure budgets and week'),
      ago: t('{0} ago'),
      now: t('now'),
    };
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
:root{--s1:var(--vscode-charts-blue);--s2:var(--vscode-charts-purple);--ok:var(--vscode-charts-green);--warn:var(--vscode-charts-yellow);--bad:var(--vscode-charts-red);--muted:var(--vscode-descriptionForeground);--line:var(--vscode-editorWidget-border,#8884)}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:12px 16px;max-width:1100px}
h1{font-size:1.3em;margin:0 0 12px}
h2{font-size:1.05em;margin:22px 0 8px;display:flex;align-items:center;gap:10px}
.muted{color:var(--muted)}
.meters{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
.meter{border:1px solid var(--line);border-radius:6px;padding:10px 12px}
.meter .top{display:flex;justify-content:space-between;align-items:baseline}
.meter .pct{font-size:1.9em;font-weight:600;font-variant-numeric:tabular-nums}
.bar{height:8px;border-radius:4px;background:var(--vscode-input-background,#8882);margin:8px 0 6px;overflow:hidden}
.bar>span{display:block;height:100%;border-radius:4px}
.lvl-ok{background:var(--ok)}.lvl-warn{background:var(--warn)}.lvl-bad{background:var(--bad)}
.tag{font-size:.85em;padding:1px 6px;border-radius:8px;border:1px solid var(--line);color:var(--muted)}
.chart{position:relative;border:1px solid var(--line);border-radius:6px;padding:8px 8px 4px}
.chart svg{display:block;width:100%;height:190px}
.tip{position:absolute;pointer-events:none;background:var(--vscode-editorHoverWidget-background);border:1px solid var(--vscode-editorHoverWidget-border,var(--line));padding:4px 8px;border-radius:4px;font-size:.9em;white-space:nowrap;display:none}
.legend{display:flex;gap:14px;font-size:.9em;color:var(--muted);margin:4px 2px}
.sw{display:inline-block;width:10px;height:3px;border-radius:2px;vertical-align:middle;margin-right:5px}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
th{font-weight:600;color:var(--muted)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.mini{display:inline-block;width:60px;height:6px;border-radius:3px;background:var(--vscode-input-background,#8882);vertical-align:middle;margin-right:6px;overflow:hidden}
.mini>span{display:block;height:100%}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
.card{border:1px solid var(--line);border-radius:6px;padding:8px 12px}
.card .v{font-size:1.5em;font-weight:600;font-variant-numeric:tabular-nums}
.days{max-width:760px;display:grid;grid-template-columns:auto 1fr auto;gap:4px 10px;align-items:center;font-variant-numeric:tabular-nums;margin-top:10px}
.days .b{height:10px;border-radius:0 4px 4px 0;background:var(--s1);min-width:1px}
button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;padding:2px 8px;border-radius:2px;cursor:pointer}
button:hover{background:var(--vscode-button-secondaryHoverBackground)}
button.on{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.seg{display:inline-flex;gap:2px;font-weight:normal}
.note{margin:8px 0;padding:8px 10px;border-left:3px solid var(--vscode-textLink-foreground);background:var(--vscode-textBlockQuote-background)}
</style></head><body>
<h1>${T.title}</h1>
<div id="limits"></div>
<h2>${T.history}<span class="seg"><button data-range="24">${T.h24}</button><button data-range="168">${T.d7}</button></span></h2>
<div class="chart" id="chart"><div class="legend"><span><span class="sw" style="background:var(--s1)"></span>${T.session}</span><span><span class="sw" style="background:var(--s2)"></span>${T.week}</span></div><svg id="svg" role="img" aria-label="${T.history}"></svg><div class="tip" id="tip"></div></div>
<h2>${T.agents}</h2><div id="agents"></div>
<h2>${T.spend}</h2><div id="cost"></div>
<h2>${T.estimate}</h2><div id="estimate"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const T = ${JSON.stringify(T)};
const L = ${JSON.stringify(locale())};
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f = (s, ...a) => s.replace(/\\{(\\d+)\\}/g, (_, i) => a[i]);
const lvl = p => p >= 80 ? 'bad' : p >= 50 ? 'warn' : 'ok';
const dur = ms => { const m = Math.max(0, Math.round(ms / 60000)); if (m < 60) return m + ' min'; const h = Math.floor(m / 60); return h < 48 ? h + ' h ' + (m % 60) + ' min' : Math.floor(h / 24) + ' d ' + (h % 24) + ' h'; };
const ago = (ms, now) => now - ms < 60000 ? T.now : f(T.ago, dur(now - ms));
const when = ms => new Date(ms).toLocaleString(L, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const tok = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n || 0);
const usd = n => '$' + (n || 0).toFixed(2);
let range = 24, last;
try { range = vscode.getState()?.range || 24; } catch {}

function meter(label, r, now) {
  if (!r) return '';
  const p = Math.round(r.pct);
  const reset = r.resetsAt ? f(T.resets, when(r.resetsAt)) + ' · ' + f(T.inTime, dur(r.resetsAt - now)) : '';
  return '<div class="meter"><div class="top"><span>' + esc(label) + '</span><span class="pct">' + p + '%</span></div>' +
    '<div class="bar" role="meter" aria-valuenow="' + p + '" aria-valuemin="0" aria-valuemax="100"><span class="lvl-' + lvl(p) + '" style="width:' + Math.min(100, p) + '%"></span></div>' +
    '<div class="muted">' + esc(reset) + '</div></div>';
}

function renderLimits(d) {
  const el = document.getElementById('limits');
  if (d.statusLine === 'off') { el.innerHTML = '<div class="note">' + esc(T.statusOff) + ' <button data-settings="worktreeGraph.claude.statusLine">' + esc(T.turnOn) + '</button></div>'; return; }
  const l = d.limits;
  if (!l || (!l.fiveHour && !l.sevenDay)) { el.innerHTML = '<div class="note">' + esc(T.noLimits) + '</div>'; return; }
  el.innerHTML = '<h2 style="margin-top:0">' + esc(T.limits) + ' <span class="tag">' + esc(f(T.updated, ago(l.at, d.now))) + '</span></h2><div class="meters">' + meter(T.session, l.fiveHour, d.now) + meter(T.week, l.sevenDay, d.now) + '</div>';
}

function renderChart(d) {
  const svg = document.getElementById('svg');
  document.querySelectorAll('[data-range]').forEach(b => b.classList.toggle('on', Number(b.dataset.range) === range));
  const W = svg.clientWidth || 600, H = 190, pl = 34, pr = 70, pt = 8, pb = 22;
  const t1 = d.now, t0 = t1 - range * 3600000;
  const pts = d.samples.filter(s => s.at >= t0);
  const x = ms => pl + (ms - t0) / (t1 - t0) * (W - pl - pr);
  const y = p => pt + (1 - Math.min(100, p) / 100) * (H - pt - pb);
  let g = '';
  for (const v of [0, 50, 80, 100]) g += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="var(--line)" stroke-width="1"' + (v === 80 ? ' stroke-dasharray="3 3"' : '') + '/><text x="' + (pl - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end" font-size="10" fill="var(--muted)">' + v + '%</text>';
  const ticks = range <= 24 ? 6 : 7;
  for (let i = 0; i <= ticks; i++) {
    const ms = t0 + (t1 - t0) * i / ticks;
    const lab = range <= 24 ? new Date(ms).toLocaleTimeString(L, { hour: '2-digit', minute: '2-digit' }) : new Date(ms).toLocaleDateString(L, { weekday: 'short' });
    g += '<text x="' + x(ms) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="10" fill="var(--muted)">' + esc(lab) + '</text>';
  }
  if (!pts.length) { svg.innerHTML = g + '<text x="' + (W / 2) + '" y="' + (H / 2) + '" text-anchor="middle" fill="var(--muted)">' + esc(T.noHistory) + '</text>'; return; }
  // degraus: o valor vale até a próxima amostra; o último se estende até agora
  const path = key => { let p = '', prev; for (const s of pts) { if (s[key] == null) continue; p += (p ? 'H' + x(s.at) + 'V' : 'M' + x(s.at) + ',') + y(s[key]); prev = s[key]; } return p ? { d: p + 'H' + x(t1), v: prev } : null; };
  const lines = [['five', 'var(--s1)', T.session], ['seven', 'var(--s2)', T.week]].map(([k, c, n]) => ({ k, c, n, p: path(k) })).filter(l => l.p);
  for (const l of lines) g += '<path d="' + l.p.d + '" fill="none" stroke="' + l.c + '" stroke-width="2" stroke-linejoin="round"/>';
  // rótulos diretos no fim, sem sobrepor
  const ends = lines.map(l => ({ ...l, ty: y(l.p.v) + 4 })).sort((a, b) => a.ty - b.ty);
  for (let i = 1; i < ends.length; i++) if (ends[i].ty - ends[i - 1].ty < 12) ends[i].ty = ends[i - 1].ty + 12;
  for (const l of ends) g += '<text x="' + (W - pr + 6) + '" y="' + l.ty + '" font-size="11" fill="var(--vscode-foreground)">' + Math.round(l.p.v) + '% ' + esc(l.k === 'five' ? '5h' : '7d') + '</text>';
  g += '<line id="cross" y1="' + pt + '" y2="' + (H - pb) + '" stroke="var(--muted)" stroke-width="1" visibility="hidden"/><rect id="hit" x="' + pl + '" y="0" width="' + (W - pl - pr) + '" height="' + H + '" fill="transparent"/>';
  svg.innerHTML = g;
  const tip = document.getElementById('tip'), cross = document.getElementById('cross');
  const hit = document.getElementById('hit');
  hit.addEventListener('mousemove', e => {
    const r = svg.getBoundingClientRect(), px = e.clientX - r.left, ms = t0 + (px - pl) / (W - pl - pr) * (t1 - t0);
    let s = null; for (const p of pts) if (p.at <= ms) s = p;
    if (!s) { tip.style.display = 'none'; cross.setAttribute('visibility', 'hidden'); return; }
    cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
    tip.innerHTML = esc(new Date(ms).toLocaleString(L, { weekday: 'short', hour: '2-digit', minute: '2-digit' })) + '<br><span class="sw" style="background:var(--s1)"></span>' + esc(T.session) + ': <b>' + (s.five ?? '–') + '%</b><br><span class="sw" style="background:var(--s2)"></span>' + esc(T.week) + ': <b>' + (s.seven ?? '–') + '%</b>';
    tip.style.display = 'block';
    tip.style.left = Math.min(px + 14, W - tip.offsetWidth) + 'px'; tip.style.top = '28px';
  });
  hit.addEventListener('mouseleave', () => { tip.style.display = 'none'; cross.setAttribute('visibility', 'hidden'); });
}

function renderAgents(d) {
  const el = document.getElementById('agents');
  if (!d.agents.length) { el.innerHTML = '<div class="muted">' + esc(T.noAgents) + '</div>'; return; }
  const rows = d.agents.map(a => {
    const ctx = a.ctx == null ? '<span class="muted">' + esc(T.waiting) + '</span>' : '<span class="mini"><span class="lvl-' + lvl(a.ctx) + '" style="width:' + Math.min(100, a.ctx) + '%"></span></span>' + Math.round(a.ctx) + '%';
    const lines = a.added || a.removed ? '+' + (a.added || 0) + ' −' + (a.removed || 0) : '–';
    return '<tr><td>' + esc(a.terminal) + '</td><td>' + esc(a.where) + '</td><td>' + esc(a.state) + '</td><td>' + esc(a.model || '–') + '</td><td>' + ctx + '</td>' +
      '<td class="num">' + (a.usd == null ? '–' : usd(a.usd)) + '</td><td class="num">' + lines + '</td><td class="num">' + (a.durationMs ? dur(a.durationMs) : '–') + '</td>' +
      '<td><button data-pid="' + a.pid + '" data-id="' + esc(a.id) + '">' + esc(a.local ? T.go : T.other) + '</button></td></tr>';
  }).join('');
  el.innerHTML = '<table><tr><th>' + esc(T.agent) + '</th><th>' + esc(T.worktree) + '</th><th>' + esc(T.state) + '</th><th>' + esc(T.model) + '</th><th>' + esc(T.context) + '</th><th class="num">' + esc(T.cost) + '</th><th class="num">' + esc(T.lines) + '</th><th class="num">' + esc(T.time) + '</th><th></th></tr>' + rows + '</table>';
}

function bars(list, fmt) {
  const max = Math.max(1e-9, ...list.map(x => x.v));
  return '<div class="days">' + list.map(x => '<span class="muted">' + esc(x.k) + '</span><span><span class="b" style="display:block;width:' + (x.v / max * 100) + '%"></span></span><span>' + esc(fmt(x.v)) + '</span>').join('') + '</div>';
}
const dayLabel = k => new Date(k + 'T12:00:00').toLocaleDateString(L, { weekday: 'short', day: '2-digit' });

function renderCost(d) {
  document.getElementById('cost').innerHTML = '<div class="cards"><div class="card"><div class="muted">' + esc(T.today) + '</div><div class="v">' + usd(d.cost.today) + '</div></div>' +
    '<div class="card"><div class="muted">' + esc(T.last7) + '</div><div class="v">' + usd(d.cost.week) + '</div></div></div>' +
    bars(d.cost.days.map(x => ({ k: dayLabel(x.day), v: x.usd })), usd) + '<p class="muted">' + esc(T.costNote) + '</p>';
}

function renderEstimate(d) {
  const e = d.estimate, el = document.getElementById('estimate');
  if (!e) { el.innerHTML = '<div class="muted">…</div>'; return; }
  const pct = (n, of) => of > 0 ? ' (' + Math.round(n / of * 100) + '%)' : '';
  el.innerHTML = '<div class="cards"><div class="card"><div class="muted">' + esc(T.window) + '</div><div class="v">' + (e.block ? tok(e.block.tokens) + pct(e.block.tokens, e.budgets.session) : '–') + '</div><div class="muted">' +
    esc(e.block ? f(T.responses, e.block.responses) + ' · ' + f(T.resets, when(e.block.end)) : T.noWindow) + '</div></div>' +
    '<div class="card"><div class="muted">' + esc(e.week.monday ? T.since : T.last7) + '</div><div class="v">' + tok(e.week.tokens) + pct(e.week.tokens, e.budgets.week) + '</div><div class="muted">' + esc(f(T.responses, e.week.responses)) + '</div></div></div>' +
    '<h2 style="font-size:1em">' + esc(T.perDay) + '</h2>' + bars(e.days.map(x => ({ k: dayLabel(x.day), v: x.tokens })), tok) +
    (e.perWt.length ? '<h2 style="font-size:1em">' + esc(T.topWt) + '</h2>' + bars(e.perWt.map(x => ({ k: x.name, v: x.tokens })), tok) : '') +
    '<p><button data-settings="worktreeGraph.claude">' + esc(T.budgets) + '</button></p>';
}

function render(d) { renderLimits(d); renderChart(d); renderAgents(d); renderCost(d); renderEstimate(d); }
window.addEventListener('message', e => { if (e.data.type === 'data') { last = e.data; render(last); } });
window.addEventListener('resize', () => last && renderChart(last));
document.addEventListener('click', e => {
  const r = e.target.closest('[data-range]');
  if (r) { range = Number(r.dataset.range); try { vscode.setState({ range }); } catch {} if (last) renderChart(last); return; }
  const s = e.target.closest('[data-settings]');
  if (s) return vscode.postMessage({ type: 'settings', query: s.dataset.settings });
  const b = e.target.closest('button[data-id]');
  if (b) vscode.postMessage({ type: 'show', pid: Number(b.dataset.pid), id: b.dataset.id });
});
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
  }

  dispose() {
    this.timers.forEach(clearInterval);
    this.panel?.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
