import * as vscode from 'vscode';
import { createWorktree } from '../actions';
import { fillTemplate } from '../agents';
import type { Controller } from '../controller';
import { t } from '../i18n';
import { formatDuration, Pipeline, PipelineClient, pipelineClient, PipelineJob, PipelineStatus, tailLog } from './pipelines';

type Guard = <T extends unknown[]>(fn: (...args: T) => unknown) => (...args: T) => Promise<void>;
type Scope = 'worktrees' | 'all';

const IDLE_MS = 60_000;
const BUSY_MS = 10_000;

function defaultFixPrompt() {
  return [
    t('The pipeline "{0}" on branch {1} failed ({2}).', '${pipeline}', '${branch}', '${url}'),
    t('Failed jobs: {0}.', '${jobs}'),
    '',
    t('End of the log of the first failed job:'),
    '```',
    '${log}',
    '```',
    '',
    t(
      'Find the cause, fix it on branch {0}, run locally whatever you can (tests, lint, build) and commit. Do not push without asking me. If the failure is in the CI infrastructure and not in the code, explain instead of changing the code.',
      '${branch}',
    ),
  ].join('\n');
}

/**
 * Pipelines do remoto, atualizados a cada 60 s (10 s enquanto algum estiver rodando). Só pede
 * redesenho quando a lista muda de fato, para não entrar em laço com o refresh do controller.
 */
export class PipelineService implements vscode.Disposable {
  pipelines: Pipeline[] = [];
  error?: string;
  /** Sem remoto reconhecido ou sem credencial: a view mostra como conectar. */
  unavailable?: 'noRemote' | 'noAuth';
  scope: Scope;
  private readonly jobsCache = new Map<number, { updatedAt: number; jobs: PipelineJob[] }>();
  private readonly notified = new Set<number>();
  private primed = false;
  private timer?: NodeJS.Timeout;
  private fetching?: Promise<void>;
  private disposed = false;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  /** Preenchido na ativação: trata um pipeline que falhou (ex.: manda ao agente aberto); true = já tratou. */
  onFailure?: (p: Pipeline) => Promise<boolean>;

  constructor(private readonly ctl: Controller) {
    this.scope = ctl.ctx.workspaceState.get<Scope>('pipelines.scope', 'worktrees');
    vscode.commands.executeCommand('setContext', 'worktreeGraph.pipelinesScope', this.scope);
    ctl.stateHooks.push(s => {
      const latest: NonNullable<typeof s.pipelines> = {};
      for (const p of this.pipelines) {
        const cur = latest[p.branch];
        if (!cur || p.createdAt > (this.pipelines.find(x => x.id === cur.id)?.createdAt ?? 0)) {
          latest[p.branch] = { id: p.id, status: p.status, name: p.name, url: p.url, updatedAt: p.updatedAt };
        }
      }
      s.pipelines = latest;
    });
    ctl.onDidChangeRepo?.(() => {
      this.pipelines = [];
      this.jobsCache.clear();
      this.primed = false;
      this.refresh(true);
    });
    this.schedule(3_000);
  }

  private schedule(ms?: number) {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    const busy = this.pipelines.some(p => p.status === 'running' || p.status === 'queued');
    this.timer = setTimeout(async () => {
      if (vscode.window.state.focused) await this.refresh();
      this.schedule();
    }, ms ?? (busy ? BUSY_MS : IDLE_MS));
  }

  async client(interactive: boolean): Promise<PipelineClient | undefined> {
    const c = await this.ctl.requests.credentials(interactive);
    return c ? pipelineClient(c.remote, c.token, c.apiBase) : undefined;
  }

  /** Branches que interessam no filtro "com worktree": as das worktrees e os estágios do fluxo. */
  private relevantBranches(): Set<string> {
    const s = this.ctl.state;
    const set = new Set<string>();
    for (const w of s?.worktrees ?? []) if (w.branch && !w.prunable) set.add(w.branch);
    for (const f of s?.flow ?? []) {
      set.add(f.from.branch);
      set.add(f.to.branch);
    }
    if (s?.base) set.add(s.base);
    return set;
  }

