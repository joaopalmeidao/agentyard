import * as vscode from 'vscode';
import { agents } from '../agents';
import type { AgentTerminals } from '../agents';
import type { TaskQueue } from '../agentFlow/tasks';
import type { Controller } from '../controller';
import { describeTarget, nextRuns, parseWhen, relativeTime, Schedule, Target } from './core';
import { Scheduler } from './service';

const DEFAULT_PROMPT = 'Tarefa agendada em ${date} na branch ${branch} (base ${base}): ';

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
    this.description = !valid ? '⚠ quando inválido' : !schedule.enabled ? 'pausado' : next ? relativeTime(next, new Date(sch.now())) : 'sem próximo horário';
    this.iconPath = new vscode.ThemeIcon(!valid ? 'warning' : schedule.enabled ? 'clock' : 'debug-pause');
    const rt = sch.runtime(schedule.id);
    const last = sch.history().find(h => h.scheduleId === schedule.id);
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${schedule.name}**${schedule.scope === 'shared' ? ' — compartilhado (.agentyard/schedules.json)' : ''}\n\n`);
    md.appendMarkdown(`Quando: \`${schedule.when}\`\n\n`);
    md.appendMarkdown(`Alvo: ${describeTarget(schedule.target)} · ${schedule.delivery === 'queue' ? 'entra na fila' : 'abre o agente'}${schedule.agent ? ` (${schedule.agent})` : ''}\n\n`);
    const conds = [schedule.conditions.onlyClean ? 'só worktree limpa' : '', schedule.conditions.onlyIfBaseMoved ? 'só se a base andou' : '', schedule.conditions.skipIfAgentOpen ? 'pula se já há agente' : '']
      .filter(Boolean)
      .join(', ');
    if (conds) md.appendMarkdown(`Condições: ${conds}\n\n`);
    if (rt.lastRun) md.appendMarkdown(`Última execução: ${new Date(rt.lastRun).toLocaleString('pt-BR')}${last ? ` — ${last.result}: ${last.message}` : ''}\n\n`);
    md.appendMarkdown(`Tarefa:\n\n> ${schedule.prompt.replace(/\n/g, '\n> ')}`);
    this.tooltip = md;
    this.command = { command: 'worktreeGraph.schedules.edit', title: 'Editar', arguments: [this] };
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

const PRESETS = ['todo dia às 09:00', 'dias úteis às 09:00', 'toda segunda às 09:00', 'a cada 2 h', 'a cada 30 min', 'de hora em hora'];

