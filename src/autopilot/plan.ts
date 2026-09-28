/**
 * Orquestrador: uma tarefa grande dividida em subtarefas com dependências, cada uma numa worktree
 * com o seu agente. Sem VS Code (testado em test/autopilot.test.js).
 *
 * As independentes começam juntas a partir da base; uma subtarefa com dependências começa quando
 * todas ficam prontas, empilhada sobre a primeira (as outras são mescladas nela). No fim, as branches
 * entram na fila de merge na ordem das dependências.
 */

export type SubtaskStatus = 'waiting' | 'running' | 'ready' | 'failed' | 'skipped';

export interface Subtask {
  id: string;
  title: string;
  branch: string;
  task: string;
  dependsOn: string[];
  /** Arquivos/pastas que ela deve mexer (reservados para ela no mural). */
  files: string[];
  status: SubtaskStatus;
  path?: string;
  started?: number;
  finished?: number;
}

export interface Orchestration {
  id: string;
  title: string;
  task: string;
  base: string;
  created: number;
  subtasks: Subtask[];
  /** Todas prontas e na fila de merge. */
  queued?: boolean;
}

const MAX_SUBTASKS = 8;

export function planPrompt(task: string, base: string, prefix: string): string {
  return [
    'You are planning how to split a software task among several coding agents that will work IN PARALLEL, each in its own git worktree and branch created from ' + base + '.',
    'Read the code you need to understand the task (you may use your read-only tools), then split it into 2 to 6 subtasks.',
    'Rules:',
    '- Each subtask must be self-contained: an agent that only reads its description can do it, test it and commit it.',
    '- Maximize parallelism: prefer subtasks that touch different files. Use dependsOn ONLY when a subtask really needs the code of another one to start (e.g. it calls an API the other creates).',
    '- Never create a dependency cycle. Do not create a subtask just for "integration" unless it is really needed.',
    '- If the task is too small to split, return a single subtask.',
    `- Branch names: ${prefix}<short-kebab-name>, unique.`,
    '- files: the files or folders (globs allowed, relative to the repository root) the subtask is expected to change; they will be reserved for it.',
    '',
    'The task:',
    task,
    '',
    'Answer with ONLY a JSON object, no code fences, no explanations, in this shape:',
    '{"title": "<short title of the whole task>", "subtasks": [{"id": "<short-id>", "title": "<one line>", "branch": "<branch>", "task": "<complete instructions for the agent: what to do, where, how to test, what not to touch>", "dependsOn": ["<id>"], "files": ["src/x/**"]}]}',
  ].join('\n');
}

/** Tira o JSON da resposta (pode vir com cerca ou texto em volta). */
export function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const body = fence ? fence[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in the answer');
  return JSON.parse(body.slice(start, end + 1));
}

const BRANCH_BAD = /[\s~^:?*[\\]|\.\.|@\{|\/$|^\/|\.lock$/;

export function slug(s: string): string {
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .slice(0, 6)
      .join('-') || 'parte'
  );
}

/**
 * Valida e normaliza o plano: ids únicos, dependências conhecidas e sem ciclo, branches válidas e
 * sem repetir as que já existem (`taken`).
 */
export function normalizePlan(raw: unknown, prefix: string, taken: Set<string>): { title: string; subtasks: Subtask[] } {
  const o = raw as { title?: unknown; subtasks?: unknown };
  const list = Array.isArray(o?.subtasks) ? o.subtasks : [];
  if (!list.length) throw new Error('the plan has no subtasks');
  if (list.length > MAX_SUBTASKS) throw new Error(`the plan has ${list.length} subtasks (at most ${MAX_SUBTASKS})`);
  const ids = new Set<string>();
  const branches = new Set<string>();
  const out: Subtask[] = [];
  for (const [i, x] of list.entries()) {
    const s = (x ?? {}) as Record<string, unknown>;
    const title = String(s.title ?? '').trim() || `Part ${i + 1}`;
    let id = slug(String(s.id ?? '') || title);
    while (ids.has(id)) id = `${id}-${i + 1}`;
    ids.add(id);
    const task = String(s.task ?? '').trim();
    if (!task) throw new Error(`subtask "${title}" has no instructions`);
    let branch = String(s.branch ?? '').trim();
    if (!branch || BRANCH_BAD.test(branch)) branch = `${prefix}${slug(title)}`;
    if (!branch.startsWith(prefix)) branch = `${prefix}${branch.replace(/^.*\//, '')}`;
    const stem = branch;
    for (let n = 2; branches.has(branch) || taken.has(branch); n++) branch = `${stem}-${n}`;
    branches.add(branch);
    const files = Array.isArray(s.files) ? s.files.map(f => String(f).trim()).filter(Boolean).slice(0, 30) : [];
    const dependsOn = Array.isArray(s.dependsOn) ? s.dependsOn.map(d => slug(String(d))) : [];
    out.push({ id, title, branch, task, dependsOn, files, status: 'waiting' });
  }
  // dependências por id original ou normalizado; desconhecidas saem
  const rawIds = list.map((x, i) => [slug(String((x as Record<string, unknown>)?.id ?? '')), out[i].id] as const);
  const map = new Map(rawIds.filter(([a]) => a));
  for (const s of out) s.dependsOn = [...new Set(s.dependsOn.map(d => map.get(d) ?? d).filter(d => ids.has(d) && d !== s.id))];
  if (hasCycle(out)) throw new Error('the plan has a dependency cycle');
  return { title: String(o.title ?? '').trim(), subtasks: out };
}

export function hasCycle(subs: Pick<Subtask, 'id' | 'dependsOn'>[]): boolean {
  const byId = new Map(subs.map(s => [s.id, s]));
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 2) return false;
    if (state.get(id) === 1) return true;
    state.set(id, 1);
    for (const d of byId.get(id)?.dependsOn ?? []) if (visit(d)) return true;
    state.set(id, 2);
    return false;
  };
  return subs.some(s => visit(s.id));
}

