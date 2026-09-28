import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentTerminals } from '../agents';
import { stateText } from '../agents';
import { formatTokens } from '../claude/sessions';
import type { ClaudeService } from '../claude/view';
import type { Controller } from '../controller';
import { t } from '../i18n';
import { ChecklistItem, detectVerify, durationText, Milestone, MilestoneStatus, ProjectStatus, ReviewMode } from './core';
import { LongProject, LongProjects } from './service';

function statusText(s: ProjectStatus): string {
  switch (s) {
    case 'planning':
      return t('planning');
    case 'planned':
      return t('plan ready');
    case 'running':
      return t('running');
    case 'review':
      return t('waiting for review');
    case 'paused':
      return t('paused');
    case 'blocked':
      return t('blocked');
    case 'done':
      return t('done');
  }
}

function milestoneStatusText(s: MilestoneStatus): string {
  switch (s) {
    case 'pending':
      return t('pending');
    case 'active':
      return t('in progress');
    case 'done':
      return t('done');
    case 'blocked':
      return t('blocked');
    case 'stuck':
      return t('stuck');
  }
}

const PROJECT_ICON: Record<ProjectStatus, [string, string?]> = {
  planning: ['edit', 'charts.blue'],
  planned: ['checklist', 'charts.blue'],
  running: ['sync~spin', 'charts.blue'],
  review: ['eye', 'charts.yellow'],
  paused: ['debug-pause', 'charts.yellow'],
  blocked: ['bell-dot', 'charts.red'],
  done: ['pass-filled', 'testing.iconPassed'],
};
const MILESTONE_ICON: Record<MilestoneStatus, [string, string?]> = {
  pending: ['circle-large-outline', 'descriptionForeground'],
  active: ['sync~spin', 'charts.blue'],
  done: ['pass', 'testing.iconPassed'],
  blocked: ['bell-dot', 'charts.red'],
  stuck: ['warning', 'charts.yellow'],
};
const icon = ([id, color]: [string, string?]) => new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined);

export class ProjectItem extends vscode.TreeItem {
  constructor(readonly p: LongProject, agentState?: string) {
    super(p.config.title, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `lp:${p.key}`;
    const done = p.plan.filter(m => p.rt.milestones[m.id]?.status === 'done').length;
    this.description = [
      p.plan.length ? `${done}/${p.plan.length}` : '',
      p.rt.status === 'running' && p.rt.current ? `[${p.rt.current}]` : '',
      statusText(p.rt.status),
      agentState,
      p.branch ?? path.basename(p.worktree),
    ]
      .filter(Boolean)
      .join(' · ');
    this.iconPath = icon(PROJECT_ICON[p.rt.status]);
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${p.config.title}**\n\n${p.config.goal}\n\n`);
    if (p.rt.reason) md.appendMarkdown(`$(info) ${p.rt.reason}\n\n`);
    md.appendMarkdown(`${t('Verification')}: \`${p.config.verify || t('(none)')}\` · ${p.config.review === 'milestone' ? t('stops for review after each milestone') : t('advances on its own')}\n\n`);
    md.appendMarkdown(`${p.worktree}`);
    this.tooltip = md;
    this.contextValue = `lproject-${p.rt.status}`;
  }
}

