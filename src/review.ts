import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { createWorktree } from './actions';
import { fillTemplate } from './agents';
import type { Controller } from './controller';
import type { ChangeRequest } from './hosting/core';
import { DEFAULT_REVIEW_PROMPT, parseReviewFile, reviewPoster, ReviewFile } from './hosting/review';

type Guard = <T extends unknown[]>(fn: (...args: T) => unknown) => (...args: T) => Promise<void>;

const REVIEW_DIR = '.worktree-graph';
const REVIEW_FILE = 'review.json';

/** `.worktree-graph/` fica fora do git: vai no info/exclude (compartilhado pelas worktrees), nunca no .gitignore do projeto. */
export function ensureExcluded(commonDir: string) {
  const file = path.join(commonDir, 'info', 'exclude');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // arquivo ainda não existe
  }
  if (text.split(/\r?\n/).some(l => l.trim() === `${REVIEW_DIR}/`)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}# Worktree Graph (revisões de agente)\n${REVIEW_DIR}/\n`);
}

/**
 * "Revisar PR/MR com o agente": o agente escreve `.worktree-graph/review.json` na worktree da branch;
 * quando o arquivo aparece, o painel "Revisão" lista os comentários para escolher e postar.
 */
export class ReviewService implements vscode.Disposable {
  private readonly watchers = new Map<string, vscode.FileSystemWatcher>();
  panel?: ReviewPanel;

  constructor(private readonly ctl: Controller) {}

  private request(branch: string): ChangeRequest | undefined {
    return this.ctl.requests.byBranch.get(branch);
  }