  visible(): Pipeline[] {
    if (this.scope === 'all') return this.pipelines;
    const rel = this.relevantBranches();
    return this.pipelines.filter(p => rel.has(p.branch));
  }

  async setScope(s: Scope) {
    this.scope = s;
    await this.ctl.ctx.workspaceState.update('pipelines.scope', s);
    vscode.commands.executeCommand('setContext', 'worktreeGraph.pipelinesScope', s);
    this.changed.fire();
  }

  private signature() {
    return `${this.unavailable ?? ''}|${this.error ?? ''}|${this.pipelines.map(p => `${p.id}:${p.status}:${p.updatedAt}`).join(',')}`;
  }

  refresh(force = false): Promise<void> {
    if (this.fetching) return this.fetching;
    const before = this.signature();
    this.fetching = (async () => {
      try {
        const remote = await this.ctl.requests.detectRemote();
        if (!remote) {
          this.unavailable = 'noRemote';
          this.pipelines = [];
          return;
        }
        const client = await this.client(false);
        if (!client) {
          this.unavailable = 'noAuth';
          this.pipelines = [];
          return;
        }
        this.unavailable = undefined;
        this.pipelines = (await client.list()).sort((a, b) => b.createdAt - a.createdAt);
        this.error = undefined;
      } catch (e) {
        this.error = (e as Error).message;
        this.ctl.log(`Pipelines: ${this.error}`);
      }
    })().finally(() => {
      this.fetching = undefined;
      if (force || this.signature() !== before) {
        this.changed.fire();
        // o painel e a árvore mostram o último pipeline de cada branch
        if (this.signature() !== before) this.ctl.scheduleRefresh(20);
      }
      this.notifyFailures();
    });
    return this.fetching;
  }

  /** Avisa uma vez por pipeline que falhou numa branch com worktree; o que já existia ao abrir não avisa. */
  private notifyFailures() {
    if (!this.primed) {
      for (const p of this.pipelines) this.notified.add(p.id);
      this.primed = this.pipelines.length > 0 || !this.unavailable;
      return;
    }
    const withWorktree = new Set((this.ctl.state?.worktrees ?? []).filter(w => w.branch && !w.prunable).map(w => w.branch!));
    for (const p of this.pipelines) {
      if (this.notified.has(p.id)) continue;
      if (p.status === 'running' || p.status === 'queued') continue;
      this.notified.add(p.id);
      if (p.status !== 'failed' || !withWorktree.has(p.branch)) continue;
      void this.announceFailure(p);
    }
  }

  private async announceFailure(p: Pipeline) {
    if (this.onFailure && (await this.onFailure(p).catch(() => false))) return;
    const agent = this.agentName();
    const viewLog = t('View log');
    const rerun = t('Re-run');
    const pick = await vscode.window.showWarningMessage(t('Pipeline "{0}" failed on {1}.', p.name, p.branch), viewLog, rerun, t('✦ Ask {0} to fix it', agent));
    if (pick === viewLog) return this.showLog(p);
    if (pick === rerun) return this.retry(p, true);
    if (pick) return this.fixWithAgent(p);
  }

  private agentName(): string {
    const list = this.ctl.cfg().get<{ name: string }[]>('agents', []);
    return list[0]?.name ?? 'Claude Code';
  }

  async jobs(p: Pipeline): Promise<PipelineJob[]> {
    const cached = this.jobsCache.get(p.id);
    if (cached && cached.updatedAt === p.updatedAt) return cached.jobs;
    const client = await this.client(false);
    if (!client) return [];
    const jobs = await client.jobs(p);
    this.jobsCache.set(p.id, { updatedAt: p.updatedAt, jobs });
    return jobs;
  }

