import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { mergeBranches, openWorktree } from './actions';
import { resolveButton, runResolve } from './conflicts';
import { Controller } from './controller';
import { branchMatches, Repo, Worktree } from './git';
import { t } from './i18n';
import { describePlan, needsAttention, needsRechain } from './migrations/core';
import { applyRechain, checkMigrations } from './migrations/register';
import { SyncKind, SyncWhere } from './model';

const LOCK_FILE = 'worktree-graph-sync.lock';
const LOCK_STALE_MS = 5 * 60_000;

/**
 * Vigia a base e a mescla nas worktrees que ficaram para trás. Com `autoSync.trigger = push`
 * (padrão), a verificação periódica só atualiza o estado; o merge acontece antes do push da branch.
 * Regras de segurança: só mexe em worktree limpa, sem merge/rebase em andamento, e só quando a
 * simulação (git merge-tree) não prevê conflito. Várias janelas do mesmo repositório disputam um
 * lock no common dir para que só uma rode o sync.
 */
export class AutoSync implements vscode.Disposable {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly notified = new Set<string>();
  private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);

  constructor(private readonly ctl: Controller) {
    this.statusBar.command = 'worktreeGraph.toggleAutoSync';
    this.reschedule();
  }

  reschedule() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.updateStatusBar();
    if (!this.ctl.repo || !this.ctl.autoSyncEnabled()) {
      this.releaseLock();
      return;
    }
    const secs = Math.max(15, this.ctl.cfg().get<number>('autoSync.intervalSeconds', 60));
    this.timer = setInterval(() => this.tick(), secs * 1000);
    setTimeout(() => this.tick(), 1500);
  }

  private updateStatusBar() {
    if (!this.ctl.repo) {
      this.statusBar.hide();
      return;
    }
    const on = this.ctl.autoSyncEnabled();
    const mode = this.ctl.cfg().get<string>('autoSync.mode', 'merge');
    const where = { local: '', github: ' · CI', split: ` · ${t('split')}`, both: ' · local+CI' }[this.ctl.syncWhere()];
    const label = mode === 'notify' ? t('(notify)') : this.onPush() ? t('on push') : 'on';
    this.statusBar.text = on ? `$(sync) Sync ${label}${where}` : `$(sync-ignored) Sync off${where}`;
    this.statusBar.tooltip = on
      ? this.ctl.syncOwner
        ? t('AgentYard: this window is keeping the worktrees up to date with the base. Click to turn off.')
        : t('AgentYard: sync on (another window of the same repository may be running it). Click to turn off.')
      : t('AgentYard: automatic sync off. Click to turn on.');
    this.statusBar.show();
  }

  /** true = a base só é mesclada quando a branch é enviada (push), não a cada verificação. */
  private onPush() {
    return this.ctl.cfg().get<string>('autoSync.trigger', 'push') === 'push';
  }

  /**
   * Chamado por pushBranch antes de enviar: com o gatilho "push", mescla a base na worktree da
   * branch (mesmas regras de segurança do sync). Se não der para mesclar, o push segue e o motivo
   * fica no estado da branch.
   */
  async beforePush(branch: string) {
    const repo = this.ctl.repo;
    if (!repo || !this.ctl.autoSyncEnabled() || !this.onPush()) return;
    const c = this.ctl.cfg();
    if (c.get<string>('autoSync.mode', 'merge') === 'notify') return;
    if (!branchMatches(branch, c.get<string[]>('autoSync.branches', ['**'])) || branchMatches(branch, c.get<string[]>('autoSync.exclude', []))) return;
    if (this.ctl.paused().includes(branch)) return;
    const where = this.ctl.syncWhere();
    if (where === 'github' || (where === 'split' && (await repo.upstream(branch)))) return;
    const wt = (await repo.worktreesFast()).find(w => w.branch === branch && !w.bare && !w.prunable);
    if (!wt) return;
    while (this.running) await new Promise(r => setTimeout(r, 200));
    this.running = true;
    try {
      if (c.get('autoSync.fetchRemote', false)) {
        const f = await repo.run(['fetch', '--prune', '--quiet', 'origin'], repo.root, 120_000);
        if (f.code !== 0) this.ctl.log(t('fetch failed: {0}', f.stderr.trim()));
      }
      const { base, baseRef } = await this.ctl.base();
      if (branch === base) return;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Merging {0} into {1} before push…', baseRef, branch) }, () =>
        this.syncOne(repo, wt, baseRef, true),
      );
    } catch (e) {
      this.set(branch, 'error', (e as Error).message);
      this.ctl.log(`[${branch}] ${t('sync error before push: {0}', (e as Error).message)}`);
    } finally {
      this.running = false;
      this.ctl.scheduleRefresh(50);
    }
  }

  async toggle() {
    const v = !this.ctl.autoSyncEnabled();
    await this.ctl.setAutoSyncEnabled(v);
    vscode.window.showInformationMessage(v ? t('Automatic sync on for this repository.') : t('Automatic sync off for this repository.'));
    this.reschedule();
    this.ctl.scheduleRefresh(50);
  }

  async chooseWhere() {
    const current = this.ctl.syncWhere();
    const items: (vscode.QuickPickItem & { value: SyncWhere })[] = [
      { value: 'local', label: t('Local only'), detail: t('The extension merges the base into the worktrees on this machine. The GitHub workflow is not used.') },
      { value: 'github', label: t('CI only (GitHub Actions or GitLab CI)'), detail: t('The extension does not touch the worktrees; the CI generated by "Generate CI" syncs the published branches.') },
      { value: 'split', label: t('Split'), detail: t('Local for branches not yet published; CI for published ones. No branch is synced by both.') },
      { value: 'both', label: t('Both'), detail: t('Local and CI on all branches. May create two different merges of the same base.') },
    ];
    for (const i of items) if (i.value === current) i.description = t('(current)');
    const pick = await vscode.window.showQuickPick(items, { placeHolder: t('Where should the base sync run in this repository?') });
    if (!pick) return;
    await this.ctl.setSyncWhere(pick.value);
    this.ctl.statuses.clear();
    if (pick.value !== 'local' && !this.ctl.hasCiWorkflow()) {
      const go = await vscode.window.showInformationMessage(t('This repository does not have the sync workflow yet. Generate it now?'), t('Generate CI'));
      if (go) await vscode.commands.executeCommand('worktreeGraph.generateCiWorkflow');
    }
    this.reschedule();
    if (this.ctl.autoSyncEnabled()) await this.tick(true);
    this.ctl.scheduleRefresh(50);
  }

  async tick(manual = false) {
    const repo = this.ctl.repo;
    if (!repo || this.running) return;
    if (!manual && !this.ctl.autoSyncEnabled()) return;
    if (!this.acquireLock(repo)) {
      if (manual) vscode.window.showInformationMessage(t('Another window of this repository is running the sync right now.'));
      return;
    }
    this.running = true;
    try {
      const c = this.ctl.cfg();
      if (c.get('autoSync.fetchRemote', false)) {
        const f = await repo.run(['fetch', '--prune', '--quiet', 'origin'], repo.root, 120_000);
        if (f.code !== 0) this.ctl.log(t('fetch failed: {0}', f.stderr.trim()));
      }
      const { base, baseRef } = await this.ctl.base();
      const include = c.get<string[]>('autoSync.branches', ['**']);
      const exclude = c.get<string[]>('autoSync.exclude', []);
      const paused = new Set(this.ctl.paused());
      const where = this.ctl.syncWhere();
      for (const wt of await repo.worktreesFast()) {
        if (!wt.branch || wt.bare || wt.prunable || wt.branch === base) continue;
        if (!branchMatches(wt.branch, include) || branchMatches(wt.branch, exclude)) continue;
        if (where === 'github' || (where === 'split' && (await repo.upstream(wt.branch)))) {
          this.set(
            wt.branch,
            'remote',
            where === 'github'
              ? t('Sync is set to run only on CI (GitHub Actions/GitLab CI).')
              : t('Published branch: CI syncs it (split mode).'),
          );
          continue;
        }
        // Com centenas de worktrees, só vale conferir de novo quem o estado não sabe se está em dia.
        const known = this.ctl.state?.worktrees.find(v => v.path.toLowerCase() === wt.path.toLowerCase());
        if (known?.compareKnown && known.behind === 0 && this.ctl.state?.baseRef === baseRef) {
          this.set(wt.branch, 'uptodate', t('Up to date with {0}.', baseRef));
          continue;
        }
        if (paused.has(wt.branch)) {
          this.set(wt.branch, 'paused', t('Sync paused for this branch.'));
          continue;
        }
        try {
          await this.syncOne(repo, wt, baseRef, manual);
        } catch (e) {
          this.set(wt.branch, 'error', (e as Error).message);
          this.ctl.log(`[${wt.branch}] ${t('error: {0}', (e as Error).message)}`);
        }
      }
    } finally {
      this.running = false;
      this.updateStatusBar();
      this.ctl.scheduleRefresh(50);
    }
  }

  private async syncOne(repo: Repo, wt: Worktree, baseRef: string, manual: boolean) {
    const branch = wt.branch!;
    const c = this.ctl.cfg();
    const [behind] = await repo.aheadBehind(baseRef, branch);
    if (behind === 0) {
      this.set(branch, 'uptodate', t('Up to date with {0}.', baseRef));
      return;
    }
    const baseSha = (await repo.revParse(baseRef)) ?? '';
    const st = await repo.status(wt.path);
    if (st.operation) {
      this.set(branch, 'error', t('{0} in progress in the worktree; sync waiting.', st.operation));
      return;
    }
    if (st.changes > 0) {
      this.set(branch, 'waiting-dirty', t('{0} commit(s) behind. Waiting for the worktree to be clean ({1} uncommitted change(s)).', behind, st.changes));
      return;
    }
    const preview = await repo.mergePreview(branch, baseRef);
    if (preview?.conflict) {
      this.set(branch, 'conflict', t('Merging {0} will conflict in: {1}', baseRef, preview.files.join(', ')));
      this.notifyOnce(`${branch}@${baseSha}@conflict`, t('{0}: the base moved ahead and will conflict in {1} file(s).', branch, preview.files.length), branch, true, true);
      return;
    }
    if (c.get<string>('autoSync.mode', 'merge') === 'notify' && !manual) {
      this.set(branch, 'behind', t('{0} commit(s) behind {1}, no conflicts expected.', behind, baseRef));
      this.notifyOnce(`${branch}@${baseSha}@behind`, t('{0} is {1} commit(s) behind {2}.', branch, behind, baseRef), branch, false);
      return;
    }
    if (this.onPush() && !manual) {
      this.set(branch, 'behind', t('{0} commit(s) behind {1}, no conflicts expected. The base will be merged on the next push.', behind, baseRef));
      return;
    }

    const pre = (await repo.revParse('HEAD', wt.path))!;
    // Migrations novas dos dois lados não conflitam no git, mas quebram a cadeia: reencadeia antes
    // (depois de `pre`, para o rollback dos testes desfazer as duas coisas).
    const mig = await checkMigrations(repo, branch, baseRef).catch(() => undefined);
    if (mig && needsAttention(mig.plan)) {
      const auto = c.get<boolean>('migrations.rechainOnSync', true) && needsRechain(mig.plan);
      if (!auto || !(await applyRechain(this.ctl, mig, { commit: true, quiet: true }))) {
        this.set(branch, 'conflict', t('Migrations collide with {0}: {1}', baseRef, describePlan(mig.plan).join(' ')));
        this.notifyOnce(`${branch}@${baseSha}@migrations`, t('{0}: the migrations collide with those on {1}.', branch, baseRef), branch, true);
        return;
      }
      this.ctl.log(`[${branch}] ${t('migrations rechained after {0}.', baseRef)}`);
    }
    const msg = `Merge ${baseRef} into ${branch} (worktree-graph auto-sync)`;
    const r = await repo.run(['merge', '--no-edit', '-m', msg, baseRef], wt.path, 300_000);
    if (r.code !== 0) {
      await repo.run(['merge', '--abort'], wt.path);
      this.set(branch, 'conflict', t('Merge failed and was aborted: {0}', (r.stderr || r.stdout).trim()));
      return;
    }
    this.ctl.log(`[${branch}] ${t('{0} commit(s) from {1} merged.', behind, baseRef)}`);

    const test = c.get<string>('autoSync.testCommand', '').trim();
    if (test) {
      this.set(branch, 'testing', t('Running "{0}"…', test));
      this.ctl.scheduleRefresh(50);
      const res = await runShell(test, wt.path, c.get<number>('autoSync.testTimeoutSeconds', 900) * 1000);
      this.ctl.log(`[${branch}] ${test} → ${res.ok ? 'ok' : t('FAILED')}\n${res.output.slice(-4000)}`);
      if (!res.ok) {
        let rolled = '';
        if (c.get('autoSync.rollbackOnTestFailure', true)) {
          // --keep preserva o que alguém tenha editado enquanto os testes rodavam.
          const rb = await repo.run(['reset', '--keep', pre], wt.path);
          rolled = ' ' + (rb.code === 0 ? t('The merge was undone.') : t('Could not undo the merge: {0}', rb.stderr.trim()));
        }
        this.set(branch, 'test-failed', t('"{0}" failed after merging {1}.', test, baseRef) + rolled);
        this.notifyOnce(`${branch}@${baseSha}@test`, `${branch}: ${t('"{0}" failed after merging {1}.', test, baseRef)}${rolled}`, branch, true);
        return;
      }
    }
    this.set(branch, 'merged', test ? t('{0} commit(s) from {1} merged and verified.', behind, baseRef) : t('{0} commit(s) from {1} merged.', behind, baseRef));
  }

  private set(branch: string, kind: SyncKind, message: string) {
    this.ctl.statuses.set(branch, { kind, message, at: Date.now() });
  }

  private async notifyOnce(key: string, message: string, branch: string, warn: boolean, conflict = false) {
    if (this.notified.has(key)) return;
    this.notified.add(key);
    const resolve = resolveButton(this.ctl);
    const openWt = t('Open worktree');
    const viewGraph = t('View graph');
    const log = t('Log');
    const mergeNow = t('Merge now');
    const buttons = warn ? [...(conflict ? [resolve] : []), openWt, viewGraph, log] : [mergeNow, viewGraph];
    const pick = await (warn ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(message, ...buttons);
    if (pick === resolve) await runResolve(branch);
    else if (pick === openWt) await openWorktree(this.ctl, branch);
    else if (pick === viewGraph) await vscode.commands.executeCommand('worktreeGraph.openGraph');
    else if (pick === log) this.ctl.out.show();
    else if (pick === mergeNow) {
      const { baseRef } = await this.ctl.base();
      await mergeBranches(this.ctl, baseRef, branch, { confirm: false, quiet: true });
    }
  }

  private lockPath(repo: Repo) {
    return path.join(repo.commonDir, LOCK_FILE);
  }

  private lockRepo?: Repo;

  private acquireLock(repo: Repo): boolean {
    const file = this.lockPath(repo);
    const me = vscode.env.sessionId;
    try {
      const st = fs.statSync(file);
      const owner = fs.readFileSync(file, 'utf8').trim();
      if (owner !== me && Date.now() - st.mtimeMs < LOCK_STALE_MS) {
        this.ctl.syncOwner = false;
        return false;
      }
    } catch {
      // sem lock: é nosso
    }
    try {
      if (this.lockRepo && this.lockRepo !== repo) this.releaseLock();
      fs.writeFileSync(file, me);
      this.lockRepo = repo;
      this.ctl.syncOwner = true;
      return true;
    } catch {
      return false;
    }
  }

  private releaseLock() {
    const repo = this.lockRepo ?? this.ctl.repo;
    this.ctl.syncOwner = false;
    this.lockRepo = undefined;
    if (!repo) return;
    try {
      if (fs.readFileSync(this.lockPath(repo), 'utf8').trim() === vscode.env.sessionId) fs.unlinkSync(this.lockPath(repo));
    } catch {
      // nada a liberar
    }
  }


  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.releaseLock();
    this.statusBar.dispose();
  }
}

function runShell(cmd: string, cwd: string, timeout: number): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => {
    exec(cmd, { cwd, timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout}${stderr}` });
    });
  });
}
