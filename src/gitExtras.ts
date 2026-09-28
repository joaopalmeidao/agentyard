import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as actions from './actions';
import type { AgentTerminals } from './agents';
import { keyOf } from './agentFlow/head';
import { bisectRun, addTemp } from './bisect';
import { commitMessagePrompt, parseTitleBody, prDescriptionPrompt, runHeadless } from './claude/headless';
import type { Controller } from './controller';
import { t, locale } from './i18n';
import { coneDirs, listDirs, setSparse, sparseDirs } from './sparse';

type Arg = { branch?: string; path?: string } | string | undefined;

/**
 * Recursos de git que conversam com os agentes: checkout parcial, bisect (por comando ou pelo agente),
 * mensagem de commit e descrição de PR/MR escritas pelo Claude sem terminal (`claude -p`).
 */
export function registerGitExtras(ctx: vscode.ExtensionContext, ctl: Controller, guard: <T extends unknown[]>(fn: (...a: T) => unknown) => (...a: T) => Promise<void>, deps: { agentTerms: AgentTerminals }) {
  const reg = (id: string, fn: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(`worktreeGraph.${id}`, guard(fn)));
  const repo = () => {
    if (!ctl.repo) throw new Error(t('No git repository open in this workspace.'));
    return ctl.repo;
  };

  /** Worktree de item da árvore, card, branch ou pergunta. */
  const worktreeOf = async (arg: Arg, placeHolder: string) => {
    const wts = (ctl.state?.worktrees ?? []).filter(w => !w.bare && !w.prunable);
    const p = typeof arg === 'object' ? arg?.path : undefined;
    const b = typeof arg === 'string' ? arg : arg?.branch;
    const hit = p ? wts.find(w => keyOf(w.path) === keyOf(p)) : b ? wts.find(w => w.branch === b) : undefined;
    if (hit) return hit;
    const pick = await vscode.window.showQuickPick(
      wts.map(w => ({ label: w.name, description: w.branch, detail: w.path, w })),
      { placeHolder },
    );
    return pick?.w;
  };

  /** Escolha das pastas do checkout parcial (as atuais já marcadas). */
  const pickDirs = async (cwd: string, ref: string, current: string[] = [], title: string): Promise<string[] | undefined> => {
    const dirs = await listDirs(cwd, ref, ctl.cfg().get<number>('worktree.sparseDepth', 2));
    const items = dirs.map(d => ({ label: d, picked: current.includes(d) }));
    const other = { label: `$(edit) ${t('Type other folders…')}`, alwaysShow: true, picked: false };
    const picks = await vscode.window.showQuickPick([...items, other], {
      canPickMany: true,
      title,
      placeHolder: t('Folders that go into the worktree (files at the root always go). None = full checkout.'),
      ignoreFocusOut: true,
    });
    if (!picks) return undefined;
    const out = picks.filter(p => p !== other).map(p => p.label);
    if (picks.includes(other)) {
      const typed = await vscode.window.showInputBox({ title, prompt: t('Folders separated by comma (e.g. packages/api, libs/shared)'), ignoreFocusOut: true });
      if (typed === undefined) return undefined;
      out.push(...typed.split(','));
    }
    return coneDirs(out);
  };

  reg('newSparseWorktree', async () => {
    const r = repo();
    const { base } = await ctl.base();
    const dirs = await pickDirs(r.root, base, [], t('New worktree with partial checkout (sparse)'));
    if (!dirs) return;
    await actions.createWorktree(ctl, { sparse: dirs });
  });

  reg('sparseCheckout', async (arg: Arg) => {
    const w = await worktreeOf(arg, t('Partial checkout of which worktree?'));
    if (!w) return;
    const current = await sparseDirs(w.path);
    const dirs = await pickDirs(w.path, 'HEAD', current ?? [], t('Partial checkout of {0}', w.name));
    if (!dirs) return;
    if (w.changes) {
      const go = t('Continue');
      const ok = await vscode.window.showWarningMessage(t('{0} has uncommitted changes. Folders that leave the checkout keep only files with changes.', w.name), { modal: true }, go);
      if (ok !== go) return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Updating the checkout of {0}…', w.name) }, () => setSparse(w.path, dirs));
    vscode.window.showInformationMessage(dirs.length ? t('{0} now has only: {1}.', w.name, dirs.join(', ')) : t('{0} is back to the full checkout.', w.name));
    ctl.scheduleRefresh(50);
  });

  // ------------------------------------------------------------ bisect

  /** Commits recentes para escolher o "bom" (tags primeiro, depois o log da branch). */
  const pickGood = async (cwd: string, bad: string, base: string): Promise<string | undefined> => {
    const r = repo();
    const tags = (await r.run(['tag', '--merged', bad, '--sort=-creatordate'], cwd)).stdout.split(/\r?\n/).filter(Boolean).slice(0, 10);
    const log = (await r.run(['log', '--format=%h%x09%s%x09%cr', '-n', '40', bad], cwd)).stdout.split(/\r?\n/).filter(Boolean);
    const mb = (await r.run(['merge-base', base, bad], cwd)).stdout.trim();
    const items: (vscode.QuickPickItem & { ref?: string })[] = [
      ...(mb ? [{ label: `$(git-merge) ${t('Where it came out of {0}', base)}`, description: mb.slice(0, 8), ref: mb }] : []),
      ...(tags.length ? [{ label: t('Tags'), kind: vscode.QuickPickItemKind.Separator }] : []),
      ...tags.map(x => ({ label: `$(tag) ${x}`, ref: x })),
      { label: t('Commits'), kind: vscode.QuickPickItemKind.Separator },
      ...log.map(l => {
        const [h, s, when] = l.split('\t');
        return { label: `$(git-commit) ${h}`, description: s, detail: when, ref: h };
      }),
    ];
    const pick = await vscode.window.showQuickPick(items, { title: t('Bisect (2/3): last commit that worked'), matchOnDescription: true });
    return pick?.ref;
  };

  reg('bisect', async (arg: Arg) => {
    const w = await worktreeOf(arg, t('Find where it broke in which worktree?'));
    if (!w) return;
    const r = repo();
    const { base } = await ctl.base();
    const bad = await vscode.window.showInputBox({
      title: t('Bisect (1/3): commit that is broken'),
      value: 'HEAD',
      prompt: t('Branch, tag or commit (HEAD = the last commit of {0})', w.branch ?? w.name),
    });
    if (!bad) return;
    const badSha = (await r.run(['rev-parse', '--verify', `${bad}^{commit}`], w.path)).stdout.trim();
    if (!badSha) throw new Error(t('{0} is not a commit.', bad));
    const good = await pickGood(w.path, badSha, base);
    if (!good) return;
    const cmd = await vscode.window.showInputBox({
      title: t('Bisect (3/3): test command'),
      prompt: t('Exit 0 = works, anything else = broken (e.g. npm test -- login). Empty: the agent investigates.'),
      value: ctx.workspaceState.get<string>('bisect.lastCommand', ''),
      ignoreFocusOut: true,
    });
    if (cmd === undefined) return;
    const tmp = path.join(os.tmpdir(), `agentyard-bisect-${Date.now().toString(36)}`);
    if (!cmd.trim()) {
      // sem comando: o agente conduz o bisect numa worktree própria, destacada
      await addTemp(r.root, tmp, badSha);
      await deps.agentTerms.launchWithPrompt(
        tmp,
        undefined,
        t(
          'This is a temporary worktree (detached HEAD at {0}) created only to find where a bug appeared. The code works at {1} and is broken at {0}. Figure out how to reproduce the problem with a command (ask me what is broken if you do not know), then use `git bisect start {0} {1}` and `git bisect run <command>` to find the first bad commit. Explain what that commit changed and why it broke. Do not commit anything here; when done, run `git bisect reset`.',
          badSha.slice(0, 10),
          good,
        ),
      );
      vscode.window.showInformationMessage(t('Agent opened in a temporary worktree at {0}. Remove it with "Clean up worktrees" when done.', tmp));
      return;
    }
    await ctx.workspaceState.update('bisect.lastCommand', cmd);
    const res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('Bisect between {0} and {1}: running "{2}"…', String(good).slice(0, 10), badSha.slice(0, 10), cmd) },
      () => bisectRun(r.root, tmp, good, badSha, cmd),
    );
    if (!res.sha) {
      const doc = await vscode.workspace.openTextDocument({ language: 'log', content: res.log });
      await vscode.window.showTextDocument(doc, { preview: true });
      vscode.window.showWarningMessage(t('The bisect did not find a first bad commit (see the log).'));
      return;
    }
    const subject = (await r.run(['log', '-1', '--format=%s (%an, %cr)', res.sha])).stdout.trim();
    const show = t('Show commit');
    const explain = t('✦ Explain with the agent');
    const pick = await vscode.window.showInformationMessage(t('First bad commit: {0} — {1}', res.sha.slice(0, 10), subject), show, explain);
    if (pick === show) await vscode.commands.executeCommand('worktreeGraph.showCommitSha', res.sha);
    else if (pick === explain) {
      await deps.agentTerms.launchWithPrompt(
        w.path,
        w.branch,
        t('`git bisect` found that commit {0} broke `{1}` (it passes on {2}). Read the commit (`git show {0}`), explain why it broke and propose the fix. Do not change code before I agree.', res.sha, cmd, good),
      );
    }
  });

  // ------------------------------------------------------------ Claude sem terminal

  const claudeBin = () => ctl.cfg().get<string>('claude.headlessCommand', 'claude');
  const headlessModel = () => ctl.cfg().get<string>('claude.headlessModel', 'haiku') || undefined;
  const language = () => (locale().toLowerCase().startsWith('pt') ? 'Brazilian Portuguese' : 'English');

  reg('claude.commitMessage', async (arg: Arg) => {
    const w = await worktreeOf(arg, t('Commit in which worktree?'));
    if (!w) return;
    const r = repo();
    let diff = (await r.run(['diff', '--cached', '--no-color'], w.path)).stdout;
    let stageAll = false;
    if (!diff.trim()) {
      diff = (await r.run(['diff', '--no-color'], w.path)).stdout;
      const untracked = (await r.run(['ls-files', '--others', '--exclude-standard'], w.path)).stdout.trim();
      if (!diff.trim() && !untracked) {
        vscode.window.showInformationMessage(t('{0} has nothing to commit.', w.name));
        return;
      }
      if (untracked) diff += `\n\nNew files:\n${untracked}`;
      stageAll = true;
    }
    const recent = (await r.run(['log', '-n', '12', '--format=%s'], w.path)).stdout.split(/\r?\n/).filter(Boolean);
    const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Claude is writing the commit message…'), cancellable: true }, (_p, token) => {
      const ac = new AbortController();
      token.onCancellationRequested(() => ac.abort());
      return runHeadless(commitMessagePrompt(diff, recent, language()), { cwd: w.path, bin: claudeBin(), model: headlessModel(), signal: ac.signal });
    });
    const msg = await vscode.window.showInputBox({
      title: stageAll ? t('Commit all changes of {0}', w.name) : t('Commit the staged changes of {0}', w.name),
      value: res.text.split('\n')[0],
      prompt: res.text.includes('\n') ? t('Body: {0}', res.text.split('\n').slice(1).join(' ').trim().slice(0, 200)) : undefined,
      ignoreFocusOut: true,
    });
    if (!msg) return;
    const full = res.text.includes('\n') ? `${msg}\n${res.text.slice(res.text.indexOf('\n'))}` : msg;
    if (stageAll) await r.exec(['add', '-A'], w.path);
    await r.exec(['commit', '-m', full], w.path);
    ctl.scheduleRefresh(50);
    vscode.window.setStatusBarMessage(t('Committed in {0}: {1}', w.name, msg), 5000);
  });

  ctl.requests.describe = async (branch, target, subjects, label) => {
    if (!ctl.cfg().get<boolean>('pullRequests.describeWithClaude', false)) return undefined;
    const r = repo();
    const diff = (await r.run(['diff', '--no-color', `${target}...${branch}`])).stdout;
    try {
      const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Claude is writing the {0} description…', label) }, () =>
        runHeadless(prDescriptionPrompt(branch, target, subjects, diff, label, language()), { cwd: r.root, bin: claudeBin(), model: headlessModel() }),
      );
      return parseTitleBody(res.text);
    } catch (e) {
      vscode.window.showWarningMessage(t('Claude did not write the description: {0}', (e as Error).message));
      return undefined;
    }
  };
}
