/** Chamada HTTP comum aos clientes REST de hospedagem (JSON por padrão, texto com raw). */
import { HostError } from './core';
import { t } from '../i18n';

type Fetch = typeof fetch;

export async function request(f: Fetch, url: string, init: RequestInit, raw = false): Promise<any> {
  let res: Response;
  try {
    res = await f(url, init);
  } catch (e) {
    throw new HostError(0, t('Could not reach {0}: {1}', new URL(url).host, (e as Error).message));
  }
  const text = await res.text();
  if (!res.ok) {
    let msg: unknown = text || res.statusText;
    try {
      const b = JSON.parse(text);
      // GitHub/GitLab: message/error; Bitbucket: error.message; Azure: message; Jira: errorMessages/errors
      msg =
        (b && (b.message || (b.error && (b.error.message || b.error)) || (Array.isArray(b.errorMessages) && b.errorMessages.length && b.errorMessages.join('; ')) ||
          (b.errors && typeof b.errors === 'object' && !Array.isArray(b.errors) && Object.values(b.errors).join('; ')) ||
          (Array.isArray(b.errors) && b.errors.map((e: any) => e.message || e).join('; ')))) ||
        msg;
    } catch {
      // corpo não é JSON
    }
    throw new HostError(res.status, `${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  if (raw) return text;
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return text;
  }
}

/**
 * Cabeçalho de autenticação a partir do que a pessoa colou:
 *  - "usuario:segredo" → Basic (app password do Bitbucket, e-mail + API token do Jira Cloud)
 *  - ":pat" → Basic com usuário vazio (PAT do Azure DevOps)
 *  - qualquer outra coisa → Bearer
 */
export function authHeader(token: string, basicAlways = false): string {
  const tok = token.trim();
  if (basicAlways) return `Basic ${Buffer.from(tok.includes(':') ? tok : `:${tok}`).toString('base64')}`;
  if (tok.includes(':')) return `Basic ${Buffer.from(tok).toString('base64')}`;
  return `Bearer ${tok}`;
}
