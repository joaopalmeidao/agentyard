/**
 * Bitbucket Cloud (bitbucket.org) e Bitbucket Server/Data Center, sem API do VS Code.
 * Cloud: /2.0/repositories/{workspace}/{repo}; Server: /rest/api/1.0/projects/{PROJ}/repos/{repo}.
 */
import type { Issue, IssueScope, NewIssue } from '../issues/core';
import { ChangeRequest, HostClient, HostError, NewChangeRequest, RemoteInfo } from './core';
import { authHeader, request } from './http';
import type { Pipeline, PipelineClient, PipelineJob, PipelineStatus, Workflow } from './pipelines';

type Fetch = typeof fetch;
const ts = (s?: string | null) => (s ? Math.floor(Date.parse(s) / 1000) || 0 : 0);

abstract class BitbucketBase {
  protected readonly api: string;

  constructor(protected readonly remote: RemoteInfo, protected readonly token: string, apiBase?: string, protected readonly f: Fetch = fetch) {
    this.api = (apiBase || remote.apiRoot || (remote.flavor === 'cloud' ? 'https://api.bitbucket.org/2.0' : `${remote.webBase}/rest/api/1.0`)).replace(/\/+$/, '');
  }

  protected call(method: string, url: string, body?: unknown, raw = false) {
    return request(
      this.f,
      url.startsWith('http') ? url : `${this.api}${url}`,
      {
        method,
        headers: { Authorization: authHeader(this.token), Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      },
      raw,
    );
  }
}

// ---------- Cloud ----------

export class BitbucketCloudClient extends BitbucketBase implements HostClient {
  readonly kind = 'bitbucket';
  readonly label = 'PR';
  private readonly repo = this.remote.projectPath;
  private me?: { uuid: string; name: string };

  private map(p: any): ChangeRequest {
    return {
      id: p.id,
      ref: `#${p.id}`,
      url: p.links?.html?.href ?? `${this.remote.webBase}/${this.repo}/pull-requests/${p.id}`,
      title: p.title,
      state: p.state === 'MERGED' ? 'merged' : p.state === 'OPEN' ? (p.draft ? 'draft' : 'open') : 'closed',
      source: p.source?.branch?.name,
      target: p.destination?.branch?.name,
    };
  }

  async listOpen() {
    const r = await this.call('GET', `/repositories/${this.repo}/pullrequests?state=OPEN&pagelen=50`);
    return (r.values ?? []).map((p: any) => this.map(p));
  }

  async findForBranch(branch: string) {
    const q = encodeURIComponent(`source.branch.name="${branch.replace(/"/g, '\\"')}"`);
    const r = await this.call('GET', `/repositories/${this.repo}/pullrequests?q=${q}&state=OPEN&state=MERGED&state=DECLINED&sort=-updated_on&pagelen=5`);
    return r.values?.[0] ? this.map(r.values[0]) : undefined;
  }

  async create(n: NewChangeRequest) {
    return this.map(
      await this.call('POST', `/repositories/${this.repo}/pullrequests`, {
        title: n.title,
        description: n.body,
        source: { branch: { name: n.source } },
        destination: { branch: { name: n.target } },
        draft: n.draft,
      }),
    );
  }

  private async user() {
    if (!this.me) {
      const u = await this.call('GET', '/user');
      this.me = { uuid: u.uuid, name: u.username ?? u.nickname ?? u.display_name };
    }
    return this.me;
  }

  async whoami() {
    return (await this.user()).name;
  }

  private mapIssue(i: any): Issue {
    return {
      provider: 'bitbucket',
      id: i.id,
      key: `#${i.id}`,
      title: i.title,
      body: i.content?.raw ?? '',
      url: i.links?.html?.href ?? `${this.remote.webBase}/${this.repo}/issues/${i.id}`,
      labels: [i.kind, i.priority, i.state].filter(Boolean),
      assignee: i.assignee?.display_name,
      updated: ts(i.updated_on),
    };
  }

  /** O issue tracker é opcional no Cloud; desativado, a API responde 404 e a lista fica vazia. */
  async listIssues(scope: IssueScope): Promise<Issue[]> {
    let q = '(state="new" OR state="open")';
    if (scope === 'mine') q += ` AND assignee.uuid="${(await this.user()).uuid}"`;
    try {
      const r = await this.call('GET', `/repositories/${this.repo}/issues?q=${encodeURIComponent(q)}&sort=-updated_on&pagelen=50`);
      return (r.values ?? []).map((i: any) => this.mapIssue(i));
    } catch (e) {
      if (e instanceof HostError && e.status === 404) return [];
      throw e;
    }
  }

