import * as vscode from 'vscode';
import { runGit } from './git';

export const SCHEME = 'wtgraph-git';

/** Conteúdo de um arquivo numa revisão, para o lado esquerdo (ou direito) do diff. */
export class GitShowProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = JSON.parse(uri.query) as { cwd: string; ref: string; path: string };
    if (q.ref === '__empty__') return '';
    const r = await runGit(q.cwd, ['show', `${q.ref}:${q.path}`]);
    return r.code === 0 ? r.stdout : '';
  }
}

export function gitUri(cwd: string, ref: string, relPath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: '/' + relPath.replace(/\\/g, '/'), query: JSON.stringify({ cwd, ref, path: relPath.replace(/\\/g, '/') }) });
}
