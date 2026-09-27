/**
 * Pipelines do GitHub Actions e do GitLab CI (inclusive self-hosted), via REST e sem depender da
 * API do VS Code, para ser testado contra um servidor falso (test/pipelines.test.js).
 */
import type { HostKind, RemoteInfo } from './core';
import { HostError } from './core';

export type PipelineStatus = 'queued' | 'running' | 'success' | 'failed' | 'canceled' | 'skipped' | 'manual' | 'other';

export interface Pipeline {
  id: number;
  provider: HostKind;
  /** Nome do workflow (GitHub) ou "Pipeline #id" (GitLab). */
  name: string;
  branch: string;
  sha: string;
  status: PipelineStatus;
  /** push, pull_request, schedule, web, merge_request_event… */
  event: string;
  url: string;
  createdAt: number;
  updatedAt: number;
  durationSec?: number;
}

export interface PipelineJob {
  id: number;
  name: string;
  stage?: string;
  status: PipelineStatus;
  url: string;
  durationSec?: number;
}

export interface Workflow {
  id: number;
  name: string;
  path: string;
}

export interface PipelineClient {
  readonly kind: HostKind;
  list(branch?: string): Promise<Pipeline[]>;
  jobs(p: Pipeline): Promise<PipelineJob[]>;
  /** Re-executa o pipeline inteiro, ou só os jobs que falharam (no GitLab, retry já é só dos falhos). */
  retry(p: Pipeline, onlyFailed?: boolean): Promise<void>;
  cancel(p: Pipeline): Promise<void>;
  log(job: PipelineJob): Promise<string>;
  /** Workflows que podem ser disparados (GitHub); vazio no GitLab, onde um pipeline novo roda o .gitlab-ci.yml. */
  workflows(): Promise<Workflow[]>;
  /** Dispara um pipeline para a branch; no GitHub, `workflowId` é obrigatório (workflow_dispatch). */
  trigger(branch: string, workflowId?: number): Promise<void>;
  /** Job manual do GitLab. */
  play(job: PipelineJob): Promise<void>;
}

type Fetch = typeof fetch;
const ts = (s?: string | null) => (s ? Math.floor(Date.parse(s) / 1000) : 0);

