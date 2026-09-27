import { Issue, IssueScope, mapGitHubIssue, mapGitLabIssue, NewIssue } from '../issues/core';
import { parsePlatformRemote } from './platforms';

/**
 * GitHub (incl. Enterprise) e GitLab (incl. self-hosted) via REST, sem depender da API do VS Code
 * para poder ser testado contra um servidor falso (test/hosting.test.js).
 */

export type HostKind = 'github' | 'gitlab' | 'bitbucket' | 'azure';

export interface RemoteInfo {
  kind: HostKind;
  /** Só o nome, sem porta: "gitlab.empresa.com". */
  host: string;
  /** Endereço web com esquema e porta: "https://gitlab.empresa.com:8443". */
  webBase: string;
  /** "grupo/subgrupo/projeto", "dono/repo", "PROJ/repo" (Bitbucket Server) ou "org/projeto/repo" (Azure). */
  projectPath: string;
  /** Bitbucket e Azure DevOps: serviço na nuvem ou instalação própria. */
  flavor?: 'cloud' | 'server';
  /** Raiz da API quando não sai direto do webBase (Bitbucket Cloud/Server, coleção do Azure). */
  apiRoot?: string;
  azure?: { collection: string; organization: string; project: string; repo: string };
}

export interface ChangeRequest {
  /** Número no GitHub, iid no GitLab. */
  id: number;
  /** "#12" (PR) ou "!12" (MR). */
  ref: string;
  url: string;
  title: string;
  state: 'open' | 'draft' | 'merged' | 'closed';
  source: string;
  target: string;
  /** Situação da revisão (só para PRs/MRs abertos; preenchida à parte). */
  review?: ReviewStatus;
}

export interface ReviewStatus {
  state: 'approved' | 'changes' | 'commented' | 'pending' | 'discussions';
  /** Aprovações recebidas. */
  approvals: number;
  /** Aprovações que ainda faltam (GitLab, quando há regra). */
  approvalsLeft?: number;
  /** Quem aprovou / pediu mudanças, para o tooltip. */
  by: string[];
}

/**
 * Decisão a partir das revisões do GitHub: vale a última revisão de cada pessoa; qualquer
 * "mudanças pedidas" pesa mais que aprovações.
 */
export function githubReviewDecision(reviews: { user?: { login?: string }; state: string }[]): ReviewStatus {
  const last = new Map<string, string>();
  for (const r of reviews) {
    const who = r.user?.login ?? '?';
    // COMMENTED não desfaz uma aprovação ou um pedido de mudança anterior da mesma pessoa
    if (r.state === 'COMMENTED' && last.has(who)) continue;
    if (r.state === 'DISMISSED') {
      last.delete(who);
      continue;
    }
    last.set(who, r.state);
  }
  const changes = [...last].filter(([, s]) => s === 'CHANGES_REQUESTED').map(([w]) => w);
  const approved = [...last].filter(([, s]) => s === 'APPROVED').map(([w]) => w);
  if (changes.length) return { state: 'changes', approvals: approved.length, by: changes };
  if (approved.length) return { state: 'approved', approvals: approved.length, by: approved };
  if (last.size) return { state: 'commented', approvals: 0, by: [...last.keys()] };
  return { state: 'pending', approvals: 0, by: [] };
}

/** Bitbucket Cloud: participantes com papel de revisor; approved ou state "changes_requested". */
export function bitbucketCloudReview(participants: any[]): ReviewStatus {
  const rev = (participants ?? []).filter(p => p.role === 'REVIEWER' || p.approved || p.state);
  const name = (p: any) => p.user?.nickname ?? p.user?.display_name ?? '?';
  const changes = rev.filter(p => p.state === 'changes_requested').map(name);
  const approved = rev.filter(p => p.approved || p.state === 'approved').map(name);
  if (changes.length) return { state: 'changes', approvals: approved.length, by: changes };
  if (approved.length) return { state: 'approved', approvals: approved.length, by: approved };
  return { state: 'pending', approvals: 0, by: [] };
}

