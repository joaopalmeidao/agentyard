import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Controller } from '../controller';
import { pLimit } from '../git';
import { t } from '../i18n';
import { describePlan, needsAttention, needsRechain } from './core';
import { checkMigrations, MigrationCheck } from './scan';

export { checkMigrations, MigrationCheck } from './scan';

/** Num merge de `source` em `target`, quem se reencadeia é a branch de trabalho, nunca a base. */
export async function rechainSideOf(ctl: Controller, source: string, target: string): Promise<{ branch: string; onto: string }> {
  const { base, baseRef } = ctl.state ?? (await ctl.base());
  const sourceIsBase = source === base || source === baseRef || /^(origin|upstream)\//.test(source);
  return sourceIsBase ? { branch: target, onto: source } : { branch: source, onto: target };
}

/** Reencadeia na worktree da branch (criada se preciso). Devolve true se aplicou. */
export async function applyRechain(ctl: Controller, check: MigrationCheck, opts: { commit: boolean; quiet?: boolean }): Promise<boolean> {
  const repo = ctl.repo;
  if (!repo || !needsRechain(check.plan)) return false;
  const { branch, onto, plan } = check;
  const fail = (msg: string) => {
    ctl.log(t('Migrations of {0}: {1}', branch, msg));
    if (!opts.quiet) vscode.window.showErrorMessage(t('Did not rechain the migrations of {0}: {1}', branch, msg));
    return false;
  };

  let wt = (await repo.worktreesFast()).find(w => w.branch === branch && !w.prunable)?.path;
  if (!wt) {
    const { createWorktree } = await import('../actions');
    wt = await createWorktree(ctl, { existing: branch, quiet: true });
    if (!wt) return false;
  }
  const head = await repo.revParse('HEAD', wt);
  if (head !== check.branchSha) return fail(t('the branch moved since the check; check again.'));
  const st = await repo.status(wt);
  if (st.operation) return fail(t('the worktree is in the middle of a {0}.', st.operation));
  const touched = new Set([...plan.renames.flatMap(r => [r.from, r.to]), ...plan.writes.map(w => w.path)]);
  const dirty = (st.files ?? []).map(([, f]) => f.replace(/\\/g, '/')).filter(f => touched.has(f));
  if (dirty.length) return fail(t('there are uncommitted changes in {0}.', dirty.join(', ')));
  const clash = plan.renames.find(r => fs.existsSync(path.join(wt!, r.to)));
  if (clash) return fail(t('{0} already exists.', clash.to));

  for (const r of plan.renames) {
    const mv = await repo.run(['mv', r.from, r.to], wt);
    if (mv.code !== 0) return fail((mv.stderr || mv.stdout).trim());
  }
  for (const w of plan.writes) {
    const file = path.join(wt, w.path);
    // Mantém o fim de linha que está no disco (autocrlf).
    const crlf = fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('\r\n');
    fs.writeFileSync(file, crlf ? w.content.replace(/\r?\n/g, '\r\n') : w.content);
  }
  const paths = [...touched];
  await repo.run(['add', '-A', '--', ...paths], wt);
  const summary = describePlan(plan);
  ctl.log(`${t('Migrations of {0} rechained after {1}:', branch, onto)}\n${summary.join('\n')}`);
  if (opts.commit) {
    const msg = `${t('Rechain migrations after {0}', onto)}\n\n${summary.join('\n')}`;
    const c = await repo.run(['commit', '-m', msg, '--', ...paths], wt);
    if (c.code !== 0) return fail(t('the commit failed: {0}', (c.stderr || c.stdout).trim()));
  }
  ctl.scheduleRefresh(100);
  return true;
}

/**
 * Antes de um merge: se as migrations colidem, oferece reencadear. true = pode seguir com o merge.
 * Usado por actions.mergeBranches.
 */