  async createIssue(n: NewIssue): Promise<Issue> {
    try {
      return this.mapIssue(await this.call('POST', `/repositories/${this.repo}/issues`, { title: n.title, content: { raw: n.body }, kind: 'task' }));
    } catch (e) {
      if (e instanceof HostError && e.status === 404) throw new HostError(404, 'O issue tracker está desativado neste repositório do Bitbucket (Repository settings → Issue tracker).');
      throw e;
    }
  }
}

// ---------- Server / Data Center ----------

export class BitbucketServerClient extends BitbucketBase implements HostClient {
  readonly kind = 'bitbucket';
  readonly label = 'PR';

  private get base() {
    const [project, repo] = this.remote.projectPath.split('/');
    return `/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo)}`;
  }

  private map(p: any): ChangeRequest {
    return {
      id: p.id,
      ref: `#${p.id}`,
      url: p.links?.self?.[0]?.href ?? `${this.remote.webBase}/projects/${this.remote.projectPath.split('/')[0]}/repos/${this.remote.projectPath.split('/')[1]}/pull-requests/${p.id}`,
      title: p.title,
      state: p.state === 'MERGED' ? 'merged' : p.state === 'OPEN' ? (p.draft ? 'draft' : 'open') : 'closed',
      source: p.fromRef?.displayId,
      target: p.toRef?.displayId,
    };
  }

  async listOpen() {
    const r = await this.call('GET', `${this.base}/pull-requests?state=OPEN&limit=50`);
    return (r.values ?? []).map((p: any) => this.map(p));
  }

  async findForBranch(branch: string) {
    const r = await this.call('GET', `${this.base}/pull-requests?state=ALL&direction=OUTGOING&at=${encodeURIComponent(`refs/heads/${branch}`)}&limit=5`);
    return r.values?.[0] ? this.map(r.values[0]) : undefined;
  }

  async create(n: NewChangeRequest) {
    return this.map(
      await this.call('POST', `${this.base}/pull-requests`, {
        title: n.title,
        description: n.body,
        fromRef: { id: `refs/heads/${n.source}` },
        toRef: { id: `refs/heads/${n.target}` },
        ...(n.draft ? { draft: true } : {}),
      }),
    );
  }

  /** Servlet de identidade do Bitbucket Server: devolve o nome do usuário em texto puro. */
  async whoami() {
    const name = await this.call('GET', `${this.remote.webBase}/plugins/servlet/applinks/whoami`, undefined, true);
    if (!String(name).trim()) throw new HostError(401, '401: token não identificou nenhum usuário');
    return String(name).trim();
  }

  /** O Bitbucket Server não tem issues (normalmente usa Jira). */
  async listIssues(): Promise<Issue[]> {
    return [];
  }

  async createIssue(): Promise<Issue> {
    throw new HostError(0, 'O Bitbucket Server não tem issues; conecte o Jira na view Issues.');
  }
}

export function bitbucketClient(remote: RemoteInfo, token: string, apiBase?: string, f: Fetch = fetch): HostClient {
  return remote.flavor === 'cloud' ? new BitbucketCloudClient(remote, token, apiBase, f) : new BitbucketServerClient(remote, token, apiBase, f);
}

// ---------- Pipelines ----------

export function bitbucketPipelineStatus(state?: string, result?: string): PipelineStatus {
  switch (state) {
    case 'PENDING':
      return 'queued';
    case 'IN_PROGRESS':
    case 'RUNNING':
      return 'running';
    case 'PAUSED':
    case 'HALTED':
      return 'manual';
  }
  switch (result) {
    case 'SUCCESSFUL':
      return 'success';
    case 'FAILED':
    case 'ERROR':
      return 'failed';
    case 'STOPPED':
      return 'canceled';
    case 'SKIPPED':
    case 'NOT_RUN':
      return 'skipped';
    default:
      return 'other';
  }
}

/** Bitbucket Pipelines (Cloud). Re-executar = disparar de novo para a mesma branch. */
export class BitbucketCloudPipelines extends BitbucketBase implements PipelineClient {
  readonly kind = 'bitbucket';
  /** build_number → uuid (a API de passos e logs usa o uuid). */
  private readonly uuids = new Map<number, string>();
  private readonly stepOf = new Map<number, { pipeline: string; step: string }>();

  async list(branch?: string): Promise<Pipeline[]> {
    const q = branch ? `&target.branch=${encodeURIComponent(branch)}` : '';
    const r = await this.call('GET', `/repositories/${this.remote.projectPath}/pipelines/?sort=-created_on&pagelen=30${q}`);
    return (r.values ?? []).map((p: any): Pipeline => {
      this.uuids.set(p.build_number, p.uuid);
      return {
        id: p.build_number,
        provider: 'bitbucket',
        name: `Pipeline #${p.build_number}`,
        branch: p.target?.ref_name ?? '',
        sha: p.target?.commit?.hash ?? '',
        status: bitbucketPipelineStatus(p.state?.name, p.state?.result?.name),
        event: String(p.trigger?.name ?? '').toLowerCase(),
        url: `${this.remote.webBase}/${this.remote.projectPath}/pipelines/results/${p.build_number}`,
        createdAt: ts(p.created_on),
        updatedAt: ts(p.completed_on ?? p.created_on),
        durationSec: p.duration_in_seconds ?? undefined,
      };
    });
  }