/** Bitbucket Server/Data Center: reviewers[].status APPROVED | NEEDS_WORK | UNAPPROVED. */
export function bitbucketServerReview(reviewers: any[]): ReviewStatus {
  const name = (r: any) => r.user?.name ?? r.user?.displayName ?? '?';
  const changes = (reviewers ?? []).filter(r => r.status === 'NEEDS_WORK').map(name);
  const approved = (reviewers ?? []).filter(r => r.status === 'APPROVED' || r.approved).map(name);
  if (changes.length) return { state: 'changes', approvals: approved.length, by: changes };
  if (approved.length) return { state: 'approved', approvals: approved.length, by: approved };
  return { state: 'pending', approvals: 0, by: [] };
}

/** Azure DevOps: vote 10 aprovado, 5 aprovado com sugestões, -5 aguardando o autor, -10 rejeitado. */
export function azureReview(reviewers: any[]): ReviewStatus {
  const name = (r: any) => r.displayName ?? r.uniqueName ?? '?';
  const changes = (reviewers ?? []).filter(r => r.vote <= -5).map(name);
  const approved = (reviewers ?? []).filter(r => r.vote >= 5).map(name);
  if (changes.length) return { state: 'changes', approvals: approved.length, by: changes };
  if (approved.length) return { state: 'approved', approvals: approved.length, by: approved };
  return { state: 'pending', approvals: 0, by: [] };
}

export interface NewChangeRequest {
  source: string;
  target: string;
  title: string;
  body: string;
  draft: boolean;
}

export interface HostClient {
  readonly kind: HostKind;
  /** "PR" no GitHub, "MR" no GitLab. */
  readonly label: 'PR' | 'MR';
  listOpen(): Promise<ChangeRequest[]>;
  findForBranch(branch: string): Promise<ChangeRequest | undefined>;
  create(r: NewChangeRequest): Promise<ChangeRequest>;
  /** Situação da revisão de um PR/MR aberto. */
  reviewStatus(r: ChangeRequest): Promise<ReviewStatus>;
  /** Confere o token; devolve o nome do usuário. */
  whoami(): Promise<string>;
  listIssues(scope: IssueScope): Promise<Issue[]>;
  createIssue(n: NewIssue): Promise<Issue>;
}

export class HostError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Entrada da configuração ("gitlab.empresa.com" ou "https://gitlab.empresa.com:8443") → nome e endereço web. */
function hostEntry(entry: string): { host: string; webBase: string; prefix: string } | undefined {
  const e = entry.trim();
  if (!e) return undefined;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(e) ? e : `https://${e}`);
    // instalação em subcaminho: https://empresa.com/gitlab
    const prefix = u.pathname.replace(/^\/+|\/+$/g, '');
    return { host: u.hostname.toLowerCase(), webBase: `${u.protocol}//${u.host}${prefix ? `/${prefix}` : ''}`, prefix };
  } catch {
    return undefined;
  }
}

/**
 * Entende https, ssh://, scp-like (git@host:grupo/repo.git), com usuário, porta e subgrupos.
 * A porta de um remoto ssh é a do ssh, não a da web: nesses casos o endereço web vem da
 * configuração do host (gitlabHosts/githubHosts) ou cai para https://host.
 */
export function parseRemote(
  url: string,
  gitlabHosts: string[] = [],
  githubHosts: string[] = [],
  bitbucketHosts: string[] = [],
  azureHosts: string[] = [],
): RemoteInfo | undefined {
  // Bitbucket e Azure DevOps têm formatos de caminho próprios (/scm/, /_git/, v3/…)
  const platform = parsePlatformRemote(url, bitbucketHosts, azureHosts);
  if (platform) return platform;
  let host: string;
  let path: string;
  let webBase: string;
  const scp = /^(?:[^@\s]+@)?([^:\s/]+):(?!\/)(.+)$/.exec(url.trim());
  if (scp && !/^[a-z]+:\/\//i.test(url)) {
    host = scp[1].toLowerCase();
    path = scp[2];
    webBase = `https://${host}`;
  } else {
    let u: URL;
    try {
      u = new URL(url.trim());
    } catch {
      return undefined;
    }
    host = u.hostname.toLowerCase();
    path = decodeURIComponent(u.pathname);
    webBase = u.protocol === 'http:' || u.protocol === 'https:' ? `${u.protocol}//${u.host}` : `https://${host}`;
  }
  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  if (!path.includes('/')) return undefined;

  const gl = gitlabHosts.map(hostEntry).find(h => h?.host === host);
  const gh = githubHosts.map(hostEntry).find(h => h?.host === host);
  let kind: HostKind | undefined;
  if (host === 'github.com' || gh) kind = 'github';
  else if (host === 'gitlab.com' || gl || /(^|[.-])gitlab([.-]|$)/.test(host)) kind = 'gitlab';
  if (!kind) return undefined;
  const entry = gl ?? gh;
  if (entry) {
    webBase = entry.webBase;
    // num remoto https de instalação em subcaminho, o caminho começa com o prefixo: não é parte do projeto
    if (entry.prefix && path.toLowerCase().startsWith(entry.prefix.toLowerCase() + '/')) path = path.slice(entry.prefix.length + 1);
  }
  return { kind, host, webBase, projectPath: path };
}

