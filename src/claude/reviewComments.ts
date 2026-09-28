import * as path from 'path';
import * as vscode from 'vscode';
import { keyOf } from '../agentFlow/head';
import type { ClaudeBridge } from '../bridge/register';
import type { Controller } from '../controller';
import { t } from '../i18n';
import type { ClaudeIntegration } from './integration';

/** Um comentário da revisão local, como vai para o agente. */
export interface ReviewNote {
  file: string;
  line: number;
  endLine: number;
  code: string;
  text: string;
}

class NoteComment implements vscode.Comment {
  mode = vscode.CommentMode.Preview;
  author = { name: t('You') };
  contextValue = 'agentReviewNote';
  constructor(public body: string | vscode.MarkdownString) {}
}

/** Texto da revisão para o agente (e para a ferramenta MCP review_comments). */
export function reviewText(notes: ReviewNote[]): string {
  if (!notes.length) return 'No review comments.';
  return notes
    .map(n => {
      const where = n.endLine > n.line ? `${n.file}:${n.line}-${n.endLine}` : `${n.file}:${n.line}`;
      const code = n.code.trim() ? `\n  \`${n.code.trim().slice(0, 200)}\`` : '';
      return `- ${where}${code}\n  ${n.text.replace(/\n/g, '\n  ')}`;
    })
    .join('\n');
}

/**
 * Revisão local para o agente: comentários nas linhas dos arquivos das worktrees (como num PR) que
 * vão todos juntos, numa tarefa só, para o Claude daquela worktree.
 */
