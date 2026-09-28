import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createWorktree } from '../actions';
import type { Controller } from '../controller';
import { gitUri } from '../diff';
import { Worktree } from '../git';
import { t } from '../i18n';
import { extraTree } from '../treeView';
import {
  buildTodo,
  discardEffect,
  discardSummary,
  movePlan,
  parseNameStatus,
  parseNumstat,
  parseStashList,
  parseStatusPaths,
  parseUncommitted,
  PlanStep,
  RebaseAction,
  StashEntry,
  stashTitle,
  Uncommitted,
  validatePlan,
} from './core';

type Guard = <T extends unknown[]>(fn: (...args: T) => unknown) => (...args: T) => Promise<void>;
type Arg = string | { branch?: string; path?: string; sha?: string; target?: string } | undefined;

const branchOf = (a: Arg) => (typeof a === 'string' ? a : a?.branch);
const short = (sha: string) => sha.slice(0, 7);

function ago(unix: number) {
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

class StashGroup extends vscode.TreeItem {
  readonly kind = 'stashes';
  constructor() {
    super('Stashes', vscode.TreeItemCollapsibleState.Collapsed);
    this.id = 'stashes';
    this.iconPath = new vscode.ThemeIcon('archive');
    this.contextValue = 'stashGroup';
    this.tooltip = t('Changes saved with git stash (shared by all worktrees in the repository)');
  }
}

class StashItem extends vscode.TreeItem {
  readonly kind = 'stash';
  constructor(readonly entry: StashEntry) {
    super(stashTitle(entry), vscode.TreeItemCollapsibleState.None);
    this.id = `stash:${entry.sha}`;
    this.description = [entry.branch, ago(entry.date)].filter(Boolean).join(' · ');
    this.tooltip = `${entry.ref}\n${entry.message}`;
    this.iconPath = new vscode.ThemeIcon('git-stash');
    this.contextValue = 'stash';
    this.command = { command: 'worktreeGraph.stashShow', title: t('Show diff'), arguments: [this] };
  }
}

/** Pull/fetch, stash, cherry-pick, reorganizar commits e comparar worktrees. */
export class GitOps implements vscode.Disposable {
  private fetchTimer?: NodeJS.Timeout;
  private notifiedBehind = '';
  /** branch → ref de segurança do último "Reorganizar commits". */
  readonly backups = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ctl: Controller) {
    this.scheduleFetch();
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('worktreeGraph.fetch') && this.scheduleFetch()));
  }

  private get repo() {
    if (!this.ctl.repo) throw new Error(t('No git repository open.'));
    return this.ctl.repo;
  }

  private remoteName() {
    return this.ctl.cfg().get<string>('remote', 'origin');
  }

  private async worktreeOf(branch: string): Promise<Worktree | undefined> {
    return (await this.repo.worktreesFast()).find(w => w.branch === branch && !w.prunable);
  }

  async pathOf(a: Arg): Promise<{ path: string; branch?: string } | undefined> {
    if (typeof a === 'object' && a?.path) {
      const w = (await this.repo.worktreesFast()).find(x => x.path.toLowerCase() === a.path!.toLowerCase());
      return { path: a.path, branch: a.branch ?? w?.branch };
    }
    const b = branchOf(a);
    if (b) {
      const w = await this.worktreeOf(b);
      return w ? { path: w.path, branch: b } : undefined;
    }
    return this.pickWorktree(t('In which worktree?'));
  }

  async pickWorktree(placeHolder: string, exclude?: string): Promise<{ path: string; branch?: string } | undefined> {
    const wts = (await this.repo.worktreesFast()).filter(w => !w.prunable && !w.bare && w.path.toLowerCase() !== exclude?.toLowerCase());
    const pick = await vscode.window.showQuickPick(
      wts.map(w => ({ label: w.branch ?? path.basename(w.path), description: w.path, w })),
      { placeHolder },
    );
    return pick ? { path: pick.w.path, branch: pick.w.branch } : undefined;
  }

  async pickBranch(placeHolder: string, exclude?: string): Promise<string | undefined> {
    const refs = (await this.repo.refs()).filter(r => r.kind === 'head' && r.name !== exclude);
    const wtBranches = new Set((await this.repo.worktreesFast()).map(w => w.branch));
    const pick = await vscode.window.showQuickPick(
      refs
        .sort((x, y) => Number(wtBranches.has(y.name)) - Number(wtBranches.has(x.name)) || y.date - x.date)
        .map(r => ({ label: r.name, description: wtBranches.has(r.name) ? 'worktree' : '', detail: r.subject })),
      { placeHolder },
    );
    return pick?.label;
  }

  /** Conflito numa operação em andamento: agente, abrir arquivos ou abortar. */
  private async onConflict(op: 'merge' | 'cherry-pick' | 'rebase', wtPath: string, branch: string | undefined, what: string) {
    const files = await this.repo.conflictedFiles(wtPath);
    const agent = this.ctl.cfg().get<{ name: string }[]>('agents', [])[0]?.name ?? 'Claude Code';
    const list = `${files.slice(0, 5).join(', ')}${files.length > 5 ? '…' : ''}`;
    const openFiles = t('Open files');
    const pick = await vscode.window.showWarningMessage(
      branch
        ? t('Conflict while {0} on {1}: {2}. The {3} is still in progress in the worktree.', what, branch, list, op)
        : t('Conflict while {0}: {1}. The {2} is still in progress in the worktree.', what, list, op),
      t('✦ Resolve with {0}', agent),
      openFiles,
      t('Abort {0}', op),
    );
    if (!pick) return;
    if (pick.startsWith('✦')) {
      const prompt = [
        t('In the worktree of branch {0} there is a {1} in progress with conflicts in: {2}.', branch ?? path.basename(wtPath), op, files.join(', ')),
        t('Context: {0}.', what),
        t('Resolve the conflicts preserving the intent of both changes, run the project tests, git add the resolved files and continue with git {0} --continue.', op),
        t('If anything is ambiguous, ask before deciding.'),
      ].join('\n');
      await vscode.commands.executeCommand('worktreeGraph.launchAgentWithPrompt', { path: wtPath, branch, prompt });
    } else if (pick === openFiles) {
      for (const f of files.slice(0, 20)) await vscode.window.showTextDocument(vscode.Uri.file(path.join(wtPath, f)), { preview: false });
    } else {
      await this.repo.run([op, '--abort'], wtPath);
      this.ctl.scheduleRefresh(50);
    }
  }

  // ---------------------------------------------------------------- pull e fetch

  /** Traz o que o remoto tem: ff-only; se divergir, oferece merge ou rebase. Devolve true se ficou em dia. */
  async pull(branch: string, opts: { quiet?: boolean } = {}): Promise<boolean> {
    const repo = this.repo;
    const remote = this.remoteName();
    const upstream = await repo.upstream(branch);
    if (!upstream) {
      if (!opts.quiet) vscode.window.showInformationMessage(t('{0} has not been published yet; there is nothing to pull.', branch));
      return false;
    }
    const remoteBranch = upstream.startsWith(`${remote}/`) ? upstream.slice(remote.length + 1) : upstream.split('/').slice(1).join('/');
    const wt = await this.worktreeOf(branch);
    const progress = <T>(title: string, fn: () => Thenable<T>) =>
      vscode.window.withProgress({ location: opts.quiet ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification, title }, fn);

    if (!wt) {
      // sem worktree: avança a ref local só se for fast-forward (sem "+" no refspec)
      const r = await progress(t('Pulling {0}…', upstream), () => repo.run(['fetch', remote, `refs/heads/${remoteBranch}:refs/heads/${branch}`], repo.root, 300_000));
      if (r.code === 0) return this.pulled(branch, opts.quiet);
      if (!opts.quiet) {
        const go = await vscode.window.showWarningMessage(
          t('{0} and {1} have diverged; without a worktree they cannot be merged here.', branch, upstream),
          t('Create worktree to merge'),
        );
        if (go) {
          await createWorktree(this.ctl, { existing: branch, quiet: true });
          return this.pull(branch);
        }
      }
      this.ctl.log(t('pull {0} (no worktree) failed: {1}', branch, (r.stderr || r.stdout).trim()));
      return false;
    }

    const st = await repo.status(wt.path);
    if (st.operation) {
      if (!opts.quiet) vscode.window.showWarningMessage(t('{0} is in the middle of a {1}; finish or abort it first.', branch, st.operation));
      return false;
    }
    let stashed: string | undefined;
    // mensagem do stash: o prefixo "worktree-graph:" fica fixo, o resto segue o idioma
    const stashMsg = 'worktree-graph: ' + t('before pulling {0}', upstream);
    if (st.changes > 0) {
      if (opts.quiet) return false;
      const go = await vscode.window.showWarningMessage(
        t('{0} has {1} uncommitted change(s).', branch, st.changes),
        { modal: true, detail: t('The changes can be stashed, the remote pulled and the changes restored afterwards.') },
        t('Stash, pull and restore'),
      );
      if (!go) return false;
      stashed = await this.stashCreate(wt.path, stashMsg, { quiet: true });
    }

    let r = await progress(`git pull --ff-only ${upstream}…`, () => repo.run(['pull', '--ff-only', remote, remoteBranch], wt.path, 300_000));
    if (r.code !== 0) {
      const err = (r.stderr || r.stdout).trim();
      const diverged = /fast-forward|diverg/i.test(err);
      if (!diverged || opts.quiet) {
        if (!opts.quiet) vscode.window.showErrorMessage(t('Could not pull {0}: {1}', upstream, err));
        this.ctl.log(t('pull {0} failed: {1}', branch, err));
        if (stashed) await this.stashApply(stashed, wt.path, true, { quiet: true });
        return false;
      }
      const how = await vscode.window.showWarningMessage(
        t('{0} and {1} have diverged (commits on both sides).', branch, upstream),
        { modal: true, detail: t('Merge creates a commit joining both sides. Rebase replays your commits on top of the remote (rewrites local history).') },
        'Merge',
        'Rebase',
      );
      if (!how) {
        if (stashed) await this.stashApply(stashed, wt.path, true, { quiet: true });
        return false;
      }
      const op = how === 'Merge' ? 'merge' : 'rebase';
      r = await progress(`git pull --${op === 'merge' ? 'no-rebase' : 'rebase'} ${upstream}…`, () =>
        repo.run(['pull', op === 'merge' ? '--no-rebase' : '--rebase', '--no-edit', remote, remoteBranch], wt.path, 300_000),
      );
      if (r.code !== 0) {
        if ((await repo.conflictedFiles(wt.path)).length) await this.onConflict(op, wt.path, branch, t('pulling {0}', upstream));
        else vscode.window.showErrorMessage(t('Pull failed: {0}', (r.stderr || r.stdout).trim()));
        if (stashed) vscode.window.showInformationMessage(t('Your changes are saved in the stash "{0}"; apply it after resolving.', stashMsg));
        this.ctl.scheduleRefresh(50);
        return false;
      }
    }
    if (stashed && !(await this.stashApply(stashed, wt.path, true, { quiet: true }))) {
      vscode.window.showWarningMessage(t('{0} was pulled, but restoring your changes conflicted; they are still in the stash.', upstream));
    }
    return this.pulled(branch, opts.quiet);
  }

  private pulled(branch: string, quiet?: boolean) {
    this.ctl.log(`pull ${branch}: ok`);
    this.ctl.scheduleRefresh(50);
    if (!quiet) vscode.window.setStatusBarMessage(t('$(cloud-download) {0} is up to date with the remote', branch), 4000);
    return true;
  }

  /** Branches publicadas com commits no remoto que ainda não estão aqui. */
  private behindList() {
    const s = this.ctl.state;
    if (!s) return [];
    return [
      ...s.worktrees.filter(w => w.branch && !w.prunable).map(w => ({ name: w.branch!, behind: w.remote.behind, ahead: w.remote.ahead, published: w.remote.published, wt: true, clean: w.statusKnown && w.changes === 0 })),
      ...s.branches.map(b => ({ name: b.name, behind: b.remote.behind, ahead: b.remote.ahead, published: b.remote.published, wt: false, clean: true })),
    ].filter(x => x.published && x.behind > 0);
  }

  async pullMany() {
    const list = this.behindList();
    if (!list.length) {
      vscode.window.showInformationMessage(t('No branch has news on the remote (fetch to check).'), t('Fetch now')).then(g => void (g && this.fetchNow()));
      return;
    }
    const items = list.map(x => ({
      label: x.name,
      description: [`↓${x.behind}`, x.ahead ? t('↑{0} local (will ask for merge/rebase)', x.ahead) : 'fast-forward', x.wt ? (x.clean ? t('clean worktree') : t('worktree with changes')) : t('no worktree')].join(' · '),
      picked: x.clean && !x.ahead,
      name: x.name,
    }));
    const chosen = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: t('Pull from remote: {0} selected (fast-forward in a clean worktree or without a worktree)', items.filter(i => i.picked).length),
    });
    if (!chosen?.length) return;
    const ok: string[] = [];
    const failed: string[] = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Pulling branches'), cancellable: true }, async (p, token) => {
      for (const c of chosen) {
        if (token.isCancellationRequested) break;
        p.report({ message: `${c.name} (${ok.length + failed.length + 1}/${chosen.length})`, increment: 100 / chosen.length });
        ((await this.pull(c.name, { quiet: true })) ? ok : failed).push(c.name);
      }
    });
    this.ctl.scheduleRefresh(50);
    if (failed.length) vscode.window.showWarningMessage(t('{0} up to date; {1} need attention (diverged or have changes): {2}. Pull those one at a time.', ok.length, failed.length, failed.join(', ')));
    else vscode.window.showInformationMessage(t('{0} branch(es) up to date with the remote.', ok.length));
  }

  /** git fetch --prune; com notify, avisa as branches que ganharam novidades desde o último aviso. */
  async fetchNow(opts: { quiet?: boolean; notify?: boolean } = {}) {
    const repo = this.repo;
    const remote = this.remoteName();
    const r = await vscode.window.withProgress(
      { location: opts.quiet ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification, title: `git fetch ${remote}…` },
      () => repo.run(['fetch', '--prune', remote], repo.root, 300_000),
    );
    if (r.code !== 0) {
      this.ctl.log(t('fetch failed: {0}', (r.stderr || r.stdout).trim()));
      if (!opts.quiet) vscode.window.showErrorMessage(t('Fetch failed: {0}', (r.stderr || r.stdout).trim()));
      return;
    }
    await this.ctl.refresh();
    const behind = this.behindList();
    const sig = behind.map(b => `${b.name}:${b.behind}`).join(',');
    if (!opts.quiet) {
      vscode.window.setStatusBarMessage(t('$(cloud-download) fetch ok: {0} branch(es) with news', behind.length), 4000);
    } else if (opts.notify && behind.length && sig !== this.notifiedBehind) {
      this.notifiedBehind = sig;
      vscode.window
        .showInformationMessage(
          t('{0} branch(es) with news on the remote: {1}', behind.length, `${behind.slice(0, 4).map(b => b.name).join(', ')}${behind.length > 4 ? '…' : ''}`),
          t('Pull all'),
        )
        .then(g => void (g && this.pullMany()));
    }
  }

  private scheduleFetch() {
    if (this.fetchTimer) clearInterval(this.fetchTimer);
    this.fetchTimer = undefined;
    const minutes = this.ctl.cfg().get<number>('fetch.intervalMinutes', 0);
    if (!minutes || minutes <= 0) return;
    this.fetchTimer = setInterval(() => {
      if (!this.ctl.repo || !vscode.window.state.focused) return;
      this.fetchNow({ quiet: true, notify: true }).catch(e => this.ctl.log(t('periodic fetch: {0}', (e as Error).message)));
    }, Math.max(1, minutes) * 60_000);
  }

  // ---------------------------------------------------------------- stash

  async stashes(): Promise<StashEntry[]> {
    const r = await this.repo.run(['stash', 'list', '--format=%gd%x1f%H%x1f%gs%x1f%ct']);
    return r.code === 0 ? parseStashList(r.stdout) : [];
  }

  /** Guarda as alterações (inclusive não rastreadas) da worktree. Devolve o sha do stash, ou undefined se não havia nada. */
  async stashCreate(wtPath: string, message?: string, opts: { quiet?: boolean } = {}): Promise<string | undefined> {
    const repo = this.repo;
    if (message === undefined) {
      message = await vscode.window.showInputBox({ title: t('Stash changes'), prompt: t('Message to find it later (optional)'), ignoreFocusOut: true });
      if (message === undefined) return undefined;
    }
    const r = await repo.run(['stash', 'push', '--include-untracked', ...(message.trim() ? ['-m', message.trim()] : [])], wtPath, 120_000);
    if (r.code !== 0 || /No local changes/i.test(r.stdout + r.stderr)) {
      if (!opts.quiet) vscode.window.showInformationMessage(r.code !== 0 ? t('Stash failed: {0}', (r.stderr || r.stdout).trim()) : t('Nothing to stash: the worktree is clean.'));
      return undefined;
    }
    const sha = (await repo.run(['rev-parse', 'stash@{0}'])).stdout.trim();
    this.ctl.log(t('stash {0} created in {1}', short(sha), wtPath));
    this.ctl.scheduleRefresh(50);
    if (!opts.quiet) vscode.window.setStatusBarMessage(t('$(archive) Changes saved in stash {0}', short(sha)), 4000);
    return sha;
  }

  /** Aplica um stash (pelo sha) numa worktree; com pop, remove o stash se aplicou sem conflito. */
  async stashApply(sha: string, targetPath: string, pop: boolean, opts: { quiet?: boolean } = {}): Promise<boolean> {
    const repo = this.repo;
    const r = await repo.run(['stash', 'apply', sha], targetPath, 120_000);
    this.ctl.scheduleRefresh(50);
    if (r.code !== 0) {
      const conflicts = await repo.conflictedFiles(targetPath);
      if (!opts.quiet) {
        vscode.window.showWarningMessage(
          conflicts.length
            ? t('The stash conflicted in {0} file(s) ({1}); resolve it in the worktree. The stash was kept.', conflicts.length, conflicts.slice(0, 4).join(', '))
            : t('Could not apply the stash: {0}', (r.stderr || r.stdout).trim()),
        );
      }
      return false;
    }
    if (pop) await this.stashDrop(sha, { confirm: false });
    if (!opts.quiet) vscode.window.setStatusBarMessage(t('$(archive) Stash {0} applied', short(sha)), 4000);
    return true;
  }

  async stashDrop(sha: string, opts: { confirm?: boolean } = {}): Promise<boolean> {
    const entry = (await this.stashes()).find(e => e.sha === sha);
    if (!entry) return false;
    if (opts.confirm !== false) {
      const ok = await vscode.window.showWarningMessage(t('Delete stash "{0}"?', stashTitle(entry)), { modal: true, detail: t('The changes saved in it will be lost.') }, t('Delete'));
      if (!ok) return false;
    }
    const r = await this.repo.run(['stash', 'drop', entry.ref]);
    this.ctl.scheduleRefresh(50);
    return r.code === 0;
  }

  async stashShow(sha: string) {
    let r = await this.repo.run(['stash', 'show', '-p', '--include-untracked', sha]);
    if (r.code !== 0) r = await this.repo.run(['stash', 'show', '-p', sha]);
    const doc = await vscode.workspace.openTextDocument({ language: 'diff', content: r.stdout || (r.stderr || t('(empty)')) });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  /** Leva as alterações não commitadas de uma worktree para outra (stash + apply + drop). */
  async moveChanges(fromPath: string, toPath: string): Promise<boolean> {
    const wts = await this.repo.worktreesFast();
    const name = (p: string) => wts.find(w => w.path.toLowerCase() === p.toLowerCase())?.branch ?? path.basename(p);
    const sha = await this.stashCreate(fromPath, 'worktree-graph: ' + t('from {0} to {1}', name(fromPath), name(toPath)), { quiet: true });
    if (!sha) {
      vscode.window.showInformationMessage(t('{0} has no changes to move.', name(fromPath)));
      return false;
    }
    const ok = await this.stashApply(sha, toPath, true, { quiet: true });
    if (ok) vscode.window.showInformationMessage(t('Changes moved from {0} to {1}.', name(fromPath), name(toPath)));
    else vscode.window.showWarningMessage(t('Could not apply to {0} without conflicts; the changes were kept in stash {1} (Worktrees view → Stashes).', name(toPath), short(sha)));
    return ok;
  }

  // ---------------------------------------------------------------- trocar de branch

  /**
   * Troca a branch de uma worktree (git switch). Sem `target`, oferece as branches locais, as remotas
   * ainda sem branch local e a criação de uma nova. Alterações pendentes vão junto ou para um stash;
   * com `confirm: false`, sem perguntas (elas vão junto).
   */
  async switchBranch(wtPath: string, target?: string, opts: { confirm?: boolean } = {}): Promise<boolean> {
    const repo = this.repo;
    const wts = (await repo.worktreesFast()).filter(w => !w.prunable);
    const same = (p: string) => p.toLowerCase() === wtPath.toLowerCase();
    const current = wts.find(w => same(w.path))?.branch;
    const label = current ?? path.basename(wtPath);

    const st = await repo.status(wtPath);
    if (st.operation) {
      vscode.window.showWarningMessage(t('{0} is in the middle of a {1}; finish or abort it first.', label, st.operation));
      return false;
    }

    // args do git switch e o nome da branch que fica na worktree
    let args: string[];
    let dest: string;
    if (target) {
      args = [target];
      dest = target;
    } else {
      const refs = await repo.refs();
      const heads = refs.filter(r => r.kind === 'head');
      const local = new Set(heads.map(r => r.name));
      const openIn = new Map(wts.filter(w => w.branch && !same(w.path)).map(w => [w.branch!, w.path]));
      type Item = vscode.QuickPickItem & { run?: string[]; dest?: string; create?: true; other?: string };
      const items: Item[] = [{ label: `$(add) ${t('Create new branch from {0}…', label)}`, create: true, alwaysShow: true }];
      items.push({ label: t('Local branches'), kind: vscode.QuickPickItemKind.Separator });
      for (const r of heads.filter(r => r.name !== current).sort((x, y) => Number(openIn.has(x.name)) - Number(openIn.has(y.name)) || y.date - x.date)) {
        const other = openIn.get(r.name);
        items.push({
          label: `$(${other ? 'folder' : 'git-branch'}) ${r.name}`,
          description: other ? t('open in worktree {0}', other) : r.upstream ?? '',
          detail: r.subject,
          run: [r.name],
          dest: r.name,
          other,
        });
      }
      const remotes = refs.filter(r => r.kind === 'remote' && !local.has(r.name.slice(r.name.indexOf('/') + 1)));
      if (remotes.length) items.push({ label: t('Remote branches'), kind: vscode.QuickPickItemKind.Separator });
      for (const r of remotes.sort((x, y) => y.date - x.date)) {
        const name = r.name.slice(r.name.indexOf('/') + 1);
        items.push({ label: `$(cloud) ${r.name}`, description: t('creates {0} tracking the remote', name), detail: r.subject, run: ['-c', name, '--track', r.name], dest: name });
      }
      const pick = await vscode.window.showQuickPick(items, { placeHolder: t('Switch {0} to which branch?', label), matchOnDescription: true, matchOnDetail: true });
      if (!pick) return false;
      if (pick.other) {
        // o git não deixa a mesma branch em duas worktrees
        const open = t('Open that worktree');
        const go = await vscode.window.showInformationMessage(t('{0} is already checked out in the worktree {1}; git does not allow the same branch in two worktrees.', pick.dest!, pick.other), open);
        if (go) await vscode.commands.executeCommand('worktreeGraph.openWorktree', { path: pick.other });
        return false;
      }
      if (pick.create) {
        const name = await vscode.window.showInputBox({
          title: t('New branch from {0}', label),
          prompt: t('Name of the new branch'),
          ignoreFocusOut: true,
          validateInput: async v => {
            if (!v.trim()) return t('Enter a name.');
            if (local.has(v.trim())) return t('The branch {0} already exists.', v.trim());
            return (await repo.run(['check-ref-format', '--branch', v.trim()])).code === 0 ? undefined : t('Invalid branch name.');
          },
        });
        if (!name) return false;
        args = ['-c', name.trim()];
        dest = name.trim();
      } else {
        args = pick.run!;
        dest = pick.dest!;
      }
    }
    if (dest === current) return false;

    const { base } = await this.ctl.base();
    const w = this.ctl.state?.worktrees.find(x => same(x.path));
    const warn = [
      current === base ? t('This worktree is on the base {0}.', base) : '',
      w?.agents.length ? t('Agents open here ({0}) will keep working in the same folder, now on {1}.', w.agents.join(', '), dest) : '',
    ].filter(Boolean);

    let stashed: string | undefined;
    const stashMsg = 'worktree-graph: ' + t('before switching from {0} to {1}', label, dest);
    if (st.changes > 0 && opts.confirm !== false) {
      const carry = t('Take changes along');
      const stash = t('Stash and switch');
      const how = await vscode.window.showWarningMessage(
        t('{0} has {1} uncommitted change(s).', label, st.changes),
        { modal: true, detail: [...warn, t('Taking them along only works if they do not collide with {0}; otherwise git refuses and nothing changes.', dest)].join('\n') },
        carry,
        stash,
      );
      if (!how) return false;
      if (how === stash) {
        stashed = await this.stashCreate(wtPath, stashMsg, { quiet: true });
        if (!stashed) return false;
      }
    } else if (warn.length && opts.confirm !== false) {
      const ok = await vscode.window.showWarningMessage(t('Switch {0} to {1}?', label, dest), { modal: true, detail: warn.join('\n') }, t('Switch'));
      if (!ok) return false;
    }

    this.ctl.log(t('git {0}  (in {1})', ['switch', ...args].join(' '), wtPath));
    const r = await repo.run(['switch', ...args], wtPath, 120_000);
    this.ctl.scheduleRefresh(50);
    if (r.code !== 0) {
      if (stashed) await this.stashApply(stashed, wtPath, true, { quiet: true });
      vscode.window.showErrorMessage(t('Could not switch to {0}: {1}', dest, (r.stderr || r.stdout).trim()));
      return false;
    }
    if (stashed) vscode.window.showInformationMessage(t('{0} is now on {1}. Your changes are in the stash "{2}" (Worktrees view → Stashes).', label, dest, stashMsg));
    else vscode.window.setStatusBarMessage(t('$(git-branch) Worktree now on {0}', dest), 4000);
    return true;
  }

  // ---------------------------------------------------------------- alterações não commitadas

  /** Arquivos alterados na worktree (inclusive não rastreados), com as linhas de cada um. */
  async uncommitted(wtPath: string): Promise<Uncommitted[]> {
    const repo = this.repo;
    const [st, num] = await Promise.all([
      repo.run(['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'], wtPath),
      repo.run(['diff', 'HEAD', '--numstat', '-z', '--no-renames'], wtPath),
    ]);
    const list = st.code === 0 ? parseUncommitted(st.stdout) : [];
    const stats = num.code === 0 ? parseNumstat(num.stdout) : new Map<string, { added: number; deleted: number; binary: boolean }>();
    for (const u of list) {
      const s = stats.get(u.path);
      if (s) Object.assign(u, s);
      else if (u.letter === '?') Object.assign(u, untrackedStats(path.join(wtPath, u.path)));
    }
    return list;
  }

  /** Patch dos arquivos, com os não rastreados como arquivos novos. */
  async uncommittedPatch(wtPath: string, items: Uncommitted[]): Promise<string> {
    const tracked = items.filter(u => u.letter !== '?').map(u => u.path);
    const parts: string[] = [];
    if (tracked.length) {
      const r = await this.repo.run(['diff', 'HEAD', '--no-renames', '--no-color', '--', ...tracked], wtPath, 60_000);
      if (r.stdout) parts.push(r.stdout.trimEnd());
    }
    for (const u of items.filter(x => x.letter === '?')) parts.push(newFilePatch(wtPath, u.path));
    return parts.join('\n') || t('(nothing)');
  }

  async showUncommitted(wtPath: string, items?: Uncommitted[], title?: string) {
    items ??= await this.uncommitted(wtPath);
    if (!items.length) {
      vscode.window.showInformationMessage(t('The worktree is clean: nothing uncommitted.'));
      return;
    }
    const head = title ? `# ${title}\n# ${t('{0} file(s)', items.length)}\n\n` : '';
    const doc = await vscode.workspace.openTextDocument({ language: 'diff', content: head + (await this.uncommittedPatch(wtPath, items)) });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  /**
   * Descarta alterações não commitadas (todas, ou só `paths`) de forma transparente: mostra o patch
   * do que vai sair, confirma com a lista arquivo a arquivo e, antes de apagar, guarda tudo num stash
   * (git stash push -u -- <arquivos>), então dá para desfazer.
   */
  async discard(wtPath: string, paths?: string[]): Promise<boolean> {
    const repo = this.repo;
    const st = await repo.status(wtPath);
    if (st.operation) {
      vscode.window.showWarningMessage(t('There is a {0} in progress in this worktree; finish or abort it before discarding.', st.operation));
      return false;
    }
    const wts = await repo.worktreesFast();
    const name = wts.find(w => w.path.toLowerCase() === wtPath.toLowerCase())?.branch ?? path.basename(wtPath);
    const all = await this.uncommitted(wtPath);
    let items = paths ? all.filter(u => paths.includes(u.path)) : all;
    if (!items.length) {
      vscode.window.showInformationMessage(paths ? t('These files have no uncommitted changes.') : t('{0} is clean: nothing to discard.', name));
      return false;
    }
    if (!paths) {
      // tudo: escolhe na lista (todos marcados), com o efeito de cada um à vista
      const picked = await vscode.window.showQuickPick(
        items.map(u => ({
          label: `${u.letter}  ${path.basename(u.path)}`,
          description: path.dirname(u.path) === '.' ? '' : path.dirname(u.path),
          detail: discardEffect(u),
          picked: true,
          u,
        })),
        { canPickMany: true, title: t('Discard changes in {0}: uncheck what you want to keep', name), matchOnDescription: true, ignoreFocusOut: true },
      );
      if (!picked?.length) return false;
      items = picked.map(p => p.u);
    }
    const partial = items.length < all.length;
    await this.showUncommitted(wtPath, items, t('What will be discarded from {0}', name));
    const discardBtn = t('Discard');
    const ok = await vscode.window.showWarningMessage(
      t('Discard {0} uncommitted file(s) from {1}?', items.length, name),
      {
        modal: true,
        detail:
          `${discardSummary(items)}\n\n` +
          t('The full patch is open in the editor. Before discarding, a copy goes to a stash (Worktrees view → Stashes), so it can be undone.') +
          (partial ? '\n\n' + t('The other {0} changed file(s) are not touched.', all.length - items.length) : ''),
      },
      discardBtn,
    );
    if (ok !== discardBtn) return false;

    // o stash é achado logo abaixo pela mensagem exata (endsWith), então ela vem desta mesma variável
    const message = 'worktree-graph: ' + t('discarded from {0} ({1} file(s)) {2}', name, items.length, new Date().toLocaleString());
    const args = ['stash', 'push', '--include-untracked', '-m', message];
    const r = await repo.run(partial ? [...args, '--', ...items.map(u => u.path)] : args, wtPath, 120_000);
    this.ctl.scheduleRefresh(50);
    if (r.code !== 0) {
      vscode.window.showErrorMessage(t('Could not discard (nothing was deleted): {0}', (r.stderr || r.stdout).trim()));
      return false;
    }
    const entry = (await this.stashes()).find(e => e.message.endsWith(message));
    const files = items.map(u => u.path).join(', ');
    this.ctl.log(entry ? t('discarded in {0}: {1} (copy in stash {2})', wtPath, files, short(entry.sha)) : t('discarded in {0}: {1}', wtPath, files));
    if (!entry) {
      vscode.window.showInformationMessage(t('{0} file(s) discarded from {1}.', items.length, name));
      return true;
    }
    const undo = t('Undo');
    vscode.window.showInformationMessage(t('{0} file(s) discarded from {1}. Copy in stash {2}.', items.length, name, short(entry.sha)), undo, t('Show what was removed')).then(async pick => {
      if (pick === undo) {
        if (await this.stashApply(entry.sha, wtPath, true, { quiet: true })) vscode.window.setStatusBarMessage(t('$(discard) Discard undone in {0}', name), 4000);
        else vscode.window.showWarningMessage(t('Could not restore without conflicts; the copy is still in stash {0}.', short(entry.sha)));
      } else if (pick) {
        await this.stashShow(entry.sha);
      }
    });
    return true;
  }

  // ---------------------------------------------------------------- cherry-pick

  async cherryPick(sha: string, target: string, opts: { confirm?: boolean } = {}): Promise<boolean> {
    const repo = this.repo;
    const info = (await repo.exec(['log', '-1', '--format=%s%x1f%P', sha])).trim().split('\x1f');
    const subject = info[0];
    const parents = (info[1] ?? '').split(' ').filter(Boolean);
    let wt = await this.worktreeOf(target);
    if (!wt) {
      const go =
        opts.confirm === false ||
        (await vscode.window.showInformationMessage(t('{0} is not open in a worktree.', target), { modal: true, detail: t('Cherry-pick needs a worktree of the target branch.') }, t('Create worktree and apply')));
      if (!go) return false;
      await createWorktree(this.ctl, { existing: target, quiet: true });
      wt = await this.worktreeOf(target);
      if (!wt) return false;
    }
    const st = await repo.status(wt.path);
    if (st.operation || st.changes > 0) {
      vscode.window.showWarningMessage(
        st.operation
          ? t('{0} has a {1} in progress; resolve it before the cherry-pick.', target, st.operation)
          : t('{0} has {1} uncommitted change(s); resolve them before the cherry-pick.', target, st.changes),
      );
      return false;
    }
    if (opts.confirm !== false) {
      const ok = await vscode.window.showInformationMessage(
        t('Apply commit {0} to {1}?', short(sha), target),
        { modal: true, detail: `"${subject}"${parents.length > 1 ? '\n\n' + t('This is a merge commit: it will be applied relative to the first parent (-m 1).') : ''}` },
        t('Apply'),
      );
      if (!ok) return false;
    }
    const r = await repo.run(['cherry-pick', ...(parents.length > 1 ? ['-m', '1'] : []), sha], wt.path, 120_000);
    this.ctl.scheduleRefresh(50);
    if (r.code === 0) {
      this.ctl.log(t('cherry-pick {0} on {1}: ok', short(sha), target));
      if (opts.confirm !== false) vscode.window.showInformationMessage(t('Commit {0} applied to {1}.', short(sha), target));
      return true;
    }
    if ((await repo.conflictedFiles(wt.path)).length) {
      await this.onConflict('cherry-pick', wt.path, target, t('applying commit {0} ("{1}")', short(sha), subject));
    } else if (/empty|nothing to commit/i.test(r.stderr + r.stdout)) {
      await repo.run(['cherry-pick', '--abort'], wt.path);
      vscode.window.showInformationMessage(t('{0} already has the changes from commit {1}; nothing to apply.', target, short(sha)));
    } else {
      await repo.run(['cherry-pick', '--abort'], wt.path);
      vscode.window.showErrorMessage(t('Cherry-pick failed: {0}', (r.stderr || r.stdout).trim()));
    }
    return false;
  }

  // ---------------------------------------------------------------- reorganizar commits (rebase -i)

  /** Commits da worktree desde que saiu da base, do mais antigo para o mais novo. */
  async commitsSinceBase(wtPath: string) {
    const { baseRef } = await this.ctl.base();
    const mb = (await this.repo.exec(['merge-base', baseRef, 'HEAD'], wtPath)).trim();
    const out = await this.repo.exec(['log', '--reverse', '--format=%H%x1f%P%x1f%s', `${mb}..HEAD`], wtPath);
    const commits = out
      .split(/\r?\n/)
      .filter(Boolean)
      .map(l => {
        const [sha, parents, subject] = l.split('\x1f');
        return { sha, subject, merge: parents.split(' ').length > 1 };
      });
    return { mb, baseRef, commits };
  }

  private async editPlan(plan: PlanStep[], branch: string): Promise<PlanStep[] | undefined> {
    const icon: Record<RebaseAction, string> = { pick: '$(check)', squash: '$(fold-up)', fixup: '$(fold-up)', drop: '$(trash)', reword: '$(edit)' };
    let current = plan;
    for (;;) {
      const items: (vscode.QuickPickItem & { id: string; i?: number })[] = [
        { label: t('$(play) Apply'), description: t('reorganizes the commits (creates a backup first)'), id: 'apply' },
        { label: t('$(close) Cancel'), id: 'cancel' },
        { label: t('oldest to newest'), kind: vscode.QuickPickItemKind.Separator, id: 'sep' },
        ...current.map((s, i) => ({
          label: `${icon[s.action]} ${s.action === 'reword' ? s.message : s.subject}`,
          description: `${s.action}${s.action === 'squash' || s.action === 'fixup' ? ` ↑ ${t('joins the previous one')}` : ''} · ${short(s.sha)}`,
          id: 'step',
          i,
        })),
      ];
      const pick = await vscode.window.showQuickPick(items, { title: t('Reorganize commits of {0}', branch), placeHolder: t('Choose a commit to change, or Apply'), ignoreFocusOut: true });
      if (!pick || pick.id === 'cancel') return undefined;
      if (pick.id === 'apply') {
        const err = validatePlan(current);
        if (!err) return current;
        vscode.window.showWarningMessage(err);
        continue;
      }
      const i = pick.i!;
      const step = current[i];
      const act = await vscode.window.showQuickPick(
        [
          { label: t('$(arrow-up) Move up (older)'), v: 'up' },
          { label: t('$(arrow-down) Move down (newer)'), v: 'down' },
          { label: '$(check) pick', description: t('keep as is'), v: 'pick' },
          { label: '$(fold-up) squash', description: t('combine with the previous one, merging the messages'), v: 'squash' },
          { label: '$(fold-up) fixup', description: t('combine with the previous one, discarding this message'), v: 'fixup' },
          { label: '$(edit) reword', description: t('change the message'), v: 'reword' },
          { label: '$(trash) drop', description: t('drop this commit'), v: 'drop' },
        ],
        { title: step.subject },
      );
      if (!act) continue;
      if (act.v === 'up') current = movePlan(current, i, -1);
      else if (act.v === 'down') current = movePlan(current, i, 1);
      else if (act.v === 'reword') {
        const msg = await vscode.window.showInputBox({ title: t('New message'), value: step.message ?? step.subject, ignoreFocusOut: true });
        if (msg?.trim()) current = current.map((s, k) => (k === i ? { ...s, action: 'reword', message: msg.trim() } : s));
      } else current = current.map((s, k) => (k === i ? { ...s, action: act.v as RebaseAction, message: undefined } : s));
    }
  }

  /** Rebase interativo sem editor: o roteiro vem do plano (ou do assistente) e vai por GIT_SEQUENCE_EDITOR. */
  async reorganize(wtPath: string, plan?: PlanStep[]): Promise<boolean> {
    const repo = this.repo;
    const branch = (await repo.worktreesFast()).find(w => w.path.toLowerCase() === wtPath.toLowerCase())?.branch;
    if (!branch) {
      vscode.window.showWarningMessage(t('The worktree must be on a branch.'));
      return false;
    }
    const st = await repo.status(wtPath);
    if (st.operation || st.changes > 0) {
      vscode.window.showWarningMessage(
        st.operation
          ? t('{0} must be clean to reorganize commits ({1} in progress).', branch, st.operation)
          : t('{0} must be clean to reorganize commits ({1} change(s)).', branch, st.changes),
      );
      return false;
    }
    const { mb, baseRef, commits } = await this.commitsSinceBase(wtPath);
    if (commits.length < 1) {
      vscode.window.showInformationMessage(t('{0} has no commits beyond {1}.', branch, baseRef));
      return false;
    }
    if (commits.some(c => c.merge)) {
      vscode.window.showWarningMessage(t('{0} has merge commits since {1}; reorganizing with rebase would flatten them. Do it in the terminal with git rebase -i --rebase-merges.', branch, baseRef));
      return false;
    }
    if (!plan) {
      plan = await this.editPlan(commits.map(c => ({ sha: c.sha, subject: c.subject, action: 'pick' })), branch);
      if (!plan) return false;
    }
    const err = validatePlan(plan);
    if (err) {
      vscode.window.showWarningMessage(err);
      return false;
    }
    const unchanged = plan.every((s, i) => s.action === 'pick' && s.sha === commits[i]?.sha) && plan.length === commits.length;
    if (unchanged) {
      vscode.window.showInformationMessage(t('Nothing changed in the plan.'));
      return false;
    }

    const stamp = Date.now();
    const backup = `refs/worktree-graph/backup/${branch.replace(/[^\w./-]/g, '-')}/${stamp}`;
    await repo.exec(['update-ref', backup, 'HEAD'], wtPath);
    this.backups.set(branch, backup);

    const dir = path.join(os.tmpdir(), 'worktree-graph-rebase', String(stamp));
    fs.mkdirSync(dir, { recursive: true });
    const msgFile = (i: number) => path.join(dir, `msg-${i}.txt`).replace(/\\/g, '/');
    plan.forEach((s, i) => s.action === 'reword' && fs.writeFileSync(msgFile(i), s.message!.trim() + '\n'));
    const todo = path.join(dir, 'todo.txt');
    fs.writeFileSync(todo, buildTodo(plan, msgFile));

    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Reorganizing commits of {0}…', branch) }, () =>
      repo.run(['rebase', '-i', mb], wtPath, 300_000, {
        // o git chama `$GIT_SEQUENCE_EDITOR <arquivo-do-roteiro>` pelo sh: basta copiar o nosso por cima
        GIT_SEQUENCE_EDITOR: `cp "${todo.replace(/\\/g, '/')}"`,
        GIT_EDITOR: 'true',
      }),
    );
    this.ctl.scheduleRefresh(50);
    if (r.code === 0) {
      this.ctl.log(t('rebase -i on {0}: ok (backup {1})', branch, backup));
      vscode.window.showInformationMessage(t('Commits of {0} reorganized.', branch), t('Undo')).then(g => void (g && this.undoReorganize(branch)));
      return true;
    }
    if ((await repo.conflictedFiles(wtPath)).length) {
      await this.onConflict('rebase', wtPath, branch, t('reorganizing the commits (interactive rebase)'));
    } else {
      await repo.run(['rebase', '--abort'], wtPath);
      vscode.window.showErrorMessage(t('Could not reorganize; nothing was changed: {0}', (r.stderr || r.stdout).trim()));
    }
    return false;
  }

  /** Volta a branch ao estado anterior ao último "Reorganizar commits" (reset --keep para a cópia). */
  async undoReorganize(branch: string): Promise<boolean> {
    const repo = this.repo;
    let backup = this.backups.get(branch);
    if (!backup) {
      const refs = (await repo.run(['for-each-ref', '--sort=-refname', '--format=%(refname)', `refs/worktree-graph/backup/${branch}/`])).stdout.split(/\r?\n/).filter(Boolean);
      backup = refs[0];
    }
    const wt = await this.worktreeOf(branch);
    if (!backup || !wt) {
      vscode.window.showInformationMessage(t('There is no backup of {0}.', branch));
      return false;
    }
    const r = await repo.run(['reset', '--keep', backup], wt.path);
    this.ctl.scheduleRefresh(50);
    if (r.code !== 0) {
      vscode.window.showErrorMessage(t('Could not undo: {0}', (r.stderr || r.stdout).trim()));
      return false;
    }
    vscode.window.setStatusBarMessage(t('$(history) {0} is back to its previous state', branch), 4000);
    return true;
  }

  // ---------------------------------------------------------------- comparar

  /** Arquivos diferentes entre duas branches; com worktree, compara o que está em disco (inclui não commitados). */
  async compareFiles(a: string, b: string) {
    const repo = this.repo;
    const [wa, wb] = await Promise.all([this.worktreeOf(a), this.worktreeOf(b)]);
    const committed = parseNameStatus((await repo.run(['diff', '--name-status', '--no-renames', a, b])).stdout);
    const paths = new Set(committed.keys());
    for (const w of [wa, wb]) {
      if (!w) continue;
      const st = await repo.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], w.path);
      for (const p of parseStatusPaths(st.stdout)) paths.add(p);
    }
    const side = (w: Worktree | undefined, ref: string, p: string) => {
      if (!w) return { uri: gitUri(repo.root, ref, p), exists: committed.get(p) !== (ref === a ? 'A' : 'D') };
      const f = path.join(w.path, p);
      return fs.existsSync(f) ? { uri: vscode.Uri.file(f), exists: true } : { uri: gitUri(repo.root, '__empty__', p), exists: false };
    };
    const out: { path: string; status: string; left: vscode.Uri; right: vscode.Uri }[] = [];
    for (const p of [...paths].sort()) {
      const l = side(wa, a, p);
      const r = side(wb, b, p);
      if (!l.exists && !r.exists) continue;
      if (wa && wb && l.exists && r.exists) {
        // só alterado em disco nos dois lados, mas com o mesmo conteúdo: não é diferença
        try {
          if (fs.readFileSync(l.uri.fsPath).equals(fs.readFileSync(r.uri.fsPath))) continue;
        } catch {
          // segue como diferente
        }
      }
      out.push({ path: p, status: !l.exists ? 'A' : !r.exists ? 'D' : committed.get(p) ?? 'M', left: l.uri, right: r.uri });
    }
    return out;
  }

  async compareWith(a?: string, b?: string) {
    a ??= await this.pickBranch(t('Compare which branch?'));
    if (!a) return;
    b ??= await this.pickBranch(t('Compare {0} with…', a), a);
    if (!b) return;
    const files = await this.compareFiles(a, b);
    if (!files.length) {
      vscode.window.showInformationMessage(t('{0} and {1} have the same content.', a, b));
      return;
    }
    const label: Record<string, string> = { A: t('only in {0}', b), D: t('only in {0}', a), M: t('different'), T: t('different type') };
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { f: (typeof files)[number] }>();
    qp.title = t('{0} ↔ {1}: {2} file(s)', a, b, files.length);
    qp.placeholder = t('Enter opens the diff; the list stays open');
    qp.ignoreFocusOut = true;
    qp.matchOnDescription = true;
    qp.items = files.map(f => ({ label: path.basename(f.path), description: `${path.dirname(f.path) === '.' ? '' : path.dirname(f.path)}  ${label[f.status] ?? f.status}`, f }));
    qp.onDidAccept(() => {
      const it = qp.selectedItems[0];
      if (it) vscode.commands.executeCommand('vscode.diff', it.f.left, it.f.right, `${path.basename(it.f.path)} (${a} ↔ ${b})`, { preview: true, preserveFocus: true });
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  }

  dispose() {
    if (this.fetchTimer) clearInterval(this.fetchTimer);
    this.disposables.forEach(d => d.dispose());
  }
}

export function registerGitOps(ctx: vscode.ExtensionContext, ctl: Controller, guard: Guard): GitOps {
  const ops = new GitOps(ctl);
  ctx.subscriptions.push(ops);

  // grupo "Stashes" na árvore de worktrees
  extraTree.push({
    roots: () => (ctl.repo ? [new StashGroup()] : []),
    children: el => (el instanceof StashGroup ? ops.stashes().then(list => list.map(e => new StashItem(e))) : undefined),
  });

  const reg = (id: string, fn: (...args: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(`worktreeGraph.${id}`, guard(fn)));
  const shaOf = (a: any): string | undefined => (typeof a === 'string' ? a : a?.entry?.sha ?? a?.sha);
  const need = async (a: Arg, placeHolder: string) => {
    const b = branchOf(a);
    return b ?? (await vscode.window.showQuickPick((await ctl.repo!.refs()).filter(r => r.kind === 'head').map(r => r.name), { placeHolder }));
  };

  reg('pullBranch', async (a: Arg) => {
    const b = await need(a, t('Pull which branch from the remote?'));
    if (b) await ops.pull(b);
  });
  reg('pullMany', () => ops.pullMany());
  reg('fetchNow', () => ops.fetchNow());

  reg('stashCreate', async (a: Arg) => {
    const w = await ops.pathOf(a);
    if (w) await ops.stashCreate(w.path);
  });
  const applyTo = async (a: any, pop: boolean) => {
    const sha = shaOf(a) ?? (await pickStash(ops));
    if (!sha) return;
    const target = typeof a === 'object' && a?.path ? { path: a.path } : await ops.pickWorktree(pop ? t('Apply and drop the stash in which worktree?') : t('Apply the stash in which worktree?'));
    if (target) await ops.stashApply(sha, target.path, pop);
  };
  reg('stashApply', (a: any) => applyTo(a, false));
  reg('stashPop', (a: any) => applyTo(a, true));
  reg('stashDrop', async (a: any) => {
    const sha = shaOf(a) ?? (await pickStash(ops));
    if (sha) await ops.stashDrop(sha);
  });
  reg('stashShow', async (a: any) => {
    const sha = shaOf(a) ?? (await pickStash(ops));
    if (sha) await ops.stashShow(sha);
  });
  reg('moveChanges', async (a: Arg) => {
    const from = await ops.pathOf(a);
    if (!from) return;
    const to = typeof a === 'object' && a?.target ? await ops.pathOf(a.target) : await ops.pickWorktree(t('Move the changes from {0} to…', from.branch ?? path.basename(from.path)), from.path);
    if (to) await ops.moveChanges(from.path, to.path);
  });

  reg('switchBranch', async (a: any) => {
    const w = await ops.pathOf(a);
    if (w) await ops.switchBranch(w.path, typeof a?.target === 'string' ? a.target : undefined);
  });

  // alterações não commitadas: arg é a worktree ({ path }) ou arquivos do grupo "Não commitadas" ({ path, file })
  const filesOf = (a: any, sel?: any[]): string[] | undefined => {
    const list = (sel?.length ? sel : [a]).filter(x => x?.file && x.path === a?.path).map(x => x.file as string);
    return list.length ? list : undefined;
  };
  reg('showUncommittedPatch', async (a: Arg) => {
    const w = await ops.pathOf(a);
    if (w) await ops.showUncommitted(w.path, undefined, t('Uncommitted in {0}', w.branch ?? path.basename(w.path)));
  });
  reg('discardChanges', async (a: any, sel?: any[]) => {
    const w = await ops.pathOf(a);
    if (w) await ops.discard(w.path, filesOf(a, sel));
  });

  reg('cherryPick', async (a: any) => {
    const sha = shaOf(a);
    if (!sha) return;
    const target = a?.target ?? (await ops.pickBranch(t('Apply commit {0} to…', short(sha))));
    if (target) await ops.cherryPick(sha, target);
  });
  reg('reorganizeCommits', async (a: Arg) => {
    const w = await ops.pathOf(a);
    if (w) await ops.reorganize(w.path);
  });
  reg('undoReorganize', async (a: Arg) => {
    const b = await need(a, t('Undo the reorganization of which branch?'));
    if (b) await ops.undoReorganize(b);
  });
  reg('compareWith', (a: Arg, b?: string) => ops.compareWith(branchOf(a), typeof b === 'string' ? b : undefined));

  return ops;
}

async function pickStash(ops: GitOps): Promise<string | undefined> {
  const list = await ops.stashes();
  if (!list.length) {
    vscode.window.showInformationMessage(t('There are no stashes.'));
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    list.map(e => ({ label: stashTitle(e), description: [e.branch, ago(e.date)].filter(Boolean).join(' · '), sha: e.sha })),
    { placeHolder: t('Which stash?') },
  );
  return pick?.sha;
}

/** Linhas de um arquivo não rastreado (até 2 MB; acima disso ou com byte nulo, conta como binário). */
function untrackedStats(file: string): { added: number; deleted: number; binary: boolean } {
  try {
    const st = fs.statSync(file);
    if (st.size > 2_000_000) return { added: 0, deleted: 0, binary: true };
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return { added: 0, deleted: 0, binary: true };
    const text = buf.toString('utf8');
    return { added: text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0, deleted: 0, binary: false };
  } catch {
    return { added: 0, deleted: 0, binary: false };
  }
}

/** Patch de "arquivo novo" para um não rastreado, no formato do git diff. */
function newFilePatch(cwd: string, rel: string): string {
  const head = `diff --git a/${rel} b/${rel}\nnew file (${t('untracked')})\n--- /dev/null\n+++ b/${rel}`;
  if (untrackedStats(path.join(cwd, rel)).binary) return `${head}\n${t('(binary or too large to show)')}`;
  let text: string;
  try {
    text = fs.readFileSync(path.join(cwd, rel), 'utf8');
  } catch {
    return `${head}\n${t('(could not read the file)')}`;
  }
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return `${head}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l => '+' + l.replace(/\r$/, '')).join('\n')}`;
}
