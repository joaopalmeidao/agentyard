import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentHookEvent, agents, AgentTerminals, newAgentId, OpenAgent, promptArgument, promptCommandOf } from '../agents';
import { isClaudeCommand } from '../claude/hooks';
import { totalTokens } from '../claude/sessions';
import type { ClaudeService } from '../claude/view';
import type { Controller } from '../controller';
import { t } from '../i18n';
import {
  checklistDone,
  emptyMilestone,
  gateEnvFile,
  initialProgress,
  lastProgress,
  Milestone,
  milestonePrompt,
  MilestoneRuntime,
  nextMilestone,
  parseGate,
  parsePlan,
  planningPrompt,
  ProjectConfig,
  projectPaths,
  ProjectRuntime,
  PROJECTS_DIR,
  renderContext,
  slugOf,
} from './core';

const keyOf = (p: string) => path.normalize(p).toLowerCase();

/** Um projeto encontrado numa worktree. */
export interface LongProject {
  key: string;
  slug: string;
  worktree: string;
  branch?: string;
  config: ProjectConfig;
  plan: Milestone[];
  rt: ProjectRuntime;
  paths: ReturnType<typeof projectPaths>;
}

const TICK_MS = 60_000;
/** Espera máxima pelo resultado do portão depois do Stop (a verificação pode demorar). */
const GATE_WAIT_MS = 30 * 60_000;

