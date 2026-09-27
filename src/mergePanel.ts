import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { analyzeMerge, MergeAnalysis } from './analysis';
import { resolverName, runResolve } from './conflicts';
import { Controller } from './controller';
import { gitUri } from './diff';
import { describePlan, needsAttention, needsRechain } from './migrations/core';
import { applyRechain, checkMigrations, MigrationCheck, rechainSideOf } from './migrations/register';

/** Painel "Analisar merge": um por par origem → destino. */
export class MergePanel {
  private static readonly open = new Map<string, MergePanel>();
  private analysis?: MergeAnalysis;
  private migrations?: MigrationCheck;

  static async show(ctl: Controller, source: string, target: string, onMerge: (s: string, t: string) => Promise<void>, onPublish: (b: string) => Promise<void>) {
    const key = `${source}→${target}`;
    const existing = MergePanel.open.get(key);
    if (existing) {
      existing.panel.reveal();
      await existing.load();
      return;
    }
    const panel = vscode.window.createWebviewPanel('worktreeGraph.merge', `Merge: ${source} → ${target}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(ctl.ctx.extensionUri, 'media')],
    });
    const p = new MergePanel(panel, ctl, source, target, onMerge, onPublish);
    MergePanel.open.set(key, p);
    panel.onDidDispose(() => MergePanel.open.delete(key));
    await p.load();
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly ctl: Controller,
    private readonly source: string,
    private readonly target: string,
    private readonly onMerge: (s: string, t: string) => Promise<void>,
    private readonly onPublish: (b: string) => Promise<void>,
  ) {
    panel.iconPath = vscode.Uri.joinPath(ctl.ctx.extensionUri, 'media', 'icon.svg');
    panel.webview.onDidReceiveMessage(m => this.onMessage(m));
  }

  private async load() {
    this.panel.webview.html = this.html('<div class="empty">Simulando o merge…</div>');
    try {
      const side = await rechainSideOf(this.ctl, this.source, this.target);
      [this.analysis, this.migrations] = await Promise.all([
        analyzeMerge(this.ctl.repo!, this.source, this.target),
        checkMigrations(this.ctl.repo!, side.branch, side.onto).catch(() => undefined),
      ]);
      this.panel.webview.html = this.html(this.body(this.analysis));
    } catch (e) {
      this.panel.webview.html = this.html(`<div class="error">${esc((e as Error).message)}</div>`);
    }
  }

  private async onMessage(m: { action: string; path?: string }) {
    const a = this.analysis;
    const root = this.ctl.repo!.root;
    if (m.action === 'refresh') return this.load();
    if (!a) return;
    const name = (p: string) => p.split('/').pop();
    switch (m.action) {
      case 'conflict':
        return vscode.commands.executeCommand('vscode.open', gitUri(root, a.resultTree!, m.path!), { preview: true });
      case 'diff':
        return vscode.commands.executeCommand('vscode.diff', gitUri(root, a.mergeBase, m.path!), gitUri(root, a.sourceSha, m.path!), `${name(m.path!)} (o que ${a.source} mudou)`);
      case 'sides':
        return vscode.commands.executeCommand('vscode.diff', gitUri(root, a.targetSha, m.path!), gitUri(root, a.sourceSha, m.path!), `${name(m.path!)} (${a.target} ↔ ${a.source})`);
      case 'targetDiff':
        return vscode.commands.executeCommand('vscode.diff', gitUri(root, a.mergeBase, m.path!), gitUri(root, a.targetSha, m.path!), `${name(m.path!)} (o que ${a.target} mudou)`);
      case 'merge':
        await this.onMerge(a.source, a.target);
        return this.load();
      case 'publish':
        return this.onPublish(a.source);
      case 'rechain':
        if (this.migrations && (await applyRechain(this.ctl, this.migrations, { commit: true }))) {
          vscode.window.showInformationMessage(`Migrations de ${this.migrations.branch} reencadeadas após ${this.migrations.onto}.`);
        }
        return this.load();
      case 'resolve':
        // Mesclando na base: a branch traz a base e resolve. Outro destino: o destino traz a origem.
        return a.target === this.ctl.state?.base ? runResolve(a.source, { intoBase: true }) : runResolve(a.target, { base: a.source });
    }
  }

  private body(a: MergeAnalysis): string {
    const base = this.ctl.state?.base;
    const verdict = a.incoming.length === 0
      ? { cls: 'ok', text: `${a.target} já contém tudo de ${a.source}.` }
      : a.conflicts.length
        ? { cls: 'bad', text: `Vai dar conflito em ${a.conflicts.length} arquivo(s).` }
        : a.fastForward
          ? { cls: 'ok', text: 'Fast-forward: sem commit de merge, sem conflito.' }
          : { cls: 'ok', text: 'Merge limpo: nenhum conflito previsto.' };
    const both = a.files.filter(f => f.bothSides && !f.conflict).length;
    const added = a.files.reduce((s, f) => s + f.added, 0);
    const deleted = a.files.reduce((s, f) => s + f.deleted, 0);

    const conflicts = a.conflicts.length
      ? `<section><h2>Conflitos <span class="count">${a.conflicts.length}</span><span class="hint">o arquivo abre como ficaria depois do merge, com os marcadores</span></h2>
        <table class="files">${a.conflicts
          .map(
            c => `<tr><td class="p">${esc(c.path)}</td><td class="muted">${c.hunks || '?'} trecho(s)</td><td class="row-actions">
              <button class="primary" data-action="conflict" data-path="${esc(c.path)}">Ver conflito</button>
              <button data-action="sides" data-path="${esc(c.path)}">${esc(a.target)} ↔ ${esc(a.source)}</button>
              <button data-action="targetDiff" data-path="${esc(c.path)}">O que ${esc(a.target)} mudou</button></td></tr>`,
          )
          .join('')}</table></section>`
      : '';

    const mig = this.migrations;
    const migrations = mig && needsAttention(mig.plan)
      ? `<section><h2>Migrations <span class="chip bad">colidem</span><span class="hint">o git não acusa conflito, mas a cadeia de ${esc(mig.onto)} e a de ${esc(mig.branch)} se cruzam</span></h2>
        <pre class="muted">${esc(describePlan(mig.plan).join('\n'))}</pre>
        ${needsRechain(mig.plan) ? `<button class="primary" data-action="rechain">Reencadear as de ${esc(mig.branch)} após ${esc(mig.onto)} (commit)</button>` : ''}</section>`
      : '';

    const files = `<section><h2>Arquivos que ${esc(a.source)} altera <span class="count">${a.files.length}</span>
      <span class="hint"><span class="chip warn">nos dois lados</span> = ${esc(a.target)} também mexeu; revise mesmo sem conflito</span></h2>
      <table class="files">${a.files
        .map(
          f => `<tr><td class="p">${esc(f.path)}</td>
            <td>${f.conflict ? '<span class="chip bad">conflito</span>' : f.bothSides ? '<span class="chip warn">nos dois lados</span>' : ''}</td>
            <td class="num">${f.binary ? '<span class="muted">binário</span>' : `<span class="add">+${f.added}</span> <span class="del">−${f.deleted}</span>`}</td>
            <td class="row-actions"><button data-action="diff" data-path="${esc(f.path)}">Diff</button>${f.bothSides ? `<button data-action="sides" data-path="${esc(f.path)}">Comparar lados</button>` : ''}</td></tr>`,
        )
        .join('')}</table></section>`;

    const commits = `<section><h2>Commits que entram <span class="count">${a.incoming.length}</span></h2>
      <table class="files">${a.incoming
        .map(c => `<tr><td class="sha">${c.sha.slice(0, 7)}</td><td class="p">${esc(c.subject)}</td><td class="muted">${esc(c.author)}</td><td class="muted">${ago(c.date)}</td></tr>`)
        .join('')}</table></section>`;

    const canPublish = a.target === base && this.ctl.requests?.remote;
    return `<header class="toolbar"><div class="title"><span class="repo">Analisar merge</span>
        <span class="ref ref-head">${esc(a.source)}</span> <span class="muted">→</span> <span class="ref ref-base">${esc(a.target)}</span></div>
      <div class="tools">
        ${canPublish ? `<button data-action="publish">Publicar ${this.ctl.requests?.label ?? 'PR'}</button>` : ''}
        ${a.conflicts.length ? `<button data-action="resolve" class="agent" title="Abre o agente na worktree com a tarefa de trazer ${esc(a.target === this.ctl.state?.base ? a.target : a.source)} e resolver os conflitos">✦ Pedir ao ${esc(resolverName(this.ctl))} para mesclar e resolver</button>` : ''}
        <button data-action="merge" class="primary" ${a.incoming.length ? '' : 'disabled'}>Mesclar ${esc(a.source)} em ${esc(a.target)}</button>
        <button data-action="refresh" title="Refazer a simulação">↻</button></div></header>
      <div class="verdict ${verdict.cls}">${esc(verdict.text)}</div>
      <div class="stats">
        <div><b>${a.incoming.length}</b><span>commits entram</span></div>
        <div><b>${a.behind}</b><span>commits de ${esc(a.target)} que ${esc(a.source)} não tem</span></div>
        <div><b>${a.files.length}</b><span>arquivos (<span class="add">+${added}</span> <span class="del">−${deleted}</span>)</span></div>
        <div class="${a.conflicts.length ? 'bad' : ''}"><b>${a.conflicts.length}</b><span>com conflito</span></div>
        <div class="${both ? 'warn' : ''}"><b>${both}</b><span>alterados nos dois lados sem conflito</span></div>
      </div>
      ${conflicts}${migrations}${a.files.length ? files : ''}${a.incoming.length ? commits : ''}`;
  }

  private html(body: string) {
    const w = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.ctl.ctx.extensionUri, 'media', 'graph.css'));
    return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body>${body}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (el && !el.disabled) vscode.postMessage({ action: el.dataset.action, path: el.dataset.path });
});
</script></body></html>`;
  }
}

const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function ago(unix: number) {
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}
