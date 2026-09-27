import { exec } from 'child_process';
import * as vscode from 'vscode';
import { formatBytes } from './env/core';
import { bytesOf } from './env/register';
import { agents, fillTemplate } from './agents';
import type { Controller } from './controller';
import { flowStages } from './flow';
import { t } from './i18n';
import {
  checkCacheKey,
  CheckCache,
  checkCommands,
  CheckKind,
  ChecksMode,
  cleanupCandidates,
  protectedList,
  protectionDecision,
  ProtectedAction,
  ProtectionMode,
  RemindState,
  shouldCheckMerge,
  shouldRemind,
  tailLines,
} from './guardsCore';
import type { GraphState } from './model';

/** Tarefa padrão para o agente corrigir as checagens; os ${…} são preenchidos por fillTemplate. */
function defaultFixPrompt(): string {
  return [
    t('The checks on branch {0} failed before {1}.', '${branch}', '${action}'),
    t('Commands: {0}', '${commands}'),
    '',
    t('End of the output:'),
    '```',
    '${log}',
    '```',
    '',
    t('Fix the cause, run the checks again until they pass and commit. If the fix requires a product decision, ask first.'),
  ].join('\n');
}

/** Diálogos usados pelas proteções. Os testes trocam por respostas prontas. */
export interface GuardUi {
  warn(message: string, options: vscode.MessageOptions, ...items: string[]): Thenable<string | undefined>;
  input(options: vscode.InputBoxOptions): Thenable<string | undefined>;
}

const vscodeUi: GuardUi = {
  warn: (m, o, ...items) => vscode.window.showWarningMessage(m, o, ...items),
  input: o => vscode.window.showInputBox(o),
};

interface RunResult {
  ok: boolean;
  cancelled: boolean;
  failed?: string;
  output: string;
}

/**
 * Checagens antes de mesclar/enviar, branches protegidas e lembrete de limpeza. Os ganchos em
 * actions.mergeBranches, push.pushBranch e na publicação de PR/MR chamam as funções exportadas
 * no fim do arquivo, que não fazem nada se as proteções não foram registradas.
 */
export class Guards implements vscode.Disposable {
  readonly out = vscode.window.createOutputChannel(t('AgentYard: checks'));
  readonly cache = new CheckCache();
  ui: GuardUi = vscodeUi;
  /** Últimos resultados, para os testes e o log. */
  lastCheck?: { kind: CheckKind; branch: string; ok: boolean; cached: boolean; failed?: string };
  lastReminder?: { stale: number; orphans: number; at: number };
  private readonly disposables: vscode.Disposable[] = [this.out];
  private timer?: NodeJS.Timeout;

  constructor(private readonly ctl: Controller) {
    ctl.stateHooks.push(s => (s.protectedBranches = this.protectedFor(s)));
    this.disposables.push(ctl.onDidChange(s => s && s.pending === 0 && this.maybeRemind()));
    this.timer = setInterval(() => this.maybeRemind(), 3600_000);
  }

  private cfg() {
    return this.ctl.cfg();
  }

  // ---------- branches protegidas ----------

  private protectedFor(s: Pick<GraphState, 'base'>): string[] {
    return protectedList(this.cfg().get<string[]>('protectedBranches', []), s.base, flowStages(this.ctl).map(f => f.branch));
  }

  async protectedBranches(): Promise<string[]> {
    if (this.ctl.state) return this.protectedFor(this.ctl.state);
    const { base } = await this.ctl.base();
    return this.protectedFor({ base });
  }

  private mode(): ProtectionMode {
    return this.cfg().get<ProtectionMode>('protection.mode', 'confirm');
  }

  /** Pede para digitar o nome da branch: um botão só seria clicado no automático. */
  private async typeToConfirm(branch: string, what: string): Promise<boolean> {
    const v = await this.ui.input({
      title: t('{0} is a protected branch', branch),
      prompt: t('{0}. To confirm, type the branch name: {1}', what, branch),
      ignoreFocusOut: true,
      validateInput: x => (x.trim() === branch ? undefined : t('Type exactly "{0}"', branch)),
    });
    return v?.trim() === branch;
  }

