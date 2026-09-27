import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { commitDetails } from './commits';
import { Controller } from './controller';
import { bundle, locale, t } from './i18n';

export type ActionHandler = (action: string, args: Record<string, string>) => Promise<void>;

export class GraphPanel implements vscode.Disposable {
  private static current?: GraphPanel;
  private readonly disposables: vscode.Disposable[] = [];

  /** Usado pelo roteiro do vídeo (test/suite.js) para simular interações dentro do painel. */
  static demo(msg: unknown) {
    GraphPanel.current?.panel.webview.postMessage({ type: 'demo', ...(msg as object) });
  }

  static show(ctl: Controller, handler: ActionHandler) {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('worktreeGraph', 'AgentYard', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctl.ctx.extensionUri, 'media')],
    });
    GraphPanel.current = new GraphPanel(panel, ctl, handler);
  }

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly ctl: Controller, handler: ActionHandler) {
    panel.iconPath = vscode.Uri.joinPath(ctl.ctx.extensionUri, 'media', 'icon.svg');
    panel.webview.html = this.html();
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      ctl.onDidChange(s => {
        this.post();
        if (s) panel.title = `AgentYard · ${s.repoName}`;
      }),
      panel.onDidChangeViewState(e => e.webviewPanel.visible && ctl.scheduleRefresh(50)),
      panel.webview.onDidReceiveMessage(async msg => {
        if (msg.type === 'commitDetails') {
          try {
            const details = await commitDetails(ctl, msg.sha);
            panel.webview.postMessage({ type: 'commitDetails', sha: msg.sha, details });
          } catch (e) {
            panel.webview.postMessage({ type: 'commitDetails', sha: msg.sha, error: (e as Error).message });
          }
          return;
        }
        if (msg.type === 'saveUi') {
          await ctl.ctx.globalState.update('panelUi', msg.ui);
          return;
        }
        if (msg.type === 'ready') {
          panel.webview.postMessage({ type: 'ui', ui: ctl.ctx.globalState.get('panelUi') ?? null });
          this.post();
          ctl.scheduleRefresh(50);
          return;
        }
        if (msg.type !== 'action') return;
        panel.webview.postMessage({ type: 'busy', busy: true });
        try {
          await handler(msg.action, msg.args ?? {});
        } catch (e) {
          vscode.window.showErrorMessage((e as Error).message);
        } finally {
          panel.webview.postMessage({ type: 'busy', busy: false });
        }
      }),
    );
  }

  private post() {
    this.panel.webview.postMessage({ type: 'state', state: this.ctl.state ?? null });
  }

  private html(): string {
    const w = this.panel.webview;
    const media = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.ctl.ctx.extensionUri, 'media', f));
    const nonce = crypto.randomBytes(16).toString('base64');
    // traduções do webview: o graph.js usa window.__L10N (sem nada, fica em inglês)
    const l10n = JSON.stringify({ bundle: bundle(), locale: locale() }).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html lang="${locale()}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${w.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('graph.css')}">
<title>AgentYard</title>
</head>
<body data-vscode-context='{"preventDefaultContextMenuItems": true}'>
<div id="app"><div class="empty">${t('Loading…')}</div></div>
<script nonce="${nonce}">window.__L10N = ${l10n};</script>
<script nonce="${nonce}" src="${media('graph.js')}"></script>
</body>
</html>`;
  }

  dispose() {
    GraphPanel.current = undefined;
    this.disposables.forEach(d => d.dispose());
    this.panel.dispose();
  }
}
