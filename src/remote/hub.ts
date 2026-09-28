import * as crypto from 'crypto';
import type * as http from 'http';

/**
 * Conexões do celular com a extensão (sem VS Code, testável): cada aba aberta mantém um fluxo de
 * eventos (NDJSON, uma mensagem por linha) e manda as mensagens dela por POST. Os diálogos que a
 * extensão abre para uma ação que veio do celular (confirmação, lista, texto) viram pedidos que ficam
 * esperando a resposta daquela aba.
 */

export type Validate = (value: unknown) => Promise<string | undefined> | string | undefined;

interface Pending {
  /** Aba que recebeu o pedido; sem ela, todas (espelho de um aviso do VS Code). */
  client?: string;
  resolve: (v: unknown) => void;
  validate?: Validate;
  msg: Record<string, unknown>;
}

export interface RemoteRequest {
  id: string;
  promise: Promise<unknown>;
  /** Desiste do pedido (respondido no VS Code, cancelado): fecha o diálogo no celular. */
  cancel(): void;
}

const KEEPALIVE_MS = 15_000;
/** Tempo para a aba reconectar (rede do celular caiu) antes de cancelar os diálogos dela. */
const GRACE_MS = 20_000;

export class Hub {
  private readonly clients = new Map<string, http.ServerResponse>();
  private readonly pending = new Map<string, Pending>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly gone = new Map<string, NodeJS.Timeout>();
  /** Chamado quando uma aba conecta (para mandar o estado atual). */
  onConnect?: (client: string) => void;

  get size() {
    return this.clients.size;
  }

  has(client: string | undefined): boolean {
    return !!client && this.clients.has(client);
  }

  /** Abre o fluxo de eventos de uma aba; uma reconexão da mesma aba substitui a anterior. */
  connect(client: string, res: http.ServerResponse) {
    const old = this.clients.get(client);
    if (old) this.drop(client, old, true);
    clearTimeout(this.gone.get(client));
    this.gone.delete(client);
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    this.clients.set(client, res);
    // mantém o túnel e o proxy sem cortar a conexão parada
    this.timers.set(client, setInterval(() => res.write('\n'), KEEPALIVE_MS).unref());
    res.on('close', () => this.drop(client, res));
    this.write(res, { type: 'hello' });
    // diálogos que esperavam esta aba (ou todas) voltam a aparecer depois de uma reconexão
    for (const p of this.pending.values()) if (!p.client || p.client === client) this.write(res, p.msg);
    this.onConnect?.(client);
  }

  private drop(client: string, res: http.ServerResponse, replaced = false) {
    if (this.clients.get(client) !== res) return;
    this.clients.delete(client);
    clearInterval(this.timers.get(client));
    this.timers.delete(client);
    res.end();
    if (replaced) return;
    // pedidos que só esta aba podia responder, ou espelhos sem mais ninguém: cancelados se ela não voltar
    this.gone.set(
      client,
      setTimeout(() => {
        this.gone.delete(client);
        if (this.clients.has(client)) return;
        for (const [id, p] of this.pending) if (p.client === client || (!p.client && !this.clients.size)) this.settle(id, undefined);
      }, GRACE_MS).unref(),
    );
  }

  private write(res: http.ServerResponse, msg: unknown) {
    res.write(JSON.stringify(msg) + '\n');
  }

  send(client: string, msg: unknown) {
    const res = this.clients.get(client);
    if (res) this.write(res, msg);
  }

  broadcast(msg: unknown) {
    if (!this.clients.size) return;
    const line = JSON.stringify(msg) + '\n';
    for (const res of this.clients.values()) res.write(line);
  }

  /** Mostra um diálogo numa aba (ou em todas) e espera a resposta; sem aba conectada, responde undefined. */
  request(client: string | undefined, dialog: Record<string, unknown>, validate?: Validate): RemoteRequest {
    const id = crypto.randomBytes(8).toString('hex');
    let resolve!: (v: unknown) => void;
    const promise = new Promise<unknown>(r => (resolve = r));
    const target = client && this.clients.has(client) ? client : undefined;
    if (client ? !target : !this.clients.size) resolve(undefined);
    else {
      const msg = { type: 'dialog', id, ...dialog };
      this.pending.set(id, { client: target, resolve, validate, msg });
      if (target) this.send(target, msg);
      else this.broadcast(msg);
    }
    return { id, promise, cancel: () => this.settle(id, undefined) };
  }

  /** Resposta de um diálogo vinda de uma aba; com erro de validação, o diálogo continua aberto. */
  async answer(client: string, id: string, value: unknown): Promise<boolean> {
    const p = this.pending.get(id);
    if (!p || (p.client && p.client !== client)) return false;
    if (value !== undefined && p.validate) {
      const error = await p.validate(value);
      if (error) {
        this.send(client, { type: 'dialogError', id, message: error });
        return false;
      }
    }
    this.settle(id, value);
    return true;
  }

  private settle(id: string, value: unknown) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.resolve(value);
    const msg = { type: 'dialogClose', id };
    if (p.client) this.send(p.client, msg);
    else this.broadcast(msg);
  }

  dispose() {
    for (const t of this.gone.values()) clearTimeout(t);
    this.gone.clear();
    for (const [id] of this.pending) this.settle(id, undefined);
    for (const [client, res] of [...this.clients]) this.drop(client, res);
  }
}
