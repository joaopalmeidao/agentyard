import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentFlow } from '../agentFlow/register';
import type { AgentTerminals } from '../agents';
import type { Controller } from '../controller';
import { branchMatches } from '../git';
import { t } from '../i18n';
import type { WorktreeView } from '../model';
import { askTask } from '../taskInput';
import { batchPlan, budgetLevel, findOverlaps, isActive, Overlap, overlapKey, overlapSummary } from './core';
import { OverlapPanel } from './panel';

const key = (p: string) => path.normalize(p).toLowerCase();

/**
 * Coordenação de vários agentes: sobreposição de arquivos entre worktrees ativas, tarefa em lote e
 * orçamento por worktree.
 */
export class Coord implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  /** Arquivos dos commits fora da base, por worktree, em cache pelo HEAD (um git log por HEAD novo). */
  private readonly committed = new Map<string, { head: string; files: Set<string> }>();
  overlaps: Overlap[] = [];
  private summary = new Map<string, { with: string[]; files: number }>();
  private readonly notified = new Set<string>();
  private readonly budgetNotified = new Set<string>();
  private computing?: Promise<void>;
  private readonly overlapsChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeOverlaps = this.overlapsChanged.event;
  /** Worktrees "em espera" da tarefa em lote: abrem quando um agente termina. */
  private readonly batchWaiting: { path: string; branch?: string; prompt: string }[] = [];

  constructor(private readonly ctl: Controller, private readonly agentTerms: AgentTerminals, agentFlow?: AgentFlow) {
    this.disposables.push(this.overlapsChanged);
    ctl.stateHooks.push(s => {
      for (const w of s.worktrees) {
        const o = this.summary.get(key(w.path));
        w.overlap = o ? { with: o.with, files: o.files } : undefined;
        const b = budgetLevel(w.claude, this.limits());
        w.budget = b.level === 'ok' ? undefined : { level: b.level, pct: Math.round(b.ratio * 100), by: b.by };
      }
    });
    // detalhe terminado: recalcula sobreposições e confere o orçamento
    this.disposables.push(
      ctl.onDidChange(s => {
        if (!s || s.pending > 0) return;
        void this.recompute();
        this.checkBudget();
      }),
    );
    if (agentFlow) {
      this.disposables.push(
        agentFlow.watch.onDidFinish(() => void this.drainBatch()),
      );
    }
    this.disposables.push(vscode.window.onDidCloseTerminal(() => setTimeout(() => void this.drainBatch(), 500)));
  }

  // ---------- sobreposição ----------

  /** Recalcula (no máximo uma vez por vez); git só para worktrees ativas com HEAD novo. */
  recompute(): Promise<void> {
    if (this.computing) return this.computing;
    this.computing = this.doRecompute().finally(() => (this.computing = undefined));
    return this.computing;
  }

  private async doRecompute() {
    const s = this.ctl.state;
    const repo = this.ctl.repo;
    if (!s || !repo) return;
    const active = s.worktrees.filter(w => isActive(w));
    const touched = new Map<string, Set<string>>();
    for (const w of active) {
      const files = new Set<string>();
      if (w.compareKnown && w.ahead > 0 && w.head) {
        const k = key(w.path);
        let c = this.committed.get(k);
        if (!c || c.head !== w.head) {
          const r = await repo.run(['log', '--format=', '--name-only', '--no-renames', `${s.baseSha || s.baseRef}..${w.head}`]);
          c = { head: w.head, files: new Set(r.code === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : []) };
          this.committed.set(k, c);
        }
        for (const f of c.files) files.add(f);
      }
      const st = this.ctl.cache.statuses.get(key(w.path));
      for (const [, rel] of st?.files ?? []) if (!rel.endsWith('/')) files.add(rel);
      touched.set(w.path, files);
    }
    const before = JSON.stringify([...this.summary]);
    const beforeList = JSON.stringify(this.overlaps);
    this.overlaps = findOverlaps(touched);
    if (JSON.stringify(this.overlaps) !== beforeList) this.overlapsChanged.fire();
    this.summary = new Map([...overlapSummary(this.overlaps)].map(([p, v]) => [key(p), v] as [string, { with: string[]; files: number }]));
    for (const [p, v] of this.summary) v.with = v.with.map(o => this.nameOf(o));
    if (JSON.stringify([...this.summary]) !== before) this.ctl.scheduleRefresh(50);
    for (const o of this.overlaps) {
      const k = overlapKey(o);
      if (this.notified.has(k)) continue;
      this.notified.add(k);
      const viewFiles = t('View files');
      const analyze = t('Analyze merge');
      void vscode.window
        .showWarningMessage(t('AgentYard: {0} and {1} touch the same {2} file(s).', this.nameOf(o.a), this.nameOf(o.b), o.files.length), viewFiles, analyze)
        .then(p => {
          if (p === viewFiles) void this.showOverlap(o.a);
          if (p === analyze) void this.analyzePair(o);
        });
    }
  }

  nameOf(p: string) {
    return this.ctl.state?.worktrees.find(w => key(w.path) === key(p))?.name ?? path.basename(p);
  }

  private wtOf(arg: unknown): WorktreeView | undefined {
    const s = this.ctl.state;
    if (!s) return undefined;
    const a = arg as { path?: string; branch?: string } | string | undefined;
    if (typeof a === 'string') return s.worktrees.find(w => w.branch === a || key(w.path) === key(a));
    if (a?.path) return s.worktrees.find(w => key(w.path) === key(a.path!));
    if (a?.branch) return s.worktrees.find(w => w.branch === a.branch);
    return undefined;
  }

  async analyzePair(o: Overlap) {
    const a = this.wtOf(o.a);
    const b = this.wtOf(o.b);
    if (a?.branch && b?.branch) await vscode.commands.executeCommand('worktreeGraph.analyzeMerge', a.branch, b.branch);
  }

  /** Tela com as sobreposições (de uma worktree, ou todas) e as ações de cada par. */
  async showOverlap(arg?: unknown) {
    const wt = arg ? this.wtOf(arg) : undefined;
    await OverlapPanel.show(this.ctl, this, wt?.path);
  }

  /** Abre o agente da worktree `side` (um dos lados do par) avisando dos arquivos em comum. */
  async warnAgent(o: Overlap, side: string) {
    const me = this.wtOf(side);
    const otherPath = me && key(me.path) === key(o.a) ? o.b : o.a;
    if (!me) return;
    const prompt = [
      t('Heads up: the worktree {0} (another task running in parallel) is also changing these files:', this.nameOf(otherPath)),
      ...o.files.map(f => `- ${f}`),
      '',
      t(
        'To avoid merge conflicts, check its changes ({0}), keep your changes to these files as small as possible and say so if your task depends on what the other one is doing.',
        `git diff ${me.branch ?? ''}...${this.nameOf(otherPath)} -- <${t('file')}>`,
      ),
    ].join('\n');
    await this.agentTerms.launchWithPrompt(me.path, me.branch, prompt);
  }

  // ---------- tarefa em lote ----------

  private maxParallel() {
    return Math.max(1, this.ctl.cfg().get<number>('batch.maxParallel', 3));
  }

  private runningAgents(): number {
    return [...this.agentTerms.running().values()].reduce((n, l) => n + l.length, 0);
  }

  async batch(opts?: { paths?: string[]; prompt?: string }) {
    const s = this.ctl.state;
    if (!s) return;
    let targets = s.worktrees.filter(w => !w.prunable && !w.bare && !w.isBase);
    if (opts?.paths) {
      const set = new Set(opts.paths.map(key));
      targets = targets.filter(w => set.has(key(w.path)));
    } else {
      const pattern = await vscode.window.showInputBox({ title: t('Batch task: filter worktrees'), prompt: t('Branch pattern (e.g. {0}); empty = all', 'ai/*'), ignoreFocusOut: true });
      if (pattern === undefined) return;
      const pool = pattern.trim() ? targets.filter(w => w.branch && branchMatches(w.branch, pattern.split(/\s+/))) : targets;
      const picked = await vscode.window.showQuickPick(
        pool.map(w => ({ label: w.name, description: w.path, picked: isActive(w) || !!pattern.trim(), w })),
        { canPickMany: true, title: t('Send the task to which worktrees?'), matchOnDescription: true },
      );
      if (!picked?.length) return;
      targets = picked.map(p => p.w);
    }
    const blocked = this.budgetBlocked();
    const skipped = targets.filter(w => blocked.has(key(w.path)));
    targets = targets.filter(w => !blocked.has(key(w.path)));
    const prompt =
      opts?.prompt ??
      (await askTask({ title: t('Task for {0} worktree(s)', targets.length), prompt: t('What each agent should do; {0} becomes the branch name', '${branch}') }));
    if (!prompt?.trim()) return;
    const text = (w: WorktreeView) => prompt.replace(/\$\{branch\}/g, w.branch ?? w.name);
    const plan = batchPlan(targets, this.maxParallel(), this.runningAgents());
    this.batchWaiting.push(...plan.later.map(w => ({ path: w.path, branch: w.branch, prompt: text(w) })));
    for (const w of plan.now) await this.agentTerms.launchWithPrompt(w.path, w.branch, text(w));
    const msg =
      this.batchWaiting.length
        ? t('Task sent to {0} worktree(s); {1} waiting for a slot.', targets.length, this.batchWaiting.length)
        : t('Task sent to {0} worktree(s).', targets.length);
    vscode.window.showInformationMessage(skipped.length ? `${msg} ${t('{0} skipped for going over budget.', skipped.length)}` : msg);
  }

  /** Abre os que estavam esperando, conforme vagam agentes. */
  async drainBatch() {
    if (!this.batchWaiting.length) return;
    const plan = batchPlan(this.batchWaiting.slice(), this.maxParallel(), this.runningAgents());
    this.batchWaiting.splice(0, plan.now.length);
    for (const w of plan.now) await this.agentTerms.launchWithPrompt(w.path, w.branch, w.prompt);
  }

  get batchPending() {
    return this.batchWaiting.length;
  }

  // ---------- orçamento ----------

  private limits() {
    const c = this.ctl.cfg();
    return { tokens: c.get<number>('budget.perWorktreeTokens', 0) || undefined, usd: c.get<number>('budget.perWorktreeUsd', 0) || undefined };
  }

  /** Worktrees que ficam fora das tarefas em lote (budget.action = pause-queue, ou o antigo block-prompts, e limite estourado). */
  budgetBlocked(): Set<string> {
    const out = new Set<string>();
    if (!['pause-queue', 'block-prompts'].includes(this.ctl.cfg().get<string>('budget.action', 'warn'))) return out;
    for (const w of this.ctl.state?.worktrees ?? []) if (budgetLevel(w.claude, this.limits()).level === 'over') out.add(key(w.path));
    return out;
  }

  private checkBudget() {
    const lim = this.limits();
    if (!lim.tokens && !lim.usd) return;
    for (const w of this.ctl.state?.worktrees ?? []) {
      const b = budgetLevel(w.claude, lim);
      if (b.level === 'ok') continue;
      const k = `${key(w.path)}|${b.level}`;
      if (this.budgetNotified.has(k)) continue;
      this.budgetNotified.add(k);
      const pct = Math.round(b.ratio * 100);
      void vscode.window.showWarningMessage(
        b.level === 'over'
          ? t('AgentYard: {0} went over budget ({1}% in {2}).', w.name, pct, b.by === 'usd' ? 'US$' : 'tokens') +
              (['pause-queue', 'block-prompts'].includes(this.ctl.cfg().get<string>('budget.action', 'warn')) ? ` ${t('New automatic tasks for it are on hold.')}` : '')
          : t('AgentYard: {0} used {1}% of the budget.', w.name, pct),
      );
    }
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
  }
}

export function registerCoord(ctx: vscode.ExtensionContext, ctl: Controller, agentTerms: AgentTerminals, agentFlow?: AgentFlow): Coord {
  const coord = new Coord(ctl, agentTerms, agentFlow);
  const reg = (id: string, fn: (...a: any[]) => unknown) =>
    ctx.subscriptions.push(
      vscode.commands.registerCommand(`worktreeGraph.${id}`, async (...a: any[]) => {
        try {
          await fn(...a);
        } catch (e) {
          vscode.window.showErrorMessage(`AgentYard: ${(e as Error).message}`);
        }
      }),
    );
  reg('coord.showOverlaps', (arg?: unknown) => coord.showOverlap(arg));
  reg('showOverlaps', (a?: { path?: string }) => coord.showOverlap(a?.path ? { path: a.path } : undefined));
  reg('batchTask', (opts?: any) => coord.batch(opts && typeof opts === 'object' && !opts.path ? opts : undefined));
  ctx.subscriptions.push(coord);
  return coord;
}
