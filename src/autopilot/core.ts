/**
 * Piloto automático dos agentes: o que não depende do VS Code (testado em test/autopilot.test.js).
 * Portão no Stop, revisor automático, agente travado, mural e reservas de arquivos, fila que respeita
 * o limite de uso, juiz das tentativas, orquestrador e lições.
 */
import { exec } from 'child_process';

// ---------------------------------------------------------------- comandos

export interface CommandsResult {
  ok: boolean;
  /** Comando que falhou. */
  failed?: string;
  output: string;
  cancelled?: boolean;
}

/** Roda os comandos em sequência na pasta; para no primeiro que falhar. */
export async function runCommands(commands: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandsResult> {
  let output = '';
  for (const cmd of commands) {
    if (signal?.aborted) return { ok: false, cancelled: true, output };
    const r = await new Promise<{ code: number; text: string }>(resolve => {
      const child = exec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
        resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code?: unknown }).code as number) : 1) : 0, text: `${stdout}${stderr}` }),
      );
      signal?.addEventListener('abort', () => child.kill());
    });
    output += `$ ${cmd}\n${r.text}${r.text.endsWith('\n') || !r.text ? '' : '\n'}`;
    if (signal?.aborted) return { ok: false, cancelled: true, output };
    if (r.code !== 0) return { ok: false, failed: cmd, output };
  }
  return { ok: true, output };
}

/** Últimas `n` linhas de um texto. */
export function tail(text: string, n: number): string {
  const lines = text.replace(/\s+$/, '').split(/\r?\n/);
  return lines.length > n ? `…\n${lines.slice(-n).join('\n')}` : lines.join('\n');
}

// ---------------------------------------------------------------- portão no Stop

export type StopGateMode = 'off' | 'changes' | 'always';

/** Comandos do portão: os próprios; vazio cai nas checagens antes do merge e depois no testCommand. */
export function gateCommands(own: string[], beforeMerge: string[], testCommand: string): string[] {
  for (const list of [own, beforeMerge, [testCommand]]) {
    const clean = list.map(c => (c ?? '').trim()).filter(Boolean);
    if (clean.length) return clean;
  }
  return [];
}

export type GateVerdict = { action: 'skip'; why: string } | { action: 'run' };

/** Roda o portão neste Stop? */
export function gateVerdict(o: { mode: StopGateMode; commands: string[]; changed: boolean; project?: boolean; headless?: boolean }): GateVerdict {
  if (o.mode === 'off') return { action: 'skip', why: 'off' };
  if (!o.commands.length) return { action: 'skip', why: 'no-commands' };
  // projeto longo tem o portão dele; `claude -p` da extensão não é um agente trabalhando
  if (o.project) return { action: 'skip', why: 'project' };
  if (o.headless) return { action: 'skip', why: 'headless' };
  if (o.mode === 'changes' && !o.changed) return { action: 'skip', why: 'unchanged' };
  return { action: 'run' };
}

/** Motivo que o Claude recebe quando o portão não deixa parar. */
export function gateBlockReason(failed: string, output: string, attempt: number, max: number): string {
  return [
    `AgentYard: the checks failed (${failed}). Fix the problem before finishing; do not disable or skip the checks.`,
    `Attempt ${attempt} of ${max}. If the failure is not caused by your change (environment, flaky test) or you cannot fix it, explain why to the user and stop.`,
    '',
    tail(output, 60),
  ].join('\n');
}

// ---------------------------------------------------------------- revisor automático

export type ReviewVerdict = { ok: true; summary: string } | { ok: false; issues: string[]; summary: string };

const MAX_REVIEW_DIFF = 80_000;

