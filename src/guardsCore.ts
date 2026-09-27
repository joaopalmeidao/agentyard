/**
 * Regras das proteções (checagens, branches protegidas, lembrete de limpeza), sem depender do
 * VS Code, para testar direto (test/guards.test.js).
 */
import { branchMatches } from './git';

export type CheckKind = 'merge' | 'push';
export type ChecksMode = 'block' | 'warn' | 'off';
export type ProtectionMode = 'require-pr' | 'confirm' | 'off';
export type ProtectedAction = 'merge' | 'push' | 'force';
export type Decision = 'allow' | 'confirm' | 'require-pr' | 'block';

/** Chave do cache de checagem: só vale para a mesma worktree, no mesmo commit, com os mesmos comandos. */
export function checkCacheKey(worktreePath: string, head: string, commands: string[]): string {
  return `${worktreePath.toLowerCase()}|${head}|${commands.join('\u0000')}`;
}

/**
 * Cache só de resultados que passaram com a worktree limpa: com alterações pendentes os arquivos
 * mudam sem o HEAD mudar, e uma falha pode ter sido do ambiente.
 */
export class CheckCache {
  private readonly passed = new Map<string, number>();

  constructor(private readonly max = 500) {}

  has(key: string): boolean {
    return this.passed.has(key);
  }

  record(key: string, ok: boolean, clean: boolean) {
    if (!ok || !clean) {
      this.passed.delete(key);
      return;
    }
    this.passed.set(key, Date.now());
    if (this.passed.size > this.max) this.passed.delete(this.passed.keys().next().value!);
  }
}

/** Comandos a rodar: os configurados para o tipo; vazio cai no testCommand se permitido. */
export function checkCommands(configured: string[], testCommand: string, useTestCommand: boolean): string[] {
  const list = configured.map(c => c.trim()).filter(Boolean);
  if (list.length) return list;
  return useTestCommand && testCommand.trim() ? [testCommand.trim()] : [];
}

/**
 * Checagem de merge: roda na origem, exceto quando a origem é a base (ou uma ref remota) descendo
 * para uma branch de trabalho — aí não há o que validar no trabalho de ninguém.
 */
export function shouldCheckMerge(source: string, base: string, baseRef: string): boolean {
  if (source === base || source === baseRef) return false;
  if (/^(origin|upstream)\//.test(source)) return false;
  return true;
}

/** Lista efetiva: a configurada, ou (vazia) a base + estágios do fluxo + main/master. */
export function protectedList(configured: string[], base: string, flow: string[]): string[] {
  const list = configured.map(b => b.trim()).filter(Boolean);
  if (list.length) return [...new Set(list)];
  return [...new Set([base, ...flow, 'main', 'master'].filter(Boolean))];
}

export function isProtected(branch: string, list: string[]): boolean {
  const name = branch.replace(/^refs\/heads\//, '');
  return list.includes(name) || branchMatches(name, list.filter(p => p.includes('*')));
}

/** O que fazer com uma ação direta numa branch. Force-with-lease em protegida só passa com "off". */
export function protectionDecision(mode: ProtectionMode, action: ProtectedAction, branch: string, list: string[]): Decision {
  if (mode === 'off' || !isProtected(branch, list)) return 'allow';
  if (action === 'force') return 'block';
  return mode === 'require-pr' ? 'require-pr' : 'confirm';
}

export interface CleanupWorktree {
  path: string;
  isMain: boolean;
  isBase: boolean;
  prunable: boolean;
  bare?: boolean;
  compareKnown: boolean;
  statusKnown: boolean;
  ahead: number;
  changes: number;
  date: number;
  agents: string[];
  favorite: boolean;
  isCurrent?: boolean;
}

/** Mescladas, limpas, sem agente, não favoritas e paradas há mais de `staleDays`; e as órfãs à parte. */
export function cleanupCandidates(wts: CleanupWorktree[], staleDays: number, nowSec = Date.now() / 1000) {
  const limit = nowSec - staleDays * 86400;
  const stale = wts.filter(
    w =>
      !w.isMain &&
      !w.isBase &&
      !w.prunable &&
      !w.bare &&
      !w.isCurrent &&
      !w.favorite &&
      w.agents.length === 0 &&
      w.compareKnown &&
      w.ahead === 0 &&
      w.statusKnown &&
      w.changes === 0 &&
      w.date > 0 &&
      w.date < limit,
  );
  const orphans = wts.filter(w => w.prunable);
  return { stale, orphans };
}

export interface RemindState {
  /** ms: não lembrar antes disso ("Lembrar depois"). */
  snoozeUntil?: number;
  /** "Não lembrar neste projeto". */
  disabled?: boolean;
  /** ms: último aviso mostrado. */
  lastShown?: number;
}

/** Avisa se passou do limite, não está adiado nem desligado, e o último aviso tem mais de 24 h. */
export function shouldRemind(total: number, threshold: number, st: RemindState, now = Date.now()): boolean {
  if (st.disabled) return false;
  if (total < Math.max(1, threshold)) return false;
  if (st.snoozeUntil && now < st.snoozeUntil) return false;
  if (st.lastShown && now - st.lastShown < 24 * 3600_000) return false;
  return true;
}

/** Últimas `n` linhas de uma saída, sem cores ANSI. */
export function tailLines(text: string, n = 150): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const lines = clean.split(/\r?\n/);
  return lines.slice(-n).join('\n');
}
