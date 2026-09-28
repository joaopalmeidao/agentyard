import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runGit } from '../git';

/**
 * Checkpoints por turno do agente e a autoria dos commits, sem VS Code (testado em test/turns.test.js).
 *
 * Checkpoint: um commit solto com o estado inteiro da worktree (rastreados e novos, respeitando o
 * .gitignore), feito com um índice temporário: não mexe no índice, no stash nem no HEAD da worktree.
 * Fica vivo por uma ref em refs/agentyard/turns/ para o gc não levar.
 *
 * Autoria: os commits feitos durante um turno ganham uma nota em refs/notes/agentyard com a sessão do
 * Claude que os fez; o blame de uma linha leva à transcrição.
 */

export const TURN_REFS = 'refs/agentyard/turns';
export const NOTES_REF = 'refs/notes/agentyard';

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const r = await runGit(cwd, args, 120_000, env);
  if (r.code !== 0) throw new Error(`git ${args[0]}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

async function head(cwd: string): Promise<string | undefined> {
  const r = await runGit(cwd, ['rev-parse', '--verify', '-q', 'HEAD']);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** Commit com o estado atual da worktree (o pai é o HEAD). */
export async function snapshot(cwd: string, message = 'AgentYard checkpoint'): Promise<string> {
  const tmp = path.join(os.tmpdir(), `agentyard-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  try {
    // partir de uma cópia do índice real aproveita o cache de stat: o add -A só relê o que mudou
    const real = path.resolve(cwd, (await git(cwd, ['rev-parse', '--git-path', 'index'])).trim());
    if (fs.existsSync(real)) fs.copyFileSync(real, tmp);
    const env = { GIT_INDEX_FILE: tmp };
    await git(cwd, ['add', '-A', '--', '.'], env);
    const tree = (await git(cwd, ['write-tree'], env)).trim();
    const h = await head(cwd);
    const who = { GIT_AUTHOR_NAME: 'AgentYard', GIT_AUTHOR_EMAIL: 'agentyard@localhost', GIT_COMMITTER_NAME: 'AgentYard', GIT_COMMITTER_EMAIL: 'agentyard@localhost' };
    return (await git(cwd, ['commit-tree', tree, ...(h ? ['-p', h] : []), '-m', message], who)).trim();
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Nome seguro para um pedaço de ref. */
export function refPart(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '-').replace(/\.+/g, '.').replace(/^[.-]+|[.-]+$/g, '') || 'x';
}

export async function keepRef(cwd: string, ref: string, sha: string) {
  await git(cwd, ['update-ref', ref, sha]);
}

/** Apaga as refs de checkpoint com mais de `maxAgeDays` (ou todas de um agente, com `prefix`). */
export async function pruneTurnRefs(cwd: string, maxAgeDays: number, prefix = TURN_REFS, now = Date.now()): Promise<number> {
  const out = await git(cwd, ['for-each-ref', '--format=%(refname) %(committerdate:unix)', prefix]);
  let n = 0;
  for (const line of out.split('\n').filter(Boolean)) {
    const [ref, when] = line.split(' ');
    if (maxAgeDays > 0 && now / 1000 - Number(when) < maxAgeDays * 86400) continue;
    await git(cwd, ['update-ref', '-d', ref]);
    n++;
  }
  return n;
}

export interface FileChange {
  status: 'A' | 'M' | 'D' | 'T';
  path: string;
  additions: number;
  deletions: number;
}

/** Arquivos que mudaram de um checkpoint (ou commit) para outro, com +/−. */
export async function changesBetween(cwd: string, from: string, to: string): Promise<FileChange[]> {
  const [names, nums] = await Promise.all([
    git(cwd, ['diff', '--no-renames', '--name-status', '-z', from, to]),
    git(cwd, ['diff', '--no-renames', '--numstat', '-z', from, to]),
  ]);
  const n = names.split('\0');
  const counts = new Map<string, [number, number]>();
  for (const rec of nums.split('\0').filter(Boolean)) {
    const [a, d, p] = rec.split('\t');
    counts.set(p, [Number(a) || 0, Number(d) || 0]);
  }
  const out: FileChange[] = [];
  for (let i = 0; i + 1 < n.length; i += 2) {
    const status = n[i][0] as FileChange['status'];
    const p = n[i + 1];
    if (!p) continue;
    const [additions, deletions] = counts.get(p) ?? [0, 0];
    out.push({ status, path: p, additions, deletions });
  }
  return out;
}

export async function patchBetween(cwd: string, from: string, to: string, paths: string[] = []): Promise<string> {
  return git(cwd, ['diff', '--no-renames', '--no-color', from, to, ...(paths.length ? ['--', ...paths] : [])]);
}

/**
 * Volta os arquivos da worktree ao estado de `target`: o que mudou depois volta, o que foi criado
 * depois é apagado. Não mexe no índice nem no HEAD. Devolve o checkpoint de antes (para desfazer).
 */
export async function restore(cwd: string, target: string): Promise<{ before: string; files: FileChange[] }> {
  const before = await snapshot(cwd, 'AgentYard checkpoint (before restore)');
  const files = await changesBetween(cwd, target, before);
  const back = files.filter(f => f.status !== 'A').map(f => f.path);
  if (back.length) {
    const list = path.join(os.tmpdir(), `agentyard-paths-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    fs.writeFileSync(list, back.join('\0'));
    try {
      await git(cwd, ['restore', `--source=${target}`, '--worktree', '--pathspec-from-file', list, '--pathspec-file-nul']);
    } finally {
      fs.rmSync(list, { force: true });
    }
  }
  for (const f of files.filter(x => x.status === 'A')) fs.rmSync(path.join(cwd, f.path), { force: true });
  return { before, files };
}

// ---------------------------------------------------------------- autoria

export interface Provenance {
  session?: string;
  agent?: string;
  turn?: number;
  prompt?: string;
}

export function formatNote(p: Provenance): string {
  return [
    p.session ? `Agent-Session: ${p.session}` : '',
    p.agent ? `Agent: ${p.agent}` : '',
    p.turn ? `Agent-Turn: ${p.turn}` : '',
    p.prompt ? `Agent-Prompt: ${p.prompt.replace(/\s+/g, ' ').slice(0, 200)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function parseNote(text: string): Provenance {
  const get = (k: string) => text.match(new RegExp(`^${k}: (.*)$`, 'm'))?.[1]?.trim();
  const turn = Number(get('Agent-Turn'));
  return { session: get('Agent-Session'), agent: get('Agent'), turn: turn || undefined, prompt: get('Agent-Prompt') };
}

/** Commits que entraram de `from` até `to` (só os novos, sem os que já estavam na base). */
export async function newCommits(cwd: string, from: string, to: string): Promise<string[]> {
  if (!from || !to || from === to) return [];
  const out = await git(cwd, ['rev-list', `${from}..${to}`]);
  return out.split('\n').filter(Boolean);
}

export async function addNotes(cwd: string, shas: string[], p: Provenance) {
  const text = formatNote(p);
  if (!text) return;
  for (const sha of shas) await git(cwd, ['notes', `--ref=${NOTES_REF}`, 'add', '-f', '-m', text, sha]);
}

export async function noteOf(cwd: string, sha: string): Promise<Provenance | undefined> {
  const r = await runGit(cwd, ['notes', `--ref=${NOTES_REF}`, 'show', sha]);
  return r.code === 0 ? parseNote(r.stdout) : undefined;
}

/** Commit que escreveu a linha (1-based) do arquivo; undefined se ainda não commitada. */
export async function blameLine(cwd: string, file: string, line: number): Promise<{ sha: string; summary: string; author: string } | undefined> {
  const r = await runGit(cwd, ['blame', '--porcelain', '-L', `${line},${line}`, '--', file]);
  if (r.code !== 0) return undefined;
  const sha = r.stdout.split(' ')[0];
  if (!sha || /^0+$/.test(sha)) return undefined;
  const summary = r.stdout.match(/^summary (.*)$/m)?.[1] ?? '';
  const author = r.stdout.match(/^author (.*)$/m)?.[1] ?? '';
  return { sha, summary, author };
}
