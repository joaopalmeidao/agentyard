import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Controller } from '../controller';
import { pLimit } from '../git';
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
    ctl.log(`Migrations de ${branch}: ${msg}`);
    if (!opts.quiet) vscode.window.showErrorMessage(`Não reencadeei as migrations de ${branch}: ${msg}`);
    return false;
  };

  let wt = (await repo.worktreesFast()).find(w => w.branch === branch && !w.prunable)?.path;
  if (!wt) {
    const { createWorktree } = await import('../actions');
    wt = await createWorktree(ctl, { existing: branch, quiet: true });
    if (!wt) return false;
  }
  const head = await repo.revParse('HEAD', wt);
  if (head !== check.branchSha) return fail('a branch andou desde a checagem; confira de novo.');
  const st = await repo.status(wt);
  if (st.operation) return fail(`a worktree está no meio de um ${st.operation}.`);
  const touched = new Set([...plan.renames.flatMap(r => [r.from, r.to]), ...plan.writes.map(w => w.path)]);
  const dirty = (st.files ?? []).map(([, f]) => f.replace(/\\/g, '/')).filter(f => touched.has(f));
  if (dirty.length) return fail(`há alterações não commitadas em ${dirty.join(', ')}.`);
  const clash = plan.renames.find(r => fs.existsSync(path.join(wt!, r.to)));
  if (clash) return fail(`${clash.to} já existe.`);

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
  ctl.log(`Migrations de ${branch} reencadeadas após ${onto}:\n${summary.join('\n')}`);
  if (opts.commit) {
    const msg = `Reencadeia migrations após ${onto}\n\n${summary.join('\n')}`;
    const c = await repo.run(['commit', '-m', msg, '--', ...paths], wt);
    if (c.code !== 0) return fail(`o commit falhou: ${(c.stderr || c.stdout).trim()}`);
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
  const pick = await vscode.window.showWarningMessage(
    `As migrations de ${side.branch} colidem com as de ${side.onto}.`,
    {
      modal: true,
      detail: [
        ...describePlan(check.plan),
        '',
        can ? `"Reencadear" faz um commit em ${side.branch} com as mudanças acima e segue com o merge.` : 'Resolva à mão antes de mesclar.',
      ].join('\n'),
    },
    ...(can ? ['Reencadear e mesclar'] : []),
    'Mesclar assim mesmo',
  );
  if (pick === 'Mesclar assim mesmo') return true;
  if (pick !== 'Reencadear e mesclar') return false;
  return applyRechain(ctl, check, { commit: true });
}

/** Pergunta e reencadeia uma branch sobre `onto` (a base, se não vier). */
async function rechainCommand(ctl: Controller, branch: string, onto?: string) {
  const repo = ctl.repo;
  if (!repo) return;
  onto ??= (await ctl.base()).baseRef;
  const check = await checkMigrations(repo, branch, onto);
  if (!check) {
    vscode.window.showErrorMessage(`Não consegui comparar ${branch} com ${onto}.`);
    return;
  }
  if (!needsAttention(check.plan)) {
    vscode.window.showInformationMessage(
      check.plan.groups.length ? `As migrations de ${branch} já vêm depois das de ${onto}.` : `${branch} não adicionou migrations desde ${onto}.`,
    );
    return;
  }
  if (!needsRechain(check.plan)) {
    vscode.window.showWarningMessage(`As migrations de ${branch} precisam de ajuste manual.`, { modal: true, detail: describePlan(check.plan).join('\n') });
    return;
  }
  const pick = await vscode.window.showInformationMessage(
    `Reencadear as migrations de ${branch} depois das de ${onto}?`,
    { modal: true, detail: describePlan(check.plan).join('\n') },
    'Reencadear e commitar',
    'Só reencadear',
  );
  if (!pick) return;
  if (await applyRechain(ctl, check, { commit: pick === 'Reencadear e commitar' })) {
    vscode.window.showInformationMessage(`Migrations de ${branch} reencadeadas após ${onto}${pick === 'Só reencadear' ? ' (sem commit)' : ''}.`);
  }
}

/** Confere todas as worktrees contra a base e lista as que colidem. */
async function checkAll(ctl: Controller) {
  const repo = ctl.repo;
  if (!repo) return;
  const { base, baseRef } = await ctl.base();
  const branches = (await repo.worktreesFast()).map(w => w.branch).filter((b): b is string => !!b && b !== base);
  const limit = pLimit(4);
  const found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Conferindo migrations contra ${baseRef}…` }, () =>
    Promise.all(branches.map(b => limit(() => checkMigrations(repo, b, baseRef).catch(() => undefined)))),
  );
  const bad = found.filter((c): c is MigrationCheck => !!c && needsAttention(c.plan));
  if (!bad.length) {
    vscode.window.showInformationMessage(`Nenhuma das ${branches.length} worktree(s) tem migrations colidindo com ${baseRef}.`);
    return;
  }
  const pick = await vscode.window.showQuickPick(
    bad.map(c => ({
      label: c.branch,
      description: needsRechain(c.plan) ? 'dá para reencadear' : 'ajuste manual',
      detail: describePlan(c.plan).join(' · '),
      check: c,
    })),
    { title: `Migrations que colidem com ${baseRef}`, placeHolder: 'Escolha uma branch para reencadear' },
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
        branch = await pickBranch(ctl, undefined, 'Reencadear as migrations de qual branch?', true);
      }
      if (branch) await rechainCommand(ctl, branch, onto);
    }),
  );
}