/** Prompt do revisor: a tarefa (se houver), os commits e o diff contra a base. */
export function reviewPrompt(o: { branch: string; base: string; task?: string; subjects: string[]; diff: string; focus?: string }): string {
  const d = o.diff.length > MAX_REVIEW_DIFF ? `${o.diff.slice(0, MAX_REVIEW_DIFF)}\n… (diff truncated)` : o.diff;
  return [
    `You are reviewing the work another coding agent did on branch ${o.branch} (compared with ${o.base}) before a person reviews it.`,
    o.task ? `The task it was given:\n${o.task}` : '',
    o.subjects.length ? `Commits:\n${o.subjects.map(s => `- ${s}`).join('\n')}` : '',
    'Look only for real problems a careful reviewer would send back: bugs, broken edge cases, missing error handling that matters, security issues, tests that do not test what they claim, the task only partly done, and leftovers (debug code, commented-out code, unrelated changes).',
    'Do not nitpick style or naming, and do not ask for changes that are a matter of taste.',
    o.focus ? `Also pay attention to: ${o.focus}` : '',
    'Answer in this exact format and nothing else:',
    'VERDICT: OK   (or VERDICT: CHANGES)',
    'SUMMARY: <one line>',
    'ISSUES:',
    '- <file:line> <what is wrong and what to do>   (one per line; none when OK)',
    '',
    'Diff:',
    d,
  ]
    .filter(x => x !== '')
    .join('\n');
}

export function parseReview(text: string): ReviewVerdict {
  const verdict = text.match(/VERDICT:\s*(OK|CHANGES)/i)?.[1]?.toUpperCase();
  const summary = text.match(/SUMMARY:\s*(.+)/i)?.[1]?.trim() ?? '';
  const after = text.split(/ISSUES:\s*\n?/i)[1] ?? '';
  const issues = after
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => /^[-*]\s+\S/.test(l))
    .map(l => l.replace(/^[-*]\s+/, ''))
    .filter(l => !/^\(?none\)?\.?$/i.test(l));
  if (verdict === 'OK' || (!verdict && !issues.length)) return { ok: true, summary };
  return issues.length ? { ok: false, issues, summary } : { ok: true, summary };
}

/** O que vai para o agente quando o revisor pede mudanças. */
export function reviewFeedback(issues: string[], round: number, max: number): string {
  return [
    `AgentYard's automatic review (round ${round} of ${max}) found ${issues.length} problem(s) in this branch:`,
    ...issues.map((x, i) => `${i + 1}. ${x}`),
    'Fix the ones that are real, commit, and finish. If you disagree with one, say why in your final message instead of changing it.',
  ].join('\n');
}

// ---------------------------------------------------------------- juiz das tentativas

export interface JudgeAttempt {
  letter: string;
  branch: string;
  variation: string;
  commits: number;
  files: number;
  added: number;
  deleted: number;
  /** undefined: sem teste. */
  testsOk?: boolean;
  testTail?: string;
  diff: string;
}

export interface JudgeResult {
  /** Letras da melhor para a pior. */
  ranking: string[];
  reasons: Record<string, string>;
  recommendation: string;
}

const MAX_JUDGE_DIFF = 150_000;

