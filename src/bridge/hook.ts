/**
 * Hook do Claude Code: lê o evento (JSON no stdin), repassa para a janela do AgentYard dona do cwd e
 * devolve ao Claude o que ela respondeu (stdout, stderr, código de saída). Nunca atrapalha o Claude:
 * sem janela, sem resposta ou com erro, sai com 0 sem escrever nada.
 *
 * Os Claude abertos pela extensão rodam este script com `--launched` (ver launchHooks em core.ts);
 * o hook instalado no projeto fica quieto nesses terminais para o evento não chegar duas vezes.
 */
import * as core from './core';

function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function main() {
  let reply: core.HookReply = {};
  try {
    const launched = process.argv.includes('--launched');
    if (!launched && process.env.WTGRAPH_BRIDGE === '1') return;
    const payload = JSON.parse((await readStdin()) || '{}');
    const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
    const bridge = core.findBridge(cwd);
    if (bridge) {
      const event = String(payload.hook_event_name ?? '');
      reply = (await core.callBridge(bridge, 'hook', { ...payload, cwd, agentId: process.env.WTGRAPH_AGENT_ID || undefined }, core.hookWaitMs(event))) ?? {};
    }
  } catch {
    /* a extensão é opcional para o Claude */
  }
  if (reply.stdout) process.stdout.write(reply.stdout);
  if (reply.stderr) process.stderr.write(reply.stderr);
  process.exitCode = typeof reply.exit === 'number' ? reply.exit : 0;
}

void main().finally(() => setTimeout(() => process.exit(), 10).unref());
