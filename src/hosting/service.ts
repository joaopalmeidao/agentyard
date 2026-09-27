import * as vscode from 'vscode';
import { guardChecks } from '../guards';
import { pushBranch } from '../push';
import type { Controller } from '../controller';
import { AzureDevOpsClient } from './azure';
import { bitbucketClient } from './bitbucket';
import { ChangeRequest, GitHubClient, GitLabClient, HostClient, HostError, parseRemote, RemoteInfo, suggestBody, suggestTitle } from './core';
import { hostLabel } from './platforms';
import { t } from '../i18n';

const REFRESH_MS = 120_000;

/** PRs/MRs do remoto, por branch. A lista de abertos é buscada a cada 2 min, não a cada refresh. */
export class RequestService {
  readonly byBranch = new Map<string, ChangeRequest>();
  remote?: RemoteInfo;
  connected = false;
  error?: string;
  private lastFetch = 0;
  private fetching?: Promise<void>;
  private remoteChecked = false;

  constructor(private readonly ctl: Controller) {}

  /** Projeto ativo mudou: remoto, credencial e PRs são outros. */
  reset() {
    this.byBranch.clear();
    this.remote = undefined;
    this.remoteChecked = false;
    this.connected = false;
    this.error = undefined;
    this.lastFetch = 0;
  }

  /** Preenchido pelo serviço de issues: "Closes #12"/"Refs #123" da issue ligada à branch. */
  issueTrailers: (branch: string) => string[] = () => [];

  get label(): 'PR' | 'MR' {
    return this.remote?.kind === 'gitlab' ? 'MR' : 'PR';
  }

  private cfg() {
    return this.ctl.cfg();
  }

  private secretKey(r: RemoteInfo) {
    return `worktreeGraph.token:${r.kind}:${r.host}`;
  }

  async detectRemote(force = false): Promise<RemoteInfo | undefined> {
    if (this.remoteChecked && !force) return this.remote;
    this.remoteChecked = true;
    const repo = this.ctl.repo;
    if (!repo) return (this.remote = undefined);
    const name = this.cfg().get<string>('remote', 'origin');
    const r = await repo.run(['remote', 'get-url', name]);
    this.remote =
      r.code === 0
        ? parseRemote(
            r.stdout.trim(),
            this.cfg().get<string[]>('gitlab.hosts', []),
            this.cfg().get<string[]>('github.hosts', []),
            this.cfg().get<string[]>('bitbucket.hosts', []),
            this.cfg().get<string[]>('azureDevOps.hosts', []),
          )
        : undefined;
    return this.remote;
  }

  /** Token sem perguntar nada (interactive=false) ou pedindo login/token (true). */
  private async token(r: RemoteInfo, interactive: boolean): Promise<string | undefined> {
    const stored = await this.ctl.ctx.secrets.get(this.secretKey(r));
    if (stored) return stored;
    if (r.kind === 'github' && r.host === 'github.com') {
      const s = await vscode.authentication.getSession('github', ['repo'], interactive ? { createIfNone: true } : { silent: true });
      return s?.accessToken;
    }
    const env = {
      github: process.env.GITHUB_TOKEN,
      gitlab: process.env.GITLAB_TOKEN,
      bitbucket: process.env.BITBUCKET_TOKEN,
      azure: process.env.AZURE_DEVOPS_EXT_PAT ?? process.env.AZURE_DEVOPS_TOKEN,
    }[r.kind];
    if (env) return env;
    return interactive ? this.askToken(r) : undefined;
  }

  private apiBase(r: RemoteInfo): string | undefined {
    if (r.kind === 'gitlab') return this.cfg().get<string>('gitlab.apiUrl', '') || undefined;
    if (r.kind === 'github') return this.cfg().get<string>('github.apiUrl', '') || undefined;
    return undefined;
  }

  private makeClient(r: RemoteInfo, token: string): HostClient {
    switch (r.kind) {
      case 'github':
        return new GitHubClient(r, token, this.apiBase(r));
      case 'gitlab':
        return new GitLabClient(r, token, this.apiBase(r));
      case 'bitbucket':
        return bitbucketClient(r, token, this.apiBase(r));
      case 'azure':
        return new AzureDevOpsClient(r, token, this.apiBase(r), fetch, this.cfg().get<string>('azureDevOps.workItemType', 'Task'));
    }
  }

