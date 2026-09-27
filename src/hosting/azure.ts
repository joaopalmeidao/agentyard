/**
 * Azure DevOps Services (dev.azure.com, *.visualstudio.com) e Azure DevOps Server, sem API do VS
 * Code. PAT via Basic com usuário vazio. PRs do Azure Repos, work items como issues (WIQL) e
 * builds do Azure Pipelines.
 */
import type { Issue, IssueScope, NewIssue } from '../issues/core';
import { ChangeRequest, HostClient, HostError, NewChangeRequest, RemoteInfo } from './core';
import { authHeader, request } from './http';
import type { Pipeline, PipelineClient, PipelineJob, PipelineStatus, Workflow } from './pipelines';

type Fetch = typeof fetch;
const API = 'api-version=7.1';
const ts = (s?: string | null) => (s ? Math.floor(Date.parse(s) / 1000) || 0 : 0);
const stripRef = (r?: string) => (r ?? '').replace(/^refs\/heads\//, '');

/** HTML simples do work item → texto. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<li>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

abstract class AzureBase {
  protected readonly coll: string;
  protected readonly project: string;
  protected readonly repo: string;

  constructor(protected readonly remote: RemoteInfo, protected readonly token: string, apiBase?: string, protected readonly f: Fetch = fetch) {
    const a = remote.azure;
    if (!a) throw new HostError(0, 'Remoto do Azure DevOps sem organização/projeto.');
    this.coll = (apiBase || a.collection).replace(/\/+$/, '');
    this.project = a.project;
    this.repo = a.repo;
  }

  /** Endereço web da coleção (para links), mesmo quando a API aponta para outro lugar. */
  protected get web() {
    return this.remote.azure!.collection.replace(/\/+$/, '');
  }

  protected call(method: string, path: string, body?: unknown, raw = false, contentType = 'application/json') {
    const url = path.startsWith('http') ? path : `${this.coll}${path}`;
    return request(
      this.f,
      `${url}${url.includes('?') ? '&' : '?'}${API}`,
      {
        method,
        headers: { Authorization: authHeader(this.token, true), Accept: 'application/json', ...(body ? { 'Content-Type': contentType } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      },
      raw,
    );
  }

  protected get p() {
    return `/${encodeURIComponent(this.project)}`;
  }
}

export class AzureDevOpsClient extends AzureBase implements HostClient {
  readonly kind = 'azure';
  readonly label = 'PR';

  constructor(remote: RemoteInfo, token: string, apiBase?: string, f: Fetch = fetch, private readonly workItemType = 'Task') {
    super(remote, token, apiBase, f);
  }

  private get repoApi() {
    return `${this.p}/_apis/git/repositories/${encodeURIComponent(this.repo)}`;
  }

  private map(p: any): ChangeRequest {
    return {
      id: p.pullRequestId,
      ref: `!${p.pullRequestId}`,
      url: `${this.web}${this.p}/_git/${encodeURIComponent(this.repo)}/pullrequest/${p.pullRequestId}`,
      title: p.title,
      state: p.status === 'completed' ? 'merged' : p.status === 'active' ? (p.isDraft ? 'draft' : 'open') : 'closed',
      source: stripRef(p.sourceRefName),
      target: stripRef(p.targetRefName),
    };
  }

  async listOpen() {
    const r = await this.call('GET', `${this.repoApi}/pullrequests?searchCriteria.status=active&$top=100`);
    return (r.value ?? []).map((p: any) => this.map(p));
  }

  async findForBranch(branch: string) {
    const r = await this.call('GET', `${this.repoApi}/pullrequests?searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${branch}`)}&searchCriteria.status=all&$top=5`);
    return r.value?.[0] ? this.map(r.value[0]) : undefined;
  }

  async create(n: NewChangeRequest) {
    return this.map(
      await this.call('POST', `${this.repoApi}/pullrequests`, {
        sourceRefName: `refs/heads/${n.source}`,
        targetRefName: `refs/heads/${n.target}`,
        title: n.title,
        description: n.body,
        isDraft: n.draft,
      }),
    );
  }

  async whoami() {
    const r = await this.call('GET', '/_apis/connectionData');
    const u = r.authenticatedUser;
    if (!u || u.providerDisplayName === 'Anonymous') throw new HostError(401, '401: PAT não autenticou nenhum usuário');
    return u.providerDisplayName ?? u.customDisplayName ?? u.id;
  }

  private mapWorkItem(w: any): Issue {
    const f = w.fields ?? {};
    return {
      provider: 'azure',
      id: w.id,
      key: `AB#${w.id}`,
      title: f['System.Title'] ?? '',
      body: htmlToText(f['System.Description'] ?? ''),
      url: `${this.web}${this.p}/_workitems/edit/${w.id}`,
      labels: [f['System.WorkItemType'], f['System.State'], ...String(f['System.Tags'] ?? '').split(';').map((t: string) => t.trim())].filter(Boolean),
      assignee: f['System.AssignedTo']?.displayName,
      updated: ts(f['System.ChangedDate']),
      project: f['System.TeamProject'],
    };
  }

  /** Work items abertos do projeto (ou atribuídos a mim) via WIQL, e depois os campos em lote. */
  async listIssues(scope: IssueScope): Promise<Issue[]> {
    const where = [
      '[System.TeamProject] = @project',
      "[System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved', 'Completed')",
      ...(scope === 'mine' ? ['[System.AssignedTo] = @Me'] : []),
    ].join(' AND ');
    const r = await this.call('POST', `${this.p}/_apis/wit/wiql?$top=50`, {
      query: `SELECT [System.Id] FROM WorkItems WHERE ${where} ORDER BY [System.ChangedDate] DESC`,
    });
    const ids: number[] = (r.workItems ?? []).map((w: any) => w.id).slice(0, 50);
    if (!ids.length) return [];
    const fields = ['System.Id', 'System.Title', 'System.Description', 'System.State', 'System.WorkItemType', 'System.AssignedTo', 'System.ChangedDate', 'System.Tags', 'System.TeamProject'];
    const items = await this.call('GET', `${this.p}/_apis/wit/workitems?ids=${ids.join(',')}&fields=${fields.join(',')}`);
    return (items.value ?? []).map((w: any) => this.mapWorkItem(w));
  }

  /** Cria um work item (tipo configurável) com JSON Patch. */
  async createIssue(n: NewIssue): Promise<Issue> {
    const ops: { op: string; path: string; value: string }[] = [
      { op: 'add', path: '/fields/System.Title', value: n.title },
      { op: 'add', path: '/fields/System.Description', value: n.body.replace(/\n/g, '<br>') },
    ];
    if (n.labels?.length) ops.push({ op: 'add', path: '/fields/System.Tags', value: n.labels.join('; ') });
    const w = await this.call('POST', `${this.p}/_apis/wit/workitems/${encodeURIComponent('$' + this.workItemType)}`, ops, false, 'application/json-patch+json');
    return this.mapWorkItem(w);
  }
}

