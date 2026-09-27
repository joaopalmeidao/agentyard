import * as vscode from 'vscode';
import { createWorktree } from '../actions';
import { fillTemplate } from '../agents';
import type { Controller } from '../controller';
import { formatDuration, Pipeline, PipelineClient, pipelineClient, PipelineJob, PipelineStatus, tailLog } from './pipelines';

type Guard = <T extends unknown[]>(fn: (...args: T) => unknown) => (...args: T) => Promise<void>;
type Scope = 'worktrees' | 'all';

const IDLE_MS = 60_000;
const BUSY_MS = 10_000;

const DEFAULT_FIX_PROMPT = [
  'O pipeline "${pipeline}" da branch ${branch} falhou (${url}).',
  'Jobs com falha: ${jobs}.',
  '',
  'Final do log do primeiro job que falhou:',
  '```',
  '${log}',
  '```',
  '',
  'Descubra a causa, corrija na branch ${branch}, rode localmente o que for possível (testes, lint, build) e faça commit. Não faça push sem me perguntar. Se a falha for de infraestrutura do CI e não do código, explique em vez de mudar o código.',
].join('\n');

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
      const agent = this.agentName();
      vscode.window
        .showWarningMessage(`Pipeline "${p.name}" falhou em ${p.branch}.`, 'Ver log', 'Re-executar', `✦ Pedir ao ${agent} para corrigir`)
        .then(pick => {
          if (pick === 'Ver log') return this.showLog(p);
          if (pick === 'Re-executar') return this.retry(p, true);
          if (pick) return this.fixWithAgent(p);
        });
    }
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
    return this.act(onlyFailed ? `Re-executando os jobs que falharam de ${p.name}…` : `Re-executando ${p.name}…`, c => c.retry(p, onlyFailed));
  }

  async cancel(p: Pipeline) {
    const ok = await vscode.window.showWarningMessage(`Cancelar "${p.name}" em ${p.branch}?`, { modal: true }, 'Cancelar pipeline');
    if (ok) await this.act(`Cancelando ${p.name}…`, c => c.cancel(p));
  }

  playJob(job: PipelineJob) {
    return this.act(`Iniciando o job manual ${job.name}…`, c => c.play(job));
  }

  /** Dispara um pipeline para a branch; no GitHub, escolhe o workflow (precisa de workflow_dispatch). */
  async trigger(branch?: string) {
    const b =
      branch ??
      (
        await vscode.window.showQuickPick(
          [...this.relevantBranches()].map(x => ({ label: x })),
          { placeHolder: 'Rodar pipeline em qual branch?' },
        )
      )?.label;
    if (!b) return;
    const client = await this.client(true);
    if (!client) return;
    let workflowId: number | undefined;
    if (client.kind === 'github') {
      const wfs = await client.workflows().catch(() => []);
      if (!wfs.length) {
        vscode.window.showWarningMessage('Nenhum workflow ativo encontrado neste repositório.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        wfs.map(w => ({ label: w.name, description: w.path, id: w.id })),
        { title: `Disparar workflow em ${b}`, placeHolder: 'O workflow precisa ter o gatilho workflow_dispatch' },
      );
      if (!pick) return;
      workflowId = pick.id;
    }
    await this.act(`Disparando pipeline em ${b}…`, c => c.trigger(b, workflowId));
  }

  /** Job que falhou (ou o escolhido), para log e correção. */
  private async failedJob(p: Pipeline, job?: PipelineJob): Promise<PipelineJob | undefined> {
    if (job) return job;
    const jobs = await this.jobs(p);
    const failed = jobs.filter(j => j.status === 'failed');
    if (failed.length === 1) return failed[0];
    const list = failed.length ? failed : jobs;
    if (list.length === 1) return list[0];
    return (await vscode.window.showQuickPick(list.map(j => ({ label: j.name, description: `${j.stage ? `${j.stage} · ` : ''}${j.status}`, j })), { placeHolder: 'Log de qual job?' }))?.j;
  }

  async showLog(p: Pipeline, job?: PipelineJob) {
    const j = await this.failedJob(p, job);
    if (!j) return;
    const text = await this.act(`Baixando o log de ${j.name}…`, c => c.log(j));
    if (text === undefined) return;
    // eslint-disable-next-line no-control-regex
    const clean = String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    const doc = await vscode.workspace.openTextDocument({ content: `# ${p.name} · ${j.name} (${p.branch})\n# ${j.url}\n\n${clean}`, language: 'log' });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  /** Abre o agente na worktree da branch com o log da falha (cria a worktree se preciso). */
  async fixWithAgent(p: Pipeline) {
    const jobs = await this.jobs(p).catch(() => [] as PipelineJob[]);
    const failed = jobs.filter(j => j.status === 'failed');
    let log = '';
    const client = await this.client(true);
    if (!client) return;
    if (failed[0]) log = tailLog(String(await client.log(failed[0]).catch(e => `(não consegui baixar o log: ${(e as Error).message})`)), 150);
    const wts = (await this.ctl.repo?.worktreesFast()) ?? [];
    if (!wts.some(w => w.branch === p.branch)) {
      const dir = await createWorktree(this.ctl, { existing: p.branch, quiet: true });
      if (!dir) return;
    }
    const template = this.ctl.cfg().get<string>('prompts.fixPipeline', '') || DEFAULT_FIX_PROMPT;
    const prompt = fillTemplate(template, {
      branch: p.branch,
      pipeline: p.name,
      url: p.url,
      jobs: failed.map(j => j.name).join(', ') || '(não identificados)',
      log: log || '(sem log)',
    });
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

const LABEL: Record<PipelineStatus, string> = {
  success: 'passou',
  failed: 'falhou',
  running: 'rodando',
  queued: 'na fila',
  canceled: 'cancelado',
  skipped: 'pulado',
  manual: 'aguardando ação manual',
  other: 'outro',
};

function icon(s: PipelineStatus) {
  const [id, color] = ICON[s];
  return new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined);
}

function ago(unix: number) {
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 60) return 'agora';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

export class PipelineItem extends vscode.TreeItem {
  readonly kind = 'pipeline';
  constructor(readonly pipeline: Pipeline) {
    super(pipeline.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `pipeline:${pipeline.provider}:${pipeline.id}`;
    this.iconPath = icon(pipeline.status);
    this.description = [pipeline.branch, formatDuration(pipeline.durationSec), ago(pipeline.createdAt)].filter(Boolean).join(' · ');
    this.tooltip = new vscode.MarkdownString(
      `**${pipeline.name}** — ${LABEL[pipeline.status]}\n\nBranch \`${pipeline.branch}\` · \`${pipeline.sha.slice(0, 8)}\` · ${pipeline.event}\n\n[Abrir no navegador](${pipeline.url})`,
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
    this.description = [job.stage, LABEL[job.status], formatDuration(job.durationSec)].filter(Boolean).join(' · ');
    this.contextValue = `pipelineJob-${job.status}-${pipeline.provider}`;
    this.command = { command: 'worktreeGraph.pipelines.log', title: 'Ver log', arguments: [this] };
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
      if (this.svc.unavailable === 'noRemote') return [new InfoItem('Remoto não é GitHub nem GitLab reconhecido', 'worktreeGraph.connectHosting', 'info')];
      if (this.svc.unavailable === 'noAuth') return [new InfoItem('Conectar ao GitHub/GitLab para ver os pipelines…', 'worktreeGraph.connectHosting', 'plug')];
      if (this.svc.error) return [new InfoItem(`Erro: ${this.svc.error}`, 'worktreeGraph.pipelines.refresh', 'error')];
      const list = this.svc.visible();
      if (!list.length) {
        return [
          new InfoItem(
            this.svc.scope === 'worktrees' ? 'Nenhum pipeline nas branches com worktree (mostrar todos no título)' : 'Nenhum pipeline',
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
        return jobs.length ? jobs.map(j => new JobItem(el.pipeline, j)) : [new InfoItem('Sem jobs', undefined, 'info')];
      } catch (e) {
        return [new InfoItem(`Erro: ${(e as Error).message}`, undefined, 'error')];
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
    return (await vscode.window.showQuickPick(list.map(p => ({ label: p.name, description: `${p.branch} · ${LABEL[p.status]}`, p })), { placeHolder: 'Qual pipeline?' }))?.p;
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
