import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Controller } from './controller';
import { Repo } from './git';
import { t } from './i18n';

const STORE_KEY = 'projects';

export interface ProjectInfo {
  /** Pasta da worktree principal. */
  path: string;
  name: string;
  inWorkspace: boolean;
  active: boolean;
  branch?: string;
  worktrees: number;
  missing: boolean;
}

const key = (p: string) => path.normalize(p).toLowerCase();

/** Pasta da worktree principal de um repositório (o "projeto"), mesmo que se abra uma worktree. */
export function mainPathOf(repo: Repo): string {
  return path.basename(repo.commonDir).toLowerCase() === '.git' ? path.dirname(repo.commonDir) : repo.root;
}

/**
 * Resumo sem processos git (cada um custa ~0,5 s em algumas máquinas): branch atual pelo HEAD e
 * número de worktrees por `.git/worktrees`.
 */
export function quickSummary(projectPath: string): { branch?: string; worktrees: number; missing: boolean } {
  const gitDir = path.join(projectPath, '.git');
  try {
    if (!fs.statSync(gitDir).isDirectory()) return { worktrees: 1, missing: false };
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const branch = head.startsWith('ref: ') ? head.slice(5).replace(/^refs\/heads\//, '') : head.slice(0, 7);
    let extra = 0;
    try {
      extra = fs.readdirSync(path.join(gitDir, 'worktrees')).length;
    } catch {
      // sem worktrees adicionais
    }
    return { branch, worktrees: 1 + extra, missing: false };
  } catch {
    return { worktrees: 0, missing: true };
  }
}

/** Repositórios diretamente dentro de `parent` (1 nível, sem recursão). */
export function scanRepos(parent: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  if (fs.existsSync(path.join(parent, '.git'))) found.push(parent);
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    const dir = path.join(parent, e.name);
    try {
      if (fs.statSync(path.join(dir, '.git')).isDirectory()) found.push(dir);
    } catch {
      // não é repositório
    }
  }
  return found;
}

