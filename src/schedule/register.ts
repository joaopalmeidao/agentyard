import * as vscode from 'vscode';
import { agents } from '../agents';
import type { AgentTerminals } from '../agents';
import type { TaskQueue } from '../agentFlow/tasks';
import type { Controller } from '../controller';
import { describeTarget, nextRuns, parseWhen, relativeTime, Schedule, Target } from './core';
import { Scheduler } from './service';
import { locale, t } from '../i18n';

/** Texto inicial da tarefa; os ${…} são trocados na hora da execução (passam como argumentos do t). */
const defaultPrompt = () => t('Scheduled task on {0} on branch {1} (base {2}): ', '${date}', '${branch}', '${base}');

class ScheduleItem extends vscode.TreeItem {
  constructor(readonly schedule: Schedule, sch: Scheduler) {
    super(schedule.name, vscode.TreeItemCollapsibleState.None);
    this.id = `schedule:${schedule.id}`;
    this.contextValue = schedule.enabled ? 'schedule-on' : 'schedule-off';
    const next = sch.next(schedule);
    let valid = true;
    try {
      parseWhen(schedule.when);
    } catch {
      valid = false;
    }
    this.description = !valid ? t('⚠ invalid schedule') : !schedule.enabled ? t('paused') : next ? relativeTime(next, new Date(sch.now())) : t('no next run');
    this.iconPath = new vscode.ThemeIcon(!valid ? 'warning' : schedule.enabled ? 'clock' : 'debug-pause');
    const rt = sch.runtime(schedule.id);
    const last = sch.history().find(h => h.scheduleId === schedule.id);
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${schedule.name}**${schedule.scope === 'shared' ? t(' — shared ({0})', '.agentyard/schedules.json') : ''}\n\n`);
    md.appendMarkdown(t('When: {0}', `\`${schedule.when}\``) + '\n\n');
    md.appendMarkdown(
      t('Target: {0} · {1}', describeTarget(schedule.target), schedule.delivery === 'queue' ? t('goes to the queue') : t('opens the agent')) +
        `${schedule.agent ? ` (${schedule.agent})` : ''}\n\n`,
    );
    const conds = [schedule.conditions.onlyClean ? t('clean worktree only') : '', schedule.conditions.onlyIfBaseMoved ? t('only if the base moved') : '', schedule.conditions.skipIfAgentOpen ? t('skips if an agent is open') : '']
      .filter(Boolean)
      .join(', ');
    if (conds) md.appendMarkdown(t('Conditions: {0}', conds) + '\n\n');
    if (rt.lastRun) md.appendMarkdown(t('Last run: {0}', new Date(rt.lastRun).toLocaleString(locale())) + `${last ? ` — ${last.result}: ${last.message}` : ''}\n\n`);
    md.appendMarkdown(`${t('Task:')}\n\n> ${schedule.prompt.replace(/\n/g, '\n> ')}`);
    this.tooltip = md;
    this.command = { command: 'worktreeGraph.schedules.edit', title: t('Edit'), arguments: [this] };
  }
}

class SchedulesProvider implements vscode.TreeDataProvider<ScheduleItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private readonly sch: Scheduler) {
    sch.onDidChange(() => this.emitter.fire());
    // o "amanhã 09:00" envelhece; atualiza a cada minuto
    setInterval(() => this.emitter.fire(), 60_000).unref?.();
  }
  getTreeItem(e: ScheduleItem) {
    return e;
  }
  getChildren(): ScheduleItem[] {
    return this.sch
      .list()
      .sort((a, b) => (this.sch.next(a)?.getTime() ?? Infinity) - (this.sch.next(b)?.getTime() ?? Infinity))
      .map(s => new ScheduleItem(s, this.sch));
  }
}

/** Modelos no idioma da interface: o parser aceita português e inglês. */
const presets = () => [t('every day at 09:00'), t('weekdays at 09:00'), t('every monday at 09:00'), t('every 2 hours'), t('every 30 min'), t('hourly')];

