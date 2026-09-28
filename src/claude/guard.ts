import * as path from 'path';
import { t } from '../i18n';

/**
 * Guarda da worktree: decide, no hook PreToolUse, se uma ferramenta do Claude pode rodar. Com vários
 * agentes em paralelo, o erro mais caro é um deles mexer na worktree de outro (ou na principal), trocar
 * de branch ou reescrever o remoto. Não depende do VS Code (testada em test/claudeGuard.test.js).
 */

export interface GuardInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

export interface GuardContext {
  /** Worktree onde o agente foi aberto. */
  worktree: string;
  /** As outras worktrees do repositório (inclusive a principal). */
  others: { path: string; name: string }[];
  /** Base do repositório e branches protegidas: o agente não troca para elas nem as apaga. */
  protectedBranches: string[];
  /** Também impede trocar a branch da worktree (checkout -b, switch para outra branch). */
  strict?: boolean;
}

const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

function inside(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + path.sep) || c.startsWith(p + '/');
}

/** Worktree (das outras) que contém o caminho; a de caminho mais longo vence (worktrees aninhadas). */
function ownerOf(file: string, ctx: GuardContext): { path: string; name: string } | undefined {
  // uma worktree aninhada na atual (ex.: .worktrees/ dentro do repositório) conta como outra
  const hits = ctx.others.filter(o => inside(file, o.path)).sort((a, b) => b.path.length - a.path.length);
  const best = hits[0];
  if (!best) return undefined;
  if (inside(file, ctx.worktree) && ctx.worktree.length > best.path.length) return undefined;
  return best;
}

/** Comandos que só leem: podem citar outra worktree (ex.: `git -C ../x log`, `cat ../x/a.ts`). */
const READ_ONLY = /^(ls|dir|cat|head|tail|less|more|grep|rg|find|wc|diff|stat|file|tree|pwd|echo|type|Get-Content|Get-ChildItem)$/i;
const GIT_READ_ONLY = /^(log|show|diff|status|blame|grep|ls-files|ls-tree|rev-parse|rev-list|branch|describe|cat-file|shortlog|merge-base|for-each-ref)$/;

/** Separa uma linha de shell em comandos (&&, ||, ;, |) e cada um em palavras, respeitando aspas. */
export function shellCommands(line: string): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let word = '';
  let quote: string | undefined;
  let has = false;
  const push = () => {
    if (has) cur.push(word);
    word = '';
    has = false;
  };
  const end = () => {
    push();
    if (cur.length) out.push(cur);
    cur = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = undefined;
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && /[\s"'\\$`;&|]/.test(line[i + 1] ?? '') && line[i + 1] !== '\n') {
      // escape do shell; antes de letra é separador de caminho do Windows (C:\repo\x) e fica
      word += line[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (c === '\n') end();
      else push();
    } else if (c === ';' || c === '|' || c === '&') {
      end();
      if ((c === '|' || c === '&') && line[i + 1] === c) i++;
    } else {
      word += c;
      has = true;
    }
  }
  end();
  return out;
}

/** Argumentos do git depois das opções globais (-C x, -c k=v, --git-dir=…). */
function gitArgs(words: string[]): { sub?: string; rest: string[]; dirs: string[] } {
  const dirs: string[] = [];
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) {
    const w = words[i];
    if (w === '-C' || w === '-c' || w === '--git-dir' || w === '--work-tree') {
      if (w === '-C' || w === '--work-tree') dirs.push(words[i + 1] ?? '');
      i += 2;
    } else {
      if (w.startsWith('--work-tree=')) dirs.push(w.slice(12));
      i++;
    }
  }
  return { sub: words[i], rest: words.slice(i + 1), dirs };
}

