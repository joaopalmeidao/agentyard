import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { formatBytes } from './env/core';
import { bytesOf } from './env/register';
import { agentsLabel } from './agents';
import { Controller } from './controller';
import { resolveButton, runResolve } from './conflicts';
import { gitUri } from './diff';
import { guardMerge } from './guards';
import { migrationGate } from './migrations/register';
import { Repo, Worktree } from './git';
import { t } from './i18n';

type BranchArg = string | { branch?: string } | undefined;

function repoOf(ctl: Controller): Repo {
  if (!ctl.repo) throw new Error(t('No git repository open in this workspace.'));
  return ctl.repo;
}

/** Aceita nome de branch (webview), item da árvore ou nada (paleta → QuickPick). */
export async function pickBranch(ctl: Controller, arg: BranchArg, placeHolder: string, onlyWorktrees = false): Promise<string | undefined> {
  if (typeof arg === 'string') return arg;
  if (arg?.branch) return arg.branch;
  const repo = repoOf(ctl);
  const wts = await repo.worktreesFast();
  const items: vscode.QuickPickItem[] = wts
    .filter(w => w.branch)
    .map(w => ({ label: w.branch!, description: w.path, iconPath: new vscode.ThemeIcon('folder') }));
  if (!onlyWorktrees) {
    const withWt = new Set(items.map(i => i.label));
    for (const r of await repo.refs()) {
      if (r.kind === 'head' && !withWt.has(r.name)) items.push({ label: r.name, description: t('no worktree'), iconPath: new vscode.ThemeIcon('git-branch') });
    }
  }
  return (await vscode.window.showQuickPick(items, { placeHolder }))?.label;
}

async function worktreeOf(repo: Repo, branch: string): Promise<Worktree | undefined> {
  return (await repo.worktreesFast()).find(w => w.branch === branch);
}

/**
 * Mescla `source` em `target`. Se `target` estiver aberta numa worktree, o merge acontece lá
 * (conflitos ficam para resolver). Se não, usa uma worktree temporária e desiste ao primeiro conflito.
 */
export async function mergeBranches(ctl: Controller, source: string, target: string, opts: { confirm?: boolean; quiet?: boolean } = {}): Promise<boolean> {
  const repo = repoOf(ctl);
  const { base } = await ctl.base();
  if (source === target) return false;

  const [targetAhead, sourceAhead] = await repo.aheadBehind(target, source);
  if (sourceAhead === 0) {
    vscode.window.showInformationMessage(t('{0} already contains everything from {1}.', target, source));
    return false;
  }
  // Migrations que colidem não dão conflito no git: confere e oferece reencadear (src/migrations).
  if (opts.confirm !== false && !(await migrationGate(ctl, source, target))) return false;
  if (opts.confirm !== false) {
    const preview = await repo.mergePreview(target, source);
    const detail = [
      t('{0} commit(s) from {1} will go into {2}.', sourceAhead, source, target),
      targetAhead === 0 ? t('This will be a fast-forward.') : '',
      preview?.conflict
        ? t('⚠ The simulation predicts conflicts in: {0}', `${preview.files.slice(0, 8).join(', ')}${preview.files.length > 8 ? '…' : ''}`)
        : preview
          ? t('The simulation found no conflicts.')
          : '',
    ]
      .filter(Boolean)
      .join('\n');
    const mergeBtn = t('Merge');
    const analyzeBtn = t('Analyze first');
    const ok = await vscode.window.showInformationMessage(t('Merge {0} into {1}?', source, target), { modal: true, detail }, mergeBtn, analyzeBtn);
    if (ok === analyzeBtn) {
      await vscode.commands.executeCommand('worktreeGraph.analyzeMerge', source, target);
      return false;
    }
    if (ok !== mergeBtn) return false;
  }

  // branch protegida e checagens (src/guards.ts)
  if (!(await guardMerge(ctl, source, target))) return false;

  const noFf = target === base && ctl.cfg().get('noFastForwardIntoBase', true);
  const args = ['merge', '--no-edit', ...(noFf ? ['--no-ff'] : []), source];
  const wt = await worktreeOf(repo, target);

  try {
    if (wt) {
      const st = await repo.status(wt.path);
      if (st.operation) {
        vscode.window.showErrorMessage(t('The {0} worktree is in the middle of a {1}. Finish or abort it first.', target, st.operation));
        return false;
      }
      if (st.changes > 0) {
        const go = await vscode.window.showWarningMessage(
          t('The {0} worktree has {1} uncommitted change(s).', target, st.changes),
          { modal: true, detail: t('Git refuses the merge if it touches those files. If an agent is working in it, better wait for its commit.') },
          t('Merge anyway'),
        );
        if (!go) return false;
      }
      ctl.log(t('git {0}  (in {1})', args.join(' '), wt.path));
      const r = await repo.run(args, wt.path, 300_000);
      if (r.code === 0) {
        await afterMerge(ctl, source, target, base, opts.quiet);
        return true;
      }
      const conflicts = await repo.conflictedFiles(wt.path);
      if (conflicts.length === 0) {
        vscode.window.showErrorMessage(t('Merge failed: {0}', (r.stderr || r.stdout).trim()));
        return false;
      }
      const openFiles = t('Open files');
      const openWt = t('Open worktree');
      const abort = t('Abort merge');
      const pick = await vscode.window.showWarningMessage(
        t('Conflict merging {0} into {1} ({2} file(s)). The merge is still in progress in the worktree.', source, target, conflicts.length),
        resolveButton(ctl),
        openFiles,
        openWt,
        abort,
      );
      if (pick === resolveButton(ctl)) {
        await runResolve(target, { base: source });
      } else if (pick === openFiles) {
        for (const f of conflicts.slice(0, 20)) await vscode.window.showTextDocument(vscode.Uri.file(path.join(wt.path, f)), { preview: false });
      } else if (pick === openWt) {
        await openWorktree(ctl, target);
      } else if (pick === abort) {
        await repo.run(['merge', '--abort'], wt.path);
      }
      return false;
    }

    const tmp = path.join(os.tmpdir(), `wtgraph-${process.pid}-${Date.now()}`);
    await repo.exec(['worktree', 'add', '--quiet', tmp, target]);
    try {
      ctl.log(t('git {0}  (in temporary worktree {1})', args.join(' '), tmp));
      const r = await repo.run(args, tmp, 300_000);
      if (r.code === 0) {
        await afterMerge(ctl, source, target, base, opts.quiet);
        return true;
      }
      const conflicts = await repo.conflictedFiles(tmp);
      await repo.run(['merge', '--abort'], tmp);
      const pick = await vscode.window.showWarningMessage(
        conflicts.length
          ? t('Conflict merging {0} into {1}: {2}. Nothing was changed.', source, target, conflicts.slice(0, 5).join(', '))
          : t('Merge failed: {0}', (r.stderr || r.stdout).trim()),
        ...(conflicts.length ? [resolveButton(ctl)] : []),
        t('Create a worktree for {0} to resolve it', target),
      );
      // Mesclando na base: quem resolve é a branch, trazendo a base; senão, o destino traz a origem.
      if (pick === resolveButton(ctl)) await (target === base ? runResolve(source, { intoBase: true }) : runResolve(target, { base: source }));
      else if (pick) await createWorktree(ctl, { existing: target });
      return false;
    } finally {
      await repo.removeWorktree(tmp, true);
    }
  } finally {
    ctl.scheduleRefresh(100);
  }
}

