/**
 * Partes puras das operações do dia a dia (rebase, stash, comparação), testáveis sem o VS Code
 * (test/gitOps.test.js).
 */

export type RebaseAction = 'pick' | 'squash' | 'fixup' | 'drop' | 'reword';

export interface PlanStep {
  sha: string;
  subject: string;
  action: RebaseAction;
  /** Nova mensagem, quando action = 'reword'. */
  message?: string;
}

/** Erro de plano legível, ou undefined se o plano pode ser executado. */
export function validatePlan(plan: PlanStep[]): string | undefined {
  const kept = plan.filter(s => s.action !== 'drop');
  if (!kept.length) return 'O plano descarta todos os commits; use "Remover worktree" ou reset se for isso.';
  if (kept[0].action === 'squash' || kept[0].action === 'fixup') return `"${kept[0].subject}" não tem um commit anterior para juntar.`;
  const empty = plan.find(s => s.action === 'reword' && !s.message?.trim());
  if (empty) return `Informe a nova mensagem de "${empty.subject}".`;
  return undefined;
}

/**
 * Roteiro do `git rebase -i`, na ordem de aplicação (mais antigo primeiro). Reword vira
 * `pick` + `exec git commit --amend -F <arquivo>`, para não depender de editor interativo.
 * `messageFile(i)` devolve o caminho (com "/") onde a mensagem do passo i foi gravada.
 */
export function buildTodo(plan: PlanStep[], messageFile: (i: number) => string): string {
  const lines: string[] = [];
  plan.forEach((s, i) => {
    const subject = s.subject.replace(/\r?\n/g, ' ');
    if (s.action === 'reword') {
      lines.push(`pick ${s.sha} ${subject}`);
      lines.push(`exec git commit --amend --no-verify -F "${messageFile(i)}"`);
    } else {
      lines.push(`${s.action} ${s.sha} ${subject}`);
    }
  });
  return lines.join('\n') + '\n';
}

/** Move o passo i uma posição (delta -1 = para cima/mais antigo, +1 = para baixo/mais novo). */
export function movePlan(plan: PlanStep[], i: number, delta: -1 | 1): PlanStep[] {
  const j = i + delta;
  if (j < 0 || j >= plan.length) return plan;
  const out = plan.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

export interface StashEntry {
  /** "stash@{0}" */
  ref: string;
  sha: string;
  /** Mensagem do reflog: "WIP on ai/x: abc123 assunto" ou "On ai/x: minha mensagem". */
  message: string;
  /** Branch de onde veio, lida da mensagem. */
  branch?: string;
  date: number;
}

/** Saída de `git stash list --format=%gd%x1f%H%x1f%gs%x1f%ct`. */
export function parseStashList(out: string): StashEntry[] {
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map(l => {
      const [ref, sha, message, ct] = l.split('\x1f');
      const m = /^(?:WIP on|On) ([^:]+):/.exec(message ?? '');
      return { ref, sha, message: message ?? '', branch: m?.[1], date: Number(ct) || 0 };
    });
}

/** Texto curto da mensagem do stash, sem o prefixo "WIP on x:"/"On x:". */
export function stashTitle(e: StashEntry): string {
  return e.message.replace(/^(?:WIP on|On) [^:]+:\s*/, '') || e.ref;
}

/** `git diff --name-status` → mapa caminho → letra (A/M/D/T). */
export function parseNameStatus(out: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of out.split(/\r?\n/)) {
    if (!l) continue;
    const [st, ...rest] = l.split('\t');
    m.set(rest.join('\t'), st[0]);
  }
  return m;
}

/** `git status --porcelain=v1 -z` → caminhos alterados (inclui não rastreados). */
export function parseStatusPaths(out: string): string[] {
  return out
    .split('\0')
    .filter(Boolean)
    .map(e => e.slice(3))
    .filter(p => p && !p.endsWith('/'));
}

// ---------------------------------------------------------------- alterações não commitadas

export type UncommittedKind = 'untracked' | 'conflict' | 'staged' | 'unstaged' | 'mixed';

export interface Uncommitted {
  path: string;
  /** Letra que resume a alteração: M, A, D, T ou ? (não rastreado). */
  letter: string;
  kind: UncommittedKind;
  added?: number;
  deleted?: number;
  binary?: boolean;
}

const CONFLICT = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** `git status --porcelain=v1 -z --no-renames --untracked-files=all` → uma entrada por arquivo. */
export function parseUncommitted(out: string): Uncommitted[] {
  const list: Uncommitted[] = [];
  for (const e of out.split('\0')) {
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    const p = e.slice(3);
    if (!p || p.endsWith('/')) continue;
    const [x, y] = xy;
    let kind: UncommittedKind;
    if (xy === '??') kind = 'untracked';
    else if (CONFLICT.has(xy)) kind = 'conflict';
    else if (x !== ' ' && y !== ' ') kind = 'mixed';
    else if (x !== ' ') kind = 'staged';
    else kind = 'unstaged';
    const letter = kind === 'untracked' ? '?' : kind === 'conflict' ? '!' : x === 'A' ? 'A' : x === 'D' || y === 'D' ? 'D' : x !== ' ' ? x : y;
    list.push({ path: p, letter, kind });
  }
  return list.sort((a, b) => a.path.localeCompare(b.path));
}

/** `git diff HEAD --numstat -z --no-renames` → caminho → linhas (+/−); binário vem como "-". */
export function parseNumstat(out: string): Map<string, { added: number; deleted: number; binary: boolean }> {
  const m = new Map<string, { added: number; deleted: number; binary: boolean }>();
  for (const e of out.split('\0')) {
    const [a, d, ...rest] = e.split('\t');
    const p = rest.join('\t').replace(/^\n+/, '');
    if (!p) continue;
    const binary = a === '-' || d === '-';
    m.set(p, { added: binary ? 0 : Number(a) || 0, deleted: binary ? 0 : Number(d) || 0, binary });
  }
  return m;
}

export const KIND_LABEL: Record<UncommittedKind, string> = {
  untracked: 'novo, não rastreado',
  conflict: 'em conflito',
  staged: 'no stage',
  unstaged: '',
  mixed: 'parte no stage',
};

/** O que o descarte faz com o arquivo, em linguagem clara: "volta ao último commit (+3 −1)". */
export function discardEffect(u: Uncommitted): string {
  const lines = (n?: number) => (u.binary ? 'binário' : `${n ?? 0} linha(s)`);
  if (u.letter === '?') return `apagado (arquivo novo, ${lines(u.added)})`;
  if (u.letter === 'A') return `apagado (adicionado no stage, ${lines(u.added)})`;
  if (u.letter === 'D') return 'volta a existir (tinha sido removido)';
  return `volta ao último commit (${u.binary ? 'binário' : `+${u.added ?? 0} −${u.deleted ?? 0}`})`;
}

/** Lista para a confirmação do descarte, cortada em `max` linhas. */
export function discardSummary(items: Uncommitted[], max = 15): string {
  const shown = items.slice(0, max).map(u => `${u.letter}  ${u.path} — ${discardEffect(u)}`);
  if (items.length > max) shown.push(`… e mais ${items.length - max} arquivo(s)`);
  return shown.join('\n');
}