/** Ordem das dependências (as de que outras dependem primeiro). */
export function topoOrder(subs: Subtask[]): Subtask[] {
  const byId = new Map(subs.map(s => [s.id, s]));
  const done = new Set<string>();
  const out: Subtask[] = [];
  const visit = (s: Subtask) => {
    if (done.has(s.id)) return;
    done.add(s.id);
    for (const d of s.dependsOn) {
      const x = byId.get(d);
      if (x) visit(x);
    }
    out.push(s);
  };
  subs.forEach(visit);
  return out;
}

/** Subtarefas que podem começar agora: esperando e com todas as dependências prontas. */
export function startable(o: Orchestration, maxParallel: number): Subtask[] {
  const byId = new Map(o.subtasks.map(s => [s.id, s]));
  const running = o.subtasks.filter(s => s.status === 'running').length;
  const free = Math.max(0, maxParallel - running);
  return o.subtasks.filter(s => s.status === 'waiting' && s.dependsOn.every(d => byId.get(d)?.status === 'ready')).slice(0, free);
}

/** Dependência falhou: as que dependem dela (direta ou indiretamente) não vão rodar. */
export function blockedBy(o: Orchestration): Subtask[] {
  const bad = new Set(o.subtasks.filter(s => s.status === 'failed' || s.status === 'skipped').map(s => s.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of o.subtasks) {
      if (!bad.has(s.id) && s.dependsOn.some(d => bad.has(d))) {
        bad.add(s.id);
        grew = true;
      }
    }
  }
  return o.subtasks.filter(s => s.status === 'waiting' && bad.has(s.id));
}

export function finished(o: Orchestration): boolean {
  return o.subtasks.every(s => s.status === 'ready' || s.status === 'failed' || s.status === 'skipped');
}

/** De onde a worktree da subtarefa sai e o que precisa ser mesclado nela antes do agente começar. */
export function startPoint(o: Orchestration, s: Subtask): { from: string; merge: string[] } {
  const deps = s.dependsOn.map(d => o.subtasks.find(x => x.id === d)).filter((x): x is Subtask => !!x);
  if (!deps.length) return { from: o.base, merge: [] };
  return { from: deps[0].branch, merge: deps.slice(1).map(d => d.branch) };
}

/** O que o agente de uma subtarefa recebe. */
export function subtaskPrompt(o: Orchestration, s: Subtask): string {
  const others = o.subtasks.filter(x => x.id !== s.id);
  const deps = s.dependsOn.map(d => o.subtasks.find(x => x.id === d)).filter((x): x is Subtask => !!x);
  return [
    `You are one of ${o.subtasks.length} agents working in parallel on: ${o.title || o.task.split(/\r?\n/)[0]}`,
    '',
    `YOUR PART (${s.id}): ${s.title}`,
    s.task,
    s.files.length ? `\nFiles reserved for you: ${s.files.join(', ')}. Avoid changing files outside your part; if you must, check list_claims first.` : '',
    deps.length ? `\nThis branch already contains the work of: ${deps.map(d => `${d.branch} (${d.title})`).join(', ')}.` : '',
    others.length ? `\nThe other parts (other agents are doing them, do not do them yourself):\n${others.map(x => `- ${x.id}: ${x.title} (${x.branch})`).join('\n')}` : '',
    '\nIf you change something the others depend on (an interface, a schema, a shared file), tell them with the agentyard post_note tool. When your part is done, tested and committed, call mark_ready.',
    `\nThe whole task, for context:\n${o.task}`,
  ]
    .filter(Boolean)
    .join('\n');
}
