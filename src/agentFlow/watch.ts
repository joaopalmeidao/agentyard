import * as vscode from 'vscode';
import type { AgentLaunch, AgentTerminals } from '../agents';
import type { Controller } from '../controller';
import { indexMtime, keyOf, readHead } from './head';

/** Worktree marcada como "pronta para revisar": o agente terminou e deixou commits. */
export interface ReadyInfo {
  path: string;
  branch?: string;
  at: number;
  commits: number;
}

interface Session {
  key: string;
  path: string;
  branch?: string;
  terminal: vscode.Terminal;
  headAtStart?: string;
  lastHead?: string;
  lastIndex: number;
  lastActivity: number;
  execEnded: boolean;
  closed: boolean;
}

export interface AgentFinish {
  path: string;
  branch?: string;
  /** true: terminou com commits e worktree limpa; false: fechou sem deixar commit. */
  ready: boolean;
}

const READY_KEY = 'agentFlow.ready';
const TICK_MS = 30_000;

/**
 * Acompanha os agentes abertos pela extensão e decide quando cada um "terminou":
 *  - o comando do agente acabou (shell integration, quando o VS Code oferece),
 *  - o terminal foi fechado,
 *  - o Claude Code terminou o turno (hook Stop, ver src/claude/hooks.ts), ou
 *  - sem hooks: ninguém mexeu no HEAD nem no índice da worktree por `agents.idleMinutes`.
 * Só vira "pronto para revisar" se o HEAD andou desde a abertura e a worktree ficou limpa.
 * A checagem lê arquivos do .git; o único processo git é o status final, e só das worktrees com agente.
 */
export class AgentWatch implements vscode.Disposable {
  private readonly sessions = new Map<string, Session>();
  private readonly finished = new vscode.EventEmitter<AgentFinish>();
  readonly onDidFinish = this.finished.event;
  private readonly disposables: vscode.Disposable[] = [this.finished];
  private timer?: NodeJS.Timeout;
  private checking = new Set<string>();

  constructor(private readonly ctl: Controller, private readonly agentTerms: AgentTerminals, private readonly onReady: (r: ReadyInfo) => void) {
    this.disposables.push(
      agentTerms.onDidLaunch(l => this.track(l)),
      // Claude com hooks: o fim do turno (Stop) é o sinal certo de que parou
      agentTerms.onDidChangeState(({ open }) => {
        if (open.state !== 'idle' && open.state !== 'ended') return;
        for (const s of this.sessions.values()) if (s.terminal === open.terminal) void this.check(s.key);
      }),
      vscode.window.onDidCloseTerminal(t => {
        for (const s of this.sessions.values()) {
          if (s.terminal === t) {
            s.closed = true;
            void this.check(s.key);
          }
        }
      }),
    );
    // Shell integration (VS Code 1.93+): o fim do comando do agente é o sinal mais preciso.
    const w = vscode.window as unknown as Record<string, unknown>;
    if (typeof w.onDidEndTerminalShellExecution === 'function') {
      const on = w.onDidEndTerminalShellExecution as (cb: (e: { terminal: vscode.Terminal }) => void) => vscode.Disposable;
      this.disposables.push(
        on(e => {
          for (const s of this.sessions.values()) {
            if (s.terminal === e.terminal) {
              s.execEnded = true;
              void this.check(s.key);
            }
          }
        }),
      );
    }
  }

  private idleMs() {
    return Math.max(0.1, this.ctl.cfg().get<number>('agents.idleMinutes', 3)) * 60_000;
  }

  /** Começa a acompanhar um agente recém-aberto; abrir de novo limpa o "pronto". */
  track(l: AgentLaunch) {
    const key = keyOf(l.path);
    void this.clearReady(l.path);
    const head = readHead(l.path);
    this.sessions.set(key, {
      key,
      path: l.path,
      branch: l.branch,
      terminal: l.terminal,
      headAtStart: head,
      lastHead: head,
      lastIndex: indexMtime(l.path),
      lastActivity: Date.now(),
      execEnded: false,
      closed: false,
    });
    this.ensureTimer();
  }

