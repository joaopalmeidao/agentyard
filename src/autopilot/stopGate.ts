import * as vscode from 'vscode';
import type { AgentTerminals } from '../agents';
import type { AgentFlow } from '../agentFlow/register';
import { keyOf } from '../agentFlow/head';
import type { BridgeHookEvent, ClaudeBridge } from '../bridge/register';
import { hookJson } from '../bridge/register';
import type { ClaudeIntegration } from '../claude/integration';
import { osNotify } from '../claude/osNotify';
import type { Controller } from '../controller';
import { t } from '../i18n';
import { gateBlockReason, gateCommands, gateVerdict, runCommands, StopGateMode } from './core';

export interface GateResult {
  ok: boolean;
  at: number;
  failed?: string;
  /** Desistiu depois de `maxRetries` tentativas com as checagens falhando. */
  gaveUp?: boolean;
}

/**
 * Portão no Stop para todo Claude com a ponte: quando o turno mexeu em arquivos, roda as checagens
 * (`claude.stopGate.commands`, ou as de antes do merge, ou o testCommand) antes de deixar o Claude
 * parar. Falhou: o hook devolve `decision: block` com o fim do log e o Claude continua corrigindo,
 * até `claude.stopGate.maxRetries` vezes seguidas. Enquanto roda, a worktree não vira "pronta".
 */