async function request(f: Fetch, url: string, init: RequestInit, raw = false): Promise<any> {
  let res: Response;
  try {
    res = await f(url, init);
  } catch (e) {
    throw new HostError(0, `Não consegui falar com ${new URL(url).host}: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text || res.statusText;
    try {
      const b = JSON.parse(text);
      msg = b.message || b.error || msg;
    } catch {
      // corpo não é JSON
    }
    throw new HostError(res.status, `${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  if (raw) return text;
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return text;
  }
}

/** status + conclusion do GitHub (run ou job) → status comum. */
export function githubStatus(status: string | null, conclusion: string | null): PipelineStatus {
  if (status !== 'completed') {
    if (status === 'in_progress') return 'running';
    if (status === 'waiting' && conclusion === 'action_required') return 'manual';
    return 'queued';
  }
  switch (conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return 'failed';
    case 'cancelled':
      return 'canceled';
    case 'skipped':
    case 'neutral':
    case 'stale':
      return 'skipped';
    case 'action_required':
      return 'manual';
    default:
      return 'other';
  }
}

export function gitlabStatus(s: string): PipelineStatus {
  switch (s) {
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'pending':
    case 'scheduled':
      return 'queued';
    case 'running':
      return 'running';
    case 'success':
      return 'success';
    case 'failed':
      return 'failed';
    case 'canceled':
    case 'canceling':
      return 'canceled';
    case 'skipped':
      return 'skipped';
    case 'manual':
      return 'manual';
    default:
      return 'other';
  }
}

export class GitHubPipelines implements PipelineClient {
  readonly kind = 'github';
  private readonly api: string;

  constructor(private readonly remote: RemoteInfo, private readonly token: string, apiBase?: string, private readonly f: Fetch = fetch) {
    this.api = (apiBase || (remote.host === 'github.com' ? 'https://api.github.com' : `${remote.webBase}/api/v3`)).replace(/\/+$/, '');
  }

  private req(method: string, p: string, body?: unknown, raw = false) {
    return request(
      this.f,
      `${this.api}/repos/${this.remote.projectPath}${p}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'worktree-graph',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      },
      raw,
    );
  }

  async list(branch?: string): Promise<Pipeline[]> {
    const q = new URLSearchParams({ per_page: '30' });
    if (branch) q.set('branch', branch);
    const r = await this.req('GET', `/actions/runs?${q}`);
    return (r?.workflow_runs ?? []).map((w: any): Pipeline => {
      const status = githubStatus(w.status, w.conclusion);
      const start = ts(w.run_started_at) || ts(w.created_at);
      const end = ts(w.updated_at);
      return {
        id: w.id,
        provider: 'github',
        name: w.name || w.display_title || 'Workflow',
        branch: w.head_branch ?? '',
        sha: w.head_sha ?? '',
        status,
        event: w.event ?? '',
        url: w.html_url,
        createdAt: ts(w.created_at),
        updatedAt: end,
        durationSec: status !== 'queued' && status !== 'running' && end >= start ? end - start : undefined,
      };
    });
  }

  async jobs(p: Pipeline): Promise<PipelineJob[]> {
    const r = await this.req('GET', `/actions/runs/${p.id}/jobs?per_page=100`);
    return (r?.jobs ?? []).map((j: any): PipelineJob => {
      const a = ts(j.started_at);
      const b = ts(j.completed_at);
      return { id: j.id, name: j.name, status: githubStatus(j.status, j.conclusion), url: j.html_url, durationSec: a && b >= a ? b - a : undefined };
    });
  }

  async retry(p: Pipeline, onlyFailed = false) {
    await this.req('POST', `/actions/runs/${p.id}/${onlyFailed ? 'rerun-failed-jobs' : 'rerun'}`);
  }

  async cancel(p: Pipeline) {
    await this.req('POST', `/actions/runs/${p.id}/cancel`);
  }

  /** A API responde 302 para um arquivo de texto temporário; o fetch segue o redirect (sem o token). */
  async log(job: PipelineJob): Promise<string> {
    return this.req('GET', `/actions/jobs/${job.id}/logs`, undefined, true);
  }

  async workflows(): Promise<Workflow[]> {
    const r = await this.req('GET', '/actions/workflows?per_page=100');
    return (r?.workflows ?? []).filter((w: any) => w.state === 'active').map((w: any) => ({ id: w.id, name: w.name, path: w.path }));
  }

  async trigger(branch: string, workflowId?: number) {
    if (!workflowId) throw new HostError(0, 'Escolha um workflow com gatilho workflow_dispatch.');
    await this.req('POST', `/actions/workflows/${workflowId}/dispatches`, { ref: branch });
  }

  async play(): Promise<void> {
    throw new HostError(0, 'O GitHub Actions não tem jobs manuais; use re-executar.');
  }
}

export class GitLabPipelines implements PipelineClient {
  readonly kind = 'gitlab';
  private readonly api: string;
  private readonly project: string;

  constructor(private readonly remote: RemoteInfo, private readonly token: string, apiBase?: string, private readonly f: Fetch = fetch) {
    this.api = (apiBase || `${remote.webBase}/api/v4`).replace(/\/+$/, '');
    this.project = encodeURIComponent(remote.projectPath);
  }

  private req(method: string, p: string, body?: unknown, raw = false) {
    return request(
      this.f,
      `${this.api}/projects/${this.project}${p}`,
      { method, headers: { 'PRIVATE-TOKEN': this.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined },
      raw,
    );
  }

  async list(branch?: string): Promise<Pipeline[]> {
    const q = new URLSearchParams({ per_page: '30', order_by: 'id', sort: 'desc' });
    if (branch) q.set('ref', branch);
    const r = await this.req('GET', `/pipelines?${q}`);
    return (r ?? []).map((p: any): Pipeline => {
      const status = gitlabStatus(p.status);
      const a = ts(p.created_at);
      const b = ts(p.updated_at);
      return {
        id: p.id,
        provider: 'gitlab',
        name: `Pipeline #${p.iid ?? p.id}`,
        branch: p.ref ?? '',
        sha: p.sha ?? '',
        status,
        event: p.source ?? '',
        url: p.web_url,
        createdAt: a,
        updatedAt: b,
        durationSec: status !== 'queued' && status !== 'running' && b >= a ? b - a : undefined,
      };
    });
  }

  async jobs(p: Pipeline): Promise<PipelineJob[]> {
    const r = await this.req('GET', `/pipelines/${p.id}/jobs?per_page=100&include_retried=false`);
    return (r ?? []).map((j: any): PipelineJob => ({
      id: j.id,
      name: j.name,
      stage: j.stage,
      status: gitlabStatus(j.status),
      url: j.web_url,
      durationSec: typeof j.duration === 'number' ? Math.round(j.duration) : undefined,
    }));
  }

  async retry(p: Pipeline) {
    await this.req('POST', `/pipelines/${p.id}/retry`);
  }

  async cancel(p: Pipeline) {
    await this.req('POST', `/pipelines/${p.id}/cancel`);
  }

  async log(job: PipelineJob): Promise<string> {
    return this.req('GET', `/jobs/${job.id}/trace`, undefined, true);
  }

  async workflows(): Promise<Workflow[]> {
    return [];
  }

  async trigger(branch: string) {
    await this.req('POST', '/pipeline', { ref: branch });
  }

  async play(job: PipelineJob) {
    await this.req('POST', `/jobs/${job.id}/play`);
  }
}

export function pipelineClient(remote: RemoteInfo, token: string, apiBase?: string, f: Fetch = fetch): PipelineClient {
  return remote.kind === 'github' ? new GitHubPipelines(remote, token, apiBase, f) : new GitLabPipelines(remote, token, apiBase, f);
}

/** Últimas `n` linhas de um log, sem os códigos de cor ANSI. */
export function tailLog(text: string, n = 150): string {
  // eslint-disable-next-line no-control-regex
  const lines = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/);
  return lines.slice(-n).join('\n');
}

export function statusIcon(s: PipelineStatus): string {
  return { success: '✓', failed: '✗', running: '⟳', queued: '…', canceled: '⊘', skipped: '↷', manual: '▶', other: '?' }[s];
}

export function formatDuration(sec?: number): string {
  if (sec === undefined) return '';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m${String(sec % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}