export class MilestoneItem extends vscode.TreeItem {
  constructor(readonly p: LongProject, readonly m: Milestone, svc: LongProjects) {
    super(`[${m.id}] ${m.title}`, m.items.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.id = `lpm:${p.key}:${m.id}`;
    const mr = p.rt.milestones[m.id];
    const status: MilestoneStatus = mr?.status ?? (m.items.length && m.items.every(i => i.done) ? 'done' : 'pending');
    const done = m.items.filter(i => i.done).length;
    const tokens = mr ? svc.tokensOf(mr) : 0;
    const time = mr?.started ? durationText((mr.finished ?? Date.now()) - mr.started) : '';
    this.description = [m.items.length ? `${done}/${m.items.length}` : '', milestoneStatusText(status), time, tokens ? `${formatTokens(tokens)} tokens` : '']
      .filter(Boolean)
      .join(' · ');
    this.iconPath = icon(MILESTONE_ICON[status]);
    const lines = [
      `**[${m.id}] ${m.title}**`,
      mr ? t('{0} session(s) · the gate sent it back {1} time(s)', mr.sessions, mr.gateBlocks) : '',
      mr?.lastGate ? t('Last gate result: {0}', mr.lastGate) : '',
    ];
    this.tooltip = new vscode.MarkdownString(lines.filter(Boolean).join('\n\n'));
    this.contextValue = `lmilestone-${status}`;
  }
}

class CheckItem extends vscode.TreeItem {
  constructor(parent: string, i: ChecklistItem, n: number) {
    super(i.text, vscode.TreeItemCollapsibleState.None);
    this.id = `${parent}:${n}`;
    this.iconPath = new vscode.ThemeIcon(i.done ? 'check' : 'circle-small');
  }
}

type Node = ProjectItem | MilestoneItem | CheckItem;

class LongProjectsProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private readonly svc: LongProjects, private readonly agentTerms: AgentTerminals) {
    svc.onDidChange(() => this.emitter.fire());
    agentTerms.onDidChange(() => this.emitter.fire());
  }
  getTreeItem(el: Node) {
    return el;
  }
  getChildren(el?: Node): Node[] {
    if (!el) return this.svc.list().map(p => new ProjectItem(p, stateText(this.svc.terminalOf(p)?.state) || undefined));
    if (el instanceof ProjectItem) return el.p.plan.map(m => new MilestoneItem(el.p, m, this.svc));
    if (el instanceof MilestoneItem) return el.m.items.map((i, n) => new CheckItem(el.id!, i, n));
    return [];
  }
}

type Arg = ProjectItem | MilestoneItem | { path?: string; branch?: string } | undefined;

