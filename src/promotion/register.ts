import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { Controller } from '../controller';
import { flowStages } from '../flow';
import { locale, t } from '../i18n';
import { ChangeGroup, computePromotion, MatrixRow, PromotionMap, Stage, StepView } from './core';

type Guard = <T extends unknown[]>(fn: (...args: T) => unknown) => (...args: T) => Promise<void>;

export interface PromotionDeps {
  /** PR/MR, análise ou merge de `from` em `to` (src/flow.ts). */
  promote: (from: string, to: string) => Promise<unknown>;
  /** Merge direto (back-merge de hotfix). */
  merge: (source: string, target: string) => Promise<unknown>;
  showCommit: (sha: string) => Promise<unknown>;
}

const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function ago(ms: number) {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

/** Painel "Mapa de promoção": o que falta subir entre os ambientes, por etapa e por branch. */
export class PromotionService implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private timer?: NodeJS.Timeout;
  private busy = false;
  /** Último cálculo (os testes leem daqui). */
  last?: PromotionMap;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ctl: Controller, private readonly deps: PromotionDeps) {
    // Recalcula quando o repositório muda (commit, merge, fetch), só com o painel aberto.
    this.disposables.push(ctl.onDidChange(() => this.panel?.visible && this.schedule()));
  }

  private remote() {
    return this.ctl.cfg().get<string>('remote', 'origin');
  }

  private mode(): 'local' | 'remote' {
    return this.ctl.ctx.workspaceState.get<'local' | 'remote'>('promotionMode', 'remote');
  }

  async compute(): Promise<PromotionMap | undefined> {
    const repo = this.ctl.repo;
    const flow = flowStages(this.ctl);
    if (!repo || flow.length < 2) return undefined;
    this.last = await computePromotion(repo, flow, this.mode(), this.remote());
    return this.last;
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.render(), 800);
  }

  async open() {
    if (flowStages(this.ctl).length < 2) {
      const go = await vscode.window.showInformationMessage(
        t('The promotion map uses the environment flow (e.g. dev → qa → hml → prd), which has not been configured yet.'),
        t('Configure flow'),
      );
      if (!go) return;
      await vscode.commands.executeCommand('worktreeGraph.configureFlow');
      if (flowStages(this.ctl).length < 2) return;
    }
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('worktreeGraph.promotion', t('Promotion map'), vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.ctl.ctx.extensionUri, 'media')],
      });
      this.panel.iconPath = vscode.Uri.joinPath(this.ctl.ctx.extensionUri, 'media', 'icon.svg');
      this.panel.onDidDispose(() => (this.panel = undefined));
      this.panel.webview.onDidReceiveMessage(m => this.onMessage(m));
      this.panel.webview.html = this.html(`<div class="empty">${t('Calculating…')}</div>`);
    }
    this.panel.reveal();
    await this.render();
  }

  private async onMessage(m: { action: string; [k: string]: string }) {
    try {
      switch (m.action) {
        case 'refresh':
          return await this.render();
        case 'mode':
          await this.ctl.ctx.workspaceState.update('promotionMode', m.value);
          return await this.render();
        case 'fetch': {
          const repo = this.ctl.repo;
          if (!repo) return;
          const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Fetching {0}…', this.remote()) }, () =>
            repo.run(['fetch', '--prune', this.remote()], repo.root, 300_000),
          );
          if (r.code !== 0) vscode.window.showWarningMessage(t('git fetch failed: {0}', r.stderr.trim().split(/\r?\n/).pop() ?? ''));
          this.ctl.scheduleRefresh(20);
          return await this.render();
        }
        case 'configure':
          await vscode.commands.executeCommand('worktreeGraph.configureFlow');
          return await this.render();
        case 'promote':
          await this.deps.promote(m.from, m.to);
          return await this.render();
        case 'merge':
          await this.deps.merge(m.source, m.target);
          return await this.render();
        case 'commit':
          return await this.deps.showCommit(m.sha);
        case 'url':
          return await vscode.env.openExternal(vscode.Uri.parse(m.value));
        case 'worktree':
          return await vscode.commands.executeCommand('worktreeGraph.openWorktree', m.value);
        case 'copy':
          await vscode.env.clipboard.writeText(m.value);
          return void vscode.window.setStatusBarMessage(t('Copied.'), 2000);
      }
    } catch (e) {
      vscode.window.showErrorMessage((e as Error).message);
    }
  }

  private async render() {
    if (!this.panel || this.busy) return;
    this.busy = true;
    try {
      this.panel.webview.postMessage({ busy: true });
      const data = await this.compute();
      if (this.panel) this.panel.webview.html = this.html(data ? this.body(data) : `<div class="empty">${t('Configure the environment flow.')}</div>`);
    } catch (e) {
      if (this.panel) this.panel.webview.html = this.html(`<div class="error">${esc((e as Error).message)}</div>`);
    } finally {
      this.busy = false;
    }
  }

  // ------------------------------------------------------------------ HTML

  private body(d: PromotionMap): string {
    const s = this.ctl.state;
    const wtOf = new Map((s?.worktrees ?? []).filter(w => w.branch).map(w => [w.branch!, w.path]));
    const reqs = this.ctl.requests.byBranch;
    const L = this.ctl.requests.label;
    const n = d.stages.length;

    const refChip = (st: Stage) =>
      `<span class="ref ${st.ref ? 'ref-head' : 'ref-detached'}" title="${esc(st.ref ? `${st.ref} · ${st.sha.slice(0, 7)}` : t('does not exist'))}">${esc(st.ref.replace(/^refs\/remotes\//, '') || st.branch)}</span>`;
    const drift = (st: Stage) =>
      st.drift
        ? `<span class="chip warn" title="${t('Local {0} and {1}/{2} differ', esc(st.branch), esc(d.remote), esc(st.branch))}">local ${st.drift[0] ? `+${st.drift[0]}` : ''}${st.drift[0] && st.drift[1] ? ' / ' : ''}${st.drift[1] ? `−${st.drift[1]}` : ''} vs ${esc(d.remote)}</span>`
        : '';

    // ---- faixa dos ambientes
    let strip = '';
    d.stages.forEach((st, i) => {
      const here = d.rows.filter(r => !r.noOwnCommits && r.reached === i + 1 && i + 1 < n).length;
      strip += `<div class="pm-stage"><span class="stage-label">${esc(st.label)}</span>${refChip(st)}
        <span class="muted">${st.date ? ago(st.date) : t('does not exist')}</span>${drift(st)}
        ${i + 1 < n && here ? `<span class="chip muted" title="${t('Branches already in {0} and not yet in {1}', esc(st.label), esc(d.stages[i + 1].label))}">${t('{0} branch(es) stop here', here)}</span>` : ''}</div>`;
      const stp = d.steps[i];
      if (!stp) return;
      strip += `<a class="pm-arrow" href="#step-${i}" data-tab="steps" title="${t('See what is missing between {0} and {1}', esc(st.label), esc(stp.to.label))}">
        <span>→</span>
        ${!st.ref || !stp.to.ref ? `<span class="chip bad">${t('branch does not exist')}</span>` : stp.forwardCount ? `<span class="chip info">↑ ${t('{0} item(s) · {1} commit(s)', stp.forward.length, stp.forwardCount)}</span>` : `<span class="chip ok">${t('up to date')}</span>`}
        ${stp.backwardCount ? `<span class="chip warn">↓ ${t('{0} only in {1}', stp.backwardCount, esc(stp.to.label))}</span>` : ''}</a>`;
    });
    const outside = d.rows.filter(r => !r.noOwnCommits && r.reached === 0).length;

    const toolbar = `<header class="toolbar"><div class="title"><span class="repo">${t('Promotion map')}</span>
        <span class="muted">${esc(s?.repoName ?? '')} · ${d.stages.map(x => esc(x.label)).join(' → ')}</span></div>
      <div class="tools">
        <input id="pmfilter" type="search" placeholder="${t('Filter branch, title, author…')}" />
        <span class="seg" title="${t('Compare with the local environment branches or the ones published on the remote')}">
          <button data-act="mode" data-value="remote" class="${d.mode === 'remote' ? 'on' : ''}">${esc(d.remote)}</button>
          <button data-act="mode" data-value="local" class="${d.mode === 'local' ? 'on' : ''}">local</button></span>
        <button data-act="fetch" title="git fetch --prune ${esc(d.remote)}">${t('Fetch from remote')}</button>
        <button data-act="configure">${t('Edit flow')}</button>
        <button data-act="refresh" title="${t('Recalculate')}">↻</button>
      </div></header>`;

    const summary = `<div class="stats">
      <div class="${outside ? '' : 'muted'}"><b>${outside}</b><span>${t('branch(es) outside the flow (not even in {0})', esc(d.stages[0].label))}</span></div>
      ${d.steps.map(stp => `<div><b>${stp.forward.length}</b><span>${t('in {0}, missing in {1}', esc(stp.from.label), esc(stp.to.label))}</span></div>`).join('')}
      ${d.steps.some(x => x.backwardCount) ? `<div class="bad"><b>${d.steps.reduce((a, x) => a + x.backward.length, 0)}</b><span>${t('item(s) in an environment and missing in the previous one (hotfix without back-merge)')}</span></div>` : ''}
    </div>`;

    // ---- por etapa
    const commitList = (g: ChangeGroup) =>
      `<table class="files">${g.commits
        .slice(0, 60)
        .map(c => `<tr class="pm-commit" data-act="commit" data-sha="${c.sha}"><td class="sha">${c.sha.slice(0, 7)}</td><td class="p">${esc(c.subject)}</td><td class="muted">${esc(c.author)}</td><td class="muted">${ago(c.date)}</td></tr>`)
        .join('')}${g.commits.length > 60 ? `<tr><td></td><td class="muted">${t('… and {0} more', g.commits.length - 60)}</td></tr>` : ''}</table>`;
    const groupItem = (g: ChangeGroup, target: Stage, dir: 'fw' | 'bw') => {
      const name = g.kind === 'direct' ? t('direct commits') : g.branch ?? g.ref ?? '?';
      const r = g.branch ? reqs.get(g.branch) : undefined;
      const openReq = r && (r.state === 'open' || r.state === 'draft') && r.target === target.branch ? r : undefined;
      const search = [name, g.title, g.ref, ...g.authors, ...g.commits.slice(0, 20).map(c => c.subject)].join(' ').toLowerCase();
      const actions =
        dir === 'fw' && g.branch && g.live
          ? `<button data-act="promote" data-from="${esc(g.branch)}" data-to="${esc(target.branch)}" title="${t('Take only this branch to {0} ({1}, review or merge)', esc(target.branch), L)}">${t('Only this → {0}', esc(target.label))}</button>`
          : '';
      return `<details class="pm-item" data-search="${esc(search)}"><summary>
          <span class="pm-kind ${g.kind}" title="${g.kind === 'merge' ? t('Came in through a merge') : g.kind === 'branch' ? t('Reached by the branch tip') : t('Commit made directly on the environment')}">${g.kind === 'merge' ? '⑂' : g.kind === 'branch' ? '●' : '•'}</span>
          <span class="pm-name">${g.kind === 'direct' ? `<i>${esc(name)}</i>` : esc(name)}</span>
          ${g.ref ? (openReq ? `<a href="#" class="chip info" data-act="url" data-value="${esc(openReq.url)}">${esc(g.ref)}</a>` : `<span class="chip muted">${esc(g.ref)}</span>`) : ''}
          ${openReq && openReq.ref !== g.ref ? `<a href="#" class="chip info" data-act="url" data-value="${esc(openReq.url)}" title="${esc(openReq.title)}">${t('{0} open', esc(openReq.ref))}</a>` : ''}
          ${g.title ? `<span class="pm-title">${esc(g.title)}</span>` : g.kind !== 'direct' ? `<span class="pm-title muted">${esc(g.commits[0]?.subject ?? '')}</span>` : ''}
          ${g.kind !== 'direct' && !g.live ? `<span class="chip muted" title="${t('The branch has already been deleted')}">${t('branch deleted')}</span>` : ''}
          <span class="pm-meta muted">${t('{0} commit(s)', g.commits.length)} · ${esc(g.authors.slice(0, 2).join(', '))}${g.authors.length > 2 ? '…' : ''} · ${ago(g.date)}</span>
          <span class="pm-actions">${actions}</span>
        </summary>${commitList(g)}</details>`;
    };
    const stepSection = (stp: StepView, i: number) => {
      const missing = !stp.from.ref || !stp.to.ref;
      const fw = stp.forward.map(g => groupItem(g, stp.to, 'fw')).join('');
      const bw = stp.backward.map(g => groupItem(g, stp.from, 'bw')).join('');
      return `<section class="pm-step" id="step-${i}">
        <h2>${esc(stp.from.label)} → ${esc(stp.to.label)} <span class="muted">${esc(stp.from.branch)} → ${esc(stp.to.branch)}</span>
          ${stp.truncated ? `<span class="chip warn">${t('list cut at {0} commits', 3000)}</span>` : ''}
          <span class="hint">
            <button data-act="promote" data-from="${esc(stp.from.branch)}" data-to="${esc(stp.to.branch)}" ${stp.forwardCount ? '' : 'disabled'} class="primary" title="${t('{0}, review or merge of everything', L)}">${t('Promote all ↑')}</button>
            ${stp.backwardCount ? `<button data-act="merge" data-source="${esc(stp.to.branch)}" data-target="${esc(stp.from.branch)}" title="${t('Merge {0} into {1} (back-merge)', esc(stp.to.branch), esc(stp.from.branch))}">↓ ${t('Bring to {0}', esc(stp.from.label))}</button>` : ''}
          </span></h2>
        ${
          missing
            ? `<div class="muted">${t('Branch {0} does not exist (neither locally nor on {1}).', esc(!stp.from.ref ? stp.from.branch : stp.to.branch), esc(d.remote))}</div>`
            : `<div class="pm-cols">
          <div><h3>↑ ${t('In {0}, missing in {1}', esc(stp.from.label), esc(stp.to.label))} <span class="count">${stp.forward.length}</span></h3>${fw || `<div class="muted pm-none">${t('Nothing: {0} has everything from {1}.', esc(stp.to.label), esc(stp.from.label))}</div>`}</div>
          <div><h3>↓ ${t('In {0}, missing in {1}', esc(stp.to.label), esc(stp.from.label))} <span class="count">${stp.backward.length}</span></h3>${bw || `<div class="muted pm-none">${t('Nothing: no hotfix pending back-merge.')}</div>`}</div>
        </div>`
        }</section>`;
    };

    // ---- por branch
    const cell = (r: MatrixRow, i: number) => {
      const m = r.missing[i];
      const st = d.stages[i];
      if (m === undefined) return `<td class="pm-cell na" title="${t('{0} does not exist', esc(st.branch))}">·</td>`;
      if (m === 0) return `<td class="pm-cell ok" title="${t('Fully in {0}', esc(st.label))}">✓</td>`;
      const partial = r.missing.some((x, j) => j !== i && x !== undefined && x < m);
      return `<td class="pm-cell ${i === r.reached ? 'next' : 'no'}" title="${t('{0} commit(s) of {1} are not in {2} yet', m, esc(r.name), esc(st.label))}${partial ? ' ' + t('(part of it already reached another environment, or the branch got commits after the merge)') : ''}">${i === r.reached ? `↑${m}` : m}</td>`;
    };
    const rowHtml = (r: MatrixRow) => {
      const next = d.stages[r.reached];
      const wt = wtOf.get(r.name);
      const req = reqs.get(r.name);
      const openReq = req && (req.state === 'open' || req.state === 'draft') ? req : undefined;
      const search = [r.name, r.subject, openReq?.title ?? ''].join(' ').toLowerCase();
      return `<tr data-search="${esc(search)}">
        <td class="pm-branch"><span class="ref ${r.remoteOnly ? 'ref-remote' : wt ? 'ref-wt' : 'ref-head'}" title="${esc(r.ref)}">${esc(r.name)}</span>
          ${r.remoteOnly ? `<span class="chip muted" title="${t('Only exists on {0}', esc(d.remote))}">${esc(d.remote)}</span>` : ''}
          ${r.ahead.length ? `<span class="chip warn" title="${t('Already in {0} without being in {1}', esc(r.ahead.map(j => d.stages[j].label).join(', ')), esc(d.stages[r.reached]?.label ?? ''))}">${t('skipped {0}', esc(d.stages[r.reached]?.label ?? ''))}</span>` : ''}
          ${openReq ? `<a href="#" class="chip info" data-act="url" data-value="${esc(openReq.url)}" title="${esc(openReq.title)}">${esc(openReq.ref)} → ${esc(openReq.target)}</a>` : ''}
          <div class="muted pm-sub">${esc(r.subject)} · ${ago(r.date)}</div></td>
        ${d.stages.map((_, i) => cell(r, i)).join('')}
        <td class="pm-row-actions">
          ${next ? `<button data-act="promote" data-from="${esc(r.name)}" data-to="${esc(next.branch)}" title="${t('{0}, review or merge of {1} into {2}', L, esc(r.name), esc(next.branch))}">→ ${esc(next.label)}</button>` : ''}
          ${wt ? `<button data-act="worktree" data-value="${esc(r.name)}" title="${t('Open the worktree')}">${t('open')}</button>` : ''}
        </td></tr>`;
    };
    const head = `<tr class="muted"><td>branch</td>${d.stages.map(x => `<td class="pm-cell">${esc(x.label)}</td>`).join('')}<td></td></tr>`;
    const groups: { title: string; hint: string; rows: MatrixRow[]; open: boolean }[] = [];
    const real = d.rows.filter(r => !r.noOwnCommits);
    groups.push({ title: t('Outside the flow: not in {0} yet', d.stages[0].label), hint: t('branches with work that no environment has'), rows: real.filter(r => r.reached === 0), open: true });
    for (let i = 1; i < n; i++)
      groups.push({ title: t('In {0}, missing {1}', d.stages[i - 1].label, d.stages[i].label), hint: '', rows: real.filter(r => r.reached === i), open: true });
    groups.push({ title: t('In {0} (all delivered)', d.stages[n - 1].label), hint: t('most recent first'), rows: real.filter(r => r.reached >= n), open: false });
    groups.push({
      title: t('No own commits'),
      hint: t('the tip is on the main line of an environment: created from there without commits, or merged by fast-forward'),
      rows: d.rows.filter(r => r.noOwnCommits),
      open: false,
    });
    const byBranch = groups
      .filter(g => g.rows.length)
      .map(
        g => `<details class="pm-group" ${g.open ? 'open' : ''}><summary><h2>${esc(g.title)} <span class="count">${g.rows.length}</span>${g.hint ? `<span class="hint">${esc(g.hint)}</span>` : ''}</h2></summary>
        <div class="table-wrap"><table class="files pm-matrix">${head}${g.rows.slice(0, 200).map(rowHtml).join('')}</table></div></details>`,
      )
      .join('');

    return `${toolbar}
      <div class="pm-strip">${strip}</div>
      ${summary}
      <nav class="seg pm-tabs"><button data-tab="steps" class="on">${t('By stage')}</button><button data-tab="branches">${t('By branch')}</button></nav>
      <div data-pane="steps">${d.steps.map(stepSection).join('')}</div>
      <div data-pane="branches" hidden>
        <div class="muted pm-legend">${t('✓ fully in the environment · ↑N commits to move up to the next · N missing commits · · environment does not exist')}</div>
        ${byBranch || `<div class="empty">${t('No branches besides the environment ones.')}</div>`}
      </div>`;
  }

  private html(body: string) {
    const w = this.panel!.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.ctl.ctx.extensionUri, 'media', 'graph.css'));
    return `<!DOCTYPE html><html lang="${locale()}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body class="activity-page promotion-page">${body}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const st = vscode.getState() || { tab: 'steps', filter: '' };
function tab(name) {
  st.tab = name; vscode.setState(st);
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('[data-pane]').forEach(p => (p.hidden = p.dataset.pane !== name));
}
function filter(q) {
  st.filter = q; vscode.setState(st);
  q = q.trim().toLowerCase();
  document.querySelectorAll('[data-search]').forEach(el => (el.hidden = !!q && !el.dataset.search.includes(q)));
}
tab(st.tab);
const f = document.getElementById('pmfilter');
if (f) { f.value = st.filter || ''; filter(f.value); f.addEventListener('input', () => filter(f.value)); }
window.addEventListener('message', e => { if (e.data && e.data.busy) document.body.classList.add('busy'); });
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act],[data-tab]');
  if (!t) return;
  if (t.dataset.tab) return tab(t.dataset.tab);
  if (t.tagName === 'A' && t.getAttribute('href') !== '#' && !t.dataset.value) return;
  e.preventDefault();
  e.stopPropagation();
  vscode.postMessage({ ...t.dataset, action: t.dataset.act });
});
</script></body></html>`;
  }

  dispose() {
    clearTimeout(this.timer);
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

export function registerPromotion(ctx: vscode.ExtensionContext, ctl: Controller, guard: Guard, deps: PromotionDeps): PromotionService {
  const svc = new PromotionService(ctl, deps);
  ctx.subscriptions.push(svc, vscode.commands.registerCommand('worktreeGraph.promotionMap', guard(() => svc.open())));
  return svc;
}