  private async act<T>(title: string, fn: (c: PipelineClient) => Promise<T>): Promise<T | undefined> {
    const client = await this.client(true);
    if (!client) return undefined;
    try {
      return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () => fn(client));
    } catch (e) {
      vscode.window.showErrorMessage(`${title.replace(/…$/, '')}: ${(e as Error).message}`);
      return undefined;
    } finally {
      setTimeout(() => this.refresh(true), 2_000);
    }
  }

  retry(p: Pipeline, onlyFailed = false) {
    return this.act(onlyFailed ? t('Re-running the failed jobs of {0}…', p.name) : t('Re-running {0}…', p.name), c => c.retry(p, onlyFailed));
  }

  async cancel(p: Pipeline) {
    const ok = await vscode.window.showWarningMessage(t('Cancel "{0}" on {1}?', p.name, p.branch), { modal: true }, t('Cancel pipeline'));
    if (ok) await this.act(t('Canceling {0}…', p.name), c => c.cancel(p));
  }

  playJob(job: PipelineJob) {
    return this.act(t('Starting manual job {0}…', job.name), c => c.play(job));
  }

  /** Dispara um pipeline para a branch; no GitHub (workflow_dispatch) e no Azure, escolhe qual. */
  async trigger(branch?: string) {
    const b =
      branch ??
      (
        await vscode.window.showQuickPick(
          [...this.relevantBranches()].map(x => ({ label: x })),
          { placeHolder: t('Run the pipeline on which branch?') },
        )
      )?.label;
    if (!b) return;
    const client = await this.client(true);
    if (!client) return;
    let workflowId: number | undefined;
    // GitHub e Azure disparam uma definição específica; GitLab e Bitbucket rodam o arquivo de CI da branch
    if (client.kind === 'github' || client.kind === 'azure') {
      const wfs = await client.workflows().catch(() => []);
      if (!wfs.length) {
        vscode.window.showWarningMessage(client.kind === 'azure' ? t('No pipeline definition found in this project.') : t('No active workflow found in this repository.'));
        return;
      }
      const pick = await vscode.window.showQuickPick(
        wfs.map(w => ({ label: w.name, description: w.path, id: w.id })),
        {
          title: t('Trigger pipeline on {0}', b),
          placeHolder: client.kind === 'github' ? t('The workflow must have the workflow_dispatch trigger') : t('Which pipeline to run'),
        },
      );
      if (!pick) return;
      workflowId = pick.id;
    }
    await this.act(t('Triggering pipeline on {0}…', b), c => c.trigger(b, workflowId));
  }

  /** Job que falhou (ou o escolhido), para log e correção. */
  private async failedJob(p: Pipeline, job?: PipelineJob): Promise<PipelineJob | undefined> {
    if (job) return job;
    const jobs = await this.jobs(p);
    const failed = jobs.filter(j => j.status === 'failed');
    if (failed.length === 1) return failed[0];
    const list = failed.length ? failed : jobs;
    if (list.length === 1) return list[0];
    return (await vscode.window.showQuickPick(list.map(j => ({ label: j.name, description: `${j.stage ? `${j.stage} · ` : ''}${statusLabel(j.status)}`, j })), { placeHolder: t('Log of which job?') }))?.j;
  }

  async showLog(p: Pipeline, job?: PipelineJob) {
    const j = await this.failedJob(p, job);
    if (!j) return;
    const text = await this.act(t('Downloading the log of {0}…', j.name), c => c.log(j));
    if (text === undefined) return;
    // eslint-disable-next-line no-control-regex
    const clean = String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    const doc = await vscode.workspace.openTextDocument({ content: `# ${p.name} · ${j.name} (${p.branch})\n# ${j.url}\n\n${clean}`, language: 'log' });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  /** Jobs que falharam e o fim do log do primeiro (para o agente e a ferramenta MCP ci_status). */
  async failure(p: Pipeline, interactive = true): Promise<{ failed: PipelineJob[]; log: string } | undefined> {
    const jobs = await this.jobs(p).catch(() => [] as PipelineJob[]);
    const failed = jobs.filter(j => j.status === 'failed');
    const client = await this.client(interactive);
    if (!client) return undefined;
    const log = failed[0] ? tailLog(String(await client.log(failed[0]).catch(e => t('(could not download the log: {0})', (e as Error).message))), 150) : '';
    return { failed, log };
  }

  /** Prompt de correção do pipeline (worktreeGraph.prompts.fixPipeline). */
  async fixPrompt(p: Pipeline): Promise<string | undefined> {
    const f = await this.failure(p);
    if (!f) return undefined;
    const template = this.ctl.cfg().get<string>('prompts.fixPipeline', '') || defaultFixPrompt();
    return fillTemplate(template, {
      branch: p.branch,
      pipeline: p.name,
      url: p.url,
      jobs: f.failed.map(j => j.name).join(', ') || t('(not identified)'),
      log: f.log || t('(no log)'),
    });
  }

  /** Abre o agente na worktree da branch com o log da falha (cria a worktree se preciso). */
  async fixWithAgent(p: Pipeline) {
    const prompt = await this.fixPrompt(p);
    if (!prompt) return;
    const wts = (await this.ctl.repo?.worktreesFast()) ?? [];
    if (!wts.some(w => w.branch === p.branch)) {
      const dir = await createWorktree(this.ctl, { existing: p.branch, quiet: true });
      if (!dir) return;
    }
    await vscode.commands.executeCommand('worktreeGraph.launchAgentWithPrompt', { branch: p.branch, prompt });
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.changed.dispose();
  }
}