function read(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function mtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Projetos longos: cada marco numa sessão nova do Claude, com a memória do projeto injetada pelo
 * SessionStart e o portão no Stop. Quando o portão passa, o marco fica feito e o próximo começa
 * (ou espera revisão); bloqueio, desistência do portão, tempo e sessões demais pausam o projeto.
 */
export class LongProjects implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.changed];
  /** Terminais que a própria extensão fechou (não é "terminal fechado" que pausa). */
  private readonly closing = new Set<vscode.Terminal>();
  /** Terminal → projeto e id: ao fechar, o AgentTerminals já tirou o terminal da lista dele. */
  private readonly terminals = new Map<vscode.Terminal, { key: string; id: string }>();
  private readonly waitingGate = new Set<string>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly ctl: Controller, private readonly agentTerms: AgentTerminals, private readonly claude?: ClaudeService) {
    this.disposables.push(
      agentTerms.onDidHookEvent(e => void this.onHook(e)),
      vscode.window.onDidCloseTerminal(term => void this.onClosed(term)),
      ctl.onDidChange(s => s && s.pending === 0 && this.changed.fire()),
    );
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  private cfg() {
    return this.ctl.cfg();
  }

  // ---------- estado ----------

  private storeKey() {
    return `longProjects:${this.ctl.repo?.commonDir.toLowerCase() ?? ''}`;
  }

  private runtimes(): Record<string, ProjectRuntime> {
    return this.ctl.ctx.workspaceState.get<Record<string, ProjectRuntime>>(this.storeKey(), {});
  }

  private async saveRuntime(key: string, rt: ProjectRuntime) {
    await this.ctl.ctx.workspaceState.update(this.storeKey(), { ...this.runtimes(), [key]: rt });
    this.changed.fire();
  }

  /** Projetos das worktrees do repositório ativo (só os da branch que os criou). */
  list(): LongProject[] {
    const out: LongProject[] = [];
    const rts = this.runtimes();
    for (const w of this.ctl.state?.worktrees ?? []) {
      if (w.prunable || w.bare) continue;
      let slugs: string[] = [];
      try {
        slugs = fs.readdirSync(path.join(w.path, PROJECTS_DIR));
      } catch {
        continue;
      }
      for (const slug of slugs) {
        const p = this.load(w.path, w.branch, slug, rts);
        if (p) out.push(p);
      }
    }
    return out.sort((a, b) => b.config.created - a.config.created);
  }

  private load(worktree: string, branch: string | undefined, slug: string, rts = this.runtimes()): LongProject | undefined {
    const paths = projectPaths(worktree, slug);
    let config: ProjectConfig;
    try {
      config = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
    } catch {
      return undefined;
    }
    if (!config?.title || (config.branch && branch && config.branch !== branch)) return undefined;
    const key = `${keyOf(worktree)}|${slug}`;
    const rt: ProjectRuntime = rts[key] ?? { status: fs.existsSync(paths.plan) ? 'planned' : 'planning', milestones: {} };
    return { key, slug, worktree, branch, config, plan: parsePlan(read(paths.plan)), rt, paths };
  }

  get(key: string): LongProject | undefined {
    return this.list().find(p => p.key === key);
  }

  private byTerminal(o: OpenAgent): LongProject | undefined {
    if (!o.project) return undefined;
    const p = this.get(o.project);
    return p && p.rt.terminalId === o.id ? p : undefined;
  }

  terminalOf(p: LongProject): OpenAgent | undefined {
    return this.agentTerms.list().find(o => o.id === p.rt.terminalId);
  }

  milestoneRt(p: LongProject, id: string): MilestoneRuntime {
    return (p.rt.milestones[id] ??= emptyMilestone());
  }

  /** Tokens das sessões de um marco (das sessões já lidas pelo ClaudeService). */
  tokensOf(m: MilestoneRuntime): number {
    if (!this.claude || !m.sessionIds.length) return 0;
    const ids = new Set(m.sessionIds);
    return this.claude.sessions.filter(s => ids.has(s.id)).reduce((sum, s) => sum + totalTokens(s.usage), 0);
  }

  /** Projetos que pedem atenção (plano pronto, revisão, pausado, bloqueado). */
  needsAttention(): number {
    return this.list().filter(p => ['planned', 'review', 'paused', 'blocked'].includes(p.rt.status)).length;
  }

  // ---------- criar e planejar ----------

  async create(worktree: string, branch: string | undefined, config: ProjectConfig): Promise<LongProject> {
    let slug = slugOf(config.title);
    for (let n = 2; fs.existsSync(projectPaths(worktree, slug).dir); n++) slug = `${slug.replace(/-\d+$/, '')}-${n}`;
    const paths = projectPaths(worktree, slug);
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.config, JSON.stringify(config, null, 2) + '\n', 'utf8');
    fs.writeFileSync(paths.progress, initialProgress(config), 'utf8');
    const key = `${keyOf(worktree)}|${slug}`;
    await this.saveRuntime(key, { status: 'planning', milestones: {} });
    const p = this.load(worktree, branch, slug)!;
    await this.openSession(p, planningPrompt(config, paths.rel), undefined);
    return p;
  }

  /** Abre o Claude para (re)planejar. */
  async replan(p: LongProject) {
    p.rt.status = 'planning';
    p.rt.reason = undefined;
    await this.saveRuntime(p.key, p.rt);
    await this.openSession(p, planningPrompt(p.config, p.paths.rel), undefined);
  }

  // ---------- sessões ----------

  private claudeAgent() {
    return agents(this.ctl).find(a => isClaudeCommand(a.command));
  }

  /** Grava o que o hook SessionStart injeta (chamado na abertura, a cada Stop e antes de compactar). */
  writeContext(p: LongProject, terminalId = p.rt.terminalId) {
    if (!terminalId) return;
    const m = p.rt.current ? p.plan.find(x => x.id === p.rt.current) : undefined;
    const text = renderContext({
      config: p.config,
      rel: p.paths.rel,
      status: p.rt.status,
      milestone: m,
      milestones: p.plan,
      progress: lastProgress(read(p.paths.progress)),
    });
    fs.writeFileSync(path.join(this.agentTerms.eventsDir(), `${terminalId}.context.md`), text, 'utf8');
  }

  /**
   * Abre uma sessão nova do Claude para o projeto (planejamento sem portão; marco com portão).
   * A sessão anterior do projeto, se ainda aberta, é fechada: a memória está nos arquivos.
   */
  private async openSession(p: LongProject, prompt: string, milestone: Milestone | undefined) {
    const agent = this.claudeAgent();
    if (!agent) throw new Error(t('Long-running projects need Claude Code in worktreeGraph.agents.'));
    if (!this.cfg().get<boolean>('claude.trackState', true)) throw new Error(t('Long-running projects need worktreeGraph.claude.trackState turned on (they use the Claude Code hooks).'));
    const old = this.terminalOf(p);
    const id = newAgentId();
    const dir = this.agentTerms.eventsDir();
    fs.mkdirSync(dir, { recursive: true });
    p.rt.terminalId = id;
    this.writeContext(p, id);
    fs.writeFileSync(
      path.join(dir, `${id}.project`),
      gateEnvFile({
        projectDir: p.paths.dir,
        worktree: p.worktree,
        milestone: milestone?.id ?? '',
        verify: p.config.verify,
        gate: !!milestone && p.config.gate,
        maxRetries: this.cfg().get<number>('longProjects.gateRetries', 3),
      }),
      'utf8',
    );
    // início do turno: o PROGRESS.md precisa ser mais novo que isto para o portão liberar
    fs.writeFileSync(path.join(dir, `${id}.turn`), '', 'utf8');
    await this.saveRuntime(p.key, p.rt);
    const arg = promptArgument(prompt);
    const command = promptCommandOf(agent).replace(/\{prompt\}/g, () => arg.arg).trim();
    const where = p.branch ?? path.basename(p.worktree);
    const name = milestone ? `${agent.name} · ${where} · ${milestone.id}` : `${agent.name} · ${where} · ${t('plan')}`;
    const o = await this.agentTerms.start(p.worktree, p.branch, agent.name, command, { task: true, prompt, id, project: p.key, name });
    this.terminals.set(o.terminal, { key: p.key, id });
    if (old) {
      this.closing.add(old.terminal);
      old.terminal.dispose();
    }
    this.ctl.log(t('Long-running project {0}: session {1} opened ({2}).', p.config.title, id, milestone ? milestone.id : t('plan')));
  }

  /** Começa (ou continua) o próximo marco numa sessão nova. */
  async startNext(p: LongProject, force = false): Promise<boolean> {
    p = this.get(p.key) ?? p;
    if (!p.plan.length) {
      vscode.window.showWarningMessage(t('{0}: PLAN.md has no milestones yet (headings like "## [M1] Title").', p.config.title));
      return false;
    }
    const m = nextMilestone(p.plan, p.rt);
    if (!m) {
      await this.finishProject(p);
      return false;
    }
    if (!force && this.ctl.taskBlocked?.(p.worktree)) {
      await this.pause(p, t('the worktree budget ran out'));
      return false;
    }
    const mr = this.milestoneRt(p, m.id);
    const maxSessions = this.cfg().get<number>('longProjects.maxSessionsPerMilestone', 3);
    if (!force && maxSessions > 0 && mr.sessions >= maxSessions) {
      mr.status = 'stuck';
      await this.pause(p, t('milestone [{0}] already had {1} sessions without finishing', m.id, mr.sessions));
      return false;
    }
    try {
      fs.unlinkSync(p.paths.blocked);
    } catch {
      // não havia bloqueio
    }
    const resumed = mr.sessions > 0;
    mr.status = 'active';
    mr.started ??= Date.now();
    mr.sessions++;
    mr.overtime = false;
    p.rt.current = m.id;
    p.rt.status = 'running';
    p.rt.reason = undefined;
    await this.openSession(p, milestonePrompt(p.config, p.paths.rel, m, resumed), m);
    return true;
  }

  async pause(p: LongProject, reason: string, notify = true) {
    p.rt.status = 'paused';
    p.rt.reason = reason;
    await this.saveRuntime(p.key, p.rt);
    this.ctl.log(t('Long-running project {0} paused: {1}', p.config.title, reason));
    if (notify) void this.alert(p, t('{0} paused: {1}.', p.config.title, reason), 'warning');
  }

  /** Pausa pelo usuário: o terminal continua aberto, só não avança sozinho. */
  async pauseByUser(p: LongProject) {
    await this.pause(p, t('paused by you'), false);
  }

  async markMilestoneDone(p: LongProject, id: string) {
    const mr = this.milestoneRt(p, id);
    mr.status = 'done';
    mr.finished = Date.now();
    await this.saveRuntime(p.key, p.rt);
  }

  /** Volta o marco para "pendente", zerando sessões e bloqueios do portão (para tentar de novo). */
  async resetMilestone(p: LongProject, id: string) {
    p.rt.milestones[id] = emptyMilestone();
    await this.saveRuntime(p.key, p.rt);
  }

  private async finishProject(p: LongProject) {
    p.rt.status = 'done';
    p.rt.current = undefined;
    p.rt.reason = undefined;
    await this.saveRuntime(p.key, p.rt);
    void this.alert(p, t('{0}: all {1} milestones are done.', p.config.title, p.plan.length), 'info');
  }

  // ---------- eventos dos hooks ----------

  private async onHook({ open, event }: AgentHookEvent) {
    const p = this.byTerminal(open);
    if (!p) return;
    this.terminals.set(open.terminal, { key: p.key, id: open.id });
    const name = event.hook_event_name;
    if (name === 'SessionStart' && event.session_id && p.rt.current) {
      const mr = this.milestoneRt(p, p.rt.current);
      if (!mr.sessionIds.includes(event.session_id)) {
        mr.sessionIds.push(event.session_id);
        await this.saveRuntime(p.key, p.rt);
      }
    }
    if (name === 'PreCompact') this.writeContext(p);
    if (name !== 'Stop') return;
    this.writeContext(p);
    if (p.rt.status === 'planning') return this.onPlanningStop(p);
    if (p.rt.status === 'running' && p.rt.current) return this.onMilestoneStop(p, open, Date.now());
  }

  private async onPlanningStop(p: LongProject) {
    const m = mtime(p.paths.plan);
    if (!p.plan.length || m === p.rt.planNotified) return;
    p.rt.planNotified = m;
    await this.saveRuntime(p.key, p.rt);
    const start = t('Start milestone [{0}]', p.plan[0].id);
    const open = t('Open plan');
    const pick = await vscode.window.showInformationMessage(
      t('{0}: plan ready with {1} milestones. Review it and start when it looks right (you can keep talking to the agent to adjust it).', p.config.title, p.plan.length),
      start,
      open,
    );
    if (pick === open) await vscode.window.showTextDocument(vscode.Uri.file(p.paths.plan));
    if (pick === start) {
      const cur = this.get(p.key);
      if (cur) await this.startNext(cur);
    }
  }

  /** Espera o portão terminar de rodar (ele roda ao mesmo tempo que o hook dos eventos). */
  private async waitGate(terminalId: string, since: number) {
    const file = path.join(this.agentTerms.eventsDir(), `${terminalId}.gate`);
    if (!since) {
      // reavaliação (retomada): só o resultado que já está lá
      const g = parseGate(read(file));
      return g && g.kind !== 'running' ? g : undefined;
    }
    const until = Date.now() + GATE_WAIT_MS;
    await new Promise(r => setTimeout(r, 800));
    while (Date.now() < until) {
      if (mtime(file) >= since - 1500) {
        const g = parseGate(read(file));
        if (g && g.kind !== 'running') return g;
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    return undefined;
  }

  private async onMilestoneStop(p: LongProject, open: OpenAgent, at: number) {
    if (this.waitingGate.has(open.id)) return;
    this.waitingGate.add(open.id);
    let g;
    try {
      g = p.config.gate ? await this.waitGate(open.id, at) : { kind: 'pass' as const };
    } finally {
      this.waitingGate.delete(open.id);
    }
    const cur = this.get(p.key);
    if (!cur || cur.rt.terminalId !== open.id || cur.rt.status !== 'running' || !cur.rt.current) return;
    const id = cur.rt.current;
    const mr = this.milestoneRt(cur, id);
    const m = cur.plan.find(x => x.id === id);
    if (!g) return;
    mr.lastGate = g.kind === 'fail' ? `fail ${g.why}` : g.kind;
    if (g.kind === 'fail') {
      if (at) mr.gateBlocks++;
      await this.saveRuntime(cur.key, cur.rt);
      return; // o Claude recebeu o motivo e continua
    }
    if (g.kind === 'blocked') {
      mr.status = 'blocked';
      cur.rt.status = 'blocked';
      const why = read(cur.paths.blocked).replace(/^#.*\n/, '').trim().split(/\r?\n/)[0] ?? '';
      cur.rt.reason = why || t('the agent needs a person');
      await this.saveRuntime(cur.key, cur.rt);
      void this.alert(cur, t('{0}: milestone [{1}] is blocked: {2}', cur.config.title, id, cur.rt.reason), 'warning');
      return;
    }
    if (g.kind === 'giveup') {
      mr.status = 'stuck';
      await this.pause(cur, t('the gate blocked milestone [{0}] {1} times in a row (last: {2})', id, mr.gateBlocks, mr.lastGate ?? '?'));
      return;
    }
    // pass: portão liberou; confere o checklist de novo (o portão pode estar desligado)
    if (m && m.items.length && !checklistDone(m)) {
      await this.saveRuntime(cur.key, cur.rt);
      return;
    }
    mr.status = 'done';
    mr.finished = Date.now();
    await this.saveRuntime(cur.key, cur.rt);
    this.ctl.log(t('Long-running project {0}: milestone [{1}] done.', cur.config.title, id));
    const next = nextMilestone(cur.plan, cur.rt);
    if (!next) return this.finishProject(cur);
    if (cur.config.review === 'milestone') {
      cur.rt.status = 'review';
      cur.rt.reason = undefined;
      await this.saveRuntime(cur.key, cur.rt);
      return this.askReview(cur, id, next);
    }
    await this.startNext(cur);
  }

  private async askReview(p: LongProject, doneId: string, next: Milestone) {
    const go = t('Start [{0}]', next.id);
    const review = t('Review changes');
    const pick = await vscode.window.showInformationMessage(t('{0}: milestone [{1}] done. Review it before the next one?', p.config.title, doneId), go, review);
    if (pick === review && p.branch) await vscode.commands.executeCommand('worktreeGraph.openReview', { path: p.worktree, branch: p.branch });
    if (pick === go) {
      const cur = this.get(p.key);
      if (cur) await this.startNext(cur);
    }
  }

  private async onClosed(term: vscode.Terminal) {
    const known = this.terminals.get(term);
    this.terminals.delete(term);
    if (this.closing.delete(term) || !known) return;
    const p = this.get(known.key);
    if (!p || p.rt.terminalId !== known.id || p.rt.status !== 'running') return;
    await this.pause(p, t('the terminal of milestone [{0}] was closed', p.rt.current ?? '?'), false);
  }

  /** Marco rodando há mais que `longProjects.milestoneMinutes`: avisa uma vez. */
  private async tick() {
    const limit = this.cfg().get<number>('longProjects.milestoneMinutes', 120);
    if (!(limit > 0)) return;
    for (const p of this.list()) {
      if (p.rt.status !== 'running' || !p.rt.current) continue;
      const mr = this.milestoneRt(p, p.rt.current);
      if (mr.overtime || !mr.started || Date.now() - mr.started < limit * 60_000) continue;
      mr.overtime = true;
      await this.saveRuntime(p.key, p.rt);
      void this.alert(p, t('{0}: milestone [{1}] has been running for more than {2} min.', p.config.title, p.rt.current, limit), 'warning');
    }
  }

  private async alert(p: LongProject, msg: string, level: 'info' | 'warning') {
    const show = t('Show terminal');
    const openPlan = t('Open plan');
    const actions = this.terminalOf(p) ? [show, openPlan] : [openPlan];
    const pick = await (level === 'warning' ? vscode.window.showWarningMessage(msg, ...actions) : vscode.window.showInformationMessage(msg, ...actions));
    if (pick === show) this.terminalOf(p)?.terminal.show();
    if (pick === openPlan) await vscode.window.showTextDocument(vscode.Uri.file(p.paths.plan));
  }

  /** Continua depois de bloqueio/pausa: com o terminal aberto e bloqueio, só volta a acompanhar. */
  async resume(p: LongProject) {
    if (p.rt.status === 'planning' || p.rt.status === 'planned') return this.startNext(p, true);
    const open = this.terminalOf(p);
    // pausado com a sessão do marco ainda aberta: volta a acompanhar em vez de abrir outra
    if (p.rt.status === 'paused' && open && p.rt.current && this.milestoneRt(p, p.rt.current).status === 'active') {
      p.rt.status = 'running';
      p.rt.reason = undefined;
      await this.saveRuntime(p.key, p.rt);
      // se ela já parou enquanto estava pausado, avalia o último resultado do portão
      if (open.state === 'idle') void this.onMilestoneStop(p, open, 0);
      return true;
    }
    if (p.rt.status === 'blocked' && this.terminalOf(p)) {
      try {
        fs.unlinkSync(p.paths.blocked);
      } catch {
        // já apagado
      }
      p.rt.status = 'running';
      p.rt.reason = undefined;
      if (p.rt.current) this.milestoneRt(p, p.rt.current).status = 'active';
      await this.saveRuntime(p.key, p.rt);
      const o = this.terminalOf(p)!;
      o.terminal.show();
      vscode.window.showInformationMessage(t('Answer the agent in the terminal; the milestone continues from there.'));
      return true;
    }
    return this.startNext(p, true);
  }

  async forget(p: LongProject) {
    const all = this.runtimes();
    delete all[p.key];
    await this.ctl.ctx.workspaceState.update(this.storeKey(), all);
    this.changed.fire();
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.disposables.forEach(d => d.dispose());
  }
}
