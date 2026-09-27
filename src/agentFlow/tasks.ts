import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentTerminals } from '../agents';
import type { Controller } from '../controller';
import { keyOf } from './head';
import type { AgentWatch } from './watch';

export type TaskStatus = 'waiting' | 'running' | 'done' | 'failed';

export interface Task {
  id: string;
  text: string;
  status: TaskStatus;
  created: number;
  started?: number;
  finished?: number;
}

interface Queue {
  path: string;
  branch?: string;
  tasks: Task[];
}

/**
 * Tarefas em fila por worktree. A primeira vai para o agente; quando ele termina (AgentWatch diz
 * "pronto"), a próxima é enviada sozinha (`tasks.autoAdvance`). Guardado por repositório.
 */
export class TaskQueue implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.changed];

  constructor(private readonly ctl: Controller, private readonly agentTerms: AgentTerminals, watch: AgentWatch) {
    this.disposables.push(watch.onDidFinish(e => void this.onFinished(e.path, e.ready)));
  }

  private storeKey() {
    return `agentFlow.tasks:${this.ctl.repo?.commonDir.toLowerCase() ?? ''}`;
  }

  all(): Record<string, Queue> {
    return this.ctl.ctx.workspaceState.get<Record<string, Queue>>(this.storeKey(), {});
  }

  private async save(all: Record<string, Queue>) {
    for (const [k, q] of Object.entries(all)) if (!q.tasks.length) delete all[k];
    await this.ctl.ctx.workspaceState.update(this.storeKey(), all);
    this.changed.fire();
    this.ctl.scheduleRefresh(20);
  }

  queue(p: string): Queue | undefined {
    return this.all()[keyOf(p)];
  }

  summary(p: string): { waiting: number; running?: string } | undefined {
    const q = this.queue(p);
    if (!q) return undefined;
    const waiting = q.tasks.filter(t => t.status === 'waiting').length;
    const running = q.tasks.find(t => t.status === 'running')?.text;
    return waiting || running ? { waiting, running } : undefined;
  }

  private autoAdvance() {
    return this.ctl.cfg().get<boolean>('tasks.autoAdvance', true);
  }

  /** Acrescenta uma tarefa; se nada estiver rodando nessa worktree, já manda para o agente. */
  async add(p: string, branch: string | undefined, text?: string): Promise<Task | undefined> {
    const t =
      text ??
      (await vscode.window.showInputBox({
        title: `Nova tarefa para ${branch ?? path.basename(p)}`,
        prompt: 'O que o agente deve fazer. Ela entra na fila e roda quando a anterior ficar pronta.',
        ignoreFocusOut: true,
      }));
    if (!t?.trim()) return undefined;
    const all = this.all();
    const k = keyOf(p);
    const q = all[k] ?? { path: p, branch, tasks: [] };
    const task: Task = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text: t.trim(), status: 'waiting', created: Date.now() };
    q.tasks.push(task);
    q.branch = branch ?? q.branch;
    all[k] = q;
    await this.save(all);
    if (!q.tasks.some(x => x.status === 'running') && this.autoAdvance()) await this.startNext(p);
    return task;
  }

  async startNext(p: string) {
    const next = this.queue(p)?.tasks.find(t => t.status === 'waiting');
    if (next) await this.run(p, next.id);
  }

  /** Manda a tarefa para o agente agora (a que estava rodando volta para a fila). */
  async run(p: string, id: string) {
    const all = this.all();
    const q = all[keyOf(p)];
    const task = q?.tasks.find(t => t.id === id);
    if (!q || !task) return;
    for (const t of q.tasks) if (t.status === 'running' && t.id !== id) t.status = 'waiting';
    task.status = 'running';
    task.started = Date.now();
    await this.save(all);
    await this.agentTerms.launchWithPrompt(q.path, q.branch, task.text);
  }

  private async onFinished(p: string, ready: boolean) {
    const all = this.all();
    const q = all[keyOf(p)];
    const cur = q?.tasks.find(t => t.status === 'running');
    if (!q || !cur) return;
    cur.status = ready ? 'done' : 'failed';
    cur.finished = Date.now();
    await this.save(all);
    if (ready && this.autoAdvance()) await this.startNext(p);
  }

  async setStatus(p: string, id: string, status: TaskStatus) {
    const all = this.all();
    const t = all[keyOf(p)]?.tasks.find(x => x.id === id);
    if (!t) return;
    t.status = status;
    if (status === 'done' || status === 'failed') t.finished = Date.now();
    await this.save(all);
  }

  async move(p: string, id: string, delta: number) {
    const all = this.all();
    const q = all[keyOf(p)];
    if (!q) return;
    const i = q.tasks.findIndex(t => t.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= q.tasks.length) return;
    [q.tasks[i], q.tasks[j]] = [q.tasks[j], q.tasks[i]];
    await this.save(all);
  }

  async remove(p: string, id: string) {
    const all = this.all();
    const q = all[keyOf(p)];
    if (!q) return;
    q.tasks = q.tasks.filter(t => t.id !== id);
    await this.save(all);
  }

  async clearFinished() {
    const all = this.all();
    for (const q of Object.values(all)) q.tasks = q.tasks.filter(t => t.status === 'waiting' || t.status === 'running');
    await this.save(all);
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
  }
}

const ICON: Record<TaskStatus, [string, string]> = {
  waiting: ['circle-large-outline', 'descriptionForeground'],
  running: ['sync~spin', 'charts.blue'],
  done: ['pass', 'testing.iconPassed'],
  failed: ['error', 'testing.iconFailed'],
};
const LABEL: Record<TaskStatus, string> = { waiting: 'esperando', running: 'rodando', done: 'pronta', failed: 'falhou' };

class QueueItem extends vscode.TreeItem {
  readonly kind = 'taskQueue';
  constructor(readonly q: Queue) {
    super(q.branch ?? path.basename(q.path), vscode.TreeItemCollapsibleState.Expanded);
    this.id = `tq:${keyOf(q.path)}`;
    const waiting = q.tasks.filter(t => t.status === 'waiting').length;
    this.description = [q.tasks.some(t => t.status === 'running') ? 'rodando' : '', waiting ? `${waiting} na fila` : ''].filter(Boolean).join(' · ');
    this.iconPath = new vscode.ThemeIcon('list-ordered');
    this.contextValue = 'taskQueue';
  }
}

export class TaskItem extends vscode.TreeItem {
  readonly kind = 'task';
  constructor(readonly q: Queue, readonly task: Task, index: number) {
    super(`${index + 1}. ${task.text.split(/\r?\n/)[0].slice(0, 90)}`, vscode.TreeItemCollapsibleState.None);
    this.id = `task:${task.id}`;
    this.description = LABEL[task.status];
    const [icon, color] = ICON[task.status];
    this.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    this.tooltip = task.text;
    this.contextValue = `task-${task.status}`;
  }
}

export class TasksProvider implements vscode.TreeDataProvider<QueueItem | TaskItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly tasks: TaskQueue) {
    tasks.onDidChange(() => this.emitter.fire());
  }

  getTreeItem(el: QueueItem | TaskItem) {
    return el;
  }

  getChildren(el?: QueueItem | TaskItem): (QueueItem | TaskItem)[] {
    if (!el) return Object.values(this.tasks.all()).map(q => new QueueItem(q));
    if (el instanceof QueueItem) return el.q.tasks.map((t, i) => new TaskItem(el.q, t, i));
    return [];
  }
}