export async function migrationGate(ctl: Controller, source: string, target: string): Promise<boolean> {
  const repo = ctl.repo;
  if (!repo || !ctl.cfg().get<boolean>('migrations.checkOnMerge', true)) return true;
  const side = await rechainSideOf(ctl, source, target);
  const check = await checkMigrations(repo, side.branch, side.onto).catch(() => undefined);
  if (!check || !needsAttention(check.plan)) return true;
  const can = needsRechain(check.plan);
  const rechainMerge = t('Rechain and merge');
  const mergeAnyway = t('Merge anyway');
  const pick = await vscode.window.showWarningMessage(
    t('The migrations of {0} collide with those of {1}.', side.branch, side.onto),
    {
      modal: true,
      detail: [
        ...describePlan(check.plan),
        '',
        can ? t('"Rechain" makes a commit on {0} with the changes above and continues with the merge.', side.branch) : t('Resolve it by hand before merging.'),
      ].join('\n'),
    },
    ...(can ? [rechainMerge] : []),
    mergeAnyway,
  );
  if (pick === mergeAnyway) return true;
  if (pick !== rechainMerge) return false;
  return applyRechain(ctl, check, { commit: true });
}

/** Pergunta e reencadeia uma branch sobre `onto` (a base, se não vier). */
async function rechainCommand(ctl: Controller, branch: string, onto?: string) {
  const repo = ctl.repo;
  if (!repo) return;
  onto ??= (await ctl.base()).baseRef;
  const check = await checkMigrations(repo, branch, onto);
  if (!check) {
    vscode.window.showErrorMessage(t('Could not compare {0} with {1}.', branch, onto));
    return;
  }
  if (!needsAttention(check.plan)) {
    vscode.window.showInformationMessage(
      check.plan.groups.length ? t('The migrations of {0} already come after those of {1}.', branch, onto) : t('{0} has not added migrations since {1}.', branch, onto),
    );
    return;
  }
  if (!needsRechain(check.plan)) {
    vscode.window.showWarningMessage(t('The migrations of {0} need manual adjustment.', branch), { modal: true, detail: describePlan(check.plan).join('\n') });
    return;
  }
  const andCommit = t('Rechain and commit');
  const pick = await vscode.window.showInformationMessage(
    t('Rechain the migrations of {0} after those of {1}?', branch, onto),
    { modal: true, detail: describePlan(check.plan).join('\n') },
    andCommit,
    t('Rechain only'),
  );
  if (!pick) return;
  if (await applyRechain(ctl, check, { commit: pick === andCommit })) {
    vscode.window.showInformationMessage(
      pick === andCommit ? t('Migrations of {0} rechained after {1}.', branch, onto) : t('Migrations of {0} rechained after {1} (no commit).', branch, onto),
    );
  }
}

/** Confere todas as worktrees contra a base e lista as que colidem. */
async function checkAll(ctl: Controller) {
  const repo = ctl.repo;
  if (!repo) return;
  const { base, baseRef } = await ctl.base();
  const branches = (await repo.worktreesFast()).map(w => w.branch).filter((b): b is string => !!b && b !== base);
  const limit = pLimit(4);
  const found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Checking migrations against {0}…', baseRef) }, () =>
    Promise.all(branches.map(b => limit(() => checkMigrations(repo, b, baseRef).catch(() => undefined)))),
  );
  const bad = found.filter((c): c is MigrationCheck => !!c && needsAttention(c.plan));
  if (!bad.length) {
    vscode.window.showInformationMessage(t('None of the {0} worktree(s) has migrations colliding with {1}.', branches.length, baseRef));
    return;
  }
  const pick = await vscode.window.showQuickPick(
    bad.map(c => ({
      label: c.branch,
      description: needsRechain(c.plan) ? t('can be rechained') : t('manual adjustment'),
      detail: describePlan(c.plan).join(' · '),
      check: c,
    })),
    { title: t('Migrations colliding with {0}', baseRef), placeHolder: t('Choose a branch to rechain') },
  );
  if (pick) await rechainCommand(ctl, pick.check.branch, baseRef);
}

export function registerMigrations(ctx: vscode.ExtensionContext, ctl: Controller) {
  const branchOf = (item?: string | { branch?: string }) => (typeof item === 'string' ? item : item?.branch);
  ctx.subscriptions.push(
    vscode.commands.registerCommand('worktreeGraph.checkMigrations', () => checkAll(ctl)),
    vscode.commands.registerCommand('worktreeGraph.rechainMigrations', async (item?: string | { branch?: string }, onto?: string) => {
      let branch = branchOf(item);
      if (!branch) {
        const { pickBranch } = await import('../actions');
        branch = await pickBranch(ctl, undefined, t('Rechain the migrations of which branch?'), true);
      }
      if (branch) await rechainCommand(ctl, branch, onto);
    }),
  );
}
