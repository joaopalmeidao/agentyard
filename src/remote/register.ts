import * as vscode from 'vscode';
import type { Controller } from '../controller';
import { t } from '../i18n';
import { isTunnelLink } from './core';
import { TUNNEL_LINK_KEY } from './push';

/** Comandos do Remote Tunnels do VS Code (acesso pelo vscode.dev). */
const TUNNEL = {
  turnOn: 'workbench.remoteTunnel.actions.turnOn',
  manage: 'workbench.remoteTunnel.actions.manage',
  copy: 'workbench.remoteTunnel.actions.copyToClipboard',
};
/** Tempo para o túnel conectar depois de ligado (login, download do servidor na 1ª vez). */
const CONNECT_MS = 120_000;

function cfg() {
  return vscode.workspace.getConfiguration('worktreeGraph');
}

const OLD_KEYS = ['enabled', 'port', 'host', 'actions', 'publicUrl', 'ntfyTopic'];

/**
 * As settings do acesso remoto eram worktreeGraph.remote.*, que colide com worktreeGraph.remote (o
 * remote git): com elas definidas, a leitura do remote virava um objeto e o push falhava. Apaga as
 * antigas, levando o ntfyTopic para remoteAccess.ntfyTopic (as outras eram do servidor próprio, que o
 * túnel do VS Code substituiu).
 */
async function migrateOldSettings() {
  const c = cfg();
  const targets = [
    [vscode.ConfigurationTarget.Global, 'globalValue'],
    [vscode.ConfigurationTarget.Workspace, 'workspaceValue'],
  ] as const;
  for (const k of OLD_KEYS) {
    const old = c.inspect(`remote.${k}`);
    if (!old) continue;
    for (const [target, field] of targets) {
      if (old[field] === undefined) continue;
      if (target === vscode.ConfigurationTarget.Workspace && !vscode.workspace.workspaceFolders?.length) continue;
      try {
        if (k === 'ntfyTopic' && c.inspect('remoteAccess.ntfyTopic')?.[field] === undefined) await c.update('remoteAccess.ntfyTopic', old[field], target);
        await c.update(`remote.${k}`, undefined, target);
      } catch (e) {
        console.warn(`AgentYard: migração de worktreeGraph.remote.${k} falhou`, e);
      }
    }
  }
}

/**
 * Link do túnel desta janela, se ele está conectado. O VS Code não expõe o estado do túnel para
 * extensões; o "copiar link" dele só escreve na área de transferência quando está conectado, então a
 * área de transferência é lida antes e depois (e devolvida como estava quando não veio link).
 */
async function tunnelLink(): Promise<string | undefined> {
  const clip = vscode.env.clipboard;
  const before = await clip.readText();
  const marker = `agentyard-tunnel-${Date.now()}`;
  await clip.writeText(marker);
  try {
    await vscode.commands.executeCommand(TUNNEL.copy);
  } catch {
    // comando indisponível (VS Code na web, versão antiga)
  }
  let text = '';
  // a escrita do VS Code não é aguardada pelo comando
  for (let i = 0; i < 5; i++) {
    text = await clip.readText();
    if (text !== marker) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (isTunnelLink(text)) return text.trim();
  await clip.writeText(before);
  return undefined;
}

/** Liga o túnel (o VS Code pede a conta e se vale só nesta sessão ou como serviço) e espera o link. */
async function turnOnTunnel(): Promise<string | undefined> {
  try {
    await vscode.commands.executeCommand(TUNNEL.turnOn);
  } catch (e) {
    vscode.window.showErrorMessage(t('Could not turn on the VS Code remote tunnel: {0}', (e as Error).message));
    return undefined;
  }
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('Waiting for the VS Code remote tunnel to connect…'), cancellable: true },
    async (_p, token) => {
      const end = Date.now() + CONNECT_MS;
      while (!token.isCancellationRequested && Date.now() < end) {
        const link = await tunnelLink();
        if (link) return link;
        await new Promise(r => setTimeout(r, 2000));
      }
      return undefined;
    },
  );
}

/**
 * Acesso remoto: o VS Code inteiro (editor, terminais, Claude, painel do AgentYard) no navegador de
 * qualquer aparelho, pelo Remote Tunnels do VS Code. O login é o da conta GitHub ou Microsoft do túnel.
 */
export function registerRemoteAccess(ctx: vscode.ExtensionContext, ctl: Controller, guard: <T extends unknown[]>(fn: (...a: T) => unknown) => (...a: T) => Promise<void>) {
  void migrateOldSettings();

  const reg = (id: string, fn: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(`worktreeGraph.${id}`, guard(fn)));

  reg('remote.copyLink', async () => {
    if (vscode.env.remoteName === 'tunnel') {
      vscode.window.showInformationMessage(t('This window is already the remote access (VS Code tunnel).'));
      return;
    }
    let link = await tunnelLink();
    if (!link) {
      const enable = t('Turn on');
      const pick = await vscode.window.showInformationMessage(
        t('Turn on remote access?'),
        {
          modal: true,
          detail: t(
            'Remote access uses the VS Code Remote Tunnels: this VS Code opens whole (editor, terminals, Claude and the AgentYard panel) on vscode.dev, in the browser of any device, including the phone. You sign in with GitHub or Microsoft and only that account opens it. VS Code asks next whether it stays on only while this window is open or as a service.',
          ),
        },
        enable,
      );
      if (pick !== enable) return;
      link = await turnOnTunnel();
      if (!link) {
        const manage = t('Manage tunnel');
        if ((await vscode.window.showWarningMessage(t('The VS Code remote tunnel did not connect yet. Check its state in the Accounts menu or in "Remote Tunnels: Manage".'), manage)) === manage)
          await vscode.commands.executeCommand(TUNNEL.manage);
        return;
      }
    }
    await ctx.globalState.update(TUNNEL_LINK_KEY, link);
    await vscode.env.clipboard.writeText(link);
    ctl.log(t('Remote access: {0}', link));
    const open = t('Open');
    const manage = t('Manage tunnel');
    const pick = await vscode.window.showInformationMessage(
      t('Remote access link copied: {0}. Open it on any device signed in with the tunnel account.', link),
      open,
      manage,
    );
    if (pick === open) await vscode.env.openExternal(vscode.Uri.parse(link));
    else if (pick === manage) await vscode.commands.executeCommand(TUNNEL.manage);
  });

  reg('remote.manage', async () => {
    try {
      await vscode.commands.executeCommand(TUNNEL.manage);
    } catch (e) {
      vscode.window.showErrorMessage(t('Could not open the VS Code remote tunnel: {0}', (e as Error).message));
    }
  });
}
