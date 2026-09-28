import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentFlow } from '../agentFlow/register';
import { keyOf } from '../agentFlow/head';
import type { BridgeHookEvent, ClaudeBridge } from '../bridge/register';
import { hookJson } from '../bridge/register';
import { isInside } from '../bridge/core';
import type { Controller } from '../controller';
import { t } from '../i18n';
import { addNote, Board, boardPath, claim, claimOn, formatNotes, notesFor, pruneClaims, readBoard, release, updateBoard } from './board';

export type ClaimsMode = 'ask' | 'block' | 'off';

const FIRST_LOOK_MS = 24 * 3600_000;
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/**
 * Mural entre os agentes e reservas de arquivos (src/autopilot/board.ts):
 *  - ferramentas MCP `post_note`, `read_notes`, `claim_files`, `release_files` e `list_claims`;
 *  - notas novas de outras worktrees (e as suas, pelo VS Code) entram no contexto do próximo prompt
 *    de cada Claude;
 *  - editar um arquivo reservado por outra worktree pede confirmação (`claude.claims: ask`) ou é
 *    recusado (`block`); as reservas saem quando a worktree fica pronta, vencem ou a worktree some.
 */
export class AgentBoard implements vscode.Disposable {
  /** Até quando cada Claude (terminal ou sessão) já recebeu as notas. */
  private readonly seen = new Map<string, number>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ctl: Controller, private readonly bridge: ClaudeBridge, flow: AgentFlow) {
    bridge.onHook('UserPromptSubmit', e => this.onPrompt(e));
    bridge.onHook('PreToolUse', e => this.onTool(e));
    this.disposables.push(flow.watch.onDidFinish(f => f.ready && this.file() && updateBoard(this.file()!, b => release(b, f.path))));
    this.registerTools();
  }

  private cfg() {
    return this.ctl.cfg();
  }

  private file(): string | undefined {
    const dir = this.ctl.repo?.commonDir;
    return dir ? boardPath(dir) : undefined;
  }

  private alive = (wt: string) => (this.ctl.state?.worktrees ?? []).some(w => keyOf(w.path) === keyOf(wt));

  board(): Board {
    const f = this.file();
    const b = f ? readBoard(f) : { notes: [], claims: [] };
    pruneClaims(b, Date.now(), this.ctl.state ? this.alive : undefined);
    return b;
  }

  private agentKey(e: BridgeHookEvent) {
    return e.open?.id ?? e.session_id ?? keyOf(e.cwd);
  }

  // ------------------------------------------------------------ hooks

  private onPrompt(e: BridgeHookEvent) {
    const w = e.worktree;
    if (!w || !this.cfg().get<boolean>('claude.board', true)) return undefined;
    const k = this.agentKey(e);
    const since = this.seen.get(k) ?? Date.now() - FIRST_LOOK_MS;
    const notes = notesFor(this.board(), w.path, since, this.seen.has(k) ? 20 : 10);
    if (!notes.length) {
      if (!this.seen.has(k)) this.seen.set(k, Date.now());
      return undefined;
    }
    this.seen.set(k, notes[notes.length - 1].at);
    const text = `AgentYard board — notes from the other agents working on this repository (and from the user):\n${formatNotes(notes)}\nTake them into account if they affect your work. To tell the others about a change that affects them, use the agentyard post_note tool.`;
    return hookJson({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } });
  }

  private onTool(e: BridgeHookEvent) {
    const w = e.worktree;
    const mode = this.cfg().get<ClaimsMode>('claude.claims', 'ask');
    if (!w || mode === 'off' || !EDIT_TOOLS.has(e.tool_name ?? '')) return undefined;
    const raw = String(e.tool_input?.file_path ?? e.tool_input?.notebook_path ?? '');
    if (!raw) return undefined;
    const abs = path.resolve(e.cwd || w.path, raw);
    if (!isInside(abs, w.path)) return undefined;
    const rel = path.relative(w.path, abs);
    const c = claimOn(this.board(), w.path, rel, Date.now());
    if (!c) return undefined;
    const why = `${rel} is reserved by the agent in ${c.branch}${c.note ? ` (${c.note})` : ''} until ${new Date(c.expires).toLocaleTimeString()}. Coordinate first: leave a note with the agentyard post_note tool, work on something else, or ask the user.`;
    this.ctl.log(t('File reservation: {0} in {1} is reserved by {2}.', rel, w.branch ?? w.name, c.branch));
    return hookJson({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: mode === 'block' ? 'deny' : 'ask', permissionDecisionReason: why } });
  }

  // ------------------------------------------------------------ ferramentas

  private registerTools() {
    const need = () => {
      const f = this.file();
      if (!f) throw new Error('AgentYard has no repository open.');
      return f;
    };
    this.bridge.addTool('post_note', async (args, { cwd, open }) => {
      const text = String(args.text ?? '').trim();
      if (!text) throw new Error('Give the note text.');
      const w = this.bridge.resolve(open?.path, cwd);
      updateBoard(need(), b => addNote(b, { at: Date.now(), from: w.branch ?? w.name, worktree: w.path, text: text.slice(0, 2000) }));
      return 'Note posted. The other agents get it with their next prompt.';
    });
    this.bridge.addTool('read_notes', async (args, { cwd, open }) => {
      const w = this.bridge.resolve(open?.path, cwd);
      const b = this.board();
      const notes = args.all ? b.notes.slice(-40) : notesFor(b, w.path, 0, 30);
      return notes.length ? formatNotes(notes) : 'No notes on the board.';
    });
    this.bridge.addTool('claim_files', async (args, { cwd, open }) => {
      const w = this.bridge.resolve(open?.path, cwd);
      const patterns = (Array.isArray(args.files) ? args.files : [args.files]).map(x => String(x ?? '')).filter(Boolean);
      if (!patterns.length) throw new Error('Give the files or folders (globs allowed) to reserve.');
      const hours = Math.min(24, Math.max(0.25, Number(args.hours) || this.cfg().get<number>('claude.claims.hours', 4)));
      const r = updateBoard(need(), b => claim(b, { worktree: w.path, branch: w.branch ?? w.name, patterns, note: args.note ? String(args.note) : undefined, now: Date.now(), hours }));
      const lines = [
        r.claimed.length ? `Reserved for ${hours} h: ${r.claimed.join(', ')}.` : '',
        ...r.taken.map(x => `Not reserved: ${x.pattern} — already reserved by ${x.by.branch}${x.by.note ? ` (${x.by.note})` : ''}.`),
      ].filter(Boolean);
      return { text: lines.join('\n'), isError: !r.claimed.length };
    });
    this.bridge.addTool('release_files', async (args, { cwd, open }) => {
      const w = this.bridge.resolve(open?.path, cwd);
      const patterns = Array.isArray(args.files) ? args.files.map(String) : undefined;
      const n = updateBoard(need(), b => release(b, w.path, patterns));
      return `${n} reservation(s) released.`;
    });
    this.bridge.addTool('list_claims', async () => {
      const b = this.board();
      if (!b.claims.length) return 'No files reserved.';
      return b.claims.map(c => `${c.pattern} — ${c.branch}${c.note ? ` (${c.note})` : ''}, until ${new Date(c.expires).toLocaleTimeString()}`).join('\n');
    });
  }

  // ------------------------------------------------------------ comandos

  /** A pessoa escreve no mural: todos os agentes recebem no próximo prompt. */
  async post() {
    const f = this.file();
    if (!f) return;
    const text = await vscode.window.showInputBox({
      title: t('Note to all agents'),
      prompt: t('Every Claude working on this repository gets it with its next prompt (e.g. "the users table now has a tenant_id column").'),
      ignoreFocusOut: true,
    });
    if (!text?.trim()) return;
    updateBoard(f, b => addNote(b, { at: Date.now(), from: t('the user'), text: text.trim() }));
    vscode.window.setStatusBarMessage(t('$(megaphone) Note posted to the agents'), 4000);
  }

  async show() {
    const b = this.board();
    const name = (wt?: string) => (wt ? this.bridge.nameOf(wt) : t('the user'));
    const md = [
      `# ${t('Agent board')}`,
      '',
      `## ${t('Reserved files')}`,
      '',
      ...(b.claims.length ? b.claims.map(c => `- \`${c.pattern}\` — ${c.branch}${c.note ? ` · ${c.note}` : ''} · ${t('until {0}', new Date(c.expires).toLocaleTimeString())}`) : [`- ${t('none')}`]),
      '',
      `## ${t('Notes')}`,
      '',
      ...(b.notes.length
        ? [...b.notes]
            .reverse()
            .slice(0, 60)
            .map(n => `- **${n.worktree ? name(n.worktree) : n.from}** · ${new Date(n.at).toLocaleString()}\n  ${n.text.replace(/\n/g, '\n  ')}`)
        : [`- ${t('none')}`]),
    ];
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md.join('\n') + '\n' });
    await vscode.commands.executeCommand('markdown.showPreview', doc.uri).then(undefined, () => vscode.window.showTextDocument(doc));
  }

  /** Reserva arquivos para uma worktree (o orquestrador, ao começar uma subtarefa). */
  claimFor(worktree: string, branch: string, patterns: string[], note?: string) {
    const f = this.file();
    if (!f || !patterns.length) return;
    updateBoard(f, b => claim(b, { worktree, branch, patterns, note, now: Date.now(), hours: 24 }));
  }

  async releaseFor(worktree: string) {
    const f = this.file();
    if (!f) return;
    const n = updateBoard(f, b => release(b, worktree));
    vscode.window.showInformationMessage(t('{0} file reservation(s) released.', n));
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
  }
}
