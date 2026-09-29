import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { agentsLabel } from './agents';
import { Controller } from './controller';
import { gitUri } from './diff';
import { discardEffect, KIND_LABEL, parseNumstat, parseUncommitted, Uncommitted } from './gitops/core';
import { BranchView, WorktreeView } from './model';
import { LOG_FORMAT, parseLog } from './summary/core';
import { locale, t } from './i18n';

type Node = OrphansGroup | WorktreeItem | UncommittedGroup | UncommittedFileItem | CommitsItem | CommitItem | ChangesItem | ChangeItem | DirItem | FileItem | BranchesGroup | BranchItem | TreeEntryItem;

const HIDDEN = new Set(['.git']);
const statusLabel = (s: string): string | undefined =>
  ({ A: t('added'), M: t('modified'), D: t('deleted'), '?': t('new, untracked'), T: t('type changed') })[s];

/** Último pipeline de uma branch (preenchido pelo provider a partir do estado). */
let pipelineOf: ((branch: string) => { status: string } | undefined) | undefined;

/** Preenchido a cada leitura com as branches protegidas (src/guards.ts), para o cadeado na árvore. */
let protectedNames = new Set<string>();
export function setProtectedNames(list: string[] | undefined) {
  protectedNames = new Set(list ?? []);
}

export class WorktreeItem extends vscode.TreeItem {
  readonly kind = 'worktree';
  readonly branch?: string;
  readonly path: string;

