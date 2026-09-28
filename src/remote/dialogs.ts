import { AsyncLocalStorage } from 'async_hooks';
import * as vscode from 'vscode';
import { t } from '../i18n';
import type { Hub } from './hub';

/**
 * Diálogos do VS Code no celular. A extensão tem centenas de showQuickPick/showInputBox/show*Message;
 * em vez de mexer em cada um, as funções de vscode.window (o objeto da API desta extensão, não o de
 * outras) passam por aqui:
 * - ação que veio do celular (runAsRemote): o diálogo aparece só na aba que pediu, e avisos sem botão
 *   viram um toast lá;
 * - aviso com botões que o VS Code mostra sozinho (ex.: permissão do Claude) com o celular conectado:
 *   aparece nos dois lugares e vale a primeira resposta.
 */

const origin = new AsyncLocalStorage<{ client: string }>();
let installed: Hub | undefined;

/** A ação em curso veio de uma aba do celular ainda conectada (os diálogos dela vão para lá). */
export function isRemoteAction(): boolean {
  const c = origin.getStore()?.client;
  return !!c && !!installed?.has(c);
}

/** Roda uma ação vinda de uma aba do celular: os diálogos dela vão para essa aba. */
export function runAsRemote<T>(client: string, fn: () => T): T {
  return origin.run({ client }, fn);
}

type Level = 'info' | 'warning' | 'error';

const text = (s: unknown) => (typeof s === 'string' ? s : '');

/** show*Message(message, options?, ...items): separa as opções dos botões. */
function messageArgs(rest: unknown[]): { options?: vscode.MessageOptions; items: (string | vscode.MessageItem)[] } {
  const first = rest[0];
  if (first && typeof first === 'object' && !('title' in (first as object))) return { options: first as vscode.MessageOptions, items: rest.slice(1) as (string | vscode.MessageItem)[] };
  return { items: rest as (string | vscode.MessageItem)[] };
}

const itemLabel = (i: string | vscode.MessageItem) => (typeof i === 'string' ? i : i.title);

