import * as vscode from 'vscode';
import type { Controller } from './controller';
import { discoverCiBranches } from './ciBranches';
import { flowStages } from './flow';
import { guardForce, guardPush } from './guards';
import { t } from './i18n';
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
  // gatilho "push" do sync automático: traz a base para a branch antes de enviar (src/sync.ts)
  await ctl.beforePush?.(branch);
  const remote = ctl.remoteName();
  const upstream = await repo.upstream(branch);
  if (upstream) {
    const [, ahead] = await repo.aheadBehind(upstream, branch);
    if (ahead === 0) {
      if (!opts.quiet) vscode.window.showInformationMessage(t('{0} is already up to date with {1}.', branch, upstream));
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
    if (!opts.quiet) vscode.window.showErrorMessage(t('Push of {0} failed: {1}', branch, err));
    ctl.log(t('push {0} failed: {1}', branch, err));
    return false;
  }

  const force = t('Force (--force-with-lease)');
  const pick = await vscode.window.showWarningMessage(
    t('The remote rejected the push of {0}: it has commits your branch does not have.', branch),
    { modal: true, detail: t('Pull from remote does a local merge and tries again. Force overwrites the remote, but only if nobody pushed anything beyond what you have already seen (--force-with-lease).') },
    t('Pull from remote and try again'),
    force,
  );
  if (!pick) return false;
  if (pick === force) {
    if (!(await guardForce(ctl, branch))) return false;
    r = await run(['--force-with-lease']);
    if (r.code === 0) return done(ctl, branch, remote, false, false);
    vscode.window.showErrorMessage(t('Even the forced push failed (did the remote change again?): {0}', (r.stderr || r.stdout).trim()));
    return false;
  }
  const cwd = await cwdOf(ctl, branch);
  const hasWorktree = cwd !== repo.root || (await repo.worktreesFast())[0]?.branch === branch;
  if (!hasWorktree) {
    vscode.window.showWarningMessage(t('{0} is not open in a worktree; create one to pull the changes from the remote.', branch));
    return false;
  }
  const pull = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Pulling {0}…', `${remote}/${branch}`) }, () =>
    repo.run(['pull', '--no-rebase', '--no-edit', remote, branch], cwd, 300_000),
  );
  if (pull.code !== 0) {
    const conflicts = await repo.conflictedFiles(cwd);
    vscode.window.showErrorMessage(
      conflicts.length
        ? t('Conflict while pulling {0} ({1} file(s)). Resolve it in the worktree and push again.', `${remote}/${branch}`, conflicts.length)
        : t('Could not pull {0}: {1}', `${remote}/${branch}`, (pull.stderr || pull.stdout).trim()),
    );
    ctl.scheduleRefresh(50);
    return false;
  }
  r = await run([]);
  if (r.code === 0) return done(ctl, branch, remote, false, false);
  vscode.window.showErrorMessage(t('Push of {0} failed again: {1}', branch, (r.stderr || r.stdout).trim()));
  return false;
}

function done(ctl: Controller, branch: string, remote: string, quiet: boolean | undefined, published: boolean) {
  ctl.log(`push ${remote} ${branch}: ok${published ? ` ${t('(published)')}` : ''}`);
  ctl.scheduleRefresh(50);
  if (!quiet) vscode.window.setStatusBarMessage(`$(cloud-upload) ${published ? t('{0} published to {1}', branch, remote) : t('{0} pushed to {1}', branch, remote)}`, 4000);
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
    vscode.window.showInformationMessage(t('No branches with commits to push.'));
    return;
  }
  const items = cands
    .sort((a, b) => Number(b.track.published) - Number(a.track.published) || b.date - a.date)
    .map(c => ({
      label: c.name,
      description: [
        c.track.published ? t('↑{0} not pushed', c.track.ahead) : c.track.gone ? t('deleted on remote') : t('not published'),
        c.track.behind ? t('↓{0} on remote', c.track.behind) : '',
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
    title: t('Push branches: {0} selected (published with pending commits)', items.filter(i => i.picked).length),
    placeHolder: t('Select the branches to push; unpublished ones get an upstream (push -u)'),
  });
  if (chosen?.length) await pushList(ctl, chosen.map(c => c.name));
}

/** Envia as branches uma a uma (sem perguntar nada); no fim, resume o que passou e o que foi recusado. */
async function pushList(ctl: Controller, names: string[]) {
  const ok: string[] = [];
  const failed: string[] = [];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Pushing branches'), cancellable: true }, async (progress, token) => {
    for (const name of names) {
      if (token.isCancellationRequested) break;
      progress.report({ message: `${name} (${ok.length + failed.length + 1}/${names.length})`, increment: 100 / names.length });
      ((await pushBranch(ctl, name, { quiet: true })) ? ok : failed).push(name);
    }
  });
  ctl.scheduleRefresh(50);
  if (failed.length) {
    const pick = await vscode.window.showWarningMessage(
      t('{0} pushed; {1} rejected: {2}. Push those one by one to choose between pulling from the remote or forcing.', ok.length, failed.length, failed.join(', ')),
      t('View log'),
    );
    if (pick) ctl.out.show();
  } else {
    vscode.window.showInformationMessage(t('{0} branch(es) pushed.', ok.length));
  }
}

type Local = { name: string; track: RemoteTrack; wt: boolean; date: number };

