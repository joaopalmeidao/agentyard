import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Controller } from './controller';
import { gitUri } from './diff';
import { BranchView, WorktreeView } from './model';

type Node = WorktreeItem | ChangesItem | ChangeItem | DirItem | FileItem | BranchesGroup | BranchItem | TreeEntryItem;

const HIDDEN = new Set(['.git']);
const STATUS_LABEL: Record<string, string> = { A: 'adicionado', M: 'modificado', D: 'removido', '?': 'novo, não rastreado', T: 'tipo alterado' };

export class WorktreeItem extends vscode.TreeItem {
  readonly kind = 'worktree';
  readonly branch?: string;
  readonly path: string;

  constructor(readonly wt: WorktreeView, base: string, baseRef: string) {
    super(wt.name, wt.bare || wt.prunable ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `wt:${wt.path}`;
    this.branch = wt.branch;
    this.path = wt.path;
    this.contextValue = wt.isMain || wt.isBase ? 'worktree-main' : 'worktree';

    const parts: string[] = [];
    if (!wt.isBase && wt.behind) parts.push(`↓${wt.behind}`);
    if (!wt.isBase && wt.ahead) parts.push(`↑${wt.ahead}`);
    if (wt.changes) parts.push(`●${wt.changes}`);
    if (wt.operation) parts.push(wt.operation);
    if (wt.preview?.conflict) parts.push('⚠ conflito');
    if (wt.agents.length) parts.push(`✦ ${wt.agents.join(', ')}`);
    if (wt.paused) parts.push('‖');
    this.description = parts.join('  ');

    let icon = 'check';
    let color: string | undefined = 'testing.iconPassed';
    if (wt.operation || wt.preview?.conflict || wt.sync?.kind === 'test-failed') {
      icon = 'warning';
      color = 'list.warningForeground';
    } else if (wt.changes) {
      icon = 'circle-filled';
      color = 'gitDecoration.modifiedResourceForeground';
    } else if (wt.behind) {
      icon = 'arrow-down';
      color = 'gitDecoration.untrackedResourceForeground';
    }
    if (wt.isBase) icon = 'home';
    if (wt.isCurrent) this.label = { label: wt.name, highlights: [[0, wt.name.length]] };
    this.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);

    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${wt.name}**${wt.isCurrent ? ' — esta janela' : ''}\n\n`);
    md.appendMarkdown(`\`${wt.path}\`\n\n`);
    if (wt.subject) md.appendMarkdown(`Último commit: ${wt.subject}\n\n`);
    if (!wt.isBase) md.appendMarkdown(`${wt.behind} atrás e ${wt.ahead} à frente de \`${baseRef}\`\n\n`);
    md.appendMarkdown(wt.changes ? `${wt.changes} alteração(ões) não commitada(s)\n\n` : 'Worktree limpa\n\n');
    if (wt.preview?.conflict) md.appendMarkdown(`⚠ Mesclar \`${base}\` conflita em: ${wt.preview.files.join(', ')}\n\n`);
    if (wt.agents.length) md.appendMarkdown(`Agentes abertos: ${wt.agents.join(', ')}\n\n`);
    if (wt.sync) md.appendMarkdown(`Sync: ${wt.sync.message}\n\n`);
    this.tooltip = md;
  }
}

/** "Alterações × base": o que a branch mudou desde que saiu da base, incluindo o não commitado. */
class ChangesItem extends vscode.TreeItem {
  readonly kind = 'changes';
  constructor(readonly wt: WorktreeView, readonly baseRef: string) {
    super(`Alterações × ${baseRef}`, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `changes:${wt.path}`;
    this.iconPath = new vscode.ThemeIcon('diff');
    this.contextValue = 'changes';
  }
}

class ChangeItem extends vscode.TreeItem {
  readonly kind = 'change';
  constructor(cwd: string, mergeBase: string, file: string, status: string, right: vscode.Uri, title: string) {
    super(vscode.Uri.file(path.join(cwd, file)), vscode.TreeItemCollapsibleState.None);
    this.label = path.basename(file);
    this.description = `${path.dirname(file) === '.' ? '' : path.dirname(file)}  ${status}`;
    this.tooltip = `${file} — ${STATUS_LABEL[status] ?? status}`;
    const left = status === 'A' || status === '?' ? gitUri(cwd, '__empty__', file) : gitUri(cwd, mergeBase, file);
    const r = status === 'D' ? gitUri(cwd, '__empty__', file) : right;
    this.command = { command: 'vscode.diff', title: 'Diff', arguments: [left, r, `${path.basename(file)} (${title})`, { preview: true }] };
  }
}

class DirItem extends vscode.TreeItem {
  readonly kind = 'dir';
  constructor(readonly dir: string) {
    super(vscode.Uri.file(dir), vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `dir:${dir}`;
    this.contextValue = 'wtFolder';
  }
}

class FileItem extends vscode.TreeItem {
  readonly kind = 'file';
  constructor(file: string) {
    const uri = vscode.Uri.file(file);
    super(uri, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'wtFile';
    this.command = { command: 'vscode.open', title: 'Abrir', arguments: [uri, { preview: true }] };
  }
}

class BranchesGroup extends vscode.TreeItem {
  readonly kind = 'branches';
  constructor(count: number) {
    super('Branches sem worktree', vscode.TreeItemCollapsibleState.Collapsed);
    this.id = 'branches';
    this.description = String(count);
    this.iconPath = new vscode.ThemeIcon('git-branch');
  }
}

/** Branch sem worktree: navegável pelo conteúdo do commit, somente leitura. */
class BranchItem extends vscode.TreeItem {
  readonly kind = 'branch';
  readonly branch: string;
  constructor(readonly b: BranchView) {
    super(b.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `branch:${b.name}`;
    this.branch = b.name;
    this.contextValue = 'branch';
    this.description = [b.behind ? `↓${b.behind}` : '', b.ahead ? `↑${b.ahead}` : 'mesclada'].filter(Boolean).join(' ');
    this.tooltip = `${b.name}\n${b.subject}\n(arquivos somente leitura, lidos do git)`;
    this.iconPath = new vscode.ThemeIcon('git-branch');
  }
}

class TreeEntryItem extends vscode.TreeItem {
  readonly kind = 'entry';
  constructor(readonly cwd: string, readonly ref: string, readonly entryPath: string, readonly isDir: boolean) {
    super(vscode.Uri.file(path.join(cwd, entryPath)), isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.id = `entry:${ref}:${entryPath}`;
    this.description = isDir ? undefined : ref;
    if (!isDir) {
      const uri = gitUri(cwd, ref, entryPath);
      this.command = { command: 'vscode.open', title: 'Abrir', arguments: [uri, { preview: true }] };
    }
  }
}

export class WorktreeTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly ctl: Controller) {
    ctl.onDidChange(() => this.emitter.fire());
  }

