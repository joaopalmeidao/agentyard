import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { locale, t } from './i18n';
import { ActivityReport, buildActivity, commitsIn, costPerTask, hasPrices, Prices, rangeOf, RangeId, TaskCost } from './activity';
import type { ClaudeService } from './claude/view';
import type { Controller } from './controller';
import type { ChangeRequest } from './hosting/core';
import type { Pipeline } from './hosting/pipelines';

type Guard = <T extends unknown[]>(fn: (...args: T) => unknown) => (...args: T) => Promise<void>;

export interface ActivityDeps {
  claude: ClaudeService;
  /** Pipelines conhecidos (a view de pipelines pode não ter dados sem remoto). */
  pipelines?: () => Pipeline[];
  /** Issue ligada à branch (vínculo salvo pela view de issues). */
  issueOf?: (branch: string) => { key: string; title: string; url: string } | undefined;
}

export interface ActivityData {
  report: ActivityReport;
  costs: TaskCost[];
  requests: ChangeRequest[];
  failedPipelines: Pipeline[];
  prices: Prices;
}

export class ActivityService implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private range: RangeId = 'today';
  /** Última renderização (os testes leem daqui). */
  last?: ActivityData;

  constructor(private readonly ctl: Controller, private readonly deps: ActivityDeps) {
    // Custo estimado da worktree no chip do Claude (só com preços configurados).
    ctl.stateHooks.push(s => {
      const prices = this.prices();
      if (!hasPrices(prices)) return;
      const worktrees = s.worktrees.map(w => ({ path: w.path, branch: w.branch }));
      const costs = new Map(costPerTask(this.deps.claude.sessions, worktrees, () => undefined, prices).map(c => [c.branch, c]));
      for (const w of s.worktrees) {
        const c = w.branch ? costs.get(w.branch) : undefined;
        if (w.claude && c?.usd !== undefined) w.claude.usd = c.usd;
      }
    });
  }

  prices(): Prices {
    const c = this.ctl.cfg();
    return {
      input: c.get<number>('claude.pricePerMTokInput', 0),
      output: c.get<number>('claude.pricePerMTokOutput', 0),
      cacheRead: c.get<number>('claude.pricePerMTokCacheRead', 0),
    };
  }

  /** Commits (um processo git), sessões, PRs/MRs e pipelines do período, mais o custo por tarefa. */
  async compute(id: RangeId): Promise<ActivityData> {
    const range = rangeOf(id);
    const repo = this.ctl.repo;
    const worktrees = (this.ctl.state?.worktrees ?? []).filter(w => !w.prunable).map(w => ({ path: w.path, branch: w.branch }));
    const commits = repo ? await commitsIn(repo, range.from, range.to) : [];
    const sessions = this.deps.claude.sessions;
    const report = buildActivity(range, commits, sessions, worktrees);
    const prices = this.prices();
    const reqs = [...this.ctl.requests.byBranch.values()];
    const costs = costPerTask(
      sessions,
      worktrees,
      b => {
        const i = this.deps.issueOf?.(b);
        if (i) return { ...i, kind: 'issue' };
        const r = this.ctl.requests.byBranch.get(b);
        return r ? { key: r.ref, title: r.title, url: r.url, kind: 'pr' } : undefined;
      },
      prices,
    );
    const failedPipelines = (this.deps.pipelines?.() ?? []).filter(p => p.status === 'failed' && p.updatedAt * 1000 >= range.from && p.updatedAt * 1000 < range.to);
    this.last = { report, costs, requests: reqs, failedPipelines, prices };
    return this.last;
  }

  async open(id?: RangeId) {
    if (id) this.range = id;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('worktreeGraph.activity', t('Activity'), vscode.ViewColumn.Active, {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.ctl.ctx.extensionUri, 'media')],
      });
      this.panel.iconPath = vscode.Uri.joinPath(this.ctl.ctx.extensionUri, 'media', 'icon.svg');
      this.panel.onDidDispose(() => (this.panel = undefined));
      this.panel.webview.onDidReceiveMessage(async m => {
        if (m.action === 'range') await this.open(m.value);
        if (m.action === 'url') await vscode.env.openExternal(vscode.Uri.parse(m.value));
        if (m.action === 'worktree') await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(m.value), { forceNewWindow: true });
        if (m.action === 'prices') await vscode.commands.executeCommand('workbench.action.openSettings', 'worktreeGraph.claude.pricePerMTok');
      });
    }
    this.panel.webview.html = this.html(`<div class="empty">${t('Calculating…')}</div>`);
    this.panel.reveal();
    const data = await this.compute(this.range);
    if (this.panel) this.panel.webview.html = this.html(this.body(data));
  }

  private body(d: ActivityData): string {
    const { report: r, costs } = d;
    const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
    const tok = (n: number) => (n >= 1e6 ? t('{0}M', (n / 1e6).toLocaleString(locale(), { maximumFractionDigits: 1, minimumFractionDigits: 1 })) : n >= 1e3 ? t('{0}K', Math.round(n / 1e3)) : String(n));
    const usd = (n?: number) => (n === undefined ? '' : `≈ US$ ${n.toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    const priced = hasPrices(d.prices);

    // gráfico de barras: tokens (barra) e commits (marcador), cada um na sua escala
    const W = 720;
    const H = 150;
    const n = r.chart.length;
    const bw = W / n;
    const maxT = Math.max(1, ...r.chart.map(c => c.tokens));
    const maxC = Math.max(1, ...r.chart.map(c => c.commits));
    const bars = r.chart
      .map((c, i) => {
        const h = (c.tokens / maxT) * (H - 30);
        const y = H - 18 - h;
        const cy = H - 18 - (c.commits / maxC) * (H - 30);
        return `<g><title>${esc(t('{0}: {1} tokens, {2} commit(s)', c.label, tok(c.tokens), c.commits))}</title>
          <rect x="${i * bw + 3}" y="${y}" width="${bw - 6}" height="${h}" rx="2" fill="var(--agent-color, #b180d7)" opacity=".75"/>
          ${c.commits ? `<circle cx="${i * bw + bw / 2}" cy="${cy}" r="4" fill="var(--info)"/>` : ''}
          ${n <= 7 || i % 3 === 0 ? `<text x="${i * bw + bw / 2}" y="${H - 4}" text-anchor="middle" font-size="10" fill="var(--muted)">${esc(c.label)}</text>` : ''}</g>`;
      })
      .join('');

    const rows = r.rows
      .map(
        x => `<tr><td class="p">${x.worktree ? `<a href="#" data-worktree="${esc(x.worktree)}" title="${esc(t('Open this worktree in a new window'))}">${esc(x.branch)}</a>` : esc(x.branch)}</td>
          <td class="num">${x.commits}</td><td class="num">${x.files}</td>
          <td class="num"><span class="add">+${x.added}</span> <span class="del">−${x.deleted}</span></td>
          <td class="num">${x.sessions}</td><td class="num">${tok(x.tokens)}</td></tr>`,
      )
      .join('');
    const costRows = costs
      .slice(0, 40)
      .map(
        c => `<tr><td>${c.task ? `<a href="#" data-url="${esc(c.task.url)}">${esc(c.task.key)}</a> <span class="muted">${esc(c.task.title)}</span>` : '<span class="muted">—</span>'}</td>
          <td class="p">${esc(c.branch)}</td><td class="num">${c.sessions}</td><td class="num">${tok(c.tokens)}</td><td class="num">${priced ? usd(c.usd) : ''}</td></tr>`,
      )
      .join('');
    const reqs = d.requests
      .filter(q => q.state === 'open' || q.state === 'draft')
      .map(q => `<li><a href="#" data-url="${esc(q.url)}">${esc(q.ref)}</a> ${esc(q.title)} <span class="muted">${esc(q.source)} → ${esc(q.target)}${q.state === 'draft' ? ` · ${t('draft')}` : ''}</span></li>`)
      .join('');
    const fails = d.failedPipelines.map(p => `<li><a href="#" data-url="${esc(p.url)}">✗ ${esc(p.name)}</a> <span class="muted">${esc(p.branch)}</span></li>`).join('');
    const btn = (id: RangeId, label: string) => `<button data-range="${id}" class="${r.range.id === id ? 'on' : ''}">${label}</button>`;
    const byHour = r.range.unit === 'hour';
    return `<header class="toolbar"><div class="title"><span class="repo">${esc(t('Activity'))}</span> <span class="muted">${esc(this.ctl.state?.repoName ?? '')} · ${esc(r.range.label)}</span></div>
      <div class="tools"><span class="seg">${btn('today', esc(t('Today')))}${btn('yesterday', esc(t('Yesterday')))}${btn('week', esc(t('7 days')))}</span></div></header>
      <div class="stats">
        <div><b>${r.totals.commits}</b><span>commits</span></div>
        <div><b>${r.totals.files}</b><span>${esc(t('files'))} (<span class="add">+${r.totals.added}</span> <span class="del">−${r.totals.deleted}</span>)</span></div>
        <div><b>${r.totals.sessions}</b><span>${esc(t('Claude sessions with usage in the period'))}</span></div>
        <div><b>${tok(r.totals.tokens)}</b><span>${esc(t('tokens (input + output + cache creation)'))}</span></div>
      </div>
      <section><h2>${esc(byHour ? t('By hour') : t('By day'))}<span class="hint">${esc(t('bar = tokens · dot = commits'))}</span></h2>
        <svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px" role="img" aria-label="${esc(byHour ? t('Tokens and commits by hour') : t('Tokens and commits by day'))}">${bars}</svg></section>
      <section><h2>${esc(t('By worktree and branch'))} <span class="count">${r.rows.length}</span></h2>
        <table class="files"><tr class="muted"><td>branch</td><td class="num">commits</td><td class="num">${esc(t('files'))}</td><td class="num">${esc(t('lines'))}</td><td class="num">${esc(t('sessions'))}</td><td class="num">tokens</td></tr>${rows || `<tr><td class="muted">${esc(t('Nothing in the period.'))}</td></tr>`}</table></section>
      <section><h2>${esc(t('Cost per task'))} <span class="count">${costs.length}</span>
        <span class="hint">${priced ? esc(t('estimate from local logs and the configured prices; the exact amount is on your invoice')) : t('{0} to see the estimated cost in US$', `<a href="#" id="prices">${esc(t('set the price per million tokens'))}</a>`)}</span></h2>
        <table class="files"><tr class="muted"><td>issue / PR</td><td>branch</td><td class="num">${esc(t('sessions'))}</td><td class="num">tokens</td><td class="num">${priced ? esc(t('cost')) : ''}</td></tr>${costRows || `<tr><td class="muted">${esc(t('No Claude session linked to a branch.'))}</td></tr>`}</table></section>
      <section class="cols2"><div><h2>${esc(t('Open PRs/MRs'))}</h2><ul class="plain">${reqs || `<li class="muted">${esc(t('None (or GitHub/GitLab not connected).'))}</li>`}</ul></div>
        <div><h2>${esc(t('Failed pipelines in the period'))}</h2><ul class="plain">${fails || `<li class="muted">${esc(t('None.'))}</li>`}</ul></div></section>`;
  }

  private html(body: string) {
    const w = this.panel!.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.ctl.ctx.extensionUri, 'media', 'graph.css'));
    return `<!DOCTYPE html><html lang="${locale()}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body class="activity-page">${body}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.addEventListener('click', e => {
  const t = e.target.closest('[data-range],[data-url],[data-worktree],#prices');
  if (!t) return;
  e.preventDefault();
  if (t.dataset.range) vscode.postMessage({ action: 'range', value: t.dataset.range });
  else if (t.dataset.url) vscode.postMessage({ action: 'url', value: t.dataset.url });
  else if (t.dataset.worktree) vscode.postMessage({ action: 'worktree', value: t.dataset.worktree });
  else vscode.postMessage({ action: 'prices' });
});
</script></body></html>`;
  }

  dispose() {
    this.panel?.dispose();
  }
}

export function registerActivity(ctx: vscode.ExtensionContext, ctl: Controller, guard: Guard, deps: ActivityDeps): ActivityService {
  const svc = new ActivityService(ctl, deps);
  ctx.subscriptions.push(
    svc,
    vscode.commands.registerCommand('worktreeGraph.activity', guard((id?: RangeId) => svc.open(id))),
    vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('worktreeGraph.claude') && ctl.scheduleRefresh(50)),
  );
  return svc;
}
