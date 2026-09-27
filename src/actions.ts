import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Controller } from './controller';
import { gitUri } from './diff';
import { Repo, Worktree } from './git';

type BranchArg = string | { branch?: string } | undefined;

function repoOf(ctl: Controller): Repo {
  if (!ctl.repo) throw new Error('Nenhum repositório git aberto neste workspace.');
  return ctl.repo;
}

/** Aceita nome de branch (webview), item da árvore ou nada (paleta → QuickPick). */
export async function pickBranch(ctl: Controller, arg: BranchArg, placeHolder: string, onlyWorktrees = false): Promise<string | undefined> {
  if (typeof arg === 'string') return arg;
  if (arg?.branch) return arg.branch;
  const repo = repoOf(ctl);
  const wts = await repo.worktrees();
  const items: vscode.QuickPickItem[] = wts
    .filter(w => w.branch)
    .map(w => ({ label: w.branch!, description: w.path, iconPath: new vscode.ThemeIcon('folder') }));
  if (!onlyWorktrees) {
    const withWt = new Set(items.map(i => i.label));
    for (const r of await repo.refs()) {
      if (r.kind === 'head' && !withWt.has(r.name)) items.push({ label: r.name, description: 'sem worktree', iconPath: new vscode.ThemeIcon('git-branch') });
    }
  }
  return (await vscode.window.showQuickPick(items, { placeHolder }))?.label;
}

async function worktreeOf(repo: Repo, branch: string): Promise<Worktree | undefined> {
  return (await repo.worktrees()).find(w => w.branch === branch);
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
    vscode.window.showInformationMessage(`${target} já contém tudo de ${source}.`);
    return false;
  }
  if (opts.confirm !== false) {
    const preview = await repo.mergePreview(target, source);
    const detail = [
      `${sourceAhead} commit(s) de ${source} entram em ${target}.`,
      targetAhead === 0 ? 'Vai ser um fast-forward.' : '',
      preview?.conflict ? `⚠ A simulação prevê conflito em: ${preview.files.slice(0, 8).join(', ')}${preview.files.length > 8 ? '…' : ''}` : preview ? 'A simulação não encontrou conflitos.' : '',
    ]
      .filter(Boolean)
      .join('\n');
    const ok = await vscode.window.showInformationMessage(`Mesclar ${source} em ${target}?`, { modal: true, detail }, 'Mesclar');
    if (ok !== 'Mesclar') return false;
  }

  const noFf = target === base && ctl.cfg().get('noFastForwardIntoBase', true);
  const args = ['merge', '--no-edit', ...(noFf ? ['--no-ff'] : []), source];
  const wt = await worktreeOf(repo, target);

  try {
    if (wt) {
      const st = await repo.status(wt.path);
      if (st.operation) {
        vscode.window.showErrorMessage(`A worktree de ${target} está no meio de um ${st.operation}. Termine ou aborte antes.`);
        return false;
      }
      if (st.changes > 0) {
        const go = await vscode.window.showWarningMessage(
          `A worktree de ${target} tem ${st.changes} alteração(ões) não commitada(s).`,
          { modal: true, detail: 'O git recusa o merge se ele tocar nesses arquivos. Se for um agente trabalhando nela, o ideal é esperar o commit.' },
          'Mesclar mesmo assim',
        );
        if (!go) return false;
      }
      ctl.log(`git ${args.join(' ')}  (em ${wt.path})`);
      const r = await repo.run(args, wt.path, 300_000);
      if (r.code === 0) {
        await afterMerge(ctl, source, target, base, opts.quiet);
        return true;
      }
      const conflicts = await repo.conflictedFiles(wt.path);
      if (conflicts.length === 0) {
        vscode.window.showErrorMessage(`Merge falhou: ${(r.stderr || r.stdout).trim()}`);
        return false;
      }
      const pick = await vscode.window.showWarningMessage(
        `Conflito ao mesclar ${source} em ${target} (${conflicts.length} arquivo(s)). O merge ficou em andamento na worktree.`,
        'Abrir arquivos',
        'Abrir worktree',
        'Abortar merge',
      );
      if (pick === 'Abrir arquivos') {
        for (const f of conflicts.slice(0, 20)) await vscode.window.showTextDocument(vscode.Uri.file(path.join(wt.path, f)), { preview: false });
      } else if (pick === 'Abrir worktree') {
        await openWorktree(ctl, target);
      } else if (pick === 'Abortar merge') {
        await repo.run(['merge', '--abort'], wt.path);
      }
      return false;
    }

    const tmp = path.join(os.tmpdir(), `wtgraph-${process.pid}-${Date.now()}`);
    await repo.exec(['worktree', 'add', '--quiet', tmp, target]);
    try {
      ctl.log(`git ${args.join(' ')}  (em worktree temporária ${tmp})`);
      const r = await repo.run(args, tmp, 300_000);
      if (r.code === 0) {
        await afterMerge(ctl, source, target, base, opts.quiet);
        return true;
      }
      const conflicts = await repo.conflictedFiles(tmp);
      await repo.run(['merge', '--abort'], tmp);
      const pick = await vscode.window.showWarningMessage(
        conflicts.length
          ? `Conflito ao mesclar ${source} em ${target}: ${conflicts.slice(0, 5).join(', ')}. Nada foi alterado.`
          : `Merge falhou: ${(r.stderr || r.stdout).trim()}`,
        `Criar worktree de ${target} para resolver`,
      );
      if (pick) await createWorktree(ctl, { existing: target });
      return false;
    } finally {
      await repo.run(['worktree', 'remove', '--force', tmp]);
    }
  } finally {
    ctl.scheduleRefresh(100);
  }
}