  async client(interactive: boolean): Promise<HostClient | undefined> {
    const r = await this.detectRemote();
    if (!r) return undefined;
    const tok = await this.token(r, interactive);
    this.connected = !!tok;
    return tok ? this.makeClient(r, tok) : undefined;
  }

  /** Cliente sem perguntar nada (para atualizações em segundo plano). */
  clientSilent(): Promise<HostClient | undefined> {
    return this.client(false);
  }

  /** Cliente pedindo login/token se faltar (para ações do usuário). */
  clientInteractive(): Promise<HostClient | undefined> {
    return this.client(true);
  }

  /** Remoto, token e URL da API, para outros clientes REST (ex.: pipelines). */
  async credentials(interactive: boolean): Promise<{ remote: RemoteInfo; token: string; apiBase?: string } | undefined> {
    const r = await this.detectRemote();
    if (!r) return undefined;
    const token = await this.token(r, interactive);
    return token ? { remote: r, token, apiBase: this.apiBase(r) } : undefined;
  }

  /** Pede um token de acesso pessoal, valida e guarda no cofre do VS Code. */
  async askToken(r: RemoteInfo): Promise<string | undefined> {
    const h = tokenHelp(r);
    const openTokens = t('Open tokens page');
    const open = await vscode.window.showInformationMessage(
      t('Connect to {0} at {1}', hostLabel(r.kind), r.webBase),
      {
        modal: true,
        detail: t('{0} It is kept in the VS Code secret storage, not in files.', h.detail),
      },
      openTokens,
      t('I already have a token'),
    );
    if (!open) return undefined;
    if (open === openTokens) await vscode.env.openExternal(vscode.Uri.parse(h.url));
    const token = await vscode.window.showInputBox({
      title: t('Token for {0}', r.host),
      prompt: h.prompt,
      password: true,
      ignoreFocusOut: true,
    });
    if (!token) return undefined;
    try {
      const user = await this.makeClient(r, token.trim()).whoami();
      await this.ctl.ctx.secrets.store(this.secretKey(r), token.trim());
      vscode.window.showInformationMessage(t('Connected to {0} as {1}.', r.host, user));
      this.connected = true;
      return token.trim();
    } catch (e) {
      vscode.window.showErrorMessage(t('The token did not work on {0}: {1}', r.host, (e as Error).message));
      return undefined;
    }
  }

