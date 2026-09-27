import * as vscode from 'vscode';
import { createWorktree, openTerminal } from '../actions';
import type { Controller } from '../controller';
import { DEFAULT_ISSUE_PROMPT, Issue, IssueProvider, IssueScope, issueBranch, issueTrailer, RedmineClient, renderPrompt } from './core';

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
      if (remote) {
        const g: IssueGroup = {
          provider: remote.kind,
          title: `${remote.kind === 'gitlab' ? 'GitLab' : 'GitHub'} · ${remote.projectPath}`,
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
      title: 'Conectar ao Redmine',
      prompt: 'Endereço do Redmine (ex.: https://redmine.empresa.com)',
      value: this.redmineUrl() || 'https://',
      ignoreFocusOut: true,
      validateInput: v => (/^https?:\/\/[^/\s]+/.test(v.trim()) ? undefined : 'Informe um endereço http(s)://'),
    });
    if (!url) return;
    const base = url.trim().replace(/\/+$/, '');
    const open = await vscode.window.showInformationMessage(
      `Chave de API do Redmine em ${base}`,
      { modal: true, detail: 'Fica em "Minha conta" → "Chave de acesso à API" (a API REST precisa estar habilitada na administração). A chave vai para o cofre de segredos do VS Code.' },
      'Abrir minha conta',
      'Já tenho a chave',
    );
    if (!open) return;
    if (open === 'Abrir minha conta') await vscode.env.openExternal(vscode.Uri.parse(`${base}/my/account`));
    const key = await vscode.window.showInputBox({ title: 'Chave de API do Redmine', password: true, ignoreFocusOut: true });
    if (!key) return;
    const client = new RedmineClient(base, key.trim());
    let user: string;
    try {
      user = await client.whoami();
    } catch (e) {
      vscode.window.showErrorMessage(`A chave não funcionou em ${base}: ${(e as Error).message}`);
      return;
    }
    await this.ctl.ctx.secrets.store(this.redmineSecret(base), key.trim());
    await this.ctl.cfg().update('redmine.url', base, vscode.ConfigurationTarget.Global);

    // projeto opcional: sem escolher, lista de todos os projetos
    try {
      const projects = await client.projects();
      if (projects.length > 1) {
        const pick = await vscode.window.showQuickPick(
          [{ label: 'Todos os projetos', id: '' }, ...projects.map(p => ({ label: p.name, description: p.identifier, id: p.identifier }))],
          { title: 'Redmine: issues de qual projeto?' },
        );
        // por repositório e fora do settings.json, para não deixar a worktree com alteração
        if (pick) await this.ctl.ctx.workspaceState.update(this.redmineProjectKey(), pick.id);
      }
    } catch {
      // listar projetos é opcional
    }
    vscode.window.showInformationMessage(`Conectado ao Redmine como ${user}.`);
    await this.refresh(true);
  }

  async disconnectRedmine() {
    const url = this.redmineUrl();
    if (!url) return;
    await this.ctl.ctx.secrets.delete(this.redmineSecret(url));
    vscode.window.showInformationMessage(`Chave do Redmine (${url}) removida.`);
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
  async start(issue: Issue, withAgent: boolean) {
    const repo = this.ctl.repo;
    if (!repo) throw new Error('Nenhum repositório git aberto.');
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
      vscode.window.showInformationMessage(`Worktree ${branch} pronta para ${issue.key}.`);
      return;
    }

    const body = issue.body.length > MAX_BODY ? `${issue.body.slice(0, MAX_BODY)}\n\n[… descrição cortada; veja o link]` : issue.body;
    const template = this.ctl.cfg().get<string>('prompts.issue', '') || DEFAULT_ISSUE_PROMPT;
    const prompt = renderPrompt(template, { key: issue.key, title: issue.title, body: body || '(sem descrição)', url: issue.url, branch, base });
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
  vscode.window.showInformationMessage('Prompt da issue aberto ao lado; o terminal já está na worktree.', 'Copiar prompt').then(p => p && vscode.env.clipboard.writeText(args.prompt));
}
