import * as vscode from 'vscode';
import type { HostKind } from '../hosting/core';
import { hostLabel } from '../hosting/platforms';
import { Issue } from './core';
import { IssueGroup, IssueService } from './service';
import { t } from '../i18n';

const ICON: Record<string, [string, string]> = {
  github: ['issues', 'charts.green'],
  gitlab: ['issues', 'charts.orange'],
  redmine: ['issues', 'charts.red'],
};

function ago(unix: number) {
  if (!unix) return '';
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 3600) return t('{0} min', Math.max(1, Math.floor(s / 60)));
  if (s < 86400) return t('{0} h', Math.floor(s / 3600));
  return t('{0} d', Math.floor(s / 86400));
}

export class IssueGroupItem extends vscode.TreeItem {
  readonly kind = 'issueGroup';
  constructor(readonly group: IssueGroup) {
    super(group.title, group.issues.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `issues:${group.title}`;
    const count = group.total !== undefined && group.total > group.issues.length ? `${group.issues.length}/${group.total}` : String(group.issues.length);
    const state = group.needsConnect ? t('not connected') : group.error ? t('error') : count;
    this.description = group.detail && !group.needsConnect ? `${group.detail} · ${state}` : state;
    const icons: Record<string, string> = { redmine: 'tasklist', jira: 'issues', gitlab: 'source-control', bitbucket: 'repo', azure: 'azure-devops', github: 'github' };
    this.iconPath = new vscode.ThemeIcon(icons[group.provider] ?? 'issues');
    this.tooltip = group.error ?? [group.title, group.detail].filter(Boolean).join('\n');
    this.contextValue = `issueGroup-${group.provider}${group.needsConnect ? '-disconnected' : ''}`;
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
    if (issue.project) md.appendMarkdown(`${t('Project: {0}', escapeMd(issue.project))}  \n`);
    if (issue.assignee) md.appendMarkdown(`${t('Assignee: {0}', escapeMd(issue.assignee))}  \n`);
    if (issue.labels.length) md.appendMarkdown(`${issue.labels.map(escapeMd).join(' · ')}\n\n`);
    const excerpt = issue.body.trim().slice(0, 600);
    if (excerpt) md.appendText(`${excerpt}${issue.body.length > 600 ? '…' : ''}\n\n`);
    md.appendMarkdown(`[${t('Open in browser')}](${issue.url})`);
    this.tooltip = md;
    this.contextValue = branch ? 'issue-linked' : 'issue';
    this.command = { command: 'worktreeGraph.issues.show', title: t('View issue'), arguments: [this] };
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

export const isIssueNode = (n: unknown): n is Node => n instanceof IssueGroupItem || n instanceof IssueItem || n instanceof ActionItem;

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
        if (g.provider === 'redmine') return [new ActionItem(t('Connect to {0}…', 'Redmine'), 'worktreeGraph.connectRedmine', 'plug')];
        if (g.provider === 'jira') return [new ActionItem(t('Connect to {0}…', 'Jira'), 'worktreeGraph.connectJira', 'plug')];
        return [new ActionItem(t('Connect to {0}…', hostLabel(g.provider as HostKind)), 'worktreeGraph.connectHosting', 'plug')];
      }
      if (g.error) return [new ActionItem(t('Error: {0}', g.error), 'worktreeGraph.issues.refresh', 'error')];
      if (!g.issues.length) {
        if (g.filtered) return [new ActionItem(t('No issues with this filter'), 'worktreeGraph.redmine.filter', 'filter')];
        return [new ActionItem(this.svc.scope === 'mine' ? t('No open issues assigned to you') : t('No open issues'), 'worktreeGraph.issues.refresh', 'check')];
      }
      const items: Node[] = g.issues.map(i => new IssueItem(i, this.svc.branchOf(i)));
      if (g.total !== undefined && g.total > g.issues.length)
        items.push(new ActionItem(t('Load more ({0} of {1})…', g.issues.length, g.total), 'worktreeGraph.redmine.loadMore', 'ellipsis'));
      return items;
    }
    return [];
  }
}

/** Documento só de leitura com o conteúdo da issue. */
export async function showIssue(issue: Issue) {
  const content = [
    `# ${issue.key} ${issue.title}`,
    '',
    [issue.project && t('Project: {0}', issue.project), issue.assignee && t('Assignee: {0}', issue.assignee), issue.labels.length && issue.labels.join(' · ')].filter(Boolean).join('  \n'),
    '',
    issue.url,
    '',
    '---',
    '',
    issue.body || `_${t('(no description)')}_`,
  ].join('\n');
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content });
  await vscode.window.showTextDocument(doc, { preview: true });
}

function escapeMd(s: string) {
  return s.replace(/[\\`*_{}[\]()#+!|<>]/g, '\\$&');
}
