import * as vscode from 'vscode';
import * as actions from '../actions';
import type { AgentTerminals } from '../agents';
import { keyOf } from '../agentFlow/head';
import type { Controller } from '../controller';
import { t } from '../i18n';
import type { registerPullRequests } from '../prs/view';
import { clearParent, descendants, readStack, restack, revParse, setParent, StackLink, stackOf, stackState, StackState } from './core';

type Prs = ReturnType<typeof registerPullRequests>;
type Arg = { branch?: string; path?: string } | string | undefined;

/**
 * Branches empilhadas: criar uma worktree em cima de outra branch, publicar o PR contra o pai e,
 * quando o pai anda (ou entra na base), trazer os filhos para cima dele (restack) — e trocar o
 * destino do PR quando o pai já foi mesclado.
 */
export function registerStack(ctx: vscode.ExtensionContext, ctl: Controller, guard: <T extends unknown[]>(fn: (...a: T) => unknown) => (...a: T) => Promise<void>, deps: { prs: Prs; agentTerms: AgentTerminals }) {
  let links = new Map<string, StackLink>();
  let states = new Map<string, StackState>();
  /** Avisos já dados (branch + commit do pai), para não repetir a cada refresh. */
  const told = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let computing = false;

  ctl.stateHooks.push(s => {
    for (const w of s.worktrees) {
      const l = w.branch ? links.get(w.branch) : undefined;
      w.stack = l ? { parent: l.parent, state: states.get(w.branch!) ?? 'ok' } : undefined;
    }
  });
  ctl.requests.preferredTarget = b => links.get(b)?.parent;

  const root = () => ctl.repo?.root;

  const recompute = async () => {
    const r = root();
    if (!r || computing) return;
    computing = true;
    try {
      const base = (await ctl.base()).base;
      links = await readStack(r);
      const next = new Map<string, StackState>();
      for (const [b, l] of links) next.set(b, await stackState(r, b, l, base).catch(() => 'ok' as StackState));
      const changed = JSON.stringify([...next]) !== JSON.stringify([...states]);
      states = next;
      if (changed) ctl.repaint();
      await offer(base);
    } finally {
      computing = false;
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void recompute(), 1500);
  };
  ctx.subscriptions.push(ctl.onDidChange(() => schedule()), ctl.onDidChangeRepo(() => schedule()), { dispose: () => timer && clearTimeout(timer) });
  schedule();

  /** Pai andou ou entrou na base: avisa (ou faz sozinho, com stack.autoRestack = auto). */
  const offer = async (base: string) => {
    const mode = ctl.cfg().get<string>('stack.autoRestack', 'ask');
    if (mode === 'off') return;
    const r = root();
    if (!r) return;
    for (const [b, st] of states) {
      if (st === 'ok') continue;
      const l = links.get(b)!;
      const key = `${b}|${l.parent}|${(await revParse(r, l.parent)) ?? 'gone'}`;
      if (told.has(key)) continue;
      told.add(key);
      // só as de baixo da pilha: os filhos vão junto
      if (links.has(l.parent) && states.get(l.parent) !== 'ok') continue;
      if (mode === 'auto') {
        await restackTree(b, base, true);
        continue;
      }
      const go = t('Restack');
      const msg =
        st === 'parent-merged' || st === 'parent-gone'
          ? t('{0} is already in {1}: move {2} (and the branches stacked on it) onto {1}?', l.parent, base, b)
          : t('{0} got new commits: restack {1} (and the branches stacked on it) onto it?', l.parent, b);
      void vscode.window.showInformationMessage(msg, go).then(p => (p ? restackTree(b, base, false) : undefined));
    }
  };

  const worktreeOf = (branch: string) => ctl.state?.worktrees.find(w => w.branch === branch && !w.prunable);

  /** Restack de uma branch e dos que estão em cima dela, em ordem; conflito para ali e oferece o agente. */
  const restackTree = async (branch: string, base: string, quiet: boolean) => {
    const r = root();
    if (!r) return;
    links = await readStack(r);
    const order = [branch, ...descendants(links, branch)].filter(b => links.has(b));
    const done: string[] = [];
    const skipped: string[] = [];
    const retargeted: { branch: string; parent: string }[] = [];
    for (const b of order) {
      const l = links.get(b)!;
      const wt = worktreeOf(b);
      if (!wt) {
        skipped.push(t('{0} (no worktree)', b));
        continue;
      }
      const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: t('Restacking {0}…', b) }, () => restack(wt.path, b, l, base));
      if (res.ok) {
        done.push(b);
        if (res.parent !== l.parent) retargeted.push({ branch: b, parent: res.parent });
        links = await readStack(r);
        continue;
      }
      if (res.conflict) {
        const ask = t('✦ Resolve with the agent');
        const pick = await vscode.window.showWarningMessage(t('Restack of {0} onto {1} stopped on a conflict; nothing was changed.', b, l.parent), { detail: res.message }, ask);
        if (pick === ask) {
          const onto = res.parent === l.parent ? l.parent : base;
          await deps.agentTerms.launchWithPrompt(
            wt.path,
            b,
            t(
              'Branch {0} is stacked on {1}, which got new commits. Move only the commits of {0} onto {1} with `git rebase --onto {1} {2} {0}`, resolve the conflicts keeping the intent of both sides, run the tests and finish the rebase. Do not push.',
              b,
              onto,
              l.tip ?? l.parent,
            ),
          );
        }
        break;
      }
      skipped.push(`${b} (${res.message === 'uncommitted changes' ? t('uncommitted changes') : res.message})`);
    }
    await recompute();
    ctl.scheduleRefresh(50);
    for (const x of retargeted) await retargetPr(x.branch, x.parent, quiet);
    if (done.length) {
      const push = t('Push (force-with-lease)');
      const published = done.filter(b => worktreeOf(b)?.remote.published);
      const msg = t('Restacked: {0}.', done.join(', ')) + (skipped.length ? ` ${t('Skipped: {0}.', skipped.join(', '))}` : '');
      const pick = published.length ? await vscode.window.showInformationMessage(msg, push) : (vscode.window.showInformationMessage(msg), undefined);
      if (pick === push) await forcePush(published);
    } else if (skipped.length && !quiet) vscode.window.showWarningMessage(t('Nothing restacked. Skipped: {0}.', skipped.join(', ')));
  };

  /** O rebase reescreveu branches já enviadas: push com --force-with-lease, confirmado. */
  const forcePush = async (branches: string[]) => {
    const repo = ctl.repo;
    if (!repo) return;
    const remote = ctl.remoteName();
    for (const b of branches) {
      const r = await repo.run(['push', '--force-with-lease', remote, `${b}:${b}`], repo.root, 300_000);
      if (r.code !== 0) vscode.window.showErrorMessage(t('Push of {0} refused: {1}', b, (r.stderr || r.stdout).trim()));
    }
    ctl.scheduleRefresh(50);
  };

  /** O pai entrou na base: o PR da branch passa a apontar para a base. */
  const retargetPr = async (branch: string, target: string, quiet: boolean) => {
    const b = await deps.prs.svc.browser();
    await deps.prs.svc.refresh(true);
    const pr = deps.prs.svc.all().find(p => p.source === branch && (p.state === 'open' || p.state === 'draft'));
    if (!b || !pr || pr.target === target) return;
    try {
      await b.retarget(pr, target);
      if (!quiet) vscode.window.showInformationMessage(t('{0} now targets {1}.', pr.ref, target));
    } catch (e) {
      vscode.window.showWarningMessage(t('Could not change the target of {0} to {1}: {2}', pr.ref, target, (e as Error).message));
    }
  };

  const branchOf = async (arg: Arg, placeHolder: string) => {
    if (typeof arg === 'string') return arg;
    if (arg?.branch) return arg.branch;
    if (arg?.path) return ctl.state?.worktrees.find(w => keyOf(w.path) === keyOf(arg.path!))?.branch;
    return actions.pickBranch(ctl, undefined, placeHolder, true);
  };

  const reg = (id: string, fn: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(`worktreeGraph.${id}`, guard(fn)));

  reg('stack.newChild', async (arg: Arg) => {
    const parent = await branchOf(arg, t('Stack a new branch on which branch?'));
    const r = root();
    if (!parent || !r) return;
    const names = new Set((await ctl.repo!.refs()).filter(x => x.kind === 'head').map(x => x.name));
    const branch = await vscode.window.showInputBox({
      title: t('New worktree stacked on {0}', parent),
      prompt: t('Branch name (e.g. ai/refactor-login)'),
      validateInput: v => (!v.trim() ? t('Enter a name.') : /[\s~^:?*[\\]|\.\.|@\{|\/$|^\/|\.lock$/.test(v) ? t('Invalid branch name.') : names.has(v) ? t('That branch already exists.') : undefined),
    });
    if (!branch) return;
    const dir = await actions.createWorktree(ctl, { branch, startPoint: parent, quiet: true });
    if (!dir) return;
    await setParent(r, branch, parent);
    await recompute();
    const agent = t('✦ Open agent');
    const pick = await vscode.window.showInformationMessage(t('Worktree {0} created, stacked on {1}. Its PR will target {1}.', branch, parent), agent);
    if (pick) await vscode.commands.executeCommand('worktreeGraph.launchAgent', { path: dir, branch });
  });

  reg('stack.setParent', async (arg: Arg) => {
    const branch = await branchOf(arg, t('Stack which branch?'));
    const r = root();
    if (!branch || !r) return;
    const base = (await ctl.base()).base;
    const heads = (await ctl.repo!.refs()).filter(x => x.kind === 'head' && x.name !== branch && x.name !== base).map(x => x.name);
    const cur = links.get(branch)?.parent;
    const pick = await vscode.window.showQuickPick(
      [{ label: base, description: t('not stacked (comes out of the base)'), value: '' }, ...heads.map(h => ({ label: h, description: h === cur ? t('current parent') : '', value: h }))],
      { placeHolder: t('{0} comes out of which branch?', branch) },
    );
    if (!pick) return;
    if (!pick.value) await clearParent(r, branch);
    else {
      // o ponto em comum com o novo pai é de onde a branch saiu
      const mb = (await ctl.repo!.run(['merge-base', pick.value, branch])).stdout.trim();
      await setParent(r, branch, pick.value, mb || undefined);
    }
    await recompute();
  });

  reg('stack.restack', async (arg: Arg) => {
    const branch = await branchOf(arg, t('Restack which branch?'));
    if (!branch) return;
    if (!links.has(branch)) {
      vscode.window.showInformationMessage(t('{0} is not stacked on another branch.', branch));
      return;
    }
    await restackTree(branch, (await ctl.base()).base, false);
  });

  reg('stack.show', async (arg: Arg) => {
    const branch = await branchOf(arg, t('Stack of which branch?'));
    if (!branch) return;
    await recompute();
    const list = stackOf(links, branch);
    const label: Record<StackState, string> = {
      ok: t('up to date'),
      behind: t('needs restack'),
      'parent-merged': t('parent already merged'),
      'parent-gone': t('parent deleted'),
    };
    const pick = await vscode.window.showQuickPick(
      list.map((b, i) => ({
        label: `${'  '.repeat(i)}${i ? '↳ ' : ''}${b}`,
        description: [links.has(b) ? label[states.get(b) ?? 'ok'] : t('bottom of the stack'), worktreeOf(b)?.request?.ref].filter(Boolean).join(' · '),
        b,
      })),
      { placeHolder: t('Stack of {0}', branch) },
    );
    if (pick) await vscode.commands.executeCommand('worktreeGraph.branchSummary', pick.b);
  });

  return { recompute, links: () => links };
}
