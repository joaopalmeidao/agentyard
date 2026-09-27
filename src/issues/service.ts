import * as vscode from 'vscode';
import { createWorktree, openTerminal } from '../actions';
import type { Controller } from '../controller';
import { hostLabel } from '../hosting/platforms';
import { DEFAULT_ISSUE_PROMPT, Issue, IssueProvider, IssueScope, issueBranch, issueTrailer, RedmineClient, renderPrompt } from './core';
import { JiraAuth, JiraClient } from './jira';
import { t } from '../i18n';

const REFRESH_MS = 180_000;
const MAX_BODY = 6000;

export interface IssueGroup {
  provider: IssueProvider;
  /** "GitHub · dono/repo", "GitLab · git.empresa.com", "Redmine · redmine.empresa.com". */
  title: string;
  issues: Issue[];
  error?: string;
  /** Provedor reconhecido, mas sem credencial: a view mostra "Conectar". */
  needsConnect?: boolean;
}

interface IssueLink {
  provider: IssueProvider;
  id: number | string;
  key: string;
  title: string;
  url: string;
}

/** Issues do remoto do repositório e do Redmine. Busca a cada 3 min, ou quando pedido. */
export class IssueService implements vscode.Disposable {
  groups: IssueGroup[] = [];
  private lastFetch = 0;
  private fetching?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly ctl: Controller) {
    this.timer = setInterval(() => vscode.window.state.focused && this.refresh(), REFRESH_MS);
    vscode.commands.executeCommand('setContext', 'worktreeGraph.issuesScope', this.scope);
  }

  get scope(): IssueScope {
    return this.ctl.ctx.workspaceState.get<IssueScope>('issuesScope', 'mine');
  }

  async setScope(s: IssueScope) {
    await this.ctl.ctx.workspaceState.update('issuesScope', s);
    vscode.commands.executeCommand('setContext', 'worktreeGraph.issuesScope', s);
    await this.refresh(true);
  }

  private redmineProjectKey() {
    return `redmine.projectId:${this.ctl.repo?.commonDir.toLowerCase() ?? ''}`;
  }

  /** Configuração explícita tem precedência; senão, o projeto escolhido ao conectar. */
  private redmineProject(): string | undefined {
    return this.ctl.cfg().get<string>('redmine.projectId', '') || this.ctl.ctx.workspaceState.get<string>(this.redmineProjectKey()) || undefined;
  }

  private redmineUrl(): string {
    return this.ctl.cfg().get<string>('redmine.url', '').trim().replace(/\/+$/, '');
  }

  private redmineSecret(url: string) {
    return `worktreeGraph.redmine:${url.toLowerCase()}`;
  }

  private async redmineClient(): Promise<RedmineClient | undefined> {
    const url = this.redmineUrl();
    if (!url) return undefined;
    const key = (await this.ctl.ctx.secrets.get(this.redmineSecret(url))) ?? process.env.REDMINE_API_KEY;
    return key ? new RedmineClient(url, key) : undefined;
  }

  // ---------- Jira ----------

  private jiraUrl(): string {
    return this.ctl.cfg().get<string>('jira.url', '').trim().replace(/\/+$/, '');
  }

  private jiraSecret(url: string) {
    return `worktreeGraph.jira:${url.toLowerCase()}`;
  }

  private jiraProjectKey() {
    return `jira.projectKey:${this.ctl.repo?.commonDir.toLowerCase() ?? ''}`;
  }

  /** Configuração explícita tem precedência; senão, o projeto escolhido ao conectar. */
  private jiraProject(): string | undefined {
    return this.ctl.cfg().get<string>('jira.projectKey', '') || this.ctl.ctx.workspaceState.get<string>(this.jiraProjectKey()) || undefined;
  }

  private async jiraClient(): Promise<JiraClient | undefined> {
    const url = this.jiraUrl();
    if (!url) return undefined;
    const raw = await this.ctl.ctx.secrets.get(this.jiraSecret(url));
    let auth: JiraAuth | undefined;
    try {
      auth = raw ? (JSON.parse(raw) as JiraAuth) : undefined;
    } catch {
      auth = undefined;
    }
    if (!auth && process.env.JIRA_API_TOKEN) {
      auth = process.env.JIRA_EMAIL
        ? { kind: 'cloud', email: process.env.JIRA_EMAIL, token: process.env.JIRA_API_TOKEN }
        : { kind: 'server', token: process.env.JIRA_API_TOKEN };
    }
    return auth ? new JiraClient(url, auth) : undefined;
  }

  async connectJira() {
    const url = await vscode.window.showInputBox({
      title: t('Connect to Jira'),
      prompt: t('Jira address (e.g. https://company.atlassian.net or https://jira.company.com)'),
      value: this.jiraUrl() || 'https://',
      ignoreFocusOut: true,
      validateInput: v => (/^https?:\/\/[^/\s]+/.test(v.trim()) ? undefined : t('Enter an http(s):// address')),
    });
    if (!url) return;
    const base = url.trim().replace(/\/+$/, '');
    const cloudGuess = /\.atlassian\.net$/i.test(new URL(base).hostname);
    const kinds = [
      { label: 'Jira Cloud', detail: t('Atlassian account email + API token (id.atlassian.com → Security → API tokens)'), flavor: 'cloud' as const },
      { label: 'Jira Server / Data Center', detail: t('Personal Access Token (Profile → Personal Access Tokens)'), flavor: 'server' as const },
    ];
    if (!cloudGuess) kinds.reverse();
    const kind = await vscode.window.showQuickPick(kinds, { title: t('Jira at {0}: installation type', base) });
    if (!kind) return;
    let auth: JiraAuth;
    if (kind.flavor === 'cloud') {
      const email = await vscode.window.showInputBox({
        title: t('Atlassian account email'),
        ignoreFocusOut: true,
        validateInput: v => (/.+@.+/.test(v) ? undefined : t('Enter the email.')),
      });
      if (!email) return;
      const openTokens = t('Open tokens page');
      const open = await vscode.window.showInformationMessage(
        t('Jira Cloud API token'),
        { modal: true, detail: t('The token is kept in the VS Code secret storage.') },
        openTokens,
        t('I already have the token'),
      );
      if (!open) return;
      if (open === openTokens) await vscode.env.openExternal(vscode.Uri.parse('https://id.atlassian.com/manage-profile/security/api-tokens'));
      const token = await vscode.window.showInputBox({ title: t('Jira Cloud API token'), password: true, ignoreFocusOut: true });
      if (!token) return;
      auth = { kind: 'cloud', email: email.trim(), token: token.trim() };
    } else {
      const token = await vscode.window.showInputBox({ title: t('Jira Personal Access Token'), password: true, ignoreFocusOut: true });
      if (!token) return;
      auth = { kind: 'server', token: token.trim() };
    }
    const client = new JiraClient(base, auth);
    let user: string;
    try {
      user = await client.whoami();
    } catch (e) {
      vscode.window.showErrorMessage(t('The credentials did not work on {0}: {1}', base, (e as Error).message));
      return;
    }
    await this.ctl.ctx.secrets.store(this.jiraSecret(base), JSON.stringify(auth));
    await this.ctl.cfg().update('jira.url', base, vscode.ConfigurationTarget.Global);
    try {
      const projects = await client.projects();
      if (projects.length) {
        const pick = await vscode.window.showQuickPick(
          [{ label: t('All projects'), key: '' }, ...projects.map(p => ({ label: p.name, description: p.key, key: p.key }))],
          { title: t('Jira: issues from which project?') },
        );
        // por repositório e fora do settings.json, para não deixar a worktree com alteração
        if (pick) await this.ctl.ctx.workspaceState.update(this.jiraProjectKey(), pick.key);
      }
    } catch {
      // listar projetos é opcional
    }
    vscode.window.showInformationMessage(t('Connected to Jira as {0}.', user));
    await this.refresh(true);
  }

  async disconnectJira() {
    const url = this.jiraUrl();
    if (!url) return;
    await this.ctl.ctx.secrets.delete(this.jiraSecret(url));
    vscode.window.showInformationMessage(t('Jira credentials ({0}) removed.', url));
    await this.refresh(true);
  }

  private signature() {
    return this.groups.map(g => `${g.title}|${g.error ?? ''}|${g.needsConnect ?? ''}|${g.issues.map(i => `${i.key}${i.updated}`).join(',')}`).join(';');
  }

  /** Nunca pergunta nada ao usuário; só redesenha se algo mudou. */
  refresh(force = false): Promise<void> {
    if (this.fetching) return this.fetching;
    if (!force && Date.now() - this.lastFetch < REFRESH_MS) return Promise.resolve();
    this.lastFetch = Date.now();
    const before = this.signature();
    this.fetching = (async () => {
      const scope = this.scope;
      const groups: IssueGroup[] = [];
      const jobs: Promise<void>[] = [];

      const remote = await this.ctl.requests.detectRemote();
      // Bitbucket Server não tem issues (normalmente usa o Jira)
      if (remote && !(remote.kind === 'bitbucket' && remote.flavor === 'server')) {
        const g: IssueGroup = {
          provider: remote.kind,
          title: `${hostLabel(remote.kind)} · ${remote.projectPath}`,
          issues: [],
        };
        groups.push(g);
        jobs.push(
          (async () => {
            try {
              const client = await this.ctl.requests.client(false);
              if (!client) {
                g.needsConnect = true;
                return;
              }
              g.issues = await client.listIssues(scope);
            } catch (e) {
              g.error = (e as Error).message;
            }
          })(),
        );
      }

      const url = this.redmineUrl();
      if (url) {
        const g: IssueGroup = { provider: 'redmine', title: `Redmine · ${url.replace(/^https?:\/\//, '')}`, issues: [] };
        groups.push(g);
        jobs.push(
          (async () => {
            try {
              const client = await this.redmineClient();
              if (!client) {
                g.needsConnect = true;
                return;
              }
              g.issues = await client.listIssues(scope, this.redmineProject());
            } catch (e) {
              g.error = (e as Error).message;
            }
          })(),
        );
      }

      const jiraUrl = this.jiraUrl();
      if (jiraUrl) {
        const g: IssueGroup = { provider: 'jira', title: `Jira · ${jiraUrl.replace(/^https?:\/\//, '')}`, issues: [] };
        groups.push(g);
        jobs.push(
          (async () => {
            try {
              const client = await this.jiraClient();
              if (!client) {
                g.needsConnect = true;
                return;
              }
              g.issues = await client.listIssues(scope, this.jiraProject(), this.ctl.cfg().get<string>('jira.jql', ''));
            } catch (e) {
              g.error = (e as Error).message;
            }
          })(),
        );
      }

      await Promise.all(jobs);
      for (const g of groups) if (g.error) this.ctl.log(`Issues (${g.title}): ${g.error}`);
      this.groups = groups;
    })().finally(() => {
      this.fetching = undefined;
      if (this.signature() !== before) this.changed.fire();
    });
    return this.fetching;
  }

  async connectRedmine() {
    const url = await vscode.window.showInputBox({
      title: t('Connect to Redmine'),
      prompt: t('Redmine address (e.g. https://redmine.company.com)'),
      value: this.redmineUrl() || 'https://',
      ignoreFocusOut: true,
      validateInput: v => (/^https?:\/\/[^/\s]+/.test(v.trim()) ? undefined : t('Enter an http(s):// address')),
    });
    if (!url) return;
    const base = url.trim().replace(/\/+$/, '');
    const openAccount = t('Open my account');
    const open = await vscode.window.showInformationMessage(
      t('Redmine API key at {0}', base),
      {
        modal: true,
        detail: t(
          'It is under "My account" → "API access key" (the REST API must be enabled in the administration). The key goes to the VS Code secret storage.',
        ),
      },
      openAccount,
      t('I already have the key'),
    );
    if (!open) return;
    if (open === openAccount) await vscode.env.openExternal(vscode.Uri.parse(`${base}/my/account`));
    const key = await vscode.window.showInputBox({ title: t('Redmine API key'), password: true, ignoreFocusOut: true });
    if (!key) return;
    const client = new RedmineClient(base, key.trim());
    let user: string;
    try {
      user = await client.whoami();
    } catch (e) {
      vscode.window.showErrorMessage(t('The key did not work on {0}: {1}', base, (e as Error).message));
      return;
    }
    await this.ctl.ctx.secrets.store(this.redmineSecret(base), key.trim());
    await this.ctl.cfg().update('redmine.url', base, vscode.ConfigurationTarget.Global);

    // projeto opcional: sem escolher, lista de todos os projetos
    try {
      const projects = await client.projects();
      if (projects.length > 1) {
        const pick = await vscode.window.showQuickPick(
          [{ label: t('All projects'), id: '' }, ...projects.map(p => ({ label: p.name, description: p.identifier, id: p.identifier }))],
          { title: t('Redmine: issues from which project?') },
        );
        // por repositório e fora do settings.json, para não deixar a worktree com alteração
        if (pick) await this.ctl.ctx.workspaceState.update(this.redmineProjectKey(), pick.id);
      }
    } catch {
      // listar projetos é opcional
    }
    vscode.window.showInformationMessage(t('Connected to Redmine as {0}.', user));
    await this.refresh(true);
  }

  async disconnectRedmine() {
    const url = this.redmineUrl();
    if (!url) return;
    await this.ctl.ctx.secrets.delete(this.redmineSecret(url));
    vscode.window.showInformationMessage(t('Redmine key ({0}) removed.', url));
    await this.refresh(true);
  }

  // ---------- vínculo branch → issue ----------

  private links(): Record<string, IssueLink> {
    return this.ctl.ctx.workspaceState.get<Record<string, IssueLink>>('issueLinks', {});
  }

  linkOf(branch: string): IssueLink | undefined {
    return this.links()[branch];
  }

  /** Linhas para a descrição do PR/MR ("Closes #12", "Refs #123"). */
  trailers(branch: string): string[] {
    const l = this.linkOf(branch);
    return l ? [issueTrailer(l)] : [];
  }

  /** Branch já criada para a issue, se houver. */
  branchOf(issue: Issue): string | undefined {
    return Object.entries(this.links()).find(([, l]) => l.provider === issue.provider && String(l.id) === String(issue.id))?.[0];
  }

  /**
   * Cria (ou reaproveita) a worktree da issue e, com `withAgent`, abre o agente com o prompt da issue.
   */
  /**
   * Nova issue no GitHub/GitLab do repositório ou no Redmine. `context` é um texto pronto para a
   * descrição (ex.: trecho de código selecionado), que entra depois do que a pessoa escrever.
   */
  async create(context?: string) {
    type Target = { label: string; description: string; where: 'host' | 'redmine' | 'jira' };
    const targets: Target[] = [];
    const remote = await this.ctl.requests.detectRemote();
    // Bitbucket Server não tem issues (normalmente usa o Jira)
    if (remote && !(remote.kind === 'bitbucket' && remote.flavor === 'server'))
      targets.push({ label: hostLabel(remote.kind), description: `${remote.host}/${remote.projectPath}`, where: 'host' });
    if (this.redmineUrl()) targets.push({ label: 'Redmine', description: this.redmineUrl(), where: 'redmine' });
    if (this.jiraUrl()) targets.push({ label: 'Jira', description: this.jiraUrl(), where: 'jira' });
    if (!targets.length) {
      const jira = t('Connect to Jira');
      const redmine = t('Connect to Redmine');
      const remoteOpt = t('Connect to the remote');
      const go = await vscode.window.showWarningMessage(
        t('Nowhere to create issues: the remote has no recognized issues and neither Redmine nor Jira is configured.'),
        jira,
        redmine,
        remoteOpt,
      );
      if (go === jira) await this.connectJira();
      if (go === redmine) await this.connectRedmine();
      if (go === remoteOpt) await this.ctl.requests.connect();
      return;
    }
    const target = targets.length === 1 ? targets[0] : await vscode.window.showQuickPick(targets, { title: t('New issue: where?') });
    if (!target) return;

    const title = await vscode.window.showInputBox({
      title: t('New issue on {0}', target.label),
      prompt: t('Title'),
      ignoreFocusOut: true,
      validateInput: v => (v.trim() ? undefined : t('Enter a title.')),
    });
    if (!title) return;
    const text = await vscode.window.showInputBox({
      title: t('New issue: {0}', title),
      prompt: context
        ? t('Description (the selected snippet goes right below). Press Enter with it empty to use only the snippet.')
        : t('Description (optional; you can complete it later in the browser)'),
      ignoreFocusOut: true,
    });
    if (text === undefined) return;
    const body = [text.trim(), context ?? ''].filter(Boolean).join('\n\n');

    let created: Issue;
    try {
      if (target.where === 'host') {
        const client = await this.ctl.requests.client(true);
        if (!client) return;
        const labelsRaw = await vscode.window.showInputBox({ title: t('New issue: {0}', title), prompt: t('Comma-separated labels (optional)'), ignoreFocusOut: true });
        if (labelsRaw === undefined) return;
        const labels = labelsRaw.split(',').map(l => l.trim()).filter(Boolean);
        created = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Creating issue…') }, () => client.createIssue({ title: title.trim(), body, labels }));
      } else if (target.where === 'jira') {
        const client = await this.jiraClient();
        if (!client) return this.connectJira();
        let projectKey = this.jiraProject();
        if (!projectKey) {
          const projects = await client.projects();
          const pick = await vscode.window.showQuickPick(projects.map(p => ({ label: p.name, description: p.key, key: p.key })), { title: t('Jira: in which project?') });
          if (!pick) return;
          projectKey = pick.key;
        }
        const labelsRaw = await vscode.window.showInputBox({ title: t('New issue: {0}', title), prompt: t('Comma-separated labels (optional)'), ignoreFocusOut: true });
        if (labelsRaw === undefined) return;
        const labels = labelsRaw.split(',').map(l => l.trim()).filter(Boolean);
        const issueType = this.ctl.cfg().get<string>('jira.issueType', 'Task');
        created = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Creating issue…') }, () =>
          client.createIssue({ projectKey: projectKey!, issueType, title: title.trim(), body, labels }),
        );
      } else {
        const client = await this.redmineClient();
        if (!client) return this.connectRedmine();
        let projectId = this.redmineProject();
        if (!projectId) {
          const projects = await client.projects();
          const pick = await vscode.window.showQuickPick(projects.map(p => ({ label: p.name, description: p.identifier, id: p.identifier })), { title: t('Redmine: in which project?') });
          if (!pick) return;
          projectId = pick.id;
        }
        created = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Creating issue…') }, () =>
          client.createIssue({ projectId: projectId!, title: title.trim(), body }),
        );
      }
    } catch (e) {
      vscode.window.showErrorMessage(t('Could not create the issue: {0}', (e as Error).message));
      return;
    }
    this.ctl.log(t('Issue {0} created: {1}', created.key, created.url));
    void this.refresh(true);
    const startClaude = t('✦ Start with Claude');
    const openBrowser = t('Open in browser');
    const copyLink = t('Copy link');
    const go = await vscode.window.showInformationMessage(t('Issue {0} created: {1}', created.key, created.title), startClaude, openBrowser, copyLink);
    if (go === startClaude) await this.start(created, true);
    if (go === openBrowser) vscode.env.openExternal(vscode.Uri.parse(created.url));
    if (go === copyLink) vscode.env.clipboard.writeText(created.url);
  }

  async start(issue: Issue, withAgent: boolean) {
    const repo = this.ctl.repo;
    if (!repo) throw new Error(t('No git repository open.'));
    const { base } = await this.ctl.base();
    const branch = this.branchOf(issue) ?? issueBranch(issue, this.ctl.cfg().get<string>('issues.branchPrefix', 'issue'));
    const wts = await repo.worktreesFast();
    let wt = wts.find(w => w.branch === branch && !w.prunable);
    if (!wt) {
      const exists = (await repo.refs()).some(r => r.kind === 'head' && r.name === branch);
      const dir = await createWorktree(this.ctl, exists ? { existing: branch, quiet: true } : { branch, quiet: true });
      if (!dir) return;
      wt = { path: dir, branch } as (typeof wts)[number];
    }
    await this.ctl.ctx.workspaceState.update('issueLinks', {
      ...this.links(),
      [branch]: { provider: issue.provider, id: issue.id, key: issue.key, title: issue.title, url: issue.url },
    });
    this.ctl.scheduleRefresh(50);
    if (!withAgent) {
      vscode.window.showInformationMessage(t('Worktree {0} ready for {1}.', branch, issue.key));
      return;
    }

    const body = issue.body.length > MAX_BODY ? `${issue.body.slice(0, MAX_BODY)}\n\n${t('[… description truncated; see the link]')}` : issue.body;
    const template = this.ctl.cfg().get<string>('prompts.issue', '') || DEFAULT_ISSUE_PROMPT;
    const prompt = renderPrompt(template, { key: issue.key, title: issue.title, body: body || t('(no description)'), url: issue.url, branch, base });
    await launchWithPrompt(this.ctl, { path: wt.path, branch, prompt });
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.changed.dispose();
  }
}

/**
 * Abre o agente com o prompt (comando da frente de agentes). Sem ele, abre um terminal na worktree
 * e o prompt num documento, para colar em qualquer agente.
 */
export async function launchWithPrompt(ctl: Controller, args: { path: string; branch?: string; prompt: string; agent?: string }) {
  const all = await vscode.commands.getCommands(true);
  if (all.includes('worktreeGraph.launchAgentWithPrompt')) {
    await vscode.commands.executeCommand('worktreeGraph.launchAgentWithPrompt', args);
    return;
  }
  await openTerminal(ctl, { path: args.path });
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: args.prompt });
  await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  vscode.window.showInformationMessage(t('Issue prompt opened to the side; the terminal is already in the worktree.'), t('Copy prompt')).then(p => {
    if (p) void vscode.env.clipboard.writeText(args.prompt);
  });
}
