import * as vscode from 'vscode';
import { createWorktree } from './actions';
import { AgentTerminals, agents, fillTemplate } from './agents';
import { Controller } from './controller';
import { t } from './i18n';

/** Tarefa padrão para resolver conflitos (placeholders ${branch}, ${base} e ${files}). */
export function defaultResolvePrompt(): string {
  return t(
    'On branch {0}, bring in {1} (git merge {1}) and resolve the conflicts in: {2}. Preserve the intent of both changes, run the project tests and commit the merge. If anything is ambiguous, ask before deciding.',
    '${branch}',
    '${base}',
    '${files}',
  );
}

export function defaultIntoBasePrompt(): string {
  return t(
    'Branch {0} conflicts with {1} and cannot be merged into it yet. In this worktree, bring in {1} (git merge {1}) and resolve the conflicts in: {2}, preserving the intent of both changes. Run the project tests and commit the merge, so that merging {0} into {1} is clean. Do not merge into {1} without asking me. If anything is ambiguous, ask before deciding.',
    '${branch}',
    '${base}',
    '${files}',
  );
}

export interface ResolveOptions {
  /** O que deve ser trazido para `branch`. Padrão: a base do repositório. */
  base?: string;
  /** O conflito apareceu ao mesclar `branch` na base (usa o template mergeIntoBase). */
  intoBase?: boolean;
}

/** Nome do agente que os botões "Resolver com …" usam: o primeiro configurado. */
export function resolverName(ctl: Controller): string {
  return agents(ctl)[0]?.name ?? 'Claude Code';
}

/**
 * Manda o agente trazer `base` para `branch` e resolver os conflitos, na worktree da branch
 * (criada antes, se ela ainda não tiver uma).
 */
export async function resolveConflict(ctl: Controller, terms: AgentTerminals, branch: string, opts: ResolveOptions = {}) {
  const repo = ctl.repo;
  if (!repo) return;
  const { base: repoBase, baseRef } = await ctl.base();
  const base = opts.base ?? baseRef;

  let wt = (await repo.worktreesFast()).find(w => w.branch === branch && !w.prunable);
  if (!wt) {
    await createWorktree(ctl, { existing: branch, quiet: true });
    wt = (await repo.worktreesFast()).find(w => w.branch === branch && !w.prunable);
    if (!wt) return;
  }

  // Merge já em andamento na worktree: os arquivos vêm do índice; senão, da simulação.
  const st = await repo.status(wt.path);
  let files = st.operation === 'merge' ? await repo.conflictedFiles(wt.path) : [];
  if (!files.length) files = (await repo.mergePreview(branch, base))?.files ?? [];

  const cfg = ctl.cfg();
  const template = opts.intoBase
    ? cfg.get<string>('prompts.mergeIntoBase', '') || defaultIntoBasePrompt()
    : cfg.get<string>('prompts.resolveConflict', '') || defaultResolvePrompt();
  const prompt = fillTemplate(template, {
    branch,
    base: opts.intoBase ? repoBase : base,
    files: files.length ? files.join(', ') : t('(the simulation listed no files; run the merge to see them)'),
  });
  await terms.launchWithPrompt(wt.path, branch, prompt, resolverName(ctl));
}

/** Botão de notificação: devolve o rótulo e a ação para "Resolver com <agente>". */
export function resolveButton(ctl: Controller): string {
  return t('Resolve with {0}', resolverName(ctl));
}

export function runResolve(branch: string, opts: ResolveOptions = {}) {
  return vscode.commands.executeCommand('worktreeGraph.resolveConflict', branch, opts);
}
