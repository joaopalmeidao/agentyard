import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { createWorktree } from '../actions';
import type { AgentTerminals } from '../agents';
import type { Controller } from '../controller';
import { branchMatches } from '../git';
import { t } from '../i18n';
import { describeTarget, missedSince, newBranchName, nextRun, parseWhen, renderTemplate, RunRecord, Schedule } from './core';

const LOCK_FILE = 'agentyard-schedule.lock';
const LOCK_STALE_MS = 5 * 60_000;
/** Horário que passou há mais que isto conta como "perdido" (VS Code fechado ou máquina dormindo). */
const LATE_MS = 2 * 60_000;
const HISTORY_MAX = 100;

interface Runtime {
  lastRun?: number;
  lastBaseSha?: string;
}

/**
 * Dispara os agendamentos enquanto o VS Code está aberto. Um timer acorda no próximo horário
 * (no máximo a cada hora, para se recuperar de suspensão); com várias janelas do mesmo repositório,
 * só a que tem o lock no common dir executa.
 */
export class Scheduler implements vscode.Disposable {
  private timer?: NodeJS.Timeout;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.changed];
  private running = false;
  /** Relógio (os testes trocam). */
  now: () => number = () => Date.now();

  constructor(private readonly ctl: Controller, private readonly agentTerms: AgentTerminals) {
    this.disposables.push(ctl.onDidChangeRepo(() => void this.start()));
  }

  // ---------- armazenamento ----------

  private key(kind: string) {
    return `schedule.${kind}:${this.ctl.repo?.commonDir.toLowerCase() ?? ''}`;
  }

  /** Pasta da worktree principal (onde fica .agentyard/schedules.json). */
  private mainDir(): string | undefined {
    const c = this.ctl.repo?.commonDir;
    if (!c) return undefined;
    return path.basename(c).toLowerCase() === '.git' ? path.dirname(c) : this.ctl.repo!.root;
  }

  sharedFile(): string | undefined {
    const d = this.mainDir();
    return d ? path.join(d, '.agentyard', 'schedules.json') : undefined;
  }

  private readShared(): Schedule[] {
    const f = this.sharedFile();
    if (!f || !fs.existsSync(f)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      return (Array.isArray(data) ? data : data.schedules ?? []).map((s: Schedule) => ({ ...s, scope: 'shared' as const }));
    } catch (e) {
      this.ctl.log(t('Schedules: {0} is invalid: {1}', f, (e as Error).message));
      return [];
    }
  }

  private writeShared(list: Schedule[]) {
    const f = this.sharedFile();
    if (!f) return;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ schedules: list.map(({ scope, ...rest }) => rest) }, null, 2) + '\n');
  }

  list(): Schedule[] {
    if (!this.ctl.repo) return [];
    return [...this.ctl.ctx.globalState.get<Schedule[]>(this.key('list'), []), ...this.readShared()];
  }

  get(id: string) {
    return this.list().find(s => s.id === id);
  }

  async save(s: Schedule) {
    const local = this.ctl.ctx.globalState.get<Schedule[]>(this.key('list'), []).filter(x => x.id !== s.id);
    const shared = this.readShared().filter(x => x.id !== s.id);
    if (s.scope === 'shared') shared.push(s);
    else local.push(s);
    await this.ctl.ctx.globalState.update(this.key('list'), local);
    if (s.scope === 'shared' || this.readShared().length !== shared.length) this.writeShared(shared);
    this.changed.fire();
    this.reschedule();
  }

  async remove(id: string) {
    const local = this.ctl.ctx.globalState.get<Schedule[]>(this.key('list'), []);
    if (local.some(s => s.id === id)) await this.ctl.ctx.globalState.update(this.key('list'), local.filter(s => s.id !== id));
    const shared = this.readShared();
    if (shared.some(s => s.id === id)) this.writeShared(shared.filter(s => s.id !== id));
    this.changed.fire();
    this.reschedule();
  }

  runtime(id: string): Runtime {
    return this.ctl.ctx.globalState.get<Record<string, Runtime>>(this.key('runtime'), {})[id] ?? {};
  }

  private async setRuntime(id: string, r: Runtime) {
    const all = this.ctl.ctx.globalState.get<Record<string, Runtime>>(this.key('runtime'), {});
    all[id] = { ...all[id], ...r };
    await this.ctl.ctx.globalState.update(this.key('runtime'), all);
  }

  history(): RunRecord[] {
    return this.ctl.ctx.globalState.get<RunRecord[]>(this.key('history'), []);
  }

  private async record(r: RunRecord) {
    const h = [r, ...this.history()].slice(0, HISTORY_MAX);
    await this.ctl.ctx.globalState.update(this.key('history'), h);
    this.ctl.log(t('Schedule "{0}" → {1}: {2}', r.name, r.target, r.result) + (r.message ? ` (${r.message})` : ''));
  }

  /** Próximo horário de um agendamento ativo (undefined: pausado, inválido ou "uma vez" já feito). */
  next(s: Schedule): Date | undefined {
    if (!s.enabled) return undefined;
    try {
      const when = parseWhen(s.when);
      const since = this.runtime(s.id).lastRun ?? s.createdAt;
      // se há um horário devido e não executado, ele é o "próximo"
      return missedSince(when, since, this.now()) ?? nextRun(when, new Date(Math.max(since, this.now())));
    } catch {
      return undefined;
    }
  }

  // ---------- timer ----------

  async start() {
    this.changed.fire();
    if (!this.ctl.repo) return this.stop();
    await this.tick();
  }

  private stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  reschedule() {
    this.stop();
    if (!this.ctl.repo) return;
    const times = this.list()
      .map(s => this.next(s)?.getTime())
      .filter((x): x is number => x !== undefined);
    if (!times.length) return;
    const wait = Math.min(Math.max(0, Math.min(...times) - this.now()), 3600_000);
    this.timer = setTimeout(() => void this.tick(), wait + 500);
  }

  private acquireLock(): boolean {
    const repo = this.ctl.repo;
    if (!repo) return false;
    const file = path.join(repo.commonDir, LOCK_FILE);
    const me = vscode.env.sessionId;
    try {
      const st = fs.statSync(file);
      if (fs.readFileSync(file, 'utf8').trim() !== me && Date.now() - st.mtimeMs < LOCK_STALE_MS) return false;
    } catch {
      // sem lock
    }
    try {
      fs.writeFileSync(file, me);
      return true;
    } catch {
      return false;
    }
  }

  /** Executa o que venceu. Horário perdido há mais de 2 min segue a política do agendamento. */
  async tick() {
    if (this.running || !this.ctl.repo) return;
    if (!this.acquireLock()) {
      // outra janela deste repositório está cuidando; tenta de novo mais tarde
      this.stop();
      this.timer = setTimeout(() => void this.tick(), 60_000);
      return;
    }
    this.running = true;
    try {
      const now = this.now();
      for (const s of this.list()) {
        if (!s.enabled) continue;
        let when;
        try {
          when = parseWhen(s.when);
        } catch {
          continue;
        }
        const due = missedSince(when, this.runtime(s.id).lastRun ?? s.createdAt, now);
        if (!due) continue;
        if (now - due.getTime() > LATE_MS && s.missed === 'skip') {
          await this.setRuntime(s.id, { lastRun: now });
          await this.record({ at: now, scheduleId: s.id, name: s.name, target: describeTarget(s.target), result: 'skipped', message: t('time missed while VS Code was closed') });
          continue;
        }
        await this.run(s);
      }
    } finally {
      this.running = false;
      this.changed.fire();
      this.reschedule();
    }
  }

  // ---------- execução ----------

  private async targets(s: Schedule, now: Date): Promise<{ path?: string; branch: string; error?: string }[]> {
    const repo = this.ctl.repo!;
    const wts = (await repo.worktreesFast()).filter(w => w.branch && !w.prunable && !w.bare);
    if (s.target.kind === 'pattern') {
      const pat = s.target.pattern;
      return wts.filter(w => branchMatches(w.branch!, [pat])).map(w => ({ path: w.path, branch: w.branch! }));
    }
    if (s.target.kind === 'branch') {
      const b = s.target.branch;
      const wt = wts.find(w => w.branch === b);
      if (wt) return [{ path: wt.path, branch: b }];
      const exists = (await repo.refs()).some(r => r.kind === 'head' && r.name === b);
      if (!exists) return [{ branch: b, error: t('branch {0} does not exist', b) }];
      const dir = await createWorktree(this.ctl, { existing: b, quiet: true });
      return [{ path: dir, branch: b, error: dir ? undefined : t('couldn\'t create the worktree') }];
    }
    const names = new Set((await repo.refs()).filter(r => r.kind === 'head').map(r => r.name));
    let name = newBranchName(s.target.prefix, s.name, now);
    for (let i = 2; names.has(name); i++) name = `${newBranchName(s.target.prefix, s.name, now)}-${i}`;
    const dir = await createWorktree(this.ctl, { branch: name, quiet: true });
    return [{ path: dir, branch: name, error: dir ? undefined : t('couldn\'t create the worktree') }];
  }

  /** Executa um agendamento agora (pelo timer ou por "Executar agora"). */
  async run(s: Schedule, opts: { manual?: boolean } = {}): Promise<RunRecord[]> {
    const repo = this.ctl.repo;
    if (!repo) return [];
    const nowMs = this.now();
    const now = new Date(nowMs);
    const out: RunRecord[] = [];
    const rec = async (target: string, result: RunRecord['result'], message: string) => {
      const r = { at: nowMs, scheduleId: s.id, name: s.name, target, result, message };
      out.push(r);
      await this.record(r);
    };
    try {
      const { base, baseRef } = await this.ctl.base();
      const baseSha = (await repo.revParse(baseRef)) ?? '';
      if (s.conditions.onlyIfBaseMoved && !opts.manual && this.runtime(s.id).lastBaseSha === baseSha) {
        await this.setRuntime(s.id, { lastRun: nowMs });
        await rec(describeTarget(s.target), 'skipped', t('{0} hasn\'t changed since the last run', base));
        return out;
      }
      const running = this.agentTerms.running();
      const pad = (n: number) => String(n).padStart(2, '0');
      const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
      const targets = await this.targets(s, now);
      if (!targets.length) await rec(describeTarget(s.target), 'skipped', t('no worktree matched the target'));
      for (const tg of targets) {
        if (tg.error || !tg.path) {
          await rec(tg.branch, 'error', tg.error ?? t('no worktree'));
          continue;
        }
        if (s.conditions.skipIfAgentOpen && (running.get(path.normalize(tg.path).toLowerCase())?.length ?? 0) > 0) {
          await rec(tg.branch, 'skipped', t('an agent is already open in this worktree'));
          continue;
        }
        if (s.conditions.onlyClean) {
          const st = await repo.status(tg.path);
          if (st.changes || st.operation) {
            await rec(tg.branch, 'skipped', st.operation ? t('worktree has {0} in progress', st.operation) : t('worktree has {0} change(s)', st.changes));
            continue;
          }
        }
        const prompt = renderTemplate(s.prompt, { date, branch: tg.branch, base, repo: this.ctl.state?.repoName ?? path.basename(repo.root) });
        await vscode.commands.executeCommand('worktreeGraph.launchAgentWithPrompt', { path: tg.path, branch: tg.branch, prompt, agent: s.agent });
        await rec(tg.branch, 'ok', s.agent ? t('agent opened ({0})', s.agent) : t('agent opened'));
      }
      await this.setRuntime(s.id, { lastRun: nowMs, lastBaseSha: baseSha });
    } catch (e) {
      await this.setRuntime(s.id, { lastRun: nowMs });
      await rec(describeTarget(s.target), 'error', (e as Error).message);
    }
    this.changed.fire();
    this.ctl.scheduleRefresh(50);
    return out;
  }

  dispose() {
    this.stop();
    const repo = this.ctl.repo;
    if (repo) {
      try {
        const f = path.join(repo.commonDir, LOCK_FILE);
        if (fs.readFileSync(f, 'utf8').trim() === vscode.env.sessionId) fs.unlinkSync(f);
      } catch {
        // nada a liberar
      }
    }
    this.disposables.forEach(d => d.dispose());
  }
}