  getTreeItem(el: Node) {
    return el;
  }

  getParent(el: Node): Node | undefined {
    const s = this.ctl.state;
    if (s && el instanceof ChangesItem) return new WorktreeItem(el.wt, s.base, s.baseRef);
    return undefined;
  }

  async getChildren(el?: Node): Promise<Node[]> {
    const s = this.ctl.state;
    const repo = this.ctl.repo;
    if (!s || !repo) return [];
    try {
      if (!el) {
        const items: Node[] = s.worktrees.map(w => new WorktreeItem(w, s.base, s.baseRef));
        const branches = s.branches.filter(b => !b.isBase);
        if (branches.length) items.push(new BranchesGroup(branches.length));
        return items;
      }
      if (el instanceof WorktreeItem) {
        const out: Node[] = [];
        if (!el.wt.isBase && el.wt.branch) out.push(new ChangesItem(el.wt, s.baseRef));
        return [...out, ...listDir(el.wt.path)];
      }
      if (el instanceof DirItem) return listDir(el.dir);
      if (el instanceof ChangesItem) {
        const cwd = el.wt.path;
        const mb = (await repo.exec(['merge-base', el.baseRef, 'HEAD'], cwd)).trim();
        const changed = (await repo.exec(['diff', '--name-status', '--no-renames', mb], cwd))
          .split(/\r?\n/)
          .filter(Boolean)
          .map(l => {
            const [st, ...rest] = l.split('\t');
            return { status: st[0], file: rest.join('\t') };
          });
        const untracked = (await repo.exec(['ls-files', '--others', '--exclude-standard'], cwd)).split(/\r?\n/).filter(Boolean);
        changed.push(...untracked.map(file => ({ status: '?', file })));
        el.description = String(changed.length);
        return changed.map(c => new ChangeItem(cwd, mb, c.file, c.status, vscode.Uri.file(path.join(cwd, c.file)), `${el.baseRef} ↔ ${el.wt.name}`));
      }
      if (el instanceof BranchesGroup) return s.branches.filter(b => !b.isBase).map(b => new BranchItem(b));
      if (el instanceof BranchItem) return lsTree(repo.root, el.b.name, '', repo.exec.bind(repo));
      if (el instanceof TreeEntryItem && el.isDir) return lsTree(el.cwd, el.ref, el.entryPath, repo.exec.bind(repo));
    } catch (e) {
      this.ctl.log(`Árvore: ${(e as Error).message}`);
    }
    return [];
  }
}

function listDir(dir: string): Node[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(e => !HIDDEN.has(e.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map(e => (e.isDirectory() ? new DirItem(path.join(dir, e.name)) : new FileItem(path.join(dir, e.name))));
}

async function lsTree(cwd: string, ref: string, dir: string, exec: (args: string[], cwd?: string) => Promise<string>): Promise<Node[]> {
  const spec = dir ? `${ref}:${dir}` : `${ref}:`;
  const out = await exec(['ls-tree', '-z', spec], cwd);
  return out
    .split('\0')
    .filter(Boolean)
    .map(line => {
      const [meta, name] = line.split('\t');
      return { name, isDir: meta.split(' ')[1] === 'tree' };
    })
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
    .map(e => new TreeEntryItem(cwd, ref, dir ? `${dir}/${e.name}` : e.name, e.isDir));
}
