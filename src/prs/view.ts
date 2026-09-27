import * as path from 'path';
import * as vscode from 'vscode';
import { createWorktree } from '../actions';
import type { Controller } from '../controller';
import { gitUri } from '../diff';
import {
  fetchSpecFor,
  GitHubPrBrowser,
  GitLabPrBrowser,
  ListOnlyPrBrowser,
  MergeMethod,
  PrBrowser,
  PrCheck,
  PrComment,
  PrFile,
  PrGroups,
  PullRequestInfo,
  shortText,
} from './core';

const REFRESH_MS = 120_000;
const EMPTY: PrGroups = { mine: [], reviewRequested: [], open: [], recentlyMerged: [] };

function ago(unix: number) {
  if (!unix) return '';
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

/** Busca e guarda os PRs/MRs do remoto do projeto ativo. Não pede login sozinho. */
export class PrService implements vscode.Disposable {
  groups: PrGroups = EMPTY;
  me = '';
  error?: string;
  /** undefined = ainda não sabe; false = sem remoto/credencial. */
  connected?: boolean;
  filter = '';
  private browserOverride?: PrBrowser;
  private cached?: { key: string; browser: PrBrowser };
  private lastFetch = 0;
  private fetching?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly ctl: Controller) {}

  /** Testes: troca o acesso à API por um navegador falso. */
  setBrowser(b: PrBrowser | undefined) {
    this.browserOverride = b;
    this.cached = undefined;
    this.lastFetch = 0;
  }

  async browser(): Promise<PrBrowser | undefined> {
    if (this.browserOverride) return this.browserOverride;
    const cred = await this.ctl.requests.credentials(false);
    if (!cred) {
      // Bitbucket/Azure: o cliente geral já sabe listar
      const client = await this.ctl.requests.clientSilent();
      return client ? new ListOnlyPrBrowser(client) : undefined;
    }
    const key = `${cred.remote.kind}|${cred.remote.webBase}|${cred.remote.projectPath}|${cred.token.length}`;
    if (this.cached?.key === key) return this.cached.browser;
    let b: PrBrowser | undefined;
    if (cred.remote.kind === 'github') b = new GitHubPrBrowser(cred.remote, cred.token, cred.apiBase);
    else if (cred.remote.kind === 'gitlab') b = new GitLabPrBrowser(cred.remote, cred.token, cred.apiBase);
    else {
      const client = await this.ctl.requests.clientSilent();
      b = client ? new ListOnlyPrBrowser(client) : undefined;
    }
    if (b) this.cached = { key, browser: b };
    return b;
  }

  private signature() {
    const g = this.groups;
    return [this.connected, this.error, ...[g.mine, g.reviewRequested, g.open, g.recentlyMerged].map(l => l.map(p => `${p.ref}${p.state}${p.review?.state ?? ''}${p.updatedAt}`).join(','))].join('|');
  }

  /** Busca de novo no máximo a cada 2 min (salvo force). Só avisa a view se algo mudou. */
  refresh(force = false): Promise<void> {
    if (this.fetching) return this.fetching;
    if (!force && Date.now() - this.lastFetch < REFRESH_MS) return Promise.resolve();
    this.lastFetch = Date.now();
    const before = this.signature();
    this.fetching = (async () => {
      try {
        const b = await this.browser();
        this.connected = !!b;
        if (!b) {
          this.groups = EMPTY;
          this.error = undefined;
          return;
        }
        if (!this.me) this.me = await b.whoami().catch(() => '');
        this.groups = await b.groups(this.me);
        this.error = undefined;
      } catch (e) {
        this.error = (e as Error).message;
        this.ctl.log(`PRs: ${this.error}`);
      }
    })().finally(() => {
      this.fetching = undefined;
      if (this.signature() !== before) this.changed.fire();
    });
    return this.fetching;
  }

  /** Atualiza a cada 2 min enquanto a view estiver visível. */
  setVisible(v: boolean) {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!v) return;
    void this.refresh();
    this.timer = setInterval(() => vscode.window.state.focused && void this.refresh(), REFRESH_MS);
  }

  resetForProject() {
    this.cached = undefined;
    this.me = '';
    this.groups = EMPTY;
    this.connected = undefined;
    this.lastFetch = 0;
    this.changed.fire();
  }

  all(): PullRequestInfo[] {
    const seen = new Map<string, PullRequestInfo>();
    for (const p of [...this.groups.open, ...this.groups.recentlyMerged]) seen.set(p.ref, p);
    return [...seen.values()];
  }

  find(ref: string) {
    return this.all().find(p => p.ref === ref || String(p.id) === ref.replace(/^[#!]/, ''));
  }

  matches(p: PullRequestInfo) {
    const q = this.filter.toLowerCase();
    return !q || `${p.ref} ${p.title} ${p.author} ${p.source} ${p.target}`.toLowerCase().includes(q);
  }

  /** Worktree local da branch do PR (ou da pr/N de um fork), se houver. */
  worktreeOf(p: PullRequestInfo) {
    const names = [p.source, `pr/${p.id}`, `mr/${p.id}`];
    return this.ctl.state?.worktrees.find(w => w.branch && names.includes(w.branch) && !w.prunable);
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.changed.dispose();
  }
}

// ---------------------------------------------------------------- árvore

type Node = GroupItem | PrItem | DetailGroupItem | DetailItem | ActionItem;

class ActionItem extends vscode.TreeItem {
  readonly kind = 'action';
  constructor(label: string, command: string, icon: string, tooltip?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = { command, title: label };
    this.tooltip = tooltip;
  }
}

class GroupItem extends vscode.TreeItem {
  readonly kind = 'group';
  constructor(readonly key: keyof PrGroups, label: string, readonly prs: PullRequestInfo[], expanded: boolean) {
    super(label, prs.length ? (expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None);
    this.id = `prs:${key}`;
    this.description = String(prs.length);
    this.iconPath = new vscode.ThemeIcon({ mine: 'account', reviewRequested: 'eye', open: 'git-pull-request', recentlyMerged: 'git-merge' }[key]);
  }
}

const REVIEW: Record<string, [string, string]> = {
  approved: ['✓ aprovado', 'testing.iconPassed'],
  changes: ['✎ mudanças pedidas', 'list.errorForeground'],
  discussions: ['💬 conversas abertas', 'list.warningForeground'],
  commented: ['💬 comentado', 'textLink.foreground'],
  pending: ['◷ aguardando revisão', 'descriptionForeground'],
};

export class PrItem extends vscode.TreeItem {
  readonly kind = 'pr';
  constructor(readonly pr: PullRequestInfo, group: string, hasWorktree: boolean, ci?: { status: string; name: string }, canExpand = true) {
    super(`${pr.ref} ${pr.title}`, canExpand ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.id = `pr:${group}:${pr.ref}`;
    const parts: string[] = [];
    if (hasWorktree) parts.push('▣');
    if (pr.state === 'draft') parts.push('rascunho');
    if (pr.state === 'merged') parts.push(`mesclado ${ago(pr.mergedAt ?? 0)}`);
    else if (pr.review) parts.push(REVIEW[pr.review.state]?.[0] ?? pr.review.state);
    if (ci) parts.push({ success: '✓ CI', failed: '✗ CI', running: '⟳ CI' }[ci.status] ?? `CI ${ci.status}`);
    if (pr.conflicts) parts.push('⚠ conflito');
    parts.push(`${pr.author}`, `${pr.source} → ${pr.target}`);
    if (pr.state !== 'merged' && pr.updatedAt) parts.push(ago(pr.updatedAt));
    this.description = parts.filter(Boolean).join(' · ');
    const icon = pr.state === 'merged' ? 'git-merge' : pr.state === 'draft' ? 'git-pull-request-draft' : 'git-pull-request';
    const color = pr.state === 'merged' ? 'charts.purple' : pr.review ? REVIEW[pr.review.state]?.[1] : undefined;
    this.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    this.contextValue = ['pr', pr.state, hasWorktree ? 'wt' : 'nowt', pr.fork ? 'fork' : ''].filter(Boolean).join('-');
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${pr.ref} ${pr.title}**\n\n${pr.author} · \`${pr.source}\` → \`${pr.target}\`${pr.fork ? ' (fork)' : ''}\n\n`);
    if (pr.review) md.appendMarkdown(`Revisão: ${REVIEW[pr.review.state]?.[0] ?? pr.review.state}${pr.review.by.length ? ` (${pr.review.by.join(', ')})` : ''}\n\n`);
    if (pr.reviewers.length) md.appendMarkdown(`Revisores pedidos: ${pr.reviewers.join(', ')}\n\n`);
    if (ci) md.appendMarkdown(`CI: ${ci.name} — ${ci.status}\n\n`);
    if (pr.conflicts) md.appendMarkdown('⚠ Conflito com o destino\n\n');
    md.appendMarkdown(`[Abrir no navegador](${pr.url})`);
    this.tooltip = md;
  }
}

class DetailGroupItem extends vscode.TreeItem {
  readonly kind = 'detail-group';
  constructor(readonly pr: PullRequestInfo, readonly what: 'files' | 'checks' | 'comments', label: string, icon: string) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `pr-detail:${pr.ref}:${what}`;
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

class DetailItem extends vscode.TreeItem {
  readonly kind = 'detail';
  constructor(label: string, description: string, icon: vscode.ThemeIcon, command?: vscode.Command, tooltip?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = icon;
    this.command = command;
    this.tooltip = tooltip;
  }
}

const openUrl = (url?: string): vscode.Command | undefined => (url ? { command: 'vscode.open', title: 'Abrir', arguments: [vscode.Uri.parse(url)] } : undefined);

export class PrTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly svc: PrService, private readonly ctl: Controller) {
    svc.onDidChange(() => this.emitter.fire());
    ctl.onDidChange(() => this.emitter.fire());
  }

  fire() {
    this.emitter.fire();
  }

  getTreeItem(n: Node) {
    return n;
  }

  private static readonly LABELS: Record<keyof PrGroups, string> = {
    mine: 'Meus',
    reviewRequested: 'Pedem minha revisão',
    open: 'Abertos',
    recentlyMerged: 'Mesclados (7 dias)',
  };

  group(key: keyof PrGroups) {
    const g = this.svc.groups;
    const expanded = key === 'mine' || key === 'reviewRequested' || (key === 'open' && !g.mine.length && !g.reviewRequested.length);
    return new GroupItem(key, PrTreeProvider.LABELS[key], g[key].filter(p => this.svc.matches(p)), expanded);
  }

  /** Necessário para view.reveal: PR → grupo; detalhes → PR. */
  getParent(n: Node): Node | undefined {
    if (n instanceof PrItem) return this.group(n.id!.split(':')[1] as keyof PrGroups);
    if (n instanceof DetailGroupItem) return this.item(n.pr, 'open');
    return undefined;
  }

  private ci(p: PullRequestInfo) {
    const x = this.ctl.state?.pipelines?.[p.source];
    return x ? { status: x.status, name: x.name } : undefined;
  }

  item(p: PullRequestInfo, group: string, b?: PrBrowser) {
    const canExpand = !b || b.can.files || b.can.checks || b.can.comments;
    return new PrItem(p, group, !!this.svc.worktreeOf(p), this.ci(p), canExpand);
  }

  async getChildren(n?: Node): Promise<Node[]> {
    const s = this.svc;
    if (!n) {
      if (s.connected === undefined) {
        void s.refresh();
        return [new ActionItem('Carregando…', 'worktreeGraph.pullRequests.refresh', 'loading~spin')];
      }
      if (!s.connected) {
        return [new ActionItem('Conectar ao GitHub/GitLab…', 'worktreeGraph.connectHosting', 'plug', 'Para listar os PRs/MRs do remoto deste projeto')];
      }
      const out: Node[] = [];
      if (s.error) out.push(new ActionItem(`Erro: ${s.error}`, 'worktreeGraph.pullRequests.refresh', 'error', 'Clique para tentar de novo'));
      if (s.filter) out.push(new ActionItem(`Filtro: "${s.filter}" (limpar)`, 'worktreeGraph.pullRequests.clearFilter', 'filter'));
      out.push(this.group('mine'), this.group('reviewRequested'), this.group('open'), this.group('recentlyMerged'));
      return out;
    }
    if (n instanceof GroupItem) {
      const b = await s.browser();
      return n.prs.map(p => this.item(p, n.key, b));
    }
    if (n instanceof PrItem) {
      const b = await s.browser();
      if (!b) return [];
      const out: Node[] = [];
      if (b.can.files) out.push(new DetailGroupItem(n.pr, 'files', 'Arquivos', 'files'));
      if (b.can.checks) out.push(new DetailGroupItem(n.pr, 'checks', 'Checks', 'checklist'));
      if (b.can.comments) out.push(new DetailGroupItem(n.pr, 'comments', 'Comentários recentes', 'comment-discussion'));
      return out;
    }
    if (n instanceof DetailGroupItem) {
      const b = await s.browser();
      if (!b) return [];
      try {
        if (n.what === 'files') {
          const files = await b.files(n.pr);
          n.description = String(files.length);
          return files.map(
            (f: PrFile) =>
              new DetailItem(
                path.basename(f.path),
                `${path.dirname(f.path) === '.' ? '' : path.dirname(f.path)}  +${f.additions} −${f.deletions}`,
                new vscode.ThemeIcon({ added: 'diff-added', removed: 'diff-removed', renamed: 'diff-renamed', modified: 'diff-modified', other: 'file' }[f.status]),
                { command: 'worktreeGraph.pullRequests.openFileDiff', title: 'Diff', arguments: [n.pr.ref, f.path, f.status] },
                f.path,
              ),
          );
        }
        if (n.what === 'checks') {
          const checks = await b.checks(n.pr);
          if (!checks.length) return [new DetailItem('Nenhum check', '', new vscode.ThemeIcon('circle-slash'))];
          const icon: Record<PrCheck['status'], vscode.ThemeIcon> = {
            success: new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed')),
            failed: new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed')),
            running: new vscode.ThemeIcon('sync~spin'),
            pending: new vscode.ThemeIcon('clock'),
            skipped: new vscode.ThemeIcon('debug-step-over'),
            other: new vscode.ThemeIcon('question'),
          };
          return checks.map(c => new DetailItem(c.name, c.status, icon[c.status], openUrl(c.url)));
        }
        const comments = await b.comments(n.pr);
        if (!comments.length) return [new DetailItem('Sem comentários', '', new vscode.ThemeIcon('comment'))];
        return comments.map(
          (c: PrComment) =>
            new DetailItem(`${c.author}: ${shortText(c.body, 90)}`, `${c.path ? `${c.path} · ` : ''}${ago(c.at)}`, new vscode.ThemeIcon('comment'), openUrl(c.url), c.body),
        );
      } catch (e) {
        return [new DetailItem(`Erro: ${(e as Error).message}`, '', new vscode.ThemeIcon('error'))];
      }
    }
    return [];
  }
}

// ---------------------------------------------------------------- ações

type PrArg = PrItem | { pr?: PullRequestInfo; ref?: string } | string | undefined;

export function registerPullRequests(ctx: vscode.ExtensionContext, ctl: Controller, guard: <T extends unknown[]>(fn: (...a: T) => unknown) => (...a: T) => Promise<void>) {
  const svc = new PrService(ctl);
  const tree = new PrTreeProvider(svc, ctl);
  const view = vscode.window.createTreeView('worktreeGraph.pullRequests', { treeDataProvider: tree, showCollapseAll: true });
  ctx.subscriptions.push(svc, view, view.onDidChangeVisibility(e => svc.setVisible(e.visible)));
  if (view.visible) svc.setVisible(true);
  svc.onDidChange(() => {
    const n = svc.groups.reviewRequested.length;
    view.badge = n ? { value: n, tooltip: `${n} PR(s)/MR(s) pedem sua revisão` } : undefined;
    view.message = undefined;
  });
  ctl.onDidChangeRepo?.(() => svc.resetForProject());

  const prOf = async (arg: PrArg): Promise<PullRequestInfo | undefined> => {
    if (arg instanceof PrItem) return arg.pr;
    if (typeof arg === 'string') return svc.find(arg);
    if (arg && typeof arg === 'object' && 'pr' in arg && arg.pr) return arg.pr;
    if (arg && typeof arg === 'object' && 'ref' in arg && arg.ref) return svc.find(arg.ref);
    await svc.refresh();
    const pick = await vscode.window.showQuickPick(
      svc.all().map(p => ({ label: `${p.ref} ${p.title}`, description: `${p.author} · ${p.source} → ${p.target}`, p })),
      { placeHolder: 'Qual PR/MR?', matchOnDescription: true },
    );
    return pick?.p;
  };

  /** Traz a branch do PR para o repositório local e abre (ou cria) a worktree dela. */
  const bring = async (p: PullRequestInfo, open = true): Promise<string | undefined> => {
    const repo = ctl.repo;
    if (!repo) return undefined;
    const existing = svc.worktreeOf(p);
    if (existing) {
      if (open) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(existing.path), { forceNewWindow: true });
      return existing.path;
    }
    const b = await svc.browser();
    const remote = ctl.cfg().get<string>('remote', 'origin');
    const { refspec, localBranch } = fetchSpecFor(p, b?.kind ?? 'github');
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Trazendo ${p.ref} (${p.source})…` }, () =>
      repo.run(['fetch', remote, refspec], repo.root, 300_000),
    );
    if (r.code !== 0) {
      vscode.window.showErrorMessage(`Não consegui trazer ${p.ref}: ${(r.stderr || r.stdout).trim()}`);
      return undefined;
    }
    const hasLocal = (await repo.run(['rev-parse', '--verify', '--quiet', `refs/heads/${localBranch}`])).code === 0;
    if (!hasLocal) await repo.exec(['branch', '--track', localBranch, `${remote}/${localBranch}`]);
    const dir = await createWorktree(ctl, { existing: localBranch, quiet: true });
    ctl.scheduleRefresh(50);
    tree.fire();
    if (dir && open) {
      // sem await: o comando termina quando a worktree existe; a pergunta fica na notificação
      void vscode.window.showInformationMessage(`${p.ref} está na worktree ${localBranch}.`, 'Abrir em nova janela', 'Abrir terminal').then(go => {
        if (go === 'Abrir em nova janela') vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir), { forceNewWindow: true });
        if (go === 'Abrir terminal') vscode.window.createTerminal({ name: localBranch, cwd: dir }).show();
      });
    }
    return dir;
  };

  const localBranchOf = async (p: PullRequestInfo): Promise<string | undefined> => {
    const wt = svc.worktreeOf(p);
    if (wt?.branch) return wt.branch;
    const go = await vscode.window.showInformationMessage(`${p.ref} ainda não está no repositório local.`, 'Trazer para uma worktree');
    if (!go) return undefined;
    await bring(p, false);
    await ctl.refresh();
    return svc.worktreeOf(p)?.branch;
  };

  const reg = (id: string, fn: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(`worktreeGraph.pullRequests.${id}`, guard(fn)));

  reg('refresh', () => svc.refresh(true));
  reg('filter', async () => {
    const q = await vscode.window.showInputBox({ title: 'Filtrar PRs/MRs', prompt: 'Número, título, autor ou branch', value: svc.filter });
    if (q === undefined) return;
    svc.filter = q.trim();
    tree.fire();
  });
  reg('clearFilter', () => {
    svc.filter = '';
    tree.fire();
  });
  reg('openBrowser', async (arg: PrArg) => {
    const p = await prOf(arg);
    if (p) await vscode.env.openExternal(vscode.Uri.parse(p.url));
  });
  reg('copyLink', async (arg: PrArg) => {
    const p = await prOf(arg);
    if (p) {
      await vscode.env.clipboard.writeText(p.url);
      vscode.window.setStatusBarMessage(`Link de ${p.ref} copiado`, 2500);
    }
  });
  reg('openWorktree', async (arg: PrArg) => {
    const p = await prOf(arg);
    if (p) await bring(p, true);
  });
  reg('bringWorktree', async (arg: PrArg) => {
    const p = await prOf(arg);
    if (p) await bring(p, true);
  });
  reg('reviewWithAgent', async (arg: PrArg) => {
    const p = await prOf(arg);
    const b = p && (await localBranchOf(p));
    if (b) await vscode.commands.executeCommand('worktreeGraph.reviewWithAgent', b);
  });
  reg('analyzeMerge', async (arg: PrArg) => {
    const p = await prOf(arg);
    const b = p && (await localBranchOf(p));
    if (p && b) await vscode.commands.executeCommand('worktreeGraph.analyzeMerge', b, p.target);
  });
  reg('reviewFiles', async (arg: PrArg) => {
    const p = await prOf(arg);
    if (!p) return;
    const b = await svc.browser();
    if (!b?.can.files) {
      await vscode.env.openExternal(vscode.Uri.parse(p.url));
      return;
    }
    const files = await b.files(p);
    const pick = await vscode.window.showQuickPick(
      files.map(f => ({ label: path.basename(f.path), description: `${path.dirname(f.path) === '.' ? '' : path.dirname(f.path)}  +${f.additions} −${f.deletions}`, f })),
      { placeHolder: `${p.ref}: ${files.length} arquivo(s)`, matchOnDescription: true },
    );
    if (pick) await vscode.commands.executeCommand('worktreeGraph.pullRequests.openFileDiff', p.ref, pick.f.path, pick.f.status);
  });
  /** Diff do arquivo contra o ponto em comum com o destino; sem os commits locais, abre no navegador. */
  reg('openFileDiff', async (ref: string, file: string, status: PrFile['status']) => {
    const p = svc.find(ref);
    const repo = ctl.repo;
    if (!p || !repo) return;
    const remote = ctl.cfg().get<string>('remote', 'origin');
    const wt = svc.worktreeOf(p);
    const candidates = [wt?.branch, `${remote}/${p.source}`, `pr/${p.id}`, `mr/${p.id}`, p.headSha].filter(Boolean) as string[];
    let head: string | undefined;
    for (const c of candidates) if ((await repo.run(['rev-parse', '--verify', '--quiet', `${c}^{commit}`])).code === 0) {
      head = c;
      break;
    }
    const target = (await repo.run(['rev-parse', '--verify', '--quiet', `${remote}/${p.target}^{commit}`])).code === 0 ? `${remote}/${p.target}` : p.target;
    const mb = head ? (await repo.run(['merge-base', target, head])).stdout.trim() : '';
    if (!head || !mb) {
      const b = await svc.browser();
      await vscode.env.openExternal(vscode.Uri.parse(`${p.url}${b?.kind === 'gitlab' ? '/diffs' : '/files'}`));
      return;
    }
    const left = status === 'added' ? gitUri(repo.root, '__empty__', file) : gitUri(repo.root, mb, file);
    const right = status === 'removed' ? gitUri(repo.root, '__empty__', file) : wt ? vscode.Uri.file(path.join(wt.path, file)) : gitUri(repo.root, head, file);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(file)} (${p.ref})`, { preview: true });
  });
  reg('merge', async (arg: PrArg) => {
    const p = await prOf(arg);
    const b = await svc.browser();
    if (!p || !b) return;
    if (!b.can.merge) {
      await vscode.env.openExternal(vscode.Uri.parse(p.url));
      return;
    }
    const method = ctl.cfg().get<MergeMethod>('pullRequests.mergeMethod', 'merge');
    const ci = ctl.state?.pipelines?.[p.source];
    const warnings = [
      p.state === 'draft' ? 'é um rascunho' : '',
      p.review?.state !== 'approved' ? `não está aprovado (${REVIEW[p.review?.state ?? 'pending']?.[0] ?? 'sem revisão'})` : '',
      ci && ci.status !== 'success' ? `o último CI está "${ci.status}"` : '',
      p.conflicts ? 'tem conflito com o destino' : '',
    ].filter(Boolean);
    const ok = await vscode.window.showWarningMessage(
      `Mesclar ${p.ref} "${p.title}" em ${p.target} pelo ${b.kind === 'gitlab' ? 'GitLab' : 'GitHub'}?`,
      {
        modal: true,
        detail: [`Método: ${method}.`, warnings.length ? `Atenção: ${warnings.join('; ')}.` : 'Aprovado e sem pendências conhecidas.'].join('\n'),
      },
      warnings.length ? 'Mesclar mesmo assim' : 'Mesclar',
    );
    if (!ok) return;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Mesclando ${p.ref}…` }, () => b.merge(p, method));
      vscode.window.showInformationMessage(`${p.ref} mesclado em ${p.target}.`);
      await svc.refresh(true);
      void ctl.requests.refresh(true);
    } catch (e) {
      vscode.window.showErrorMessage(`O servidor recusou o merge de ${p.ref}: ${(e as Error).message}`);
    }
  });
  const draft = async (arg: PrArg, value: boolean) => {
    const p = await prOf(arg);
    const b = await svc.browser();
    if (!p || !b?.can.draft) return;
    try {
      await b.setDraft(p, value);
      vscode.window.showInformationMessage(value ? `${p.ref} virou rascunho.` : `${p.ref} está pronto para revisão.`);
      await svc.refresh(true);
    } catch (e) {
      vscode.window.showErrorMessage(`Não consegui alterar ${p.ref}: ${(e as Error).message}`);
    }
  };
  reg('ready', (arg: PrArg) => draft(arg, false));
  reg('draft', (arg: PrArg) => draft(arg, true));
  /** Chip de PR no painel: foca a view no PR. */
  reg('reveal', async (ref: string) => {
    await vscode.commands.executeCommand('worktreeGraph.pullRequests.focus');
    await svc.refresh();
    const p = svc.find(ref);
    if (!p) return;
    const g = (['mine', 'reviewRequested', 'open', 'recentlyMerged'] as (keyof PrGroups)[]).find(k => svc.groups[k].some(x => x.ref === p.ref)) ?? 'open';
    const b = await svc.browser();
    try {
      await view.reveal(tree.item(p, g, b), { select: true, focus: true, expand: false });
    } catch {
      // grupo fechado: a view já está em foco
    }
  });

  return { svc, tree, view };
}
