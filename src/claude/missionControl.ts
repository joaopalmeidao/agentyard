import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentTerminals, OpenAgent } from '../agents';
import { stateText } from '../agents';
import { keyOf } from '../agentFlow/head';
import { bridgeHome } from '../bridge/core';
import type { Controller } from '../controller';
import { t } from '../i18n';

/** Um agente como aparece no registro compartilhado entre as janelas. */
export interface RegistryAgent {
  id: string;
  terminal: string;
  agent: string;
  worktree: string;
  branch?: string;
  state?: string;
  message?: string;
  started: number;
  stateAt?: number;
  asking?: boolean;
  tokens?: number;
  usd?: number;
  review?: boolean;
}

export interface RegistryWindow {
  pid: number;
  repo?: string;
  root?: string;
  updated: number;
  agents: RegistryAgent[];
}

const STALE_MS = 120_000;

function registryDir(home = bridgeHome()) {
  return path.join(home, 'agents');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Janelas com agentes (a desta primeiro); apaga registros de processos mortos ou velhos. */
export function readRegistry(home = bridgeHome(), now = Date.now(), isAlive = alive): RegistryWindow[] {
  const dir = registryDir(home);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter(n => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: RegistryWindow[] = [];
  for (const n of names) {
    const f = path.join(dir, n);
    try {
      const w = JSON.parse(fs.readFileSync(f, 'utf8')) as RegistryWindow;
      if (!isAlive(w.pid) || now - w.updated > STALE_MS * 3) {
        fs.rmSync(f, { force: true });
        continue;
      }
      out.push(w);
    } catch {
      // sendo escrito
    }
  }
  return out.sort((a, b) => (a.pid === process.pid ? -1 : b.pid === process.pid ? 1 : (a.repo ?? '').localeCompare(b.repo ?? '')));
}

export function writeRegistry(w: RegistryWindow, home = bridgeHome()) {
  const dir = registryDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${w.pid}.json`);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(w));
  fs.renameSync(`${f}.tmp`, f);
}

/**
 * Mission control: todos os agentes de todas as janelas do VS Code numa tela só, com estado, há quanto
 * tempo, custo e o que fazer a seguir. Cada janela publica os seus em ~/.agentyard/agents/<pid>.json.
 */
export class MissionControl implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private timer?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly ctl: Controller, private readonly agentTerms: AgentTerminals) {
    const publish = () => this.publish();
    this.disposables.push(agentTerms.onDidChange(publish), agentTerms.onDidChangeState(publish), ctl.onDidChange(publish));
    this.heartbeat = setInterval(publish, 30_000);
    publish();
  }

  private toRegistry(o: OpenAgent): RegistryAgent {
    const w = this.ctl.state?.worktrees.find(x => keyOf(x.path) === keyOf(o.path));
    return {
      id: o.id,
      terminal: o.terminal.name,
      agent: o.agent,
      worktree: o.path,
      branch: o.branch,
      state: o.state,
      message: o.message,
      started: o.started,
      stateAt: o.stateAt,
      asking: o.asking,
      tokens: w?.claude?.tokens,
      usd: w?.claude?.usd,
      review: !!w?.review,
    };
  }

  private publish() {
    try {
      const agents = this.agentTerms.list().map(o => this.toRegistry(o));
      const file = path.join(registryDir(), `${process.pid}.json`);
      if (!agents.length) {
        fs.rmSync(file, { force: true });
        return;
      }
      writeRegistry({ pid: process.pid, repo: this.ctl.state?.repoName, root: this.ctl.repo?.root, updated: Date.now(), agents });
    } catch (e) {
      this.ctl.log(t('Mission control: could not publish the agents of this window: {0}', (e as Error).message));
    }
  }

  show() {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('agentyard.missionControl', t('Mission control'), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: false });
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon.svg');
    panel.webview.html = this.html(panel.webview);
    const send = () => void panel.webview.postMessage({ type: 'data', pid: process.pid, windows: readRegistry(), now: Date.now() });
    this.timer = setInterval(send, 2000);
    panel.onDidDispose(() => {
      if (this.timer) clearInterval(this.timer);
      this.panel = undefined;
    });
    panel.webview.onDidReceiveMessage(async m => {
      if (m?.type === 'ready') return send();
      const win = readRegistry().find(w => w.pid === m?.pid);
      const a = win?.agents.find(x => x.id === m?.id);
      if (!win || !a) return;
      if (win.pid !== process.pid) {
        // agente de outra janela: abrir a pasta foca a janela que já está com ela aberta
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(win.root ?? a.worktree), { forceNewWindow: true });
        return;
      }
      const o = this.agentTerms.list().find(x => x.id === a.id);
      if (m.type === 'show') o?.terminal.show();
      else if (m.type === 'turns') await vscode.commands.executeCommand('worktreeGraph.turns.pick', { path: a.worktree });
    });
    send();
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const texts = {
      agent: t('Agent'),
      worktree: t('Worktree'),
      state: t('State'),
      since: t('For'),
      next: t('Next'),
      cost: t('Cost'),
      go: t('Go to'),
      turns: t('Turns'),
      other: t('open window'),
      empty: t('No agent open in any VS Code window.'),
      answer: t('answer: {0}'),
      asking: t('asking in VS Code'),
      review: t('review the changes'),
      yourTurn: t('your turn: send the next message'),
      running: t('let it work'),
      ended: t('close the terminal'),
      total: t('{0} agent(s)'),
      thisWindow: t('this window'),
    };
    const labels = {
      starting: stateText('starting'),
      working: stateText('working'),
      waiting: stateText('waiting'),
      idle: stateText('idle'),
      ended: stateText('ended'),
    };
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:12px 16px}
h1{font-size:1.3em;margin:0 0 8px}
.sum{display:flex;gap:10px;flex-wrap:wrap;margin:6px 0 16px}
.chip{padding:3px 10px;border-radius:10px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
.chip.waiting{background:var(--vscode-inputValidation-warningBackground);color:var(--vscode-foreground)}
h2{font-size:1.05em;margin:18px 0 6px;color:var(--vscode-descriptionForeground)}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--vscode-editorWidget-border,#8884);vertical-align:top}
th{font-weight:600;color:var(--vscode-descriptionForeground)}
td.num{text-align:right;font-variant-numeric:tabular-nums}
.st{font-weight:600}
.st.waiting{color:var(--vscode-editorWarning-foreground)}
.st.working{color:var(--vscode-charts-blue)}
.st.idle{color:var(--vscode-charts-green)}
.st.ended{color:var(--vscode-disabledForeground)}
.next{color:var(--vscode-descriptionForeground)}
button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;padding:2px 8px;border-radius:2px;cursor:pointer;margin-right:4px}
button:hover{background:var(--vscode-button-secondaryHoverBackground)}
.empty{color:var(--vscode-descriptionForeground);margin-top:24px}
</style></head><body>
<h1>${t('Mission control')}</h1><div class="sum" id="sum"></div><div id="list"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const S = ${JSON.stringify(labels)};
const T = ${JSON.stringify(texts)};
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f = (s, ...a) => s.replace(/\\{(\\d+)\\}/g, (_, i) => a[i]);
const ago = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; };
const tok = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0);
function next(a) {
  if (a.state === 'waiting') return a.asking ? T.asking : f(T.answer, a.message || '');
  if (a.state === 'idle') return a.review ? T.review : T.yourTurn;
  if (a.state === 'working' || a.state === 'starting') return T.running;
  if (a.state === 'ended') return T.ended;
  return '';
}
window.addEventListener('message', e => {
  const d = e.data; if (d.type !== 'data') return;
  const all = d.windows.flatMap(w => w.agents.map(a => ({ ...a, pid: w.pid })));
  const n = st => all.filter(a => a.state === st).length;
  document.getElementById('sum').innerHTML = [
    '<span class="chip">' + f(T.total, all.length) + '</span>',
    n('waiting') ? '<span class="chip waiting">' + n('waiting') + ' ' + esc(S.waiting) + '</span>' : '',
    n('working') ? '<span class="chip">' + n('working') + ' ' + esc(S.working) + '</span>' : '',
    n('idle') ? '<span class="chip">' + n('idle') + ' ' + esc(S.idle) + '</span>' : '',
  ].join('');
  if (!all.length) { document.getElementById('list').innerHTML = '<div class="empty">' + esc(T.empty) + '</div>'; return; }
  const order = { waiting: 0, idle: 1, working: 2, starting: 3, ended: 4 };
  document.getElementById('list').innerHTML = d.windows.filter(w => w.agents.length).map(w => {
    const rows = [...w.agents].sort((a, b) => (order[a.state] ?? 5) - (order[b.state] ?? 5)).map(a => {
      const since = d.now - (a.stateAt || a.started);
      const cost = a.usd ? '$' + a.usd.toFixed(2) : a.tokens ? tok(a.tokens) : '–';
      const local = w.pid === d.pid;
      return '<tr><td>' + esc(a.terminal) + '</td><td>' + esc(a.branch || a.worktree) + '</td><td class="st ' + esc(a.state || '') + '">' + esc(S[a.state] || '–') + '</td>' +
        '<td class="num">' + ago(since) + '</td><td class="next">' + esc(next(a)) + '</td><td class="num">' + esc(cost) + '</td><td>' +
        '<button data-t="show" data-pid="' + w.pid + '" data-id="' + esc(a.id) + '">' + esc(local ? T.go : T.other) + '</button>' +
        (local ? '<button data-t="turns" data-pid="' + w.pid + '" data-id="' + esc(a.id) + '">' + esc(T.turns) + '</button>' : '') + '</td></tr>';
    }).join('');
    return '<h2>' + esc(w.repo || w.root || '?') + (w.pid === d.pid ? ' · ' + esc(T.thisWindow) : '') + '</h2><table><tr><th>' + esc(T.agent) + '</th><th>' + esc(T.worktree) + '</th><th>' + esc(T.state) +
      '</th><th>' + esc(T.since) + '</th><th>' + esc(T.next) + '</th><th>' + esc(T.cost) + '</th><th></th></tr>' + rows + '</table>';
  }).join('');
});
document.addEventListener('click', e => { const b = e.target.closest('button[data-t]'); if (b) vscode.postMessage({ type: b.dataset.t, pid: Number(b.dataset.pid), id: b.dataset.id }); });
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    try {
      fs.rmSync(path.join(registryDir(), `${process.pid}.json`), { force: true });
    } catch {
      // já saiu
    }
    this.panel?.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
