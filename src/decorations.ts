import * as path from 'path';
import * as vscode from 'vscode';
import { Controller } from './controller';

/**
 * Cores e letras de status do git (M, U, A, D…) nos arquivos das outras worktrees, como o Explorer
 * faz para o workspace. Usa o git status que o detalhamento já rodou; a pasta aberta nesta janela
 * fica de fora porque a extensão Git do VS Code já a decora.
 */
export class WorktreeDecorations implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  /** caminho da worktree (minúsculo, com separador no fim) → arquivo relativo (minúsculo) → código XY */
  private index?: { root: string; files: Map<string, string> }[];

  constructor(private readonly ctl: Controller) {
    ctl.onDidChangeCache(() => {
      this.index = undefined;
      this.emitter.fire(undefined);
    });
  }

  private build() {
    const open = new Set((vscode.workspace.workspaceFolders ?? []).map(f => path.normalize(f.uri.fsPath).toLowerCase()));
    const list: { root: string; files: Map<string, string> }[] = [];
    for (const [wt, st] of this.ctl.cache.statuses) {
      if (!st.files?.length || open.has(wt)) continue;
      const files = new Map<string, string>();
      for (const [code, rel] of st.files) files.set(rel.replace(/\/$/, '').toLowerCase(), code);
      list.push({ root: wt.endsWith(path.sep) ? wt : wt + path.sep, files });
    }
    return list;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') return undefined;
    this.index ??= this.build();
    const p = path.normalize(uri.fsPath).toLowerCase();
    const wt = this.index.find(w => p.startsWith(w.root));
    if (!wt) return undefined;
    const rel = p.slice(wt.root.length).split(path.sep).join('/');
    let code = wt.files.get(rel);
    if (!code) {
      // pasta nova inteira aparece no status como "pasta/": vale para tudo dentro dela
      for (const [f, c] of wt.files) if (c === '??' && rel.startsWith(f + '/')) code = c;
    }
    if (!code) return undefined;
    return decoration(code);
  }
}

function decoration(code: string): vscode.FileDecoration {
  const x = code[0];
  const y = code[1];
  if (code === '??') return deco('U', 'gitDecoration.untrackedResourceForeground', 'Não rastreado');
  if (x === 'U' || y === 'U' || code === 'AA' || code === 'DD') return deco('!', 'gitDecoration.conflictingResourceForeground', 'Em conflito');
  if (x === 'D' || y === 'D') return deco('D', 'gitDecoration.deletedResourceForeground', 'Removido');
  if (x === 'A') return deco('A', 'gitDecoration.addedResourceForeground', 'Adicionado');
  return deco('M', 'gitDecoration.modifiedResourceForeground', x !== ' ' && y === ' ' ? 'Modificado (no índice)' : 'Modificado');
}

function deco(badge: string, color: string, tooltip: string): vscode.FileDecoration {
  const d = new vscode.FileDecoration(badge, tooltip, new vscode.ThemeColor(color));
  d.propagate = true;
  return d;
}