export class StopGate implements vscode.Disposable {
  /** Worktrees com o portão rodando agora (chave → desde quando). */
  private readonly running = new Map<string, number>();
  /** Bloqueios seguidos por Claude (terminal ou sessão); zera a cada prompt novo. */
  private readonly retries = new Map<string, number>();
  private readonly results = new Map<string, GateResult>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly ctl: Controller,
    bridge: ClaudeBridge,
    private readonly integration: ClaudeIntegration,
    private readonly flow: AgentFlow,
    private readonly agentTerms: AgentTerminals,
  ) {
    bridge.onHook('UserPromptSubmit', e => {
      this.retries.delete(this.agentKey(e));
      return undefined;
    });
    bridge.onHook('Stop', e => this.onStop(e));
    // o portão segura o "pronto": o Claude parou, mas ainda pode voltar a trabalhar
    flow.watch.holds.push(p => this.running.has(keyOf(p)));
    // mark_ready no meio do turno: espera o fim do turno (e o portão) para marcar
    flow.watch.describers.push(p => this.describe(p));
    flow.watch.gates.push(async info => !(this.enabled() && this.agentTerms.claudeIn(info.path).some(o => o.bridged && o.state === 'working')));
  }

  private cfg() {
    return this.ctl.cfg();
  }

  mode(): StopGateMode {
    return this.cfg().get<StopGateMode>('claude.stopGate', 'changes');
  }

  commands(): string[] {
    const c = this.cfg();
    return gateCommands(c.get<string[]>('claude.stopGate.commands', []), c.get<string[]>('checks.beforeMerge', []), c.get<string>('autoSync.testCommand', ''));
  }

  enabled() {
    return this.mode() !== 'off' && this.commands().length > 0;
  }

  /** Último resultado do portão numa worktree. */
  resultFor(p: string): GateResult | undefined {
    return this.results.get(keyOf(p));
  }

  isRunning(p: string) {
    return this.running.has(keyOf(p));
  }

  private agentKey(e: BridgeHookEvent) {
    return e.open?.id ?? (e.session_id ? `session-${e.session_id}` : keyOf(e.cwd));
  }

  private async onStop(e: BridgeHookEvent) {
    const w = e.worktree;
    if (!w) return undefined;
    const mode = this.mode();
    const commands = this.commands();
    const changed = mode === 'changes' && commands.length ? await this.integration.turnChanged(e) : true;
    const verdict = gateVerdict({ mode, commands, changed, project: !!e.open?.project, headless: e.headless === true });
    if (verdict.action === 'skip') return undefined;

    const where = w.branch ?? w.name;
    const key = this.agentKey(e);
    const blocks = this.retries.get(key) ?? 0;
    const max = Math.max(1, this.cfg().get<number>('claude.stopGate.maxRetries', 3));
    const wk = keyOf(w.path);
    this.running.set(wk, Date.now());
    this.changed.fire();
    this.ctl.log(t('Stop gate: running the checks in {0}: {1}', where, commands.join(' && ')));
    const timeout = Math.max(10, this.cfg().get<number>('checks.timeoutSeconds', 900)) * 1000;
    const job = runCommands(commands, w.path, timeout);
    vscode.window.setStatusBarMessage(t('$(sync~spin) Checking {0} before Claude stops…', where), job);
    let r;
    try {
      r = await job;
    } finally {
      this.running.delete(wk);
    }
    if (r.ok) {
      this.retries.delete(key);
      this.results.set(wk, { ok: true, at: Date.now() });
      this.ctl.log(t('Stop gate: checks passed in {0}.', where));
      this.changed.fire();
      // o fim do turno já passou pelo AgentWatch enquanto o portão rodava: checa de novo
      setTimeout(() => void this.flow.watch.checkNow(w.path).catch(() => undefined), 500);
      return undefined;
    }
    const failed = r.failed ?? commands[0];
    if (blocks >= max) {
      this.retries.delete(key);
      this.results.set(wk, { ok: false, at: Date.now(), failed, gaveUp: true });
      this.changed.fire();
      this.ctl.log(t('Stop gate: {0} still fails in {1} after {2} attempt(s); letting Claude stop.', failed, where, max));
      const msg = t('Claude in {0} stopped with the checks still failing ({1}) after {2} attempt(s).', where, failed, max);
      if (!vscode.window.state.focused) osNotify(this.ctl, 'AgentYard', msg);
      const show = t('Show terminal');
      void vscode.window.showWarningMessage(msg, show).then(p => p && this.focus(w.path, e));
      return undefined;
    }
    this.retries.set(key, blocks + 1);
    this.results.set(wk, { ok: false, at: Date.now(), failed });
    this.changed.fire();
    this.ctl.log(t('Stop gate: {0} failed in {1}; Claude continues (attempt {2} of {3}).', failed, where, blocks + 1, max));
    return hookJson({ decision: 'block', reason: gateBlockReason(failed, r.output, blocks + 1, max) });
  }

  private focus(p: string, e: BridgeHookEvent) {
    const term = e.open?.terminal ?? this.agentTerms.list(p).pop()?.terminal;
    term?.show();
  }

  /** Liga/desliga pelo comando: sem comandos, pergunta quais usar. */
  async configure() {
    const cur = this.mode();
    const labels: Record<StopGateMode, string> = {
      changes: t('When the turn changed files (recommended)'),
      always: t('At the end of every turn'),
      off: t('Off'),
    };
    const pick = await vscode.window.showQuickPick(
      (['changes', 'always', 'off'] as StopGateMode[]).map(m => ({ label: labels[m], description: m === cur ? t('current') : undefined, m })),
      { title: t('Checks before Claude stops'), placeHolder: this.commands().join(' && ') || t('No command configured yet') },
    );
    if (!pick) return;
    await this.cfg().update('claude.stopGate', pick.m, vscode.ConfigurationTarget.Workspace);
    if (pick.m !== 'off' && !this.commands().length) {
      const typed = await vscode.window.showInputBox({
        title: t('Command that must pass before Claude stops'),
        prompt: t('Runs in the worktree, e.g. npm test or npm run lint && npm test'),
        ignoreFocusOut: true,
      });
      if (typed?.trim()) await this.cfg().update('claude.stopGate.commands', [typed.trim()], vscode.ConfigurationTarget.Workspace);
    }
    vscode.window.showInformationMessage(
      pick.m === 'off' ? t('Checks before Claude stops: off.') : t('Checks before Claude stops: {0}. Takes effect in Claude sessions opened by AgentYard.', this.commands().join(' && ') || t('no command')),
    );
  }

  /** Texto para a notificação de pronto e o mission control. */
  describe(p: string): string | undefined {
    const r = this.resultFor(p);
    if (!r) return undefined;
    return r.ok ? t('checks passed') : r.gaveUp ? t('checks failing ({0})', r.failed ?? '') : undefined;
  }

  dispose() {
    this.changed.dispose();
  }
}
