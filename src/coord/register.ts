import * as path from 'path';
import * as vscode from 'vscode';
import * as actions from '../actions';
import type { AgentFlow } from '../agentFlow/register';
import type { AgentTerminals } from '../agents';
import type { Controller } from '../controller';
import { gitUri } from '../diff';
import { branchMatches } from '../git';
import { guardChecks } from '../guards';
import type { WorktreeView } from '../model';
import { pushBranch } from '../push';
import {
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

const key = (p: string) => path.normalize(p).toLowerCase();

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
  private readonly queueChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeQueue = this.queueChanged.event;
  /** Worktrees "em espera" da tarefa em lote: abrem quando um agente termina. */
  private readonly batchWaiting: { path: string; branch?: string; prompt: string }[] = [];

  constructor(private readonly ctl: Controller, private readonly agentTerms: AgentTerminals, private readonly agentFlow?: AgentFlow) {
    this.disposables.push(this.queueChanged);
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
    if (agentFlow) this.disposables.push(agentFlow.watch.onDidFinish(() => void this.drainBatch()));
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
    this.overlaps = findOverlaps(touched);
    this.summary = new Map([...overlapSummary(this.overlaps)].map(([p, v]) => [key(p), v] as [string, { with: string[]; files: number }]));
    for (const [p, v] of this.summary) v.with = v.with.map(o => this.nameOf(o));
    if (JSON.stringify([...this.summary]) !== before) this.ctl.scheduleRefresh(50);
    for (const o of this.overlaps) {
      const k = overlapKey(o);
      if (this.notified.has(k)) continue;
      this.notified.add(k);
      void vscode.window
        .showWarningMessage(`AgentYard: ${this.nameOf(o.a)} e ${this.nameOf(o.b)} mexem nos mesmos ${o.files.length} arquivo(s).`, 'Ver arquivos', 'Analisar merge')
        .then(p => {
          if (p === 'Ver arquivos') void this.showOverlap(o.a);
          if (p === 'Analisar merge') void this.analyzePair(o);
        });
    }
  }

  private nameOf(p: string) {
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

  private async analyzePair(o: Overlap) {
    const a = this.wtOf(o.a);
    const b = this.wtOf(o.b);
    if (a?.branch && b?.branch) await vscode.commands.executeCommand('worktreeGraph.analyzeMerge', a.branch, b.branch);
  }

  /** Lista das sobreposições (de uma worktree, ou todas) e ações. */
  async showOverlap(arg?: unknown) {
    await this.recompute();
    const wt = arg ? this.wtOf(arg) : undefined;
    const list = this.overlaps.filter(o => !wt || key(o.a) === key(wt.path) || key(o.b) === key(wt.path));
    if (!list.length) {
      vscode.window.showInformationMessage(wt ? `${wt.name} não sobrepõe arquivos com outras worktrees ativas.` : 'Nenhuma sobreposição entre worktrees ativas.');
      return;
    }
    type It = vscode.QuickPickItem & { o: Overlap; file?: string; act?: string };
    const items: It[] = [];
    for (const o of list) {
      const title = `${this.nameOf(o.a)} ↔ ${this.nameOf(o.b)}`;
      items.push({ label: title, kind: vscode.QuickPickItemKind.Separator, o });
      items.push({ label: '$(git-compare) Analisar merge entre as duas', o, act: 'analyze' });
      items.push({ label: '$(sparkle) Avisar o agente', description: 'abre o agente com a lista de arquivos em comum', o, act: 'warn' });
      for (const f of o.files) items.push({ label: path.basename(f), description: path.dirname(f) === '.' ? '' : path.dirname(f), detail: 'comparar os dois lados', o, file: f });
    }
    const pick = await vscode.window.showQuickPick(items, { title: 'Arquivos em comum entre worktrees ativas', matchOnDescription: true });
    if (!pick) return;
    if (pick.act === 'analyze') return this.analyzePair(pick.o);
    if (pick.act === 'warn') return this.warnAgent(pick.o, wt);
    if (pick.file) {
      const l = vscode.Uri.file(path.join(pick.o.a, pick.file));
      const r = vscode.Uri.file(path.join(pick.o.b, pick.file));
      await vscode.commands.executeCommand('vscode.diff', l, r, `${path.basename(pick.file)} (${this.nameOf(pick.o.a)} ↔ ${this.nameOf(pick.o.b)})`);
    }
  }

  private async warnAgent(o: Overlap, prefer?: WorktreeView) {
    const me = prefer ?? this.wtOf(o.a);
    const otherPath = me && key(me.path) === key(o.a) ? o.b : o.a;
    if (!me) return;
    const prompt = [
      `Atenção: a worktree ${this.nameOf(otherPath)} (outra tarefa em paralelo) também está mexendo nestes arquivos:`,
      ...o.files.map(f => `- ${f}`),
      '',
      `Para evitar conflito no merge, confira as mudanças dela (git diff ${me.branch ?? ''}...${this.nameOf(otherPath)} -- <arquivo>), mantenha as suas mudanças nesses arquivos o menor possível e avise se a sua tarefa depende do que a outra está fazendo.`,
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

  async enqueue(branch: string, target?: string) {
    const t = target ?? (await this.ctl.base()).base;
    const items = this.queue();
    if (items.some(i => i.branch === branch && ['waiting', 'running', 'awaiting-pr'].includes(i.status))) {
      vscode.window.showInformationMessage(`${branch} já está na fila de merge.`);
      return;
    }
    items.push({ branch, target: t, status: 'waiting', added: Date.now() });
    await this.saveQueue(items);
    void this.runQueue();
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

  /** Processa a fila até acabar ou parar (falha, PR pendente, pausa). */
  async runQueue(): Promise<void> {
    if (this.processing || this.paused() || !this.ctl.repo) return;
    this.processing = true;
    try {
      for (;;) {
        const items = this.queue();
        const done = await processNext(items, {
          syncTarget: i => this.syncTarget(i),
          checks: i => guardChecks('merge', i.branch),
          requiresPr: i => this.requiresPr(i.target),
          merge: async i => ((await actions.mergeBranches(this.ctl, i.branch, i.target, { confirm: false, quiet: true })) ? undefined : 'o merge não aconteceu (conflito ou recusa)'),
          pushTarget: this.ctl.cfg().get<boolean>('mergeQueue.pushBase', false) ? async i => void (await pushBranch(this.ctl, i.target, { quiet: true })) : undefined,
        });
        if (!done) break;
        await this.saveQueue(items);
        this.ctl.log(`Fila de merge: ${done.branch} → ${done.target}: ${done.status}${done.reason ? ` (${done.reason})` : ''}`);
        if (done.status === 'failed') {
          void vscode.window.showWarningMessage(`Fila de merge: ${done.branch} saiu da fila — ${done.reason}.`, '✦ Corrigir com o agente').then(p => {
            if (p) void vscode.commands.executeCommand('worktreeGraph.launchAgentWithPrompt', {
              branch: done.branch,
              prompt: `A branch ${done.branch} não entrou em ${done.target} pela fila de merge: ${done.reason}. Traga ${done.target} (git merge ${done.target}), resolva o que for preciso, rode os testes e faça commit.`,
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
      this.ctl.scheduleRefresh(50);
    }
  }

  /** Traz o destino para a branch na worktree dela (cria se preciso). */
  private async syncTarget(i: MergeItem): Promise<string | undefined> {
    const repo = this.ctl.repo!;
    let wt = (await repo.worktreesFast()).find(w => w.branch === i.branch);
    if (!wt) {
      const dir = await actions.createWorktree(this.ctl, { existing: i.branch, quiet: true });
      if (!dir) return 'não consegui criar a worktree da branch';
      wt = (await repo.worktreesFast()).find(w => w.branch === i.branch);
      if (!wt) return 'worktree da branch não encontrada';
    }
    const st = await repo.status(wt.path);
    if (st.operation) return `${st.operation} em andamento na worktree`;
    if (st.changes) return 'a worktree tem alterações não commitadas';
    const [behind] = await repo.aheadBehind(i.target, i.branch);
    if (!behind) return undefined;
    const r = await repo.run(['merge', '--no-edit', i.target], wt.path, 300_000);
    if (r.code === 0) return undefined;
    await repo.run(['merge', '--abort'], wt.path);
    return `conflito ao trazer ${i.target}`;
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
      const pattern = await vscode.window.showInputBox({ title: 'Tarefa em lote: filtrar worktrees', prompt: 'Padrão de branch (ex.: ai/*); vazio = todas', ignoreFocusOut: true });
      if (pattern === undefined) return;
      const pool = pattern.trim() ? targets.filter(w => w.branch && branchMatches(w.branch, pattern.split(/\s+/))) : targets;
      const picked = await vscode.window.showQuickPick(
        pool.map(w => ({ label: w.name, description: w.path, picked: isActive(w) || !!pattern.trim(), w })),
        { canPickMany: true, title: 'Enviar tarefa para quais worktrees?', matchOnDescription: true },
      );
      if (!picked?.length) return;
      targets = picked.map(p => p.w);
    }
    const blocked = this.budgetBlocked();
    const skipped = targets.filter(w => blocked.has(key(w.path)));
    targets = targets.filter(w => !blocked.has(key(w.path)));
    const prompt =
      opts?.prompt ??
      (await vscode.window.showInputBox({ title: `Tarefa para ${targets.length} worktree(s)`, prompt: 'O que cada agente deve fazer; ${branch} vira o nome da branch', ignoreFocusOut: true }));
    if (!prompt?.trim()) return;
    const mode =
      opts?.mode ??
      (
        await vscode.window.showQuickPick(
          [
            { label: 'Abrir o agente agora em cada uma', detail: `No máximo ${this.maxParallel()} ao mesmo tempo (worktreeGraph.batch.maxParallel); as outras esperam`, v: 'now' as const },
            { label: 'Colocar na fila de tarefas de cada uma', detail: 'Roda quando a tarefa atual daquela worktree ficar pronta', v: 'queue' as const },
          ],
          { title: 'Tarefa em lote' },
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
    const msg = `Tarefa enviada para ${targets.length} worktree(s)${mode === 'now' && this.batchWaiting.length ? `; ${this.batchWaiting.length} esperando vaga` : ''}.`;
    vscode.window.showInformationMessage(skipped.length ? `${msg} ${skipped.length} pulada(s) por orçamento estourado.` : msg);
  }

  /** Abre os que estavam esperando, conforme vagam agentes. */
  async drainBatch() {
    if (!this.batchWaiting.length) return;
    const plan = batchPlan(this.batchWaiting.slice(), this.maxParallel(), this.runningAgents());
    this.batchWaiting.splice(0, plan.now.length);
    for (const t of plan.now) await this.agentTerms.launchWithPrompt(t.path, t.branch, t.prompt);
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
    if (this.ctl.cfg().get<string>('budget.action', 'warn') !== 'pause-queue') return out;
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
          ? `AgentYard: ${w.name} estourou o orçamento (${pct}% em ${b.by === 'usd' ? 'US$' : 'tokens'}).${this.ctl.cfg().get('budget.action') === 'pause-queue' ? ' Novas tarefas automáticas para ela ficam paradas.' : ''}`
          : `AgentYard: ${w.name} usou ${pct}% do orçamento.`,
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
  'awaiting-pr': ['git-pull-request', 'charts.yellow'],
  done: ['pass', 'testing.iconPassed'],
  failed: ['error', 'testing.iconFailed'],
};
const LABEL: Record<MergeItem['status'], string> = { waiting: 'na fila', running: 'processando', 'awaiting-pr': 'esperando PR/MR', done: 'mesclada', failed: 'falhou' };

class MergeQueueItem extends vscode.TreeItem {
  constructor(readonly item: MergeItem) {
    super(item.branch, vscode.TreeItemCollapsibleState.None);
    this.description = `→ ${item.target} · ${LABEL[item.status]}`;
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
  const setDesc = () => (view.description = coord.paused() ? 'pausada' : undefined);
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
  const branchOf = async (arg: any) => (typeof arg === 'string' ? arg : arg?.branch ?? (await actions.pickBranch(ctl, undefined, 'Qual branch?')));
  reg('coord.showOverlaps', (arg?: unknown) => coord.showOverlap(arg));
  reg('showOverlaps', (a?: { path?: string }) => coord.showOverlap(a?.path ? { path: a.path } : undefined));
  reg('mergeQueueAdd', (a?: { branch?: string }) => a?.branch && coord.enqueue(a.branch));
  reg('mergeQueue.add', async (arg?: any, target?: string) => {
    const b = await branchOf(arg);
    if (b) await coord.enqueue(b, typeof target === 'string' ? target : undefined);
  });
  reg('mergeQueue.remove', (it?: MergeQueueItem) => it && coord.remove(it.item.branch));
  reg('mergeQueue.moveUp', (it?: MergeQueueItem) => it && coord.move(it.item.branch, -1));
  reg('mergeQueue.moveDown', (it?: MergeQueueItem) => it && coord.move(it.item.branch, 1));
  reg('mergeQueue.pause', () => coord.setPaused(true));
  reg('mergeQueue.resume', () => coord.setPaused(false));
  reg('mergeQueue.run', () => coord.runQueue());
  reg('mergeQueue.clearFinished', () => coord.clearFinished());
  reg('batchTask', (opts?: any) => coord.batch(opts && typeof opts === 'object' && !opts.path ? opts : undefined));
  ctx.subscriptions.push(coord, view);
  // se a janela fechou no meio de um item, continua ao abrir
  setTimeout(() => void coord.runQueue(), 5000);
  return coord;
}