// ---------- view ----------

const ICON: Record<PipelineStatus, [string, string | undefined]> = {
  success: ['pass-filled', 'testing.iconPassed'],
  failed: ['error', 'testing.iconFailed'],
  running: ['sync~spin', 'charts.blue'],
  queued: ['clock', 'charts.yellow'],
  canceled: ['circle-slash', 'disabledForeground'],
  skipped: ['debug-step-over', 'disabledForeground'],
  manual: ['debug-start', 'charts.orange'],
  other: ['question', undefined],
};

function statusLabel(s: PipelineStatus): string {
  const labels: Record<PipelineStatus, string> = {
    success: t('passed'),
    failed: t('failed'),
    running: t('running'),
    queued: t('queued'),
    canceled: t('canceled'),
    skipped: t('skipped'),
    manual: t('waiting for manual action'),
    other: t('other'),
  };
  return labels[s];
}

function icon(s: PipelineStatus) {
  const [id, color] = ICON[s];
  return new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined);
}

function ago(unix: number) {
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 60) return t('now');
  if (s < 3600) return t('{0} min', Math.floor(s / 60));
  if (s < 86400) return t('{0} h', Math.floor(s / 3600));
  return t('{0} d', Math.floor(s / 86400));
}

export class PipelineItem extends vscode.TreeItem {
  readonly kind = 'pipeline';
  constructor(readonly pipeline: Pipeline) {
    super(pipeline.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `pipeline:${pipeline.provider}:${pipeline.id}`;
    this.iconPath = icon(pipeline.status);
    this.description = [pipeline.branch, formatDuration(pipeline.durationSec), ago(pipeline.createdAt)].filter(Boolean).join(' · ');
    this.tooltip = new vscode.MarkdownString(
      `**${pipeline.name}** — ${statusLabel(pipeline.status)}\n\nBranch \`${pipeline.branch}\` · \`${pipeline.sha.slice(0, 8)}\` · ${pipeline.event}\n\n[${t('Open in browser')}](${pipeline.url})`,
    );
    this.contextValue = `pipeline-${pipeline.status}-${pipeline.provider}`;
  }
}

export class JobItem extends vscode.TreeItem {
  readonly kind = 'job';
  constructor(readonly pipeline: Pipeline, readonly job: PipelineJob) {
    super(job.name, vscode.TreeItemCollapsibleState.None);
    this.id = `job:${pipeline.provider}:${job.id}`;
    this.iconPath = icon(job.status);
    this.description = [job.stage, statusLabel(job.status), formatDuration(job.durationSec)].filter(Boolean).join(' · ');
    this.contextValue = `pipelineJob-${job.status}-${pipeline.provider}`;
    this.command = { command: 'worktreeGraph.pipelines.log', title: t('View log'), arguments: [this] };
  }
}

class InfoItem extends vscode.TreeItem {
  readonly kind = 'info';
  constructor(label: string, command: string | undefined, iconId: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(iconId);
    if (command) this.command = { command, title: label };
  }
}

type Node = PipelineItem | JobItem | InfoItem;

export class PipelineTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly svc: PipelineService) {
    svc.onDidChange(() => this.emitter.fire());
  }

  getTreeItem(el: Node) {
    return el;
  }

  async getChildren(el?: Node): Promise<Node[]> {
    if (!el) {
      if (this.svc.unavailable === 'noRemote') return [new InfoItem(t('Remote is not a recognized GitHub, GitLab, Bitbucket or Azure DevOps remote'), 'worktreeGraph.connectHosting', 'info')];
      if (this.svc.unavailable === 'noAuth') return [new InfoItem(t('Connect to the remote to see pipelines…'), 'worktreeGraph.connectHosting', 'plug')];
      if (this.svc.error) return [new InfoItem(t('Error: {0}', this.svc.error), 'worktreeGraph.pipelines.refresh', 'error')];
      const list = this.svc.visible();
      if (!list.length) {
        return [
          new InfoItem(
            this.svc.scope === 'worktrees' ? t('No pipelines on branches with a worktree (show all from the title bar)') : t('No pipelines'),
            'worktreeGraph.pipelines.refresh',
            'check',
          ),
        ];
      }
      return list.map(p => new PipelineItem(p));
    }
    if (el instanceof PipelineItem) {
      try {
        const jobs = await this.svc.jobs(el.pipeline);
        return jobs.length ? jobs.map(j => new JobItem(el.pipeline, j)) : [new InfoItem(t('No jobs'), undefined, 'info')];
      } catch (e) {
        return [new InfoItem(t('Error: {0}', (e as Error).message), undefined, 'error')];
      }
    }
    return [];
  }
}

