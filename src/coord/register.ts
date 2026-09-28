import * as path from 'path';
import * as vscode from 'vscode';
import * as actions from '../actions';
import type { AgentFlow } from '../agentFlow/register';
import type { AgentTerminals } from '../agents';
import type { Controller } from '../controller';
import { resolverName } from '../conflicts';
import { gitUri } from '../diff';
import { branchMatches } from '../git';
import { guardChecks } from '../guards';
import { t } from '../i18n';
import type { WorktreeView } from '../model';
import { pushBranch } from '../push';
import {
  agentFinished,
  batchPlan,
  budgetLevel,
  findOverlaps,
  isActive,
  MergeItem,
  Overlap,
  overlapKey,
  overlapSummary,
  processNext,
  resolveAwaiting,
} from './core';
import { OverlapPanel } from './panel';

const key = (p: string) => path.normalize(p).toLowerCase();
/** Itens que ainda estão na fila (não saíram por merge nem falha). */
const QUEUED: MergeItem['status'][] = ['waiting', 'running', 'agent', 'awaiting-pr'];

/**
 * Coordenação de vários agentes: sobreposição de arquivos entre worktrees ativas, fila de merge,
 * tarefa em lote e orçamento por worktree.
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
  private processing = false;
  /** Pedido de rodar a fila enquanto ela já rodava (ex.: o agente terminou no meio): roda de novo no fim. */
  private runAgain = false;
  private readonly overlapsChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeOverlaps = this.overlapsChanged.event;
  private readonly queueChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeQueue = this.queueChanged.event;
  /** Worktrees "em espera" da tarefa em lote: abrem quando um agente termina. */
  private readonly batchWaiting: { path: string; branch?: string; prompt: string }[] = [];

  constructor(private readonly ctl: Controller, private readonly agentTerms: AgentTerminals, private readonly agentFlow?: AgentFlow) {
    this.disposables.push(this.queueChanged, this.overlapsChanged);
    ctl.stateHooks.push(s => {
      for (const w of s.worktrees) {
        const o = this.summary.get(key(w.path));
        w.overlap = o ? { with: o.with, files: o.files } : undefined;
        const b = budgetLevel(w.claude, this.limits());
        w.budget = b.level === 'ok' ? undefined : { level: b.level, pct: Math.round(b.ratio * 100), by: b.by };
      }
    });
    // detalhe terminado: recalcula sobreposições, confere PRs esperando e orçamento
    this.disposables.push(
      ctl.onDidChange(s => {
        if (!s || s.pending > 0) return;
        void this.recompute();
        void this.checkAwaiting();
        this.checkBudget();
      }),
    );
    if (agentFlow) {
      this.disposables.push(
        agentFlow.watch.onDidFinish(e => {
          void this.drainBatch();
          void this.onAgentFinished(e.path, e.branch, e.ready);
        }),
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

  // ---------- fila de merge ----------

  private queueKey() {
    return `coord.mergeQueue:${this.ctl.repo?.commonDir.toLowerCase() ?? ''}`;
  }

  queue(): MergeItem[] {
    return this.ctl.ctx.workspaceState.get<MergeItem[]>(this.queueKey(), []);
  }

  private async saveQueue(items: MergeItem[]) {
    await this.ctl.ctx.workspaceState.update(this.queueKey(), items);
    this.queueChanged.fire();
  }

  paused(): boolean {
    return this.ctl.ctx.workspaceState.get<boolean>(`${this.queueKey()}:paused`, false);
  }

  async setPaused(v: boolean) {
    await this.ctl.ctx.workspaceState.update(`${this.queueKey()}:paused`, v);
    this.queueChanged.fire();
    if (!v) void this.runQueue();
  }

  /**
   * Põe uma ou várias branches no fim da fila, na ordem dada; elas entram no destino uma por vez.
   * `authorized`: o agente que resolver conflitos delas já abre autorizado (vale também para quem já estava na fila).
   */
  async enqueue(branches: string | string[], target?: string, opts: { authorized?: boolean } = {}) {
    const tgt = target ?? (await this.ctl.base()).base;
    const items = this.queue();
    const already: string[] = [];
    for (const branch of typeof branches === 'string' ? [branches] : branches) {
      if (branch === tgt) continue;
      const queued = items.find(i => i.branch === branch && QUEUED.includes(i.status));
      if (queued) {
        if (opts.authorized && !queued.authorized) queued.authorized = true;
        else already.push(branch);
        continue;
      }
      items.push({ branch, target: tgt, status: 'waiting', added: Date.now(), authorized: opts.authorized || undefined });
    }
    if (already.length) vscode.window.showInformationMessage(t('{0} is already in the merge queue.', already.join(', ')));
    await this.saveQueue(items);
    void this.runQueue();
  }

  /** Branches locais que ainda não estão na fila (para escolher várias de uma vez). */
  async pickForQueue(authorized = false): Promise<string[]> {
    const repo = this.ctl.repo;
    if (!repo) return [];
    const { base } = await this.ctl.base();
    const queued = new Set(this.queue().filter(i => QUEUED.includes(i.status)).map(i => i.branch));
    const items = (await repo.refs())
      .filter(r => r.kind === 'head' && r.name !== base && !queued.has(r.name))
      .map(r => ({ label: r.name, description: r.subject }));
    const picks = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: authorized ? t('Add to merge queue → {0} (Claude authorized to resolve conflicts)', base) : t('Add to merge queue → {0}', base),
      placeHolder: t('Pick the branches; they go into {0} one at a time, in this order', base),
    });
    return picks?.map(p => p.label) ?? [];
  }

  /** O agente que cuidava de um item terminou: volta para a fila (ou sai) e a fila segue. */
  private async onAgentFinished(p: string, branch: string | undefined, ready: boolean) {
    const items = this.queue();
    const b = items.find(i => i.status === 'agent' && (i.agentPath ? key(i.agentPath) === key(p) : i.branch === branch))?.branch;
    if (!b) return;
    const item = agentFinished(items, b, ready);
    if (!item) return;
    await this.saveQueue(items);
    this.ctl.log(t('Merge queue: {0} → {1}: {2}', item.branch, item.target, item.status) + (item.reason ? ` (${item.reason})` : ''));
    if (item.status === 'failed') void vscode.window.showWarningMessage(t('Merge queue: {0} left the queue — {1}.', item.branch, item.reason ?? ''));
    void this.runQueue();
  }

  /** Liga/desliga a autorização do agente para um item que ainda está na fila. */
  async toggleAuthorized(branch: string) {
    const items = this.queue();
    const item = items.find(i => i.branch === branch && QUEUED.includes(i.status));
    if (!item) return;
    item.authorized = !item.authorized || undefined;
    await this.saveQueue(items);
  }

  async remove(branch: string) {
    await this.saveQueue(this.queue().filter(i => i.branch !== branch || i.status === 'done'));
  }

  async move(branch: string, delta: number) {
    const items = this.queue();
    const i = items.findIndex(x => x.branch === branch && x.status === 'waiting');
    const j = i + delta;
    if (i < 0 || j < 0 || j >= items.length || items[j].status !== 'waiting') return;
    [items[i], items[j]] = [items[j], items[i]];
    await this.saveQueue(items);
  }

  async clearFinished() {
    await this.saveQueue(this.queue().filter(i => !['done', 'failed'].includes(i.status)));
  }

  private requiresPr(target: string) {
    const c = this.ctl.cfg();
    const mode = c.get<string>('protection.mode', 'confirm');
    return mode === 'require-pr' && !!this.ctl.state?.protectedBranches?.includes(target);
  }

  /**
   * Processa a fila até acabar ou parar (PR pendente, agente resolvendo, pausa).
   * `retryAgent`: pedido manual — itens que esperavam o agente voltam a ser tentados.
   */
  async runQueue(opts: { retryAgent?: boolean } = {}): Promise<void> {
    if (this.processing) {
      this.runAgain = true;
      return;
    }
    if (this.paused() || !this.ctl.repo) return;
    this.processing = true;
    try {
      if (opts.retryAgent) {
        const items = this.queue();
        const stuck = items.filter(i => i.status === 'agent');
        stuck.forEach(i => (i.status = 'waiting'));
        if (stuck.length) await this.saveQueue(items);
      }
      for (;;) {
        const items = this.queue();
        const done = await processNext(items, {
          syncTarget: i => this.syncTarget(i),
          checks: i => guardChecks('merge', i.branch),
          requiresPr: i => this.requiresPr(i.target),
          merge: async i => ((await actions.mergeBranches(this.ctl, i.branch, i.target, { confirm: false, quiet: true })) ? undefined : t('the merge didn\'t happen (conflict or declined)')),
          pushTarget: this.ctl.cfg().get<boolean>('mergeQueue.pushBase', false) ? async i => void (await pushBranch(this.ctl, i.target, { quiet: true })) : undefined,
          handoff: this.agentFlow && this.ctl.cfg().get<boolean>('mergeQueue.resolveWithAgent', true) ? (i, reason) => this.handoff(i, reason) : undefined,
        });
        if (!done) break;
        await this.saveQueue(items);
        this.ctl.log(t('Merge queue: {0} → {1}: {2}', done.branch, done.target, done.status) + (done.reason ? ` (${done.reason})` : ''));
        if (done.status === 'failed') {
          void vscode.window.showWarningMessage(t('Merge queue: {0} left the queue — {1}.', done.branch, done.reason ?? ''), t('✦ Fix with the agent')).then(p => {
            if (p) void vscode.commands.executeCommand('worktreeGraph.launchAgentWithPrompt', {
              branch: done.branch,
              prompt: t(
                'Branch {0} did not get into {1} through the merge queue: {2}. Bring in {1} ({3}), fix whatever is needed, run the tests and commit.',
                done.branch,
                done.target,
                done.reason ?? '',
                `git merge ${done.target}`,
              ),
            });
          });
        }
        if (done.status === 'awaiting-pr') {
          await this.ctl.requests.publish(done.branch, done.target);
          break;
        }
      }
    } finally {
      this.processing = false;
      if (this.runAgain) {
        this.runAgain = false;
        void this.runQueue();
      }
      this.ctl.scheduleRefresh(50);
    }
  }

  /** Abre o agente na worktree da branch para resolver o que tirou o item da fila. */
  private async handoff(i: MergeItem, reason: string): Promise<boolean> {
    const repo = this.ctl.repo!;
    const wt = (await repo.worktreesFast()).find(w => w.branch === i.branch && !w.prunable);
    if (!wt) return false;
    const st = await repo.status(wt.path);
    // Worktree suja ou com operação no meio: é trabalho de alguém, não do agente da fila.
    if (st.operation || st.changes) return false;
    const files = (await repo.mergePreview(i.branch, i.target))?.files ?? [];
    const prompt = t(
      'Branch {0} is in the merge queue to go into {1}, and it stopped: {2}. In this worktree, bring in {1} ({3}), resolve the conflicts{4} preserving the intent of both changes, make the checks and tests pass and commit. Do not merge into {1} yourself: when you finish and commit, the queue merges {0} and moves on to the next branch.',
      i.branch,
      i.target,
      reason,
      `git merge ${i.target}`,
      files.length ? ` (${files.join(', ')})` : '',
    ) +
      ' ' +
      (i.authorized
        ? t('Nobody is watching this terminal: do not stop to ask; when something is ambiguous, pick what best keeps both changes and explain the choice in the commit message.')
        : t('If anything is ambiguous, ask before deciding.'));
    i.agentPath = wt.path;
    const permissionMode = i.authorized ? this.ctl.cfg().get<string>('mergeQueue.authorizedPermissionMode', 'auto') : undefined;
    await this.agentTerms.launchWithPrompt(wt.path, i.branch, prompt, resolverName(this.ctl), { permissionMode });
    void vscode.window.showInformationMessage(t('Merge queue: {0} stopped ({1}); {2} is resolving it and the queue continues when it finishes.', i.branch, reason, resolverName(this.ctl)));
    return true;
  }

  /** Traz o destino para a branch na worktree dela (cria se preciso). */
  private async syncTarget(i: MergeItem): Promise<string | undefined> {
    const repo = this.ctl.repo!;
    let wt = (await repo.worktreesFast()).find(w => w.branch === i.branch);
    if (!wt) {
      const dir = await actions.createWorktree(this.ctl, { existing: i.branch, quiet: true });
      if (!dir) return t('couldn\'t create the branch\'s worktree');
      wt = (await repo.worktreesFast()).find(w => w.branch === i.branch);
      if (!wt) return t('branch\'s worktree not found');
    }
    const st = await repo.status(wt.path);
    if (st.operation) return t('{0} in progress in the worktree', st.operation);
    if (st.changes) return t('the worktree has uncommitted changes');
    const [behind] = await repo.aheadBehind(i.target, i.branch);
    if (!behind) return undefined;
    const r = await repo.run(['merge', '--no-edit', i.target], wt.path, 300_000);
    if (r.code === 0) return undefined;
    await repo.run(['merge', '--abort'], wt.path);
    return t('conflict bringing in {0}', i.target);
  }

  private async checkAwaiting() {
    const items = this.queue();
    if (!items.some(i => i.status === 'awaiting-pr')) return;
    const repo = this.ctl.repo;
    if (!repo) return;
    const merged = new Map<string, boolean>();
    for (const i of items.filter(x => x.status === 'awaiting-pr')) merged.set(i.branch, (await repo.aheadBehind(i.target, i.branch))[1] === 0);
    if (resolveAwaiting(items, i => !!merged.get(i.branch))) {
      await this.saveQueue(items);
      void this.runQueue();
    }
  }

  // ---------- tarefa em lote ----------

  private maxParallel() {
    return Math.max(1, this.ctl.cfg().get<number>('batch.maxParallel', 3));
  }

  private runningAgents(): number {
    return [...this.agentTerms.running().values()].reduce((n, l) => n + l.length, 0);
  }

  async batch(opts?: { paths?: string[]; prompt?: string; mode?: 'now' | 'queue' }) {
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
      (await vscode.window.showInputBox({ title: t('Task for {0} worktree(s)', targets.length), prompt: t('What each agent should do; {0} becomes the branch name', '${branch}'), ignoreFocusOut: true }));
    if (!prompt?.trim()) return;
    const mode =
      opts?.mode ??
      (
        await vscode.window.showQuickPick(
          [
            { label: t('Open the agent in each one now'), detail: t('At most {0} at a time ({1}); the others wait', this.maxParallel(), 'worktreeGraph.batch.maxParallel'), v: 'now' as const },
            { label: t('Add to each one\'s task queue'), detail: t('Runs when that worktree\'s current task is done'), v: 'queue' as const },
          ],
          { title: t('Batch task') },
        )
      )?.v;
    if (!mode) return;
    const text = (w: WorktreeView) => prompt.replace(/\$\{branch\}/g, w.branch ?? w.name);
    if (mode === 'queue') {
      for (const w of targets) {
        if (this.agentFlow) await this.agentFlow.tasks.add(w.path, w.branch, text(w));
        else await vscode.commands.executeCommand('worktreeGraph.tasks.add', { path: w.path, branch: w.branch }, text(w));
      }
    } else {
      const plan = batchPlan(targets, this.maxParallel(), this.runningAgents());
      this.batchWaiting.push(...plan.later.map(w => ({ path: w.path, branch: w.branch, prompt: text(w) })));
      for (const w of plan.now) await this.agentTerms.launchWithPrompt(w.path, w.branch, text(w));
    }
    const msg =
      mode === 'now' && this.batchWaiting.length
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

  /** Worktrees que não recebem mais tarefas automáticas (budget.action = pause-queue e limite estourado). */
  budgetBlocked(): Set<string> {
    const out = new Set<string>();
    if (!['pause-queue', 'block-prompts'].includes(this.ctl.cfg().get<string>('budget.action', 'warn'))) return out;
    for (const w of this.ctl.state?.worktrees ?? []) if (budgetLevel(w.claude, this.limits()).level === 'over') out.add(key(w.path));
    return out;
  }

  isBlocked(p: string): boolean {
    return this.budgetBlocked().has(key(p));
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

// ---------- view da fila de merge ----------

const ICON: Record<MergeItem['status'], [string, string]> = {
  waiting: ['circle-large-outline', 'descriptionForeground'],
  running: ['sync~spin', 'charts.blue'],
  agent: ['sparkle', 'charts.purple'],
  'awaiting-pr': ['git-pull-request', 'charts.yellow'],
  done: ['pass', 'testing.iconPassed'],
  failed: ['error', 'testing.iconFailed'],
};
const label = (st: MergeItem['status']): string =>
  ({ waiting: t('queued'), running: t('processing'), agent: t('with the agent'), 'awaiting-pr': t('waiting for PR/MR'), done: t('merged'), failed: t('failed') })[st];

class MergeQueueItem extends vscode.TreeItem {
  constructor(readonly item: MergeItem) {
    super(item.branch, vscode.TreeItemCollapsibleState.None);
    this.description = `→ ${item.target} · ${label(item.status)}${item.authorized ? ` · ✦ ${t('authorized')}` : ''}`;
    this.tooltip = item.reason ?? `${item.branch} → ${item.target}`;
    this.iconPath = new vscode.ThemeIcon(ICON[item.status][0], new vscode.ThemeColor(ICON[item.status][1]));
    this.contextValue = `mergeQueue-${item.status}`;
  }
}

class MergeQueueProvider implements vscode.TreeDataProvider<MergeQueueItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private readonly coord: Coord) {
    coord.onDidChangeQueue(() => this.emitter.fire());
  }
  getTreeItem(e: MergeQueueItem) {
    return e;
  }
  getChildren() {
    return this.coord.queue().map(i => new MergeQueueItem(i));
  }
}

export function registerCoord(ctx: vscode.ExtensionContext, ctl: Controller, agentTerms: AgentTerminals, agentFlow?: AgentFlow): Coord {
  const coord = new Coord(ctl, agentTerms, agentFlow);
  const view = vscode.window.createTreeView('worktreeGraph.mergeQueue', { treeDataProvider: new MergeQueueProvider(coord) });
  const setDesc = () => (view.description = coord.paused() ? t('queue paused') : undefined);
  coord.onDidChangeQueue(setDesc);
  setDesc();
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
  const branchOf = async (arg: any) => (typeof arg === 'string' ? arg : arg?.branch ?? (await actions.pickBranch(ctl, undefined, t('Which branch?'))));
  reg('coord.showOverlaps', (arg?: unknown) => coord.showOverlap(arg));
  reg('showOverlaps', (a?: { path?: string }) => coord.showOverlap(a?.path ? { path: a.path } : undefined));
  reg('mergeQueueAdd', (a?: { branch?: string }) => a?.branch && coord.enqueue(a.branch));
  // Árvore com várias selecionadas: (clicada, selecionadas[]); sem argumento: escolhe várias.
  const add = (authorized: boolean) => async (arg?: any, second?: any) => {
    if (Array.isArray(second) && second.length) {
      const bs = second.map(x => (typeof x === 'string' ? x : x?.branch)).filter((b): b is string => !!b);
      if (bs.length) return coord.enqueue(bs, undefined, { authorized });
    }
    const target = typeof second === 'string' ? second : undefined;
    if (arg === undefined) {
      const bs = await coord.pickForQueue(authorized);
      return bs.length ? coord.enqueue(bs, target, { authorized }) : undefined;
    }
    const b = await branchOf(arg);
    if (b) await coord.enqueue(b, target, { authorized });
  };
  reg('mergeQueue.add', add(false));
  // Mesma coisa, mas o Claude que resolver os conflitos já abre autorizado e a fila segue sozinha.
  reg('mergeQueue.addAuthorized', add(true));
  reg('mergeQueueAddAuthorized', (a?: { branch?: string }) => a?.branch && coord.enqueue(a.branch, undefined, { authorized: true }));
  reg('mergeQueue.toggleAuthorized', (it?: MergeQueueItem) => it && coord.toggleAuthorized(it.item.branch));
  reg('mergeQueue.remove', (it?: MergeQueueItem) => it && coord.remove(it.item.branch));
  reg('mergeQueue.moveUp', (it?: MergeQueueItem) => it && coord.move(it.item.branch, -1));
  reg('mergeQueue.moveDown', (it?: MergeQueueItem) => it && coord.move(it.item.branch, 1));
  reg('mergeQueue.pause', () => coord.setPaused(true));
  reg('mergeQueue.resume', () => coord.setPaused(false));
  reg('mergeQueue.run', () => coord.runQueue({ retryAgent: true }));
  reg('mergeQueue.clearFinished', () => coord.clearFinished());
  reg('batchTask', (opts?: any) => coord.batch(opts && typeof opts === 'object' && !opts.path ? opts : undefined));
  ctx.subscriptions.push(coord, view);
  // se a janela fechou no meio de um item, continua ao abrir
  setTimeout(() => void coord.runQueue(), 5000);
  return coord;
}
