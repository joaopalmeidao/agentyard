import * as vscode from 'vscode';
import { fillTemplate } from '../agents';
import type { AgentFlow } from '../agentFlow/register';
import { keyOf } from '../agentFlow/head';
import type { ClaudeBridge } from '../bridge/register';
import type { ClaudeIntegration } from '../claude/integration';
import { osNotify } from '../claude/osNotify';
import type { Controller } from '../controller';
import type { Pipeline } from '../hosting/pipelines';
import type { PipelineService } from '../hosting/pipelinesView';
import { t } from '../i18n';
import { pushBranch } from '../push';
import { feedbackText, openThreads, PrFeedback, PullRequestInfo } from './core';
import type { registerPullRequests } from './view';

type Prs = ReturnType<typeof registerPullRequests>;

interface Deps {
  prs: Prs;
  bridge: ClaudeBridge;
  integration: ClaudeIntegration;
  agentFlow: AgentFlow;
  pipelines: PipelineService;
}

/** Conversas mandadas ao agente, por branch: quando ele terminar, dá para responder e resolver no PR. */
interface Pending {
  ref: string;
  threads: string[];
  at: number;
}

const PENDING_KEY = 'prFeedback.pending';

export function defaultFeedbackPrompt(): string {
  return t(
    'The review of ${ref} ("${title}", ${url}) on branch ${branch} asked for changes. Address each point below: fix the code, run the tests, commit and push. If you disagree with a point, explain why in your final message instead of changing the code.\n\n${feedback}',
  );
}

/**
 * Revisão e CI → agente: manda o que a revisão do PR pediu (e o CI que falhou) para o Claude da
 * worktree, e as ferramentas MCP pr_feedback e ci_status para ele buscar sozinho.
 */
