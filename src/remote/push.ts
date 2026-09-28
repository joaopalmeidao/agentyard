import type { Controller } from '../controller';
import { t } from '../i18n';
import { ntfyRequest } from './core';

/**
 * Notificação no celular pelo ntfy (`worktreeGraph.remote.ntfyTopic`), junto com a do sistema. O link
 * da notificação é o remote.publicUrl sem o token: o celular já guardou o token ao abrir o link uma vez.
 */
export function pushNotify(ctl: Controller, title: string, body: string) {
  const c = ctl.cfg();
  const topic = c.get<string>('remote.ntfyTopic', '').trim();
  if (!topic) return;
  const pub = c.get<string>('remote.publicUrl', '').trim();
  const req = ntfyRequest(topic, title, body.slice(0, 500), c.get<boolean>('remote.enabled', false) && pub ? pub : undefined);
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
