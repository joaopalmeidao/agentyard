import * as crypto from 'crypto';
import * as vscode from 'vscode';
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
      this.panel = vscode.window.createWebviewPanel('worktreeGraph.activity', 'Atividade', vscode.ViewColumn.Active, {
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
    this.panel.webview.html = this.html('<div class="empty">Calculando…</div>');
    this.panel.reveal();
    const data = await this.compute(this.range);
    if (this.panel) this.panel.webview.html = this.html(this.body(data));
  }

  private body(d: ActivityData): string {
    const { report: r, costs } = d;
    const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
    const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} mi` : n >= 1e3 ? `${Math.round(n / 1e3)} mil` : String(n));
    const usd = (n?: number) => (n === undefined ? '' : `≈ US$ ${n.toFixed(2).replace('.', ',')}`);
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
        return `<g><title>${esc(c.label)}: ${tok(c.tokens)} tokens, ${c.commits} commit(s)</title>
          <rect x="${i * bw + 3}" y="${y}" width="${bw - 6}" height="${h}" rx="2" fill="var(--agent-color, #b180d7)" opacity=".75"/>
          ${c.commits ? `<circle cx="${i * bw + bw / 2}" cy="${cy}" r="4" fill="var(--info)"/>` : ''}
          ${n <= 7 || i % 3 === 0 ? `<text x="${i * bw + bw / 2}" y="${H - 4}" text-anchor="middle" font-size="10" fill="var(--muted)">${esc(c.label)}</text>` : ''}</g>`;
      })
      .join('');

    const rows = r.rows
      .map(
        x => `<tr><td class="p">${x.worktree ? `<a href="#" data-worktree="${esc(x.worktree)}" title="Abrir a worktree numa nova janela">${esc(x.branch)}</a>` : esc(x.branch)}</td>
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
      .map(q => `<li><a href="#" data-url="${esc(q.url)}">${esc(q.ref)}</a> ${esc(q.title)} <span class="muted">${esc(q.source)} → ${esc(q.target)}${q.state === 'draft' ? ' · rascunho' : ''}</span></li>`)
      .join('');
    const fails = d.failedPipelines.map(p => `<li><a href="#" data-url="${esc(p.url)}">✗ ${esc(p.name)}</a> <span class="muted">${esc(p.branch)}</span></li>`).join('');
    const btn = (id: RangeId, label: string) => `<button data-range="${id}" class="${r.range.id === id ? 'on' : ''}">${label}</button>`;
    return `<header class="toolbar"><div class="title"><span class="repo">Atividade</span> <span class="muted">${esc(this.ctl.state?.repoName ?? '')} · ${esc(r.range.label)}</span></div>
      <div class="tools"><span class="seg">${btn('today', 'Hoje')}${btn('yesterday', 'Ontem')}${btn('week', '7 dias')}</span></div></header>
      <div class="stats">
        <div><b>${r.totals.commits}</b><span>commits</span></div>
        <div><b>${r.totals.files}</b><span>arquivos (<span class="add">+${r.totals.added}</span> <span class="del">−${r.totals.deleted}</span>)</span></div>
        <div><b>${r.totals.sessions}</b><span>sessões do Claude com uso no período</span></div>
        <div><b>${tok(r.totals.tokens)}</b><span>tokens (entrada + saída + criação de cache)</span></div>
      </div>
      <section><h2>Por ${r.range.unit === 'hour' ? 'hora' : 'dia'}<span class="hint">barra = tokens · ponto = commits</span></h2>
        <svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px" role="img" aria-label="Tokens e commits por ${r.range.unit === 'hour' ? 'hora' : 'dia'}">${bars}</svg></section>
      <section><h2>Por worktree e branch <span class="count">${r.rows.length}</span></h2>
        <table class="files"><tr class="muted"><td>branch</td><td class="num">commits</td><td class="num">arquivos</td><td class="num">linhas</td><td class="num">sessões</td><td class="num">tokens</td></tr>${rows || '<tr><td class="muted">Nada no período.</td></tr>'}</table></section>
      <section><h2>Custo por tarefa <span class="count">${costs.length}</span>
        <span class="hint">${priced ? 'estimativa a partir dos logs locais e dos preços configurados; o valor exato está na fatura' : '<a href="#" id="prices">configure o preço por milhão de tokens</a> para ver o custo estimado em US$'}</span></h2>
        <table class="files"><tr class="muted"><td>issue / PR</td><td>branch</td><td class="num">sessões</td><td class="num">tokens</td><td class="num">${priced ? 'custo' : ''}</td></tr>${costRows || '<tr><td class="muted">Nenhuma sessão do Claude ligada a uma branch.</td></tr>'}</table></section>
      <section class="cols2"><div><h2>PRs/MRs abertos</h2><ul class="plain">${reqs || '<li class="muted">Nenhum (ou GitHub/GitLab não conectado).</li>'}</ul></div>
        <div><h2>Pipelines com falha no período</h2><ul class="plain">${fails || '<li class="muted">Nenhum.</li>'}</ul></div></section>`;
  }

  private html(body: string) {
    const w = this.panel!.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.ctl.ctx.extensionUri, 'media', 'graph.css'));
    return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
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