export function registerPrFeedback(ctx: vscode.ExtensionContext, ctl: Controller, guard: <T extends unknown[]>(fn: (...a: T) => unknown) => (...a: T) => Promise<void>, d: Deps) {
  const { svc, prOf, bring } = d.prs;
  const pending = () => ctx.workspaceState.get<Record<string, Pending>>(PENDING_KEY, {});
  const setPending = (branch: string, p: Pending | undefined) => {
    const all = pending();
    if (p) all[branch] = p;
    else delete all[branch];
    return ctx.workspaceState.update(PENDING_KEY, all);
  };

  /** PR aberto de uma branch (busca a lista se ainda não tem). */
  const prOfBranch = async (branch: string): Promise<PullRequestInfo | undefined> => {
    const find = () => svc.all().find(p => p.source === branch && (p.state === 'open' || p.state === 'draft'));
    if (!find()) await svc.refresh(true);
    return find();
  };

  const load = async (p: PullRequestInfo): Promise<PrFeedback | undefined> => {
    const b = await svc.browser();
    if (!b?.can.threads) {
      vscode.window.showWarningMessage(t('Reading review threads is not available for this platform yet.'));
      return undefined;
    }
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Reading the review of {0}…', p.ref) }, () => b.feedback(p));
  };

  /** Manda o que a revisão pediu ao agente da worktree do PR (trazendo a branch, se preciso). */
  const send = async (p: PullRequestInfo) => {
    const fb = await load(p);
    if (!fb) return;
    const open = openThreads(fb);
    const reviews = fb.reviews.filter(r => r.author.toLowerCase() !== svc.me.toLowerCase());
    if (!open.length && !reviews.some(r => r.state === 'changes_requested')) {
      vscode.window.showInformationMessage(t('{0} has no unresolved review threads.', p.ref));
      return;
    }
    const dir = svc.worktreeOf(p)?.path ?? (await bring(p, false));
    const wt = dir ? ctl.state?.worktrees.find(w => keyOf(w.path) === keyOf(dir)) : undefined;
    if (!dir) return;
    const branch = wt?.branch ?? p.source;
    const template = ctl.cfg().get<string>('prompts.prFeedback', '') || defaultFeedbackPrompt();
    const full = fillTemplate(template, { ref: p.ref, title: p.title, url: p.url, branch, feedback: feedbackText(p, fb, svc.me) });
    const line = t('The review of {0} left {1} unresolved thread(s). Read them with the agentyard pr_feedback tool, fix what they ask, run the tests, commit and push, then call mark_ready.', p.ref, open.length);
    const how = await d.integration.sendTask(dir, branch, line, full);
    await setPending(branch, { ref: p.ref, threads: open.map(x => x.id), at: Date.now() });
    vscode.window.setStatusBarMessage(
      how === 'typed' ? t('Review of {0} sent to the Claude already open in {1}.', p.ref, branch) : t('Agent opened in {0} with the review of {1}.', branch, p.ref),
      5000,
    );
  };

  /** Responde e resolve no PR as conversas que foram mandadas ao agente. */
  const resolveSent = async (branch: string, push: boolean) => {
    const pend = pending()[branch];
    const p = pend && (svc.find(pend.ref) ?? (await prOfBranch(branch)));
    const b = await svc.browser();
    if (!pend || !p || !b?.can.threads) return;
    const wt = ctl.state?.worktrees.find(w => w.branch === branch);
    if (push && !(await pushBranch(ctl, branch, { quiet: true }))) return;
    const sha = wt ? (await ctl.repo?.run(['rev-parse', '--short', 'HEAD'], wt.path))?.stdout.trim() : '';
    const reply = sha ? t('Addressed in {0}.', sha) : t('Addressed.');
    let ok = 0;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Resolving the threads of {0}…', p.ref) }, async () => {
      for (const id of pend.threads) {
        try {
          await b.resolveThread(p, id, reply);
          ok++;
        } catch (e) {
          ctl.log(t('Could not resolve thread {0} of {1}: {2}', id, p.ref, (e as Error).message));
        }
      }
    });
    await setPending(branch, undefined);
    vscode.window.showInformationMessage(t('{0} of {1} thread(s) of {2} answered and resolved.', ok, pend.threads.length, p.ref));
    void svc.refresh(true);
  };

  // quando o agente termina uma worktree com conversas pendentes, oferece responder e resolver
  ctx.subscriptions.push(
    d.agentFlow.watch.onDidFinish(async f => {
      if (!f.ready || !f.branch) return;
      const pend = pending()[f.branch];
      if (!pend) return;
      const go = t('Push and resolve');
      const only = t('Only resolve');
      const pick = await vscode.window.showInformationMessage(
        t('The agent finished the review changes of {0} on {1}. Reply "addressed" and resolve the {2} thread(s) on the {3}?', pend.ref, f.branch, pend.threads.length, pend.ref.startsWith('!') ? 'MR' : 'PR'),
        go,
        only,
        t('Keep open'),
      );
      if (pick === go) await resolveSent(f.branch, true);
      else if (pick === only) await resolveSent(f.branch, false);
      else if (pick) await setPending(f.branch, undefined);
    }),
  );

  const reg = (id: string, fn: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(`worktreeGraph.${id}`, guard(fn)));
  reg('pullRequests.sendFeedback', async arg => {
    const p = await prOf(arg);
    if (p) await send(p);
  });
  /** Da worktree/branch: acha o PR aberto dela. */
  reg('sendPrFeedback', async (arg?: { branch?: string; path?: string } | string) => {
    const branch = typeof arg === 'string' ? arg : arg?.branch ?? ctl.state?.worktrees.find(w => arg?.path && keyOf(w.path) === keyOf(arg.path))?.branch;
    const p = branch ? await prOfBranch(branch) : await prOf(undefined);
    if (!p) {
      vscode.window.showInformationMessage(t('No open PR/MR for {0}.', branch ?? '?'));
      return;
    }
    await send(p);
  });
  reg('resolveSentFeedback', async (arg?: { branch?: string } | string) => {
    const branch = typeof arg === 'string' ? arg : arg?.branch;
    const names = Object.keys(pending());
    const b = branch ?? (names.length === 1 ? names[0] : (await vscode.window.showQuickPick(names, { placeHolder: t('Resolve the threads sent from which branch?') })));
    if (b) await resolveSent(b, false);
  });

  // ------------------------------------------------------------ ferramentas MCP

  d.bridge.addTool('pr_feedback', async (args, { cwd, open }) => {
    const w = d.bridge.resolve(args.worktree ?? open?.path, cwd);
    if (!w.branch) return { text: 'This worktree has no branch.', isError: true };
    const p = await prOfBranch(w.branch);
    if (!p) return `No open PR/MR for ${w.branch}.`;
    const b = await svc.browser();
    if (!b?.can.threads) return { text: 'Reading review threads is not supported for this hosting platform.', isError: true };
    return feedbackText(p, await b.feedback(p), svc.me);
  });

  d.bridge.addTool('ci_status', async (args, { cwd, open }) => {
    const w = d.bridge.resolve(args.worktree ?? open?.path, cwd);
    if (!w.branch) return { text: 'This worktree has no branch.', isError: true };
    await d.pipelines.refresh();
    const list = d.pipelines.pipelines.filter(p => p.branch === w.branch);
    if (!list.length) return d.pipelines.unavailable ? `CI not available (${d.pipelines.unavailable}).` : `No pipelines for ${w.branch}.`;
    const latest = list[0];
    const head = `${latest.name} #${latest.id}: ${latest.status} (${latest.event}, ${latest.sha.slice(0, 8)}) — ${latest.url}`;
    if (latest.status !== 'failed') return head;
    const f = await d.pipelines.failure(latest, false);
    if (!f) return `${head}\n(could not read the jobs: no credentials)`;
    return `${head}\nFailed jobs: ${f.failed.map(j => j.name).join(', ') || '(not identified)'}\n\nEnd of the log of ${f.failed[0]?.name ?? '?'}:\n${f.log || '(no log)'}`;
  });

  // ------------------------------------------------------------ CI que falhou

  d.pipelines.onFailure = async (p: Pipeline) => {
    if (!vscode.window.state.focused) osNotify(ctl, 'AgentYard', t('Pipeline "{0}" failed on {1}.', p.name, p.branch));
    if (ctl.cfg().get<string>('pipelines.onFailure', 'ask') !== 'agent') return false;
    const wt = ctl.state?.worktrees.find(w => w.branch === p.branch && !w.prunable);
    // só manda sozinho se há um Claude com a ponte aberto e parado ali; senão, a notificação de sempre
    const idle = wt && d.integration.hasIdleAgent(wt.path);
    if (!wt || !idle) return false;
    const full = await d.pipelines.fixPrompt(p);
    if (!full) return false;
    const line = t('The CI pipeline "{0}" failed on this branch. Read the failure with the agentyard ci_status tool, fix it, run the tests, commit and push.', p.name);
    await d.integration.sendTask(wt.path, wt.branch, line, full);
    vscode.window.setStatusBarMessage(t('Pipeline "{0}" failed on {1}: sent to the Claude open there.', p.name, p.branch), 8000);
    return true;
  };
}