  /** Abre o agente com a tarefa de revisar e passa a vigiar o arquivo de resultado. */
  async start(branch: string) {
    const repo = this.ctl.repo;
    if (!repo || !branch) return;
    const { base } = await this.ctl.base();
    let wtPath = (await repo.worktreesFast()).find(w => w.branch === branch)?.path;
    if (!wtPath) wtPath = await createWorktree(this.ctl, { existing: branch, quiet: true });
    if (!wtPath) return;

    let req = this.request(branch);
    if (!req) {
      const client = await this.ctl.requests.clientSilent();
      req = await client?.findForBranch(branch).catch(() => undefined);
    }
    const label = this.ctl.requests.label;
    const stat = await repo.run(['diff', '--stat', '--stat-width=120', `${base}...${branch}`]);
    const diffStat = stat.code === 0 ? stat.stdout.trim().split(/\r?\n/).slice(-40).join('\n') : '(não consegui calcular)';

    ensureExcluded(repo.commonDir);
    const dir = path.join(wtPath, REVIEW_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.rmSync(path.join(dir, REVIEW_FILE), { force: true });
    this.watch(wtPath, branch);

    const template = this.ctl.cfg().get<string>('prompts.review', '') || DEFAULT_REVIEW_PROMPT;
    const prompt = fillTemplate(template, {
      kind: req ? label : 'a branch',
      title: req?.title ?? branch,
      url: req?.url ?? '(ainda sem PR/MR)',
      branch,
      base,
      diffStat,
    });
    await vscode.commands.executeCommand('worktreeGraph.launchAgentWithPrompt', { path: wtPath, branch, prompt });
    vscode.window.setStatusBarMessage(`$(eye) Revisão de ${branch}: o painel abre quando o agente gravar ${REVIEW_DIR}/${REVIEW_FILE}`, 8000);
  }

  watch(wtPath: string, branch: string) {
    const key = wtPath.toLowerCase();
    if (this.watchers.has(key)) return;
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(wtPath), `${REVIEW_DIR}/${REVIEW_FILE}`));
    const open = () => void this.open(wtPath, branch);
    w.onDidCreate(open);
    w.onDidChange(open);
    this.watchers.set(key, w);
  }

  /** Lê o review.json da worktree e mostra o painel (também pelo comando, para abrir de novo). */
  async open(wtPath: string, branch: string) {
    const file = path.join(wtPath, REVIEW_DIR, REVIEW_FILE);
    let review: ReviewFile;
    try {
      review = parseReviewFile(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      // o agente pode estar no meio da gravação; o próximo evento de alteração tenta de novo
      this.ctl.log(`Revisão de ${branch}: ${(e as Error).message}`);
      return;
    }
    if (!this.panel || this.panel.disposed) this.panel = new ReviewPanel(this.ctl, this);
    this.panel.show(wtPath, branch, review, this.request(branch));
  }

  async post(branch: string, review: ReviewFile) {
    const creds = await this.ctl.requests.credentials(true);
    if (!creds) {
      vscode.window.showWarningMessage('Sem GitHub/GitLab conectado para postar a revisão.');
      return;
    }
    let req = this.request(branch);
    if (!req) {
      const client = await this.ctl.requests.clientInteractive();
      req = await client?.findForBranch(branch);
    }
    if (!req || (req.state !== 'open' && req.state !== 'draft')) {
      vscode.window.showWarningMessage(`${branch} não tem ${this.ctl.requests.label} aberto para receber a revisão.`);
      return;
    }
    const poster = reviewPoster(creds.remote, creds.token, creds.apiBase);
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Postando revisão em ${req.ref}…` }, () => poster.post(req!.id, review));
    this.ctl.log(`Revisão postada em ${req.ref}: ${r.inline} em linha, ${r.general} no texto geral.`);
    const go = await vscode.window.showInformationMessage(
      `Revisão postada em ${req.ref}: ${r.inline} comentário(s) em linha${r.general ? `, ${r.general} no texto geral (fora das linhas alteradas)` : ''}.`,
      'Abrir no navegador',
    );
    if (go) vscode.env.openExternal(vscode.Uri.parse(r.url ?? req.url));
  }

  dispose() {
    this.watchers.forEach(w => w.dispose());
    this.panel?.dispose();
  }
}

export class ReviewPanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  disposed = false;
  current?: { wtPath: string; branch: string; review: ReviewFile };

  constructor(private readonly ctl: Controller, private readonly svc: ReviewService) {
    this.panel = vscode.window.createWebviewPanel('worktreeGraph.review', 'Revisão', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(ctl.ctx.extensionUri, 'media')],
    });
    this.panel.iconPath = vscode.Uri.joinPath(ctl.ctx.extensionUri, 'media', 'icon.svg');
    this.panel.onDidDispose(() => (this.disposed = true));
    this.panel.webview.onDidReceiveMessage(m => this.onMessage(m));
  }

  show(wtPath: string, branch: string, review: ReviewFile, req?: ChangeRequest) {
    this.current = { wtPath, branch, review };
    this.panel.title = `Revisão: ${branch}`;
    this.panel.webview.html = this.html(branch, review, req);
    this.panel.reveal(undefined, true);
  }

  private async onMessage(m: { action: string; index?: number; selected?: number[] }) {
    const c = this.current;
    if (!c) return;
    if (m.action === 'open' && m.index !== undefined) {
      const it = c.review.comments[m.index];
      const uri = vscode.Uri.file(path.join(c.wtPath, it.path));
      const line = Math.max(0, (it.line ?? 1) - 1);
      await vscode.window.showTextDocument(uri, { selection: new vscode.Range(line, 0, line, 0), preview: true, viewColumn: vscode.ViewColumn.Beside });
    }
    if (m.action === 'post') {
      const chosen = c.review.comments.filter((_, i) => m.selected?.includes(i));
      await this.svc.post(c.branch, { summary: c.review.summary, comments: chosen });
    }
  }

  private html(branch: string, r: ReviewFile, req?: ChangeRequest) {
    const w = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.ctl.ctx.extensionUri, 'media', 'graph.css'));
    const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
    const sevCls: Record<string, string> = { bug: 'bad', risco: 'warn', sugestao: 'info', nit: 'muted' };
    const host = this.ctl.requests.remote?.kind === 'gitlab' ? 'GitLab' : 'GitHub';
    const rows = r.comments
      .map(
        (c, i) => `<tr>
          <td><input type="checkbox" data-i="${i}" ${c.severity === 'nit' ? '' : 'checked'} aria-label="Postar comentário ${i + 1}"></td>
          <td>${c.severity ? `<span class="chip ${sevCls[c.severity] ?? 'muted'}">${esc(c.severity)}</span>` : ''}</td>
          <td class="p"><a href="#" data-open="${i}">${esc(c.path)}${c.line ? `:${c.line}` : ''}</a><div>${esc(c.body)}</div></td></tr>`,
      )
      .join('');
    return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body class="review-page">
<header class="toolbar"><div class="title"><span class="repo">Revisão do agente</span> <span class="ref ref-head">${esc(branch)}</span>
  ${req ? `<span class="muted">${esc(req.ref)} · ${esc(req.title)}</span>` : '<span class="muted">sem PR/MR aberto</span>'}</div>
  <div class="tools"><button id="post" class="primary" ${req ? '' : 'disabled title="Abra um PR/MR para postar"'}>Postar selecionados no ${host}</button></div></header>
<div class="verdict ${r.comments.some(c => c.severity === 'bug') ? 'bad' : 'ok'}">${esc(r.summary || 'Sem resumo.')}</div>
<section><h2>Comentários <span class="count">${r.comments.length}</span><span class="hint">marque o que vai para o ${host}; linhas fora do diff vão no texto geral</span></h2>
<table class="files review-list">${rows || '<tr><td class="muted">Nenhum comentário: o agente não encontrou problemas.</td></tr>'}</table></section>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.addEventListener('click', e => {
  const a = e.target.closest('[data-open]');
  if (a) { e.preventDefault(); vscode.postMessage({ action: 'open', index: Number(a.dataset.open) }); }
  if (e.target.id === 'post') {
    const selected = [...document.querySelectorAll('input[data-i]:checked')].map(x => Number(x.dataset.i));
    vscode.postMessage({ action: 'post', selected });
  }
});
</script></body></html>`;
  }

  dispose() {
    this.panel.dispose();
  }
}

export function registerReview(ctx: vscode.ExtensionContext, ctl: Controller, guard: Guard): ReviewService {
  const svc = new ReviewService(ctl);
  ctx.subscriptions.push(svc);
  const branchOf = async (arg: unknown): Promise<string | undefined> => {
    if (typeof arg === 'string') return arg;
    const b = (arg as { branch?: string } | undefined)?.branch;
    if (b) return b;
    const withReq = [...ctl.requests.byBranch.values()].filter(r => r.state === 'open' || r.state === 'draft');
    const pick = await vscode.window.showQuickPick(
      withReq.length
        ? withReq.map(r => ({ label: r.source, description: `${r.ref} ${r.title}` }))
        : (ctl.state?.worktrees ?? []).filter(w => w.branch && !w.isBase).map(w => ({ label: w.branch!, description: w.path })),
      { placeHolder: 'Revisar qual PR/MR (ou branch)?' },
    );
    return pick?.label;
  };
  ctx.subscriptions.push(
    vscode.commands.registerCommand('worktreeGraph.reviewWithAgent', guard(async (arg?: unknown) => {
      const b = await branchOf(arg);
      if (b) await svc.start(b);
    })),
    vscode.commands.registerCommand('worktreeGraph.openReview', guard(async (arg?: unknown) => {
      const b = await branchOf(arg);
      const wt = b ? ctl.state?.worktrees.find(w => w.branch === b) : undefined;
      if (b && wt) await svc.open(wt.path, b);
    })),
  );
  return svc;
}
