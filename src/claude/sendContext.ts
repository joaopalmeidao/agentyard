import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentTerminals, claudeAgentName, OpenAgent } from '../agents';
import type { Controller } from '../controller';
import { runGit } from '../git';
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

export interface DiagnosticLine {
  line: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  source?: string;
}

/**
 * Problemas numa linha só (cada \n viraria um Enter no Claude): `@arq#L3 (error, ts: msg); @arq#L9 (warning: msg)`.
 * Erros primeiro; mensagens longas são cortadas.
 */
export function diagnosticsText(file: string, cwd: string, list: DiagnosticLine[], max = 20): string {
  const order = { error: 0, warning: 1, info: 2 };
  return list
    .slice()
    .sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line)
    .slice(0, max)
    .map(d => {
      const msg = d.message.replace(/\s+/g, ' ').trim();
      const short = msg.length > 200 ? `${msg.slice(0, 199)}…` : msg;
      return `${mentionOf(file, cwd, { start: d.line, end: d.line })} (${d.severity}${d.source ? `, ${d.source}` : ''}: ${short})`;
    })
    .join('; ');
}

/** Worktree que contém o arquivo (a mais funda, se uma estiver dentro da outra). */
export function worktreeOfFile(ctl: Controller, file: string) {
  return ctl.state?.worktrees
    .filter(w => !w.prunable && !w.bare && (file.toLowerCase() + path.sep).startsWith(w.path.toLowerCase() + path.sep))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

/** Texto longo vai para um arquivo temporário, e o Claude recebe a menção dele. */
function contextFile(name: string, text: string): string {
  const dir = path.join(os.tmpdir(), 'worktree-graph-prompts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now().toString(36)}-${name}`);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

/**
 * "Enviar ao Claude": digita a menção do arquivo (e das linhas selecionadas) no Claude aberto na
 * worktree do arquivo, sem apertar Enter, para você completar a mensagem. Sem Claude ali, oferece
 * os de outras worktrees ou abrir um novo. O mesmo caminho manda os problemas do arquivo, o diff da
 * worktree e a seleção de um terminal.
 */
export function registerSendToClaude(ctx: vscode.ExtensionContext, ctl: Controller, agentTerms: AgentTerminals) {
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

  /** Worktree do editor ativo, do terminal ativo ou da janela, nessa ordem. */
  const currentWorktree = () => {
    const file = vscode.window.activeTextEditor?.document.uri;
    if (file?.scheme === 'file') {
      const w = worktreeOfFile(ctl, file.fsPath);
      if (w) return w;
    }
    const term = vscode.window.activeTerminal;
    const opened = term && ((term.creationOptions as vscode.TerminalOptions).cwd as string | vscode.Uri | undefined);
    const cwd = term && (agentTerms.byTerminal(term)?.path ?? (typeof opened === 'string' ? opened : opened?.fsPath));
    const key = (p: string) => path.normalize(p).toLowerCase();
    return (cwd && ctl.state?.worktrees.find(w => key(w.path) === key(cwd))) || ctl.state?.worktrees.find(w => w.isCurrent);
  };

  const severityOf = (s: vscode.DiagnosticSeverity): DiagnosticLine['severity'] =>
    s === vscode.DiagnosticSeverity.Error ? 'error' : s === vscode.DiagnosticSeverity.Warning ? 'warning' : 'info';

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
      const target = await pickTarget(worktreeOfFile(ctl, files[0]));
      if (!target) return;
      const text = files.map(f => mentionOf(f, target.path, lines)).join(' ') + ' ';
      await agentTerms.type(target, text, false);
    }),

    vscode.commands.registerCommand('worktreeGraph.claude.sendDiagnostics', async (uri?: vscode.Uri) => {
      const editor = vscode.window.activeTextEditor;
      const doc = uri instanceof vscode.Uri ? uri : editor?.document.uri;
      if (!doc || doc.scheme !== 'file') {
        vscode.window.showInformationMessage(t('Open a file to send its problems to Claude.'));
        return;
      }
      // com seleção no editor, só os problemas dentro dela
      const sel = editor && editor.document.uri.toString() === doc.toString() && !editor.selection.isEmpty ? editor.selection : undefined;
      const diags = vscode.languages.getDiagnostics(doc).filter(d => !sel || d.range.intersection(sel));
      if (!diags.length) {
        vscode.window.showInformationMessage(t('No problems in {0}.', path.basename(doc.fsPath)));
        return;
      }
      const target = await pickTarget(worktreeOfFile(ctl, doc.fsPath));
      if (!target) return;
      const text = diagnosticsText(
        doc.fsPath,
        target.path,
        diags.map(d => ({ line: d.range.start.line + 1, severity: severityOf(d.severity), message: d.message, source: d.source })),
      );
      await agentTerms.type(target, `${t('Fix these problems:')} ${text} `, false);
    }),

    vscode.commands.registerCommand('worktreeGraph.claude.sendDiff', async (item?: { path?: string }) => {
      const wt = (item?.path && ctl.state?.worktrees.find(w => w.path === item.path)) || currentWorktree();
      if (!wt) {
        vscode.window.showInformationMessage(t('No worktree to take the diff from.'));
        return;
      }
      const { base } = await ctl.base().catch(() => ({ base: '' }));
      // tudo o que a branch mudou desde a base, commitado ou não
      const mb = base ? (await runGit(wt.path, ['merge-base', base, 'HEAD'])).stdout.trim() : '';
      const diff = await runGit(wt.path, ['diff', mb || 'HEAD']);
      if (diff.code !== 0 || !diff.stdout.trim()) {
        vscode.window.showInformationMessage(t('{0} has no changes compared to {1}.', wt.branch ?? wt.name, base || 'HEAD'));
        return;
      }
      const target = await pickTarget(wt);
      if (!target) return;
      const file = contextFile(`${(wt.branch ?? wt.name).replace(/[^\w.-]+/g, '-')}.diff`, diff.stdout);
      await agentTerms.type(target, `${t('Changes in {0} compared to {1}:', wt.branch ?? wt.name, base || 'HEAD')} ${mentionOf(file, target.path)} `, false);
    }),

    vscode.commands.registerCommand('worktreeGraph.claude.sendTerminalSelection', async () => {
      const term = vscode.window.activeTerminal;
      if (!term) return;
      // a API não lê a seleção do terminal: copia pela área de transferência e devolve o que havia nela
      const saved = await vscode.env.clipboard.readText();
      await vscode.env.clipboard.writeText('');
      await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
      const text = await vscode.env.clipboard.readText();
      await vscode.env.clipboard.writeText(saved);
      if (!text.trim()) {
        vscode.window.showInformationMessage(t('Select some text in the terminal to send it to Claude.'));
        return;
      }
      const target = await pickTarget(currentWorktree());
      if (!target) return;
      const file = contextFile('terminal.txt', text);
      await agentTerms.type(target, `${t('Output from the terminal {0}:', term.name)} ${mentionOf(file, target.path)} `, false);
    }),
  );
}
