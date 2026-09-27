/**
 * Jira Cloud e Jira Server/Data Center como provedor de issues, sem API do VS Code.
 * Cloud: e-mail + API token (Basic), busca em /rest/api/3/search/jql (a /rest/api/2/search foi
 * removida do Cloud). Server/DC: Personal Access Token (Bearer), busca em /rest/api/2/search.
 */
import { callJson, Issue, IssueScope, NewIssue } from './core';

type Fetch = typeof fetch;

export type JiraAuth = { kind: 'cloud'; email: string; token: string } | { kind: 'server'; token: string };

const unix = (iso?: string) => (iso ? Math.floor(Date.parse(iso) / 1000) || 0 : 0);

/** Texto do Atlassian Document Format (descrição no Cloud v3) ou string (v2/Server). */
export function adfToText(node: any): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  const inner = (node.content ?? []).map(adfToText).join('');
  if (['paragraph', 'heading', 'codeBlock', 'blockquote'].includes(node.type)) return inner + '\n\n';
  if (node.type === 'listItem') return `- ${inner.trim()}\n`;
  return inner;
}

/** JQL das listas "minhas" e "todas"; `custom` (configuração) substitui o filtro do projeto. */
export function jiraJql(scope: IssueScope, projectKey?: string, custom?: string): string {
  const base = custom?.trim() || [projectKey ? `project = "${projectKey}"` : '', 'statusCategory != Done'].filter(Boolean).join(' AND ');
  const withScope = scope === 'mine' ? `assignee = currentUser() AND (${base})` : base;
  return /order by/i.test(withScope) ? withScope : `${withScope} ORDER BY updated DESC`;
}

export class JiraClient {
  readonly base: string;

  constructor(baseUrl: string, private readonly auth: JiraAuth, private readonly f: Fetch = fetch) {
    this.base = baseUrl.trim().replace(/\/+$/, '');
  }

  private get authHeader() {
    return this.auth.kind === 'cloud' ? `Basic ${Buffer.from(`${this.auth.email}:${this.auth.token}`).toString('base64')}` : `Bearer ${this.auth.token}`;
  }

  private req<T>(method: string, p: string, body?: unknown) {
    return callJson<T>(this.f, `${this.base}${p}`, {
      method,
      headers: { Authorization: this.authHeader, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async whoami(): Promise<string> {
    const u = await this.req<any>('GET', '/rest/api/2/myself');
    return u.displayName ?? u.name ?? u.emailAddress;
  }

  private map(i: any): Issue {
    const f = i.fields ?? {};
    return {
      provider: 'jira',
      id: i.key,
      key: i.key,
      title: f.summary ?? '',
      body: adfToText(f.description).trim(),
      url: `${this.base}/browse/${i.key}`,
      labels: [f.issuetype?.name, f.status?.name, ...(f.labels ?? [])].filter(Boolean),
      assignee: f.assignee?.displayName,
      updated: unix(f.updated),
      project: f.project?.key,
    };
  }

  async listIssues(scope: IssueScope, projectKey?: string, jql?: string): Promise<Issue[]> {
    const q = new URLSearchParams({
      jql: jiraJql(scope, projectKey, jql),
      maxResults: '50',
      fields: 'summary,description,labels,assignee,updated,status,issuetype,project',
    });
    const path = this.auth.kind === 'cloud' ? '/rest/api/3/search/jql' : '/rest/api/2/search';
    const r = await this.req<any>('GET', `${path}?${q}`);
    return (r.issues ?? []).map((i: any) => this.map(i));
  }

  async createIssue(n: NewIssue & { projectKey: string; issueType?: string }): Promise<Issue> {
    const created = await this.req<any>('POST', '/rest/api/2/issue', {
      fields: {
        project: { key: n.projectKey },
        summary: n.title,
        description: n.body,
        issuetype: { name: n.issueType || 'Task' },
        ...(n.labels?.length ? { labels: n.labels.map(l => l.replace(/\s+/g, '-')) } : {}),
      },
    });
    return {
      provider: 'jira',
      id: created.key,
      key: created.key,
      title: n.title,
      body: n.body,
      url: `${this.base}/browse/${created.key}`,
      labels: n.labels ?? [],
      updated: Math.floor(Date.now() / 1000),
      project: n.projectKey,
    };
  }

  async projects(): Promise<{ key: string; name: string }[]> {
    const r = await this.req<any>('GET', '/rest/api/2/project');
    return (Array.isArray(r) ? r : r.values ?? []).map((p: any) => ({ key: p.key, name: p.name }));
  }
}
