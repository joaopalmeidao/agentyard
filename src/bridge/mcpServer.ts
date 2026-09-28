/**
 * Servidor MCP (stdio, JSON-RPC por linha) que o Claude Code sobe. Não depende do VS Code: repassa
 * cada chamada de ferramenta para a janela do AgentYard dona do cwd (ver core.ts).
 * Roda como `node -e` carregando `<home>/bin/agentyard-mcp.js`, ou direto com `node mcpServer.js`.
 */
import * as core from './core';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function send(msg: unknown) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function text(t: string, isError = false) {
  return { content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) };
}

export async function handle(msg: any, cwd = process.cwd()): Promise<unknown | undefined> {
  const { id, method, params } = msg ?? {};
  const reply = (result: unknown) => (id === undefined ? undefined : { jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string) => (id === undefined ? undefined : { jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: core.SERVER_NAME, version: '1' },
        instructions:
          'Ferramentas do AgentYard (extensão do VS Code que organiza worktrees e agentes em paralelo). Use `status` para saber a situação desta worktree, `overlaps` antes de mexer em arquivos que outros agentes podem estar editando, `pr_feedback` e `ci_status` para ver o que a revisão e o CI pediram, e `mark_ready` quando terminar e tiver commitado.',
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: core.TOOLS.map(({ readOnly, ...t }) => ({ ...t, annotations: { readOnlyHint: !!readOnly } })) });
    case 'tools/call': {
      const name = params?.name;
      if (!core.TOOLS.some(t => t.name === name)) return fail(-32602, `Ferramenta desconhecida: ${name}`);
      const bridge = core.findBridge(cwd);
      if (!bridge) {
        return reply(text('O AgentYard não está aberto para este repositório: abra a pasta do repositório (ou uma worktree dele) no VS Code com a extensão ativa.', true));
      }
      try {
        const r = await core.callBridge(bridge, 'tool', { name, args: params?.arguments ?? {}, cwd, agentId: process.env.WTGRAPH_AGENT_ID || undefined });
        return reply(text(typeof r.text === 'string' ? r.text : JSON.stringify(r, null, 2), !!r.isError));
      } catch (e) {
        return reply(text(`Falha ao falar com o AgentYard: ${(e as Error).message}`, true));
      }
    }
    default:
      if (typeof method === 'string' && method.startsWith('notifications/')) return undefined;
      return fail(-32601, `Método não suportado: ${method}`);
  }
}

function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } });
        continue;
      }
      void handle(msg).then(r => r && send(r));
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

// Rodando como servidor (node -e com require, ou node mcpServer.js), não quando importado pelos testes.
if (!process.env.AGENTYARD_NO_MAIN) main();
