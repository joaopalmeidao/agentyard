import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createWorktree } from '../actions';
import type { Controller } from '../controller';
import { gitUri } from '../diff';
import { Worktree } from '../git';
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
    this.tooltip = 'Alterações guardadas com git stash (compartilhadas por todas as worktrees do repositório)';
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
    this.command = { command: 'worktreeGraph.stashShow', title: 'Ver diff', arguments: [this] };
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
    if (!this.ctl.repo) throw new Error('Nenhum repositório git aberto.');
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
    return this.pickWorktree('Em qual worktree?');
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
    const pick = await vscode.window.showWarningMessage(
      `Conflito ao ${what}${branch ? ` em ${branch}` : ''}: ${files.slice(0, 5).join(', ')}${files.length > 5 ? '…' : ''}. O ${op} ficou em andamento na worktree.`,
      `✦ Resolver com ${agent}`,
      'Abrir arquivos',
      `Abortar ${op}`,
    );
    if (!pick) return;
    if (pick.startsWith('✦')) {
      const prompt = [
        `Na worktree da branch ${branch ?? path.basename(wtPath)} há um ${op} em andamento com conflito em: ${files.join(', ')}.`,
        `Contexto: ${what}.`,
        `Resolva os conflitos preservando a intenção das duas mudanças, rode os testes do projeto, faça git add dos arquivos resolvidos e continue com git ${op} --continue.`,
        'Se algo for ambíguo, pergunte antes de decidir.',
      ].join('\n');
      await vscode.commands.executeCommand('worktreeGraph.launchAgentWithPrompt', { path: wtPath, branch, prompt });
    } else if (pick === 'Abrir arquivos') {
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
      if (!opts.quiet) vscode.window.showInformationMessage(`${branch} ainda não foi publicada; não há o que trazer.`);
      return false;
    }
    const remoteBranch = upstream.startsWith(`${remote}/`) ? upstream.slice(remote.length + 1) : upstream.split('/').slice(1).join('/');
    const wt = await this.worktreeOf(branch);
    const progress = <T>(title: string, fn: () => Thenable<T>) =>
      vscode.window.withProgress({ location: opts.quiet ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification, title }, fn);

    if (!wt) {
      // sem worktree: avança a ref local só se for fast-forward (sem "+" no refspec)
      const r = await progress(`Trazendo ${upstream}…`, () => repo.run(['fetch', remote, `refs/heads/${remoteBranch}:refs/heads/${branch}`], repo.root, 300_000));
      if (r.code === 0) return this.pulled(branch, opts.quiet);
      if (!opts.quiet) {
        const go = await vscode.window.showWarningMessage(
          `${branch} e ${upstream} divergiram; sem worktree não dá para mesclar aqui.`,
          'Criar worktree para mesclar',
        );
        if (go) {
          await createWorktree(this.ctl, { existing: branch, quiet: true });
          return this.pull(branch);
        }
      }
      this.ctl.log(`pull ${branch} (sem worktree) falhou: ${(r.stderr || r.stdout).trim()}`);
      return false;
    }

    const st = await repo.status(wt.path);
    if (st.operation) {
      if (!opts.quiet) vscode.window.showWarningMessage(`${branch} está no meio de um ${st.operation}; termine ou aborte antes.`);
      return false;
    }
    let stashed: string | undefined;
    if (st.changes > 0) {
      if (opts.quiet) return false;
      const go = await vscode.window.showWarningMessage(
        `${branch} tem ${st.changes} alteração(ões) não commitada(s).`,
        { modal: true, detail: 'Dá para guardar as alterações num stash, trazer o remoto e devolvê-las em seguida.' },
        'Guardar, trazer e devolver',
      );
      if (!go) return false;
      stashed = await this.stashCreate(wt.path, `worktree-graph: antes de trazer ${upstream}`, { quiet: true });
    }

    let r = await progress(`git pull --ff-only ${upstream}…`, () => repo.run(['pull', '--ff-only', remote, remoteBranch], wt.path, 300_000));
    if (r.code !== 0) {
      const err = (r.stderr || r.stdout).trim();
      const diverged = /fast-forward|diverg/i.test(err);
      if (!diverged || opts.quiet) {
        if (!opts.quiet) vscode.window.showErrorMessage(`Não consegui trazer ${upstream}: ${err}`);
        this.ctl.log(`pull ${branch} falhou: ${err}`);
        if (stashed) await this.stashApply(stashed, wt.path, true, { quiet: true });
        return false;
      }
      const how = await vscode.window.showWarningMessage(
        `${branch} e ${upstream} divergiram (commits dos dois lados).`,
        { modal: true, detail: 'Merge cria um commit juntando os dois lados. Rebase reaplica os seus commits por cima do remoto (reescreve o histórico local).' },
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
        if ((await repo.conflictedFiles(wt.path)).length) await this.onConflict(op, wt.path, branch, `trazer ${upstream}`);
        else vscode.window.showErrorMessage(`O pull falhou: ${(r.stderr || r.stdout).trim()}`);
        if (stashed) vscode.window.showInformationMessage(`Suas alterações estão guardadas no stash "${`worktree-graph: antes de trazer ${upstream}`}"; aplique depois de resolver.`);
        this.ctl.scheduleRefresh(50);
        return false;
      }
    }
    if (stashed && !(await this.stashApply(stashed, wt.path, true, { quiet: true }))) {
      vscode.window.showWarningMessage(`${upstream} foi trazido, mas devolver suas alterações deu conflito; elas continuam no stash.`);
    }
    return this.pulled(branch, opts.quiet);
  }

  private pulled(branch: string, quiet?: boolean) {
    this.ctl.log(`pull ${branch}: ok`);
    this.ctl.scheduleRefresh(50);
    if (!quiet) vscode.window.setStatusBarMessage(`$(cloud-download) ${branch} em dia com o remoto`, 4000);
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
      vscode.window.showInformationMessage('Nenhuma branch com novidades no remoto (faça um fetch para conferir).', 'Fetch agora').then(g => g && this.fetchNow());
      return;
    }
    const items = list.map(x => ({
      label: x.name,
      description: [`↓${x.behind}`, x.ahead ? `↑${x.ahead} local (vai pedir merge/rebase)` : 'fast-forward', x.wt ? (x.clean ? 'worktree limpa' : 'worktree com alterações') : 'sem worktree'].join(' · '),
      picked: x.clean && !x.ahead,
      name: x.name,
    }));
    const chosen = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: `Trazer do remoto: ${items.filter(i => i.picked).length} marcadas (fast-forward em worktree limpa ou sem worktree)`,
    });
    if (!chosen?.length) return;
    const ok: string[] = [];
    const failed: string[] = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Trazendo branches', cancellable: true }, async (p, token) => {
      for (const c of chosen) {
        if (token.isCancellationRequested) break;
        p.report({ message: `${c.name} (${ok.length + failed.length + 1}/${chosen.length})`, increment: 100 / chosen.length });
        ((await this.pull(c.name, { quiet: true })) ? ok : failed).push(c.name);
      }
    });
    this.ctl.scheduleRefresh(50);
    if (failed.length) vscode.window.showWarningMessage(`${ok.length} em dia; ${failed.length} precisam de atenção (divergiram ou têm alterações): ${failed.join(', ')}. Traga essas uma a uma.`);
    else vscode.window.showInformationMessage(`${ok.length} branch(es) em dia com o remoto.`);
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
      this.ctl.log(`fetch falhou: ${(r.stderr || r.stdout).trim()}`);
      if (!opts.quiet) vscode.window.showErrorMessage(`O fetch falhou: ${(r.stderr || r.stdout).trim()}`);
      return;
    }
    await this.ctl.refresh();
    const behind = this.behindList();
    const sig = behind.map(b => `${b.name}:${b.behind}`).join(',');
    if (!opts.quiet) {
      vscode.window.setStatusBarMessage(`$(cloud-download) fetch ok: ${behind.length} branch(es) com novidades`, 4000);
    } else if (opts.notify && behind.length && sig !== this.notifiedBehind) {
      this.notifiedBehind = sig;
      vscode.window
        .showInformationMessage(`${behind.length} branch(es) com novidades no remoto: ${behind.slice(0, 4).map(b => b.name).join(', ')}${behind.length > 4 ? '…' : ''}`, 'Trazer todas')
        .then(g => g && this.pullMany());
    }
  }

  private scheduleFetch() {
    if (this.fetchTimer) clearInterval(this.fetchTimer);
    this.fetchTimer = undefined;
    const minutes = this.ctl.cfg().get<number>('fetch.intervalMinutes', 0);
    if (!minutes || minutes <= 0) return;
    this.fetchTimer = setInterval(() => {
      if (!this.ctl.repo || !vscode.window.state.focused) return;
      this.fetchNow({ quiet: true, notify: true }).catch(e => this.ctl.log(`fetch periódico: ${(e as Error).message}`));
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
      message = await vscode.window.showInputBox({ title: 'Guardar alterações (stash)', prompt: 'Mensagem para achar depois (opcional)', ignoreFocusOut: true });
      if (message === undefined) return undefined;
    }
    const r = await repo.run(['stash', 'push', '--include-untracked', ...(message.trim() ? ['-m', message.trim()] : [])], wtPath, 120_000);
    if (r.code !== 0 || /No local changes/i.test(r.stdout + r.stderr)) {
      if (!opts.quiet) vscode.window.showInformationMessage(r.code !== 0 ? `O stash falhou: ${(r.stderr || r.stdout).trim()}` : 'Nada para guardar: a worktree está limpa.');
      return undefined;
    }
    const sha = (await repo.run(['rev-parse', 'stash@{0}'])).stdout.trim();
    this.ctl.log(`stash ${short(sha)} criado em ${wtPath}`);
    this.ctl.scheduleRefresh(50);
    if (!opts.quiet) vscode.window.setStatusBarMessage(`$(archive) Alterações guardadas no stash ${short(sha)}`, 4000);
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
            ? `O stash conflitou em ${conflicts.length} arquivo(s) (${conflicts.slice(0, 4).join(', ')}); resolva na worktree. O stash foi mantido.`
            : `Não consegui aplicar o stash: ${(r.stderr || r.stdout).trim()}`,
        );
      }
      return false;
    }
    if (pop) await this.stashDrop(sha, { confirm: false });
    if (!opts.quiet) vscode.window.setStatusBarMessage(`$(archive) Stash ${short(sha)} aplicado`, 4000);
    return true;
  }

  async stashDrop(sha: string, opts: { confirm?: boolean } = {}): Promise<boolean> {
    const entry = (await this.stashes()).find(e => e.sha === sha);
    if (!entry) return false;
    if (opts.confirm !== false) {
      const ok = await vscode.window.showWarningMessage(`Apagar o stash "${stashTitle(entry)}"?`, { modal: true, detail: 'As alterações guardadas nele se perdem.' }, 'Apagar');
      if (!ok) return false;
    }
    const r = await this.repo.run(['stash', 'drop', entry.ref]);
    this.ctl.scheduleRefresh(50);
    return r.code === 0;
  }

  async stashShow(sha: string) {
    let r = await this.repo.run(['stash', 'show', '-p', '--include-untracked', sha]);
    if (r.code !== 0) r = await this.repo.run(['stash', 'show', '-p', sha]);
    const doc = await vscode.workspace.openTextDocument({ language: 'diff', content: r.stdout || (r.stderr || '(vazio)') });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  /** Leva as alterações não commitadas de uma worktree para outra (stash + apply + drop). */
  async moveChanges(fromPath: string, toPath: string): Promise<boolean> {
    const wts = await this.repo.worktreesFast();
    const name = (p: string) => wts.find(w => w.path.toLowerCase() === p.toLowerCase())?.branch ?? path.basename(p);
    const sha = await this.stashCreate(fromPath, `worktree-graph: de ${name(fromPath)} para ${name(toPath)}`, { quiet: true });
    if (!sha) {
      vscode.window.showInformationMessage(`${name(fromPath)} não tem alterações para mover.`);
      return false;
    }
    const ok = await this.stashApply(sha, toPath, true, { quiet: true });
    if (ok) vscode.window.showInformationMessage(`Alterações movidas de ${name(fromPath)} para ${name(toPath)}.`);
    else vscode.window.showWarningMessage(`Não deu para aplicar em ${name(toPath)} sem conflito; as alterações ficaram guardadas no stash ${short(sha)} (view Worktrees → Stashes).`);
    return ok;
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
    return parts.join('\n') || '(nada)';
  }

  async showUncommitted(wtPath: string, items?: Uncommitted[], title?: string) {
    items ??= await this.uncommitted(wtPath);
    if (!items.length) {
      vscode.window.showInformationMessage('A worktree está limpa: nada não commitado.');
      return;
    }
    const head = title ? `# ${title}\n# ${items.length} arquivo(s)\n\n` : '';
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
      vscode.window.showWarningMessage(`Há um ${st.operation} em andamento nesta worktree; termine ou aborte antes de descartar.`);
      return false;
    }
    const wts = await repo.worktreesFast();
    const name = wts.find(w => w.path.toLowerCase() === wtPath.toLowerCase())?.branch ?? path.basename(wtPath);
    const all = await this.uncommitted(wtPath);
    let items = paths ? all.filter(u => paths.includes(u.path)) : all;
    if (!items.length) {
      vscode.window.showInformationMessage(paths ? 'Esses arquivos não têm alterações não commitadas.' : `${name} está limpa: nada para descartar.`);
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
        { canPickMany: true, title: `Descartar alterações de ${name}: desmarque o que quer manter`, matchOnDescription: true, ignoreFocusOut: true },
      );
      if (!picked?.length) return false;
      items = picked.map(p => p.u);
    }
    const partial = items.length < all.length;
    await this.showUncommitted(wtPath, items, `O que será descartado de ${name}`);
    const ok = await vscode.window.showWarningMessage(
      `Descartar ${items.length} arquivo(s) não commitado(s) de ${name}?`,
      {
        modal: true,
        detail:
          `${discardSummary(items)}\n\nO patch completo está aberto no editor. Antes de descartar, uma cópia vai para um stash ` +
          `(view Worktrees → Stashes), então dá para desfazer.` +
          (partial ? `\n\nOs outros ${all.length - items.length} arquivo(s) alterado(s) não são tocados.` : ''),
      },
      'Descartar',
    );
    if (ok !== 'Descartar') return false;

    const message = `worktree-graph: descartado de ${name} (${items.length} arquivo(s)) ${new Date().toLocaleString()}`;
    const args = ['stash', 'push', '--include-untracked', '-m', message];
    const r = await repo.run(partial ? [...args, '--', ...items.map(u => u.path)] : args, wtPath, 120_000);
    this.ctl.scheduleRefresh(50);
    if (r.code !== 0) {
      vscode.window.showErrorMessage(`Não consegui descartar (nada foi apagado): ${(r.stderr || r.stdout).trim()}`);
      return false;
    }
    const entry = (await this.stashes()).find(e => e.message.endsWith(message));
    this.ctl.log(`descartado em ${wtPath}: ${items.map(u => u.path).join(', ')}${entry ? ` (cópia no stash ${short(entry.sha)})` : ''}`);
    if (!entry) {
      vscode.window.showInformationMessage(`${items.length} arquivo(s) descartado(s) de ${name}.`);
      return true;
    }
    vscode.window.showInformationMessage(`${items.length} arquivo(s) descartado(s) de ${name}. Cópia no stash ${short(entry.sha)}.`, 'Desfazer', 'Ver o que saiu').then(async pick => {
      if (pick === 'Desfazer') {
        if (await this.stashApply(entry.sha, wtPath, true, { quiet: true })) vscode.window.setStatusBarMessage(`$(discard) Descarte desfeito em ${name}`, 4000);
        else vscode.window.showWarningMessage(`Não deu para devolver sem conflito; a cópia continua no stash ${short(entry.sha)}.`);
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
        (await vscode.window.showInformationMessage(`${target} não está aberta numa worktree.`, { modal: true, detail: 'O cherry-pick precisa de uma worktree da branch de destino.' }, 'Criar worktree e aplicar'));
      if (!go) return false;
      await createWorktree(this.ctl, { existing: target, quiet: true });
      wt = await this.worktreeOf(target);
      if (!wt) return false;
    }
    const st = await repo.status(wt.path);
    if (st.operation || st.changes > 0) {
      vscode.window.showWarningMessage(`${target} tem ${st.operation ? `um ${st.operation} em andamento` : `${st.changes} alteração(ões) não commitada(s)`}; resolva antes do cherry-pick.`);
      return false;
    }
    if (opts.confirm !== false) {
      const ok = await vscode.window.showInformationMessage(
        `Aplicar o commit ${short(sha)} em ${target}?`,
        { modal: true, detail: `"${subject}"${parents.length > 1 ? '\n\nÉ um commit de merge: será aplicado em relação ao primeiro pai (-m 1).' : ''}` },
        'Aplicar',
      );
      if (!ok) return false;
    }
    const r = await repo.run(['cherry-pick', ...(parents.length > 1 ? ['-m', '1'] : []), sha], wt.path, 120_000);
    this.ctl.scheduleRefresh(50);
    if (r.code === 0) {
      this.ctl.log(`cherry-pick ${short(sha)} em ${target}: ok`);
      if (opts.confirm !== false) vscode.window.showInformationMessage(`Commit ${short(sha)} aplicado em ${target}.`);
      return true;
    }
    if ((await repo.conflictedFiles(wt.path)).length) {
      await this.onConflict('cherry-pick', wt.path, target, `aplicar o commit ${short(sha)} ("${subject}")`);
    } else if (/empty|nothing to commit/i.test(r.stderr + r.stdout)) {
      await repo.run(['cherry-pick', '--abort'], wt.path);
      vscode.window.showInformationMessage(`${target} já tem as mudanças do commit ${short(sha)}; nada a aplicar.`);
    } else {
      await repo.run(['cherry-pick', '--abort'], wt.path);
      vscode.window.showErrorMessage(`O cherry-pick falhou: ${(r.stderr || r.stdout).trim()}`);
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
        { label: '$(play) Aplicar', description: 'reorganiza os commits (antes cria uma cópia de segurança)', id: 'apply' },
        { label: '$(close) Cancelar', id: 'cancel' },
        { label: 'do mais antigo para o mais novo', kind: vscode.QuickPickItemKind.Separator, id: 'sep' },
        ...current.map((s, i) => ({
          label: `${icon[s.action]} ${s.action === 'reword' ? s.message : s.subject}`,
          description: `${s.action}${s.action === 'squash' || s.action === 'fixup' ? ' ↑ junta com o anterior' : ''} · ${short(s.sha)}`,
          id: 'step',
          i,
        })),
      ];
      const pick = await vscode.window.showQuickPick(items, { title: `Reorganizar commits de ${branch}`, placeHolder: 'Escolha um commit para mudar, ou Aplicar', ignoreFocusOut: true });
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
          { label: '$(arrow-up) Mover para cima (mais antigo)', v: 'up' },
          { label: '$(arrow-down) Mover para baixo (mais novo)', v: 'down' },
          { label: '$(check) pick', description: 'manter como está', v: 'pick' },
          { label: '$(fold-up) squash', description: 'juntar com o anterior, somando as mensagens', v: 'squash' },
          { label: '$(fold-up) fixup', description: 'juntar com o anterior, descartando esta mensagem', v: 'fixup' },
          { label: '$(edit) reword', description: 'trocar a mensagem', v: 'reword' },
          { label: '$(trash) drop', description: 'descartar este commit', v: 'drop' },
        ],
        { title: step.subject },
      );
      if (!act) continue;
      if (act.v === 'up') current = movePlan(current, i, -1);
      else if (act.v === 'down') current = movePlan(current, i, 1);
      else if (act.v === 'reword') {
        const msg = await vscode.window.showInputBox({ title: 'Nova mensagem', value: step.message ?? step.subject, ignoreFocusOut: true });
        if (msg?.trim()) current = current.map((s, k) => (k === i ? { ...s, action: 'reword', message: msg.trim() } : s));
      } else current = current.map((s, k) => (k === i ? { ...s, action: act.v as RebaseAction, message: undefined } : s));
    }
  }

  /** Rebase interativo sem editor: o roteiro vem do plano (ou do assistente) e vai por GIT_SEQUENCE_EDITOR. */
  async reorganize(wtPath: string, plan?: PlanStep[]): Promise<boolean> {
    const repo = this.repo;
    const branch = (await repo.worktreesFast()).find(w => w.path.toLowerCase() === wtPath.toLowerCase())?.branch;
    if (!branch) {
      vscode.window.showWarningMessage('A worktree precisa estar numa branch.');
      return false;
    }
    const st = await repo.status(wtPath);
    if (st.operation || st.changes > 0) {
      vscode.window.showWarningMessage(`${branch} precisa estar limpa para reorganizar commits (${st.operation ? `${st.operation} em andamento` : `${st.changes} alteração(ões)`}).`);
      return false;
    }
    const { mb, baseRef, commits } = await this.commitsSinceBase(wtPath);
    if (commits.length < 1) {
      vscode.window.showInformationMessage(`${branch} não tem commits além de ${baseRef}.`);
      return false;
    }
    if (commits.some(c => c.merge)) {
      vscode.window.showWarningMessage(`${branch} tem commits de merge desde ${baseRef}; reorganizar com rebase os achataria. Faça isso no terminal com git rebase -i --rebase-merges.`);
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
      vscode.window.showInformationMessage('Nada mudou no plano.');
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

    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Reorganizando commits de ${branch}…` }, () =>
      repo.run(['rebase', '-i', mb], wtPath, 300_000, {
        // o git chama `$GIT_SEQUENCE_EDITOR <arquivo-do-roteiro>` pelo sh: basta copiar o nosso por cima
        GIT_SEQUENCE_EDITOR: `cp "${todo.replace(/\\/g, '/')}"`,
        GIT_EDITOR: 'true',
      }),
    );
    this.ctl.scheduleRefresh(50);
    if (r.code === 0) {
      this.ctl.log(`rebase -i em ${branch}: ok (cópia de segurança ${backup})`);
      vscode.window.showInformationMessage(`Commits de ${branch} reorganizados.`, 'Desfazer').then(g => g && this.undoReorganize(branch));
      return true;
    }
    if ((await repo.conflictedFiles(wtPath)).length) {
      await this.onConflict('rebase', wtPath, branch, 'reorganizar os commits (rebase interativo)');
    } else {
      await repo.run(['rebase', '--abort'], wtPath);
      vscode.window.showErrorMessage(`Não deu para reorganizar; nada foi alterado: ${(r.stderr || r.stdout).trim()}`);
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
      vscode.window.showInformationMessage(`Não há cópia de segurança de ${branch}.`);
      return false;
    }
    const r = await repo.run(['reset', '--keep', backup], wt.path);
    this.ctl.scheduleRefresh(50);
    if (r.code !== 0) {
      vscode.window.showErrorMessage(`Não consegui desfazer: ${(r.stderr || r.stdout).trim()}`);
      return false;
    }
    vscode.window.setStatusBarMessage(`$(history) ${branch} voltou ao estado anterior`, 4000);
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
    a ??= await this.pickBranch('Comparar qual branch?');
    if (!a) return;
    b ??= await this.pickBranch(`Comparar ${a} com…`, a);
    if (!b) return;
    const files = await this.compareFiles(a, b);
    if (!files.length) {
      vscode.window.showInformationMessage(`${a} e ${b} têm o mesmo conteúdo.`);
      return;
    }
    const label: Record<string, string> = { A: `só em ${b}`, D: `só em ${a}`, M: 'diferente', T: 'tipo diferente' };
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { f: (typeof files)[number] }>();
    qp.title = `${a} ↔ ${b}: ${files.length} arquivo(s)`;
    qp.placeholder = 'Enter abre o diff; a lista continua aberta';
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
    const b = await need(a, 'Trazer qual branch do remoto?');
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
    const target = typeof a === 'object' && a?.path ? { path: a.path } : await ops.pickWorktree(pop ? 'Aplicar e remover o stash em qual worktree?' : 'Aplicar o stash em qual worktree?');
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
    const to = typeof a === 'object' && a?.target ? await ops.pathOf(a.target) : await ops.pickWorktree(`Mover as alterações de ${from.branch ?? path.basename(from.path)} para…`, from.path);
    if (to) await ops.moveChanges(from.path, to.path);
  });

  // alterações não commitadas: arg é a worktree ({ path }) ou arquivos do grupo "Não commitadas" ({ path, file })
  const filesOf = (a: any, sel?: any[]): string[] | undefined => {
    const list = (sel?.length ? sel : [a]).filter(x => x?.file && x.path === a?.path).map(x => x.file as string);
    return list.length ? list : undefined;
  };
  reg('showUncommitted', async (a: Arg) => {
    const w = await ops.pathOf(a);
    if (w) await ops.showUncommitted(w.path, undefined, `Não commitado em ${w.branch ?? path.basename(w.path)}`);
  });
  reg('discardChanges', async (a: any, sel?: any[]) => {
    const w = await ops.pathOf(a);
    if (w) await ops.discard(w.path, filesOf(a, sel));
  });

  reg('cherryPick', async (a: any) => {
    const sha = shaOf(a);
    if (!sha) return;
    const target = a?.target ?? (await ops.pickBranch(`Aplicar o commit ${short(sha)} em…`));
    if (target) await ops.cherryPick(sha, target);
  });
  reg('reorganizeCommits', async (a: Arg) => {
    const w = await ops.pathOf(a);
    if (w) await ops.reorganize(w.path);
  });
  reg('undoReorganize', async (a: Arg) => {
    const b = await need(a, 'Desfazer a reorganização de qual branch?');
    if (b) await ops.undoReorganize(b);
  });
  reg('compareWith', (a: Arg, b?: string) => ops.compareWith(branchOf(a), typeof b === 'string' ? b : undefined));

  return ops;
}

async function pickStash(ops: GitOps): Promise<string | undefined> {
  const list = await ops.stashes();
  if (!list.length) {
    vscode.window.showInformationMessage('Não há stashes.');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    list.map(e => ({ label: stashTitle(e), description: [e.branch, ago(e.date)].filter(Boolean).join(' · '), sha: e.sha })),
    { placeHolder: 'Qual stash?' },
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
  const head = `diff --git a/${rel} b/${rel}\nnew file (não rastreado)\n--- /dev/null\n+++ b/${rel}`;
  if (untrackedStats(path.join(cwd, rel)).binary) return `${head}\n(binário ou grande demais para mostrar)`;
  let text: string;
  try {
    text = fs.readFileSync(path.join(cwd, rel), 'utf8');
  } catch {
    return `${head}\n(não consegui ler o arquivo)`;
  }
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return `${head}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l => '+' + l.replace(/\r$/, '')).join('\n')}`;
}
