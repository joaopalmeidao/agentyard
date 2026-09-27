import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { Controller } from './controller';

export type ActionHandler = (action: string, args: Record<string, string>) => Promise<void>;

export class GraphPanel implements vscode.Disposable {
  private static current?: GraphPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(ctl: Controller, handler: ActionHandler) {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('worktreeGraph', 'Worktree Graph', vscode.ViewColumn.Active, {
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
      ctl.onDidChange(() => this.post()),
      panel.onDidChangeViewState(e => e.webviewPanel.visible && ctl.scheduleRefresh(50)),
      panel.webview.onDidReceiveMessage(async msg => {
        if (msg.type === 'ready') {
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
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${w.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('graph.css')}">
<title>Worktree Graph</title>
</head>
<body data-vscode-context='{"preventDefaultContextMenuItems": true}'>
<div id="app"><div class="empty">Carregando…</div></div>
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
