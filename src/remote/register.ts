import type * as http from 'http';
import * as vscode from 'vscode';
import { stateText } from '../agents';
import { readRegistry } from '../claude/missionControl';
import type { Controller } from '../controller';
import { locale, t } from '../i18n';
import * as core from './core';

const RETRY_MS = 30_000;

function cfg() {
  return vscode.workspace.getConfiguration('worktreeGraph');
}

/** Endereço onde a página abre de fora (remote.publicUrl) ou, sem ele, nesta máquina. */
function baseUrl(): string {
  const pub = cfg().get<string>('remote.publicUrl', '').trim();
  return pub || `http://localhost:${cfg().get<number>('remote.port', 7420)}`;
}

/**
 * Acesso remoto: uma página só leitura com os agentes de todas as janelas, para abrir no celular
 * através de um túnel (Tailscale, portas do VS Code, cloudflared). Uma janela só serve a página: as
 * outras encontram a porta ocupada e tentam de novo quando ela fechar.
 */
class RemoteAccess implements vscode.Disposable {
  private server?: http.Server;
  private retry?: NodeJS.Timeout;
  private serving = '';

  constructor(private readonly ctl: Controller) {}

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
      },
      locale(),
    );
  }

  /** Liga, desliga ou reinicia conforme a configuração. */
  apply() {
    const on = cfg().get<boolean>('remote.enabled', false);
    const host = cfg().get<string>('remote.host', '127.0.0.1').trim() || '127.0.0.1';
    const port = cfg().get<number>('remote.port', 7420);
    const want = on ? `${host}:${port}` : '';
    if (want === this.serving && (this.server || this.retry)) return;
    this.stop();
    if (!on) return;
    this.serving = want;
    const server = core.createRemoteServer({ token: () => core.remoteToken(), state: () => core.remoteState(readRegistry()), page: () => this.page() });
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
    this.server?.close();
    this.server = undefined;
    this.serving = '';
  }

  dispose() {
    this.stop();
  }
}

export function registerRemoteAccess(ctx: vscode.ExtensionContext, ctl: Controller, guard: <T extends unknown[]>(fn: (...a: T) => unknown) => (...a: T) => Promise<void>) {
  const remote = new RemoteAccess(ctl);
  ctx.subscriptions.push(
    remote,
    vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('worktreeGraph.remote') && remote.apply()),
  );
  remote.apply();

  const reg = (id: string, fn: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(`worktreeGraph.${id}`, guard(fn)));

  reg('remote.copyLink', async () => {
    if (!cfg().get<boolean>('remote.enabled', false)) {
      const enable = t('Turn on');
      const pick = await vscode.window.showInformationMessage(
        t('Turn on remote access?'),
        { modal: true, detail: t('AgentYard serves a read-only page with the state of your agents on this machine (port {0}). To open it on your phone, expose that port with a tunnel of your choice, such as Tailscale.', cfg().get<number>('remote.port', 7420)) },
        enable,
      );
      if (pick !== enable) return;
      await cfg().update('remote.enabled', true, vscode.ConfigurationTarget.Global);
    }
    const link = core.remoteLink(baseUrl(), core.remoteToken());
    await vscode.env.clipboard.writeText(link);
    const open = t('Open');
    const settings = t('Settings');
    const hasPublic = !!cfg().get<string>('remote.publicUrl', '').trim();
    const pick = await vscode.window.showInformationMessage(
      hasPublic
        ? t('Remote access link copied. Open it on your phone once; it keeps the access.')
        : t('Remote access link copied (this machine only). To open it on your phone, expose port {0} (e.g. "tailscale serve --bg {0}") and set worktreeGraph.remote.publicUrl.', cfg().get<number>('remote.port', 7420)),
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