export function registerLongProjects(ctx: vscode.ExtensionContext, ctl: Controller, agentTerms: AgentTerminals, claude?: ClaudeService): LongProjects {
  const svc = new LongProjects(ctl, agentTerms, claude);
  const view = vscode.window.createTreeView('worktreeGraph.longProjects', { treeDataProvider: new LongProjectsProvider(svc, agentTerms), showCollapseAll: true });
  const badge = () => {
    const n = svc.needsAttention();
    view.badge = n ? { value: n, tooltip: t('{0} long-running project(s) need you', n) } : undefined;
  };
  ctx.subscriptions.push(svc, view, svc.onDidChange(badge));

  /** Projeto a partir do item da árvore ou pergunta. */
  const pickProject = async (arg: Arg, filter?: (p: LongProject) => boolean): Promise<LongProject | undefined> => {
    if (arg instanceof ProjectItem || arg instanceof MilestoneItem) return svc.get(arg.p.key) ?? arg.p;
    const list = svc.list().filter(p => !filter || filter(p));
    if (list.length === 1) return list[0];
    if (!list.length) {
      vscode.window.showInformationMessage(t('No long-running projects here.'));
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      list.map(p => ({ label: p.config.title, description: `${statusText(p.rt.status)} · ${p.branch ?? path.basename(p.worktree)}`, p })),
      { placeHolder: t('Which long-running project?') },
    );
    return pick?.p;
  };

  const guard =
    <T extends unknown[]>(fn: (...args: T) => unknown) =>
    async (...args: T) => {
      try {
        await fn(...args);
      } catch (e) {
        vscode.window.showErrorMessage(`AgentYard: ${(e as Error).message}`);
      }
    };
  const reg = (id: string, fn: (...args: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(`worktreeGraph.longProjects.${id}`, guard(fn)));

  reg('new', async (arg?: { path?: string; branch?: string }) => {
    const repo = ctl.repo;
    if (!repo) return;
    const wts = (await repo.worktreesFast()).filter(w => !w.prunable && !w.bare);
    let wt = arg?.path ? wts.find(w => w.path.toLowerCase() === arg.path!.toLowerCase()) : arg?.branch ? wts.find(w => w.branch === arg.branch) : undefined;
    if (!wt) {
      const pick = await vscode.window.showQuickPick(
        wts.map(w => ({ label: w.branch ?? path.basename(w.path), description: w.path, w })),
        { placeHolder: t('In which worktree will the project run? (tip: a dedicated branch)') },
      );
      wt = pick?.w;
    }
    if (!wt) return;
    const goal = await vscode.window.showInputBox({
      title: t('New long-running project in {0}', wt.branch ?? path.basename(wt.path)),
      prompt: t('What should be built? Describe the goal; the agent will ask about the details while planning.'),
      ignoreFocusOut: true,
    });
    if (!goal?.trim()) return;
    const title = await vscode.window.showInputBox({
      title: t('Project name'),
      value: goal.trim().split(/[.\n]/)[0].slice(0, 60),
      ignoreFocusOut: true,
    });
    if (!title?.trim()) return;
    const verify = await vscode.window.showInputBox({
      title: t('Verification command'),
      prompt: t('Must pass before the agent can finish a milestone (tests, build). Empty = no verification.'),
      value: detectVerify(wt.path, ctl.cfg().get<string>('autoSync.testCommand', '')),
      ignoreFocusOut: true,
    });
    if (verify === undefined) return;
    const review = await vscode.window.showQuickPick(
      [
        { label: t('Stop for review after each milestone'), description: t('recommended at the start'), mode: 'milestone' as ReviewMode },
        { label: t('Advance on its own'), description: t('the next milestone starts as soon as the gate passes'), mode: 'auto' as ReviewMode },
      ],
      { placeHolder: t('When a milestone is done…') },
    );
    if (!review) return;
    await svc.create(wt.path, wt.branch, {
      title: title.trim(),
      goal: goal.trim(),
      branch: wt.branch,
      verify: verify.trim(),
      review: review.mode,
      gate: true,
      created: Date.now(),
    });
    await vscode.commands.executeCommand('worktreeGraph.longProjects.focus');
  });
  reg('start', async (arg?: Arg) => {
    const p = await pickProject(arg, x => x.rt.status !== 'running' && x.rt.status !== 'done');
    if (p) await svc.resume(p);
  });
  reg('pause', async (arg?: Arg) => {
    const p = await pickProject(arg, x => x.rt.status === 'running');
    if (p) await svc.pauseByUser(p);
  });
  reg('replan', async (arg?: Arg) => {
    const p = await pickProject(arg);
    if (p) await svc.replan(p);
  });
  reg('openPlan', async (arg?: Arg) => {
    const p = await pickProject(arg);
    if (p) await vscode.window.showTextDocument(vscode.Uri.file(p.paths.plan));
  });
  reg('openProgress', async (arg?: Arg) => {
    const p = await pickProject(arg);
    if (p) await vscode.window.showTextDocument(vscode.Uri.file(p.paths.progress));
  });
  reg('showTerminal', async (arg?: Arg) => {
    const p = await pickProject(arg);
    const o = p && svc.terminalOf(p);
    if (o) o.terminal.show();
    else if (p) vscode.window.showInformationMessage(t('{0} has no session open right now.', p.config.title));
  });
  reg('verify', async (arg?: Arg) => {
    const p = await pickProject(arg);
    if (!p) return;
    if (!p.config.verify) return vscode.window.showInformationMessage(t('{0} has no verification command.', p.config.title));
    const term = vscode.window.createTerminal({ name: t('Verify · {0}', p.config.title), cwd: p.worktree, iconPath: new vscode.ThemeIcon('beaker') });
    term.show();
    term.sendText(p.config.verify);
  });
  reg('retryMilestone', async (it?: MilestoneItem) => {
    if (!(it instanceof MilestoneItem)) return;
    const p = svc.get(it.p.key);
    if (!p) return;
    await svc.resetMilestone(p, it.m.id);
    await svc.startNext(p, true);
  });
  reg('markDone', async (it?: MilestoneItem) => {
    if (!(it instanceof MilestoneItem)) return;
    const p = svc.get(it.p.key);
    if (p) await svc.markMilestoneDone(p, it.m.id);
  });
  reg('forget', async (arg?: Arg) => {
    const p = await pickProject(arg);
    if (!p) return;
    const yes = t('Reset');
    const pick = await vscode.window.showWarningMessage(
      t('Reset the progress AgentYard recorded for {0}? The files in {1} stay as they are.', p.config.title, p.paths.rel),
      { modal: true },
      yes,
    );
    if (pick === yes) await svc.forget(p);
  });

  badge();
  return svc;
}