export class AgentReviewComments implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly threads = new Set<vscode.CommentThread>();
  /** Última revisão mandada, por worktree (a ferramenta MCP lê daqui). */
  private readonly sent = new Map<string, ReviewNote[]>();
  private readonly status: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ctl: Controller, private readonly bridge: ClaudeBridge, private readonly integration: ClaudeIntegration) {
    this.controller = vscode.comments.createCommentController('agentyard.agentReview', t('Review for the agent'));
    this.controller.options = { prompt: t('Comment for the agent…'), placeHolder: t('What should the agent change here?') };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: doc => (doc.uri.scheme === 'file' && this.worktreeOf(doc.uri.fsPath) ? [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)] : []),
    };
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 45);
    this.status.command = 'worktreeGraph.agentReview.send';
    this.disposables.push(this.controller, this.status);
    bridge.addTool('review_comments', async (_args, { cwd, open }) => {
      const w = this.worktreeOf(open?.path ?? cwd);
      if (!w) return { text: `${cwd} is not a worktree of the repository open in AgentYard.`, isError: true };
      const notes = [...this.pending(w.path), ...(this.sent.get(keyOf(w.path)) ?? [])];
      return reviewText(notes);
    });
  }

  private worktreeOf(file: string) {
    return this.bridge.worktreeAt(file);
  }

  private noteOf(th: vscode.CommentThread): ReviewNote | undefined {
    const w = this.worktreeOf(th.uri.fsPath);
    const text = th.comments.map(c => (typeof c.body === 'string' ? c.body : c.body.value)).join('\n');
    if (!w || !text.trim() || !th.range) return undefined;
    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === th.uri.toString());
    const code = doc ? doc.lineAt(Math.min(th.range.start.line, doc.lineCount - 1)).text : '';
    return { file: path.relative(w.path, th.uri.fsPath).split(path.sep).join('/'), line: th.range.start.line + 1, endLine: th.range.end.line + 1, code, text };
  }

  /** Comentários ainda não mandados de uma worktree. */
  pending(worktree: string): ReviewNote[] {
    const out: ReviewNote[] = [];
    for (const th of this.threads) {
      const w = this.worktreeOf(th.uri.fsPath);
      if (!w || keyOf(w.path) !== keyOf(worktree)) continue;
      const n = this.noteOf(th);
      if (n) out.push(n);
    }
    return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }

  private update() {
    const n = [...this.threads].filter(th => th.comments.length).length;
    vscode.commands.executeCommand('setContext', 'worktreeGraph.agentReviewPending', n > 0);
    if (!n) return this.status.hide();
    this.status.text = `$(comment-discussion) ${t('{0} comment(s) for the agent', n)}`;
    this.status.tooltip = t('Click to send the review comments to the agent of the worktree.');
    this.status.show();
  }

  add(reply: vscode.CommentReply) {
    const th = reply.thread;
    th.comments = [...th.comments, new NoteComment(reply.text)];
    th.label = t('For the agent');
    th.canReply = true;
    th.contextValue = 'agentReview';
    this.threads.add(th);
    this.update();
  }

  deleteThread(th: vscode.CommentThread) {
    this.threads.delete(th);
    th.dispose();
    this.update();
  }

  deleteComment(c: NoteComment) {
    for (const th of this.threads) {
      if (!th.comments.includes(c)) continue;
      th.comments = th.comments.filter(x => x !== c);
      if (!th.comments.length) this.deleteThread(th);
      break;
    }
    this.update();
  }

  clear() {
    for (const th of this.threads) th.dispose();
    this.threads.clear();
    this.update();
  }

  /** Manda os comentários de uma worktree ao agente dela (pergunta qual, se houver mais de uma). */
  async send(arg?: { path?: string } | vscode.CommentThread) {
    const byWt = new Map<string, { path: string; branch?: string; notes: ReviewNote[] }>();
    for (const th of this.threads) {
      const w = this.worktreeOf(th.uri.fsPath);
      if (!w) continue;
      const k = keyOf(w.path);
      if (!byWt.has(k)) byWt.set(k, { path: w.path, branch: w.branch, notes: this.pending(w.path) });
    }
    const hint = arg && 'uri' in arg ? this.worktreeOf(arg.uri.fsPath)?.path : (arg as { path?: string } | undefined)?.path;
    let target = hint ? byWt.get(keyOf(hint)) : byWt.size === 1 ? [...byWt.values()][0] : undefined;
    if (!target && byWt.size > 1) {
      const pick = await vscode.window.showQuickPick(
        [...byWt.values()].map(v => ({ label: v.branch ?? path.basename(v.path), description: t('{0} comment(s)', v.notes.length), v })),
        { placeHolder: t('Send the comments of which worktree?') },
      );
      target = pick?.v;
    }
    if (!target?.notes.length) {
      vscode.window.showInformationMessage(t('No review comments for the agent. Click the + in the editor gutter of a worktree file to comment a line.'));
      return;
    }
    const full = `${t('Review of your changes in {0}. Address each comment below (file:line, the code and what to change), run the tests and commit.', target.branch ?? target.path)}\n\n${reviewText(target.notes)}`;
    const line = t('I left {0} review comment(s) on your changes. Read them with the agentyard review_comments tool, address each one, run the tests and commit.', target.notes.length);
    const how = await this.integration.sendTask(target.path, target.branch, line, full);
    this.sent.set(keyOf(target.path), target.notes);
    for (const th of [...this.threads]) if (keyOf(this.worktreeOf(th.uri.fsPath)?.path ?? '') === keyOf(target.path)) this.deleteThread(th);
    vscode.window.setStatusBarMessage(how === 'typed' ? t('Comments sent to the Claude open in {0}.', target.branch ?? target.path) : t('Agent opened in {0} with the comments.', target.branch ?? target.path), 5000);
  }

  dispose() {
    this.clear();
    this.disposables.forEach(d => d.dispose());
  }
}

export function registerAgentReview(ctx: vscode.ExtensionContext, ctl: Controller, bridge: ClaudeBridge, integration: ClaudeIntegration) {
  const r = new AgentReviewComments(ctl, bridge, integration);
  ctx.subscriptions.push(
    r,
    vscode.commands.registerCommand('worktreeGraph.agentReview.add', (reply: vscode.CommentReply) => r.add(reply)),
    vscode.commands.registerCommand('worktreeGraph.agentReview.deleteThread', (th: vscode.CommentThread) => r.deleteThread(th)),
    vscode.commands.registerCommand('worktreeGraph.agentReview.deleteComment', (c: NoteComment) => r.deleteComment(c)),
    vscode.commands.registerCommand('worktreeGraph.agentReview.clear', () => r.clear()),
    vscode.commands.registerCommand('worktreeGraph.agentReview.send', async (arg?: { path?: string } | vscode.CommentThread) => {
      try {
        await r.send(arg);
      } catch (e) {
        vscode.window.showErrorMessage(`AgentYard: ${(e as Error).message}`);
      }
    }),
  );
  return r;
}
