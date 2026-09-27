import * as vscode from 'vscode';
import { Controller } from './controller';
import { WorktreeView } from './model';

export class WorktreeItem extends vscode.TreeItem {
  readonly branch?: string;
  readonly path: string;

  constructor(wt: WorktreeView, base: string, baseRef: string) {
    super(wt.name, vscode.TreeItemCollapsibleState.None);
    this.branch = wt.branch;
    this.path = wt.path;
    this.contextValue = wt.isMain || wt.isBase ? 'worktree-main' : 'worktree';

    const parts: string[] = [];
    if (!wt.isBase && (wt.behind || wt.ahead)) parts.push(`↓${wt.behind} ↑${wt.ahead}`);
    if (wt.changes) parts.push(`●${wt.changes}`);
    if (wt.operation) parts.push(wt.operation);
    if (wt.preview?.conflict) parts.push('⚠ conflito');
    if (wt.paused) parts.push('⏸');
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
    if (wt.sync) md.appendMarkdown(`Sync: ${wt.sync.message}\n\n`);
    this.tooltip = md;
    this.command = { command: 'worktreeGraph.openGraph', title: 'Abrir grafo' };
  }
}

export class WorktreeTreeProvider implements vscode.TreeDataProvider<WorktreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly ctl: Controller) {
    ctl.onDidChange(() => this.emitter.fire());
  }

  getTreeItem(el: WorktreeItem) {
    return el;
  }

  getChildren(): WorktreeItem[] {
    const s = this.ctl.state;
    if (!s) return [];
    return s.worktrees.map(w => new WorktreeItem(w, s.base, s.baseRef));
  }
}
