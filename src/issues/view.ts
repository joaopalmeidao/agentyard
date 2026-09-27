import * as vscode from 'vscode';
import { Issue } from './core';
import { IssueGroup, IssueService } from './service';

const ICON: Record<string, [string, string]> = {
  github: ['issues', 'charts.green'],
  gitlab: ['issues', 'charts.orange'],
  redmine: ['issues', 'charts.red'],
};

function ago(unix: number) {
  if (!unix) return '';
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

export class IssueGroupItem extends vscode.TreeItem {
  readonly kind = 'issueGroup';
  constructor(readonly group: IssueGroup) {
    super(group.title, group.issues.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `issues:${group.title}`;
    this.description = group.needsConnect ? 'não conectado' : group.error ? 'erro' : String(group.issues.length);
    this.iconPath = new vscode.ThemeIcon(group.provider === 'redmine' ? 'tasklist' : group.provider === 'gitlab' ? 'source-control' : 'github');
    this.tooltip = group.error ?? group.title;
    this.contextValue = `issueGroup-${group.provider}`;
  }
}

export class IssueItem extends vscode.TreeItem {
  readonly kind = 'issue';
  constructor(readonly issue: Issue, branch: string | undefined) {
    super(`${issue.key} ${issue.title}`, vscode.TreeItemCollapsibleState.None);
    this.id = `issue:${issue.provider}:${issue.id}`;
    this.description = [branch ? `▣ ${branch}` : '', issue.labels.slice(0, 3).join(', '), ago(issue.updated)].filter(Boolean).join(' · ');
    const [icon, color] = ICON[issue.provider];
    this.iconPath = new vscode.ThemeIcon(branch ? 'git-branch' : icon, new vscode.ThemeColor(color));
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${issue.key} ${escapeMd(issue.title)}**\n\n`);
    if (issue.project) md.appendMarkdown(`Projeto: ${escapeMd(issue.project)}  \n`);
    if (issue.assignee) md.appendMarkdown(`Responsável: ${escapeMd(issue.assignee)}  \n`);
    if (issue.labels.length) md.appendMarkdown(`${issue.labels.map(escapeMd).join(' · ')}\n\n`);
    const excerpt = issue.body.trim().slice(0, 600);
    if (excerpt) md.appendText(`${excerpt}${issue.body.length > 600 ? '…' : ''}\n\n`);
    md.appendMarkdown(`[Abrir no navegador](${issue.url})`);
    this.tooltip = md;
    this.contextValue = branch ? 'issue-linked' : 'issue';
    this.command = { command: 'worktreeGraph.issues.show', title: 'Ver issue', arguments: [this] };
  }
}

class ActionItem extends vscode.TreeItem {
  readonly kind = 'action';
  constructor(label: string, command: string, icon: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = { command, title: label };
  }
}

type Node = IssueGroupItem | IssueItem | ActionItem;

export class IssueTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly svc: IssueService) {
    svc.onDidChange(() => this.emitter.fire());
  }

  getTreeItem(el: Node) {
    return el;
  }

  getChildren(el?: Node): Node[] {
    if (!el) return this.svc.groups.map(g => new IssueGroupItem(g));
    if (el instanceof IssueGroupItem) {
      const g = el.group;
      if (g.needsConnect) {
        return g.provider === 'redmine'
          ? [new ActionItem('Conectar ao Redmine…', 'worktreeGraph.connectRedmine', 'plug')]
          : [new ActionItem(`Conectar ao ${g.provider === 'gitlab' ? 'GitLab' : 'GitHub'}…`, 'worktreeGraph.connectHosting', 'plug')];
      }
      if (g.error) return [new ActionItem(`Erro: ${g.error}`, 'worktreeGraph.issues.refresh', 'error')];
      if (!g.issues.length) return [new ActionItem(this.svc.scope === 'mine' ? 'Nenhuma issue aberta atribuída a você' : 'Nenhuma issue aberta', 'worktreeGraph.issues.refresh', 'check')];
      return g.issues.map(i => new IssueItem(i, this.svc.branchOf(i)));
    }
    return [];
  }
}

/** Documento só de leitura com o conteúdo da issue. */
export async function showIssue(issue: Issue) {
  const content = [
    `# ${issue.key} ${issue.title}`,
    '',
    [issue.project && `Projeto: ${issue.project}`, issue.assignee && `Responsável: ${issue.assignee}`, issue.labels.length && issue.labels.join(' · ')].filter(Boolean).join('  \n'),
    '',
    issue.url,
    '',
    '---',
    '',
    issue.body || '_(sem descrição)_',
  ].join('\n');
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content });
  await vscode.window.showTextDocument(doc, { preview: true });
}

function escapeMd(s: string) {
  return s.replace(/[\\`*_{}[\]()#+!|<>]/g, '\\$&');
}