async function afterMerge(ctl: Controller, source: string, target: string, base: string, quiet?: boolean) {
  ctl.log(`${source} mesclada em ${target}.`);
  if (quiet) return;
  if (target === base && source !== base) {
    const repo = repoOf(ctl);
    const wt = await worktreeOf(repo, source);
    const pick = await vscode.window.showInformationMessage(
      `${source} mesclada em ${target}.`,
      wt ? 'Remover worktree e branch' : 'Excluir branch',
    );
    if (pick === 'Remover worktree e branch') await removeWorktree(ctl, source, { alsoBranch: true });
    else if (pick === 'Excluir branch') await deleteBranch(ctl, source);
  } else {
    vscode.window.showInformationMessage(`${source} mesclada em ${target}.`);
  }
}

export async function mergeBaseInto(ctl: Controller, arg: BranchArg) {
  const branch = await pickBranch(ctl, arg, 'Trazer a base para qual branch?');
  if (!branch) return;
  const { baseRef } = await ctl.base();
  await mergeBranches(ctl, baseRef, branch);
}

export async function mergeIntoBase(ctl: Controller, arg: BranchArg) {
  const branch = await pickBranch(ctl, arg, 'Mesclar qual branch na base?');
  if (!branch) return;
  const { base } = await ctl.base();
  await mergeBranches(ctl, branch, base);
}

export async function mergeInto(ctl: Controller, arg: BranchArg) {
  const source = await pickBranch(ctl, arg, 'Mesclar qual branch?');
  if (!source) return;
  const repo = repoOf(ctl);
  const items = (await repo.refs())
    .filter(r => r.kind === 'head' && r.name !== source)
    .map(r => ({ label: r.name, description: r.subject }));
  const target = await vscode.window.showQuickPick(items, { placeHolder: `Mesclar ${source} em…` });
  if (target) await mergeBranches(ctl, source, target.label);
}

