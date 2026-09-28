import { runGit } from '../git';

/**
 * Branches empilhadas: uma branch que sai de outra (não da base). O pai e o commit do pai de onde
 * ela saiu (ou do último restack) ficam no config local do git (`branch.<b>.agentyardParent` e
 * `agentyardParentTip`), então valem para todas as worktrees e sobrevivem a recarregar.
 * Sem VS Code (testado em test/stack.test.js).
 */

export interface StackLink {
  parent: string;
  /** Commit do pai quando a branch saiu dele (ou no último restack). */
  tip?: string;
}

async function git(cwd: string, args: string[]) {
  const r = await runGit(cwd, args, 300_000);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

export async function revParse(cwd: string, ref: string): Promise<string | undefined> {
  const r = await runGit(cwd, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** Todas as ligações pai → filho do repositório. */
export async function readStack(cwd: string): Promise<Map<string, StackLink>> {
  const r = await runGit(cwd, ['config', '--local', '--get-regexp', '^branch\\..*\\.agentyardparent(tip)?$']);
  const out = new Map<string, StackLink>();
  for (const line of r.stdout.split(/\r?\n/).filter(Boolean)) {
    const sp = line.indexOf(' ');
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1).trim();
    const branch = key.slice('branch.'.length, key.lastIndexOf('.'));
    const name = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
    const cur = out.get(branch) ?? { parent: '' };
    if (name === 'agentyardparent') cur.parent = value;
    else cur.tip = value;
    out.set(branch, cur);
  }
  for (const [b, l] of out) if (!l.parent) out.delete(b);
  return out;
}

export async function setParent(cwd: string, branch: string, parent: string, tip?: string) {
  await git(cwd, ['config', '--local', `branch.${branch}.agentyardParent`, parent]);
  const t = tip ?? (await revParse(cwd, parent));
  if (t) await git(cwd, ['config', '--local', `branch.${branch}.agentyardParentTip`, t]);
}

export async function clearParent(cwd: string, branch: string) {
  for (const k of ['agentyardParent', 'agentyardParentTip']) await runGit(cwd, ['config', '--local', '--unset', `branch.${branch}.${k}`]);
}

/** Descendentes de `root` na ordem em que precisam ser atualizados (pai antes do filho). */
export function descendants(links: Map<string, StackLink>, root: string): string[] {
  const out: string[] = [];
  const walk = (b: string, seen: Set<string>) => {
    for (const [child, l] of links) {
      if (l.parent !== b || seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      walk(child, seen);
    }
  };
  walk(root, new Set([root]));
  return out;
}

/** Pilha inteira de uma branch: da mais de baixo (filha da base) até ela, e depois os descendentes. */
export function stackOf(links: Map<string, StackLink>, branch: string): string[] {
  const up: string[] = [];
  let b: string | undefined = branch;
  const seen = new Set<string>();
  while (b && !seen.has(b)) {
    seen.add(b);
    up.unshift(b);
    b = links.get(b)?.parent;
    if (b && !links.has(b)) {
      up.unshift(b);
      break;
    }
  }
  return [...up, ...descendants(links, branch)];
}

export type StackState = 'ok' | 'behind' | 'parent-merged' | 'parent-gone';

/** Situação de uma branch empilhada: em dia, pai andou (restack), pai já entrou na base, pai sumiu. */
export async function stackState(cwd: string, branch: string, link: StackLink, base: string): Promise<StackState> {
  const parentSha = await revParse(cwd, link.parent);
  if (!parentSha) return 'parent-gone';
  if (link.parent !== base && (await runGit(cwd, ['merge-base', '--is-ancestor', parentSha, base])).code === 0) {
    // pai inteiro já está na base (merge normal); squash não aparece aqui, mas o "pai sumiu" pega depois
    return 'parent-merged';
  }
  if (link.tip && link.tip !== parentSha) return 'behind';
  if (!link.tip) {
    const r = await runGit(cwd, ['merge-base', '--is-ancestor', parentSha, branch]);
    return r.code === 0 ? 'ok' : 'behind';
  }
  return 'ok';
}

export interface RestackResult {
  ok: boolean;
  /** Parou em conflito (o rebase foi desfeito). */
  conflict?: boolean;
  message?: string;
  /** Novo pai (quando o antigo já tinha entrado na base). */
  parent: string;
}

/**
 * Traz para cima do pai só os commits da branch (rebase --onto pai tipAntigo), na worktree dela.
 * Com o pai já mesclado (ou apagado), a branch passa a sair da base. Conflito: desfaz e avisa.
 */
export async function restack(wtPath: string, branch: string, link: StackLink, base: string): Promise<RestackResult> {
  const state = await stackState(wtPath, branch, link, base);
  const newParent = state === 'parent-merged' || state === 'parent-gone' ? base : link.parent;
  const onto = await revParse(wtPath, newParent);
  if (!onto) return { ok: false, parent: link.parent, message: `${newParent} not found` };
  const st = await git(wtPath, ['status', '--porcelain', '--untracked-files=no']);
  if (st.trim()) return { ok: false, parent: link.parent, message: 'uncommitted changes' };
  const upstream = link.tip && (await revParse(wtPath, link.tip)) ? link.tip : newParent;
  const r = await runGit(wtPath, ['-c', 'core.editor=true', 'rebase', '--onto', onto, upstream, branch], 300_000);
  if (r.code !== 0) {
    await runGit(wtPath, ['rebase', '--abort']);
    return { ok: false, conflict: true, parent: link.parent, message: (r.stderr || r.stdout).trim().split('\n').slice(-3).join('\n') };
  }
  if (newParent === base && newParent !== link.parent) await clearParent(wtPath, branch);
  else await setParent(wtPath, branch, newParent, onto);
  return { ok: true, parent: newParent };
}
