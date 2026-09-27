import * as path from 'path';
import * as vscode from 'vscode';
import { AgentTerminals, claudeAgentName, OpenAgent } from '../agents';
import type { Controller } from '../controller';
import { t } from '../i18n';

/** `@caminho#L10-20` como o Claude Code entende; relativo ao terminal quando o arquivo está dentro dele. */
export function mentionOf(file: string, cwd: string, lines?: { start: number; end: number }): string {
  const rel = path.relative(cwd, file);
  const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  const ref = (inside ? rel : file).split(path.sep).join('/');
  const range = lines ? (lines.start === lines.end ? `#L${lines.start}` : `#L${lines.start}-${lines.end}`) : '';
  return /\s/.test(ref) ? `@"${ref}"${range}` : `@${ref}${range}`;
}

/** Linhas da seleção (1-based); seleção vazia = arquivo inteiro. Uma seleção que acaba na coluna 0 não pega a última linha. */
export function selectionLines(sel: { start: { line: number }; end: { line: number; character: number }; isEmpty: boolean }) {
  if (sel.isEmpty) return undefined;
  const end = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
  return { start: sel.start.line + 1, end: end + 1 };
}

/**
 * "Enviar ao Claude": digita a menção do arquivo (e das linhas selecionadas) no Claude aberto na
 * worktree do arquivo, sem apertar Enter, para você completar a mensagem. Sem Claude ali, oferece
 * os de outras worktrees ou abrir um novo.
 */
export function registerSendToClaude(ctx: vscode.ExtensionContext, ctl: Controller, agentTerms: AgentTerminals) {
  const worktreeOf = (file: string) =>
    ctl.state?.worktrees
      .filter(w => !w.prunable && !w.bare && (file.toLowerCase() + path.sep).startsWith(w.path.toLowerCase() + path.sep))
      .sort((a, b) => b.path.length - a.path.length)[0];

  const pickTarget = async (wt: { path: string; branch?: string; name: string } | undefined): Promise<OpenAgent | undefined> => {
    const here = wt ? agentTerms.claudeIn(wt.path) : [];
    if (here.length === 1) return here[0];
    const others = agentTerms.claudeIn().filter(o => !here.includes(o));
    type Item = vscode.QuickPickItem & { o?: OpenAgent; open?: boolean };
    const items: Item[] = [
      ...here.map(o => ({ label: `$(terminal) ${o.terminal.name}`, description: agentTerms.describe(o), o })),
      ...(wt && !here.length ? [{ label: `$(add) ${t('Open a Claude in {0}', wt.name)}`, open: true }] : []),
      ...(others.length ? [{ label: t('Other worktrees'), kind: vscode.QuickPickItemKind.Separator } as Item] : []),
      ...others.map(o => ({ label: `$(terminal) ${o.terminal.name}`, description: agentTerms.describe(o), o })),
    ];
    if (!items.length) {
      vscode.window.showInformationMessage(t('No Claude Code open by AgentYard. Open one from the panel or the status bar.'));
      return undefined;
    }
    if (items.length === 1 && items[0].open && wt) return agentTerms.start(wt.path, wt.branch, claudeAgentName(ctl), 'claude');
    const pick = await vscode.window.showQuickPick(items, { placeHolder: t('Send to which Claude?') });
    if (pick?.open && wt) return agentTerms.start(wt.path, wt.branch, claudeAgentName(ctl), 'claude');
    return pick?.o;
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand('worktreeGraph.claude.sendSelection', async (uri?: vscode.Uri, uris?: unknown) => {
      const editor = vscode.window.activeTextEditor;
      // o Explorer manda a lista selecionada no 2º argumento; o menu do editor manda outra coisa
      const fromExplorer = Array.isArray(uris) && uris.length > 0;
      const list: vscode.Uri[] = fromExplorer ? (uris as vscode.Uri[]) : uri instanceof vscode.Uri ? [uri] : editor ? [editor.document.uri] : [];
      const files = list.filter(u => u.scheme === 'file').map(u => u.fsPath);
      if (!files.length) {
        vscode.window.showInformationMessage(t('Open a file (or select one in the Explorer) to send it to Claude.'));
        return;
      }
      // pelo editor: as linhas selecionadas; pelo Explorer: o arquivo inteiro
      const inEditor = !fromExplorer && files.length === 1 && editor?.document.uri.fsPath === files[0];
      const lines = inEditor ? selectionLines(editor!.selection) : undefined;
      const target = await pickTarget(worktreeOf(files[0]));
      if (!target) return;
      const text = files.map(f => mentionOf(f, target.path, lines)).join(' ') + ' ';
      await agentTerms.type(target, text, false);
    }),
  );
}
