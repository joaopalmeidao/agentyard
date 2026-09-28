import * as fs from 'fs';
import type * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { stateText } from '../agents';
import { readRegistry } from '../claude/missionControl';
import type { Controller } from '../controller';
import { type ActionHandler, panelMessage } from '../graphPanel';
import { bundle, locale, t } from '../i18n';
import * as core from './core';
import { installRemoteDialogs, runAsRemote } from './dialogs';
import { Hub } from './hub';
import { panelPage } from './panelPage';

const RETRY_MS = 30_000;

function cfg() {
  return vscode.workspace.getConfiguration('worktreeGraph');
}

/** Acesso pelo celular (host, publicUrl e ntfy); desligado, a página só abre no navegador desta máquina. */
function phone(): boolean {
  return cfg().get<boolean>('remoteAccess.phone', false);
}

const ACCESS_KEYS = ['enabled', 'port', 'host', 'actions', 'publicUrl', 'ntfyTopic'];

/**
 * As settings do acesso remoto eram worktreeGraph.remote.*, que colide com worktreeGraph.remote (o
 * remote git): com elas definidas, a leitura do remote virava um objeto e o push falhava. Move os
 * valores antigos (usuário e workspace) para remoteAccess.* e apaga os antigos.
 */
async function migrateOldSettings() {
  const c = cfg();
  const targets = [
    [vscode.ConfigurationTarget.Global, 'globalValue'],
    [vscode.ConfigurationTarget.Workspace, 'workspaceValue'],
  ] as const;
  for (const k of ACCESS_KEYS) {
    const old = c.inspect(`remote.${k}`);
    if (!old) continue;
    for (const [target, field] of targets) {
      if (old[field] === undefined) continue;
      if (target === vscode.ConfigurationTarget.Workspace && !vscode.workspace.workspaceFolders?.length) continue;
      try {
        if (c.inspect(`remoteAccess.${k}`)?.[field] === undefined) await c.update(`remoteAccess.${k}`, old[field], target);
        await c.update(`remote.${k}`, undefined, target);
      } catch (e) {
        console.warn(`AgentYard: migração de worktreeGraph.remote.${k} falhou`, e);
      }
    }
  }
}

/** Endereço onde a página abre de fora (remoteAccess.publicUrl) ou, sem ele, nesta máquina. */
function baseUrl(): string {
  const pub = phone() ? cfg().get<string>('remoteAccess.publicUrl', '').trim() : '';
  return pub || `http://localhost:${cfg().get<number>('remoteAccess.port', 7420)}`;
}

/** Arquivos do painel que o celular pode baixar (media/). */
const MEDIA: Record<string, string> = { 'graph.js': 'text/javascript; charset=utf-8', 'graph.css': 'text/css; charset=utf-8' };

/**
 * Acesso remoto: a página dos agentes de todas as janelas e o painel principal desta janela, para
 * abrir no celular. Uma janela só serve a página: as outras encontram a porta ocupada e tentam de novo
 * quando ela fechar.
 */
