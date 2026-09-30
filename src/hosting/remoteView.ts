import * as vscode from 'vscode';
import { t } from '../i18n';

export type SectionKey = 'issues' | 'pipelines' | 'prs';

/** Uma parte da view "Issues, pipelines e PRs": a árvore de antes, pendurada sob uma seção. */
export interface RemoteSection {
  provider: vscode.TreeDataProvider<vscode.TreeItem>;
  /** Diz se o nó veio desta seção (para getChildren/getParent saberem a quem perguntar). */
  owns(n: vscode.TreeItem): boolean;
  /** Resumo ao lado do título da seção (contagens). */
  describe?(): string | undefined;
  /** A view apareceu ou sumiu: cada seção decide se busca de novo. */
  onVisible?(visible: boolean): void;
}

const ORDER: SectionKey[] = ['issues', 'pipelines', 'prs'];
const ICONS: Record<SectionKey, string> = { issues: 'issues', pipelines: 'rocket', prs: 'git-pull-request' };

export class SectionItem extends vscode.TreeItem {
  readonly kind = 'remoteSection';
  constructor(readonly key: SectionKey, description?: string) {
    super(SectionItem.label(key), vscode.TreeItemCollapsibleState.Expanded);
    this.id = `remote:${key}`;
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(ICONS[key]);
    this.contextValue = `remoteSection-${key}`;
  }

  private static label(key: SectionKey) {
    const labels: Record<SectionKey, string> = { issues: t('Issues'), pipelines: t('Pipelines'), prs: t('Pull requests') };
    return labels[key];
  }
}

/** Issues, pipelines e PRs/MRs do remoto numa view só, uma seção para cada. */
export class RemoteView implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly sections = new Map<SectionKey, RemoteSection>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  view?: vscode.TreeView<vscode.TreeItem>;

  add(key: SectionKey, s: RemoteSection) {
    this.sections.set(key, s);
    s.provider.onDidChangeTreeData?.(() => this.emitter.fire());
  }

  /** Cria a view depois que as seções foram registradas. */
  create(ctx: vscode.ExtensionContext) {
    const view = vscode.window.createTreeView('worktreeGraph.remote', { treeDataProvider: this, showCollapseAll: true });
    this.view = view;
    const visible = (v: boolean) => this.sections.forEach(s => s.onVisible?.(v));
    ctx.subscriptions.push(this.emitter, view, view.onDidChangeVisibility(e => visible(e.visible)));
    ctx.subscriptions.push(vscode.commands.registerCommand('worktreeGraph.remote.refresh', () => Promise.all(ORDER.map(k => vscode.commands.executeCommand(`worktreeGraph.${k === 'prs' ? 'pullRequests' : k}.refresh`)))));
    if (view.visible) visible(true);
    return view;
  }

  section(key: SectionKey) {
    return new SectionItem(key, this.sections.get(key)?.describe?.());
  }

  /** Abre a view com a seção à vista. */
  async focus(key: SectionKey) {
    await vscode.commands.executeCommand('worktreeGraph.remote.focus');
    await this.view?.reveal(this.section(key), { expand: true }).then(undefined, () => undefined);
  }

  private ownerOf(n: vscode.TreeItem): [SectionKey, RemoteSection] | undefined {
    for (const e of this.sections) if (e[1].owns(n)) return e;
    return undefined;
  }

  getTreeItem(n: vscode.TreeItem) {
    return n;
  }

  async getChildren(n?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!n) return ORDER.filter(k => this.sections.has(k)).map(k => this.section(k));
    const s = n instanceof SectionItem ? this.sections.get(n.key) : this.ownerOf(n)?.[1];
    return ((await s?.provider.getChildren(n instanceof SectionItem ? undefined : n)) ?? []) as vscode.TreeItem[];
  }

  /** Necessário para view.reveal: o topo de cada seção tem a seção como pai. */
  async getParent(n: vscode.TreeItem): Promise<vscode.TreeItem | undefined> {
    if (n instanceof SectionItem) return undefined;
    const owner = this.ownerOf(n);
    if (!owner) return undefined;
    return ((await owner[1].provider.getParent?.(n)) as vscode.TreeItem | undefined) ?? this.section(owner[0]);
  }
}