  /**
   * Conectar ao GitLab informando a URL (útil para self-hosted, subcaminho, ou quando o remoto é ssh
   * numa porta/host diferente da web). Salva a URL em worktreeGraph.gitlab.hosts e pede o token.
   */
  async connectGitLab() {
    const current = await this.detectRemote(true);
    const url = await vscode.window.showInputBox({
      title: t('Connect to GitLab'),
      prompt: t('GitLab address (e.g. https://gitlab.company.com or https://company.com/gitlab)'),
      value: current?.kind === 'gitlab' ? current.webBase : 'https://',
      ignoreFocusOut: true,
      validateInput: v => (/^https?:\/\/[^/\s]+/.test(v.trim()) ? undefined : t('Enter an http(s):// address')),
    });
    if (!url) return;
    const base = url.trim().replace(/\/+$/, '');
    const hosts = this.cfg().get<string[]>('gitlab.hosts', []);
    const host = new URL(base).hostname.toLowerCase();
    const others = hosts.filter(h => {
      try {
        return new URL(/^[a-z]+:\/\//i.test(h) ? h : `https://${h}`).hostname.toLowerCase() !== host;
      } catch {
        return true;
      }
    });
    await this.cfg().update('gitlab.hosts', [...others, base], vscode.ConfigurationTarget.Global);
    const r = await this.detectRemote(true);
    if (!r || r.kind !== 'gitlab' || r.host !== host) {
      vscode.window.showWarningMessage(
        t(
          'Saved {0}, but this repository\'s remote "{1}" does not point to {2}. PRs/MRs, issues and pipelines use the repository\'s remote.',
          base,
          this.cfg().get<string>('remote', 'origin'),
          host,
        ),
      );
      return;
    }
    await this.askToken(r);
    await this.refresh(true);
  }

  async connect() {
    const r = await this.detectRemote(true);
    if (!r) {
      const enterUrl = t('Enter GitLab URL');
      const openSettings = t('Open settings');
      const pick = await vscode.window.showWarningMessage(
        t(
          'The remote was not recognized as GitHub, GitLab, Bitbucket or Azure DevOps. If it is a self-hosted GitLab, enter its address; for other self-hosted installations, add the host to worktreeGraph.bitbucket.hosts, azureDevOps.hosts or github.hosts.',
        ),
        enterUrl,
        openSettings,
      );
      if (pick === enterUrl) return this.connectGitLab();
      if (pick === openSettings) vscode.commands.executeCommand('workbench.action.openSettings', 'worktreeGraph.gitlab.hosts');
      return;
    }
    if (r.kind === 'gitlab') return this.connectGitLab();
    if (r.kind === 'github' && r.host === 'github.com') {
      const s = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
      if (s) vscode.window.showInformationMessage(t('Connected to GitHub as {0}.', s.account.label));
    } else {
      await this.askToken(r);
    }
    await this.refresh(true);
  }

  async disconnect() {
    const r = await this.detectRemote();
    if (!r) return;
    await this.ctl.ctx.secrets.delete(this.secretKey(r));
    this.connected = false;
    this.byBranch.clear();
    vscode.window.showInformationMessage(t('Token for {0} removed.', r.host));
    this.ctl.scheduleRefresh(20);
  }

  private signature() {
    return `${this.connected}|${this.error ?? ''}|${this.remote?.host ?? ''}|${[...this.byBranch.values()].map(p => `${p.ref}${p.state}${p.review?.state ?? ''}${p.review?.approvals ?? ''}`).join(',')}`;
  }

  /** Busca os PRs/MRs abertos (no máximo a cada 2 min, salvo force). Não pergunta nada ao usuário. */
  refresh(force = false): Promise<void> {
    if (this.fetching) return this.fetching;
    if (!force && Date.now() - this.lastFetch < REFRESH_MS) return Promise.resolve();
    // Marca antes: sem remoto ou sem credencial, a próxima tentativa também só vem daqui a 2 min.
    this.lastFetch = Date.now();
    const before = this.signature();
    this.fetching = (async () => {
      try {
        const client = await this.client(false);
        if (!client) return;
        const list = await client.listOpen();
        // revisão só dos abertos (rascunhos não pedem revisão), 4 de cada vez
        const open = list.filter(p => p.state === 'open');
        for (let i = 0; i < open.length; i += 4) {
          await Promise.all(
            open.slice(i, i + 4).map(async p => {
              try {
                p.review = await client.reviewStatus(p);
              } catch {
                // sem permissão para ver revisões: fica sem a informação
              }
            }),
          );
        }
        this.byBranch.clear();
        for (const p of list) this.byBranch.set(p.source, p);
        this.error = undefined;
      } catch (e) {
        this.error = (e as Error).message;
        this.ctl.log(`PRs/MRs: ${this.error}`);
      }
    })().finally(() => {
      this.fetching = undefined;
      // Só redesenha se algo mudou; redesenhar sempre gerava um refresh em laço.
      if (this.signature() !== before) this.ctl.scheduleRefresh(20);
    });
    return this.fetching;
  }

  /** Publica a branch (push se preciso) e abre o PR/MR. */
  /** `fixedTarget`: destino já decidido (promoção entre estágios do fluxo). */
  async publish(branch: string, fixedTarget?: string) {
    const repo = this.ctl.repo;
    if (!repo) return;
    const r = await this.detectRemote(true);
    if (!r) return this.connect();
    const client = await this.client(true);
    if (!client) return;
    const L = client.label;

    let existing: ChangeRequest | undefined;
    try {
      existing = await client.findForBranch(branch);
    } catch (e) {
      vscode.window.showErrorMessage(t('Could not query {0}: {1}', r.host, (e as Error).message));
      return;
    }
    if (existing && (existing.state === 'open' || existing.state === 'draft') && (!fixedTarget || existing.target === fixedTarget)) {
      const openBrowser = t('Open in browser');
      const pushNew = t('Push new commits');
      const go = await vscode.window.showInformationMessage(t('{0} already has {1} {2}: {3}', branch, L, existing.ref, existing.title), openBrowser, pushNew);
      if (go === openBrowser) vscode.env.openExternal(vscode.Uri.parse(existing.url));
      if (go === pushNew) await this.push(branch);
      return;
    }

    const { base } = await this.ctl.base();
    const targets = [base, ...(await repo.refs()).filter(x => x.kind === 'head' && x.name !== base && x.name !== branch).map(x => x.name)];
    const target = fixedTarget
      ? { label: fixedTarget }
      : await vscode.window.showQuickPick(
          targets.map((tgt, i) => ({ label: tgt, description: i === 0 ? 'base' : '' })),
          { title: t('{0} from {1} to…', L, branch), placeHolder: base },
        );
    if (!target) return;

    const subjects = (await repo.exec(['log', '--reverse', '--format=%s', `${target.label}..${branch}`])).split(/\r?\n/).filter(Boolean);
    if (!subjects.length) {
      vscode.window.showInformationMessage(t('{0} has no commits that {1} does not have.', branch, target.label));
      return;
    }
    const title = await vscode.window.showInputBox({ title: t('{0} title', L), value: suggestTitle(branch, subjects), ignoreFocusOut: true });
    if (!title) return;
    const kind = await vscode.window.showQuickPick(
      [
        { label: t('Create {0}', L), draft: false, detail: t('{0} commit(s) from {1} to {2}', subjects.length, branch, target.label) },
        { label: t('Create {0} as draft', L), draft: true, detail: t('Does not request review yet') },
      ],
      { title: `${L}: ${title}` },
    );
    if (!kind) return;

    // checagens antes do PR/MR mesmo se a branch já estiver enviada (o push reaproveita o resultado)
    if (!(await guardChecks('push', branch))) return;
    if (!(await this.push(branch))) return;
    try {
      const created = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Creating {0}…', L) }, () =>
        client.create({ source: branch, target: target.label, title, body: suggestBody(subjects, L, this.issueTrailers(branch)), draft: kind.draft }),
      );
      this.byBranch.set(branch, created);
      this.ctl.log(t('{0} {1} created: {2}', L, created.ref, created.url));
      this.ctl.scheduleRefresh(20);
      const openBrowser = t('Open in browser');
      const copyLink = t('Copy link');
      const go = await vscode.window.showInformationMessage(t('{0} {1} created: {2}', L, created.ref, created.title), openBrowser, copyLink);
      if (go === openBrowser) vscode.env.openExternal(vscode.Uri.parse(created.url));
      if (go === copyLink) vscode.env.clipboard.writeText(created.url);
    } catch (e) {
      const msg =
        e instanceof HostError && e.status === 422
          ? t('{0} (the branch may already have a {1}, or have no difference from the target)', (e as Error).message, L)
          : (e as Error).message;
      vscode.window.showErrorMessage(t('Could not create the {0}: {1}', L, msg));
    }
  }