type Fetch = typeof fetch;

async function call<T>(f: Fetch, url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await f(url, init);
  } catch (e) {
    throw new HostError(0, `Não consegui falar com ${new URL(url).host}: ${(e as Error).message}`);
  }
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg =
      (body && (body.message || body.error || (Array.isArray(body.errors) && body.errors.map((e: any) => e.message || e).join('; ')))) ||
      text ||
      res.statusText;
    throw new HostError(res.status, `${res.status}: ${Array.isArray(msg) ? msg.join('; ') : typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return body as T;
}

export class GitHubClient implements HostClient {
  readonly kind = 'github';
  readonly label = 'PR';
  private readonly api: string;
  private readonly owner: string;

  constructor(private readonly remote: RemoteInfo, private readonly token: string, apiBase?: string, private readonly f: Fetch = fetch) {
    this.api = (apiBase || (remote.host === 'github.com' ? 'https://api.github.com' : `${remote.webBase}/api/v3`)).replace(/\/+$/, '');
    this.owner = remote.projectPath.split('/')[0];
  }

  private req<T>(method: string, p: string, body?: unknown) {
    return call<T>(this.f, `${this.api}/repos/${this.remote.projectPath}${p}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'worktree-graph',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  private map(p: any): ChangeRequest {
    return {
      id: p.number,
      ref: `#${p.number}`,
      url: p.html_url,
      title: p.title,
      state: p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : p.draft ? 'draft' : 'open',
      source: p.head?.ref,
      target: p.base?.ref,
    };
  }

  async listOpen() {
    const list = await this.req<any[]>('GET', '/pulls?state=open&per_page=100');
    // PRs vindos de forks podem ter o mesmo nome de branch: só contam os do próprio repositório.
    return list.filter(p => !p.head?.repo || p.head.repo.full_name?.toLowerCase() === this.remote.projectPath.toLowerCase()).map(p => this.map(p));
  }

  async findForBranch(branch: string) {
    const list = await this.req<any[]>('GET', `/pulls?state=all&per_page=5&head=${encodeURIComponent(`${this.owner}:${branch}`)}`);
    return list[0] ? this.map(list[0]) : undefined;
  }

  async create(r: NewChangeRequest) {
    return this.map(await this.req<any>('POST', '/pulls', { title: r.title, head: r.source, base: r.target, body: r.body, draft: r.draft }));
  }

  async reviewStatus(r: ChangeRequest): Promise<ReviewStatus> {
    return githubReviewDecision(await this.req<any[]>('GET', `/pulls/${r.id}/reviews?per_page=100`));
  }

  private login?: string;

  async listIssues(scope: IssueScope): Promise<Issue[]> {
    let q = 'state=open&per_page=50&sort=updated';
    if (scope === 'mine') {
      this.login ??= await this.whoami();
      q += `&assignee=${encodeURIComponent(this.login)}`;
    }
    const list = await this.req<any[]>('GET', `/issues?${q}`);
    // a API de issues do GitHub devolve PRs também
    return list.filter(i => !i.pull_request).map(mapGitHubIssue);
  }

  async createIssue(n: NewIssue): Promise<Issue> {
    return mapGitHubIssue(await this.req<any>('POST', '/issues', { title: n.title, body: n.body, ...(n.labels?.length ? { labels: n.labels } : {}) }));
  }

  async whoami() {
    const u = await call<any>(this.f, `${this.api}/user`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'worktree-graph' },
    });
    return u.login as string;
  }
}

