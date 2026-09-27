import * as vscode from 'vscode';
import type { Controller } from '../controller';
import { Issue } from './core';
import { IssueService } from './service';
import { IssueItem, IssueTreeProvider, showIssue } from './view';

type Guard = <T extends unknown[]>(fn: (...args: T) => unknown) => (...args: T) => Promise<void>;

/** View "Issues" e seus comandos. Separado de extension.ts para não disputar edições com outras áreas. */
export function registerIssues(ctx: vscode.ExtensionContext, ctl: Controller, guard: Guard): IssueService {
  const svc = new IssueService(ctl);
  ctl.requests.issueTrailers = b => svc.trailers(b);
  const view = vscode.window.createTreeView('worktreeGraph.issues', { treeDataProvider: new IssueTreeProvider(svc), showCollapseAll: true });
  ctx.subscriptions.push(svc, view, view.onDidChangeVisibility(e => e.visible && svc.refresh()));

  const issueOf = (arg: IssueItem | Issue | undefined): Issue | undefined => (arg && 'issue' in arg ? arg.issue : (arg as Issue | undefined));
  const reg = (id: string, fn: (...args: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(`worktreeGraph.${id}`, guard(fn)));

  reg('issues.refresh', () => svc.refresh(true));
  reg('issues.scopeAll', () => svc.setScope('all'));
  reg('issues.scopeMine', () => svc.setScope('mine'));
  reg('issues.start', arg => {
    const i = issueOf(arg);
    return i && svc.start(i, true);
  });
  reg('issues.createWorktree', arg => {
    const i = issueOf(arg);
    return i && svc.start(i, false);
  });
  reg('issues.openUrl', arg => {
    const i = issueOf(arg);
    return i && vscode.env.openExternal(vscode.Uri.parse(i.url));
  });
  reg('issues.copyLink', arg => {
    const i = issueOf(arg);
    return i && vscode.env.clipboard.writeText(i.url);
  });
  reg('issues.show', arg => {
    const i = issueOf(arg);
    return i && showIssue(i);
  });
  // Paleta: escolher uma issue de qualquer provedor e começar
  reg('issues.pick', async () => {
    await svc.refresh(true);
    const items = svc.groups.flatMap(g => g.issues.map(i => ({ label: `${i.key} ${i.title}`, description: g.title, detail: i.labels.join(' · '), issue: i })));
    if (!items.length) {
      vscode.window.showInformationMessage('Nenhuma issue encontrada. Conecte o GitHub/GitLab ou o Redmine na view Issues.');
      return;
    }
    const pick = await vscode.window.showQuickPick(items, { title: 'Começar trabalho numa issue (com Claude)', matchOnDescription: true, matchOnDetail: true });
    if (pick) await svc.start(pick.issue, true);
  });
  reg('connectRedmine', () => svc.connectRedmine());
  reg('issues.create', () => svc.create());
  // Trecho selecionado no editor vira contexto da issue: arquivo, linhas e código.
  reg('issues.createFromSelection', () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.selection.isEmpty) return svc.create();
    const doc = ed.document;
    const rel = vscode.workspace.asRelativePath(doc.uri, false);
    const a = ed.selection.start.line + 1;
    const b = ed.selection.end.line + (ed.selection.end.character === 0 ? 0 : 1);
    const code = doc.getText(ed.selection).replace(/\s+$/, '');
    return svc.create(`Em \`${rel}\` (linhas ${a}–${b}):\n\n\`\`\`${doc.languageId}\n${code}\n\`\`\``);
  });
  reg('disconnectRedmine', () => svc.disconnectRedmine());
  return svc;
}
