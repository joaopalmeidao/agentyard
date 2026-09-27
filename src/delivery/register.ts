import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { commitsIn, rangeOf, RangeId } from '../activity';
import type { ActivityService } from '../activityPanel';
import type { Controller } from '../controller';
import { locale, t } from '../i18n';
import type { Pipeline } from '../hosting/pipelines';
import {
  applyRelease,
  branchCreatedAt,
  buildTimeline,
  MergeInfo,
  parseMergeLog,
  parseSourceLog,
  planRelease,
  ReleasePlan,
  renderReport,
  ReportBranch,
  TimelineRow,
} from './core';

type Guard = <T extends unknown[]>(fn: (...args: T) => unknown) => (...args: T) => Promise<void>;

export interface DeliveryDeps {
  activity: ActivityService;
  pipelines?: () => Pipeline[];
  issueOf?: (branch: string) => { key: string; title: string; url: string } | undefined;
}

const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export class DeliveryService implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private days = 30;
  private pattern = '';
  /** Últimos resultados (os testes leem daqui). */
  lastTimeline?: TimelineRow[];
  lastReport?: string;
  lastPlan?: ReleasePlan;

  constructor(private readonly ctl: Controller, private readonly deps: DeliveryDeps) {}

  // ------------------------------------------------------------------ linha do tempo

  /** Dois processos git: commits fora da base por branch, e merges no first-parent da base. */
  async timeline(days = this.days, pattern = this.pattern): Promise<TimelineRow[]> {
    const repo = this.ctl.repo;
    const s = this.ctl.state;
    if (!repo || !s) return [];
    const now = Date.now();
    const from = now - days * 86_400_000;
    const since = `--since=${new Date(from).toISOString()}`;
    const [src, mer] = await Promise.all([
      repo.run(['log', '--branches', '--not', s.baseRef, '--source', '--no-merges', since, '--format=%x1e%S%x1f%at']),
      repo.run(['log', '--merges', '--first-parent', s.baseRef, since, '--format=%x1e%H%x1f%at%x1f%P%x1f%s%x1f%b']),
    ]);
    const commits = src.code === 0 ? parseSourceLog(src.stdout) : new Map<string, number[]>();
    const merges: MergeInfo[] = mer.code === 0 ? parseMergeLog(mer.stdout) : [];
    const wtCreated = (p: string) => {
      try {
        return fs.statSync(p).birthtimeMs || undefined;
      } catch {
        return undefined;
      }
    };
    const branches = [
      ...s.worktrees.filter(w => w.branch && !w.isBase && !w.prunable).map(w => ({ name: w.branch!, worktree: true, date: w.date * 1000, head: w.head, worktreeCreated: wtCreated(w.path) })),
      ...s.branches.filter(b => !b.isBase).map(b => ({ name: b.name, worktree: false, date: b.date * 1000, head: b.sha })),
    ].map(b => ({ ...b, created: branchCreatedAt(repo.commonDir, b.name) }));
    const requests = [...this.ctl.requests.byBranch.values()].map(r => ({
      source: r.source,
      ref: r.ref,
      url: r.url,
      state: r.state,
      createdAt: r.createdAt,
      mergedAt: r.mergedAt,
      approved: r.review?.state === 'approved',
    }));
    let rows = buildTimeline({ now, from, branches, commits, merges, requests });
    if (pattern.trim()) {
      const re = new RegExp('^' + pattern.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*') + '$');
      rows = rows.filter(r => re.test(r.branch));
    }
    this.lastTimeline = rows;
    return rows;
  }

  async openTimeline() {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('worktreeGraph.timeline', t('Timeline'), vscode.ViewColumn.Active, { enableScripts: true });
      this.panel.iconPath = vscode.Uri.joinPath(this.ctl.ctx.extensionUri, 'media', 'icon.svg');
      this.panel.onDidDispose(() => (this.panel = undefined));
      this.panel.webview.onDidReceiveMessage(async m => {
        if (m.action === 'days') this.days = Number(m.value) || 30;
        if (m.action === 'pattern') this.pattern = String(m.value ?? '');
        if (m.action === 'open') {
          if (m.url) return vscode.env.openExternal(vscode.Uri.parse(m.url));
          return vscode.commands.executeCommand('worktreeGraph.analyzeMerge', m.branch);
        }
        if (m.action === 'days' || m.action === 'pattern' || m.action === 'refresh') await this.renderTimeline();
      });
    }
    this.panel.reveal();
    await this.renderTimeline();
  }

  private async renderTimeline() {
    if (!this.panel) return;
    const rows = await this.timeline();
    const now = Date.now();
    const from = now - this.days * 86_400_000;
    const W = 900;
    const X = (ms: number) => Math.max(0, Math.min(W, ((ms - from) / (now - from)) * W));
    const day = (ms: number) => new Date(ms).toLocaleDateString(locale(), { day: '2-digit', month: '2-digit' });
    const full = (ms?: number) => (ms ? new Date(ms).toLocaleString(locale()) : '—');
    const ticks = Array.from({ length: 7 }, (_, i) => from + ((now - from) * i) / 6);
    const axis = `<svg width="100%" viewBox="0 0 ${W} 22" preserveAspectRatio="none" class="axis">${ticks
      .map(tk => `<line x1="${X(tk)}" y1="0" x2="${X(tk)}" y2="6" /><text x="${Math.min(W - 30, X(tk))}" y="18">${day(tk)}</text>`)
      .join('')}</svg>`;
    const body = rows
      .map(r => {
        const start = Math.max(from, r.born ?? r.commits[0] ?? r.last);
        const end = r.merged ?? (r.worktree ? now : r.last);
        const tip = [
          t('born: {0}', full(r.born)),
          t('{0} commit(s) outside the base', r.commits.length),
          r.worktreeCreated ? t('worktree created: {0}', full(r.worktreeCreated)) : '',
          r.prRef ? `${r.prRef} ${r.prState ?? ''}${r.prOpened ? ` · ${t('opened {0}', full(r.prOpened))}` : ''}` : '',
          r.approved ? t('approved') : '',
          r.merged ? t('merged: {0}', full(r.merged)) : r.worktree ? t('active worktree') : t('worktree removed / no worktree'),
        ]
          .filter(Boolean)
          .join('\n');
        const marks = [
          ...r.commits.filter(c => c >= from).map(c => `<circle cx="${X(c)}" cy="11" r="2.6" class="c" />`),
          r.prOpened && r.prOpened >= from ? `<rect x="${X(r.prOpened) - 4}" y="3" width="8" height="16" class="pr" />` : '',
          r.merged && r.merged >= from ? `<path d="M${X(r.merged)} 2 l7 9 l-7 9 l-7 -9 z" class="m" />` : '',
        ].join('');
        return `<tr data-branch="${esc(r.branch)}" data-url="${esc(r.prUrl ?? '')}" title="${esc(tip)}">
          <td class="name">${esc(r.branch)}${r.worktree ? ' <span class="tag">wt</span>' : ''}${r.prRef ? ` <span class="tag">${esc(r.prRef)}</span>` : ''}${r.approved ? ' <span class="ok">✓</span>' : ''}</td>
          <td class="bar"><svg width="100%" viewBox="0 0 ${W} 22" preserveAspectRatio="none">
            <rect x="${X(start)}" y="7" width="${Math.max(2, X(end) - X(start))}" height="8" rx="4" class="${r.merged ? 'done' : r.worktree ? 'live' : 'idle'}" />${marks}</svg></td>
        </tr>`;
      })
      .join('');
    const nonce = crypto.randomBytes(12).toString('base64');
    this.panel.webview.html = `<!DOCTYPE html><html lang="${locale()}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:0 16px 24px;font-size:13px}
header{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:12px 0;position:sticky;top:0;background:var(--vscode-editor-background)}
h1{font-size:15px;margin:0 12px 0 0}button,input{font:inherit}
button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-widget-border,#444);border-radius:3px;padding:2px 9px;cursor:pointer}
button.on{border-color:var(--vscode-focusBorder)}
input{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:2px 6px;width:180px}
table{width:100%;border-collapse:collapse}td{padding:3px 6px;border-bottom:1px solid var(--vscode-widget-border,#333)}
td.name{white-space:nowrap;width:1%;font-family:var(--vscode-editor-font-family);font-size:12px}td.bar{width:100%}
tr{cursor:pointer}tr:hover{background:var(--vscode-list-hoverBackground)}
svg{display:block;height:22px}.axis line{stroke:var(--vscode-descriptionForeground)}.axis text{fill:var(--vscode-descriptionForeground);font-size:10px}
.live{fill:#3aa8f0aa}.done{fill:#4fbf7a88}.idle{fill:#8888}.c{fill:var(--vscode-foreground)}.pr{fill:#b56fc9}.m{fill:#4fbf7a}
.tag{font-size:10px;border:1px solid var(--vscode-widget-border,#555);border-radius:3px;padding:0 4px;color:var(--vscode-descriptionForeground)}.ok{color:#4fbf7a}
.legend{color:var(--vscode-descriptionForeground);font-size:11px}.empty{color:var(--vscode-descriptionForeground);padding:24px 0}
</style></head><body>
<header><h1>${esc(t('Timeline'))}</h1>
${[7, 30, 90].map(d => `<button data-days="${d}" class="${d === this.days ? 'on' : ''}">${esc(t('{0} days', d))}</button>`).join('')}
<input id="pat" placeholder="${esc(t('Filter branches (e.g. {0})', 'ai/*'))}" value="${esc(this.pattern)}" />
<button id="ref">↻</button>
<span class="legend">${esc(t('● commit · ▮ PR/MR opened · ◆ merged · blue bar: active worktree, green: merged'))}</span></header>
${rows.length ? `<table><tr><td></td><td>${axis}</td></tr>${body}</table>` : `<div class="empty">${esc(t('No branch with activity in the period.'))}</div>`}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.querySelectorAll('[data-days]').forEach(b => b.onclick = () => vscode.postMessage({ action: 'days', value: b.dataset.days }));
document.getElementById('ref').onclick = () => vscode.postMessage({ action: 'refresh' });
const pat = document.getElementById('pat');
pat.onkeydown = e => { if (e.key === 'Enter') vscode.postMessage({ action: 'pattern', value: pat.value }); };
document.querySelectorAll('tr[data-branch]').forEach(tr => tr.onclick = () => vscode.postMessage({ action: 'open', branch: tr.dataset.branch, url: tr.dataset.url }));
</script></body></html>`;
  }

  // ------------------------------------------------------------------ relatório do dia

  async report(id: RangeId = 'today'): Promise<string> {
    const repo = this.ctl.repo;
    const s = this.ctl.state;
    if (!repo || !s) return '';
    const range = rangeOf(id);
    const act = await this.deps.activity.compute(id);
    const commits = await commitsIn(repo, range.from, range.to);
    const pipes = (this.deps.pipelines?.() ?? []).filter(p => p.updatedAt * 1000 >= range.from && p.updatedAt * 1000 < range.to);
    const costOf = new Map(act.costs.map(c => [c.branch, c]));
    const branches: ReportBranch[] = act.report.rows.map(r => {
      const req = this.ctl.requests.byBranch.get(r.branch);
      return {
        branch: r.branch,
        worktree: r.worktree,
        commits: commits.filter(c => c.branch === r.branch).map(c => ({ subject: c.subject, sha: c.sha })),
        files: r.files,
        added: r.added,
        deleted: r.deleted,
        tokens: r.tokens,
        sessions: r.sessions,
        usd: costOf.get(r.branch)?.usd,
        request: req ? { ref: req.ref, title: req.title, url: req.url, state: req.state } : undefined,
        issue: this.deps.issueOf?.(r.branch),
        pipelines: pipes.filter(p => p.branch === r.branch).map(p => ({ name: p.name, status: p.status, url: p.url })),
      };
    });
    const mer = await repo.run(['log', '--merges', '--first-parent', s.baseRef, `--since=${new Date(range.from).toISOString()}`, `--until=${new Date(range.to).toISOString()}`, '--format=%x1e%H%x1f%at%x1f%P%x1f%s%x1f%b']);
    const merged = mer.code === 0 ? parseMergeLog(mer.stdout) : [];
    const usdTotal = act.costs.some(c => c.usd !== undefined) ? act.costs.reduce((sum, c) => sum + (c.usd ?? 0), 0) : undefined;
    const md = renderReport({
      title: t('Report for {0}', range.label),
      repo: s.repoName,
      base: s.base,
      generatedAt: Date.now(),
      branches,
      merged,
      failedPipelines: pipes.filter(p => p.status === 'failed').map(p => ({ name: p.name, branch: p.branch, url: p.url })),
      passedPipelines: pipes.filter(p => p.status === 'success').length,
      totals: { ...act.report.totals, usd: usdTotal },
    });
    this.lastReport = md;
    return md;
  }

  async openReport() {
    const pick = await vscode.window.showQuickPick(
      [
        { label: t('Today'), id: 'today' as RangeId },
        { label: t('Yesterday'), id: 'yesterday' as RangeId },
        { label: t('Last 7 days'), id: 'week' as RangeId },
      ],
      { title: t('Report for which period?') },
    );
    if (!pick) return;
    const md = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Building the report…') }, () => this.report(pick.id));
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
    await vscode.window.showTextDocument(doc, { preview: false });
    const copy = t('Copy');
    const save = t('Save to {0}', 'docs/relatorios');
    const summarize = t('✦ Write a summary with the agent');
    const actions = [copy, save, ...(this.ctl.cfg().get('report.agentSummary', false) ? [summarize] : [])];
    const go = await vscode.window.showInformationMessage(t('Report ready.'), ...actions);
    if (go === copy) await vscode.env.clipboard.writeText(doc.getText());
    if (go === save) {
      const d = new Date();
      const name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.md`;
      const file = path.join(this.ctl.repo!.root, 'docs', 'relatorios', name);
      if (fs.existsSync(file)) {
        const overwrite = t('Overwrite');
        const ok = await vscode.window.showWarningMessage(t('{0} already exists.', name), { modal: true }, overwrite);
        if (ok !== overwrite) return;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, doc.getText());
      await vscode.window.showTextDocument(vscode.Uri.file(file));
    }
    if (go === summarize) {
      const branch = this.ctl.state?.worktrees.find(w => w.isMain)?.branch;
      await vscode.commands.executeCommand('worktreeGraph.launchAgentWithPrompt', {
        branch,
        prompt: `${t('Write a short summary (5 to 10 lines, for a partner or client) of the report below. Do not change any files.')}\n\n${doc.getText()}`,
      });
    }
  }

  // ------------------------------------------------------------------ preparar versão

  async prepareRelease(opts: { cwd?: string; version?: string; confirm?: boolean } = {}): Promise<ReleasePlan | undefined> {
    const repo = this.ctl.repo;
    const s = this.ctl.state;
    if (!repo || !s) return undefined;
    const baseWt = s.worktrees.find(w => w.branch === s.base);
    const cwd = opts.cwd ?? baseWt?.path;
    if (!cwd) {
      vscode.window.showWarningMessage(t('{0} isn\'t open in a worktree; create one to prepare the release.', s.base));
      return undefined;
    }
    const titles = new Map([...this.ctl.requests.byBranch.values()].map(r => [r.source, r.title]));
    const plan = await planRelease(repo, s.base, cwd, titles);
    this.lastPlan = plan;
    if (opts.confirm === false) {
      const version = opts.version ?? plan.version;
      const tag = plan.tag.replace(plan.version, version);
      await applyRelease(repo, cwd, version, tag, plan.block.replace(plan.version, version));
      this.ctl.scheduleRefresh(50);
      return { ...plan, version, tag };
    }

    const version = await vscode.window.showInputBox({
      title: plan.lastTag
        ? t('Prepare release ({0} change(s) since {1})', plan.entries.length, plan.lastTag)
        : t('Prepare release ({0} change(s) since the beginning)', plan.entries.length),
      prompt: t('Version number (suggested from the change types: {0})', 'feat → minor, fix → patch, BREAKING → major'),
      value: plan.version,
      validateInput: v => (/^\d+\.\d+\.\d+([-+].+)?$/.test(v.trim()) ? undefined : t('Use the format {0}', '1.2.3')),
    });
    if (!version) return undefined;
    const tag = plan.tag.replace(plan.version, version.trim());
    const block = plan.block.replace(`## ${plan.version}`, `## ${version.trim()}`);
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: block });
    await vscode.window.showTextDocument(doc, { preview: false });
    const st = await repo.status(cwd);
    const apply = t('Write, commit and create tag');
    const go = await vscode.window.showInformationMessage(
      t('Review/edit the open block. Write it to {0}, commit "{1}" on {2} and create the tag {3} (local)?', 'CHANGELOG.md', t('Version {0}', version), s.base, tag),
      {
        modal: true,
        detail: st.changes
          ? t('⚠ The {0} worktree has {1} uncommitted change(s); clean it up first.', s.base, st.changes)
          : t('Nothing is sent to the remote unless you ask.'),
      },
      ...(st.changes ? [] : [apply]),
    );
    if (go !== apply) return plan;
    await applyRelease(repo, cwd, version.trim(), tag, doc.getText());
    this.ctl.scheduleRefresh(50);
    const pushLabel = t('Push commit and tag…');
    const next = await vscode.window.showInformationMessage(t('Version {0} created: local commit and tag {1}.', version, tag), pushLabel);
    if (next === pushLabel) {
      const send = t('Push');
      const ok = await vscode.window.showWarningMessage(
        t('Push {0} and the tag {1} to the remote?', s.base, tag),
        { modal: true, detail: t('This publishes the release. Creating the release on GitHub/GitLab is up to you, on the repository\'s page.') },
        send,
      );
      if (ok === send) {
        const remote = this.ctl.cfg().get<string>('remote', 'origin');
        const r = await repo.run(['push', remote, s.base, tag], cwd, 300_000);
        if (r.code !== 0) vscode.window.showErrorMessage(t('Push failed: {0}', (r.stderr || r.stdout).trim()));
        else vscode.window.showInformationMessage(t('{0} and {1} pushed to {2}.', s.base, tag, remote));
      }
    }
    return { ...plan, version: version.trim(), tag };
  }

  dispose() {
    this.panel?.dispose();
  }
}

export function registerDelivery(ctx: vscode.ExtensionContext, ctl: Controller, guard: Guard, deps: DeliveryDeps): DeliveryService {
  const svc = new DeliveryService(ctl, deps);
  ctx.subscriptions.push(
    svc,
    vscode.commands.registerCommand('worktreeGraph.timeline', guard(() => svc.openTimeline())),
    vscode.commands.registerCommand('worktreeGraph.dailyReport', guard(() => svc.openReport())),
    vscode.commands.registerCommand('worktreeGraph.prepareRelease', guard(() => svc.prepareRelease())),
  );
  return svc;
}
