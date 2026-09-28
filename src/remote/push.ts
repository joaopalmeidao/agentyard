import type { Controller } from '../controller';
import { t } from '../i18n';
import { ntfyRequest } from './core';

/** Onde fica o último link do túnel copiado (destino ao tocar na notificação). */
export const TUNNEL_LINK_KEY = 'remoteAccess.tunnelLink';

/**
 * Notificação no celular pelo ntfy (`worktreeGraph.remoteAccess.ntfyTopic`), junto com a do sistema.
 * Tocar nela abre o VS Code pelo túnel (o último link copiado em Acesso remoto), quando há um.
 */
export function pushNotify(ctl: Controller, title: string, body: string) {
  const topic = ctl.cfg().get<string>('remoteAccess.ntfyTopic', '').trim();
  if (!topic) return;
  const req = ntfyRequest(topic, title, body.slice(0, 500), ctl.ctx.globalState.get<string>(TUNNEL_LINK_KEY) || undefined);
  if (!req) {
    ctl.log(t('Remote access: invalid ntfy topic URL: {0}', topic));
    return;
  }
  fetch(req.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req.json), signal: AbortSignal.timeout(15_000) })
    .then(r => {
      if (!r.ok) ctl.log(t('Remote access: ntfy answered {0}.', r.status));
    })
    .catch(e => ctl.log(t('Remote access: could not send the push notification: {0}', (e as Error).message)));
}