  async allowDirect(action: ProtectedAction, branch: string, source?: string): Promise<boolean> {
    const decision = protectionDecision(this.mode(), action, branch, await this.protectedBranches());
    if (decision === 'allow') return true;
    if (decision === 'block') {
      await this.ui.warn(
        t('Force push to {0} blocked: the branch is protected.', branch),
        { modal: true, detail: t('To allow it, set worktreeGraph.protection.mode to "off" or remove the branch from worktreeGraph.protectedBranches.') },
      );
      this.ctl.log(t('Protection: force push to {0} blocked.', branch));
      return false;
    }
    if (decision === 'require-pr') {
      const remote = await this.ctl.requests.detectRemote();
      const L = this.ctl.requests.label;
      if (action === 'merge' && source && remote) {
        const pick = await this.ui.warn(
          t('{0} is protected: merging {1} must go through a {2}.', branch, source, L),
          { modal: true, detail: 'worktreeGraph.protection.mode = "require-pr"' },
          t('Open {0} {1} → {2}', L, source, branch),
        );
        if (pick) await this.ctl.requests.publish(source, branch);
      } else {
        await this.ui.warn(
          action === 'merge'
            ? t('{0} is protected: direct merge blocked; use a {1}.', branch, L)
            : t('{0} is protected: direct push blocked. Work on a branch and open a {1}.', branch, L),
          { modal: true, detail: 'worktreeGraph.protection.mode = "require-pr"' },
        );
      }
      this.ctl.log(t('Protection: direct {0} to {1} blocked (require-pr).', action, branch));
      return false;
    }
    const ok = await this.typeToConfirm(branch, action === 'merge' ? t('Direct merge of {0} into {1}', source ?? '?', branch) : t('Direct push to {0}', branch));
    this.ctl.log(ok ? t('Protection: direct {0} to {1} confirmed.', action, branch) : t('Protection: direct {0} to {1} cancelled.', action, branch));
    return ok;
  }

  // ---------- checagens ----------

  private commandsFor(kind: CheckKind): string[] {
    const c = this.cfg();
    return checkCommands(c.get<string[]>(kind === 'merge' ? 'checks.beforeMerge' : 'checks.beforePush', []), c.get<string>('autoSync.testCommand', ''), c.get<boolean>('checks.useTestCommand', false));
  }

