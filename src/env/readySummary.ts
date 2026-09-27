import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentFlow } from '../agentFlow/register';
import type { Controller } from '../controller';
import { ensureExcluded } from '../review';

const DIR = '.worktree-graph';
const FILE = 'summary.md';

export interface ReadySummary {
  branch: string;
  path: string;
  base: string;
  commits: { sha: string; subject: string }[];
  files: { path: string; added: number; deleted: number }[];
  agentText?: string;
}

/**
 * Quando o agente fica "pronto para revisar", mostra antes do diff: commits desde a base, arquivos
 * com +/− e, se `readySummary.useAgent`, o resumo que o agente escreve em `.worktree-graph/summary.md`.
 */
export class ReadySummaryService implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  last?: ReadySummary;

  constructor(private readonly ctl: Controller, agentFlow: AgentFlow) {
    this.disposables.push(
      agentFlow.watch.onDidFinish(e => {
        if (e.ready && e.branch && this.ctl.cfg().get<boolean>('readySummary.enabled', true)) void this.show(e.path, e.branch);
      }),
    );
  }

  async build(wtPath: string, branch: string): Promise<ReadySummary> {
    const repo = this.ctl.repo!;
    const { base, baseRef } = this.ctl.state ?? (await this.ctl.base());
    const mb = (await repo.run(['merge-base', baseRef, 'HEAD'], wtPath)).stdout.trim() || baseRef;
    const [log, num] = await Promise.all([
      repo.run(['log', '--format=%h%x1f%s', '-n', '50', `${mb}..HEAD`], wtPath),
      repo.run(['diff', '--numstat', '--no-renames', `${mb}..HEAD`], wtPath),
    ]);
    const commits = log.stdout.split(/\r?\n/).filter(Boolean).map(l => {
      const [sha, subject] = l.split('\x1f');
      return { sha, subject };
    });
    const files = num.stdout.split(/\r?\n/).filter(Boolean).map(l => {
      const [a, d, ...rest] = l.split('\t');
      return { path: rest.join('\t'), added: Number(a) || 0, deleted: Number(d) || 0 };
    });
    let agentText: string | undefined;
    try {
      agentText = fs.readFileSync(path.join(wtPath, DIR, FILE), 'utf8');
    } catch {
      // o agente ainda não escreveu
    }
    return { branch, path: wtPath, base, commits, files, agentText };
  }

  /** Pede ao agente o resumo "o que mudou, riscos, o que testar" (grava em .worktree-graph/summary.md). */
  async askAgent(wtPath: string, branch: string) {
    if (this.ctl.repo) ensureExcluded(this.ctl.repo.commonDir);
    const { base } = this.ctl.state ?? (await this.ctl.base());
    const prompt = [
      `Resuma o trabalho da branch ${branch} em relação a ${base} (git log e git diff ${base}...HEAD).`,
      `Escreva em ${DIR}/${FILE}, em markdown, com três seções: "O que mudou", "Riscos" e "O que testar".`,
      'Não altere nenhum outro arquivo e não faça commit.',
    ].join('\n');
    await vscode.commands.executeCommand('worktreeGraph.launchAgentWithPrompt', { path: wtPath, branch, prompt });
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(wtPath), `${DIR}/${FILE}`));
    const again = () => void this.show(wtPath, branch, false);
    watcher.onDidCreate(again);
    watcher.onDidChange(again);
    this.disposables.push(watcher);
  }

  async show(wtPath: string, branch: string, maybeAskAgent = true) {
    const s = (this.last = await this.build(wtPath, branch));
    if (maybeAskAgent && !s.agentText && this.ctl.cfg().get<boolean>('readySummary.useAgent', false)) void this.askAgent(wtPath, branch);
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('worktreeGraph.readySummary', `Pronto: ${branch}`, vscode.ViewColumn.Active, {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.ctl.ctx.extensionUri, 'media')],
      });
      this.panel.onDidDispose(() => (this.panel = undefined));
      this.panel.webview.onDidReceiveMessage(async m => {
        const cur = this.last;
        if (!cur) return;
        const cmd = { review: 'diffWithBase', analyze: 'analyzeMerge', publish: 'publishRequest' }[m.action as string];
        if (cmd) await vscode.commands.executeCommand(`worktreeGraph.${cmd}`, cur.branch);
        if (m.action === 'askAgent') await this.askAgent(cur.path, cur.branch);
      });
    }
    this.panel.title = `Pronto: ${branch}`;
    this.panel.webview.html = this.html(s);
    this.panel.reveal(undefined, true);
  }

  private html(s: ReadySummary): string {
    const w = this.panel!.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.ctl.ctx.extensionUri, 'media', 'graph.css'));
    const e = (t: string) => t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
    const add = s.files.reduce((n, f) => n + f.added, 0);
    const del = s.files.reduce((n, f) => n + f.deleted, 0);
    const L = this.ctl.requests.label;
    return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body class="attempts-page">
<header class="toolbar"><div class="title"><span class="repo">✓ Pronto para revisar</span> <span class="ref ref-head">${e(s.branch)}</span></div>
<div class="tools"><button class="primary" data-action="review">Revisar</button><button data-action="analyze">Analisar merge</button><button data-action="publish">Publicar ${L}</button>
${s.agentText ? '' : '<button class="agent" data-action="askAgent">✦ Pedir resumo ao agente</button>'}</div></header>
<div class="stats"><div><b>${s.commits.length}</b><span>commits desde ${e(s.base)}</span></div><div><b>${s.files.length}</b><span>arquivos</span></div>
<div><b><span class="add">+${add}</span> <span class="del">−${del}</span></b><span>linhas</span></div></div>
${s.agentText ? `<section><h2>Resumo do agente</h2><pre style="white-space:pre-wrap;font-family:var(--font)">${e(s.agentText)}</pre></section>` : ''}
<section><h2>Commits</h2><table class="files">${s.commits.map(c => `<tr><td class="sha">${e(c.sha)}</td><td class="p">${e(c.subject)}</td></tr>`).join('')}</table></section>
<section><h2>Arquivos</h2><table class="files">${s.files.map(f => `<tr><td class="p">${e(f.path)}</td><td class="num"><span class="add">+${f.added}</span> <span class="del">−${f.deleted}</span></td></tr>`).join('')}</table></section>
<script nonce="${nonce}">const vscode = acquireVsCodeApi();
document.addEventListener('click', ev => { const el = ev.target.closest('[data-action]'); if (el) vscode.postMessage({ action: el.dataset.action }); });</script>
</body></html>`;
  }

  dispose() {
    this.panel?.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
