import * as vscode from 'vscode';
import { createWorktree } from './actions';
import { AgentTerminals, agents, fillTemplate } from './agents';
import { Controller } from './controller';

export const DEFAULT_RESOLVE_PROMPT =
  'Na branch ${branch}, traga a ${base} (git merge ${base}) e resolva os conflitos em: ${files}. ' +
  'Preserve a intenção das duas mudanças, rode os testes do projeto e faça o commit do merge. ' +
  'Se algo for ambíguo, pergunte antes de decidir.';

export const DEFAULT_INTO_BASE_PROMPT =
  'A branch ${branch} conflita com ${base} e não pode ser mesclada nela ainda. Nesta worktree, traga a ${base} ' +
  '(git merge ${base}) e resolva os conflitos em: ${files}, preservando a intenção das duas mudanças. Rode os testes ' +
  'do projeto e faça o commit do merge, para que o merge de ${branch} em ${base} fique limpo. Não faça o merge em ' +
  '${base} sem me perguntar. Se algo for ambíguo, pergunte antes de decidir.';

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
    ? cfg.get<string>('prompts.mergeIntoBase', '') || DEFAULT_INTO_BASE_PROMPT
    : cfg.get<string>('prompts.resolveConflict', '') || DEFAULT_RESOLVE_PROMPT;
  const prompt = fillTemplate(template, {
    branch,
    base: opts.intoBase ? repoBase : base,
    files: files.length ? files.join(', ') : '(a simulação não listou arquivos; rode o merge para ver)',
  });
  await terms.launchWithPrompt(wt.path, branch, prompt, resolverName(ctl));
}

/** Botão de notificação: devolve o rótulo e a ação para "Resolver com <agente>". */
export function resolveButton(ctl: Controller): string {
  return `Resolver com ${resolverName(ctl)}`;
}

export function runResolve(branch: string, opts: ResolveOptions = {}) {
  return vscode.commands.executeCommand('worktreeGraph.resolveConflict', branch, opts);
}
