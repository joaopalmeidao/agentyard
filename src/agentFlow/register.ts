import * as path from 'path';
import * as vscode from 'vscode';
import * as actions from '../actions';
import type { AgentTerminals } from '../agents';
import type { Controller } from '../controller';
import type { Issue } from '../issues/core';
import { DEFAULT_ISSUE_PROMPT, renderPrompt } from '../issues/core';
import { Attempts } from './attempts';
import { keyOf } from './head';
import { TaskItem, TaskQueue, TasksProvider } from './tasks';
import { AgentWatch, ReadyInfo } from './watch';

export interface AgentFlow {
  watch: AgentWatch;
  tasks: TaskQueue;
  attempts: Attempts;
  /** Ações vindas do painel; devolve true se tratou. */
  handle(action: string, a: Record<string, string>): Promise<boolean>;
}

type Arg = { path?: string; branch?: string } | string | undefined;

/** Worktree a partir de item da árvore, card do painel, nome de branch ou pergunta. */
async function resolveWorktree(ctl: Controller, arg: Arg, placeHolder: string): Promise<{ path: string; branch?: string } | undefined> {
  const repo = ctl.repo;
  if (!repo) return undefined;
  const wts = (await repo.worktreesFast()).filter(w => !w.prunable && !w.bare);
  if (typeof arg === 'object' && arg?.path) return { path: arg.path, branch: arg.branch ?? wts.find(w => keyOf(w.path) === keyOf(arg.path!))?.branch };
  const b = typeof arg === 'string' ? arg : arg?.branch;
  if (b) {
    const wt = wts.find(w => w.branch === b);
    return wt ? { path: wt.path, branch: b } : undefined;
  }
  const pick = await vscode.window.showQuickPick(
    wts.map(w => ({ label: w.branch ?? path.basename(w.path), description: w.path, w })),
    { placeHolder },
  );
  return pick ? { path: pick.w.path, branch: pick.w.branch } : undefined;
}

export function registerAgentFlow(ctx: vscode.ExtensionContext, ctl: Controller, agentTerms: AgentTerminals): AgentFlow {
  const notify = async (r: ReadyInfo) => {
    if (!ctl.cfg().get<boolean>('agents.notifyReady', true)) return;
    const name = r.branch ?? path.basename(r.path);
    const L = ctl.requests.label;
    const pick = await vscode.window.showInformationMessage(
      `✓ ${name}: o agente terminou${r.commits ? ` (${r.commits} commit(s) novos)` : ''}. Pronto para revisar.`,
      'Revisar',
      'Analisar merge',
      `Publicar ${L}`,
      'Abrir terminal',
    );
    if (!pick) return;
    if (pick !== 'Abrir terminal') await watch.clearReady(r.path);
    if (pick === 'Revisar' && r.branch) await actions.diffWithBase(ctl, r.branch);
    if (pick === 'Analisar merge' && r.branch) await vscode.commands.executeCommand('worktreeGraph.analyzeMerge', r.branch);
    if (pick === `Publicar ${L}` && r.branch) await ctl.requests.publish(r.branch);
    if (pick === 'Abrir terminal') await actions.openTerminal(ctl, { path: r.path });
  };

  const watch = new AgentWatch(ctl, agentTerms, r => void notify(r));
  const tasks = new TaskQueue(ctl, agentTerms, watch);
  const attempts = new Attempts(ctl, agentTerms);
  const tasksView = vscode.window.createTreeView('worktreeGraph.tasks', { treeDataProvider: new TasksProvider(tasks) });
  ctx.subscriptions.push(watch, tasks, tasksView);

  // Estado do painel/árvore: "pronto para revisar" e resumo da fila, por worktree (só leitura de memória).
  ctl.stateHooks.push(s => {
    const ready = watch.readyMap();
    for (const w of s.worktrees) {
      const r = ready[keyOf(w.path)];
      w.review = r ? { at: r.at, commits: r.commits } : undefined;
      w.tasks = tasks.summary(w.path);
    }
  });

  const guard =
    <T extends unknown[]>(fn: (...args: T) => unknown) =>
    async (...args: T) => {
      try {
        await fn(...args);
      } catch (e) {
        vscode.window.showErrorMessage(`AgentYard: ${(e as Error).message}`);
      }
    };
  const reg = (id: string, fn: (...args: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(`worktreeGraph.${id}`, guard(fn)));

  reg('tasks.add', async (arg?: Arg, text?: string) => {
    const wt = await resolveWorktree(ctl, arg, 'Adicionar tarefa em qual worktree?');
    if (wt) await tasks.add(wt.path, wt.branch, text);
  });
  reg('tasks.runNow', (it: TaskItem) => it && tasks.run(it.q.path, it.task.id));
  reg('tasks.moveUp', (it: TaskItem) => it && tasks.move(it.q.path, it.task.id, -1));
  reg('tasks.moveDown', (it: TaskItem) => it && tasks.move(it.q.path, it.task.id, 1));
  reg('tasks.remove', (it: TaskItem) => it && tasks.remove(it.q.path, it.task.id));
  reg('tasks.markDone', (it: TaskItem) => it && tasks.setStatus(it.q.path, it.task.id, 'done'));
  reg('tasks.markFailed', (it: TaskItem) => it && tasks.setStatus(it.q.path, it.task.id, 'failed'));
  reg('tasks.clearFinished', () => tasks.clearFinished());
  reg('agents.checkReady', async (arg?: Arg) => {
    const wt = typeof arg === 'object' || typeof arg === 'string' ? await resolveWorktree(ctl, arg, '') : undefined;
    const any = await watch.checkNow(wt?.path);
    if (!any) vscode.window.showInformationMessage('Nenhum agente pronto: ainda sem commits novos, ou a worktree tem alterações não commitadas.');
  });
  reg('agents.dismissReady', async (arg?: Arg) => {
    const wt = await resolveWorktree(ctl, arg, 'Tirar o "pronto para revisar" de qual worktree?');
    if (wt) await watch.clearReady(wt.path);
  });
  reg('attempts.try', (o?: { prompt?: string; title?: string; n?: number; variations?: string[]; quiet?: boolean }) => attempts.tryApproaches(o ?? {}));
  reg('attempts.fromIssue', async (item?: { issue?: Issue }) => {
    const issue = item?.issue;
    if (!issue) return attempts.tryApproaches();
    const { base } = await ctl.base();
    const template = ctl.cfg().get<string>('prompts.issue', '') || DEFAULT_ISSUE_PROMPT;
    const prompt = renderPrompt(template, { key: issue.key, title: issue.title, body: issue.body || '(sem descrição)', url: issue.url, branch: '(uma por tentativa)', base });
    return attempts.tryApproaches({ title: `${issue.key} ${issue.title}`, prompt });
  });
  reg('attempts.compare', () => attempts.pickAndCompare());

  const handle = async (action: string, a: Record<string, string>): Promise<boolean> => {
    switch (action) {
      case 'addTask':
        await vscode.commands.executeCommand('worktreeGraph.tasks.add', { path: a.path, branch: a.branch });
        return true;
      case 'openTasks':
        await vscode.commands.executeCommand('worktreeGraph.tasks.focus');
        return true;
      case 'reviewReady': {
        const r = watch.readyFor(a.path);
        await watch.clearReady(a.path);
        if (r?.branch ?? a.branch) await actions.diffWithBase(ctl, r?.branch ?? a.branch);
        return true;
      }
      case 'tryApproaches':
        await attempts.tryApproaches(a.prompt ? { prompt: a.prompt } : {});
        return true;
    }
    return false;
  };

  return { watch, tasks, attempts, handle };
}