class RemoteAccess implements vscode.Disposable {
  private server?: http.Server;
  private retry?: NodeJS.Timeout;
  private serving = '';
  readonly hub = new Hub();

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly ctl: Controller, private readonly handler: ActionHandler) {}

  private panel(): string {
    return panelPage(
      {
        title: 'AgentYard',
        loading: t('Loading…'),
        offline: t('no connection with VS Code'),
        denied: t('Invalid link: copy it again in VS Code (AgentYard: Remote access: copy link).'),
        noToken: t('Open this page with the link copied in VS Code (AgentYard: Remote access: copy link).'),
        agents: t('Agents'),
        cancel: t('Cancel'),
        ok: t('OK'),
        filter: t('Filter'),
        openLink: t('Open link'),
      },
      { bundle: bundle(), locale: locale() },
    );
  }

  /** Rotas do painel: a página, os arquivos dele, o fluxo de eventos e as mensagens da aba. */
  private async routes(req: http.IncomingMessage, res: http.ServerResponse, url: string, authed: boolean): Promise<boolean> {
    const denied = () => {
      core.sendText(res, 401, 'application/json', JSON.stringify({ error: 'Access denied.' }));
      return true;
    };
    if (req.method === 'GET' && url === '/panel') {
      core.sendText(res, 200, 'text/html; charset=utf-8', this.panel(), {
        'content-security-policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
      });
      return true;
    }
    if (req.method === 'GET' && url.startsWith('/media/')) {
      const name = url.slice('/media/'.length);
      if (!MEDIA[name]) return false;
      core.sendText(res, 200, MEDIA[name], fs.readFileSync(path.join(this.ctx.extensionUri.fsPath, 'media', name)));
      return true;
    }
    if (req.method === 'GET' && url === '/api/events') {
      if (!authed) return denied();
      const client = new URL(req.url ?? '', 'http://x').searchParams.get('c') ?? '';
      if (!/^[a-f0-9]{8,64}$/.test(client)) {
        core.sendText(res, 400, 'text/plain', 'Bad client.');
        return true;
      }
      this.hub.connect(client, res);
      return true;
    }
    if (req.method === 'POST' && url === '/api/msg') {
      if (!authed) return denied();
      const body = await core.readJson(req);
      const client = String(body?.c ?? '');
      const msg = body?.msg;
      core.sendText(res, 204, 'text/plain', '');
      if (!this.hub.has(client) || !msg || typeof msg !== 'object') return true;
      if (msg.type === 'answer') {
        await this.hub.answer(client, String(msg.id), msg.value);
        return true;
      }
      if (msg.type === 'action' && !cfg().get<boolean>('remoteAccess.actions', true)) {
        this.hub.send(client, { type: 'toast', level: 'warning', message: t('Actions from the phone are turned off (worktreeGraph.remoteAccess.actions).') });
        return true;
      }
      // os diálogos que a ação abrir vão para esta aba
      void runAsRemote(client, () => panelMessage(this.ctl, this.handler, msg, m => this.hub.send(client, m), true)).catch(e =>
        this.hub.send(client, { type: 'toast', level: 'error', message: (e as Error).message }),
      );
      return true;
    }
    return false;
  }

  private page(): string {
    return core.remotePage(
      {
        title: 'AgentYard',
        states: { starting: stateText('starting'), working: stateText('working'), waiting: stateText('waiting'), idle: stateText('idle'), ended: stateText('ended') },
        empty: t('No agent open in any VS Code window.'),
        offline: t('no connection with VS Code'),
        denied: t('Invalid link: copy it again in VS Code (AgentYard: Remote access: copy link).'),
        noToken: t('Open this page with the link copied in VS Code (AgentYard: Remote access: copy link).'),
        updated: t('updated {0}'),
        answer: t('answer: {0}'),
        asking: t('asking for permission'),
        review: t('review the changes'),
        yourTurn: t('your turn: send the next message'),
        running: t('let it work'),
        ended: t('close the terminal'),
        waitingCount: t('{0} waiting for you'),
        panel: t('Panel'),
      },
      locale(),
    );
  }

  /** Liga, desliga ou reinicia conforme a configuração. */
  apply() {
    const on = cfg().get<boolean>('remoteAccess.enabled', false);
    // sem o acesso pelo celular, só nesta máquina
    const host = (phone() && cfg().get<string>('remoteAccess.host', '127.0.0.1').trim()) || '127.0.0.1';
    const port = cfg().get<number>('remoteAccess.port', 7420);
    const want = on ? `${host}:${port}` : '';
    if (want === this.serving && (this.server || this.retry)) return;
    this.stop();
    if (!on) return;
    this.serving = want;
    const server = core.createRemoteServer({
      token: () => core.remoteToken(),
      state: () => core.remoteState(readRegistry()),
      page: () => this.page(),
      routes: (req, res, url, authed) => this.routes(req, res, url, authed),
    });
    server.once('error', (e: NodeJS.ErrnoException) => {
      server.close();
      if (this.server === server) this.server = undefined;
      if (e.code === 'EADDRINUSE') {
        // provavelmente outra janela do VS Code já está servindo (a página mostra os agentes de todas)
        this.ctl.log(t('Remote access: port {0} is in use (another VS Code window may be serving it); trying again later.', port));
        this.retry = setTimeout(() => {
          this.retry = undefined;
          this.serving = '';
          this.apply();
        }, RETRY_MS);
      } else this.ctl.log(t('Remote access: the server did not start: {0}', e.message));
    });
    server.listen(port, host, () => {
      this.ctl.log(t('Remote access: listening on {0}:{1}', host, port));
      if (!core.isLoopback(host)) this.ctl.log(t('Remote access: {0} is not a local address; anyone who reaches this port still needs the token, but prefer 127.0.0.1 with a tunnel.', host));
    });
    this.server = server;
  }

  private stop() {
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    this.hub.dispose();
    this.server?.close();
    this.server = undefined;
    this.serving = '';
  }

  dispose() {
    this.stop();
  }
}