  constructor(readonly wt: WorktreeView, base: string, baseRef: string) {
    super(wt.name, wt.bare || wt.prunable ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `wt:${wt.path}`;
    this.branch = wt.branch;
    this.path = wt.path;
    this.contextValue = (wt.isMain || wt.isBase ? 'worktree-main' : 'worktree') + (wt.favorite ? '-fav' : '');

    const parts: string[] = [];
    if (wt.favorite) parts.push('★');
    if (wt.branch && protectedNames.has(wt.branch)) parts.push('🔒');
    if (!wt.statusKnown || !wt.compareKnown) parts.push('…');
    if (!wt.isBase && wt.behind) parts.push(`↓${wt.behind}`);
    if (!wt.isBase && wt.ahead) parts.push(`↑${wt.ahead}`);
    if (wt.changes) parts.push(`●${wt.changes}`);
    if (wt.branch && !wt.isBase && !wt.remote.published) parts.push(t('☁ unpublished'));
    else if (wt.remote.ahead) parts.push(`☁↑${wt.remote.ahead}`);
    if (wt.operation) parts.push(wt.operation);
    if (wt.preview?.conflict) parts.push(t('⚠ conflict'));
    if (wt.agents.length) parts.push(`✦ ${agentsLabel(wt.agents)}${wt.agentStates?.waiting ? ` · ${t('waiting for you')}` : ''}`);
    if (wt.review) parts.push(t('✓ review'));
    if (wt.tasks) parts.push(`☰${wt.tasks.waiting + (wt.tasks.running ? 1 : 0)}`);
    if (wt.overlap) parts.push(t('⚠ overlaps {0}', wt.overlap.with.length));
    if (wt.budget) parts.push(wt.budget.level === 'over' ? t('$ over budget') : `$ ${wt.budget.pct}%`);
    if (wt.request) parts.push(`${wt.request.ref}${wt.request.state === 'draft' ? ` ${t('draft')}` : ''}`);
    if (wt.branch && pipelineOf?.(wt.branch)) {
      const p = pipelineOf(wt.branch)!;
      parts.push(`${{ success: '✓', failed: '✗', running: '⟳', queued: '…', canceled: '⊘', skipped: '↷', manual: '▶' }[p.status] ?? '?'} CI`);
    }
    if (wt.stack) parts.push(`↳ ${wt.stack.parent}${wt.stack.state === 'ok' ? '' : ' ↻'}`);
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
    md.appendMarkdown(`**${wt.name}**${wt.isCurrent ? ` — ${t('this window')}` : ''}\n\n`);
    md.appendMarkdown(`\`${wt.path}\`\n\n`);
    if (wt.subject) md.appendMarkdown(t('Last commit: {0}', wt.subject) + '\n\n');
    if (wt.lastChange) md.appendMarkdown(t('Last change: {0}', new Date(wt.lastChange * 1000).toLocaleString(locale(), { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })) + '\n\n');
    if (!wt.isBase) md.appendMarkdown(t('{0} behind and {1} ahead of {2}', wt.behind, wt.ahead, `\`${baseRef}\``) + '\n\n');
    md.appendMarkdown((wt.changes ? t('{0} uncommitted change(s)', wt.changes) : t('Clean worktree')) + '\n\n');
    if (wt.branch)
      md.appendMarkdown(
        (!wt.remote.published
          ? t('Not published to the remote')
          : wt.remote.ahead || wt.remote.behind
            ? t('Remote: {0} to push, {1} to pull', wt.remote.ahead, wt.remote.behind)
            : t('Up to date with the remote')) + '\n\n',
      );
    if (wt.preview?.conflict) md.appendMarkdown(t('⚠ Merging {0} conflicts in: {1}', `\`${base}\``, wt.preview.files.join(', ')) + '\n\n');
    if (wt.agents.length) md.appendMarkdown(t('Open agents: {0}', agentsLabel(wt.agents)) + '\n\n');
    if (wt.agentStates?.waiting) md.appendMarkdown(`🔔 ${t('waiting for you')}${wt.agentStates.message ? `: ${wt.agentStates.message}` : ''}\n\n`);
    if (wt.sync) md.appendMarkdown(`Sync: ${wt.sync.message}\n\n`);
    if (wt.request) md.appendMarkdown(`[${wt.request.ref} ${wt.request.title}](${wt.request.url})\n\n`);
    this.tooltip = md;
  }
}

/** "Não commitadas": o que a worktree tem em disco e ainda não virou commit, para ver e descartar. */
class UncommittedGroup extends vscode.TreeItem {
  readonly kind = 'uncommitted';
  readonly path: string;
  readonly branch?: string;
  constructor(readonly wt: WorktreeView) {
    super(t('Uncommitted'), vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `uncommitted:${wt.path}`;
    this.path = wt.path;
    this.branch = wt.branch;
    this.description = String(wt.changes);
    this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
    this.contextValue = 'uncommitted';
    this.tooltip = t('Changes on disk not committed yet (includes staged changes and new files). Click a file to see the diff against the last commit.');
  }
}

class UncommittedFileItem extends vscode.TreeItem {
  readonly kind = 'uncommittedFile';
  readonly path: string;
  readonly branch?: string;
  readonly file: string;
  constructor(wt: WorktreeView, u: Uncommitted) {
    const cwd = wt.path;
    super(vscode.Uri.file(path.join(cwd, u.path)), vscode.TreeItemCollapsibleState.None);
    this.id = `uncommitted:${cwd}:${u.path}`;
    this.path = cwd;
    this.branch = wt.branch;
    this.file = u.path;
    this.label = path.basename(u.path);
    const dir = path.dirname(u.path) === '.' ? '' : path.dirname(u.path);
    const lines = u.binary ? 'bin' : u.added || u.deleted ? `+${u.added ?? 0} −${u.deleted ?? 0}` : '';
    this.description = [dir, u.letter, lines, KIND_LABEL[u.kind]].filter(Boolean).join('  ');
    this.tooltip = `${u.path}\n${statusLabel(u.letter) ?? (u.kind === 'conflict' ? t('conflicted') : u.letter)}${KIND_LABEL[u.kind] ? ` (${KIND_LABEL[u.kind]})` : ''}\n${t('If discarded: {0}', discardEffect(u))}`;
    this.contextValue = u.kind === 'conflict' ? 'uncommittedFile-conflict' : 'uncommittedFile';
    const file = vscode.Uri.file(path.join(cwd, u.path));
    const left = u.letter === '?' || u.letter === 'A' ? gitUri(cwd, '__empty__', u.path) : gitUri(cwd, 'HEAD', u.path);
    const right = u.letter === 'D' ? gitUri(cwd, '__empty__', u.path) : file;
    this.command = { command: 'vscode.diff', title: 'Diff', arguments: [left, right, t('{0} (last commit ↔ uncommitted)', path.basename(u.path)), { preview: true }] };
  }
}

/** "Alterações × base": o que a branch mudou desde que saiu da base, incluindo o não commitado. */
class ChangesItem extends vscode.TreeItem {
  readonly kind = 'changes';
  constructor(readonly wt: WorktreeView, readonly baseRef: string) {
    super(t('Changes × {0}', baseRef), vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `changes:${wt.path}`;
    this.iconPath = new vscode.ThemeIcon('diff');
    this.contextValue = 'changes';
  }
}

/** "Commits × base": o que foi commitado na branch e a base não tem. Clique num commit mostra os arquivos. */
class CommitsItem extends vscode.TreeItem {
  readonly kind = 'commits';
  constructor(readonly ref: string, readonly cwd: string, readonly baseRef: string, count: number, readonly branch?: string, readonly path?: string) {
    super(`Commits × ${baseRef}`, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `commits:${path ?? ref}`;
    this.description = String(count);
    this.iconPath = new vscode.ThemeIcon('git-commit');
    this.contextValue = 'commits';
    this.tooltip = t('Branch commits the base does not have (newest first). Right-click: summary, ask the agent.');
  }
}

class CommitItem extends vscode.TreeItem {
  readonly kind = 'commit';
  constructor(parentId: string, readonly sha: string, subject: string, author: string, date: number, body: string) {
    super(subject || sha.slice(0, 7), vscode.TreeItemCollapsibleState.None);
    this.id = `${parentId}:${sha}`;
    this.description = `${sha.slice(0, 7)} · ${author} · ${new Date(date * 1000).toLocaleDateString()}`;
    this.tooltip = `${sha}
${author}

${subject}${body ? `

${body}` : ''}`;
    this.iconPath = new vscode.ThemeIcon('git-commit');
    this.contextValue = 'commit';
    this.command = { command: 'worktreeGraph.showCommitSha', title: t('View commit files'), arguments: [sha] };
  }
}

class ChangeItem extends vscode.TreeItem {
  readonly kind = 'change';
  constructor(cwd: string, mergeBase: string, file: string, status: string, right: vscode.Uri, title: string) {
    super(vscode.Uri.file(path.join(cwd, file)), vscode.TreeItemCollapsibleState.None);
    this.label = path.basename(file);
    this.description = `${path.dirname(file) === '.' ? '' : path.dirname(file)}  ${status}`;
    this.tooltip = `${file} — ${statusLabel(status) ?? status}`;
    const left = status === 'A' || status === '?' ? gitUri(cwd, '__empty__', file) : gitUri(cwd, mergeBase, file);
    const r = status === 'D' ? gitUri(cwd, '__empty__', file) : right;
    this.command = { command: 'vscode.diff', title: 'Diff', arguments: [left, r, `${path.basename(file)} (${title})`, { preview: true }] };
  }
}

class DirItem extends vscode.TreeItem {
  readonly kind = 'dir';
  constructor(readonly dir: string, compactLabel?: string) {
    super(vscode.Uri.file(dir), vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `dir:${dir}`;
    this.contextValue = 'wtFolder';
    if (compactLabel) this.label = compactLabel;
  }
}

class FileItem extends vscode.TreeItem {
  readonly kind = 'file';
  constructor(file: string) {
    const uri = vscode.Uri.file(file);
    super(uri, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'wtFile';
    this.command = { command: 'vscode.open', title: t('Open'), arguments: [uri, { preview: true }] };
  }
}

class OrphansGroup extends vscode.TreeItem {
  readonly kind = 'orphans';
  constructor(count: number) {
    super(t('Orphaned worktrees (folder deleted)'), vscode.TreeItemCollapsibleState.None);
    this.id = 'orphans';
    this.description = String(count);
    this.iconPath = new vscode.ThemeIcon('trash');
    this.tooltip = t('Records of worktrees whose folder no longer exists. Click to remove them (git worktree prune).');
    this.command = { command: 'worktreeGraph.pruneWorktrees', title: t('Remove orphans') };
  }
}

class BranchesGroup extends vscode.TreeItem {
  readonly kind = 'branches';
  constructor(count: number) {
    super(t('Branches without a worktree'), vscode.TreeItemCollapsibleState.Collapsed);
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
    this.description = [b.behind ? `↓${b.behind}` : '', b.ahead ? `↑${b.ahead}` : t('merged')].filter(Boolean).join(' ');
    this.tooltip = `${b.name}\n${b.subject}\n${t('(read-only files, read from git)')}`;
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
      this.command = { command: 'vscode.open', title: t('Open'), arguments: [uri, { preview: true }] };
    }
  }
}

/**
 * Grupos extras na raiz da árvore, registrados por outros módulos (ex.: "Stashes" em src/gitops).
 * `children` devolve undefined quando o item não é dele.
 */
export const extraTree: { roots: () => vscode.TreeItem[]; children: (el: vscode.TreeItem) => Promise<vscode.TreeItem[]> | undefined }[] = [];

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
    if (s && (el instanceof ChangesItem || el instanceof UncommittedGroup)) return new WorktreeItem(el.wt, s.base, s.baseRef);
    return undefined;
  }