  private run(commands: string[], cwd: string, title: string): Thenable<RunResult> {
    const timeout = Math.max(10, this.cfg().get<number>('checks.timeoutSeconds', 900)) * 1000;
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
      let output = '';
      for (const cmd of commands) {
        if (token.isCancellationRequested) return { ok: false, cancelled: true, output };
        progress.report({ message: cmd });
        this.out.appendLine(`$ ${cmd}   (${cwd})`);
        const r = await new Promise<{ code: number; text: string }>(resolve => {
          const child = exec(cmd, { cwd, timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
            resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code?: unknown }).code as number) : 1) : 0, text: `${stdout}${stderr}` }),
          );
          token.onCancellationRequested(() => child.kill());
        });
        output += `$ ${cmd}\n${r.text}\n`;
        this.out.append(r.text.endsWith('\n') || !r.text ? r.text : r.text + '\n');
        this.out.appendLine(r.code === 0 ? '✓ ok' : t('✗ exited with {0}', r.code));
        if (token.isCancellationRequested) return { ok: false, cancelled: true, output };
        if (r.code !== 0) return { ok: false, cancelled: false, failed: cmd, output };
      }
      return { ok: true, cancelled: false, output };
    });
  }

  /** Roda as checagens do tipo na worktree da branch. true = pode seguir. */
  async runChecks(kind: CheckKind, branch: string): Promise<boolean> {
    const mode = this.cfg().get<ChecksMode>('checks.mode', 'block');
    if (mode === 'off') return true;
    const commands = this.commandsFor(kind);
    if (!commands.length) return true;
    const repo = this.ctl.repo;
    if (!repo) return true;
    const action = kind === 'merge' ? t('merging {0}', branch) : t('pushing {0}', branch);

    let wtPath = (await repo.worktreesFast()).find(w => w.branch === branch && !w.prunable)?.path;
    if (!wtPath) {
      const skip = t('Skip checks');
      const pick = await this.ui.warn(
        kind === 'merge' ? t('{0} has no worktree to run the checks before merging.', branch) : t('{0} has no worktree to run the checks before pushing.', branch),
        { modal: true, detail: commands.join('\n') },
        t('Create worktree and check'),
        skip,
      );
      if (pick === skip) return true;
      if (!pick) return false;
      const { createWorktree } = await import('./actions');
      wtPath = await createWorktree(this.ctl, { existing: branch, quiet: true });
      if (!wtPath) return false;
    }

    const head = (await repo.revParse('HEAD', wtPath)) ?? '';
    const clean = (await repo.status(wtPath)).changes === 0;
    const key = checkCacheKey(wtPath, head, commands);
    if (clean && this.cache.has(key)) {
      this.lastCheck = { kind, branch, ok: true, cached: true };
      this.out.appendLine(t('✓ {0} @ {1}: checks already passed on this commit.', branch, head.slice(0, 7)));
      return true;
    }

    this.out.appendLine(`\n== ${t('Checks before {0}', action)} (${new Date().toLocaleTimeString()})`);
    const r = await this.run(commands, wtPath, t('Checks before {0}', action));
    this.cache.record(key, r.ok, clean);
    this.lastCheck = { kind, branch, ok: r.ok, cached: false, failed: r.failed };
    if (r.cancelled) {
      this.out.appendLine(t('checks cancelled'));
      return false;
    }
    if (r.ok) {
      vscode.window.setStatusBarMessage(t('$(pass) Checks for {0} passed', branch), 4000);
      return true;
    }

    const msg = t('Checks failed on {0}: {1}', branch, r.failed ?? '');
    const showOutput = t('Show output');
    if (mode === 'warn') {
      void this.ui.warn(t('{0}. Continuing because worktreeGraph.checks.mode is "warn".', msg), {}, showOutput).then(p => p && this.out.show());
      return true;
    }
    const agent = agents(this.ctl)[0]?.name ?? t('agent');
    const runInTerminal = t('Run in terminal');
    const continueAnyway = t('Continue anyway');
    const pick = await this.ui.warn(msg, {}, showOutput, t('✦ Fix with {0}', agent), runInTerminal, continueAnyway);
    if (pick === showOutput) this.out.show();
    else if (pick?.startsWith('✦')) {
      const prompt = fillTemplate(this.cfg().get<string>('prompts.fixChecks', '') || defaultFixPrompt(), {
        branch,
        action,
        commands: commands.join(' && '),
        failed: r.failed ?? '',
        log: tailLines(r.output),
      });
      await vscode.commands.executeCommand('worktreeGraph.launchAgentWithPrompt', { path: wtPath, branch, prompt });
    } else if (pick === runInTerminal) {
      const term = vscode.window.createTerminal({ name: t('checks · {0}', branch), cwd: wtPath });
      term.show();
      for (const c of commands) term.sendText(c);
    } else if (pick === continueAnyway) {
      const go = t('Continue');
      const sure = await this.ui.warn(t('Continue {0} with the checks failing?', action), { modal: true, detail: r.failed }, go);
      if (sure === go) {
        this.ctl.log(t('Checks skipped by choice: {0}.', action));
        return true;
      }
    }
    return false;
  }

  // ---------- lembrete de limpeza ----------

  private remindKey() {
    return `cleanupRemind:${this.ctl.repo?.commonDir.toLowerCase() ?? ''}`;
  }

  /** Avalia com o estado já calculado (sem git). `manual`: ignora adiamento e o intervalo de 24 h. */
  maybeRemind(manual = false) {
    const s = this.ctl.state;
    if (!s || s.pending > 0 || !this.ctl.repo) {
      if (manual) vscode.window.showInformationMessage(t('Still loading the worktree details; try again in a moment.'));
      return;
    }
    const c = this.cfg();
    const { stale, orphans } = cleanupCandidates(s.worktrees, c.get<number>('cleanup.staleDays', 7));
    const total = stale.length + orphans.length;
    const st = this.ctl.ctx.globalState.get<RemindState>(this.remindKey(), {});
    const threshold = c.get<number>('cleanup.remindThreshold', 20);
    if (manual) {
      if (!total) {
        vscode.window.showInformationMessage(t('No merged and idle worktrees, and no orphans.'));
        return;
      }
    } else if (!shouldRemind(total, threshold, st)) {
      return;
    }
    void this.ctl.ctx.globalState.update(this.remindKey(), { ...st, lastShown: Date.now() });
    this.lastReminder = { stale: stale.length, orphans: orphans.length, at: Date.now() };
    const parts = [stale.length ? t('{0} merged and idle for more than {1} days', stale.length, c.get<number>('cleanup.staleDays', 7)) : '', orphans.length ? t('{0} orphaned', orphans.length) : ''].filter(Boolean);
    const bytes = bytesOf(stale.map(w => w.path));
    const cleanUp = t('Clean up…');
    const later = t('Remind me later');
    const never = t('Do not remind me in this project');
    void this.ui
      .warn(
        t('{0} leftover worktrees in this project: {1}.', total, parts.length > 1 ? t('{0} and {1}', parts[0], parts[1]) : parts[0]) + (bytes ? ' ' + t('They take up ~{0}.', formatBytes(bytes)) : ''),
        {},
        cleanUp,
        later,
        never,
      )
      .then(async pick => {
        if (pick === cleanUp) {
          if (orphans.length) await vscode.commands.executeCommand('worktreeGraph.pruneWorktrees');
          if (stale.length) await vscode.commands.executeCommand('worktreeGraph.cleanupWorktrees');
        } else if (pick === later) {
          await this.ctl.ctx.globalState.update(this.remindKey(), { ...st, lastShown: Date.now(), snoozeUntil: Date.now() + 7 * 86400_000 });
        } else if (pick === never) {
          await this.ctl.ctx.globalState.update(this.remindKey(), { ...st, disabled: true });
        }
      });
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.disposables.forEach(d => d.dispose());
  }
}