async function afterMerge(ctl: Controller, source: string, target: string, base: string, quiet?: boolean) {
  ctl.log(t('{0} merged into {1}.', source, target));
  if (quiet) return;
  if (target === base && source !== base) {
    const repo = repoOf(ctl);
    const wt = await worktreeOf(repo, source);
    const removeBoth = t('Remove worktree and branch');
    const delBranch = t('Delete branch');
    const pick = await vscode.window.showInformationMessage(t('{0} merged into {1}.', source, target), wt ? removeBoth : delBranch);
    if (pick === removeBoth) await removeWorktree(ctl, source, { alsoBranch: true });
    else if (pick === delBranch) await deleteBranch(ctl, source);
  } else {
    vscode.window.showInformationMessage(t('{0} merged into {1}.', source, target));
  }
}

export async function mergeBaseInto(ctl: Controller, arg: BranchArg) {
  const branch = await pickBranch(ctl, arg, t('Bring the base into which branch?'));
  if (!branch) return;
  const { baseRef } = await ctl.base();
  await mergeBranches(ctl, baseRef, branch);
}

export async function mergeIntoBase(ctl: Controller, arg: BranchArg) {
  const branch = await pickBranch(ctl, arg, t('Merge which branch into the base?'));
  if (!branch) return;
  const { base } = await ctl.base();
  await mergeBranches(ctl, branch, base);
}

export async function mergeInto(ctl: Controller, arg: BranchArg) {
  const source = await pickBranch(ctl, arg, t('Merge which branch?'));
  if (!source) return;
  const repo = repoOf(ctl);
  const items = (await repo.refs())
    .filter(r => r.kind === 'head' && r.name !== source)
    .map(r => ({ label: r.name, description: r.subject }));
  const target = await vscode.window.showQuickPick(items, { placeHolder: t('Merge {0} into…', source) });
  if (target) await mergeBranches(ctl, source, target.label);
}

/** Escolhe a branch de origem de uma nova worktree; a base vem primeiro (Enter = base). */
export async function pickStartPoint(ctl: Controller, title: string): Promise<string | undefined> {
  const repo = repoOf(ctl);
  const { base } = await ctl.base();
  const refs = await repo.refs();
  const wtBranches = new Set((await repo.worktreesFast()).map(w => w.branch).filter(Boolean));
  type Item = vscode.QuickPickItem & { ref?: string };
  const heads = refs.filter(r => r.kind === 'head' && r.name !== base);
  const items: Item[] = [
    { label: `$(home) ${base}`, description: 'base', detail: refs.find(r => r.kind === 'head' && r.name === base)?.subject, ref: base },
    { label: t('Local branches'), kind: vscode.QuickPickItemKind.Separator },
    ...heads.map(r => ({ label: `${wtBranches.has(r.name) ? '$(folder)' : '$(git-branch)'} ${r.name}`, description: wtBranches.has(r.name) ? t('has a worktree') : undefined, detail: r.subject, ref: r.name })),
    { label: t('Remote'), kind: vscode.QuickPickItemKind.Separator },
    ...refs.filter(r => r.kind === 'remote').map(r => ({ label: `$(cloud) ${r.name}`, detail: r.subject, ref: r.name })),
  ];
  return (await vscode.window.showQuickPick(items, { title, placeHolder: t('Create the worktree from which branch?'), matchOnDetail: true }))?.ref;
}

