import { spawn } from 'child_process';

/**
 * Claude Code sem terminal (`claude -p --output-format json`): para textos curtos que a extensão
 * precisa (mensagem de commit, título e descrição de PR). O prompt vai pelo stdin. Sem VS Code
 * (testado em test/headless.test.js com um "claude" falso).
 */

export interface HeadlessResult {
  text: string;
  costUsd?: number;
  sessionId?: string;
}

export interface HeadlessOptions {
  cwd: string;
  /** Binário (padrão: claude). */
  bin?: string;
  model?: string;
  timeoutMs?: number;
  /** Cancela a execução. */
  signal?: AbortSignal;
}

/** Tira cercas de código e aspas que o modelo às vezes põe em volta da resposta. */
export function cleanOutput(s: string): string {
  let x = s.trim();
  const fence = x.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  if (fence) x = fence[1].trim();
  if (/^".*"$/s.test(x) && !x.slice(1, -1).includes('"')) x = x.slice(1, -1);
  return x;
}

/** Lê a saída JSON do `claude -p --output-format json` (ou o texto puro, se não for JSON). */
export function parseHeadless(stdout: string): HeadlessResult {
  const raw = stdout.trim();
  try {
    const j = JSON.parse(raw.split(/\r?\n/).filter(Boolean).pop() ?? raw);
    if (j && typeof j === 'object') {
      if (j.is_error || j.subtype === 'error') throw new Error(String(j.result || j.error || 'Claude returned an error.'));
      return { text: cleanOutput(String(j.result ?? '')), costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : undefined, sessionId: j.session_id };
    }
  } catch (e) {
    if (e instanceof SyntaxError) return { text: cleanOutput(raw) };
    throw e;
  }
  return { text: cleanOutput(raw) };
}

export function runHeadless(prompt: string, o: HeadlessOptions): Promise<HeadlessResult> {
  const args = ['-p', '--output-format', 'json', ...(o.model ? ['--model', o.model] : [])];
  return new Promise((resolve, reject) => {
    // no Windows o claude pode ser um .cmd (npm): precisa do shell
    const child = spawn(o.bin ?? 'claude', args, { cwd: o.cwd, shell: process.platform === 'win32', windowsHide: true, env: { ...process.env, WTGRAPH_HEADLESS: '1' } });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claude -p did not answer in ${Math.round((o.timeoutMs ?? 120_000) / 1000)} s.`));
    }, o.timeoutMs ?? 120_000);
    o.signal?.addEventListener('abort', () => {
      child.kill();
      reject(new Error('canceled'));
    });
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', e => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) return reject(new Error((err || `claude exited with ${code}`).trim()));
      try {
        resolve(parseHeadless(out));
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.end(prompt);
  });
}

const MAX_DIFF = 60_000;

/** Prompt da mensagem de commit: o diff e as últimas mensagens do repositório (para seguir o estilo). */
export function commitMessagePrompt(diff: string, recent: string[], lang?: string): string {
  const d = diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… (diff truncated)` : diff;
  return [
    'Write a git commit message for the staged changes below.',
    'Follow the style of the recent commit messages of this repository (language, tense, prefixes, length).',
    recent.length ? `Recent commit messages:\n${recent.map(s => `- ${s}`).join('\n')}` : '',
    lang ? `If the recent messages do not make the language clear, write in ${lang}.` : '',
    'Answer with the commit message only: a subject line of at most 72 characters and, only if it helps, a blank line and a short body. No quotes, no code fences, no explanations.',
    '',
    'Diff:',
    d,
  ]
    .filter(x => x !== '')
    .join('\n');
}

/** Prompt de título + descrição de PR/MR a partir dos commits e do diff. */
export function prDescriptionPrompt(branch: string, target: string, subjects: string[], diff: string, label: 'PR' | 'MR', lang?: string): string {
  const d = diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… (diff truncated)` : diff;
  return [
    `Write the title and description of a ${label} from ${branch} into ${target}.`,
    `Commits:\n${subjects.map(s => `- ${s}`).join('\n')}`,
    lang ? `Write in ${lang}, matching the language of the commits if it is clear.` : '',
    'Answer in this exact format and nothing else:',
    'TITLE: <one line, at most 72 characters>',
    'BODY:',
    '<markdown: a short summary of what changed and why, then a "How to test" list. No headings above level 2.>',
    '',
    'Diff:',
    d,
  ]
    .filter(x => x !== '')
    .join('\n');
}

export function parseTitleBody(text: string): { title: string; body: string } | undefined {
  const m = text.match(/TITLE:\s*(.+)\s*\n+BODY:\s*\n?([\s\S]*)$/i);
  if (!m) return undefined;
  return { title: m[1].trim().replace(/^["']|["']$/g, ''), body: m[2].trim() };
}