export function installRemoteDialogs(hub: Hub): vscode.Disposable {
  const w = vscode.window as unknown as Record<string, (...a: any[]) => any>;
  const saved: Record<string, (...a: any[]) => any> = {};
  installed = hub;
  const patch = (name: string, make: (orig: (...a: any[]) => any) => (...a: any[]) => any) => {
    const orig = w[name];
    saved[name] = orig;
    w[name] = make(orig);
  };
  const remoteClient = () => {
    const c = origin.getStore()?.client;
    return c && hub.has(c) ? c : undefined;
  };

  const message = (level: Level) => (orig: (...a: any[]) => any) =>
    function (this: unknown, msg: string, ...rest: unknown[]) {
      const client = remoteClient();
      const { options, items } = messageArgs(rest);
      const mirror = !client && items.length > 0 && !options?.modal && hub.size > 0;
      if (!client && !mirror) return orig.call(this, msg, ...rest);
      if (client && !items.length) {
        hub.send(client, { type: 'toast', level, message: text(msg), detail: options?.detail });
        return Promise.resolve(undefined);
      }
      const req = hub.request(client, { kind: 'message', level, message: text(msg), detail: options?.detail, modal: !!options?.modal, items: items.map(itemLabel) });
      const remote = req.promise.then(i => (typeof i === 'number' ? items[i] : undefined));
      if (client) return remote;
      // espelho: responde quem chegar primeiro; o botão que sobrar no outro lado não faz nada
      const local = Promise.resolve(orig.call(this, msg, ...rest)).then(v => {
        req.cancel();
        return v;
      });
      return Promise.race([local, remote.then(v => (v === undefined ? local : v))]);
    };
  patch('showInformationMessage', message('info'));
  patch('showWarningMessage', message('warning'));
  patch('showErrorMessage', message('error'));

  patch('showQuickPick', orig =>
    function (this: unknown, items: unknown, options?: vscode.QuickPickOptions, token?: vscode.CancellationToken) {
      const client = remoteClient();
      if (!client) return orig.call(this, items, options, token);
      return (async () => {
        const list = (await items) as (string | vscode.QuickPickItem)[];
        const req = hub.request(client, {
          kind: 'pick',
          title: options?.title,
          placeHolder: options?.placeHolder,
          many: !!options?.canPickMany,
          items: list.map(i =>
            typeof i === 'string'
              ? { label: i }
              : { label: i.label, description: i.description, detail: i.detail, picked: i.picked, separator: i.kind === vscode.QuickPickItemKind.Separator },
          ),
        });
        const sub = token?.onCancellationRequested(() => req.cancel());
        const v = await req.promise;
        sub?.dispose();
        if (options?.canPickMany) return Array.isArray(v) ? v.map(i => list[i]).filter(x => x !== undefined) : undefined;
        return typeof v === 'number' ? list[v] : undefined;
      })();
    },
  );

  patch('showInputBox', orig =>
    function (this: unknown, options?: vscode.InputBoxOptions, token?: vscode.CancellationToken) {
      const client = remoteClient();
      if (!client) return orig.call(this, options, token);
      const req = hub.request(
        client,
        { kind: 'input', title: options?.title, prompt: options?.prompt, value: options?.value, placeHolder: options?.placeHolder, password: !!options?.password },
        async value => {
          if (typeof value !== 'string') return 'Invalid value.';
          const r = await options?.validateInput?.(value);
          if (!r) return undefined;
          // aviso ou informação não impedem de confirmar (como no VS Code)
          if (typeof r === 'string') return r;
          return r.severity === vscode.InputBoxValidationSeverity.Error ? r.message : undefined;
        },
      );
      const sub = token?.onCancellationRequested(() => req.cancel());
      return req.promise.then(v => {
        sub?.dispose();
        return typeof v === 'string' ? v : undefined;
      });
    },
  );

  // ---------- o que a ação abre: link da web abre na aba do celular; editor, diff, terminal e painéis
  // só existem no VS Code do computador (abrem lá) e a aba recebe um aviso, uma vez por ação
  const warned = new WeakSet<object>();
  const desktopOnly = () => {
    const store = origin.getStore();
    const client = remoteClient();
    if (!store || !client || warned.has(store)) return;
    warned.add(store);
    hub.send(client, { type: 'toast', level: 'warning', message: t('This opens only in VS Code on the computer; it was opened there.') });
  };

  const undoOpen = replaceApi('env', 'openExternal', origOpen => function (this: unknown, uri: vscode.Uri, ...rest: unknown[]) {
    const client = remoteClient();
    if (!client) return origOpen.call(this, uri, ...rest);
    const url = uri.toString(true);
    if (/^(https?|mailto):/i.test(url) && !isLocalUrl(url)) {
      hub.send(client, { type: 'open', url });
      return Promise.resolve(true);
    }
    hub.send(client, { type: 'toast', level: 'warning', message: t('This link cannot be opened on the phone: {0}', url) });
    return Promise.resolve(false);
  });

  for (const name of ['showTextDocument', 'createTerminal', 'createWebviewPanel', 'showNotebookDocument']) {
    patch(name, orig =>
      function (this: unknown, ...a: unknown[]) {
        desktopOnly();
        return orig.apply(this, a);
      },
    );
  }

  const undoExec = replaceApi('commands', 'executeCommand', origExec => function (this: unknown, id: string, ...a: unknown[]) {
    if (opensUi(id)) desktopOnly();
    return origExec.call(this, id, ...a);
  });

  return {
    dispose: () => {
      if (installed === hub) installed = undefined;
      for (const [name, fn] of Object.entries(saved)) w[name] = fn;
      undoOpen();
      undoExec();
    },
  };
}

/**
 * Troca uma função de vscode.env/vscode.commands. O VS Code congela vscode.env (Object.freeze):
 * nesse caso o namespace inteiro vira uma cópia que herda o original e só muda essa função (quem
 * chama vscode.env.x lê a propriedade na hora). Se nem isso der, fica como está: não impede a ativação.
 */
function replaceApi(ns: 'env' | 'commands', key: string, make: (orig: (...a: any[]) => any) => (...a: any[]) => any): () => void {
  const api = vscode as unknown as Record<string, Record<string, (...a: any[]) => any>>;
  const target = api[ns];
  const orig = target[key];
  const fn = make(orig);
  try {
    target[key] = fn;
    if (target[key] === fn) return () => void (target[key] = orig);
  } catch {}
  try {
    api[ns] = Object.create(target, { [key]: { value: fn, writable: true, configurable: true, enumerable: true } });
    if (api[ns][key] === fn) return () => void (api[ns] = target);
  } catch {}
  return () => {};
}

/** Endereço desta máquina (localhost, 127.x): no celular não aponta para cá. */
function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h) || h === '0.0.0.0';
  } catch {
    return false;
  }
}

/** Comandos que abrem editor, diff, view ou painel no VS Code (não existem no celular). */
const UI_COMMANDS = new Set([
  'vscode.open',
  'vscode.diff',
  'vscode.changes',
  'vscode.openWith',
  'vscode.openFolder',
  'revealInExplorer',
  'revealFileInOS',
  'markdown.showPreview',
  'markdown.showPreviewToSide',
]);
function opensUi(id: string): boolean {
  return UI_COMMANDS.has(id) || /^workbench\.(view|action\.(open|show|terminal|chat|focus|quickOpen))/.test(id) || /\.(focus|reveal|show)$/.test(id);
}