/** Branches locais (com e sem worktree), sem repetir. */
function localBranches(ctl: Controller): Local[] {
  const s = ctl.state;
  if (!s) return [];
  const seen = new Set<string>();
  return [
    ...s.worktrees.filter(w => w.branch && !w.prunable).map(w => ({ name: w.branch!, track: w.remote, wt: true, date: w.date })),
    ...s.branches.map(b => ({ name: b.name, track: b.remote, wt: false, date: b.date })),
  ].filter(c => c.track && !seen.has(c.name) && seen.add(c.name));
}

/** Marcadas por padrão: a base e as branches que o CI usa (arquivos de CI, fluxo de ambientes, worktreeGraph.ciBranches). */
export function defaultPushBranches(ctl: Controller): string[] {
  const s = ctl.state;
  if (!s || !ctl.repo) return [];
  const heads = localBranches(ctl).map(b => b.name);
  const ci = discoverCiBranches(ctl.repo.root, {
    base: s.base,
    flow: flowStages(ctl).map(f => f.branch),
    extras: ctl.cfg().get<string[]>('ciBranches', []),
    existing: heads,
  }).map(b => b.name);
  return [...new Set([s.base, ...ci])].filter(b => heads.includes(b));
}

const trackText = (tr: RemoteTrack) =>
  [
    tr.published ? (tr.ahead ? t('↑{0} not pushed', tr.ahead) : t('up to date')) : tr.gone ? t('deleted on remote') : t('not published'),
    tr.behind ? t('↓{0} on remote', tr.behind) : '',
  ]
    .filter(Boolean)
    .join(' · ');

/** Push das branches escolhidas: lista todas as locais, com a base e as de CI já marcadas. */
export async function pushSelected(ctl: Controller) {
  if (!ctl.state || !ctl.repo) return;
  const defaults = new Set(defaultPushBranches(ctl));
  const pending = (tr: RemoteTrack) => tr.ahead > 0 || !tr.published;
  const all = localBranches(ctl).sort(
    (a, b) => Number(defaults.has(b.name)) - Number(defaults.has(a.name)) || Number(pending(b.track)) - Number(pending(a.track)) || b.date - a.date,
  );
  const item = (c: Local) => ({
    label: c.name,
    description: [trackText(c.track), c.wt ? 'worktree' : ''].filter(Boolean).join(' · '),
    picked: defaults.has(c.name),
    name: c.name,
  });
  const marked = all.filter(c => defaults.has(c.name));
  const rest = all.filter(c => !defaults.has(c.name));
  const items: (vscode.QuickPickItem & { name?: string })[] = [
    ...(marked.length ? [{ label: t('Base and CI'), kind: vscode.QuickPickItemKind.Separator }, ...marked.map(item)] : []),
    ...(rest.length ? [{ label: t('Other branches'), kind: vscode.QuickPickItemKind.Separator }, ...rest.map(item)] : []),
  ];
  const chosen = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    matchOnDescription: true,
    title: t('Push selected branches'),
    placeHolder: t('Selected: the base and the CI branches. Up-to-date ones are skipped; unpublished ones get an upstream (push -u)'),
  });
  if (!chosen?.length) return;
  const byName = new Map(all.map(c => [c.name, c]));
  const send = chosen.map(c => c.name!).filter(n => n && pending(byName.get(n)!.track));
  const skipped = chosen.length - send.length;
  if (!send.length) {
    vscode.window.showInformationMessage(
      skipped === 1 ? t('The chosen branch is already up to date with the remote.') : t('The chosen branches are already up to date with the remote.'),
    );
    return;
  }
  if (skipped) ctl.log(t('push selected: {0} already up to date, skipped', skipped));
  await pushList(ctl, send);
}

/** Botão "☁ Push" na barra de status: abre o push das branches selecionadas e mostra quantas da base/CI têm o que enviar. */
export class PushStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 48);
  private readonly subs: vscode.Disposable[];

  constructor(private readonly ctl: Controller) {
    this.item.name = t('Branch push');
    this.item.command = 'worktreeGraph.pushSelected';
    this.subs = [
      ctl.onDidChange(() => this.update()),
      vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('worktreeGraph') && this.update()),
    ];
    this.update();
  }

  private update() {
    const s = this.ctl.state;
    if (!s || !this.ctl.cfg().get<boolean>('pushStatusBar', true)) return this.item.hide();
    const defaults = new Set(defaultPushBranches(this.ctl));
    const branches = localBranches(this.ctl);
    const waiting = branches.filter(b => defaults.has(b.name) && b.track.published && b.track.ahead > 0);
    const others = branches.filter(b => !defaults.has(b.name) && b.track.published && b.track.ahead > 0).length;
    this.item.text = `$(cloud-upload) Push${waiting.length ? ` ${waiting.length}` : ''}`;
    const tip = new vscode.MarkdownString(undefined, true);
    tip.appendMarkdown(`**${t('Push selected branches')}**\n\n`);
    tip.appendMarkdown(t('Already selected: {0} (base and CI).', [...defaults].map(b => `\`${b}\``).join(', ') || t('no branches')) + '\n\n');
    tip.appendMarkdown(
      waiting.length
        ? t('With commits to push: {0}', waiting.map(b => `\`${b.name}\` ↑${b.track.ahead}`).join(', '))
        : t('Base and CI up to date with the remote.'),
    );
    if (others) tip.appendMarkdown('\n\n' + t('+{0} other branch(es) with commits to push.', others));
    this.item.tooltip = tip;
    this.item.show();
  }

  dispose() {
    this.subs.forEach(d => d.dispose());
    this.item.dispose();
  }
}
