/**
 * Issues do GitHub, GitLab (inclusive self-hosted) e Redmine, sem depender da API do VS Code
 * para poder ser testado contra um servidor falso (test/issues.test.js).
 */

import { t } from '../i18n';

export type IssueProvider = 'github' | 'gitlab' | 'bitbucket' | 'azure' | 'redmine' | 'jira';
export type IssueScope = 'mine' | 'all';

export interface Issue {
  provider: IssueProvider;
  /** Número no GitHub, iid no GitLab, id no Redmine. */
  id: number | string;
  /** "#12" no GitHub/GitLab/Bitbucket, "AB#12" no Azure DevOps, "RM#123" no Redmine, "PROJ-12" no Jira. */
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
    throw new IssueError(0, t('Could not reach {0}: {1}', new URL(url).host, (e as Error).message));
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
    return (await this.searchIssues(scope, projectId)).issues;
  }

  /**
   * Issues com filtro e paginação. Com consulta salva (`queryId`), os filtros dela valem no lugar de
   * status, tipo e responsável; o projeto continua valendo.
   */
  async searchIssues(scope: IssueScope, projectId?: string, f: RedmineFilter = {}, limit = 50, offset = 0): Promise<{ issues: Issue[]; total: number }> {
    const q = new URLSearchParams({ limit: String(limit), offset: String(offset), sort: 'updated_on:desc' });
    if (f.queryId) q.set('query_id', f.queryId);
    else {
      q.set('status_id', f.status || 'open');
      if (f.trackerId) q.set('tracker_id', f.trackerId);
      if (scope === 'mine') q.set('assigned_to_id', 'me');
    }
    if (projectId) q.set('project_id', projectId);
    const r = await this.req<any>(`/issues.json?${q}`);
    const issues = (r.issues ?? []).map((i: any) => mapRedmineIssue(i, this.base));
    return { issues, total: typeof r.total_count === 'number' ? r.total_count : issues.length };
  }

  async issue(id: number | string): Promise<Issue> {
    const r = await this.req<any>(`/issues/${encodeURIComponent(String(id))}.json`);
    return mapRedmineIssue(r.issue, this.base);
  }

  async createIssue(n: NewIssue & { projectId: string }): Promise<Issue> {
    const r = await callJson<any>(this.f, `${this.base}/issues.json`, {
      method: 'POST',
      headers: { 'X-Redmine-API-Key': this.apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ issue: { project_id: n.projectId, subject: n.title, description: n.body } }),
    });
    return mapRedmineIssue(r.issue, this.base);
  }

  /** Todos os projetos visíveis (o Redmine devolve no máximo 100 por página). */
  async projects(): Promise<RedmineProject[]> {
    const out: RedmineProject[] = [];
    for (let offset = 0; offset < 5000; offset += 100) {
      const r = await this.req<any>(`/projects.json?limit=100&offset=${offset}`);
      const page = r.projects ?? [];
      out.push(...page.map((p: any) => ({ id: p.id, identifier: p.identifier, name: p.name, parentId: p.parent?.id })));
      if (page.length < 100 || out.length >= (r.total_count ?? 0)) break;
    }
    return out;
  }

  async statuses(): Promise<{ id: number; name: string; closed: boolean }[]> {
    const r = await this.req<any>('/issue_statuses.json');
    return (r.issue_statuses ?? []).map((s: any) => ({ id: s.id, name: s.name, closed: !!s.is_closed }));
  }

  async trackers(): Promise<{ id: number; name: string }[]> {
    const r = await this.req<any>('/trackers.json');
    return (r.trackers ?? []).map((s: any) => ({ id: s.id, name: s.name }));
  }

  /** Consultas salvas (públicas e as da pessoa). `projectId` numérico = só as globais ou daquele projeto. */
  async queries(projectId?: number): Promise<{ id: number; name: string; projectId?: number }[]> {
    const out: { id: number; name: string; projectId?: number }[] = [];
    for (let offset = 0; offset < 1000; offset += 100) {
      const r = await this.req<any>(`/queries.json?limit=100&offset=${offset}`);
      const page = r.queries ?? [];
      out.push(...page.map((s: any) => ({ id: s.id, name: s.name, projectId: s.project_id ?? undefined })));
      if (page.length < 100 || out.length >= (r.total_count ?? 0)) break;
    }
    return projectId === undefined ? out : out.filter(q => q.projectId === undefined || q.projectId === projectId);
  }
}

export interface RedmineProject {
  id: number;
  identifier: string;
  name: string;
  parentId?: number;
}

/** Filtro da lista do Redmine. `status`: "open", "closed", "*" ou o id de um status. */
export interface RedmineFilter {
  status?: string;
  statusName?: string;
  trackerId?: string;
  trackerName?: string;
  queryId?: string;
  queryName?: string;
}

/** Projetos na ordem da árvore (pai antes dos filhos, irmãos por nome), com a profundidade. */
export function projectTree(projects: RedmineProject[]): (RedmineProject & { depth: number })[] {
  const ids = new Set(projects.map(p => p.id));
  const kids = new Map<number | undefined, RedmineProject[]>();
  for (const p of projects) {
    // pai invisível para a pessoa: o projeto sobe para a raiz
    const parent = p.parentId !== undefined && ids.has(p.parentId) ? p.parentId : undefined;
    kids.set(parent, [...(kids.get(parent) ?? []), p]);
  }
  const out: (RedmineProject & { depth: number })[] = [];
  const seen = new Set<number>();
  const walk = (parent: number | undefined, depth: number) => {
    for (const p of (kids.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ ...p, depth });
      walk(p.id, depth + 1);
    }
  };
  walk(undefined, 0);
  return out;
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
  const p = issue.provider === 'redmine' ? 'redmine' : issue.provider === 'jira' ? 'jira' : prefix || 'issue';
  return `${p}/${issue.id}${slug ? `-${slug}` : ''}`;
}

/** Linha para a descrição do PR/MR que fecha ou referencia a issue. */
export function issueTrailer(issue: Pick<Issue, 'provider' | 'id'>): string {
  switch (issue.provider) {
    case 'redmine':
      return `Refs #${issue.id}`;
    // Jira liga PR e issue pela chave; Azure Boards pela menção AB#id
    case 'jira':
      return String(issue.id);
    case 'azure':
      return `AB#${issue.id}`;
    default:
      return `Closes #${issue.id}`;
  }
}

/** Montado ao carregar o módulo (o bundle de tradução do VS Code já está disponível na ativação). */
export const DEFAULT_ISSUE_PROMPT = [
  t('Work on issue {0}: {1}', '${key}', '${title}'),
  '',
  t('Link: {0}', '${url}'),
  '',
  t('Issue description:'),
  '${body}',
  '',
  t('You are in the worktree of branch {0}, created from {1}.', '${branch}', '${base}'),
  t('Implement what the issue asks for, in small commits with clear messages.'),
  t('Run the project\'s tests before finishing and fix whatever breaks.'),
  t('At the end, summarize what changed, what was left out and how to validate it.'),
].join('\n');

export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}