  async getChildren(el?: Node): Promise<Node[]> {
    const s = this.ctl.state;
    const repo = this.ctl.repo;
    if (!s || !repo) return [];
    try {
      if (!el) {
        pipelineOf = b => s.pipelines?.[b];
        const items: Node[] = s.worktrees.filter(w => !w.prunable).map(w => new WorktreeItem(w, s.base, s.baseRef));
        const orphans = s.worktrees.filter(w => w.prunable);
        if (orphans.length) items.push(new OrphansGroup(orphans.length));
        const branches = s.branches.filter(b => !b.isBase);
        if (branches.length) items.push(new BranchesGroup(branches.length));
        for (const x of extraTree) items.push(...(x.roots() as unknown as Node[]));
        return items;
      }
      for (const x of extraTree) {
        const c = x.children(el as vscode.TreeItem);
        if (c) return (await c) as unknown as Node[];
      }
      if (el instanceof WorktreeItem) {
        const out: Node[] = [];
        if (el.wt.changes > 0) out.push(new UncommittedGroup(el.wt));
        if (!el.wt.isBase) out.push(new CommitsItem(el.wt.branch ?? 'HEAD', el.wt.path, s.baseRef, el.wt.ahead, el.wt.branch, el.wt.path));
        if (!el.wt.isBase && el.wt.branch) out.push(new ChangesItem(el.wt, s.baseRef));
        return [...out, ...listDir(el.wt.path)];
      }
      if (el instanceof DirItem) return listDir(el.dir);
      if (el instanceof UncommittedGroup) {
        const cwd = el.wt.path;
        const [st, num] = await Promise.all([
          repo.run(['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'], cwd),
          repo.run(['diff', 'HEAD', '--numstat', '-z', '--no-renames'], cwd),
        ]);
        const stats = parseNumstat(num.stdout);
        const list = parseUncommitted(st.stdout).map(u => Object.assign(u, stats.get(u.path)));
        el.description = String(list.length);
        return list.map(u => new UncommittedFileItem(el.wt, u));
      }
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
      if (el instanceof BranchItem) {
        const files = await lsTree(repo.root, el.b.name, '', repo.exec.bind(repo));
        return el.b.ahead ? [new CommitsItem(el.b.name, repo.root, s.baseRef, el.b.ahead, el.b.name), ...files] : files;
      }
      if (el instanceof CommitsItem) {
        const out = await repo.exec(['log', LOG_FORMAT, '-n200', `${el.baseRef}..${el.ref}`, '--'], el.cwd);
        return parseLog(out).map(c => new CommitItem(el.id!, c.sha, c.subject, c.author, c.date, c.body));
      }
      if (el instanceof TreeEntryItem && el.isDir) return lsTree(el.cwd, el.ref, el.entryPath, repo.exec.bind(repo));
    } catch (e) {
      this.ctl.log(t('Tree: {0}', (e as Error).message));
    }
    return [];
  }
}

/** Nomes escondidos pelo `files.exclude` (só os padrões de nome simples, como "**\/node_modules"). */
function excludedNames(): Set<string> {
  const out = new Set(HIDDEN);
  const cfg = vscode.workspace.getConfiguration('files').get<Record<string, boolean>>('exclude', {});
  for (const [pattern, on] of Object.entries(cfg)) {
    if (!on) continue;
    const name = pattern.replace(/^\*\*\//, '');
    if (!/[*?{}[\]/]/.test(name)) out.add(name);
  }
  return out;
}

function readDir(dir: string, hidden: Set<string>): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(e => !hidden.has(e.name));
  } catch {
    return [];
  }
}

function listDir(dir: string): Node[] {
  const hidden = excludedNames();
  const compact = vscode.workspace.getConfiguration('explorer').get('compactFolders', true);
  return readDir(dir, hidden)
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map(e => {
      const full = path.join(dir, e.name);
      if (!e.isDirectory()) return new FileItem(full);
      // Como o Explorer: pasta com uma única subpasta vira "a/b/c".
      let deepest = full;
      const parts = [e.name];
      while (compact) {
        const inside = readDir(deepest, hidden);
        if (inside.length !== 1 || !inside[0].isDirectory()) break;
        parts.push(inside[0].name);
        deepest = path.join(deepest, inside[0].name);
      }
      return new DirItem(deepest, parts.length > 1 ? parts.join('/') : undefined);
    });
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