export function registerRemoteAccess(ctx: vscode.ExtensionContext, ctl: Controller, guard: <T extends unknown[]>(fn: (...a: T) => unknown) => (...a: T) => Promise<void>, handler: ActionHandler) {
  const remote = new RemoteAccess(ctx, ctl, handler);
  ctx.subscriptions.push(
    remote,
    installRemoteDialogs(remote.hub),
    // o painel aberto no celular acompanha o estado como o do VS Code
    ctl.onDidChange(() => remote.hub.size && remote.hub.broadcast({ type: 'state', state: ctl.state ?? null })),
    vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('worktreeGraph.remoteAccess') && remote.apply()),
  );
  void migrateOldSettings().then(() => remote.apply());

  const reg = (id: string, fn: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(`worktreeGraph.${id}`, guard(fn)));

  reg('remote.copyLink', async () => {
    if (!cfg().get<boolean>('remoteAccess.enabled', false)) {
      const enable = t('Turn on');
      const port = cfg().get<number>('remoteAccess.port', 7420);
      const pick = await vscode.window.showInformationMessage(
        t('Turn on remote access?'),
        {
          modal: true,
          detail: phone()
            ? t('AgentYard serves on this machine (port {0}) a page with your agents and the main panel, where you can act as in VS Code. To open it on your phone, expose that port with a tunnel of your choice, such as Tailscale.', port)
            : t('AgentYard serves on this machine (port {0}) a page with your agents and the main panel, to open in the browser, where you can act as in VS Code.', port),
        },
        enable,
      );
      if (pick !== enable) return;
      await cfg().update('remoteAccess.enabled', true, vscode.ConfigurationTarget.Global);
    }
    const link = core.remoteLink(baseUrl(), core.remoteToken());
    await vscode.env.clipboard.writeText(link);
    const open = t('Open');
    const settings = t('Settings');
    const hasPublic = !!cfg().get<string>('remoteAccess.publicUrl', '').trim();
    const pick = await vscode.window.showInformationMessage(
      !phone()
        ? t('Remote access link copied. Open it in the browser on this machine.')
        : hasPublic
          ? t('Remote access link copied. Open it on your phone once; it keeps the access.')
          : t('Remote access link copied (this machine only). To open it on your phone, expose port {0} (e.g. "tailscale serve --bg {0}") and set worktreeGraph.remoteAccess.publicUrl.', cfg().get<number>('remoteAccess.port', 7420)),
      open,
      settings,
    );
    if (pick === open) await vscode.env.openExternal(vscode.Uri.parse(link));
    else if (pick === settings) await vscode.commands.executeCommand('workbench.action.openSettings', 'worktreeGraph.remote');
  });

  reg('remote.resetToken', async () => {
    const reset = t('Generate new link');
    const pick = await vscode.window.showWarningMessage(t('Generate a new remote access link?'), { modal: true, detail: t('The current link stops working on every device.') }, reset);
    if (pick !== reset) return;
    core.remoteToken(undefined, true);
    await vscode.commands.executeCommand('worktreeGraph.remote.copyLink');
  });
}