/** "Quando", com os próximos 3 horários aparecendo enquanto se digita. */
async function askWhen(initial: string): Promise<string | undefined> {
  const PRESETS = presets();
  const onceLabel = t('once on…');
  const writeLabel = t('Write (shortcut or 5-field cron)…');
  const pick = await vscode.window.showQuickPick(
    [
      ...PRESETS.map(p => ({ label: p, description: preview(p, 1) })),
      { label: onceLabel, description: t('on a date and time') },
      { label: writeLabel, description: initial && !PRESETS.includes(initial) ? t('current: {0}', initial) : '' },
    ],
    { title: t('Schedule: when?'), placeHolder: initial ? t('current: {0}', initial) : t('pick a template; you can adjust the time next') },
  );
  if (!pick) return undefined;
  const tomorrow = new Date(Date.now() + 86400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const start = pick.label === writeLabel
    ? initial
    : pick.label === onceLabel
      ? t('once on {0}', `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())} 09:00`)
      : pick.label;
  return new Promise(resolve => {
    const box = vscode.window.createInputBox();
    box.title = t('Schedule: when? (adjust and press Enter)');
    box.value = start;
    box.ignoreFocusOut = true;
    const upd = () => {
      try {
        parseWhen(box.value);
        box.validationMessage = undefined;
        box.prompt = t('Next: {0} · e.g. "{1}", "{2}", "{3}"', preview(box.value, 3) || t('none (date in the past?)'), t('weekdays at 8:30'), t('every 2 hours'), '0 9 * * 1-5');
      } catch (e) {
        box.validationMessage = (e as Error).message;
      }
    };
    upd();
    box.onDidChangeValue(upd);
    box.onDidAccept(() => {
      if (box.validationMessage) return;
      resolve(box.value.trim());
      box.hide();
    });
    box.onDidHide(() => {
      resolve(undefined);
      box.dispose();
    });
    box.show();
  });
}

function preview(when: string, n: number): string {
  try {
    return nextRuns(parseWhen(when), new Date(), n)
      .map(d => relativeTime(d))
      .join(', ');
  } catch {
    return '';
  }
}

/** Assistente em etapas; com `base`, edita (valores atuais pré-preenchidos). */
async function wizard(ctl: Controller, base?: Schedule): Promise<Schedule | undefined> {
  const name = await vscode.window.showInputBox({ title: t('Schedule: name'), value: base?.name ?? '', ignoreFocusOut: true, validateInput: v => (v.trim() ? undefined : t('Enter a name.')) });
  if (!name) return undefined;
  const when = await askWhen(base?.when ?? '');
  if (!when) return undefined;

  const wts = (ctl.repo ? await ctl.repo.worktreesFast() : []).filter(w => w.branch && !w.prunable && !w.bare);
  const tPick = await vscode.window.showQuickPick(
    [
      { label: `$(add) ${t('New worktree from the base')}`, description: t('a new worktree on each run ({0})', 'agendado/<nome>-<data>'), tk: 'new' as const },
      { label: `$(filter) ${t('Each worktree matching a pattern…')}`, description: t('e.g. {0}', 'ai/*'), tk: 'pattern' as const },
      ...wts.map(w => ({ label: w.branch!, description: w.path, tk: 'branch' as const })),
    ],
    { title: t('Schedule: where?'), placeHolder: base ? t('current: {0}', describeTarget(base.target)) : t('worktree that receives the task') },
  );
  if (!tPick) return undefined;
  let target: Target;
  if (tPick.tk === 'new') {
    const prefix = await vscode.window.showInputBox({ title: t('New branch prefix'), value: base?.target.kind === 'new' ? base.target.prefix : 'agendado', ignoreFocusOut: true });
    if (prefix === undefined) return undefined;
    target = { kind: 'new', prefix: prefix.trim() || 'agendado' };
  } else if (tPick.tk === 'pattern') {
    const pattern = await vscode.window.showInputBox({
      title: t('Branch pattern'),
      prompt: t('* matches one segment, ** anything. E.g. {0}', 'ai/*, feature/**'),
      value: base?.target.kind === 'pattern' ? base.target.pattern : 'ai/*',
      ignoreFocusOut: true,
      validateInput: v => (v.trim() ? undefined : t('Enter a pattern.')),
    });
    if (!pattern) return undefined;
    target = { kind: 'pattern', pattern: pattern.trim() };
  } else {
    target = { kind: 'branch', branch: tPick.label };
  }

  const prompt = await vscode.window.showInputBox({
    title: t('Schedule: task for the agent'),
    prompt: t('Filled in at run time: {0}', '${date}, ${branch}, ${base}, ${repo}'),
    value: base?.prompt ?? defaultPrompt(),
    ignoreFocusOut: true,
    validateInput: v => (v.trim() ? undefined : t('Describe the task.')),
  });
  if (!prompt) return undefined;

  const list = agents(ctl);
  let agent = base?.agent ?? list[0]?.name;
  if (list.length > 1) {
    const a = await vscode.window.showQuickPick(
      list.map(x => ({ label: x.name, description: x.name === agent ? t('current') : '' })),
      { title: t('Schedule: which agent?') },
    );
    if (!a) return undefined;
    agent = a.label;
  }

  const d = await vscode.window.showQuickPick(
    [
      { label: t('Open the agent with the task'), description: t('a new terminal in the worktree'), v: 'launch' as const },
      { label: t('Add to the worktree\'s queue'), description: t('runs when the previous task is done'), v: 'queue' as const },
    ],
    { title: t('Schedule: how to deliver?'), placeHolder: base ? t('current: {0}', base.delivery === 'queue' ? t('queue') : t('open now')) : undefined },
  );
  if (!d) return undefined;

  const conds = await vscode.window.showQuickPick(
    [
      { label: t('Only if the worktree is clean'), k: 'onlyClean' as const, picked: base ? !!base.conditions.onlyClean : target.kind !== 'new' },
      { label: t('Only if the base moved since the last run'), k: 'onlyIfBaseMoved' as const, picked: !!base?.conditions.onlyIfBaseMoved },
      { label: t('Skip if an agent is already open in the worktree'), k: 'skipIfAgentOpen' as const, picked: base ? !!base.conditions.skipIfAgentOpen : true },
    ],
    { title: t('Schedule: conditions (optional)'), canPickMany: true },
  );
  if (!conds) return undefined;

  const missed = await vscode.window.showQuickPick(
    [
      { label: t('Run once on open'), description: t('if the time passed while VS Code was closed'), v: 'run' as const },
      { label: t('Skip'), description: t('waits for the next time'), v: 'skip' as const },
    ],
    { title: t('Schedule: missed time?') },
  );
  if (!missed) return undefined;

  const scope = await vscode.window.showQuickPick(
    [
      { label: t('Just for me'), description: t('saved in this machine\'s VS Code'), v: 'local' as const },
      { label: t('Share with the team'), description: t('writes {0} in the repository (commit it)', '.agentyard/schedules.json'), v: 'shared' as const },
    ],
    { title: t('Schedule: where to save?'), placeHolder: base ? t('current: {0}', base.scope === 'shared' ? t('shared') : t('just for me')) : undefined },
  );
  if (!scope) return undefined;

  return {
    id: base?.id ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: name.trim(),
    when,
    target,
    prompt,
    agent,
    delivery: d.v,
    conditions: Object.fromEntries(conds.map(c => [c.k, true])),
    missed: missed.v,
    enabled: base?.enabled ?? true,
    scope: scope.v,
    createdAt: base?.createdAt ?? Date.now(),
  };
}

export function registerSchedule(ctx: vscode.ExtensionContext, ctl: Controller, agentTerms: AgentTerminals, tasks: TaskQueue): Scheduler {
  const sch = new Scheduler(ctl, agentTerms, tasks);
  const view = vscode.window.createTreeView('worktreeGraph.schedules', { treeDataProvider: new SchedulesProvider(sch) });
  ctx.subscriptions.push(sch, view);

  const of = (arg: ScheduleItem | Schedule | string | undefined) =>
    typeof arg === 'string' ? sch.get(arg) : arg && 'schedule' in arg ? arg.schedule : (arg as Schedule | undefined);
  const pick = async (arg: any, title: string) => {
    const s = of(arg);
    if (s) return s;
    const p = await vscode.window.showQuickPick(
      sch.list().map(x => ({ label: x.name, description: x.when, s: x })),
      { title },
    );
    return p?.s;
  };
  const reg = (id: string, fn: (...a: any[]) => unknown) =>
    ctx.subscriptions.push(
      vscode.commands.registerCommand(`worktreeGraph.schedules.${id}`, async (...a: any[]) => {
        try {
          await fn(...a);
        } catch (e) {
          vscode.window.showErrorMessage(`AgentYard: ${(e as Error).message}`);
        }
      }),
    );

  reg('new', async () => {
    if (!ctl.repo) return vscode.window.showWarningMessage(t('Open a git repository to schedule tasks.'));
    const s = await wizard(ctl);
    if (!s) return;
    await sch.save(s);
    const next = sch.next(s);
    vscode.window.showInformationMessage(next ? t('Schedule "{0}" created; next: {1}.', s.name, relativeTime(next)) : t('Schedule "{0}" created.', s.name));
  });
  reg('edit', async (arg?: any) => {
    const cur = await pick(arg, t('Edit which schedule?'));
    if (!cur) return;
    const s = await wizard(ctl, cur);
    if (s) await sch.save(s);
  });
  reg('duplicate', async (arg?: any) => {
    const cur = await pick(arg, t('Duplicate which schedule?'));
    if (!cur) return;
    await sch.save({ ...cur, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: t('{0} (copy)', cur.name), enabled: false, createdAt: Date.now() });
  });
  reg('toggle', async (arg?: any) => {
    const cur = await pick(arg, t('Pause or resume which schedule?'));
    if (!cur) return;
    // ao retomar, conta a partir de agora: não dispara o que "perdeu" enquanto estava pausado
    await sch.save({ ...cur, enabled: !cur.enabled, createdAt: cur.enabled ? cur.createdAt : Date.now() });
  });
  reg('runNow', async (arg?: any) => {
    const cur = await pick(arg, t('Run which schedule now?'));
    if (!cur) return;
    const res = await sch.run(cur, { manual: true });
    const ok = res.filter(r => r.result === 'ok').length;
    const skipped = res.filter(r => r.result !== 'ok');
    const details = skipped.map(r => `${r.target}: ${r.message}`).join('; ');
    vscode.window.showInformationMessage(
      skipped.length
        ? t('"{0}": {1} delivered; {2} not ({3}).', cur.name, ok, skipped.length, details)
        : t('"{0}": {1} delivered.', cur.name, ok),
    );
  });
  reg('history', async (arg?: any) => {
    const cur = of(arg);
    const list = sch.history().filter(h => !cur || h.scheduleId === cur.id);
    if (!list.length) return vscode.window.showInformationMessage(t('No runs recorded yet.'));
    const icon = { ok: '$(check)', skipped: '$(debug-step-over)', error: '$(error)' } as const;
    await vscode.window.showQuickPick(
      list.map(h => ({ label: `${icon[h.result]} ${h.name} → ${h.target}`, description: new Date(h.at).toLocaleString(locale()), detail: h.message })),
      { title: cur ? t('History: {0}', cur.name) : t('Schedule history'), matchOnDetail: true },
    );
  });
  reg('delete', async (arg?: any) => {
    const cur = await pick(arg, t('Delete which schedule?'));
    if (!cur) return;
    const del = t('Delete');
    const ok = await vscode.window.showWarningMessage(t('Delete schedule "{0}"?', cur.name), { modal: true }, del);
    if (ok === del) await sch.remove(cur.id);
  });
  reg('refresh', () => sch.start());
  return sch;
}