let instance: Guards | undefined;

export function registerGuards(ctx: vscode.ExtensionContext, ctl: Controller): Guards {
  instance = new Guards(ctl);
  ctx.subscriptions.push(
    instance,
    { dispose: () => (instance = undefined) },
    vscode.commands.registerCommand('worktreeGraph.cleanupReminder', () => instance?.maybeRemind(true)),
    vscode.commands.registerCommand('worktreeGraph.showChecksOutput', () => instance?.out.show()),
  );
  return instance;
}

// ---------- ganchos usados por actions.ts, push.ts e hosting/service.ts ----------

/** Merge direto: proteção do destino e checagens da origem. */
export async function guardMerge(ctl: Controller, source: string, target: string): Promise<boolean> {
  if (!instance) return true;
  if (!(await instance.allowDirect('merge', target, source))) return false;
  const { base, baseRef } = ctl.state ?? (await ctl.base());
  if (!shouldCheckMerge(source, base, baseRef)) return true;
  return instance.runChecks('merge', source);
}

/** Push: proteção da branch e checagens (antes do git push). */
export async function guardPush(ctl: Controller, branch: string): Promise<boolean> {
  if (!instance) return true;
  if (!(await instance.allowDirect('push', branch))) return false;
  return instance.runChecks('push', branch);
}

/** Push forçado: bloqueado em branch protegida (a menos que a proteção esteja desligada). */
export async function guardForce(ctl: Controller, branch: string): Promise<boolean> {
  return instance ? instance.allowDirect('force', branch) : true;
}

/** Só as checagens (antes de abrir PR/MR). */
export async function guardChecks(kind: CheckKind, branch: string): Promise<boolean> {
  return instance ? instance.runChecks(kind, branch) : true;
}
