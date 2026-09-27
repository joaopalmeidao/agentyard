import * as vscode from 'vscode';
import type { Controller } from './controller';
import { guardForce, guardPush } from './guards';
import type { RemoteTrack } from './git';
export { parseTrack } from './git';

/** Pasta onde rodar comandos da branch: a worktree dela, ou a raiz do repositório. */
async function cwdOf(ctl: Controller, branch: string) {
  const wts = await ctl.repo!.worktreesFast();
  return wts.find(w => w.branch === branch)?.path ?? ctl.repo!.root;
}

/**
 * Push de uma branch: `push -u` se ainda não está publicada. Se o remoto recusar (alguém enviou
 * antes), oferece trazer as mudanças e tentar de novo, ou forçar com --force-with-lease.
 * Devolve true se no fim a branch está no remoto.
 */
export async function pushBranch(ctl: Controller, branch: string, opts: { quiet?: boolean } = {}): Promise<boolean> {
  const repo = ctl.repo;
  if (!repo) return false;
  const remote = ctl.cfg().get<string>('remote', 'origin');
  const upstream = await repo.upstream(branch);
  if (upstream) {
    const [, ahead] = await repo.aheadBehind(upstream, branch);
    if (ahead === 0) {
      if (!opts.quiet) vscode.window.showInformationMessage(`${branch} já está em dia com ${upstream}.`);
      return true;
    }
  }
  // branch protegida e checagens antes de enviar (src/guards.ts)
  if (!(await guardPush(ctl, branch))) return false;
  const run = (extra: string[]) =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `git push ${remote} ${branch}…` }, () =>
      repo.run(['push', ...extra, remote, `refs/heads/${branch}:refs/heads/${branch}`], repo.root, 300_000),
    );
  let r = await run(upstream ? [] : ['-u']);
  if (r.code === 0) {
    if (!upstream) await repo.run(['branch', `--set-upstream-to=${remote}/${branch}`, branch]);
    return done(ctl, branch, remote, opts.quiet, !upstream);
  }

  const err = (r.stderr || r.stdout).trim();
  const rejected = /rejected|non-fast-forward|fetch first|stale info/i.test(err);
  if (!rejected || opts.quiet) {
    if (!opts.quiet) vscode.window.showErrorMessage(`O push de ${branch} falhou: ${err}`);
    ctl.log(`push ${branch} falhou: ${err}`);
    return false;
  }

  const pick = await vscode.window.showWarningMessage(
    `O remoto recusou o push de ${branch}: ele tem commits que a sua branch não tem.`,
    { modal: true, detail: 'Trazer do remoto faz um merge local e tenta de novo. Forçar sobrescreve o remoto, mas só se ninguém tiver enviado nada além do que você já viu (--force-with-lease).' },
    'Trazer do remoto e tentar de novo',
    'Forçar (--force-with-lease)',
  );
  if (!pick) return false;
  if (pick.startsWith('Forçar')) {
    if (!(await guardForce(ctl, branch))) return false;
    r = await run(['--force-with-lease']);
    if (r.code === 0) return done(ctl, branch, remote, false, false);
    vscode.window.showErrorMessage(`Nem o push forçado passou (o remoto mudou de novo?): ${(r.stderr || r.stdout).trim()}`);
    return false;
  }
  const cwd = await cwdOf(ctl, branch);
  const hasWorktree = cwd !== repo.root || (await repo.worktreesFast())[0]?.branch === branch;
  if (!hasWorktree) {
    vscode.window.showWarningMessage(`${branch} não está aberta numa worktree; crie uma para trazer as mudanças do remoto.`);
    return false;
  }
  const pull = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Trazendo ${remote}/${branch}…` }, () =>
    repo.run(['pull', '--no-rebase', '--no-edit', remote, branch], cwd, 300_000),
  );
  if (pull.code !== 0) {
    const conflicts = await repo.conflictedFiles(cwd);
    vscode.window.showErrorMessage(
      conflicts.length
        ? `Conflito ao trazer ${remote}/${branch} (${conflicts.length} arquivo(s)). Resolva na worktree e faça o push de novo.`
        : `Não consegui trazer ${remote}/${branch}: ${(pull.stderr || pull.stdout).trim()}`,
    );
    ctl.scheduleRefresh(50);
    return false;
  }
  r = await run([]);
  if (r.code === 0) return done(ctl, branch, remote, false, false);
  vscode.window.showErrorMessage(`O push de ${branch} falhou de novo: ${(r.stderr || r.stdout).trim()}`);
  return false;
}

function done(ctl: Controller, branch: string, remote: string, quiet: boolean | undefined, published: boolean) {
  ctl.log(`push ${remote} ${branch}: ok${published ? ' (publicada)' : ''}`);
  ctl.scheduleRefresh(50);
  if (!quiet) vscode.window.setStatusBarMessage(`$(cloud-upload) ${branch} ${published ? 'publicada em' : 'enviada para'} ${remote}`, 4000);
  return true;
}

/** Lista as branches com commits não enviados (ou não publicadas), já marcadas, e envia as escolhidas. */
export async function pushMany(ctl: Controller) {
  const s = ctl.state;
  if (!s || !ctl.repo) return;
  type Cand = { name: string; track: RemoteTrack; wt: boolean; date: number };
  const cands: Cand[] = [
    ...s.worktrees.filter(w => w.branch && !w.prunable).map(w => ({ name: w.branch!, track: w.remote, wt: true, date: w.date })),
    ...s.branches.map(b => ({ name: b.name, track: b.remote, wt: false, date: b.date })),
  ].filter(c => c.track && (c.track.ahead > 0 || !c.track.published));
  if (!cands.length) {
    vscode.window.showInformationMessage('Nenhuma branch com commits para enviar.');
    return;
  }
  const items = cands
    .sort((a, b) => Number(b.track.published) - Number(a.track.published) || b.date - a.date)
    .map(c => ({
      label: c.name,
      description: [
        c.track.published ? `↑${c.track.ahead} não enviado(s)` : c.track.gone ? 'apagada no remoto' : 'não publicada',
        c.track.behind ? `↓${c.track.behind} no remoto` : '',
        c.wt ? 'worktree' : '',
      ]
        .filter(Boolean)
        .join(' · '),
      // publicadas com commits pendentes já vêm marcadas; publicar branch nova é decisão caso a caso
      picked: c.track.published && c.track.ahead > 0,
      name: c.name,
    }));
  const chosen = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    matchOnDescription: true,
    title: `Enviar branches: ${items.filter(i => i.picked).length} marcadas (publicadas com commits pendentes)`,
    placeHolder: 'Marque as branches para enviar; as não publicadas ganham upstream (push -u)',
  });
  if (!chosen?.length) return;
  const ok: string[] = [];
  const failed: string[] = [];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Enviando branches', cancellable: true }, async (progress, token) => {
    for (const c of chosen) {
      if (token.isCancellationRequested) break;
      progress.report({ message: `${c.name} (${ok.length + failed.length + 1}/${chosen.length})`, increment: 100 / chosen.length });
      ((await pushBranch(ctl, c.name, { quiet: true })) ? ok : failed).push(c.name);
    }
  });
  ctl.scheduleRefresh(50);
  if (failed.length) {
    const pick = await vscode.window.showWarningMessage(
      `${ok.length} enviada(s); ${failed.length} recusada(s): ${failed.join(', ')}. Envie essas uma a uma para escolher entre trazer do remoto ou forçar.`,
      'Ver log',
    );
    if (pick) ctl.out.show();
  } else {
    vscode.window.showInformationMessage(`${ok.length} branch(es) enviada(s).`);
  }
}
