import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { agents } from './agents';
import { Repo } from './git';
import { buildState, GraphState, resolveBase, SyncStatus, SyncWhere } from './model';

/** Dono do repositório aberto e do estado mostrado na árvore e no grafo. */
export class Controller implements vscode.Disposable {
  repo?: Repo;
  state?: GraphState;
  readonly statuses = new Map<string, SyncStatus>();
  /** Preenchido pelo AutoSync: se esta janela é a que está rodando o sync. */
  syncOwner = false;
  /** Preenchido na ativação; informa quais worktrees têm terminal de agente aberto. */
  agentsRunning?: () => Map<string, string[]>;

  private readonly changed = new vscode.EventEmitter<GraphState | undefined>();
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.changed];
  private inFlight?: Promise<void>;
  private again = false;
  private debounce?: NodeJS.Timeout;
  private poll?: NodeJS.Timeout;

  constructor(readonly ctx: vscode.ExtensionContext, readonly out: vscode.OutputChannel) {}

  cfg() {
    return vscode.workspace.getConfiguration('worktreeGraph');
  }

  log(msg: string) {
    this.out.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
  }

  async init() {
    this.repo = await findRepo();
    if (this.repo) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(this.repo.commonDir), '{HEAD,packed-refs,refs/**,worktrees/*/HEAD,worktrees/*/index}'),
      );
      const kick = () => this.scheduleRefresh();
      this.disposables.push(watcher, watcher.onDidChange(kick), watcher.onDidCreate(kick), watcher.onDidDelete(kick));
    }
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('worktreeGraph')) {
          this.restartPolling();
          this.scheduleRefresh();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(async () => {
        this.repo = await findRepo();
        this.scheduleRefresh();
      }),
      vscode.window.onDidChangeWindowState(s => s.focused && this.scheduleRefresh()),
    );
    vscode.commands.executeCommand('setContext', 'worktreeGraph.hasRepo', !!this.repo);
    this.restartPolling();
    await this.refresh();
  }

  private restartPolling() {
    if (this.poll) clearInterval(this.poll);
    const secs = Math.max(3, this.cfg().get<number>('refreshIntervalSeconds', 15));
    this.poll = setInterval(() => vscode.window.state.focused && this.refresh(), secs * 1000);
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

  private async doRefresh() {
    if (!this.repo) {
      this.state = undefined;
      this.changed.fire(undefined);
      return;
    }
    const c = this.cfg();
    try {
      this.state = await buildState(this.repo, {
        configuredBase: c.get('baseBranch', ''),
        useRemoteBase: c.get('autoSync.fetchRemote', false),
        maxCommits: c.get('graph.maxCommits', 400),
        showRemotes: c.get('graph.showRemoteBranches', true),
        paused: this.paused(),
        statuses: this.statuses,
        autoSync: {
          enabled: this.autoSyncEnabled(),
          mode: c.get('autoSync.mode', 'merge'),
          testCommand: c.get('autoSync.testCommand', ''),
          owner: this.syncOwner,
          where: this.syncWhere(),
        },
        agentNames: agents(this).map(a => a.name),
        agentsRunning: this.agentsRunning?.(),
      });
    } catch (e) {
      this.log(`Falha ao ler o repositório: ${(e as Error).message}`);
      if (this.state) this.state.error = (e as Error).message;
    }
    this.changed.fire(this.state);
  }

  async base(): Promise<{ base: string; baseRef: string }> {
    if (!this.repo) throw new Error('Nenhum repositório git aberto.');
    const c = this.cfg();
    return resolveBase(this.repo, await this.repo.refs(), c.get('baseBranch', ''), c.get('autoSync.fetchRemote', false));
  }

  paused(): string[] {
    return this.ctx.workspaceState.get<string[]>('pausedBranches', []);
  }

  async setPaused(branch: string, paused: boolean) {
    const set = new Set(this.paused());
    if (paused) set.add(branch);
    else set.delete(branch);
    await this.ctx.workspaceState.update('pausedBranches', [...set]);
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
      return fs.readdirSync(path.join(this.repo.root, '.github', 'workflows')).some(f => /^sync-.*-into-branches\.ya?ml$/.test(f));
    } catch {
      return false;
    }
  }

  dispose() {
    if (this.poll) clearInterval(this.poll);
    if (this.debounce) clearTimeout(this.debounce);
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