export function azureBuildStatus(status?: string, result?: string): PipelineStatus {
  if (status === 'inProgress') return 'running';
  if (status === 'notStarted' || status === 'postponed') return 'queued';
  if (status === 'cancelling') return 'canceled';
  switch (result) {
    case 'succeeded':
      return 'success';
    case 'partiallySucceeded':
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
    default:
      return 'other';
  }
}

/** Builds do Azure Pipelines. */
export class AzurePipelines extends AzureBase implements PipelineClient {
  readonly kind = 'azure';
  /** id do job (log) → build, para buscar o log depois. */
  private readonly buildOf = new Map<number, number>();

  async list(branch?: string): Promise<Pipeline[]> {
    const q = branch ? `&branchName=${encodeURIComponent(`refs/heads/${branch}`)}` : '';
    const r = await this.call('GET', `${this.p}/_apis/build/builds?$top=30&queryOrder=queueTimeDescending${q}`);
    return (r.value ?? []).map(
      (b: any): Pipeline => ({
        id: b.id,
        provider: 'azure',
        name: b.definition?.name ?? `Build ${b.buildNumber}`,
        branch: stripRef(b.sourceBranch),
        sha: b.sourceVersion ?? '',
        status: azureBuildStatus(b.status, b.result),
        event: b.reason ?? '',
        url: b._links?.web?.href ?? `${this.web}${this.p}/_build/results?buildId=${b.id}`,
        createdAt: ts(b.queueTime),
        updatedAt: ts(b.finishTime ?? b.startTime ?? b.queueTime),
        durationSec: b.startTime && b.finishTime ? Math.round((Date.parse(b.finishTime) - Date.parse(b.startTime)) / 1000) : undefined,
      }),
    );
  }

  async jobs(p: Pipeline): Promise<PipelineJob[]> {
    const r = await this.call('GET', `${this.p}/_apis/build/builds/${p.id}/timeline`);
    return (r.records ?? [])
      .filter((x: any) => x.type === 'Job')
      .map((x: any, i: number): PipelineJob => {
        const id = x.log?.id ?? p.id * 1000 + i;
        this.buildOf.set(id, p.id);
        return {
          id,
          name: x.name,
          status: azureBuildStatus(x.state === 'completed' ? 'completed' : x.state === 'inProgress' ? 'inProgress' : 'notStarted', x.result),
          url: p.url,
          durationSec: x.startTime && x.finishTime ? Math.round((Date.parse(x.finishTime) - Date.parse(x.startTime)) / 1000) : undefined,
        };
      });
  }

  async retry(p: Pipeline) {
    await this.call('PATCH', `${this.p}/_apis/build/builds/${p.id}?retry=true`, {});
  }

  async cancel(p: Pipeline) {
    await this.call('PATCH', `${this.p}/_apis/build/builds/${p.id}`, { status: 'cancelling' });
  }

  async log(job: PipelineJob): Promise<string> {
    const build = this.buildOf.get(job.id);
    if (!build) throw new HostError(0, 'Abra os jobs do build antes de ver o log.');
    return this.call('GET', `${this.p}/_apis/build/builds/${build}/logs/${job.id}`, undefined, true);
  }

  async workflows(): Promise<Workflow[]> {
    const r = await this.call('GET', `${this.p}/_apis/build/definitions?$top=100`);
    return (r.value ?? []).map((d: any) => ({ id: d.id, name: d.name, path: d.path ?? '' }));
  }

  async trigger(branch: string, workflowId?: number) {
    if (!workflowId) throw new HostError(0, 'Escolha qual pipeline (definição) rodar.');
    await this.call('POST', `${this.p}/_apis/build/builds`, { definition: { id: workflowId }, sourceBranch: `refs/heads/${branch}` });
  }

  async play(): Promise<void> {
    throw new HostError(0, 'Aprovações e etapas manuais do Azure Pipelines são feitas pelo navegador.');
  }
}
