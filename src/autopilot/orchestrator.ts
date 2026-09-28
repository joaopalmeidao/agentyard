import * as crypto from 'crypto';
import * as vscode from 'vscode';
import * as actions from '../actions';
import type { AgentTerminals } from '../agents';
import type { AgentFlow } from '../agentFlow/register';
import { keyOf } from '../agentFlow/head';
import { runHeadless } from '../claude/headless';
import type { Controller } from '../controller';
import type { Coord } from '../coord/register';
import { t } from '../i18n';
import { setParent } from '../stack/core';
import type { AgentBoard } from './boardService';
import { blockedBy, extractJson, finished, normalizePlan, Orchestration, planPrompt, startable, startPoint, Subtask, subtaskPrompt, topoOrder } from './plan';

const PREFIX = 'ai/';

/**
 * ✦ Dividir tarefa entre agentes: um Claude sem terminal lê o código e divide a tarefa em subtarefas
 * com dependências; cada uma ganha a sua worktree e o seu agente (as independentes em paralelo, até
 * `batch.maxParallel`; as dependentes empilhadas sobre o que precisam, quando ficam prontas). No fim,
 * as branches vão para a fila de merge na ordem das dependências.
 */
export class Orchestrator implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly ctl: Controller,
    flow: AgentFlow,
    private readonly agentTerms: AgentTerminals,
    private readonly board: AgentBoard,
    private readonly coord: Coord,
  ) {
    this.disposables.push(this.changed, flow.watch.onDidFinish(f => void this.onFinished(f.path, f.ready)));
  }

  private storeKey() {
    return `autopilot.orchestrations:${this.ctl.repo?.commonDir.toLowerCase() ?? ''}`;
  }

  list(): Orchestration[] {
    return this.ctl.ctx.workspaceState.get<Orchestration[]>(this.storeKey(), []);
  }

  private async save(o: Orchestration) {
    await this.ctl.ctx.workspaceState.update(this.storeKey(), [o, ...this.list().filter(x => x.id !== o.id)].slice(0, 20));
    this.changed.fire();
  }

  private async remove(id: string) {
    await this.ctl.ctx.workspaceState.update(this.storeKey(), this.list().filter(x => x.id !== id));
    this.changed.fire();
  }

  private maxParallel() {
    return Math.max(1, this.ctl.cfg().get<number>('batch.maxParallel', 3));
  }

  // ------------------------------------------------------------ planejar

  async start(task?: string) {
    const repo = this.ctl.repo;
    if (!repo) return;
    const text =
      task ??
      (await vscode.window.showInputBox({
        title: t('Split a task among agents'),
        prompt: t('The whole task. Claude reads the code, splits it into parts with dependencies and each part gets its own worktree and agent.'),
        ignoreFocusOut: true,
      }));
    if (!text?.trim()) return;
    const { base } = await this.ctl.base();
    const taken = new Set((await repo.refs()).filter(r => r.kind === 'head').map(r => r.name));
    const root = this.ctl.state?.worktrees.find(w => w.isMain)?.path ?? repo.root;
    let plan: { title: string; subtasks: Subtask[] };
    try {
      plan = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t('Claude is splitting the task into parts…'), cancellable: true },
        async (_p, token) => {
          const ac = new AbortController();
          token.onCancellationRequested(() => ac.abort());
          const r = await runHeadless(planPrompt(text.trim(), base, PREFIX), {
            cwd: root,
            bin: this.ctl.cfg().get<string>('claude.headlessCommand', 'claude'),
            model: this.ctl.cfg().get<string>('orchestrator.model', '') || undefined,
            timeoutMs: 15 * 60_000,
            signal: ac.signal,
          });
          return normalizePlan(extractJson(r.text), PREFIX, taken);
        },
      );
    } catch (e) {
      if ((e as Error).message !== 'canceled') vscode.window.showErrorMessage(t('Could not split the task: {0}', (e as Error).message));
      return;
    }
    const chosen = await this.review(plan.subtasks);
    if (!chosen) return;
    const o: Orchestration = { id: crypto.randomBytes(4).toString('hex'), title: plan.title || text.trim().split(/\r?\n/)[0].slice(0, 80), task: text.trim(), base, created: Date.now(), subtasks: chosen };
    await this.save(o);
    await this.advance(o.id);
  }

  /** Mostra o plano e deixa tirar partes; as dependências das que saíram somem. */
  private async review(subs: Subtask[]): Promise<Subtask[] | undefined> {
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: this.planMarkdown(subs) });
    await vscode.commands.executeCommand('markdown.showPreview', doc.uri).then(undefined, () => vscode.window.showTextDocument(doc, { preview: true }));
    const picks = await vscode.window.showQuickPick(
      subs.map(s => ({
        label: `${s.id}: ${s.title}`,
        description: `${s.branch}${s.dependsOn.length ? ` ← ${s.dependsOn.join(', ')}` : ''}`,
        detail: s.task.replace(/\s+/g, ' ').slice(0, 200),
        picked: true,
        s,
      })),
      { canPickMany: true, ignoreFocusOut: true, title: t('Plan: {0} part(s). Uncheck what you do not want, Enter starts the agents.', subs.length) },
    );
    if (!picks?.length) return undefined;
    const keep = new Set(picks.map(p => p.s.id));
    return picks.map(p => ({ ...p.s, dependsOn: p.s.dependsOn.filter(d => keep.has(d)) }));
  }

  private planMarkdown(subs: Subtask[], o?: Orchestration): string {
    const icon: Record<Subtask['status'], string> = { waiting: '○', running: '◐', ready: '✓', failed: '✗', skipped: '⊘' };
    return [
      `# ${o ? o.title : t('Plan')}`,
      '',
      o ? `${t('From {0}', o.base)} · ${new Date(o.created).toLocaleString()}` : '',
      '',
      ...subs.flatMap(s => [
        `## ${o ? `${icon[s.status]} ` : ''}${s.id}: ${s.title}`,
        '',
        `- ${t('Branch')}: \`${s.branch}\``,
        s.dependsOn.length ? `- ${t('Depends on')}: ${s.dependsOn.join(', ')}` : `- ${t('Starts right away')}`,
        s.files.length ? `- ${t('Reserved files')}: ${s.files.map(f => `\`${f}\``).join(', ')}` : '',
        '',
        s.task,
        '',
      ]),
    ]
      .filter((l, i, a) => l !== '' || a[i - 1] !== '')
      .join('\n');
  }

  // ------------------------------------------------------------ executar

  private get(id: string) {
    return this.list().find(o => o.id === id);
  }

  /** Começa o que pode começar; no fim, oferece a fila de merge. */
  async advance(id: string) {
    const o = this.get(id);
    if (!o) return;
    for (const s of blockedBy(o)) s.status = 'skipped';
    for (const s of startable(o, this.maxParallel())) await this.launch(o, s);
    await this.save(o);
    if (finished(o) && !o.queued) await this.offerQueue(o);
  }

  private async launch(o: Orchestration, s: Subtask) {
    const repo = this.ctl.repo!;
    const { from, merge } = startPoint(o, s);
    const dir = await actions.createWorktree(this.ctl, { branch: s.branch, startPoint: from, quiet: true }).catch(() => undefined);
    if (!dir) {
      s.status = 'failed';
      this.ctl.log(t('Orchestration "{0}": could not create the worktree of {1}.', o.title, s.branch));
      return;
    }
    const notMerged: string[] = [];
    if (s.dependsOn.length) {
      await setParent(repo.root, s.branch, from).catch(() => undefined);
      for (const m of merge) {
        const r = await repo.run(['merge', '--no-edit', m], dir);
        if (r.code !== 0) {
          await repo.run(['merge', '--abort'], dir);
          notMerged.push(m);
        }
      }
    }
    if (s.files.length) this.board.claimFor(dir, s.branch, s.files, o.title);
    s.status = 'running';
    s.path = dir;
    s.started = Date.now();
    const extra = notMerged.length ? `\n\nBefore starting, merge ${notMerged.join(', ')} into this branch (git merge) and resolve the conflicts: AgentYard could not do it automatically.` : '';
    await this.agentTerms.launchWithPrompt(dir, s.branch, subtaskPrompt(o, s) + extra);
    this.ctl.log(t('Orchestration "{0}": {1} started in {2}.', o.title, s.id, s.branch));
  }

  private async onFinished(p: string, ready: boolean) {
    for (const o of this.list()) {
      const s = o.subtasks.find(x => x.status === 'running' && x.path && keyOf(x.path) === keyOf(p));
      if (!s) continue;
      s.status = ready ? 'ready' : 'failed';
      s.finished = Date.now();
      await this.save(o);
      if (!ready) {
        const retry = t('Try again');
        void vscode.window
          .showWarningMessage(t('Orchestration "{0}": the agent of {1} closed without finishing; the parts that depend on it wait.', o.title, s.id), retry)
          .then(pick => {
            if (pick) void this.retry(o.id, s.id);
          });
      }
      await this.advance(o.id);
    }
  }

  private async offerQueue(o: Orchestration) {
    const ready = topoOrder(o.subtasks).filter(s => s.status === 'ready');
    if (!ready.length) return;
    o.queued = true;
    await this.save(o);
    const failed = o.subtasks.length - ready.length;
    const queue = t('Add all to the merge queue');
    const show = t('Show');
    const pick = await vscode.window.showInformationMessage(
      failed
        ? t('Orchestration "{0}": {1} part(s) ready, {2} did not finish.', o.title, ready.length, failed)
        : t('Orchestration "{0}": all {1} part(s) are ready for review.', o.title, ready.length),
      queue,
      show,
    );
    if (pick === queue) await this.coord.enqueue(ready.map(s => s.branch));
    else if (pick === show) await this.show(o.id);
  }

  async retry(id: string, subId: string) {
    const o = this.get(id);
    const s = o?.subtasks.find(x => x.id === subId);
    if (!o || !s) return;
    if (s.path && (this.ctl.state?.worktrees ?? []).some(w => keyOf(w.path) === keyOf(s.path!))) {
      s.status = 'running';
      s.started = Date.now();
      await this.save(o);
      await this.agentTerms.launchWithPrompt(s.path, s.branch, subtaskPrompt(o, s));
      return;
    }
    s.status = 'waiting';
    for (const x of o.subtasks) if (x.status === 'skipped') x.status = 'waiting';
    o.queued = false;
    await this.save(o);
    await this.advance(o.id);
  }

  // ------------------------------------------------------------ ver

  async show(id?: string) {
    const all = this.list();
    if (!all.length) {
      vscode.window.showInformationMessage(t('No task split among agents yet. Use "✦ Split a task among agents…".'));
      return;
    }
    let o = id ? this.get(id) : undefined;
    if (!o) {
      const counts = (x: Orchestration) => t('{0}/{1} ready', x.subtasks.filter(s => s.status === 'ready').length, x.subtasks.length);
      const pick = await vscode.window.showQuickPick(
        all.map(x => ({ label: x.title, description: counts(x), detail: new Date(x.created).toLocaleString(), x })),
        { title: t('Tasks split among agents') },
      );
      o = pick?.x;
    }
    if (!o) return;
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: this.planMarkdown(o.subtasks, o) });
    await vscode.commands.executeCommand('markdown.showPreview', doc.uri).then(undefined, () => vscode.window.showTextDocument(doc, { preview: true }));
    const actionsList = [
      ...o.subtasks.filter(s => s.status === 'failed' || s.status === 'skipped').map(s => ({ label: t('Try {0} again', s.id), run: () => this.retry(o!.id, s.id) })),
      ...(o.subtasks.some(s => s.status === 'ready') ? [{ label: t('Add the ready parts to the merge queue'), run: () => this.coord.enqueue(topoOrder(o!.subtasks).filter(s => s.status === 'ready').map(s => s.branch)) }] : []),
      { label: t('Start what can start now'), run: () => this.advance(o!.id) },
      { label: t('Forget this plan (worktrees stay)'), run: () => this.remove(o!.id) },
    ];
    const act = await vscode.window.showQuickPick(actionsList, { title: o.title });
    if (act) await act.run();
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
  }
}