  /** git push -u, só se a branch não estiver publicada ou tiver commits locais. */
  /** Push antes de abrir o PR/MR; recusas do remoto seguem o fluxo de src/push.ts. */
  private async push(branch: string): Promise<boolean> {
    return pushBranch(this.ctl, branch, { quiet: true });
  }

}

/** Onde criar o token e o que colar, por plataforma. */
function tokenHelp(r: RemoteInfo): { url: string; prompt: string; detail: string } {
  switch (r.kind) {
    case 'gitlab':
      return {
        url: `${r.webBase}/-/user_settings/personal_access_tokens?name=Worktree%20Graph&scopes=api`,
        prompt: t('Scope {0}', 'api'),
        detail: t('Create a personal access token with the "{0}" scope and paste it on the next screen.', 'api'),
      };
    case 'bitbucket':
      return r.flavor === 'cloud'
        ? {
            url: 'https://bitbucket.org/account/settings/app-passwords/',
            prompt: t('username:app-password (or email:API token), or a repository access token'),
            detail: t(
              'Use "username:app password" (or "email:API token") with read and write permission on Pull requests, Issues and Pipelines, or a repository access token.',
            ),
          }
        : {
            url: `${r.webBase}/plugins/servlet/access-tokens/manage`,
            prompt: t('HTTP access token (project/repository: write)'),
            detail: t('Create a personal HTTP access token with write permission on the repository.'),
          };
    case 'azure':
      return {
        url: `${r.azure?.collection ?? r.webBase}/_usersSettings/tokens`,
        prompt: t('PAT with Code (read and write), Work Items (read and write) and Build (read and execute)'),
        detail: t('Create a Personal Access Token with the scopes Code (Read & write), Work Items (Read & write) and Build (Read & execute).'),
      };
    default:
      return {
        url: `${r.webBase}/settings/tokens`,
        prompt: t('Scope {0}', 'repo'),
        detail: t('Create a personal access token with the "{0}" scope and paste it on the next screen.', 'repo'),
      };
  }
}
