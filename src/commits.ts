import * as path from 'path';
import * as vscode from 'vscode';
import { createWorktree, pickBranch } from './actions';
import type { Controller } from './controller';
import { gitUri } from './diff';
import { t } from './i18n';

/** Ações sobre um commit do histórico (botão direito ou duplo clique numa linha do grafo). */

async function info(ctl: Controller, sha: string) {
  const out = await ctl.repo!.exec(['show', '-s', '--format=%H%x1f%s%x1f%b%x1f%an%x1f%P', sha]);
  const [full, subject, body, author, parents] = out.trim().split('\x1f');
  return { full, subject, body: body?.trim() ?? '', author, parents: parents ? parents.split(' ') : [] };
}

/** Arquivos alterados no commit; Enter abre o diff contra o pai, e a lista continua aberta. */
export async function showCommit(ctl: Controller, sha: string) {
  const repo = ctl.repo!;
  const c = await info(ctl, sha);
  const parent = c.parents[0];
  const files = (await repo.exec(['show', '--format=', '--name-status', '--no-renames', '-m', '--first-parent', sha]))
    .split(/\r?\n/)
    .filter(Boolean)
    .map(l => {
      const [st, ...rest] = l.split('\t');
      return { status: st[0], file: rest.join('\t') };
    });
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { file: string; status: string }>();
  qp.title = `${sha.slice(0, 7)} ${c.subject} — ${c.author}`;
  qp.placeholder = files.length ? t('{0} file(s); Enter opens the diff', files.length) : t('Commit with no file changes');
  qp.ignoreFocusOut = true;
  const label: Record<string, string> = { A: t('added'), M: t('modified'), D: t('deleted'), T: t('type changed') };
  qp.items = files.map(f => ({ label: path.basename(f.file), description: `${path.dirname(f.file) === '.' ? '' : path.dirname(f.file)}  ${label[f.status] ?? f.status}`, file: f.file, status: f.status }));
  qp.onDidAccept(() => {
    const it = qp.selectedItems[0];
    if (!it) return;
    const left = !parent || it.status === 'A' ? gitUri(repo.root, '__empty__', it.file) : gitUri(repo.root, parent, it.file);
    const right = it.status === 'D' ? gitUri(repo.root, '__empty__', it.file) : gitUri(repo.root, sha, it.file);
    vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(it.file)} (${sha.slice(0, 7)})`, { preview: true, preserveFocus: true });
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

/** Worktree onde aplicar algo "na branch": pergunta entre as worktrees com branch. */
async function pickWorktree(ctl: Controller, title: string) {
  const wts = (await ctl.repo!.worktreesFast()).filter(w => w.branch && !w.prunable);
  const pick = await vscode.window.showQuickPick(
    wts.map(w => ({ label: w.branch!, description: w.path, wt: w })),
    { title },
  );
  return pick?.wt;
}

export async function revertCommit(ctl: Controller, sha: string) {
  const c = await info(ctl, sha);
  const wt = await pickWorktree(ctl, t('Revert {0} "{1}" on which branch?', sha.slice(0, 7), c.subject));
  if (!wt) return;
  const st = await ctl.repo!.status(wt.path);
  if (st.changes || st.operation) {
    vscode.window.showWarningMessage(t('The worktree of {0} has changes or an operation in progress; commit or stash first.', wt.branch!));
    return;
  }
  const args = ['revert', '--no-edit', ...(c.parents.length > 1 ? ['-m', '1'] : []), sha];
  const r = await ctl.repo!.run(args, wt.path, 120_000);
  if (r.code === 0) {
    vscode.window.showInformationMessage(t('Commit {0} reverted on {1}.', sha.slice(0, 7), wt.branch!));
  } else {
    const conflicts = await ctl.repo!.conflictedFiles(wt.path);
    const openFiles = t('Open files');
    const abort = t('Abort revert');
    const pick = await vscode.window.showWarningMessage(
      conflicts.length ? t('Conflict while reverting on {0} ({1} file(s)); the revert is still in progress.', wt.branch!, conflicts.length) : t('Revert failed: {0}', (r.stderr || r.stdout).trim()),
      ...(conflicts.length ? [openFiles, abort] : []),
    );
    if (pick === openFiles) for (const f of conflicts.slice(0, 20)) await vscode.window.showTextDocument(vscode.Uri.file(path.join(wt.path, f)), { preview: false });
    if (pick === abort) await ctl.repo!.run(['revert', '--abort'], wt.path);
  }
  ctl.scheduleRefresh(50);
}

/** Volta a branch até o commit. --keep preserva alterações não commitadas que não conflitam. */
export async function resetTo(ctl: Controller, sha: string) {
  const repo = ctl.repo!;
  const wt = await pickWorktree(ctl, t('Reset which branch to {0}?', sha.slice(0, 7)));
  if (!wt?.branch) return;
  const contains = (await repo.run(['merge-base', '--is-ancestor', sha, wt.branch])).code === 0;
  if (!contains) {
    vscode.window.showWarningMessage(t('{0} is not part of {1}.', sha.slice(0, 7), wt.branch));
    return;
  }
  const lost = (await repo.exec(['rev-list', '--count', `${sha}..${wt.branch}`])).trim();
  const backup = `refs/worktree-graph/backup/${wt.branch}/${Date.now()}`;
  const typed = await vscode.window.showInputBox({
    title: t('Reset {0} to {1}', wt.branch, sha.slice(0, 7)),
    prompt: t('{0} commit(s) will leave the branch (a backup stays at {1}). Type the branch name to confirm.', lost, backup),
    ignoreFocusOut: true,
    validateInput: v => (v === wt.branch ? undefined : t('Type {0}', wt.branch!)),
  });
  if (typed !== wt.branch) return;
  await repo.exec(['update-ref', backup, wt.branch]);
  const r = await repo.run(['reset', '--keep', sha], wt.path);
  if (r.code !== 0) {
    vscode.window.showErrorMessage(t('Could not reset (are there conflicting changes?): {0}', (r.stderr || r.stdout).trim()));
    return;
  }
  ctl.log(t('reset --keep {0} → {1} (backup at {2})', wt.branch, sha, backup));
  const undo = await vscode.window.showInformationMessage(t('{0} was reset to {1}.', wt.branch, sha.slice(0, 7)), t('Undo'));
  if (undo) await repo.run(['reset', '--keep', backup], wt.path);
  ctl.scheduleRefresh(50);
}

export async function branchAt(ctl: Controller, sha: string) {
  const names = new Set((await ctl.repo!.refs()).filter(r => r.kind === 'head').map(r => r.name));
  const name = await vscode.window.showInputBox({
    title: t('New branch at {0} (no worktree)', sha.slice(0, 7)),
    validateInput: v => (!v.trim() ? t('Enter a name.') : names.has(v) ? t('That branch already exists.') : /[\s~^:?*[\\]|\.\.|@\{/.test(v) ? t('Invalid name.') : undefined),
  });
  if (!name) return;
  await ctl.repo!.exec(['branch', name, sha]);
  const go = await vscode.window.showInformationMessage(t('Branch {0} created at {1}.', name, sha.slice(0, 7)), t('Create a worktree for it'));
  if (go) await createWorktree(ctl, { existing: name });
  ctl.scheduleRefresh(50);
}

export async function tagAt(ctl: Controller, sha: string) {
  const name = await vscode.window.showInputBox({ title: t('Tag at {0}', sha.slice(0, 7)), prompt: t('Name (e.g. v1.2.0)'), validateInput: v => (/^[^\s~^:?*[\\]+$/.test(v) ? undefined : t('Invalid name.')) });
  if (!name) return;
  const msg = await vscode.window.showInputBox({ title: t('Tag {0}', name), prompt: t('Message (empty = lightweight tag)') });
  if (msg === undefined) return;
  await ctl.repo!.exec(msg ? ['tag', '-a', name, '-m', msg, sha] : ['tag', name, sha]);
  vscode.window.showInformationMessage(t('Tag {0} created. To push it: git push origin {0}.', name));
  ctl.scheduleRefresh(50);
}

export function commitUrl(r: { kind: string; webBase: string; projectPath: string }, sha: string): string {
  return r.kind === 'gitlab' ? `${r.webBase}/${r.projectPath}/-/commit/${sha}` : `${r.webBase}/${r.projectPath}/commit/${sha}`;
}

export async function openCommitOnWeb(ctl: Controller, sha: string) {
  const r = await ctl.requests.detectRemote();
  if (!r) {
    vscode.window.showWarningMessage(t('The remote is not a recognized GitHub or GitLab.'));
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(commitUrl(r, sha)));
}

export async function explainCommit(ctl: Controller, sha: string) {
  const c = await info(ctl, sha);
  const branch = await pickBranch(ctl, undefined, t('Open the agent in which worktree to explain {0}?', sha.slice(0, 7)), true);
  if (!branch) return;
  const prompt = [
    t('Explain commit {0} ("{1}", by {2}).', c.full, c.subject, c.author),
    t('Run `git show {0}` to see the diff. Say what changed, why (from the code context), risks and what to test.', c.full),
    t('Do not change any file.'),
  ].join('\n');
  await vscode.commands.executeCommand('worktreeGraph.launchAgentWithPrompt', { branch, prompt });
}

export async function copyMessage(ctl: Controller, sha: string) {
  const c = await info(ctl, sha);
  await vscode.env.clipboard.writeText(c.body ? `${c.subject}\n\n${c.body}` : c.subject);
  vscode.window.setStatusBarMessage(t('Commit message copied'), 2500);
}

export interface CommitDetails {
  sha: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authorDate: number;
  committer: string;
  committerEmail: string;
  committerDate: number;
  message: string;
  /** Arquivos alterados em relação ao primeiro pai, com +/− (binário: -1). */
  files: { path: string; status: string; added: number; deleted: number }[];
}

/** Detalhes para o painel expandido do histórico: dois processos git, sob demanda. */
export async function commitDetails(ctl: Controller, sha: string): Promise<CommitDetails> {
  const repo = ctl.repo!;
  const [meta, numstat, names] = await Promise.all([
    repo.exec(['show', '-s', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B', sha]),
    repo.exec(['show', '--format=', '--numstat', '--no-renames', '-m', '--first-parent', sha]),
    repo.exec(['show', '--format=', '--name-status', '--no-renames', '-m', '--first-parent', sha]),
  ]);
  const [full, parents, an, ae, at, cn, ce, ct, ...msg] = meta.split('\x1f');
  const status = new Map<string, string>();
  for (const l of names.split(/\r?\n/)) {
    const [st, ...rest] = l.split('\t');
    if (st && rest.length) status.set(rest.join('\t'), st[0]);
  }
  const files = numstat
    .split(/\r?\n/)
    .filter(Boolean)
    .map(l => {
      const [a, d, ...rest] = l.split('\t');
      const p = rest.join('\t');
      return { path: p, status: status.get(p) ?? 'M', added: a === '-' ? -1 : Number(a), deleted: d === '-' ? -1 : Number(d) };
    });
  return {
    sha: full.trim(),
    parents: parents ? parents.trim().split(' ').filter(Boolean) : [],
    author: an,
    authorEmail: ae,
    authorDate: Number(at),
    committer: cn,
    committerEmail: ce,
    committerDate: Number(ct),
    message: msg.join('\x1f').trim(),
    files,
  };
}

/** Diff de um arquivo do commit contra o pai (clique na lista do painel de detalhes). */
export async function openCommitFile(ctl: Controller, sha: string, parent: string | undefined, file: string, status: string) {
  const root = ctl.repo!.root;
  const left = !parent || status === 'A' ? gitUri(root, '__empty__', file) : gitUri(root, parent, file);
  const right = status === 'D' ? gitUri(root, '__empty__', file) : gitUri(root, sha, file);
  await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(file)} (${sha.slice(0, 7)})`, { preview: true });
}
