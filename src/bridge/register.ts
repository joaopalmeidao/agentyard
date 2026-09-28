import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import * as actions from '../actions';
import type { AgentTerminals, OpenAgent } from '../agents';
import type { AgentFlow } from '../agentFlow/register';
import { keyOf } from '../agentFlow/head';
import type { Controller } from '../controller';
import type { Coord } from '../coord/register';
import { t } from '../i18n';
import type { WorktreeView } from '../model';
import * as core from './core';

interface Deps {
  agentTerms: AgentTerminals;
  agentFlow: AgentFlow;
  coord: Coord;
}

/** Evento de hook que chega da ponte, já com a worktree e o terminal (quando a extensão abriu o Claude). */
export interface BridgeHookEvent {
  hook_event_name: string;
  cwd: string;
  session_id?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  prompt?: string;
  source?: string;
  permission_mode?: string;
  [k: string]: unknown;
  /** Worktree dona do cwd. */
  worktree?: WorktreeView;
  /** Terminal da extensão que abriu este Claude (pelo WTGRAPH_AGENT_ID). */
  open?: OpenAgent;
}

export type HookHandler = (e: BridgeHookEvent) => Promise<core.HookReply | undefined> | core.HookReply | undefined;

export interface ToolContext {
  cwd: string;
  open?: OpenAgent;
}

export type ToolHandler = (args: Record<string, any>, ctx: ToolContext) => Promise<string | { text: string; isError?: boolean }>;

