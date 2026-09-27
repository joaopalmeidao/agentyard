import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { agents } from './agents';
import { computeFlow, flowStages } from './flow';
import { hostLabel } from './hosting/platforms';
import { RequestService } from './hosting/service';
import { Repo } from './git';
import { t } from './i18n';
import { applyCache, buildState, enrich, GraphState, RepoCache, resolveBase, SyncStatus, SyncWhere, GraphFilter } from './model';

/** Dono do repositório aberto e do estado mostrado na árvore e no grafo. */
export class Controller implements vscode.Disposable {
  repo?: Repo;
  state?: GraphState;
  readonly statuses = new Map<string, SyncStatus>();
  /** Preenchido pelo AutoSync: se esta janela é a que está rodando o sync. */
  syncOwner = false;
  /** Preenchido pelo AutoSync: mescla a base na branch antes do push (gatilho "push"). */
  beforePush?: (branch: string) => Promise<void>;
  /** Preenchido na ativação; informa quais worktrees têm terminal de agente aberto. */
  agentsRunning?: () => Map<string, string[]>;

  private readonly changed = new vscode.EventEmitter<GraphState | undefined>();
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.changed];
  private inFlight?: Promise<void>;
  private again = false;
  private debounce?: NodeJS.Timeout;
  private poll?: NodeJS.Timeout;
  readonly cache = new RepoCache();
  readonly requests = new RequestService(this);
  /** Quem mais enriquece o estado depois da leitura rápida (ex.: sessões do Claude). Deve ser barato. */
  readonly stateHooks: ((s: GraphState) => void)[] = [];
  /** Preenchido por src/coord: worktree que não deve receber tarefas automáticas (orçamento estourado). */
  taskBlocked?: (worktreePath: string) => boolean;
  private readonly cacheChanged = new vscode.EventEmitter<void>();
  /** Disparado quando chegam status novos (as cores da árvore de arquivos dependem disso). */
  readonly onDidChangeCache = this.cacheChanged.event;
  private enriching?: Promise<void>;
  private enrichAgain = false;
  private lastFire = 0;
  private fireTimer?: NodeJS.Timeout;
  private loadedOnce = false;
  /** Watcher do .git do repositório ativo; refeito ao trocar de projeto. */
  private repoWatch: vscode.Disposable[] = [];
  private readonly repoChanged = new vscode.EventEmitter<Repo | undefined>();
  /** Disparado quando o projeto ativo muda (sync, lista de projetos e títulos reagem). */
  readonly onDidChangeRepo = this.repoChanged.event;

  constructor(readonly ctx: vscode.ExtensionContext, readonly out: vscode.OutputChannel) {}

  cfg() {
    return vscode.workspace.getConfiguration('worktreeGraph');
  }

  log(msg: string) {
    this.out.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
  }

  private setLoading(state: 'loading' | 'ready' | 'noRepo') {
    vscode.commands.executeCommand('setContext', 'worktreeGraph.state', state);
  }

  /** Projeto escolhido nesta janela (se ainda existir); senão, o primeiro repositório do workspace. */
  private async initialRepo(): Promise<Repo | undefined> {
    const chosen = this.ctx.workspaceState.get<string>('activeProject');
    if (chosen && fs.existsSync(chosen)) {
      const r = await Repo.open(chosen);
      if (r) return r;
    }
    return findRepo();
  }

  /** Watcher, cache persistido e estado do repositório ativo. */
  private attachRepo() {
    this.repoWatch.forEach(d => d.dispose());
    this.repoWatch = [];
    if (!this.repo) return;
    this.cache.importCompares(this.ctx.workspaceState.get(this.cacheKey()));
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(this.repo.commonDir), '{HEAD,packed-refs,refs/**,worktrees/*/HEAD,worktrees/*/index}'),
    );
    const kick = () => this.scheduleRefresh();
    this.repoWatch.push(watcher, watcher.onDidChange(kick), watcher.onDidCreate(kick), watcher.onDidDelete(kick));
  }

  /**
   * Troca o projeto (repositório) ativo desta janela. Tudo que depende do repositório — árvore,
   * painel, merges, agentes, PRs, sync — passa a usar o novo.
   */
  async setActiveRepo(p: string) {
    const repo = await Repo.open(p);
    if (!repo) throw new Error(t('{0} is not a git repository.', p));
    if (this.repo && this.repo.commonDir.toLowerCase() === repo.commonDir.toLowerCase() && this.repo.root.toLowerCase() === repo.root.toLowerCase()) return;
    this.repo = repo;
    this.state = undefined;
    this.statuses.clear();
    this.cache.compares.clear();
    this.cache.statuses.clear();
    this.loadedOnce = false;
    this.requests.reset();
    this.attachRepo();
    await this.ctx.workspaceState.update('activeProject', repo.root);
    this.log(t('Active project: {0}', repo.root));
    this.setLoading('loading');
    this.changed.fire(undefined);
    this.repoChanged.fire(repo);
    await this.refresh();
  }

  async init() {
    this.setLoading('loading');
    this.repo = await this.initialRepo();
    if (!this.repo) this.setLoading('noRepo');
    this.attachRepo();
    this.repoChanged.fire(this.repo);
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('worktreeGraph')) {
          this.restartPolling();
          this.scheduleRefresh();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(async () => {
        // Só adota uma pasta do workspace se ainda não há projeto ativo.
        if (this.repo) return;
        this.repo = await findRepo();
        this.attachRepo();
        this.repoChanged.fire(this.repo);
        this.scheduleRefresh();
      }),
      vscode.window.onDidChangeWindowState(s => s.focused && this.scheduleRefresh()),
    );
    this.restartPolling();
    await this.refresh();
  }

  private restartPolling() {
    if (this.poll) clearInterval(this.poll);
    const secs = Math.max(3, this.cfg().get<number>('refreshIntervalSeconds', 15));
    this.poll = setInterval(() => vscode.window.state.focused && this.refresh(), secs * 1000);
  }

  /** Reaplica os ganchos de estado e redesenha, sem reler o repositório (mudanças só de memória). */
  repaint() {
    if (!this.state) return;
    for (const hook of this.stateHooks) hook(this.state);
    this.changed.fire(this.state);
  }

  scheduleRefresh(ms = 400) {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.refresh(), ms);
  }

  /** Quem chama durante um refresh em andamento espera também a nova rodada. */
  async refresh(): Promise<void> {
    this.again = true;
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      while (this.again) {
        this.again = false;
        await this.doRefresh();
      }
    })();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  private cacheKey() {
    return `compareCache:${this.repo?.commonDir.toLowerCase()}`;
  }

  /** Fase rápida (lista, refs, grafo) e, em seguida, detalhamento em segundo plano. */
  private async doRefresh() {
    if (!this.repo) {
      this.state = undefined;
      this.setLoading('noRepo');
      this.changed.fire(undefined);
      return;
    }
    const c = this.cfg();
    const t0 = Date.now();
    try {
      this.state = await buildState(
        this.repo,
        {
          configuredBase: this.configuredBase(),
          useRemoteBase: c.get('autoSync.fetchRemote', false),
          maxCommits: c.get('graph.maxCommits', 400),
          showRemotes: this.ctx.workspaceState.get<boolean>('graphShowRemotes') ?? c.get('graph.showRemoteBranches', true),
          paused: this.paused(),
          statuses: this.statuses,
          autoSync: {
            enabled: this.autoSyncEnabled(),
            mode: c.get('autoSync.mode', 'merge'),
            trigger: c.get('autoSync.trigger', 'push'),
            testCommand: c.get('autoSync.testCommand', ''),
            owner: this.syncOwner,
            where: this.syncWhere(),
          },
          agentNames: agents(this).map(a => a.name),
          agentsRunning: this.agentsRunning?.(),
          favorites: new Set(this.favorites()),
          // padrão: só o que falta mesclar; a escolha do usuário fica salva (por projeto e geral)
          graphFilter: this.ctx.workspaceState.get<GraphFilter>('graphFilter') ?? this.ctx.globalState.get<GraphFilter>('graphFilter', 'unmerged'),
          graphBranches: this.ctx.workspaceState.get<string[]>('graphBranches', []),
          ci: { flow: flowStages(this).map(s => s.branch), extras: c.get<string[]>('ciBranches', []) },
        },
        this.cache,
      );
      this.applyRequests();
      for (const hook of this.stateHooks) hook(this.state);
      this.requests.refresh();
      const stages = flowStages(this);
      if (stages.length > 1) {
        const refs = [
          ...this.state.worktrees.filter(w => w.branch).map(w => ({ name: w.branch!, kind: 'head', date: w.date })),
          ...this.state.branches.map(b => ({ name: b.name, kind: 'head', date: b.date })),
        ];
        this.state.flow = await computeFlow(this.repo, stages, refs);
      }
      if (!this.loadedOnce) this.log(t('Quick read: {0} worktrees in {1} ms', this.state.worktrees.length, Date.now() - t0));
    } catch (e) {
      this.log(t('Failed to read the repository: {0}', (e as Error).message));
      if (this.state) this.state.error = (e as Error).message;
    }
    this.setLoading('ready');
    this.changed.fire(this.state);
    this.startEnrich();
  }

  /** Detalha em segundo plano; uma rodada por vez, sem segurar a fase rápida. */
  private startEnrich() {
    if (this.enriching) {
      this.enrichAgain = true;
      return;
    }
    this.enriching = (async () => {
      do {
        this.enrichAgain = false;
        const state = this.state;
        if (!this.repo || !state) break;
        const c = this.cfg();
        const t0 = Date.now();
        const run = enrich(this.repo, state, this.cache, {
          activeSeconds: c.get('statusRefresh.activeSeconds', 60),
          idleSeconds: c.get('statusRefresh.idleSeconds', 600),
          concurrency: c.get('gitConcurrency', 4),
          isCancelled: () => this.state !== state,
          onResult: () => this.fireSoon(),
        });
        if (!this.loadedOnce && state.pending > 0) {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: t('AgentYard: loading details of {0} worktrees', state.pending) },
            () => run,
          );
        } else {
          await run;
        }
        if (this.state) applyCache(this.state, this.cache);
        this.changed.fire(this.state);
        this.cacheChanged.fire();
        if (!this.loadedOnce) this.log(t('Details loaded in {0} ms', Date.now() - t0));
        this.loadedOnce = true;
        await this.ctx.workspaceState.update(this.cacheKey(), this.cache.exportCompares());
      } while (this.enrichAgain);
    })().finally(() => (this.enriching = undefined));
  }

  /** Copia os PRs/MRs conhecidos para as views. */
  private applyRequests() {
    const s = this.state;
    if (!s) return;
    const r = this.requests;
    for (const w of s.worktrees) w.request = w.branch ? r.byBranch.get(w.branch) : undefined;
    for (const b of s.branches) b.request = r.byBranch.get(b.name);
    s.hosting = r.remote
      ? { kind: r.remote.kind, name: hostLabel(r.remote.kind), label: r.remote.kind === 'gitlab' ? 'MR' : 'PR', host: r.remote.host, connected: r.connected, error: r.error }
      : undefined;
  }

  /** Redesenha no máximo a cada 400 ms enquanto os resultados chegam. */
  private fireSoon() {
    if (this.fireTimer) return;
    // com centenas de worktrees, redesenhar mais de uma vez por segundo só atrapalha
    const wait = Math.max(0, 1000 - (Date.now() - this.lastFire));
    this.fireTimer = setTimeout(() => {
      this.fireTimer = undefined;
      this.lastFire = Date.now();
      if (this.state) applyCache(this.state, this.cache);
      this.changed.fire(this.state);
      this.cacheChanged.fire();
    }, wait);
  }

  async base(): Promise<{ base: string; baseRef: string }> {
    if (!this.repo) throw new Error(t('No git repository open.'));
    const c = this.cfg();
    return resolveBase(this.repo, await this.repo.refs(), this.configuredBase(), c.get('autoSync.fetchRemote', false));
  }

  favorites(): string[] {
    return this.repo ? this.ctx.globalState.get<string[]>(`favorites:${this.repo.commonDir.toLowerCase()}`, []) : [];
  }

  isFavorite(wtPath: string): boolean {
    return this.favorites().includes(path.normalize(wtPath).toLowerCase());
  }

  async setFavorite(wtPath: string, on: boolean) {
    if (!this.repo) return;
    const k = path.normalize(wtPath).toLowerCase();
    const set = new Set(this.favorites());
    if (on) set.add(k);
    else set.delete(k);
    await this.ctx.globalState.update(`favorites:${this.repo.commonDir.toLowerCase()}`, [...set]);
  }

  /** Base explícita, ou o primeiro estágio do fluxo de ambientes. */
  configuredBase(): string {
    return this.cfg().get<string>('baseBranch', '') || flowStages(this)[0]?.branch || '';
  }

  paused(): string[] {
    return this.repo ? this.ctx.workspaceState.get<string[]>(`pausedBranches:${this.repo.commonDir.toLowerCase()}`, []) : [];
  }

  async setPaused(branch: string, paused: boolean) {
    const set = new Set(this.paused());
    if (paused) set.add(branch);
    else set.delete(branch);
    if (this.repo) await this.ctx.workspaceState.update(`pausedBranches:${this.repo.commonDir.toLowerCase()}`, [...set]);
  }

  /** Guardado por repositório (common dir), e não em settings.json, para não sujar nenhuma worktree. */
  autoSyncEnabled(): boolean {
    if (!this.repo) return false;
    return this.ctx.globalState.get<boolean>(`autoSync:${this.repo.commonDir.toLowerCase()}`) ?? this.cfg().get('autoSync.enabledByDefault', false);
  }

  async setAutoSyncEnabled(v: boolean) {
    if (!this.repo) return;
    await this.ctx.globalState.update(`autoSync:${this.repo.commonDir.toLowerCase()}`, v);
  }

  syncWhere(): SyncWhere {
    const v = this.repo && this.ctx.globalState.get<SyncWhere>(`syncWhere:${this.repo.commonDir.toLowerCase()}`);
    return v ?? this.cfg().get<SyncWhere>('autoSync.where', 'local');
  }

  async setSyncWhere(v: SyncWhere) {
    if (this.repo) await this.ctx.globalState.update(`syncWhere:${this.repo.commonDir.toLowerCase()}`, v);
  }

  hasCiWorkflow(): boolean {
    if (!this.repo) return false;
    try {
      if (fs.existsSync(path.join(this.repo.root, '.gitlab', 'worktree-graph-sync.gitlab-ci.yml'))) return true;
      return fs.readdirSync(path.join(this.repo.root, '.github', 'workflows')).some(f => /^sync-.*-into-branches\.ya?ml$/.test(f));
    } catch {
      return false;
    }
  }

  dispose() {
    if (this.poll) clearInterval(this.poll);
    if (this.debounce) clearTimeout(this.debounce);
    if (this.fireTimer) clearTimeout(this.fireTimer);
    this.repoWatch.forEach(d => d.dispose());
    this.repoChanged.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}

async function findRepo(): Promise<Repo | undefined> {
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    const repo = await Repo.open(f.uri.fsPath);
    if (repo) return repo;
  }
  return undefined;
}
