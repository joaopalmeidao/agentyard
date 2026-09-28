/**
 * Mural dos agentes e reservas de arquivos, sem VS Code (testado em test/autopilot.test.js).
 *
 * Fica em `<git common dir>/agentyard-board.json`: vale para todas as worktrees e janelas do mesmo
 * repositório e não suja nenhuma worktree. Os caminhos das reservas são relativos à raiz da worktree
 * (iguais em todas), com `/`, e aceitam glob (`*`, `**`, `?`).
 */
import * as fs from 'fs';
import * as path from 'path';

export const BOARD_FILE = 'agentyard-board.json';
const MAX_NOTES = 200;

export interface Note {
  id: string;
  at: number;
  /** Branch (ou nome) de quem escreveu; "você" quando veio do VS Code. */
  from: string;
  /** Worktree de quem escreveu (vazio: a pessoa, pelo VS Code). */
  worktree?: string;
  text: string;
}

export interface Claim {
  worktree: string;
  branch: string;
  pattern: string;
  note?: string;
  at: number;
  expires: number;
}

export interface Board {
  notes: Note[];
  claims: Claim[];
}

const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

export function boardPath(commonDir: string) {
  return path.join(commonDir, BOARD_FILE);
}

export function readBoard(file: string): Board {
  try {
    const b = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { notes: Array.isArray(b?.notes) ? b.notes : [], claims: Array.isArray(b?.claims) ? b.claims : [] };
  } catch {
    return { notes: [], claims: [] };
  }
}

export function writeBoard(file: string, b: Board) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(b, null, 2));
  fs.renameSync(tmp, file);
}

/** Lê, muda e grava (a última escrita vence; o arquivo é pequeno e as escritas raras). */
export function updateBoard<T>(file: string, fn: (b: Board) => T): T {
  const b = readBoard(file);
  const r = fn(b);
  writeBoard(file, b);
  return r;
}

export function addNote(b: Board, n: Omit<Note, 'id'>): Note {
  const note: Note = { ...n, id: `${n.at.toString(36)}${Math.random().toString(36).slice(2, 6)}` };
  b.notes.push(note);
  if (b.notes.length > MAX_NOTES) b.notes.splice(0, b.notes.length - MAX_NOTES);
  return note;
}

/** Notas de outros (não da própria worktree) depois de `since`, as mais antigas primeiro. */
export function notesFor(b: Board, worktree: string, since: number, max = 20): Note[] {
  const me = norm(worktree);
  return b.notes.filter(n => n.at > since && (!n.worktree || norm(n.worktree) !== me)).slice(-max);
}

export function formatNotes(notes: Note[]): string {
  return notes.map(n => `- [${new Date(n.at).toISOString().slice(0, 16).replace('T', ' ')}] ${n.from}: ${n.text}`).join('\n');
}

// ---------------------------------------------------------------- reservas

/** Caminho relativo normalizado (`/`, sem `./` nem barra no começo). */
export function relPattern(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

export function globToRegExp(pattern: string): RegExp {
  let re = '';
  const p = relPattern(pattern);
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // uma pasta reserva tudo dentro dela
  return new RegExp(`^${re}(?:/.*)?$`, 'i');
}

export function matches(pattern: string, rel: string): boolean {
  return globToRegExp(pattern).test(relPattern(rel));
}

/** Tira as vencidas e as de worktrees que não existem mais (`alive`). */
export function pruneClaims(b: Board, now: number, alive?: (worktree: string) => boolean) {
  b.claims = b.claims.filter(c => c.expires > now && (!alive || alive(c.worktree)));
}

/** Reserva de outra worktree que cobre o arquivo. */
export function claimOn(b: Board, worktree: string, rel: string, now: number): Claim | undefined {
  const me = norm(worktree);
  return b.claims.find(c => c.expires > now && norm(c.worktree) !== me && matches(c.pattern, rel));
}

/** Dois padrões podem pegar o mesmo arquivo? (conservador: um casa o outro como caminho) */
function overlap(a: string, b: string): boolean {
  const x = relPattern(a);
  const y = relPattern(b);
  return matches(x, y.replace(/\*+/g, 'x').replace(/\?/g, 'x')) || matches(y, x.replace(/\*+/g, 'x').replace(/\?/g, 'x'));
}

/** Reserva os padrões; os que já são de outra worktree ficam de fora e voltam em `taken`. */
export function claim(
  b: Board,
  o: { worktree: string; branch: string; patterns: string[]; note?: string; now: number; hours: number },
): { claimed: string[]; taken: { pattern: string; by: Claim }[] } {
  pruneClaims(b, o.now);
  const me = norm(o.worktree);
  const claimed: string[] = [];
  const taken: { pattern: string; by: Claim }[] = [];
  for (const raw of o.patterns) {
    const pattern = relPattern(raw);
    if (!pattern) continue;
    const by = b.claims.find(c => norm(c.worktree) !== me && overlap(c.pattern, pattern));
    if (by) {
      taken.push({ pattern, by });
      continue;
    }
    b.claims = b.claims.filter(c => !(norm(c.worktree) === me && c.pattern === pattern));
    b.claims.push({ worktree: o.worktree, branch: o.branch, pattern, note: o.note, at: o.now, expires: o.now + o.hours * 3600_000 });
    claimed.push(pattern);
  }
  return { claimed, taken };
}

/** Solta as reservas de uma worktree (todas, ou só os padrões dados). Devolve quantas saíram. */
export function release(b: Board, worktree: string, patterns?: string[]): number {
  const me = norm(worktree);
  const only = patterns?.length ? new Set(patterns.map(relPattern)) : undefined;
  const before = b.claims.length;
  b.claims = b.claims.filter(c => norm(c.worktree) !== me || (only && !only.has(c.pattern)));
  return before - b.claims.length;
}
