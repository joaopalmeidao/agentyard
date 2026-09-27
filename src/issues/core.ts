/**
 * Issues do GitHub, GitLab (inclusive self-hosted) e Redmine, sem depender da API do VS Code
 * para poder ser testado contra um servidor falso (test/issues.test.js).
 */

export type IssueProvider = 'github' | 'gitlab' | 'redmine';
export type IssueScope = 'mine' | 'all';

export interface Issue {
  provider: IssueProvider;
  /** Número no GitHub, iid no GitLab, id no Redmine. */
  id: number | string;
  /** "#12" no GitHub/GitLab, "RM#123" no Redmine. */
  key: string;
  title: string;
  body: string;
  url: string;
  labels: string[];
  assignee?: string;
  /** Unix (segundos). */
  updated: number;
  project?: string;
}

export class IssueError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

type Fetch = typeof fetch;

export async function callJson<T>(f: Fetch, url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await f(url, init);
  } catch (e) {
    throw new IssueError(0, `Não consegui falar com ${new URL(url).host}: ${(e as Error).message}`);
  }
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = (body && (body.message || body.error || (Array.isArray(body.errors) && body.errors.join('; ')))) || text || res.statusText;
    throw new IssueError(res.status, `${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return body as T;
}

const unix = (iso?: string) => (iso ? Math.floor(Date.parse(iso) / 1000) || 0 : 0);

export function mapGitHubIssue(i: any): Issue {
  return {
    provider: 'github',
    id: i.number,
    key: `#${i.number}`,
    title: i.title,
    body: i.body ?? '',
    url: i.html_url,
    labels: (i.labels ?? []).map((l: any) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
    assignee: i.assignee?.login,
    updated: unix(i.updated_at),
  };
}

export function mapGitLabIssue(i: any): Issue {
  return {
    provider: 'gitlab',
    id: i.iid,
    key: `#${i.iid}`,
    title: i.title,
    body: i.description ?? '',
    url: i.web_url,
    labels: i.labels ?? [],
    assignee: i.assignee?.username,
    updated: unix(i.updated_at),
  };
}

export function mapRedmineIssue(i: any, baseUrl: string): Issue {
  return {
    provider: 'redmine',
    id: i.id,
    key: `RM#${i.id}`,
    title: i.subject,
    body: i.description ?? '',
    url: `${baseUrl}/issues/${i.id}`,
    labels: [i.tracker?.name, i.status?.name, i.priority?.name].filter(Boolean),
    assignee: i.assigned_to?.name,
    updated: unix(i.updated_on),
    project: i.project?.name,
  };
}

export interface NewIssue {
  title: string;
  body: string;
  /** GitHub/GitLab; o Redmine ignora. */
  labels?: string[];
}

export class RedmineClient {
  readonly base: string;

  constructor(baseUrl: string, private readonly apiKey: string, private readonly f: Fetch = fetch) {
    this.base = baseUrl.trim().replace(/\/+$/, '');
  }

  private req<T>(p: string) {
    return callJson<T>(this.f, `${this.base}${p}`, { headers: { 'X-Redmine-API-Key': this.apiKey, Accept: 'application/json' } });
  }

  async whoami(): Promise<string> {
    const r = await this.req<any>('/users/current.json');
    return r.user?.login ?? `${r.user?.firstname ?? ''} ${r.user?.lastname ?? ''}`.trim();
  }

  async listIssues(scope: IssueScope, projectId?: string): Promise<Issue[]> {
    const q = new URLSearchParams({ status_id: 'open', limit: '50', sort: 'updated_on:desc' });
    if (scope === 'mine') q.set('assigned_to_id', 'me');
    if (projectId) q.set('project_id', projectId);
    const r = await this.req<any>(`/issues.json?${q}`);
    return (r.issues ?? []).map((i: any) => mapRedmineIssue(i, this.base));
  }

  async createIssue(n: NewIssue & { projectId: string }): Promise<Issue> {
    const r = await callJson<any>(this.f, `${this.base}/issues.json`, {
      method: 'POST',
      headers: { 'X-Redmine-API-Key': this.apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ issue: { project_id: n.projectId, subject: n.title, description: n.body } }),
    });
    return mapRedmineIssue(r.issue, this.base);
  }

  async projects(): Promise<{ id: number; identifier: string; name: string }[]> {
    const r = await this.req<any>('/projects.json?limit=100');
    return (r.projects ?? []).map((p: any) => ({ id: p.id, identifier: p.identifier, name: p.name }));
  }
}

/** Nome de branch para uma issue: "issue/12-corrigir-login", "redmine/123-...". */
export function issueBranch(issue: Issue, prefix: string): string {
  const slug = issue.title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 6)
    .join('-');
  const p = issue.provider === 'redmine' ? 'redmine' : prefix || 'issue';
  return `${p}/${issue.id}${slug ? `-${slug}` : ''}`;
}

/** Linha para a descrição do PR/MR que fecha ou referencia a issue. */
export function issueTrailer(issue: Pick<Issue, 'provider' | 'id'>): string {
  return issue.provider === 'redmine' ? `Refs #${issue.id}` : `Closes #${issue.id}`;
}

export const DEFAULT_ISSUE_PROMPT = [
  'Trabalhe na issue ${key}: ${title}',
  '',
  'Link: ${url}',
  '',
  'Descrição da issue:',
  '${body}',
  '',
  'Você está na worktree da branch ${branch}, criada a partir de ${base}.',
  'Implemente o que a issue pede, em commits pequenos e com mensagens claras.',
  'Rode os testes do projeto antes de terminar e corrija o que quebrar.',
  'No fim, resuma o que mudou, o que ficou de fora e como validar.',
].join('\n');

export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}