function checkGit(words: string[], ctx: GuardContext, cwd: string): string | undefined {
  const { sub, rest, dirs } = gitArgs(words);
  for (const d of dirs) {
    const o = d && ownerOf(path.resolve(cwd, d), ctx);
    if (o && !(sub && GIT_READ_ONLY.test(sub))) return t('it runs git in the worktree {0}, which belongs to another agent', o.name);
  }
  const isProtected = (b: string) => ctx.protectedBranches.includes(b.replace(/^refs\/heads\//, ''));
  switch (sub) {
    case 'push': {
      const force = rest.some(a => a === '-f' || a === '--force' || a === '--force-with-lease' || a.startsWith('--force-with-lease=') || a === '--mirror' || /^\+/.test(a));
      if (force) return t('force push rewrites history that other people and agents may already have');
      const target = rest.filter(a => !a.startsWith('-')).slice(1);
      const hit = target.map(a => a.split(':').pop() ?? a).find(isProtected);
      if (hit) return t('it pushes directly to {0}; publish the branch and open a PR instead', hit);
      return undefined;
    }
    case 'checkout':
    case 'switch': {
      // `git checkout -- arquivo` e `git checkout <commit> -- arquivo` só restauram arquivos
      if (rest.includes('--')) return undefined;
      const creating = rest.some(a => a === '-b' || a === '-B' || a === '-c' || a === '-C' || a === '--orphan');
      if (creating && ctx.strict) return t('this worktree is tied to its branch; create new branches with a new worktree');
      const target = rest.find(a => !a.startsWith('-'));
      if (target && isProtected(target)) return t('it switches this worktree to {0}; the base stays in the main worktree', target);
      if (target && sub === 'switch' && ctx.strict) return t('this worktree is tied to its branch; do not switch it to {0}', target);
      return undefined;
    }
    case 'worktree':
      if (rest[0] === 'remove' || rest[0] === 'prune' || rest[0] === 'move') return t('removing or moving worktrees is done by the user in AgentYard');
      return undefined;
    case 'branch': {
      const del = rest.some(a => a === '-d' || a === '-D' || a === '--delete' || a === '-m' || a === '-M' || a === '--move');
      const hit = rest.filter(a => !a.startsWith('-')).find(isProtected);
      if (del && hit) return t('it deletes or renames the protected branch {0}', hit);
      return undefined;
    }
    case 'update-ref':
      if (rest.some(isProtected)) return t('it moves the protected branch directly');
      return undefined;
  }
  return undefined;
}

/**
 * Motivo para negar a ferramenta, ou undefined para deixar seguir. Só nega o que tem certeza;
 * o resto fica com as permissões normais do Claude.
 */
export function guardToolUse(input: GuardInput, ctx: GuardContext): string | undefined {
  const tool = input.tool_name ?? '';
  const ti = input.tool_input ?? {};
  const cwd = input.cwd || ctx.worktree;
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) {
    const file = String(ti.file_path ?? ti.notebook_path ?? '');
    if (!file) return undefined;
    const o = ownerOf(path.resolve(cwd, file), ctx);
    return o ? t('{0} belongs to the worktree {1}, where another agent may be working. Edit only inside {2}.', file, o.name, ctx.worktree) : undefined;
  }
  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = String(ti.command ?? '');
    let dir = cwd;
    for (const words of shellCommands(cmd)) {
      const [bin, ...args] = words;
      if (!bin) continue;
      if (/^(cd|pushd|Set-Location)$/i.test(bin) && args[0]) {
        dir = path.resolve(dir, args[0]);
        continue;
      }
      if (/^git(\.exe)?$/i.test(path.basename(bin))) {
        const why = checkGit(words, ctx, dir);
        if (why) return t('Blocked by AgentYard: {0}.', why);
        if (!GIT_READ_ONLY.test(gitArgs(words).sub ?? '')) {
          const o = ownerOf(dir, ctx);
          if (o) return t('Blocked by AgentYard: the command runs git inside the worktree {0}, which belongs to another agent. Work only in {1}.', o.name, ctx.worktree);
        }
        continue;
      }
      if (READ_ONLY.test(bin)) continue;
      // escrever em outra worktree pela linha de comando (cp, mv, rm, sed -i, npm…) também não
      const o = ownerOf(dir, ctx) ?? args.map(a => (/[\\/]/.test(a) && !a.startsWith('-') ? ownerOf(path.resolve(dir, a), ctx) : undefined)).find(Boolean);
      if (o) return t('Blocked by AgentYard: the command touches the worktree {0}, which belongs to another agent. Work only in {1}.', o.name, ctx.worktree);
    }
  }
  return undefined;
}

/** Linha curta que descreve o pedido de permissão (notificação e barra de status). */
export function describeToolRequest(tool: string | undefined, input: Record<string, unknown> | undefined): string {
  const ti = input ?? {};
  const one = (s: unknown, max = 160) => {
    const x = String(s ?? '').replace(/\s+/g, ' ').trim();
    return x.length > max ? `${x.slice(0, max - 1)}…` : x;
  };
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return `${tool}: ${one(ti.command)}`;
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      return `${tool}: ${one(path.basename(String(ti.file_path ?? ti.notebook_path ?? '')))}`;
    case 'WebFetch':
      return `WebFetch: ${one(ti.url)}`;
    case 'WebSearch':
      return `WebSearch: ${one(ti.query)}`;
    case 'ExitPlanMode':
      return t('approve the plan');
  }
  if (tool?.startsWith('mcp__')) return tool.split('__').slice(1).join(' · ');
  return tool ?? '?';
}