/**
 * `branch`: nome já decidido (sem perguntar); `quiet`: sem a notificação final.
 * Devolve a pasta criada.
 */
/** Chamados depois de criar uma worktree (src/env: .env, portas e setup). */
export const worktreeCreatedHooks: ((dir: string, branch: string, quiet: boolean) => Promise<void>)[] = [];

export async function createWorktree(
  ctl: Controller,
  opts: { startPoint?: string; existing?: string; branch?: string; quiet?: boolean } = {},
): Promise<string | undefined> {
  const repo = repoOf(ctl);
  const { base } = await ctl.base();
  let branch = opts.existing ?? opts.branch;
  let startPoint = opts.startPoint;
  if (!branch && !startPoint) {
    startPoint = await pickStartPoint(ctl, t('New worktree (1/2)'));
    if (!startPoint) return;
  }
  if (!branch) {
    const names = new Set((await repo.refs()).filter(r => r.kind === 'head').map(r => r.name));
    branch = await vscode.window.showInputBox({
      title: opts.startPoint ? t('New worktree from {0}', opts.startPoint) : t('New worktree (2/2) — from {0}', startPoint ?? base),
      prompt: t('Branch name (e.g. ai/refactor-login)'),
      validateInput: v => {
        if (!v.trim()) return t('Enter a name.');
        if (/[\s~^:?*[\\]|\.\.|@\{|\/$|^\/|\.lock$/.test(v)) return t('Invalid branch name.');
        if (names.has(v)) return t('That branch already exists.');
        return undefined;
      },
    });
    if (!branch) return;
  }
  const configured = ctl.cfg().get<string>('worktreeRoot', '');
  const mainPath = (await repo.worktreesFast())[0]?.path ?? repo.root;
  const root = configured || path.join(path.dirname(mainPath), `${path.basename(mainPath)}.worktrees`);
  let dir = path.join(root, branch.replace(/[\/\\]/g, '-'));
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(root, `${branch.replace(/[\/\\]/g, '-')}-${i}`);

  const args = opts.existing ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, startPoint ?? base];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Creating worktree {0}…', branch) }, () => repo.exec(args, repo.root, 300_000));
  ctl.log(t('Worktree created: {0} ({1})', dir, branch));
  ctl.scheduleRefresh(100);

  const post = ctl.cfg().get<string>('postCreateCommand', '');
  if (post) {
    const term = vscode.window.createTerminal({ name: `${branch}: setup`, cwd: dir });
    term.show(true);
    term.sendText(post);
  }
  for (const hook of worktreeCreatedHooks) {
    try {
      await hook(dir, branch, !!opts.quiet);
    } catch (e) {
      ctl.log(t('After creating {0}: {1}', branch, (e as Error).message));
    }
  }
  if (opts.quiet) return dir;
  const openWin = t('Open in new window');
  const openTerm = t('Open terminal');
  const pick = await vscode.window.showInformationMessage(t('Worktree {0} created at {1}.', branch, dir), openWin, openTerm);
  if (pick === openWin) await openWorktree(ctl, branch);
  else if (pick === openTerm) await openTerminal(ctl, branch);
  return dir;
}

export async function openWorktree(ctl: Controller, arg: BranchArg | { path?: string }) {
  const p = typeof arg === 'object' && arg && 'path' in arg && arg.path ? arg.path : undefined;
  const target = p ?? (await worktreeOf(repoOf(ctl), (await pickBranch(ctl, arg as BranchArg, t('Open which worktree?'), true)) ?? ''))?.path;
  if (target) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: true });
}

export async function openTerminal(ctl: Controller, arg: BranchArg | { path?: string }) {
  const p = typeof arg === 'object' && arg && 'path' in arg && arg.path ? arg.path : undefined;
  const branch = p ? undefined : await pickBranch(ctl, arg as BranchArg, t('Open a terminal in which worktree?'), true);
  const cwd = p ?? (branch ? (await worktreeOf(repoOf(ctl), branch))?.path : undefined);
  if (!cwd) return;
  const term = vscode.window.createTerminal({ name: branch ?? path.basename(cwd), cwd });
  term.show();
}

export async function removeWorktree(ctl: Controller, arg: BranchArg, opts: { alsoBranch?: boolean } = {}) {
  const repo = repoOf(ctl);
  const branch = await pickBranch(ctl, arg, t('Remove which worktree?'), true);
  if (!branch) return;
  const wt = await worktreeOf(repo, branch);
  if (!wt) return;
  if (wt.isMain) {
    vscode.window.showErrorMessage(t('The main worktree cannot be removed.'));
    return;
  }
  const open = (vscode.workspace.workspaceFolders ?? []).some(f => path.normalize(f.uri.fsPath).toLowerCase() === wt.path.toLowerCase());
  const st = await repo.status(wt.path);
  const detail = [
    wt.path,
    st.changes ? t('⚠ {0} uncommitted change(s) will be LOST.', st.changes) : t('No pending changes.'),
    open ? t('⚠ This window has that worktree open.') : '',
  ]
    .filter(Boolean)
    .join('\n');
  const removeBoth = t('Remove worktree and branch');
  const actions = opts.alsoBranch ? [removeBoth] : [t('Remove worktree'), removeBoth];
  const pick = await vscode.window.showWarningMessage(t('Remove the {0} worktree?', branch), { modal: true, detail }, ...actions);
  if (!pick) return;
  const r = await repo.removeWorktree(wt.path, st.changes > 0);
  if (r.code !== 0) {
    vscode.window.showErrorMessage(t('Could not remove: {0}', r.stderr.trim()));
    return;
  }
  ctl.log(t('Worktree removed: {0}', wt.path));
  if (pick === removeBoth) await deleteBranch(ctl, branch, { skipConfirm: true });
  ctl.scheduleRefresh(100);
}