const BRANCH_RE = /[\s~^:?*[\\]|\.\.|@\{|\/$|^\/|\.lock$/;

/** Saída JSON de um hook (o que o Claude lê no stdout). */
export function hookJson(o: unknown): core.HookReply {
  return { stdout: JSON.stringify(o) };
}

/**
 * Integração com o Claude Code: servidor HTTP local que atende o servidor MCP e os hooks (ver
 * core.ts). Os Claude abertos pela extensão recebem hooks e MCP pela linha de comando; para os
 * abertos fora dela, dá para instalar no projeto.
 *
 * Outras partes da extensão registram o que fazem em cada evento (`onHook`) e ferramentas MCP a
 * mais (`addTool`).
 */
export class ClaudeBridge implements vscode.Disposable {
  private server?: http.Server;
  private info?: core.BridgeInfo;
  private readonly token = crypto.randomBytes(24).toString('hex');
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.changed];
  private readonly events: string[] = [];
  private readonly hooks = new Map<string, HookHandler[]>();
  private readonly tools = new Map<string, ToolHandler>();
  private scriptsOk = false;

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly ctl: Controller, private readonly deps: Deps) {
    this.disposables.push(
      ctl.onDidChange(() => this.announce()),
      vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('worktreeGraph.claude.bridge') && void this.restart()),
    );
    try {
      core.installScripts(path.join(ctx.extensionPath, 'out', 'bridge'));
      this.scriptsOk = true;
    } catch (e) {
      ctl.log(t('Claude integration: could not copy the scripts to {0}: {1}', core.bridgeHome(), (e as Error).message));
    }
    this.registerDefaultTools();
    deps.agentTerms.launchExtras = () => this.launchExtras();
    void this.restart();
  }

  private enabled() {
    return this.ctl.cfg().get<boolean>('claude.bridge', true);
  }

  running() {
    return !!this.info;
  }

  port() {
    return this.info?.port;
  }

  onHook(event: string, fn: HookHandler) {
    this.hooks.set(event, [...(this.hooks.get(event) ?? []), fn]);
  }

  addTool(name: string, fn: ToolHandler) {
    this.tools.set(name, fn);
  }

  /** Hooks e MCP para o Claude que a extensão vai abrir (vazio com a ponte desligada). */
  launchExtras(): { hooks: Record<string, unknown[]>; mcpConfig?: string } | undefined {
    if (!this.enabled() || !this.scriptsOk) return undefined;
    const exe = process.execPath;
    const hooks = core.launchHooks(exe);
    let mcpConfig: string | undefined;
    if (this.ctl.cfg().get<boolean>('claude.mcp', true)) {
      const dir = path.join(this.ctx.globalStorageUri.fsPath, 'claude-events');
      fs.mkdirSync(dir, { recursive: true });
      mcpConfig = path.join(dir, 'agentyard.mcp.json');
      const json = JSON.stringify(core.launchMcpConfig(exe), null, 2);
      let old = '';
      try {
        old = fs.readFileSync(mcpConfig, 'utf8');
      } catch {
        // ainda não existe
      }
      if (old !== json) fs.writeFileSync(mcpConfig, json, 'utf8');
    }
    return { hooks, mcpConfig };
  }

  private async restart() {
    this.stop();
    if (!this.enabled()) return;
    const server = http.createServer((req, res) => void this.onRequest(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    }).catch(e => this.ctl.log(t('Claude integration: the local server did not start: {0}', (e as Error).message)));
    const addr = server.address();
    if (!addr || typeof addr === 'string') return;
    this.server = server;
    this.info = { pid: process.pid, port: addr.port, token: this.token, roots: [], started: Date.now(), version: this.ctx.extension.packageJSON.version };
    this.announce(true);
    this.ctl.log(t('Claude integration: listening on 127.0.0.1:{0}', addr.port));
  }

  private stop() {
    this.server?.close();
    this.server = undefined;
    if (this.info) core.removeBridgeInfo(this.info.pid);
    this.info = undefined;
  }

  /** Atualiza o anúncio com as worktrees do repositório aberto (só reescreve quando mudam). */
  private announce(force = false) {
    if (!this.info) return;
    const roots = [...new Set([...this.worktrees().map(w => w.path), ...(this.ctl.repo ? [this.ctl.repo.root] : [])])];
    const repo = this.ctl.repo?.commonDir;
    if (!force && roots.join('\n') === this.info.roots.join('\n') && repo === this.info.repo) return;
    this.info.roots = roots;
    this.info.repo = repo;
    try {
      core.writeBridgeInfo(this.info);
    } catch (e) {
      this.ctl.log(t('Claude integration: could not announce the window: {0}', (e as Error).message));
    }
  }

  // ------------------------------------------------------------ HTTP

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${this.token}`) return reply(403, { error: 'Access denied.' });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 4_000_000) return reply(413, { error: 'Too large.' });
      chunks.push(c as Buffer);
    }
    let body: any;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      return reply(400, { error: 'Invalid JSON.' });
    }
    try {
      if (req.url === '/ping') return reply(200, { ok: true, repo: this.ctl.state?.repoName });
      if (req.url === '/hook') return reply(200, (await this.dispatchHook(body)) ?? {});
      if (req.url === '/tool') return reply(200, await this.onTool(String(body.name), body.args ?? {}, String(body.cwd ?? ''), body.agentId));
      return reply(404, { error: 'Unknown route.' });
    } catch (e) {
      return reply(200, req.url === '/tool' ? { text: (e as Error).message, isError: true } : {});
    }
  }

  private log(msg: string) {
    this.events.unshift(`${new Date().toLocaleTimeString()} ${msg}`);
    this.events.length = Math.min(this.events.length, 80);
  }

  // ------------------------------------------------------------ worktrees

  worktrees(): WorktreeView[] {
    return (this.ctl.state?.worktrees ?? []).filter(w => !w.bare && !w.prunable);
  }

  /** Worktree dona de um caminho (a de caminho mais longo). */
  worktreeAt(p: string): WorktreeView | undefined {
    if (!p) return undefined;
    return this.worktrees()
      .filter(w => core.isInside(p, w.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
  }

  /** Argumento `worktree` (branch ou caminho) ou, sem ele, a worktree do cwd. */
  resolve(arg: unknown, cwd: string): WorktreeView {
    const a = typeof arg === 'string' ? arg.trim() : '';
    const w = a ? this.worktrees().find(x => x.branch === a || x.name === a || keyOf(x.path) === keyOf(a)) ?? this.worktreeAt(a) : this.worktreeAt(cwd);
    if (!w) throw new Error(a ? `Worktree "${a}" not found. Use list_worktrees.` : `${cwd} is not a worktree of the repository open in AgentYard.`);
    return w;
  }

  private describe(w: WorktreeView): string {
    const parts = [
      `${w.branch ?? '(detached)'} — ${w.path}${w.isMain ? ' (main worktree)' : ''}${w.isBase ? ' (base)' : ''}`,
      w.compareKnown ? `  ${w.ahead} commit(s) ahead and ${w.behind} behind the base` : '  comparison with the base still being computed',
      w.statusKnown ? `  ${w.changes} uncommitted file(s)${w.operation ? ` · ${w.operation} in progress` : ''}` : '',
      w.preview?.conflict ? `  merge with the base predicted to conflict${w.preview.files.length ? ` in: ${w.preview.files.join(', ')}` : ''}` : '',
      w.agents.length ? `  open agents: ${w.agents.join(', ')}` : '',
      w.request ? `  ${w.request.ref} ${w.request.state}: ${w.request.title} (${w.request.url})` : '',
      w.review ? `  ready for review (${w.review.commits} commit(s))` : '',
      w.tasks ? `  queue: ${w.tasks.waiting} waiting${w.tasks.running ? `; running: ${w.tasks.running}` : ''}` : '',
      w.overlap ? `  touches the same ${w.overlap.files} file(s) as: ${w.overlap.with.join(', ')}` : '',
    ];
    return parts.filter(Boolean).join('\n');
  }

  nameOf(p: string) {
    const w = this.worktrees().find(x => keyOf(x.path) === keyOf(p));
    return w?.branch ?? path.basename(p);
  }

  private openById(id: unknown): OpenAgent | undefined {
    return typeof id === 'string' && id ? this.deps.agentTerms.list().find(o => o.id === id) : undefined;
  }

  // ------------------------------------------------------------ hooks

  private async dispatchHook(body: any): Promise<core.HookReply | undefined> {
    const event = String(body?.hook_event_name ?? '');
    const cwd = String(body?.cwd ?? '');
    const open = this.openById(body?.agentId);
    const worktree = (open && this.worktreeAt(open.path)) ?? this.worktreeAt(cwd);
    this.log(`hook ${event}${body?.tool_name ? ` ${body.tool_name}` : ''}${worktree ? ` (${worktree.branch ?? worktree.name})` : ''}`);
    const e: BridgeHookEvent = { ...body, cwd, open, worktree };
    let out: core.HookReply | undefined;
    for (const fn of this.hooks.get(event) ?? []) {
      try {
        const r = await fn(e);
        // o primeiro que responde decide (a guarda vem antes das outras)
        if (r && (r.stdout || r.stderr || r.exit) && !out) out = r;
      } catch (err) {
        this.ctl.log(t('Claude integration: hook {0} failed: {1}', event, (err as Error).message));
      }
    }
    return out;
  }

  // ------------------------------------------------------------ ferramentas

  private registerDefaultTools() {
    const flow = () => this.deps.agentFlow;
    const state = () => {
      const s = this.ctl.state;
      if (!s) throw new Error('AgentYard is still loading the repository; try again in a moment.');
      return s;
    };
    this.addTool('status', async (args, { cwd }) => {
      const s = state();
      return `Repository ${s.repoName}, base ${s.baseRef}.\n${this.describe(this.resolve(args.worktree, cwd))}`;
    });
    this.addTool('list_worktrees', async () => {
      const s = state();
      return `Repository ${s.repoName}, base ${s.baseRef}.\n\n${this.worktrees()
        .map(w => this.describe(w))
        .join('\n\n')}`;
    });
    this.addTool('overlaps', async (args, { cwd }) => {
      const w = this.resolve(args.worktree, cwd);
      await this.deps.coord.recompute();
      const list = this.deps.coord.overlaps.filter(o => keyOf(o.a) === keyOf(w.path) || keyOf(o.b) === keyOf(w.path));
      if (!list.length) return 'No files in common with other active worktrees.';
      return list
        .map(o => {
          const other = keyOf(o.a) === keyOf(w.path) ? o.b : o.a;
          return `With ${this.nameOf(other)} (${other}):\n${o.files.map(f => `  ${f}`).join('\n')}`;
        })
        .join('\n\n');
    });
    this.addTool('list_tasks', async (args, { cwd }) => {
      const w = this.resolve(args.worktree, cwd);
      const q = flow().tasks.queue(w.path);
      if (!q?.tasks.length) return `Empty queue in ${w.branch ?? w.name}.`;
      return q.tasks.map((x, i) => `${i + 1}. [${x.status}] ${x.text}`).join('\n');
    });
    this.addTool('queue_task', async (args, { cwd }) => {
      const text = String(args.text ?? '').trim();
      if (!text) throw new Error('Give the task text.');
      const w = this.resolve(args.worktree, cwd);
      const task = await flow().tasks.add(w.path, w.branch, text);
      const q = flow().tasks.queue(w.path);
      return `Task queued for ${w.branch ?? w.name} (${task?.status === 'running' ? 'already sent to an agent' : `${q?.tasks.filter(x => x.status === 'waiting').length ?? 0} waiting`}).`;
    });
    this.addTool('create_worktree', async args => {
      const branch = String(args.branch ?? '').trim();
      if (!branch || BRANCH_RE.test(branch)) throw new Error(`Invalid branch name: "${branch}".`);
      if (this.worktrees().some(w => w.branch === branch)) throw new Error(`There is already a worktree on branch ${branch}.`);
      const dir = await actions.createWorktree(this.ctl, { branch, startPoint: args.from ? String(args.from) : undefined, quiet: true });
      if (!dir) throw new Error('The worktree was not created.');
      const task = typeof args.task === 'string' ? args.task.trim() : '';
      if (task) await this.deps.agentTerms.launchWithPrompt(dir, branch, task);
      return `Worktree ${branch} created at ${dir}.${task ? ' An agent was opened there with the task.' : ''}`;
    });
    this.addTool('mark_ready', async (args, { cwd, open }) => {
      const w = this.resolve(open?.path, cwd);
      if (w.statusKnown && w.changes > 0) return { text: `There are still ${w.changes} uncommitted file(s) in ${w.branch ?? w.name}. Commit before marking it ready.`, isError: true };
      const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
      if (summary) this.ctl.log(t('Claude marked {0} as ready: {1}', w.branch ?? w.name, summary));
      if (!(await flow().watch.markReady(w.path, w.branch, w.ahead))) {
        return `Not marked yet: AgentYard still has to check ${w.branch ?? w.name} (the checks when you stop, or the automatic review). Finish your turn; if something comes back, fix it.`;
      }
      return `${w.branch ?? w.name} marked as ready for review.`;
    });
    this.addTool('notify', async (args, { cwd, open }) => {
      const message = String(args.message ?? '').trim();
      if (!message) throw new Error('Give the message.');
      const w = this.worktreeAt(open?.path ?? cwd);
      const show = args.level === 'error' ? vscode.window.showErrorMessage : args.level === 'warning' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      const go = t('Show terminal');
      void show(`Claude${w ? ` (${w.branch ?? w.name})` : ''}: ${message}`, ...(w ? [go] : [])).then(p => void (p && w && this.focusAgent(w.path, open)));
      return 'Notification shown.';
    });
  }

  private async onTool(name: string, args: Record<string, any>, cwd: string, agentId?: string): Promise<{ text: string; isError?: boolean }> {
    const fn = this.tools.get(name);
    if (!fn) throw new Error(`Unknown tool: ${name}`);
    this.log(`tool ${name} (${path.basename(cwd)})`);
    const r = await fn(args, { cwd, open: this.openById(agentId) });
    return typeof r === 'string' ? { text: r } : r;
  }

  async focusAgent(p: string, open?: OpenAgent) {
    const term = open?.terminal ?? this.deps.agentTerms.list(p).pop()?.terminal;
    if (term) term.show();
    else await actions.openTerminal(this.ctl, { path: p });
  }

  // ------------------------------------------------------------ instalação no projeto

  projectDir(): string | undefined {
    return this.ctl.state?.worktrees.find(w => w.isMain)?.path ?? this.ctl.repo?.root;
  }

  async setup() {
    const proj = this.projectDir();
    if (!proj) throw new Error(t('No repository open.'));
    const cur = core.integrationStatus(proj);
    if (cur.error) throw new Error(cur.error);
    const fresh = !cur.mcp && !cur.hooks.length && !cur.allowReadOnly;
    const picks = await vscode.window.showQuickPick(
      [
        {
          label: t('MCP server'),
          description: '.mcp.json',
          detail: t('Claude gets AgentYard tools: status, worktrees, file overlap, PR feedback, CI, task queue, create worktree, mark ready, notify.'),
          picked: fresh || cur.mcp,
          id: 'mcp',
        },
        {
          label: t('Hooks'),
          description: '.claude/settings.json',
          detail: t('Worktree guard, session context, permission requests answered in VS Code and checkpoints per turn, also for Claude opened outside AgentYard.'),
          picked: fresh || !!cur.hooks.length,
          id: 'hooks',
        },
        { label: t('Allow the read-only tools'), description: 'permissions.allow', detail: t('status, list_worktrees, overlaps, list_tasks, pr_feedback, ci_status and turn_diff without asking.'), picked: fresh || cur.allowReadOnly, id: 'allow' },
      ],
      { canPickMany: true, title: t('Integrate Claude Code with AgentYard in {0}', path.basename(proj)), placeHolder: t('Project files (versioned): commit them so other worktrees get them.') },
    );
    if (!picks) return;
    const ids = new Set(picks.map(p => p.id));
    if (ids.has('mcp')) core.installMcp(proj);
    else if (cur.mcp) core.uninstallMcp(proj);
    core.configureSettings(proj, { hooks: ids.has('hooks'), allowReadOnly: ids.has('allow') });
    this.changed.fire();
    if (!ids.size) {
      vscode.window.showInformationMessage(t('AgentYard integration removed from {0}.', path.basename(proj)));
      return;
    }
    const node = await hasNode();
    const files = [ids.has('mcp') ? '.mcp.json' : '', ids.has('hooks') || ids.has('allow') ? '.claude/settings.json' : ''].filter(Boolean);
    const msg =
      t('Integration configured in {0}. Commit these files so other worktrees get them. Claude sessions already open need to restart.', files.join(', ')) +
      (node ? '' : ` ${t('Warning: Node.js was not found on the PATH; the project integration runs with `node` (Claude opened by AgentYard does not need it).')}`);
    const openFiles = t('Open files');
    const pick = await (node ? vscode.window.showInformationMessage : vscode.window.showWarningMessage)(msg, openFiles);
    if (pick === openFiles) for (const f of files) await vscode.window.showTextDocument(vscode.Uri.file(path.join(proj, f)), { preview: false });
  }

  async remove() {
    const proj = this.projectDir();
    if (!proj) return;
    const ok = await vscode.window.showWarningMessage(
      t('Remove the AgentYard integration from {0}?', path.basename(proj)),
      { modal: true, detail: t('Removes the "agentyard" server from .mcp.json and the AgentYard hooks and permissions from .claude/settings.json. Everything else stays.') },
      t('Remove'),
    );
    if (!ok) return;
    core.uninstallMcp(proj);
    core.configureSettings(proj, { hooks: false, allowReadOnly: false });
    this.changed.fire();
  }

  /** Diagnóstico: servidor, scripts, hooks dos terminais abertos e últimos eventos. */
  async showStatus() {
    const proj = this.projectDir();
    const st = proj ? core.integrationStatus(proj) : undefined;
    const yes = (b: boolean) => (b ? t('yes') : t('no'));
    const open = this.deps.agentTerms.list().filter(o => o.claude);
    const lines = [
      `# ${t('Claude Code ↔ AgentYard integration')}`,
      '',
      `- ${t('Local server')}: ${this.info ? t('listening on 127.0.0.1:{0} (pid {1})', this.info.port, this.info.pid) : this.enabled() ? t('did not start (see the AgentYard log)') : t('off (worktreeGraph.claude.bridge)')}`,
      `- ${t('Scripts')}: ${path.join(core.bridgeHome(), 'bin')} (${this.scriptsOk ? t('ok') : t('could not copy')})`,
      `- ${t('Hooks and MCP in the Claude opened by AgentYard')}: ${yes(!!this.launchExtras())} · ${t('state')}: ${yes(this.ctl.cfg().get<boolean>('claude.trackState', true))} · MCP: ${yes(this.ctl.cfg().get<boolean>('claude.mcp', true))}`,
      `- ${t('Executable used as node')}: ${process.execPath}`,
      `- ${t('Node.js on the PATH (only for the project integration)')}: ${yes(await hasNode())}`,
      proj ? `- ${t('Project')}: ${proj}` : `- ${t('No repository open.')}`,
      st ? `- ${t('MCP server in .mcp.json')}: ${yes(st.mcp)}` : '',
      st ? `- ${t('Hooks in .claude/settings.json')}: ${st.hooks.length ? st.hooks.join(', ') : t('none')}` : '',
      st?.error ? `- ${t('Error reading the files')}: ${st.error}` : '',
      this.info ? `- ${t('Announced worktrees')}: ${this.info.roots.length}` : '',
      '',
      `## ${t('Open Claude Code terminals')}`,
      '',
      ...(open.length
        ? open.map(o => {
            const events = o.stateAt ? t('last event {0}', new Date(o.stateAt).toLocaleTimeString()) : t('no event received yet');
            return `- ${o.terminal.name}: ${o.state ?? t('without hooks')} · ${events}${o.state === 'starting' && Date.now() - o.started > 30_000 ? ` — ⚠ ${t('the hooks did not answer: check that Claude runs its hooks in Git Bash (Windows) and that the terminal was opened by AgentYard')}` : ''}`;
          })
        : [`- ${t('none')}`]),
      '',
      `## ${t('Latest events')}`,
      '',
      ...(this.events.length ? this.events.map(e => `- ${e}`) : [`- ${t('none')}`]),
    ];
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: lines.filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n') + '\n' });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  dispose() {
    this.stop();
    if (this.deps.agentTerms.launchExtras) this.deps.agentTerms.launchExtras = undefined;
    this.disposables.forEach(d => d.dispose());
  }
}

function hasNode(): Promise<boolean> {
  return new Promise(resolve => execFile('node', ['--version'], { shell: process.platform === 'win32', timeout: 5000 }, err => resolve(!err)));
}

export function registerClaudeBridge(ctx: vscode.ExtensionContext, ctl: Controller, deps: Deps): ClaudeBridge {
  const bridge = new ClaudeBridge(ctx, ctl, deps);
  ctx.subscriptions.push(bridge);
  const reg = (id: string, fn: () => unknown) =>
    ctx.subscriptions.push(
      vscode.commands.registerCommand(`worktreeGraph.claudeIntegration.${id}`, async () => {
        try {
          await fn();
        } catch (e) {
          vscode.window.showErrorMessage(`AgentYard: ${(e as Error).message}`);
        }
      }),
    );
  reg('setup', () => bridge.setup());
  reg('remove', () => bridge.remove());
  reg('status', () => bridge.showStatus());
  return bridge;
}