export class GitLabClient implements HostClient {
  readonly kind = 'gitlab';
  readonly label = 'MR';
  private readonly api: string;
  private readonly project: string;

  constructor(private readonly remote: RemoteInfo, private readonly token: string, apiBase?: string, private readonly f: Fetch = fetch) {
    this.api = (apiBase || `${remote.webBase}/api/v4`).replace(/\/+$/, '');
    this.project = encodeURIComponent(remote.projectPath);
  }

  private req<T>(method: string, p: string, body?: unknown) {
    return call<T>(this.f, `${this.api}${p}`, {
      method,
      headers: { 'PRIVATE-TOKEN': this.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  private map(m: any): ChangeRequest {
    const draft = m.draft || m.work_in_progress;
    return {
      id: m.iid,
      ref: `!${m.iid}`,
      url: m.web_url,
      title: m.title,
      state: m.state === 'merged' ? 'merged' : m.state === 'opened' ? (draft ? 'draft' : 'open') : 'closed',
      source: m.source_branch,
      target: m.target_branch,
    };
  }

  /** detailed_merge_status que veio na lista, por iid (evita uma chamada a mais). */
  private readonly mergeStatus = new Map<number, string>();

  async reviewStatus(r: ChangeRequest): Promise<ReviewStatus> {
    const a = await this.req<any>('GET', `/projects/${this.project}/merge_requests/${r.id}/approvals`);
    const by: string[] = (a.approved_by ?? []).map((x: any) => x.user?.username).filter(Boolean);
    const left = typeof a.approvals_left === 'number' ? a.approvals_left : undefined;
    const ms = this.mergeStatus.get(r.id);
    if (ms === 'discussions_not_resolved') return { state: 'discussions', approvals: by.length, approvalsLeft: left, by };
    if (by.length && !left) return { state: 'approved', approvals: by.length, approvalsLeft: left, by };
    return { state: 'pending', approvals: by.length, approvalsLeft: left, by };
  }

  async listOpen() {
    const list = await this.req<any[]>('GET', `/projects/${this.project}/merge_requests?state=opened&per_page=100`);
    for (const m of list) if (m.detailed_merge_status) this.mergeStatus.set(m.iid, m.detailed_merge_status);
    return list.map(m => this.map(m));
  }

  async findForBranch(branch: string) {
    const list = await this.req<any[]>(
      'GET',
      `/projects/${this.project}/merge_requests?source_branch=${encodeURIComponent(branch)}&order_by=updated_at&per_page=5`,
    );
    return list[0] ? this.map(list[0]) : undefined;
  }

  async create(r: NewChangeRequest) {
    return this.map(
      await this.req<any>('POST', `/projects/${this.project}/merge_requests`, {
        source_branch: r.source,
        target_branch: r.target,
        title: r.draft ? `Draft: ${r.title}` : r.title,
        description: r.body,
      }),
    );
  }

  async listIssues(scope: IssueScope): Promise<Issue[]> {
    const list = await this.req<any[]>(
      'GET',
      `/projects/${this.project}/issues?state=opened&per_page=50&order_by=updated_at&scope=${scope === 'mine' ? 'assigned_to_me' : 'all'}`,
    );
    return list.map(mapGitLabIssue);
  }

  async createIssue(n: NewIssue): Promise<Issue> {
    return mapGitLabIssue(
      await this.req<any>('POST', `/projects/${this.project}/issues`, { title: n.title, description: n.body, ...(n.labels?.length ? { labels: n.labels.join(',') } : {}) }),
    );
  }

  async whoami() {
    const u = await this.req<any>('GET', '/user');
    return u.username as string;
  }
}

/** Título sugerido: o commit, se for um só; senão o nome da branch legível. */
export function suggestTitle(branch: string, subjects: string[]): string {
  if (subjects.length === 1) return subjects[0];
  const last = branch.split('/').pop() ?? branch;
  const words = last.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `extra`: linhas no fim, como "Closes #12" quando a branch veio de uma issue. */
export function suggestBody(subjects: string[], label: 'PR' | 'MR', extra: string[] = []): string {
  const parts = subjects.length ? [`## Commits neste ${label}`, '', ...subjects.map(s => `- ${s}`)] : [];
  if (extra.length) parts.push(...(parts.length ? [''] : []), ...extra);
  return parts.join('\n');
}