  private uuid(p: Pipeline) {
    return this.uuids.get(p.id) ?? `${p.id}`;
  }

  async jobs(p: Pipeline): Promise<PipelineJob[]> {
    const r = await this.call('GET', `/repositories/${this.remote.projectPath}/pipelines/${encodeURIComponent(this.uuid(p))}/steps/`);
    return (r.values ?? []).map((s: any, i: number): PipelineJob => {
      const id = p.id * 1000 + i;
      this.stepOf.set(id, { pipeline: this.uuid(p), step: s.uuid });
      return {
        id,
        name: s.name ?? `Passo ${i + 1}`,
        status: bitbucketPipelineStatus(s.state?.name, s.state?.result?.name),
        url: p.url,
        durationSec: s.duration_in_seconds ?? undefined,
      };
    });
  }

  async retry(p: Pipeline) {
    await this.trigger(p.branch);
  }

  async cancel(p: Pipeline) {
    await this.call('POST', `/repositories/${this.remote.projectPath}/pipelines/${encodeURIComponent(this.uuid(p))}/stopPipeline`);
  }

  async log(job: PipelineJob): Promise<string> {
    const s = this.stepOf.get(job.id);
    if (!s) throw new HostError(0, 'Abra os passos do pipeline antes de ver o log.');
    return this.call('GET', `/repositories/${this.remote.projectPath}/pipelines/${encodeURIComponent(s.pipeline)}/steps/${encodeURIComponent(s.step)}/log`, undefined, true);
  }

  async workflows(): Promise<Workflow[]> {
    return [];
  }

  async trigger(branch: string) {
    await this.call('POST', `/repositories/${this.remote.projectPath}/pipelines/`, {
      target: { type: 'pipeline_ref_target', ref_type: 'branch', ref_name: branch },
    });
  }

  async play(): Promise<void> {
    throw new HostError(0, 'Passos manuais do Bitbucket Pipelines são iniciados pelo navegador.');
  }
}

export function bitbucketBuildStatus(state?: string): PipelineStatus {
  return state === 'SUCCESSFUL' ? 'success' : state === 'FAILED' ? 'failed' : state === 'INPROGRESS' ? 'running' : 'other';
}

/**
 * Bitbucket Server: não tem pipelines próprios; mostra os status de build (Jenkins, Bamboo…) que
 * os servidores de CI registram no último commit de cada branch. Somente leitura.
 */
export class BitbucketServerBuilds extends BitbucketBase implements PipelineClient {
  readonly kind = 'bitbucket';

  private get repoBase() {
    const [project, repo] = this.remote.projectPath.split('/');
    return `/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo)}`;
  }

  private buildApi(sha: string) {
    return `${this.remote.webBase}/rest/build-status/1.0/commits/${sha}`;
  }

  async list(branch?: string): Promise<Pipeline[]> {
    const q = branch ? `filterText=${encodeURIComponent(branch)}&limit=5` : 'orderBy=MODIFICATION&limit=10';
    const r = await this.call('GET', `${this.repoBase}/branches?${q}`);
    const branches = (r.values ?? []).filter((b: any) => !branch || b.displayId === branch);
    const out: Pipeline[] = [];
    for (const b of branches) {
      const st = await this.call('GET', this.buildApi(b.latestCommit));
      for (const s of st.values ?? []) {
        out.push({
          id: Number(s.dateAdded) || out.length + 1,
          provider: 'bitbucket',
          name: s.name || s.key,
          branch: b.displayId,
          sha: b.latestCommit,
          status: bitbucketBuildStatus(s.state),
          event: 'build',
          url: s.url,
          createdAt: Math.floor((Number(s.dateAdded) || 0) / 1000),
          updatedAt: Math.floor((Number(s.dateAdded) || 0) / 1000),
        });
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  async jobs(): Promise<PipelineJob[]> {
    return [];
  }

  private readOnly(): never {
    throw new HostError(0, 'No Bitbucket Server os builds vêm do servidor de CI (Jenkins, Bamboo…); abra-o pelo link do build.');
  }

  async retry() {
    this.readOnly();
  }

  async cancel() {
    this.readOnly();
  }

  async log(): Promise<string> {
    return this.readOnly();
  }

  async workflows(): Promise<Workflow[]> {
    return [];
  }

  async trigger() {
    this.readOnly();
  }

  async play() {
    this.readOnly();
  }
}

export function bitbucketPipelines(remote: RemoteInfo, token: string, apiBase?: string, f: Fetch = fetch): PipelineClient {
  return remote.flavor === 'cloud' ? new BitbucketCloudPipelines(remote, token, apiBase, f) : new BitbucketServerBuilds(remote, token, apiBase, f);
}