/** View "Pipelines" e seus comandos. */
export function registerPipelines(ctx: vscode.ExtensionContext, ctl: Controller, guard: Guard): PipelineService {
  const svc = new PipelineService(ctl);
  const view = vscode.window.createTreeView('worktreeGraph.pipelines', { treeDataProvider: new PipelineTreeProvider(svc), showCollapseAll: true });
  ctx.subscriptions.push(svc, view, view.onDidChangeVisibility(e => e.visible && svc.refresh()));
  const reg = (id: string, fn: (...args: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(`worktreeGraph.${id}`, guard(fn)));

  /** Aceita item da view, id numérico (painel) ou nada (pergunta). */
  const pipelineOf = async (arg: unknown): Promise<Pipeline | undefined> => {
    if (arg instanceof PipelineItem || arg instanceof JobItem) return arg.pipeline;
    if (typeof arg === 'number' || typeof arg === 'string') {
      if (!svc.pipelines.length) await svc.refresh(true);
      return svc.pipelines.find(p => String(p.id) === String(arg));
    }
    const list = svc.visible();
    return (await vscode.window.showQuickPick(list.map(p => ({ label: p.name, description: `${p.branch} · ${statusLabel(p.status)}`, p })), { placeHolder: t('Which pipeline?') }))?.p;
  };

  reg('pipelines.refresh', () => svc.refresh(true));
  reg('pipelines.scopeAll', () => svc.setScope('all'));
  reg('pipelines.scopeWorktrees', () => svc.setScope('worktrees'));
  reg('pipelines.open', async arg => {
    const url = arg instanceof JobItem ? arg.job.url : (await pipelineOf(arg))?.url;
    if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
  });
  reg('pipelines.log', async arg => {
    const p = await pipelineOf(arg);
    if (p) await svc.showLog(p, arg instanceof JobItem ? arg.job : undefined);
  });
  reg('pipelines.retry', async arg => {
    const p = await pipelineOf(arg);
    if (p) await svc.retry(p, false);
  });
  reg('pipelines.retryFailed', async arg => {
    const p = await pipelineOf(arg);
    if (p) await svc.retry(p, true);
  });
  reg('pipelines.cancel', async arg => {
    const p = await pipelineOf(arg);
    if (p) await svc.cancel(p);
  });
  reg('pipelines.trigger', (branch?: unknown) => svc.trigger(typeof branch === 'string' ? branch : undefined));
  reg('pipelines.fix', async arg => {
    const p = await pipelineOf(arg);
    if (p) await svc.fixWithAgent(p);
  });
  reg('pipelines.play', async arg => {
    if (arg instanceof JobItem) await svc.playJob(arg.job);
  });
  return svc;
}