/** Projetos do workspace + adicionados pelo usuário (compartilhados entre janelas via globalState). */
export class Projects implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  /** Pastas do workspace que são repositórios → pasta principal do projeto. */
  private workspaceRepos: string[] = [];
  private readonly disposables: vscode.Disposable[] = [this.changed];

  constructor(private readonly ctl: Controller) {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scanWorkspace()),
      ctl.onDidChangeRepo(() => this.changed.fire()),
    );
  }

  async scanWorkspace() {
    const out: string[] = [];
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      const repo = await Repo.open(f.uri.fsPath);
      if (repo) out.push(mainPathOf(repo));
    }
    this.workspaceRepos = out;
    this.changed.fire();
  }

  stored(): string[] {
    return this.ctl.ctx.globalState.get<string[]>(STORE_KEY, []);
  }

  list(): ProjectInfo[] {
    const active = this.ctl.repo ? key(mainPathOf(this.ctl.repo)) : '';
    const ws = new Set(this.workspaceRepos.map(key));
    const seen = new Set<string>();
    const out: ProjectInfo[] = [];
    for (const p of [...this.workspaceRepos, ...this.stored()]) {
      const k = key(p);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ path: p, name: path.basename(p), inWorkspace: ws.has(k), active: k === active, ...quickSummary(p) });
    }
    return out;
  }

  /** Adiciona sem perguntar (usado pelos comandos e pelos testes). Devolve a pasta principal, ou undefined se não for repositório. */
  async addPath(p: string): Promise<string | undefined> {
    const repo = await Repo.open(p);
    if (!repo) return undefined;
    const main = mainPathOf(repo);
    const list = this.stored();
    if (!list.some(x => key(x) === key(main))) await this.ctl.ctx.globalState.update(STORE_KEY, [...list, main]);
    this.changed.fire();
    return main;
  }

  async add() {
    const how = await vscode.window.showQuickPick(
      [
        { label: `$(folder-opened) ${t('Choose a repository folder…')}`, v: 'one' },
        { label: `$(search) ${t('Find repositories in a folder…')}`, detail: t('Lists the repositories right below the chosen folder (e.g. git_repos)'), v: 'scan' },
      ],
      { title: t('Add project') },
    );
    if (!how) return;
    const dir = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: how.v === 'one' ? t('Add') : t('Search here') });
    if (!dir?.[0]) return;
    let targets = [dir[0].fsPath];
    if (how.v === 'scan') {
      const known = new Set(this.list().map(p => key(p.path)));
      const found = scanRepos(dir[0].fsPath);
      if (!found.length) {
        vscode.window.showInformationMessage(t('No git repositories right below {0}.', dir[0].fsPath));
        return;
      }
      const picks = await vscode.window.showQuickPick(
        found.map(f => ({ label: path.basename(f), description: known.has(key(f)) ? t('already in the list') : '', detail: f, picked: false, f })),
        { canPickMany: true, title: t('{0} repositories in {1}', found.length, dir[0].fsPath), matchOnDetail: true },
      );
      if (!picks?.length) return;
      targets = picks.map(p => p.f);
    }
    const added: string[] = [];
    for (const target of targets) {
      const main = await this.addPath(target);
      if (main) added.push(path.basename(main));
      else vscode.window.showWarningMessage(t('{0} is not a git repository.', target));
    }
    if (added.length === 1) {
      const go = await vscode.window.showInformationMessage(t('Project {0} added.', added[0]), t('Make active'));
      if (go) await this.ctl.setActiveRepo(targets[0]);
    } else if (added.length) {
      vscode.window.showInformationMessage(t('{0} projects added.', added.length));
    }
  }

  async remove(p?: string) {
    const target = p ?? (await this.pick(t('Remove which project from the list?'), true))?.path;
    if (!target) return;
    await this.ctl.ctx.globalState.update(
      STORE_KEY,
      this.stored().filter(x => key(x) !== key(target)),
    );
    this.changed.fire();
  }

  private async pick(title: string, onlyStored = false): Promise<ProjectInfo | undefined> {
    const stored = new Set(this.stored().map(key));
    const list = this.list().filter(p => !onlyStored || stored.has(key(p.path)));
    if (!list.length) {
      vscode.window.showInformationMessage(onlyStored ? t('No projects added manually.') : t('No projects. Use "Add project…".'));
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      list.map(p => ({
        label: `${p.active ? '$(check) ' : '$(repo) '}${p.name}`,
        description: p.missing
          ? t('folder not found')
          : `${p.branch ?? ''} · ${t('{0} worktree(s)', p.worktrees)}${p.inWorkspace ? ` · ${t('in the workspace')}` : ''}`,
        detail: p.path,
        p,
      })),
      { title, matchOnDetail: true },
    );
    return picked?.p;
  }

  async switch(p?: string) {
    if (p) return this.ctl.setActiveRepo(p);
    const picked = await this.pick(t('Switch project'));
    if (!picked) return;
    if (picked.missing) {
      vscode.window.showWarningMessage(t('The folder {0} no longer exists.', picked.path));
      return;
    }
    await this.ctl.setActiveRepo(picked.path);
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
  }
}

class ProjectItem extends vscode.TreeItem {
  constructor(readonly project: ProjectInfo) {
    super(project.name, vscode.TreeItemCollapsibleState.None);
    this.id = `project:${key(project.path)}`;
    this.description = project.missing
      ? t('folder not found')
      : [project.active ? t('active') : '', project.branch, t('{0} worktree(s)', project.worktrees)].filter(Boolean).join(' · ');
    this.tooltip = `${project.path}${project.inWorkspace ? `\n${t('(workspace folder)')}` : ''}`;
    this.iconPath = new vscode.ThemeIcon(project.active ? 'pass-filled' : project.missing ? 'warning' : 'repo', project.active ? new vscode.ThemeColor('testing.iconPassed') : undefined);
    this.contextValue = project.inWorkspace ? 'project-ws' : 'project';
    this.command = { command: 'worktreeGraph.switchProject', title: t('Make active'), arguments: [project.path] };
  }

  get path() {
    return this.project.path;
  }
}

export class ProjectsTreeProvider implements vscode.TreeDataProvider<ProjectItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly projects: Projects) {
    projects.onDidChange(() => this.emitter.fire());
  }

  getTreeItem(el: ProjectItem) {
    return el;
  }

  getChildren(): ProjectItem[] {
    return this.projects.list().map(p => new ProjectItem(p));
  }
}