export function judgePrompt(task: string, attempts: JudgeAttempt[]): string {
  const per = Math.floor(MAX_JUDGE_DIFF / Math.max(1, attempts.length));
  return [
    'Several coding agents solved the same task, each in its own branch. Compare the attempts and rank them from best to worst.',
    `The task:\n${task}`,
    'Judge, in this order: does it do what the task asks (completely, and nothing unrelated); correctness and edge cases; tests passing and test quality; simplicity and fit with the existing code; size of the change.',
    ...attempts.map(a =>
      [
        `=== Attempt ${a.letter} (${a.branch})${a.variation ? ` — guidance: ${a.variation}` : ''}`,
        `${a.commits} commit(s), ${a.files} file(s), +${a.added} −${a.deleted}; tests: ${a.testsOk === undefined ? 'not run' : a.testsOk ? 'passed' : 'FAILED'}`,
        a.testsOk === false && a.testTail ? `End of the test output:\n${a.testTail}` : '',
        'Diff:',
        a.diff.length > per ? `${a.diff.slice(0, per)}\n… (diff truncated)` : a.diff || '(no changes)',
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    'Answer in this exact format and nothing else:',
    `RANKING: ${attempts.map(a => a.letter).join(', ')}   (best first, the letters only)`,
    ...attempts.map(a => `${a.letter}: <one line: the main strength or problem>`),
    'RECOMMENDATION: <two or three sentences: which one to keep and whether something from another attempt is worth bringing over>',
  ]
    .filter(x => x !== '')
    .join('\n\n');
}

export function parseJudge(text: string, letters: string[]): JudgeResult | undefined {
  const known = new Set(letters.map(l => l.toUpperCase()));
  const line = text.match(/RANKING:\s*(.+)/i)?.[1] ?? '';
  const ranking = [...new Set((line.match(/\b[A-H]\b/gi) ?? []).map(x => x.toUpperCase()).filter(x => known.has(x)))];
  if (!ranking.length) return undefined;
  for (const l of letters.map(x => x.toUpperCase())) if (!ranking.includes(l)) ranking.push(l);
  const reasons: Record<string, string> = {};
  for (const l of known) {
    const m = text.match(new RegExp(`^\\s*${l}\\s*:\\s*(.+)$`, 'mi'));
    if (m) reasons[l] = m[1].trim();
  }
  const recommendation = (text.match(/RECOMMENDATION:\s*([\s\S]+)$/i)?.[1] ?? '').trim();
  return { ranking, reasons, recommendation };
}

// ---------------------------------------------------------------- agente travado

export interface StuckTracker {
  /** Assinatura da última ação e quantas vezes seguidas ela se repetiu no turno. */
  last?: string;
  repeats: number;
  /** Já avisou neste turno. */
  nudged: boolean;
}

/** Normaliza uma ação para comparar repetições (espaços, números de linha de saída, caminhos com barra). */
export function actionSignature(tool: string | undefined, input: Record<string, unknown> | undefined): string | undefined {
  if (!tool) return undefined;
  const i = input ?? {};
  if (tool === 'Bash') return `Bash:${String(i.command ?? '').replace(/\s+/g, ' ').trim()}`;
  if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write') {
    const f = String(i.file_path ?? '').replace(/\\/g, '/');
    const body = tool === 'Write' ? String(i.content ?? '') : tool === 'Edit' ? `${i.old_string ?? ''}\u0000${i.new_string ?? ''}` : JSON.stringify(i.edits ?? '');
    return `${tool}:${f}:${hash(body)}`;
  }
  return undefined;
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Conta a ação; devolve true quando chegou a `limit` repetições seguidas (uma vez por turno). */
export function trackAction(t: StuckTracker, sig: string | undefined, limit: number): boolean {
  if (!sig) return false;
  if (sig === t.last) t.repeats++;
  else {
    t.last = sig;
    t.repeats = 1;
  }
  if (limit > 0 && t.repeats >= limit && !t.nudged) {
    t.nudged = true;
    return true;
  }
  return false;
}

export function stuckNudge(sig: string, repeats: number): string {
  const what = sig.startsWith('Bash:') ? `the command \`${sig.slice(5).slice(0, 200)}\`` : `the same edit to ${sig.split(':').slice(1, -1).join(':')}`;
  return `AgentYard: you have repeated ${what} ${repeats} times in a row in this turn without getting anywhere. Stop and rethink: read the error carefully, check your assumptions, try a different approach. If you are blocked by something only a person can solve, explain it to the user and stop.`;
}

// ---------------------------------------------------------------- limite de uso

/** Pausar a fila? `pct` é o uso estimado da janela (0–100+); `limit` 0 desliga. */
export function usageBlocks(pct: number | undefined, limit: number): boolean {
  return limit > 0 && typeof pct === 'number' && pct >= limit;
}

export interface UsagePause {
  /** Quando tentar de novo. */
  until: number;
  window: '5h' | 'week';
  pct: number;
}

/**
 * A fila deve esperar? Compara o uso estimado da janela de 5 h e da semana com os orçamentos
 * (`claude.sessionBudgetTokens`, `weeklyBudgetTokens`); sem orçamento, nunca pausa. Na semana
 * corrida não há hora de virada: tenta de novo em 1 h.
 */
export function usagePause(o: {
  limitPct: number;
  block?: { tokens: number; end: number };
  sessionBudget: number;
  week: { tokens: number; end: number };
  weekBudget: number;
  weekRolling: boolean;
  now: number;
}): UsagePause | undefined {
  if (o.limitPct <= 0) return undefined;
  const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : undefined);
  const w = pct(o.week.tokens, o.weekBudget);
  if (usageBlocks(w, o.limitPct)) return { window: 'week', pct: w!, until: o.weekRolling ? o.now + 3600_000 : o.week.end };
  const b = o.block ? pct(o.block.tokens, o.sessionBudget) : undefined;
  if (o.block && usageBlocks(b, o.limitPct)) return { window: '5h', pct: b!, until: o.block.end };
  return undefined;
}
