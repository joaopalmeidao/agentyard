import * as vscode from 'vscode';
import type { Controller } from '../controller';
import { showCommit } from '../commits';
import { ASK_PRESETS, askPrompt, BranchFacts, LOG_FORMAT, parseLog, summaryMarkdown } from './core';

type Guard = <T extends unknown[]>(fn: (...args: T) => unknown) => (...args: T) => Promise<void>;
/** Item da árvore (worktree, branch, "Commits × base") ou nome de branch. */
type Arg = string | { branch?: string; path?: string } | undefined;

/** Coleta o que a branch/worktree fez em relação à base. Na própria base, os últimos commits. */
export async function branchFacts(ctl: Controller, a: Arg): Promise<BranchFacts | undefined> {
  const repo = ctl.repo;
  if (!repo) return undefined;
  const target = typeof a === 'string' ? { branch: a } : a?.branch || a?.path ? a : await pickTarget(ctl);
  if (!target) return undefined;
  const wts = (await repo.worktreesFast()).filter(w => !w.prunable && !w.bare);
  const wt = target.path ? wts.find(w => w.path.toLowerCase() === target.path!.toLowerCase()) : wts.find(w => w.branch === target.branch);
  const branch = target.branch ?? wt?.branch;
  const ref = branch ?? 'HEAD';
  const cwd = wt?.path ?? repo.root;
  const { base, baseRef } = await ctl.base();
  const isBase = branch === base;

  const [log, behind, stat, status] = await Promise.all([
    repo.exec(['log', LOG_FORMAT, ...(isBase ? ['-n30', ref] : [`${baseRef}..${ref}`]), '--'], cwd),
    isBase ? Promise.resolve('0') : repo.exec(['rev-list', '--count', `${ref}..${baseRef}`], cwd),
    isBase ? Promise.resolve({ code: 1, stdout: '' }) : repo.run(['diff', '--stat', '--stat-width=120', `${baseRef}...${ref}`], cwd),
    wt ? repo.exec(['status', '--short'], wt.path) : Promise.resolve(''),
  ]);
  return {
    label: branch ?? `HEAD destacado (${wt ? wt.path : ''})`,
    ref,
    baseRef: isBase ? `${ref} (a própria base; últimos 30 commits)` : baseRef,
    path: wt?.path,
    commits: parseLog(log),
    behind: Number(String(behind).trim()) || 0,
    diffStat: stat.code === 0 ? stat.stdout : '',
    uncommitted: status.split(/\r?\n/).filter(Boolean),
  };
}

async function pickTarget(ctl: Controller): Promise<{ branch?: string; path?: string } | undefined> {
  const repo = ctl.repo!;
  const wts = (await repo.worktreesFast()).filter(w => !w.prunable && !w.bare);
  const withWt = new Set(wts.map(w => w.branch));
  const branches = (await repo.refs()).filter(r => r.kind === 'head' && !withWt.has(r.name)).sort((x, y) => y.date - x.date);
  const pick = await vscode.window.showQuickPick(
    [
      ...wts.map(w => ({ label: `$(folder) ${w.branch ?? 'HEAD destacado'}`, description: w.path, t: { branch: w.branch, path: w.path } })),
      ...branches.map(r => ({ label: `$(git-branch) ${r.name}`, description: 'sem worktree', detail: r.subject, t: { branch: r.name } as { branch?: string; path?: string } })),
    ],
    { placeHolder: 'Qual worktree ou branch?', matchOnDescription: true },
  );
  return pick?.t;
}

/** Resumo, pergunta ao agente e cópia do contexto de uma branch/worktree (menu da view Worktrees). */
export function registerSummary(ctx: vscode.ExtensionContext, ctl: Controller, guard: Guard) {
  const reg = (id: string, fn: (...args: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(`worktreeGraph.${id}`, guard(fn)));

  reg('branchSummary', async (a: Arg) => {
    const f = await branchFacts(ctl, a);
    if (!f) return;
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: summaryMarkdown(f) });
    await vscode.commands.executeCommand('markdown.showPreview', doc.uri).then(undefined, () => vscode.window.showTextDocument(doc, { preview: true }));
  });

  reg('copyBranchContext', async (a: Arg) => {
    const f = await branchFacts(ctl, a);
    if (!f) return;
    await vscode.env.clipboard.writeText(summaryMarkdown(f));
    vscode.window.setStatusBarMessage(`$(clippy) Resumo de ${f.label} copiado (${f.commits.length} commit(s))`, 3000);
  });

  reg('askAgentAboutBranch', async (a: Arg) => {
    const f = await branchFacts(ctl, a);
    if (!f) return;
    const pick = await vscode.window.showQuickPick(ASK_PRESETS, { placeHolder: `O que perguntar ao agente sobre ${f.label}? (${f.commits.length} commit(s) × base)` });
    if (!pick) return;
    let question: string | undefined;
    if (pick.ask === 'free') {
      question = await vscode.window.showInputBox({ title: `Pergunta sobre ${f.label}`, prompt: 'O agente recebe junto a lista de commits e arquivos alterados.', ignoreFocusOut: true });
      if (!question?.trim()) return;
    }
    // Branch sem worktree: o agente abre na worktree da base e lê a branch pelo git, sem checkout.
    const path = f.path ?? (await ctl.repo!.worktreesFast()).find(w => !w.prunable && !w.bare)?.path ?? ctl.repo!.root;
    await vscode.commands.executeCommand('worktreeGraph.launchAgentWithPrompt', { path, prompt: askPrompt(f, pick.ask, question) });
  });

  reg('showCommitSha', (sha?: string | { sha?: string }) => {
    const s = typeof sha === 'string' ? sha : sha?.sha;
    return s && showCommit(ctl, s);
  });
}
