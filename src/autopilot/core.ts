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