export async function deleteBranch(ctl: Controller, arg: BranchArg, opts: { skipConfirm?: boolean } = {}) {
  const repo = repoOf(ctl);
  const branch = await pickBranch(ctl, arg, t('Delete which branch?'));
  if (!branch) return;
  if (await worktreeOf(repo, branch)) {
    vscode.window.showErrorMessage(t('{0} is open in a worktree. Remove the worktree first.', branch));
    return;
  }
  if (!opts.skipConfirm) {
    const ok = await vscode.window.showWarningMessage(t('Delete branch {0}?', branch), { modal: true }, t('Delete'));
    if (!ok) return;
  }
  let r = await repo.run(['branch', '-d', branch]);
  if (r.code !== 0) {
    const force = await vscode.window.showWarningMessage(
      t('{0} has commits that are not in any merged branch.', branch),
      { modal: true, detail: r.stderr.trim() },
      t('Delete anyway (-D)'),
    );
    if (!force) return;
    r = await repo.run(['branch', '-D', branch]);
    if (r.code !== 0) {
      vscode.window.showErrorMessage(r.stderr.trim());
      return;
    }
  }
  ctl.log(t('Branch deleted: {0}', branch));
  ctl.scheduleRefresh(100);
}

/** QuickPick com os arquivos alterados na branch desde que saiu da base; cada item abre um diff. */
export async function diffWithBase(ctl: Controller, arg: BranchArg) {
  const repo = repoOf(ctl);
  const branch = await pickBranch(ctl, arg, t('Review which branch?'));
  if (!branch) return;
  const { baseRef } = await ctl.base();
  const mb = (await repo.exec(['merge-base', baseRef, branch])).trim();
  const wt = await worktreeOf(repo, branch);
  const cwd = wt?.path ?? repo.root;

  const diffArgs = wt ? ['diff', '--name-status', '--no-renames', mb] : ['diff', '--name-status', '--no-renames', mb, branch];
  const files = (await repo.exec(diffArgs, cwd))
    .split(/\r?\n/)
    .filter(Boolean)
    .map(l => {
      const [status, ...rest] = l.split('\t');
      return { status: status[0], file: rest.join('\t') };
    });
  if (wt) {
    const untracked = (await repo.exec(['ls-files', '--others', '--exclude-standard'], cwd)).split(/\r?\n/).filter(Boolean);
    files.push(...untracked.map(file => ({ status: '?', file })));
  }
  if (files.length === 0) {
    vscode.window.showInformationMessage(t('{0} has no changes compared to {1}.', branch, baseRef));
    return;
  }
  const label: Record<string, string> = { A: t('added'), M: t('modified'), D: t('deleted'), '?': t('untracked'), T: t('type changed') };
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { file: string; status: string }>();
  qp.title = wt
    ? t('{0} × {1} — {2} file(s) (includes uncommitted changes)', branch, baseRef, files.length)
    : t('{0} × {1} — {2} file(s)', branch, baseRef, files.length);
  qp.placeholder = t('Enter opens the diff; the list stays open for the next file');
  qp.ignoreFocusOut = true;
  qp.items = files.map(f => ({ label: f.file, description: label[f.status] ?? f.status, file: f.file, status: f.status }));
  qp.onDidAccept(async () => {
    const it = qp.selectedItems[0];
    if (!it) return;
    const left = gitUri(cwd, mb, it.file);
    const right = wt ? vscode.Uri.file(path.join(wt.path, it.file)) : gitUri(cwd, branch, it.file);
    const rightUri = it.status === 'D' ? gitUri(cwd, '__empty__', it.file) : right;
    await vscode.commands.executeCommand('vscode.diff', left, rightUri, `${path.basename(it.file)} (${baseRef} ↔ ${branch})`, { preview: true, preserveFocus: true });
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

/** Arquivos não commitados (staged, não staged e não rastreados), com status A, M, D ou ?. */
export async function uncommittedFiles(repo: Repo, cwd: string): Promise<{ file: string; status: string }[]> {
  const out = await repo.exec(['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'], cwd);
  return out
    .split('\0')
    .filter(Boolean)
    .map(e => {
      const xy = e.slice(0, 2);
      const status = xy === '??' ? '?' : xy.includes('D') ? 'D' : xy.includes('A') ? 'A' : xy.includes('T') ? 'T' : 'M';
      return { file: e.slice(3), status };
    });
}

/** Diff de um arquivo não commitado: HEAD ↔ o que está no disco. */
export function uncommittedDiffArgs(cwd: string, file: string, status: string, name: string, opts: { preserveFocus?: boolean; preview?: boolean } = {}): unknown[] {
  const left = status === 'A' || status === '?' ? gitUri(cwd, '__empty__', file) : gitUri(cwd, 'HEAD', file);
  const right = status === 'D' ? gitUri(cwd, '__empty__', file) : vscode.Uri.file(path.join(cwd, file));
  return [left, right, t('{0} ({1}: uncommitted)', path.basename(file), name), { preview: opts.preview ?? true, preserveFocus: opts.preserveFocus }];
}

function openUncommittedDiff(cwd: string, file: string, status: string, name: string, opts: { preserveFocus?: boolean; preview?: boolean } = {}) {
  return vscode.commands.executeCommand('vscode.diff', ...uncommittedDiffArgs(cwd, file, status, name, opts));
}

/** Lista o que não foi commitado numa worktree (inclusive a da base) e abre o diff de cada arquivo. */
export async function showUncommitted(ctl: Controller, arg: BranchArg | { path?: string }) {
  const repo = repoOf(ctl);
  const wts = (await repo.worktreesFast()).filter(w => !w.bare && !w.prunable);
  let dir = typeof arg === 'object' && arg && 'path' in arg && arg.path ? arg.path : undefined;
  const b = typeof arg === 'string' ? arg : (arg as { branch?: string } | undefined)?.branch;
  if (!dir && b) dir = wts.find(w => w.branch === b)?.path;
  if (!dir) {
    const withChanges = (ctl.state?.worktrees ?? []).filter(w => w.changes && !w.prunable);
    const list = withChanges.length ? withChanges.map(w => ({ label: w.name, description: `●${w.changes}  ${w.path}`, p: w.path })) : wts.map(w => ({ label: w.branch ?? path.basename(w.path), description: w.path, p: w.path }));
    dir = (await vscode.window.showQuickPick(list, { placeHolder: t('Uncommitted changes of which worktree?') }))?.p;
    if (!dir) return;
  }
  const cwd = dir;
  const name = wts.find(w => w.path.toLowerCase() === cwd.toLowerCase())?.branch ?? path.basename(cwd);
  const files = await uncommittedFiles(repo, cwd);
  if (!files.length) {
    vscode.window.showInformationMessage(t('{0} has no uncommitted changes.', name));
    return;
  }
  const label: Record<string, string> = { A: t('added'), M: t('modified'), D: t('deleted'), '?': t('new, untracked'), T: t('type changed') };
  type Item = vscode.QuickPickItem & { file?: string; status?: string; all?: boolean; patch?: boolean; window?: boolean; terminal?: boolean };
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = t('{0} — {1} uncommitted file(s)', name, files.length);
  qp.placeholder = t('Enter opens the diff; the list stays open for the next file');
  qp.ignoreFocusOut = true;
  qp.matchOnDescription = true;
  qp.items = [
    { label: `$(diff-multiple) ${t('Open all diffs')}`, description: files.length > 30 ? t('the first 30') : undefined, all: true },
    { label: `$(file-code) ${t('View full patch')}`, description: t('all in a single document'), patch: true },
    { label: `$(empty-window) ${t('Open the worktree in a new window')}`, window: true },
    { label: `$(terminal) ${t('Open a terminal in the worktree')}`, terminal: true },
    { label: t('Files'), kind: vscode.QuickPickItemKind.Separator },
    ...files.map(f => ({
      label: path.basename(f.file),
      description: `${path.dirname(f.file) === '.' ? '' : path.dirname(f.file)}  ${label[f.status] ?? f.status}`,
      file: f.file,
      status: f.status,
    })),
  ];
  qp.onDidAccept(async () => {
    const it = qp.selectedItems[0];
    if (!it) return;
    if (it.all) {
      qp.hide();
      for (const f of files.slice(0, 30)) await openUncommittedDiff(cwd, f.file, f.status, name, { preview: false });
    } else if (it.patch) {
      qp.hide();
      await vscode.commands.executeCommand('worktreeGraph.showUncommittedPatch', { path: cwd });
    } else if (it.window) {
      qp.hide();
      await openWorktree(ctl, { path: cwd });
    } else if (it.terminal) {
      qp.hide();
      await openTerminal(ctl, { path: cwd });
    } else if (it.file) {
      await openUncommittedDiff(cwd, it.file, it.status!, name, { preserveFocus: true });
    }
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

/**
 * Nova worktree a partir de uma branch escolhida (a base por padrão) e já com uma tarefa para o agente.
 * `arg` com branch (item da árvore, card do grafo) ou `startPoint` pula a escolha da origem.
 */
export async function newWorktreeWithTask(ctl: Controller, arg?: string | { branch?: string; startPoint?: string; prompt?: string; name?: string; agent?: string }) {
  const repo = repoOf(ctl);
  const o = typeof arg === 'string' ? { branch: arg } : (arg ?? {});
  let from = o.startPoint ?? o.branch;
  if (!from) {
    from = await pickStartPoint(ctl, t('New worktree with task (1/3)'));
    if (!from) return;
  }
  const prompt =
    o.prompt ??
    (await vscode.window.showInputBox({
      title: t('New worktree with task (2/3) — from {0}', from),
      prompt: t('What should the agent do in the new worktree?'),
      ignoreFocusOut: true,
    }));
  if (!prompt?.trim()) return;
  const names = new Set((await repo.refs()).filter(r => r.kind === 'head').map(r => r.name));
  const { slugify } = await import('./agentFlow/attempts');
  let suggestion = `ai/${slugify(prompt) || 'tarefa'}`;
  for (let i = 2; names.has(suggestion); i++) suggestion = `ai/${slugify(prompt) || 'tarefa'}-${i}`;
  const branch =
    o.name ??
    (await vscode.window.showInputBox({
    title: t('New worktree with task (3/3) — from {0}', from),
    prompt: t('New branch name'),
    value: suggestion,
    ignoreFocusOut: true,
    validateInput: v => {
      if (!v.trim()) return t('Enter a name.');
      if (/[\s~^:?*[\\]|\.\.|@\{|\/$|^\/|\.lock$/.test(v)) return t('Invalid branch name.');
      if (names.has(v)) return t('That branch already exists.');
      return undefined;
    },
  }));
  if (!branch) return;
  const dir = await createWorktree(ctl, { branch, startPoint: from, quiet: true });
  if (!dir) return;
  await vscode.commands.executeCommand('worktreeGraph.launchAgentWithPrompt', { path: dir, branch, prompt: prompt.trim(), agent: o.agent });
}

export async function copyText(text: string) {
  await vscode.env.clipboard.writeText(text);
  vscode.window.setStatusBarMessage(t('Copied: {0}', text), 2500);
}

/** Busca e abre qualquer arquivo de outra worktree sem trocar de janela. */
export async function openFileInWorktree(ctl: Controller, arg: BranchArg | { path?: string }) {
  const repo = repoOf(ctl);
  let dir = typeof arg === 'object' && arg && 'path' in arg && arg.path ? arg.path : undefined;
  let label = dir ? path.basename(dir) : '';
  if (!dir) {
    const wts = (await repo.worktreesFast()).filter(w => !w.bare && !w.prunable);
    const byArg = typeof arg === 'string' ? wts.find(w => w.branch === arg) : undefined;
    const pick =
      byArg ??
      (await vscode.window.showQuickPick(
        wts.map(w => ({ label: w.branch ?? path.basename(w.path), description: w.path, wt: w })),
        { placeHolder: t('Files from which worktree?') },
      ))?.wt;
    if (!pick) return;
    dir = pick.path;
    label = pick.branch ?? path.basename(pick.path);
  }
  const files = (await repo.exec(['ls-files', '--cached', '--others', '--exclude-standard'], dir)).split(/\r?\n/).filter(Boolean);
  const chosen = await vscode.window.showQuickPick(
    files.map(f => ({ label: path.basename(f), description: path.dirname(f) === '.' ? '' : path.dirname(f), file: f })),
    { placeHolder: t('Open a file from {0} ({1} files)', label, files.length), matchOnDescription: true },
  );
  if (chosen) await vscode.window.showTextDocument(vscode.Uri.file(path.join(dir, chosen.file)), { preview: true });
}

export async function toggleFavorite(ctl: Controller, arg: BranchArg | { path?: string }) {
  const p = typeof arg === 'object' && arg && 'path' in arg && arg.path ? arg.path : undefined;
  const wtPath = p ?? (await worktreeOf(repoOf(ctl), (await pickBranch(ctl, arg as BranchArg, t('Favorite which worktree?'), true)) ?? ''))?.path;
  if (!wtPath) return;
  await ctl.setFavorite(wtPath, !ctl.isFavorite(wtPath));
  ctl.scheduleRefresh(20);
}

/** `git worktree prune`: esquece worktrees cuja pasta já foi apagada. */
export async function pruneWorktrees(ctl: Controller) {
  const repo = repoOf(ctl);
  const orphans = (await repo.worktreesFast()).filter(w => w.prunable);
  if (orphans.length === 0) {
    vscode.window.showInformationMessage(t('No orphaned worktrees.'));
    return;
  }
  const list = orphans
    .slice(0, 12)
    .map(o => `• ${o.branch ?? o.path}`)
    .join('\n');
  const ok = await vscode.window.showWarningMessage(
    t('Forget {0} orphaned worktree(s)?', orphans.length),
    {
      modal: true,
      detail: t(
        'Their folders no longer exist; only the record in .git is deleted (git worktree prune). The branches remain.\n\n{0}',
        list + (orphans.length > 12 ? '\n' + t('… and {0} more', orphans.length - 12) : ''),
      ),
    },
    t('Remove orphans'),
  );
  if (!ok) return;
  await repo.exec(['worktree', 'prune']);
  ctl.log(t('git worktree prune: {0} record(s) removed.', orphans.length));
  vscode.window.showInformationMessage(t('{0} orphaned worktree(s) removed.', orphans.length));
  ctl.scheduleRefresh(50);
}

/**
 * Remoção em lote. Sem `preselected`, abre uma lista com as worktrees já marcadas quando estão
 * mescladas na base, limpas e sem agente aberto.
 */
/**
 * Worktrees que dá para apagar sem perder nada: a branch já está inteira na base e a pasta está
 * limpa. Ficam de fora a principal, a base, favoritas, com agente aberto, protegidas e a desta janela.
 */
export function mergedWorktrees(ctl: Controller) {
  const s = ctl.state;
  if (!s) return { removable: [], dirty: [] };
  const open = new Set((vscode.workspace.workspaceFolders ?? []).map(f => path.normalize(f.uri.fsPath).toLowerCase()));
  const prot = new Set(s.protectedBranches ?? []);
  const merged = s.worktrees.filter(
    w =>
      !w.isMain && !w.isBase && !w.bare && !w.prunable && w.branch && !prot.has(w.branch) &&
      !open.has(w.path.toLowerCase()) && w.compareKnown && w.ahead === 0 && !w.favorite && !w.agents.length,
  );
  return {
    removable: merged.filter(w => w.statusKnown && w.changes === 0 && !w.operation),
    dirty: merged.filter(w => !w.statusKnown || w.changes > 0 || !!w.operation),
  };
}

/** Um clique: remove as worktrees já mescladas na base (e, se quiser, as branches delas). */
/** " Libera ~1,2 GB." quando o espaço já foi calculado (src/env). */
function freed(paths: string[]): string {
  const b = bytesOf(paths);
  return b ? ' ' + t('Frees ~{0}.', formatBytes(b)) : '';
}

export async function removeMerged(ctl: Controller) {
  const s = ctl.state;
  if (!s) return;
  if (s.pending > 0) {
    const go = await vscode.window.showInformationMessage(
      t('Still comparing {0} worktree(s) with {1}; some merged ones may not show up yet.', s.pending, s.base),
      t('Continue anyway'),
    );
    if (!go) return;
  }
  const { removable, dirty } = mergedWorktrees(ctl);
  if (!removable.length) {
    vscode.window.showInformationMessage(
      dirty.length
        ? t('No merged, clean worktrees. {0} merged worktree(s) have uncommitted changes and were left out.', dirty.length)
        : t('No worktrees with a branch already merged into {0}.', s.base),
    );
    return;
  }
  const list = removable.slice(0, 15).map(w => `• ${w.name}`).join('\n') + (removable.length > 15 ? '\n' + t('… and {0} more', removable.length - 15) : '');
  const removeBoth = t('Remove worktrees and branches');
  const chooseBtn = t('Choose from the list…');
  const pick = await vscode.window.showWarningMessage(
    t('Remove {0} worktree(s) already merged into {1}?', removable.length, s.base),
    {
      modal: true,
      detail: [
        t('All are clean and their branches are fully in {0}; nothing is lost.', s.base) + freed(removable.map(w => w.path)),
        list,
        dirty.length ? t('{0} merged worktree(s) with uncommitted changes were left out.', dirty.length) : '',
        t('Favorites, worktrees with an open agent and protected branches are never included.'),
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
    removeBoth,
    t('Remove only the worktrees'),
    chooseBtn,
  );
  if (!pick) return;
  if (pick === chooseBtn) return cleanupWorktrees(ctl);
  const alsoBranch = pick === removeBoth;
  const repo = repoOf(ctl);
  let removed = 0;
  const failed: string[] = [];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Removing merged worktrees'), cancellable: true }, async (progress, token) => {
    for (const w of removable) {
      if (token.isCancellationRequested) break;
      progress.report({ message: `${w.name} (${removed + failed.length + 1}/${removable.length})`, increment: 100 / removable.length });
      // sem --force: se aparecer alteração no meio do caminho, o git recusa e a pasta fica
      const r = await repo.removeWorktree(w.path);
      if (r.code !== 0) {
        failed.push(`${w.name}: ${r.stderr.trim()}`);
        continue;
      }
      removed++;
      if (alsoBranch && w.branch) await repo.run(['branch', '-d', w.branch]);
    }
  });
  ctl.log(t('Remove merged: {0} removed.', removed) + (failed.length ? `\n${failed.join('\n')}` : ''));
  if (failed.length) {
    const see = await vscode.window.showWarningMessage(t('{0} removed; {1} not (see the log).', removed, failed.length), t('View log'));
    if (see) ctl.out.show();
  } else {
    vscode.window.showInformationMessage(alsoBranch ? t('{0} merged worktree(s) removed, along with their branches.', removed) : t('{0} merged worktree(s) removed.', removed));
  }
  ctl.scheduleRefresh(50);
}

/**
 * Branches locais sem worktree já inteiras na base (`git for-each-ref --merged`, conferido na hora).
 * Ficam de fora a base e as protegidas (inclui as do fluxo de ambientes).
 */
export async function mergedBranches(ctl: Controller): Promise<string[]> {
  const s = ctl.state;
  if (!s?.baseSha) return [];
  const repo = repoOf(ctl);
  const r = await repo.run(['for-each-ref', `--merged=${s.baseRef}`, '--format=%(refname:short)', 'refs/heads']);
  if (r.code !== 0) return [];
  const merged = new Set(r.stdout.split(/\r?\n/).filter(Boolean));
  const inWorktree = new Set((await repo.worktreesFast()).map(w => w.branch).filter(Boolean));
  const prot = new Set(s.protectedBranches ?? []);
  return s.branches.map(b => b.name).filter(n => merged.has(n) && n !== s.base && !prot.has(n) && !inWorktree.has(n));
}

/** Um clique: exclui as branches locais sem worktree que já estão inteiras na base. */
export async function removeMergedBranches(ctl: Controller) {
  const s = ctl.state;
  if (!s) return;
  const branches = await mergedBranches(ctl);
  if (!branches.length) {
    vscode.window.showInformationMessage(t('No branches without a worktree already merged into {0}.', s.base));
    return;
  }
  const list = branches.slice(0, 15).map(b => `• ${b}`).join('\n') + (branches.length > 15 ? '\n' + t('… and {0} more', branches.length - 15) : '');
  const chooseBtn = t('Choose from the list…');
  const pick = await vscode.window.showWarningMessage(
    t('Delete {0} branch(es) already merged into {1}?', branches.length, s.base),
    {
      modal: true,
      detail: [
        t('None has a worktree and all their commits are already in {0}; nothing is lost. Only local branches are deleted (remote ones remain).', s.base),
        list,
        t('A branch just created from {0}, with no commits yet, also counts as merged.', s.base),
        t('The base and protected branches are never included.'),
      ].join('\n\n'),
    },
    t('Delete branches'),
    chooseBtn,
  );
  if (!pick) return;
  let chosen = branches;
  if (pick === chooseBtn) {
    const info = new Map(s.branches.map(b => [b.name, b]));
    const picked = await vscode.window.showQuickPick(
      branches.map(b => ({ label: b, description: info.get(b)?.subject ?? '', picked: true })),
      { canPickMany: true, matchOnDescription: true, title: t('Delete branches merged into {0}', s.base), placeHolder: t('Uncheck the ones you want to keep') },
    );
    if (!picked?.length) return;
    chosen = picked.map(p => p.label);
  }
  const repo = repoOf(ctl);
  // Confere de novo: alguma pode ter ganhado commit ou worktree enquanto o diálogo estava aberto.
  const still = new Set(await mergedBranches(ctl));
  const failed: string[] = [];
  let removed = 0;
  for (const b of chosen) {
    if (!still.has(b)) {
      failed.push(t('{0}: no longer merged or now has a worktree', b));
      continue;
    }
    // -D: `-d` compara com o HEAD/upstream, não com a base; a checagem acima já garante que está na base.
    const r = await repo.run(['branch', '-D', b]);
    if (r.code !== 0) failed.push(`${b}: ${r.stderr.trim()}`);
    else removed++;
  }
  ctl.log(t('Delete merged branches: {0} deleted.', removed) + (failed.length ? `\n${failed.join('\n')}` : ''));
  if (failed.length) {
    const see = await vscode.window.showWarningMessage(t('{0} deleted; {1} not (see the log).', removed, failed.length), t('View log'));
    if (see) ctl.out.show();
  } else {
    vscode.window.showInformationMessage(t('{0} merged branch(es) deleted.', removed));
  }
  ctl.scheduleRefresh(50);
}

export async function cleanupWorktrees(ctl: Controller, preselected?: string[]) {
  const repo = repoOf(ctl);
  const s = ctl.state;
  if (!s) return;
  const open = new Set((vscode.workspace.workspaceFolders ?? []).map(f => path.normalize(f.uri.fsPath).toLowerCase()));
  const candidates = s.worktrees.filter(w => !w.isMain && !w.isBase && !w.bare && !w.prunable && !open.has(w.path.toLowerCase()));
  let chosen = candidates.filter(w => preselected?.some(p => p.toLowerCase() === w.path.toLowerCase()));

  if (!preselected) {
    const age = (d: number) => (d ? `${Math.max(1, Math.round((Date.now() / 1000 - d) / 86400))} d` : '');
    const items = candidates.map(w => {
      const merged = w.compareKnown && w.ahead === 0;
      const clean = w.statusKnown && w.changes === 0;
      const tags = [
        merged ? t('merged') : w.compareKnown ? t('↑{0} not in {1}', w.ahead, s.base) : t('comparing…'),
        clean ? t('clean') : w.statusKnown ? t('● {0} change(s)', w.changes) : 'status…',
        w.favorite ? '★' : '',
        w.agents.length ? `✦ ${agentsLabel(w.agents)}` : '',
        age(w.date),
      ].filter(Boolean);
      return { label: w.name, description: tags.join(' · '), detail: w.path, picked: merged && clean && !w.agents.length && !w.favorite, wt: w };
    });
    items.sort((a, b) => Number(b.picked) - Number(a.picked) || a.wt.date - b.wt.date);
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      matchOnDescription: true,
      matchOnDetail: true,
      title: t('Clean up worktrees: {0} already checked (merged into {1}, clean, no agent, not favorites)', items.filter(i => i.picked).length, s.base),
      placeHolder: t('Check the worktrees to remove; type to filter'),
    });
    if (!picked?.length) return;
    chosen = picked.map(p => p.wt);
  }
  if (!chosen.length) return;

  const dirty = chosen.filter(w => w.changes > 0 || !w.statusKnown);
  const unmerged = chosen.filter(w => !(w.compareKnown && w.ahead === 0));
  const detail = [
    dirty.length ? t('⚠ {0} with uncommitted changes (or no status yet): they will be LOST.', dirty.length) : t('All clean.'),
    unmerged.length ? t('{0} have commits not in {1}: their branches are kept even if you ask to delete them.', unmerged.length, s.base) : '',
  ]
    .filter(Boolean)
    .join('\n');
  const removeBoth = t('Remove worktrees and merged branches');
  const pick = await vscode.window.showWarningMessage(t('Remove {0} worktree(s)?', chosen.length), { modal: true, detail }, t('Remove worktrees'), removeBoth);
  if (!pick) return;
  const alsoBranch = pick === removeBoth;

  const failed: string[] = [];
  let removed = 0;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('Removing worktrees'), cancellable: true },
    async (progress, token) => {
      for (const w of chosen) {
        if (token.isCancellationRequested) break;
        progress.report({ message: `${w.name} (${removed + failed.length + 1}/${chosen.length})`, increment: 100 / chosen.length });
        const r = await repo.removeWorktree(w.path, true);
        if (r.code !== 0) {
          failed.push(`${w.name}: ${r.stderr.trim()}`);
          continue;
        }
        removed++;
        if (alsoBranch && w.branch) await repo.run(['branch', '-d', w.branch]);
      }
    },
  );
  ctl.log(t('Cleanup: {0} worktree(s) removed.', removed) + (failed.length ? `\n${t('Failures:')}\n${failed.join('\n')}` : ''));
  if (failed.length) {
    const see = await vscode.window.showWarningMessage(t('{0} removed, {1} failed.', removed, failed.length), t('View log'));
    if (see) ctl.out.show();
  } else {
    vscode.window.showInformationMessage(t('{0} worktree(s) removed.', removed));
  }
  ctl.scheduleRefresh(50);
}
