/**
 * Acesso remoto: o próprio VS Code, pelo Remote Tunnels (vscode.dev/tunnel/…), com editor, terminais,
 * Claude e AgentYard. Aqui só o que não depende do VS Code: reconhecer o link do túnel e o push do ntfy.
 */

/** Link do Remote Tunnels do VS Code (https://vscode.dev/tunnel/<máquina>/<pasta>, ou insiders.vscode.dev). */
export function isTunnelLink(s: string | undefined): boolean {
  return !!s && /^https:\/\/([a-z0-9-]+\.)*vscode\.dev\/tunnel\/[^/\s]+/i.test(s.trim());
}

/**
 * Pedido de publicação no ntfy a partir da URL do tópico (https://ntfy.sh/meu-topico): vai em JSON
 * para a raiz do servidor, que aceita título e texto com acentos (cabeçalhos HTTP não aceitam).
 */
export function ntfyRequest(topicUrl: string, title: string, body: string, click?: string): { url: string; json: Record<string, unknown> } | undefined {
  let u: URL;
  try {
    u = new URL(topicUrl.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
  const parts = u.pathname.split('/').filter(Boolean);
  const topic = parts.pop();
  if (!topic) return undefined;
  const root = `${u.origin}/${parts.join('/')}`.replace(/\/+$/, '') + '/';
  return { url: root, json: { topic, title, message: body, tags: ['robot'], ...(click ? { click } : {}) } };
}
