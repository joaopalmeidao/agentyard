import * as vscode from 'vscode';
import { pushBranch } from '../push';
import type { Controller } from '../controller';
import { ChangeRequest, GitHubClient, GitLabClient, HostClient, HostError, parseRemote, RemoteInfo, suggestBody, suggestTitle } from './core';

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
    this.remote = r.code === 0 ? parseRemote(r.stdout.trim(), this.cfg().get<string[]>('gitlab.hosts', []), this.cfg().get<string[]>('github.hosts', [])) : undefined;
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
    const env = r.kind === 'gitlab' ? process.env.GITLAB_TOKEN : process.env.GITHUB_TOKEN;
    if (env) return env;
    return interactive ? this.askToken(r) : undefined;
  }

  private apiBase(r: RemoteInfo): string | undefined {
    return (r.kind === 'gitlab' ? this.cfg().get<string>('gitlab.apiUrl', '') : this.cfg().get<string>('github.apiUrl', '')) || undefined;
  }

  private makeClient(r: RemoteInfo, token: string): HostClient {
    return r.kind === 'github' ? new GitHubClient(r, token, this.apiBase(r)) : new GitLabClient(r, token, this.apiBase(r));
  }

  async client(interactive: boolean): Promise<HostClient | undefined> {
    const r = await this.detectRemote();
    if (!r) return undefined;
    const t = await this.token(r, interactive);
    this.connected = !!t;
    return t ? this.makeClient(r, t) : undefined;
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
    const where =
      r.kind === 'gitlab'
        ? `${r.webBase}/-/user_settings/personal_access_tokens?name=Worktree%20Graph&scopes=api`
        : `${r.webBase}/settings/tokens`;
    const open = await vscode.window.showInformationMessage(
      `Conectar ao ${r.kind === 'gitlab' ? 'GitLab' : 'GitHub'} em ${r.webBase}`,
      {
        modal: true,
        detail: `Crie um token de acesso pessoal com o escopo ${r.kind === 'gitlab' ? '"api"' : '"repo"'} e cole na próxima tela. Ele fica guardado no cofre de segredos do VS Code, não em arquivos.`,
      },
      'Abrir página de tokens',
      'Já tenho um token',
    );
    if (!open) return undefined;
    if (open === 'Abrir página de tokens') await vscode.env.openExternal(vscode.Uri.parse(where));
    const token = await vscode.window.showInputBox({
      title: `Token de ${r.host}`,
      prompt: `Escopo ${r.kind === 'gitlab' ? 'api' : 'repo'}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (!token) return undefined;
    try {
      const user = await this.makeClient(r, token.trim()).whoami();
      await this.ctl.ctx.secrets.store(this.secretKey(r), token.trim());
      vscode.window.showInformationMessage(`Conectado a ${r.host} como ${user}.`);
      this.connected = true;
      return token.trim();
    } catch (e) {
      vscode.window.showErrorMessage(`O token não funcionou em ${r.host}: ${(e as Error).message}`);
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
      title: 'Conectar ao GitLab',
      prompt: 'Endereço do GitLab (ex.: https://gitlab.empresa.com ou https://empresa.com/gitlab)',
      value: current?.kind === 'gitlab' ? current.webBase : 'https://',
      ignoreFocusOut: true,
      validateInput: v => (/^https?:\/\/[^/\s]+/.test(v.trim()) ? undefined : 'Informe um endereço http(s)://'),
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
        `Salvei ${base}, mas o remoto "${this.cfg().get('remote', 'origin')}" deste repositório não aponta para ${host}. Os PRs/MRs, issues e pipelines usam o remoto do repositório.`,
      );
      return;
    }
    await this.askToken(r);
    await this.refresh(true);
  }

  async connect() {
    const r = await this.detectRemote(true);
    if (!r) {
      const pick = await vscode.window.showWarningMessage(
        'O remoto deste repositório não foi reconhecido como GitHub nem GitLab. Se for um GitLab self-hosted, informe o endereço dele.',
        'Informar URL do GitLab',
        'Abrir configuração',
      );
      if (pick === 'Informar URL do GitLab') return this.connectGitLab();
      if (pick === 'Abrir configuração') vscode.commands.executeCommand('workbench.action.openSettings', 'worktreeGraph.gitlab.hosts');
      return;
    }
    if (r.kind === 'gitlab') return this.connectGitLab();
    if (r.kind === 'github' && r.host === 'github.com') {
      const s = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
      if (s) vscode.window.showInformationMessage(`Conectado ao GitHub como ${s.account.label}.`);
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
    vscode.window.showInformationMessage(`Token de ${r.host} removido.`);
    this.ctl.scheduleRefresh(20);
  }

  private signature() {
    return `${this.connected}|${this.error ?? ''}|${this.remote?.host ?? ''}|${[...this.byBranch.values()].map(p => `${p.ref}${p.state}`).join(',')}`;
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
      vscode.window.showErrorMessage(`Não consegui consultar ${r.host}: ${(e as Error).message}`);
      return;
    }
    if (existing && (existing.state === 'open' || existing.state === 'draft') && (!fixedTarget || existing.target === fixedTarget)) {
      const go = await vscode.window.showInformationMessage(`${branch} já tem o ${L} ${existing.ref}: ${existing.title}`, 'Abrir no navegador', 'Enviar commits novos');
      if (go === 'Abrir no navegador') vscode.env.openExternal(vscode.Uri.parse(existing.url));
      if (go === 'Enviar commits novos') await this.push(branch);
      return;
    }

    const { base } = await this.ctl.base();
    const targets = [base, ...(await repo.refs()).filter(x => x.kind === 'head' && x.name !== base && x.name !== branch).map(x => x.name)];
    const target = fixedTarget
      ? { label: fixedTarget }
      : await vscode.window.showQuickPick(
          targets.map((t, i) => ({ label: t, description: i === 0 ? 'base' : '' })),
          { title: `${L} de ${branch} para…`, placeHolder: base },
        );
    if (!target) return;

    const subjects = (await repo.exec(['log', '--reverse', '--format=%s', `${target.label}..${branch}`])).split(/\r?\n/).filter(Boolean);
    if (!subjects.length) {
      vscode.window.showInformationMessage(`${branch} não tem commits que ${target.label} não tenha.`);
      return;
    }
    const title = await vscode.window.showInputBox({ title: `Título do ${L}`, value: suggestTitle(branch, subjects), ignoreFocusOut: true });
    if (!title) return;
    const kind = await vscode.window.showQuickPick(
      [
        { label: `Criar ${L}`, draft: false, detail: `${subjects.length} commit(s) de ${branch} para ${target.label}` },
        { label: `Criar ${L} como rascunho`, draft: true, detail: 'Não pede revisão ainda' },
      ],
      { title: `${L}: ${title}` },
    );
    if (!kind) return;

    if (!(await this.push(branch))) return;
    try {
      const created = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Criando ${L}…` }, () =>
        client.create({ source: branch, target: target.label, title, body: suggestBody(subjects, L, this.issueTrailers(branch)), draft: kind.draft }),
      );
      this.byBranch.set(branch, created);
      this.ctl.log(`${L} ${created.ref} criado: ${created.url}`);
      this.ctl.scheduleRefresh(20);
      const go = await vscode.window.showInformationMessage(`${L} ${created.ref} criado: ${created.title}`, 'Abrir no navegador', 'Copiar link');
      if (go === 'Abrir no navegador') vscode.env.openExternal(vscode.Uri.parse(created.url));
      if (go === 'Copiar link') vscode.env.clipboard.writeText(created.url);
    } catch (e) {
      const msg = e instanceof HostError && e.status === 422 ? `${(e as Error).message} (a branch pode já ter um ${L}, ou não ter diferença para o destino)` : (e as Error).message;
      vscode.window.showErrorMessage(`Não consegui criar o ${L}: ${msg}`);
    }
  }

  /** git push -u, só se a branch não estiver publicada ou tiver commits locais. */
  /** Push antes de abrir o PR/MR; recusas do remoto seguem o fluxo de src/push.ts. */
  private async push(branch: string): Promise<boolean> {
    return pushBranch(this.ctl, branch, { quiet: true });
  }

}