export async function createWorktree(ctl: Controller, opts: { startPoint?: string; existing?: string } = {}) {
  const repo = repoOf(ctl);
  const { base } = await ctl.base();
  let branch = opts.existing;
  if (!branch) {
    const names = new Set((await repo.refs()).filter(r => r.kind === 'head').map(r => r.name));
    branch = await vscode.window.showInputBox({
      title: `Nova worktree a partir de ${opts.startPoint ?? base}`,
      prompt: 'Nome da branch (ex.: ai/refatorar-login)',
      validateInput: v => {
        if (!v.trim()) return 'Informe um nome.';
        if (/[\s~^:?*[\\]|\.\.|@\{|\/$|^\/|\.lock$/.test(v)) return 'Nome de branch inválido.';
        if (names.has(v)) return 'Essa branch já existe.';
        return undefined;
      },
    });
    if (!branch) return;
  }
  const configured = ctl.cfg().get<string>('worktreeRoot', '');
  const mainPath = (await repo.worktrees())[0]?.path ?? repo.root;
  const root = configured || path.join(path.dirname(mainPath), `${path.basename(mainPath)}.worktrees`);
  let dir = path.join(root, branch.replace(/[\/\\]/g, '-'));
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(root, `${branch.replace(/[\/\\]/g, '-')}-${i}`);

  const args = opts.existing ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, opts.startPoint ?? base];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Criando worktree ${branch}…` }, () => repo.exec(args, repo.root, 300_000));
  ctl.log(`Worktree criada: ${dir} (${branch})`);
  ctl.scheduleRefresh(100);

  const post = ctl.cfg().get<string>('postCreateCommand', '');
  if (post) {
    const t = vscode.window.createTerminal({ name: `${branch}: setup`, cwd: dir });
    t.show(true);
    t.sendText(post);
  }
  const pick = await vscode.window.showInformationMessage(`Worktree ${branch} criada em ${dir}.`, 'Abrir em nova janela', 'Abrir terminal');
  if (pick === 'Abrir em nova janela') await openWorktree(ctl, branch);
  else if (pick === 'Abrir terminal') await openTerminal(ctl, branch);
}

export async function openWorktree(ctl: Controller, arg: BranchArg | { path?: string }) {
  const p = typeof arg === 'object' && arg && 'path' in arg && arg.path ? arg.path : undefined;
  const target = p ?? (await worktreeOf(repoOf(ctl), (await pickBranch(ctl, arg as BranchArg, 'Abrir qual worktree?', true)) ?? ''))?.path;
  if (target) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: true });
}

export async function openTerminal(ctl: Controller, arg: BranchArg | { path?: string }) {
  const p = typeof arg === 'object' && arg && 'path' in arg && arg.path ? arg.path : undefined;
  const branch = p ? undefined : await pickBranch(ctl, arg as BranchArg, 'Terminal em qual worktree?', true);
  const cwd = p ?? (branch ? (await worktreeOf(repoOf(ctl), branch))?.path : undefined);
  if (!cwd) return;
  const t = vscode.window.createTerminal({ name: branch ?? path.basename(cwd), cwd });
  t.show();
}

export async function removeWorktree(ctl: Controller, arg: BranchArg, opts: { alsoBranch?: boolean } = {}) {
  const repo = repoOf(ctl);
  const branch = await pickBranch(ctl, arg, 'Remover qual worktree?', true);
  if (!branch) return;
  const wt = await worktreeOf(repo, branch);
  if (!wt) return;
  if (wt.isMain) {
    vscode.window.showErrorMessage('A worktree principal não pode ser removida.');
    return;
  }
  const open = (vscode.workspace.workspaceFolders ?? []).some(f => path.normalize(f.uri.fsPath).toLowerCase() === wt.path.toLowerCase());
  const st = await repo.status(wt.path);
  const detail = [
    wt.path,
    st.changes ? `⚠ ${st.changes} alteração(ões) não commitada(s) serão PERDIDAS.` : 'Sem alterações pendentes.',
    open ? '⚠ Esta janela está com essa worktree aberta.' : '',
  ]
    .filter(Boolean)
    .join('\n');
  const actions = opts.alsoBranch ? ['Remover worktree e branch'] : ['Remover worktree', 'Remover worktree e branch'];
  const pick = await vscode.window.showWarningMessage(`Remover a worktree de ${branch}?`, { modal: true, detail }, ...actions);
  if (!pick) return;
  const r = await repo.run(['worktree', 'remove', ...(st.changes ? ['--force'] : []), wt.path], repo.root, 120_000);
  if (r.code !== 0) {
    vscode.window.showErrorMessage(`Não consegui remover: ${r.stderr.trim()}`);
    return;
  }
  ctl.log(`Worktree removida: ${wt.path}`);
  if (pick === 'Remover worktree e branch') await deleteBranch(ctl, branch, { skipConfirm: true });
  ctl.scheduleRefresh(100);
}

export async function deleteBranch(ctl: Controller, arg: BranchArg, opts: { skipConfirm?: boolean } = {}) {
  const repo = repoOf(ctl);
  const branch = await pickBranch(ctl, arg, 'Excluir qual branch?');
  if (!branch) return;
  if (await worktreeOf(repo, branch)) {
    vscode.window.showErrorMessage(`${branch} está aberta numa worktree. Remova a worktree primeiro.`);
    return;
  }
  if (!opts.skipConfirm) {
    const ok = await vscode.window.showWarningMessage(`Excluir a branch ${branch}?`, { modal: true }, 'Excluir');
    if (!ok) return;
  }
  let r = await repo.run(['branch', '-d', branch]);
  if (r.code !== 0) {
    const force = await vscode.window.showWarningMessage(
      `${branch} tem commits que não estão em nenhuma branch mesclada.`,
      { modal: true, detail: r.stderr.trim() },
      'Excluir mesmo assim (-D)',
    );
    if (!force) return;
    r = await repo.run(['branch', '-D', branch]);
    if (r.code !== 0) {
      vscode.window.showErrorMessage(r.stderr.trim());
      return;
    }
  }
  ctl.log(`Branch excluída: ${branch}`);
  ctl.scheduleRefresh(100);
}

/** QuickPick com os arquivos alterados na branch desde que saiu da base; cada item abre um diff. */
export async function diffWithBase(ctl: Controller, arg: BranchArg) {
  const repo = repoOf(ctl);
  const branch = await pickBranch(ctl, arg, 'Revisar qual branch?');
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
    vscode.window.showInformationMessage(`${branch} não tem alterações em relação a ${baseRef}.`);
    return;
  }
  const label: Record<string, string> = { A: 'adicionado', M: 'modificado', D: 'removido', '?': 'não rastreado', T: 'tipo alterado' };
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { file: string; status: string }>();
  qp.title = `${branch} × ${baseRef} — ${files.length} arquivo(s)${wt ? ' (inclui o que não foi commitado)' : ''}`;
  qp.placeholder = 'Enter abre o diff; a lista continua aberta para o próximo arquivo';
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

export async function copyText(text: string) {
  await vscode.env.clipboard.writeText(text);
  vscode.window.setStatusBarMessage(`Copiado: ${text}`, 2500);
}
