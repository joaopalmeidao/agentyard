import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Controller } from '../controller';
import { gitUri } from '../diff';
import { locale, t } from '../i18n';
import type { Overlap } from './core';

export interface OverlapSource {
  overlaps: Overlap[];
  readonly onDidChangeOverlaps: vscode.Event<void>;
  recompute(): Promise<void>;
  nameOf(p: string): string;
  analyzePair(o: Overlap): Promise<void>;
  warnAgent(o: Overlap, side: string): Promise<void>;
}

const key = (p: string) => path.normalize(p).toLowerCase();

/** Painel "Sobreposição de arquivos": pares de worktrees ativas com arquivos em comum e as ações de cada um. */
export class OverlapPanel {
  private static current?: OverlapPanel;
  private list: Overlap[] = [];
  private rendered = '';

  static async show(ctl: Controller, src: OverlapSource, focus?: string) {
    const cur = OverlapPanel.current;
    if (cur) {
      cur.focus = focus;
      cur.panel.reveal();
      await cur.load(true);
      return;
    }
    const panel = vscode.window.createWebviewPanel('worktreeGraph.overlaps', t('File overlap'), vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctl.ctx.extensionUri, 'media')],
    });
    const p = new OverlapPanel(panel, ctl, src, focus);
    OverlapPanel.current = p;
    await p.load(true);
  }

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly ctl: Controller, private readonly src: OverlapSource, private focus?: string) {
    panel.iconPath = vscode.Uri.joinPath(ctl.ctx.extensionUri, 'media', 'icon.svg');
    const subs = [panel.webview.onDidReceiveMessage(m => this.onMessage(m)), src.onDidChangeOverlaps(() => void this.load(false))];
    panel.onDidDispose(() => {
      subs.forEach(d => d.dispose());
      if (OverlapPanel.current === this) OverlapPanel.current = undefined;
    });
  }

  private async load(recompute: boolean) {
    if (recompute) await this.src.recompute();
    const f = this.focus && key(this.focus);
    this.list = this.src.overlaps.filter(o => !f || key(o.a) === f || key(o.b) === f);
    const html = this.html(this.body());
    // só re-renderiza se mudou: preserva rolagem, filtro e seções abertas
    if (html === this.rendered) return;
    this.rendered = html;
    this.panel.webview.html = html;
  }

  private async onMessage(m: { action: string; i?: string; file?: string; side?: string }) {
    if (m.action === 'refresh') return this.load(true);
    if (m.action === 'all') {
      this.focus = undefined;
      return this.load(false);
    }
    const o = this.list[Number(m.i)];
    if (!o) return;
    const file = m.file ?? '';
    const name = path.basename(file);
    switch (m.action) {
      case 'analyze':
        return this.src.analyzePair(o);
      case 'warn':
        return this.src.warnAgent(o, m.side === 'b' ? o.b : o.a);
      case 'sides':
        return vscode.commands.executeCommand(
          'vscode.diff',
          vscode.Uri.file(path.join(o.a, file)),
          vscode.Uri.file(path.join(o.b, file)),
          `${name} (${this.src.nameOf(o.a)} ↔ ${this.src.nameOf(o.b)})`,
        );
      case 'side': {
        // o que aquele lado mudou: do ponto em que saiu da base até o arquivo na worktree
        const dir = m.side === 'b' ? o.b : o.a;
        const repo = this.ctl.repo;
        const s = this.ctl.state;
        if (!repo || !s) return;
        const base = s.baseSha || s.baseRef;
        const mb = await repo.run(['merge-base', base, 'HEAD'], dir);
        const from = mb.code === 0 && mb.stdout.trim() ? mb.stdout.trim() : base;
        return vscode.commands.executeCommand('vscode.diff', gitUri(repo.root, from, file), vscode.Uri.file(path.join(dir, file)), t('{0} (what {1} changed)', name, this.src.nameOf(dir)));
      }
      case 'open':
        return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(m.side === 'b' ? o.b : o.a, file)), { preview: true });
    }
  }

  private body(): string {
    const n = this.src.nameOf.bind(this.src);
    const focusName = this.focus ? n(this.focus) : undefined;
    const files = new Set(this.list.flatMap(o => o.files));
    const wts = new Set(this.list.flatMap(o => [key(o.a), key(o.b)]));
    const scope = focusName
      ? `<span class="chip info">${esc(t('only {0}', focusName))}</span> <button data-action="all">${esc(t('Show all'))}</button>`
      : `<span class="muted">${esc(this.ctl.state?.repoName ?? '')}</span>`;
    const head = `<header class="toolbar"><div class="title"><span class="repo">${esc(t('File overlap'))}</span> ${scope}</div>
      <div class="tools"><input type="search" id="filter" placeholder="${esc(t('Filter files or worktrees'))}">
        <button data-action="refresh" title="${esc(t('Recalculate'))}">↻</button></div></header>`;
    if (!this.list.length) {
      const msg = focusName ? t('{0} doesn\'t overlap files with other active worktrees.', focusName) : t('No overlaps between active worktrees.');
      return `${head}<div class="empty">${esc(msg)}</div>`;
    }
    const stats = `<div class="stats">
      <div class="warn"><b>${this.list.length}</b><span>${esc(t('pairs of worktrees with files in common'))}</span></div>
      <div><b>${files.size}</b><span>${esc(t('shared files'))}</span></div>
      <div><b>${wts.size}</b><span>${esc(t('worktrees involved'))}</span></div></div>
      <p class="muted">${esc(t('Files touched by more than one active worktree (commits outside the base and uncommitted changes). The more overlap, the more likely a conflict at merge time.'))}</p>`;
    const pairs = this.list
      .map((o, i) => {
        const A = esc(n(o.a));
        const B = esc(n(o.b));
        const rows = o.files
          .map(f => {
            const dir = path.posix.dirname(f);
            return `<tr data-file="${esc(f.toLowerCase())}"><td class="p"><b>${esc(path.posix.basename(f))}</b>${dir === '.' ? '' : ` <span class="muted">${esc(dir)}</span>`}</td>
              <td class="row-actions"><button class="primary" data-action="sides" data-i="${i}" data-file="${esc(f)}">${A} ↔ ${B}</button>
                <button data-action="side" data-side="a" data-i="${i}" data-file="${esc(f)}">${esc(t('What {0} changed', n(o.a)))}</button>
                <button data-action="side" data-side="b" data-i="${i}" data-file="${esc(f)}">${esc(t('What {0} changed', n(o.b)))}</button>
                <button class="icon" data-action="open" data-side="a" data-i="${i}" data-file="${esc(f)}" title="${esc(t('Open the file in {0}', n(o.a)))}">A</button>
                <button class="icon" data-action="open" data-side="b" data-i="${i}" data-file="${esc(f)}" title="${esc(t('Open the file in {0}', n(o.b)))}">B</button></td></tr>`;
          })
          .join('');
        return `<details class="pair" open data-names="${esc(`${n(o.a)} ${n(o.b)}`.toLowerCase())}"><summary><h2><span class="ref ref-head">${A}</span> ↔ <span class="ref ref-head">${B}</span>
            <span class="count">${o.files.length}</span><span class="hint">${esc(t('{0} file(s) in common', o.files.length))}</span></h2></summary>
          <div class="pair-actions"><button class="primary" data-action="analyze" data-i="${i}">${esc(t('Analyze merge between the two'))}</button>
            <button class="agent" data-action="warn" data-side="a" data-i="${i}" title="${esc(t('opens the agent with the list of shared files'))}">✦ ${esc(t('Warn {0}\'s agent', n(o.a)))}</button>
            <button class="agent" data-action="warn" data-side="b" data-i="${i}" title="${esc(t('opens the agent with the list of shared files'))}">✦ ${esc(t('Warn {0}\'s agent', n(o.b)))}</button></div>
          <table class="files">${rows}</table></details>`;
      })
      .join('');
    return `${head}${stats}<section id="pairs">${pairs}</section><div class="empty" id="nomatch" hidden>${esc(t('Nothing matches the filter.'))}</div>`;
  }

  private html(body: string) {
    const w = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.ctl.ctx.extensionUri, 'media', 'graph.css'));
    return `<!DOCTYPE html><html lang="${locale()}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body class="overlap-page">${body}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.addEventListener('click', e => {
  const el = e.target.closest('button[data-action]');
  if (!el || el.disabled) return;
  e.preventDefault();
  const d = el.dataset;
  vscode.postMessage({ action: d.action, i: d.i, file: d.file, side: d.side });
});
const input = document.getElementById('filter');
const apply = () => {
  const q = (input.value || '').trim().toLowerCase();
  let any = false;
  for (const p of document.querySelectorAll('details.pair')) {
    const byName = !q || p.dataset.names.includes(q);
    let shown = 0;
    for (const r of p.querySelectorAll('tr[data-file]')) {
      const ok = byName || r.dataset.file.includes(q);
      r.hidden = !ok;
      if (ok) shown++;
    }
    p.hidden = !shown;
    if (shown) any = true;
  }
  const nm = document.getElementById('nomatch');
  if (nm) nm.hidden = any;
  vscode.setState({ q: input.value });
};
if (input) {
  input.value = (vscode.getState() || {}).q || '';
  input.addEventListener('input', apply);
  apply();
}
</script></body></html>`;
  }
}

const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