  isWatching(p: string) {
    return this.sessions.has(keyOf(p));
  }

  private ensureTimer() {
    if (this.timer || !this.sessions.size) return;
    this.timer = setInterval(() => {
      if (!this.sessions.size) {
        clearInterval(this.timer);
        this.timer = undefined;
        return;
      }
      for (const k of [...this.sessions.keys()]) void this.check(k);
    }, TICK_MS);
  }

  private poll(s: Session) {
    const head = readHead(s.path);
    if (head !== s.lastHead) {
      s.lastHead = head;
      s.lastActivity = Date.now();
    }
    const idx = indexMtime(s.path);
    if (idx > s.lastIndex) {
      s.lastIndex = idx;
      s.lastActivity = Date.now();
    }
  }

  /**
   * Checa uma sessão. `force` ignora a espera por ociosidade/fim do comando (usado pelos testes e
   * pelo comando "Verificar agora").
   */
  async check(key: string, force = false): Promise<boolean> {
    const s = this.sessions.get(key);
    if (!s || this.checking.has(key)) return false;
    this.checking.add(key);
    try {
      this.poll(s);
      // Com os hooks, o estado do Claude decide; sem eles (ou se nunca responderam), vale a ociosidade.
      const agentState = this.agentTerms.stateOf(s.terminal);
      const known = agentState !== undefined && agentState !== 'starting';
      const done = known ? agentState === 'idle' || agentState === 'ended' : Date.now() - s.lastActivity >= this.idleMs();
      if (!(force || s.closed || s.execEnded || done)) return false;
      const moved = !!s.lastHead && s.lastHead !== s.headAtStart;
      if (!moved) {
        if (s.closed) {
          this.sessions.delete(key);
          this.finished.fire({ path: s.path, branch: s.branch, ready: false });
        }
        return false;
      }
      const repo = this.ctl.repo;
      if (!repo) return false;
      const st = await repo.status(s.path);
      if (st.changes > 0 || st.operation) return false; // ainda mexendo: espera a próxima rodada
      let commits = 0;
      if (s.headAtStart) {
        const r = await repo.run(['rev-list', '--count', `${s.headAtStart}..${s.lastHead}`], s.path);
        commits = Number(r.stdout.trim()) || 0;
      }
      this.sessions.delete(key);
      const info: ReadyInfo = { path: s.path, branch: s.branch, at: Date.now(), commits };
      await this.setReady(info);
      this.finished.fire({ path: s.path, branch: s.branch, ready: true });
      this.onReady(info);
      return true;
    } finally {
      this.checking.delete(key);
    }
  }

  /** Força a checagem de uma worktree (ou de todas as acompanhadas). */
  async checkNow(p?: string): Promise<boolean> {
    const keys = p ? [keyOf(p)] : [...this.sessions.keys()];
    let any = false;
    for (const k of keys) any = (await this.check(k, true)) || any;
    return any;
  }

  readyMap(): Record<string, ReadyInfo> {
    return this.ctl.ctx.workspaceState.get<Record<string, ReadyInfo>>(READY_KEY, {});
  }

  readyFor(p: string): ReadyInfo | undefined {
    return this.readyMap()[keyOf(p)];
  }

  private async setReady(info: ReadyInfo) {
    await this.ctl.ctx.workspaceState.update(READY_KEY, { ...this.readyMap(), [keyOf(info.path)]: info });
    this.ctl.scheduleRefresh(20);
  }

  async clearReady(p: string) {
    const m = this.readyMap();
    const k = keyOf(p);
    if (!(k in m)) return;
    delete m[k];
    await this.ctl.ctx.workspaceState.update(READY_KEY, m);
    this.ctl.scheduleRefresh(20);
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.disposables.forEach(d => d.dispose());
  }
}