/** "Quando", com os próximos 3 horários aparecendo enquanto se digita. */
async function askWhen(initial: string): Promise<string | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      ...PRESETS.map(p => ({ label: p, description: preview(p, 1) })),
      { label: 'uma vez em…', description: 'numa data e hora' },
      { label: 'Escrever (atalho ou cron de 5 campos)…', description: initial && !PRESETS.includes(initial) ? `atual: ${initial}` : '' },
    ],
    { title: 'Agendamento: quando?', placeHolder: initial ? `atual: ${initial}` : 'escolha um modelo; dá para ajustar o horário em seguida' },
  );
  if (!pick) return undefined;
  const tomorrow = new Date(Date.now() + 86400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const start = pick.label.startsWith('Escrever')
    ? initial
    : pick.label === 'uma vez em…'
      ? `uma vez em ${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())} 09:00`
      : pick.label;
  return new Promise(resolve => {
    const box = vscode.window.createInputBox();
    box.title = 'Agendamento: quando? (ajuste e Enter)';
    box.value = start;
    box.ignoreFocusOut = true;
    const upd = () => {
      try {
        parseWhen(box.value);
        box.validationMessage = undefined;
        box.prompt = `Próximos: ${preview(box.value, 3) || 'nenhum (data no passado?)'} · ex.: "dias úteis às 8h30", "a cada 2 h", "0 9 * * 1-5"`;
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
  const name = await vscode.window.showInputBox({ title: 'Agendamento: nome', value: base?.name ?? '', ignoreFocusOut: true, validateInput: v => (v.trim() ? undefined : 'Informe um nome.') });
  if (!name) return undefined;
  const when = await askWhen(base?.when ?? '');
  if (!when) return undefined;

  const wts = (ctl.repo ? await ctl.repo.worktreesFast() : []).filter(w => w.branch && !w.prunable && !w.bare);
  const tPick = await vscode.window.showQuickPick(
    [
      { label: '$(add) Nova worktree a partir da base', description: 'uma worktree nova a cada execução (agendado/<nome>-<data>)', t: 'new' as const },
      { label: '$(filter) Cada worktree que casar com um padrão…', description: 'ex.: ai/*', t: 'pattern' as const },
      ...wts.map(w => ({ label: w.branch!, description: w.path, t: 'branch' as const })),
    ],
    { title: 'Agendamento: onde?', placeHolder: base ? `atual: ${describeTarget(base.target)}` : 'worktree que recebe a tarefa' },
  );
  if (!tPick) return undefined;
  let target: Target;
  if (tPick.t === 'new') {
    const prefix = await vscode.window.showInputBox({ title: 'Prefixo da branch nova', value: base?.target.kind === 'new' ? base.target.prefix : 'agendado', ignoreFocusOut: true });
    if (prefix === undefined) return undefined;
    target = { kind: 'new', prefix: prefix.trim() || 'agendado' };
  } else if (tPick.t === 'pattern') {
    const pattern = await vscode.window.showInputBox({
      title: 'Padrão das branches',
      prompt: '* casa um segmento, ** qualquer coisa. Ex.: ai/*, feature/**',
      value: base?.target.kind === 'pattern' ? base.target.pattern : 'ai/*',
      ignoreFocusOut: true,
      validateInput: v => (v.trim() ? undefined : 'Informe um padrão.'),
    });
    if (!pattern) return undefined;
    target = { kind: 'pattern', pattern: pattern.trim() };
  } else {
    target = { kind: 'branch', branch: tPick.label };
  }

  const prompt = await vscode.window.showInputBox({
    title: 'Agendamento: tarefa para o agente',
    prompt: 'Valores trocados na hora: ${date}, ${branch}, ${base}, ${repo}',
    value: base?.prompt ?? DEFAULT_PROMPT,
    ignoreFocusOut: true,
    validateInput: v => (v.trim() ? undefined : 'Descreva a tarefa.'),
  });
  if (!prompt) return undefined;

  const list = agents(ctl);
  let agent = base?.agent ?? list[0]?.name;
  if (list.length > 1) {
    const a = await vscode.window.showQuickPick(
      list.map(x => ({ label: x.name, description: x.name === agent ? 'atual' : '' })),
      { title: 'Agendamento: qual agente?' },
    );
    if (!a) return undefined;
    agent = a.label;
  }

  const d = await vscode.window.showQuickPick(
    [
      { label: 'Abrir o agente com a tarefa', description: 'um terminal novo na worktree', v: 'launch' as const },
      { label: 'Colocar na fila da worktree', description: 'roda quando a tarefa anterior ficar pronta', v: 'queue' as const },
    ],
    { title: 'Agendamento: como entregar?', placeHolder: base ? `atual: ${base.delivery === 'queue' ? 'fila' : 'abrir agora'}` : undefined },
  );
  if (!d) return undefined;

  const conds = await vscode.window.showQuickPick(
    [
      { label: 'Só se a worktree estiver limpa', k: 'onlyClean' as const, picked: base ? !!base.conditions.onlyClean : target.kind !== 'new' },
      { label: 'Só se a base andou desde a última execução', k: 'onlyIfBaseMoved' as const, picked: !!base?.conditions.onlyIfBaseMoved },
      { label: 'Pular se já houver um agente aberto na worktree', k: 'skipIfAgentOpen' as const, picked: base ? !!base.conditions.skipIfAgentOpen : true },
    ],
    { title: 'Agendamento: condições (opcionais)', canPickMany: true },
  );
  if (!conds) return undefined;

  const missed = await vscode.window.showQuickPick(
    [
      { label: 'Executar uma vez ao abrir', description: 'se o horário passou com o VS Code fechado', v: 'run' as const },
      { label: 'Pular', description: 'espera o próximo horário', v: 'skip' as const },
    ],
    { title: 'Agendamento: horário perdido?' },
  );
  if (!missed) return undefined;

  const scope = await vscode.window.showQuickPick(
    [
      { label: 'Só para mim', description: 'guardado no VS Code desta máquina', v: 'local' as const },
      { label: 'Compartilhar com o time', description: 'grava em .agentyard/schedules.json no repositório (faça commit)', v: 'shared' as const },
    ],
    { title: 'Agendamento: onde guardar?', placeHolder: base ? `atual: ${base.scope === 'shared' ? 'compartilhado' : 'só para mim'}` : undefined },
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
    if (!ctl.repo) return vscode.window.showWarningMessage('Abra um repositório git para agendar tarefas.');
    const s = await wizard(ctl);
    if (!s) return;
    await sch.save(s);
    const next = sch.next(s);
    vscode.window.showInformationMessage(`Agendamento "${s.name}" criado${next ? `; próximo: ${relativeTime(next)}` : ''}.`);
  });
  reg('edit', async (arg?: any) => {
    const cur = await pick(arg, 'Editar qual agendamento?');
    if (!cur) return;
    const s = await wizard(ctl, cur);
    if (s) await sch.save(s);
  });
  reg('duplicate', async (arg?: any) => {
    const cur = await pick(arg, 'Duplicar qual agendamento?');
    if (!cur) return;
    await sch.save({ ...cur, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: `${cur.name} (cópia)`, enabled: false, createdAt: Date.now() });
  });
  reg('toggle', async (arg?: any) => {
    const cur = await pick(arg, 'Pausar ou retomar qual agendamento?');
    if (!cur) return;
    // ao retomar, conta a partir de agora: não dispara o que "perdeu" enquanto estava pausado
    await sch.save({ ...cur, enabled: !cur.enabled, createdAt: cur.enabled ? cur.createdAt : Date.now() });
  });
  reg('runNow', async (arg?: any) => {
    const cur = await pick(arg, 'Executar qual agendamento agora?');
    if (!cur) return;
    const res = await sch.run(cur, { manual: true });
    const ok = res.filter(r => r.result === 'ok').length;
    const skipped = res.filter(r => r.result !== 'ok');
    vscode.window.showInformationMessage(
      `"${cur.name}": ${ok} entregue(s)${skipped.length ? `; ${skipped.length} não (${skipped.map(r => `${r.target}: ${r.message}`).join('; ')})` : ''}.`,
    );
  });
  reg('history', async (arg?: any) => {
    const cur = of(arg);
    const list = sch.history().filter(h => !cur || h.scheduleId === cur.id);
    if (!list.length) return vscode.window.showInformationMessage('Nenhuma execução registrada ainda.');
    const icon = { ok: '$(check)', skipped: '$(debug-step-over)', error: '$(error)' } as const;
    await vscode.window.showQuickPick(
      list.map(h => ({ label: `${icon[h.result]} ${h.name} → ${h.target}`, description: new Date(h.at).toLocaleString('pt-BR'), detail: h.message })),
      { title: cur ? `Histórico: ${cur.name}` : 'Histórico dos agendamentos', matchOnDetail: true },
    );
  });
  reg('delete', async (arg?: any) => {
    const cur = await pick(arg, 'Excluir qual agendamento?');
    if (!cur) return;
    const ok = await vscode.window.showWarningMessage(`Excluir o agendamento "${cur.name}"?`, { modal: true }, 'Excluir');
    if (ok) await sch.remove(cur.id);
  });
  reg('refresh', () => sch.start());
  return sch;
}
