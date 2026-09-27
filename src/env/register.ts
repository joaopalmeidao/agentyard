import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Controller } from '../controller';
import { t } from '../i18n';
import { allocatePort, detectSetup, dirSize, PortsConfig, portVars, rewriteEnv } from './core';

type Guard = <T extends unknown[]>(fn: (...args: T) => unknown) => (...args: T) => Promise<void>;
type Arg = { path?: string; branch?: string } | undefined;

interface SizeEntry {
  bytes: number;
  complete: boolean;
  mtime: number;
}

const k = (p: string) => path.normalize(p).toLowerCase();

/**
 * Ambiente de cada worktree: bloco de portas estável, `.env` copiado da principal com as portas
 * trocadas, setup (instalar ou compartilhar node_modules) e espaço em disco em segundo plano.
 */
export class EnvService implements vscode.Disposable {
  private sizes: Record<string, SizeEntry>;
  private sizing?: Promise<void>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ctl: Controller) {
    this.sizes = ctl.ctx.globalState.get<Record<string, SizeEntry>>('envSizes', {});
    ctl.stateHooks.push(s => {
      const ports = this.portsConfig();
      const assigned = ports ? this.assigned() : {};
      for (const w of s.worktrees) {
        const sz = this.sizes[k(w.path)];
        w.size = sz ? { bytes: sz.bytes, complete: sz.complete } : undefined;
        w.port = ports && w.branch ? assigned[w.branch] : undefined;
      }
      // só calcula o que falta ou mudou; ao terminar, um refresh (o cache evita laço)
      if (this.ctl.cfg().get<boolean>('diskUsage.enabled', true)) void this.computeSizes();
    });
  }

  // ---------- portas e .env ----------

  portsConfig(): PortsConfig | undefined {
    const c = this.ctl.cfg().get<Partial<PortsConfig>>('env.ports');
    if (!c || typeof c.base !== 'number') return undefined;
    return { base: c.base, step: c.step ?? 10, vars: c.vars?.length ? c.vars : ['PORT'] };
  }

  private portsKey() {
    return `envPorts:${this.ctl.repo?.commonDir.toLowerCase() ?? ''}`;
  }

  assigned(): Record<string, number> {
    return this.ctl.ctx.globalState.get<Record<string, number>>(this.portsKey(), {});
  }

  async portFor(branch: string): Promise<number | undefined> {
    const cfg = this.portsConfig();
    if (!cfg) return undefined;
    const r = allocatePort(this.assigned(), branch, cfg);
    await this.ctl.ctx.globalState.update(this.portsKey(), r.assigned);
    return r.port;
  }

  /** Nunca vai para o git: `.env` entra no info/exclude (compartilhado pelas worktrees). */
  private excludeEnv() {
    const repo = this.ctl.repo;
    if (!repo) return;
    const file = path.join(repo.commonDir, 'info', 'exclude');
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      // ainda não existe
    }
    if (text.split(/\r?\n/).some(l => l.trim() === '.env')) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}# ${t('AgentYard: .env per worktree')}\n.env\n`);
  }

  /**
   * Copia `.env` (ou `.env.example`) da principal para a worktree com as portas dela.
   * `.env` que já existe só é alterado com confirmação (ou `overwrite`).
   */
  async configureEnv(wtPath: string, branch: string, opts: { quiet?: boolean; overwrite?: boolean } = {}): Promise<number | undefined> {
    const port = await this.portFor(branch);
    const repo = this.ctl.repo;
    if (!repo) return port;
    const main = (await repo.worktreesFast())[0]?.path ?? repo.root;
    const target = path.join(wtPath, '.env');
    const vars = port !== undefined ? portVars(port, this.portsConfig()!.vars) : {};
    let text: string | undefined;
    if (fs.existsSync(target)) {
      if (!opts.overwrite) {
        if (opts.quiet || !Object.keys(vars).length) return port;
        const ok = await vscode.window.showWarningMessage(
          t('{0} already has a .env. Replace only the port variables ({1})?', path.basename(wtPath), Object.keys(vars).join(', ')),
          { modal: true },
          t('Replace ports'),
        );
        if (!ok) return port;
      }
      text = fs.readFileSync(target, 'utf8');
    } else if (k(main) !== k(wtPath)) {
      for (const f of ['.env', '.env.example']) {
        const src = path.join(main, f);
        if (fs.existsSync(src)) {
          text = fs.readFileSync(src, 'utf8');
          break;
        }
      }
    }
    if (text === undefined && !Object.keys(vars).length) return port;
    this.excludeEnv();
    fs.writeFileSync(target, rewriteEnv(text ?? '', vars));
    this.ctl.log(port !== undefined ? t('.env for {0} with port {1}', branch, port) : t('.env for {0}', branch));
    return port;
  }

  // ---------- setup ----------

  /** Chamado depois de criar a worktree. postCreateCommand, se definido, vence. */
  async afterCreate(dir: string, branch: string, quiet: boolean) {
    if (this.portsConfig()) await this.configureEnv(dir, branch, { quiet: true });
    if (this.ctl.cfg().get<string>('postCreateCommand', '')) return;
    await this.setup(dir, branch, quiet);
  }

  async setup(dir: string, branch: string, quiet: boolean) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return;
    }
    const plan = detectSetup(files);
    if (!plan.node && !plan.python) return;
    const mode = this.ctl.cfg().get<'install' | 'link' | 'ask'>('setup.nodeModules', 'ask');
    const repo = this.ctl.repo;
    const main = repo ? (await repo.worktreesFast())[0]?.path : undefined;
    const mainModules = main ? path.join(main, 'node_modules') : undefined;
    const canLink = !!plan.node && !!mainModules && fs.existsSync(mainModules) && !fs.existsSync(path.join(dir, 'node_modules'));
    const cmds: string[] = [];

    if (plan.node) {
      let choice: string | undefined = mode === 'ask' ? undefined : mode;
      if (mode === 'link' && !canLink) choice = 'install';
      if (!choice && !quiet) {
        const pick = await vscode.window.showQuickPick(
          [
            ...(canLink ? [{ label: t('Share node_modules from the main worktree'), detail: t('Junction/symlink: instant and no extra space; good while the dependencies are the same.'), v: 'link' }] : []),
            { label: t('Install ({0})', plan.node.install), detail: t('In the worktree\'s terminal.'), v: 'install' },
            { label: t('Do nothing'), v: 'skip' },
          ],
          { title: t('Dependencies for {0}', branch) },
        );
        choice = pick?.v;
      }
      if (choice === 'link' && canLink) {
        try {
          fs.symlinkSync(mainModules!, path.join(dir, 'node_modules'), 'junction');
          this.ctl.log(t('node_modules for {0} linked to the main worktree', branch));
        } catch (e) {
          vscode.window.showWarningMessage(t('Couldn\'t link node_modules: {0}', (e as Error).message));
        }
      } else if (choice === 'install') cmds.push(plan.node.install);
    }
    if (plan.python && !quiet) {
      const install = t('Install');
      const ok = await vscode.window.showInformationMessage(t('{0}: create the Python environment ({1})?', branch, plan.python.tool), install, t('Not now'));
      if (ok === install) cmds.push(plan.python.install);
    }
    if (cmds.length) {
      const term = vscode.window.createTerminal({ name: `${branch}: setup`, cwd: dir });
      term.show(true);
      for (const c of cmds) term.sendText(c);
    }
  }

  // ---------- rodar e abrir ----------

  async runDev(arg: Arg) {
    const wt = await this.resolve(arg);
    if (!wt) return;
    const port = wt.branch ? await this.portFor(wt.branch) : undefined;
    const cmd = this.ctl.cfg().get<string>('env.devCommand', '');
    if (!cmd) {
      const go = await vscode.window.showInformationMessage(t('Set the development command (e.g. npm run dev) in worktreeGraph.env.devCommand.'), t('Open settings'));
      if (go) vscode.commands.executeCommand('workbench.action.openSettings', 'worktreeGraph.env.devCommand');
      return;
    }
    const env = port !== undefined ? portVars(port, this.portsConfig()!.vars) : {};
    const term = vscode.window.createTerminal({ name: `${wt.branch ?? path.basename(wt.path)}: dev${port ? ` :${port}` : ''}`, cwd: wt.path, env });
    term.show();
    term.sendText(cmd);
  }

  async openBrowser(arg: Arg) {
    const wt = await this.resolve(arg);
    const port = wt?.branch ? this.assigned()[wt.branch] : undefined;
    if (port === undefined) {
      vscode.window.showInformationMessage(t('This worktree doesn\'t have a port yet. Configure worktreeGraph.env.ports and run "Configure This Worktree\'s Environment".'));
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}`));
  }

  async configureCommand(arg: Arg) {
    const wt = await this.resolve(arg);
    if (!wt?.branch) return;
    const port = this.portsConfig() ? await this.configureEnv(wt.path, wt.branch) : undefined;
    await this.setup(wt.path, wt.branch, false);
    if (port !== undefined) vscode.window.showInformationMessage(t('{0}: port {1}.', wt.branch, port));
    this.ctl.scheduleRefresh(50);
  }

  private async resolve(arg: Arg): Promise<{ path: string; branch?: string } | undefined> {
    const wts = this.ctl.repo ? (await this.ctl.repo.worktreesFast()).filter(w => !w.prunable) : [];
    if (arg?.path) return { path: arg.path, branch: arg.branch ?? wts.find(w => k(w.path) === k(arg.path!))?.branch };
    if (arg?.branch) {
      const w = wts.find(x => x.branch === arg.branch);
      return w ? { path: w.path, branch: w.branch } : undefined;
    }
    const pick = await vscode.window.showQuickPick(wts.map(w => ({ label: w.branch ?? path.basename(w.path), description: w.path, w })), { placeHolder: t('Which worktree?') });
    return pick ? { path: pick.w.path, branch: pick.w.branch } : undefined;
  }

  // ---------- espaço em disco ----------

  /** Uma passada por vez; só as worktrees sem tamanho ou cuja pasta mudou (mtime da raiz). */
  computeSizes(): Promise<void> {
    if (this.sizing) return this.sizing;
    const s = this.ctl.state;
    if (!s) return Promise.resolve();
    const todo = s.worktrees.filter(w => !w.prunable && !w.bare).filter(w => {
      let mtime = 0;
      try {
        mtime = fs.statSync(w.path).mtimeMs;
      } catch {
        return false;
      }
      const c = this.sizes[k(w.path)];
      return !c || c.mtime !== mtime;
    });
    if (!todo.length) return Promise.resolve();
    const budget = this.ctl.cfg().get<number>('diskUsage.secondsPerWorktree', 3) * 1000;
    this.sizing = (async () => {
      for (const w of todo) {
        let mtime = 0;
        try {
          mtime = fs.statSync(w.path).mtimeMs;
        } catch {
          continue;
        }
        const r = await dirSize(w.path, Date.now() + budget);
        this.sizes[k(w.path)] = { ...r, mtime };
      }
      // limpa pastas que não existem mais
      const alive = new Set(this.ctl.state?.worktrees.map(w => k(w.path)) ?? []);
      for (const key of Object.keys(this.sizes)) if (!alive.has(key)) delete this.sizes[key];
      await this.ctl.ctx.globalState.update('envSizes', this.sizes);
    })().finally(() => {
      this.sizing = undefined;
      this.ctl.scheduleRefresh(50);
    });
    return this.sizing;
  }

  async recomputeSizes() {
    this.sizes = {};
    await this.ctl.ctx.globalState.update('envSizes', {});
    await this.computeSizes();
  }

  /** Soma do espaço das worktrees (para "liberaria X" na limpeza). */
  bytesOf(paths: string[]): number {
    return paths.reduce((sum, p) => sum + (this.sizes[k(p)]?.bytes ?? 0), 0);
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
  }
}

let instance: EnvService | undefined;

/** Espaço (bytes) das worktrees; 0 se o serviço não estiver ativo ou ainda não calculou. */
export function bytesOf(paths: string[]): number {
  return instance?.bytesOf(paths) ?? 0;
}

export function registerEnv(ctx: vscode.ExtensionContext, ctl: Controller, guard: Guard): EnvService {
  const env = (instance = new EnvService(ctl));
  const reg = (id: string, fn: (...args: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(`worktreeGraph.${id}`, guard(fn)));
  reg('env.configure', (arg?: Arg) => env.configureCommand(arg));
  reg('env.runDev', (arg?: Arg) => env.runDev(arg));
  reg('env.openBrowser', (arg?: Arg) => env.openBrowser(arg));
  reg('env.refreshSizes', () => env.recomputeSizes());
  ctx.subscriptions.push(env, { dispose: () => (instance = undefined) });
  return env;
}
