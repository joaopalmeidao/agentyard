/**
 * Navegador de pull requests / merge requests, sem depender da API do VS Code (testável contra um
 * servidor falso em test/prs.test.js). GitHub e GitLab completos; Bitbucket e Azure DevOps usam a
 * listagem que os clientes de src/hosting já têm.
 */
import { ChangeRequest, githubReviewDecision, HostClient, HostError, HostKind, RemoteInfo, ReviewStatus } from '../hosting/core';
import { request } from '../hosting/http';
import { t } from '../i18n';

type Fetch = typeof fetch;

export interface PullRequestInfo extends ChangeRequest {
  author: string;
  createdAt: number;
  updatedAt: number;
  mergedAt?: number;
  headSha?: string;
  /** A API disse que há conflito com o destino. */
  conflicts?: boolean;
  /** Vem de um fork (GitHub): a branch não existe no remoto do repositório. */
  fork?: boolean;
  /** Pessoas com revisão pedida. */
  reviewers: string[];
  /** GitHub: id global para a API GraphQL (rascunho ↔ pronto). */
  nodeId?: string;
}

export interface PrGroups {
  mine: PullRequestInfo[];
  reviewRequested: PullRequestInfo[];
  open: PullRequestInfo[];
  recentlyMerged: PullRequestInfo[];
}

export interface PrFile {
  path: string;
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'other';
  additions: number;
  deletions: number;
  previousPath?: string;
}

export interface PrComment {
  author: string;
  body: string;
  at: number;
  url?: string;
  path?: string;
}

export interface PrCheck {
  name: string;
  status: 'success' | 'failed' | 'running' | 'pending' | 'skipped' | 'other';
  url?: string;
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

/** Conversa de revisão numa linha do código (thread do GitHub, discussão do GitLab). */
export interface ReviewThread {
  id: string;
  path?: string;
  line?: number;
  resolved: boolean;
  /** O código em volta mudou depois do comentário. */
  outdated?: boolean;
  comments: { author: string; body: string; at: number; url?: string }[];
}

/** O que a revisão pediu: conversas nas linhas e revisões com texto geral. */
export interface PrFeedback {
  threads: ReviewThread[];
  reviews: { author: string; state: string; body: string; at: number }[];
}

export interface PrBrowser {
  readonly kind: HostKind;
  readonly label: 'PR' | 'MR';
  /** O que dá para fazer além de listar. */
  readonly can: { files: boolean; comments: boolean; checks: boolean; merge: boolean; draft: boolean; reviewRequested: boolean; threads: boolean };
  whoami(): Promise<string>;
  groups(me: string, recentDays?: number): Promise<PrGroups>;
  files(pr: PullRequestInfo): Promise<PrFile[]>;
  comments(pr: PullRequestInfo): Promise<PrComment[]>;
  checks(pr: PullRequestInfo): Promise<PrCheck[]>;
  merge(pr: PullRequestInfo, method: MergeMethod): Promise<void>;
  setDraft(pr: PullRequestInfo, draft: boolean): Promise<void>;
  /** Conversas e revisões (para mandar ao agente). */
  feedback(pr: PullRequestInfo): Promise<PrFeedback>;
  /** Responde (se `reply`) e marca a conversa como resolvida. */
  resolveThread(pr: PullRequestInfo, id: string, reply?: string): Promise<void>;
  /** Troca a branch de destino (PR empilhado cujo pai já entrou na base). */
  retarget(pr: PullRequestInfo, target: string): Promise<void>;
}

const ts = (s?: string | null) => (s ? Math.floor(new Date(s).getTime() / 1000) : 0);
const DAY = 86400;

/** Texto curto para listas: sem markdown pesado, uma linha só. */
export function shortText(s: string, max = 140): string {
  const text = (s ?? '')
    .replace(/```[\s\S]*?```/g, t('[code]'))
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Agrupa: "meus" (autor), "pedem minha revisão", todos os abertos e mesclados nos últimos dias. */
export function groupPrs(open: PullRequestInfo[], merged: PullRequestInfo[], me: string, now = Date.now() / 1000, recentDays = 7): PrGroups {
  const lower = me.toLowerCase();
  return {
    mine: open.filter(p => p.author.toLowerCase() === lower),
    reviewRequested: open.filter(p => p.author.toLowerCase() !== lower && p.reviewers.some(r => r.toLowerCase() === lower)),
    open,
    recentlyMerged: merged.filter(p => p.mergedAt && now - p.mergedAt <= recentDays * DAY).sort((a, b) => (b.mergedAt ?? 0) - (a.mergedAt ?? 0)),
  };
}

/** Status de check-run/status do GitHub e de job/pipeline do GitLab → um conjunto só. */
export function checkStatus(status?: string, conclusion?: string | null): PrCheck['status'] {
  const s = (conclusion || status || '').toLowerCase();
  if (['success', 'passed', 'neutral'].includes(s)) return 'success';
  if (['failure', 'failed', 'error', 'timed_out', 'action_required', 'cancelled', 'canceled'].includes(s)) return 'failed';
  if (['in_progress', 'running'].includes(s)) return 'running';
  if (['queued', 'pending', 'waiting', 'created', 'preparing', 'waiting_for_resource', 'scheduled', 'requested', 'manual'].includes(s)) return 'pending';
  if (s === 'skipped') return 'skipped';
  return 'other';
}

/** Linhas +/− de um diff unificado (o GitLab não manda os números prontos). */
export function countDiff(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const l of (diff ?? '').split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) additions++;
    else if (l.startsWith('-') && !l.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

async function limited<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------- GitHub

export class GitHubPrBrowser implements PrBrowser {
  readonly kind = 'github';
  readonly label = 'PR';
  readonly can = { files: true, comments: true, checks: true, merge: true, draft: true, reviewRequested: true, threads: true };
  private readonly api: string;
  private readonly graphql: string;

  constructor(private readonly remote: RemoteInfo, private readonly token: string, apiBase?: string, private readonly f: Fetch = fetch) {
    this.api = (apiBase || (remote.host === 'github.com' ? 'https://api.github.com' : `${remote.webBase}/api/v3`)).replace(/\/+$/, '');
    this.graphql = this.api.endsWith('/api/v3') ? this.api.replace(/\/api\/v3$/, '/api/graphql') : `${this.api}/graphql`;
  }

  private headers(body?: boolean) {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'agentyard',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  private req(method: string, p: string, body?: unknown, abs = false) {
    return request(this.f, abs ? p : `${this.api}/repos/${this.remote.projectPath}${p}`, {
      method,
      headers: this.headers(!!body),
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  map(p: any): PullRequestInfo {
    const fork = !!p.head?.repo && p.head.repo.full_name?.toLowerCase() !== this.remote.projectPath.toLowerCase();
    return {
      id: p.number,
      ref: `#${p.number}`,
      url: p.html_url,
      title: p.title,
      state: p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : p.draft ? 'draft' : 'open',
      source: p.head?.ref,
      target: p.base?.ref,
      author: p.user?.login ?? '?',
      createdAt: ts(p.created_at),
      updatedAt: ts(p.updated_at),
      mergedAt: p.merged_at ? ts(p.merged_at) : undefined,
      headSha: p.head?.sha,
      conflicts: p.mergeable_state === 'dirty' ? true : undefined,
      fork,
      reviewers: (p.requested_reviewers ?? []).map((u: any) => u.login).filter(Boolean),
      nodeId: p.node_id,
    };
  }

  async whoami() {
    const u = await this.req('GET', `${this.api}/user`, undefined, true);
    return u.login as string;
  }

  async groups(me: string, recentDays = 7): Promise<PrGroups> {
    const [open, closed] = await Promise.all([
      this.req('GET', '/pulls?state=open&per_page=100&sort=updated&direction=desc') as Promise<any[]>,
      this.req('GET', '/pulls?state=closed&per_page=50&sort=updated&direction=desc') as Promise<any[]>,
    ]);
    const openPrs = open.map(p => this.map(p));
    // revisão: só dos abertos que não são rascunho, 4 de cada vez
    await limited(openPrs.filter(p => p.state === 'open').slice(0, 40), 4, async p => {
      try {
        p.review = githubReviewDecision(await this.req('GET', `/pulls/${p.id}/reviews?per_page=100`));
      } catch {
        // sem permissão para ver revisões
      }
    });
    return groupPrs(openPrs, closed.filter(p => p.merged_at).map(p => this.map(p)), me, Date.now() / 1000, recentDays);
  }

  async files(pr: PullRequestInfo): Promise<PrFile[]> {
    const list: any[] = await this.req('GET', `/pulls/${pr.id}/files?per_page=100`);
    return list.map(f => ({
      path: f.filename,
      status: (['added', 'modified', 'removed', 'renamed'].includes(f.status) ? f.status : 'other') as PrFile['status'],
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      previousPath: f.previous_filename,
    }));
  }

  async comments(pr: PullRequestInfo): Promise<PrComment[]> {
    const [issue, review] = await Promise.all([
      this.req('GET', `/issues/${pr.id}/comments?per_page=50`) as Promise<any[]>,
      this.req('GET', `/pulls/${pr.id}/comments?per_page=50`) as Promise<any[]>,
    ]);
    const all: PrComment[] = [
      ...issue.map(c => ({ author: c.user?.login ?? '?', body: c.body ?? '', at: ts(c.created_at), url: c.html_url })),
      ...review.map(c => ({ author: c.user?.login ?? '?', body: c.body ?? '', at: ts(c.created_at), url: c.html_url, path: c.path })),
    ];
    return all.sort((a, b) => b.at - a.at).slice(0, 20);
  }

  async checks(pr: PullRequestInfo): Promise<PrCheck[]> {
    if (!pr.headSha) return [];
    const [runs, status] = await Promise.all([
      this.req('GET', `/commits/${pr.headSha}/check-runs?per_page=100`).catch(() => ({ check_runs: [] })),
      this.req('GET', `/commits/${pr.headSha}/status`).catch(() => ({ statuses: [] })),
    ]);
    return [
      ...(runs.check_runs ?? []).map((r: any) => ({ name: r.name, status: checkStatus(r.status === 'completed' ? undefined : r.status, r.conclusion), url: r.html_url })),
      ...(status.statuses ?? []).map((s: any) => ({ name: s.context, status: checkStatus(s.state), url: s.target_url })),
    ];
  }

  async merge(pr: PullRequestInfo, method: MergeMethod) {
    await this.req('PUT', `/pulls/${pr.id}/merge`, { merge_method: method });
  }

  async setDraft(pr: PullRequestInfo, draft: boolean) {
    if (!pr.nodeId) throw new HostError(0, t('GitHub did not return the PR id needed to toggle draft.'));
    const mutation = draft
      ? 'mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){pullRequest{isDraft}}}'
      : 'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}';
    await this.gql(mutation, { id: pr.nodeId });
  }

  private async gql(query: string, variables: Record<string, unknown>): Promise<any> {
    const r = await request(this.f, this.graphql, { method: 'POST', headers: this.headers(true), body: JSON.stringify({ query, variables }) });
    if (r?.errors?.length) throw new HostError(0, r.errors.map((e: any) => e.message).join('; '));
    return r?.data;
  }

  async feedback(pr: PullRequestInfo): Promise<PrFeedback> {
    const [owner, ...rest] = this.remote.projectPath.split('/');
    const query =
      'query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){reviewThreads(first:100){nodes{id isResolved isOutdated path line originalLine comments(first:30){nodes{author{login} body url createdAt}}}}}}}';
    const [data, reviews] = await Promise.all([
      this.gql(query, { owner, name: rest.join('/'), n: pr.id }),
      this.req('GET', `/pulls/${pr.id}/reviews?per_page=100`) as Promise<any[]>,
    ]);
    const nodes: any[] = data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    return {
      threads: nodes.map(n => ({
        id: n.id,
        path: n.path ?? undefined,
        line: n.line ?? n.originalLine ?? undefined,
        resolved: !!n.isResolved,
        outdated: !!n.isOutdated,
        comments: (n.comments?.nodes ?? []).map((c: any) => ({ author: c.author?.login ?? '?', body: c.body ?? '', at: ts(c.createdAt), url: c.url })),
      })),
      reviews: (reviews ?? [])
        .filter(r => (r.body ?? '').trim() && r.state !== 'PENDING')
        .map(r => ({ author: r.user?.login ?? '?', state: String(r.state ?? '').toLowerCase(), body: r.body, at: ts(r.submitted_at) })),
    };
  }

  async retarget(pr: PullRequestInfo, target: string) {
    await this.req('PATCH', `/pulls/${pr.id}`, { base: target });
  }

  async resolveThread(_pr: PullRequestInfo, id: string, reply?: string) {
    if (reply) await this.gql('mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}', { id, body: reply });
    await this.gql('mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}', { id });
  }
}

// ---------------------------------------------------------------- GitLab

export class GitLabPrBrowser implements PrBrowser {
  readonly kind = 'gitlab';
  readonly label = 'MR';
  readonly can = { files: true, comments: true, checks: true, merge: true, draft: true, reviewRequested: true, threads: true };
  private readonly api: string;
  private readonly project: string;

  constructor(remote: RemoteInfo, private readonly token: string, apiBase?: string, private readonly f: Fetch = fetch) {
    this.api = (apiBase || `${remote.webBase}/api/v4`).replace(/\/+$/, '');
    this.project = encodeURIComponent(remote.projectPath);
  }

  private req(method: string, p: string, body?: unknown, raw = false) {
    return request(
      this.f,
      `${this.api}${p}`,
      { method, headers: { 'PRIVATE-TOKEN': this.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined },
      raw,
    );
  }

  map(m: any): PullRequestInfo {
    const draft = m.draft || m.work_in_progress;
    return {
      id: m.iid,
      ref: `!${m.iid}`,
      url: m.web_url,
      title: m.title,
      state: m.state === 'merged' ? 'merged' : m.state === 'opened' ? (draft ? 'draft' : 'open') : 'closed',
      source: m.source_branch,
      target: m.target_branch,
      author: m.author?.username ?? '?',
      createdAt: ts(m.created_at),
      updatedAt: ts(m.updated_at),
      mergedAt: m.merged_at ? ts(m.merged_at) : undefined,
      headSha: m.sha,
      conflicts: m.has_conflicts ? true : undefined,
      fork: m.source_project_id !== undefined && m.target_project_id !== undefined && m.source_project_id !== m.target_project_id,
      reviewers: (m.reviewers ?? []).map((u: any) => u.username).filter(Boolean),
    };
  }

  async whoami() {
    const u = await this.req('GET', '/user');
    return u.username as string;
  }

  async groups(me: string, recentDays = 7): Promise<PrGroups> {
    const base = `/projects/${this.project}/merge_requests`;
    const [open, merged] = await Promise.all([
      this.req('GET', `${base}?state=opened&per_page=100&order_by=updated_at`) as Promise<any[]>,
      this.req('GET', `${base}?state=merged&per_page=50&order_by=updated_at`) as Promise<any[]>,
    ]);
    const openPrs = open.map(m => this.map(m));
    const status = new Map(open.map(m => [m.iid, m.detailed_merge_status]));
    await limited(openPrs.filter(p => p.state === 'open').slice(0, 40), 4, async p => {
      try {
        const a = await this.req('GET', `${base}/${p.id}/approvals`);
        const by: string[] = (a.approved_by ?? []).map((x: any) => x.user?.username).filter(Boolean);
        const left = typeof a.approvals_left === 'number' ? a.approvals_left : undefined;
        const review: ReviewStatus =
          status.get(p.id) === 'discussions_not_resolved'
            ? { state: 'discussions', approvals: by.length, approvalsLeft: left, by }
            : by.length && !left
              ? { state: 'approved', approvals: by.length, approvalsLeft: left, by }
              : { state: 'pending', approvals: by.length, approvalsLeft: left, by };
        p.review = review;
      } catch {
        // aprovações indisponíveis (plano/permissão)
      }
    });
    return groupPrs(openPrs, merged.map(m => this.map(m)), me, Date.now() / 1000, recentDays);
  }

  async files(pr: PullRequestInfo): Promise<PrFile[]> {
    const base = `/projects/${this.project}/merge_requests/${pr.id}`;
    let diffs: any[];
    try {
      diffs = await this.req('GET', `${base}/diffs?per_page=100`);
    } catch (e) {
      // GitLab antigo (< 15.7): /changes
      if (!(e instanceof HostError) || e.status !== 404) throw e;
      diffs = (await this.req('GET', `${base}/changes`)).changes ?? [];
    }
    return diffs.map(d => ({
      path: d.new_path,
      status: d.new_file ? 'added' : d.deleted_file ? 'removed' : d.renamed_file ? 'renamed' : 'modified',
      ...countDiff(d.diff),
      previousPath: d.renamed_file ? d.old_path : undefined,
    }));
  }

  async comments(pr: PullRequestInfo): Promise<PrComment[]> {
    const notes: any[] = await this.req('GET', `/projects/${this.project}/merge_requests/${pr.id}/notes?sort=desc&order_by=created_at&per_page=50`);
    return notes
      .filter(n => !n.system)
      .slice(0, 20)
      .map(n => ({ author: n.author?.username ?? '?', body: n.body ?? '', at: ts(n.created_at), url: `${pr.url}#note_${n.id}`, path: n.position?.new_path }));
  }

  async checks(pr: PullRequestInfo): Promise<PrCheck[]> {
    const pipes: any[] = await this.req('GET', `/projects/${this.project}/merge_requests/${pr.id}/pipelines?per_page=1`);
    const p = pipes[0];
    if (!p) return [];
    const jobs: any[] = await this.req('GET', `/projects/${this.project}/pipelines/${p.id}/jobs?per_page=100`).catch(() => []);
    if (!jobs.length) return [{ name: `pipeline #${p.id}`, status: checkStatus(p.status), url: p.web_url }];
    return jobs.map(j => ({ name: j.stage ? `${j.stage}: ${j.name}` : j.name, status: checkStatus(j.status), url: j.web_url }));
  }

  async merge(pr: PullRequestInfo, method: MergeMethod) {
    // o GitLab faz rebase por uma rota separada; aqui: merge normal ou squash
    await this.req('PUT', `/projects/${this.project}/merge_requests/${pr.id}/merge`, method === 'squash' ? { squash: true } : {});
  }

  async setDraft(pr: PullRequestInfo, draft: boolean) {
    const clean = pr.title.replace(/^\s*(draft:|\[draft\]|\(draft\)|wip:)\s*/i, '');
    await this.req('PUT', `/projects/${this.project}/merge_requests/${pr.id}`, { title: draft ? `Draft: ${clean}` : clean });
  }

  async feedback(pr: PullRequestInfo): Promise<PrFeedback> {
    const list: any[] = await this.req('GET', `/projects/${this.project}/merge_requests/${pr.id}/discussions?per_page=100`);
    const threads: ReviewThread[] = [];
    const reviews: PrFeedback['reviews'] = [];
    for (const d of list) {
      const notes = (d.notes ?? []).filter((n: any) => !n.system);
      if (!notes.length) continue;
      const first = notes[0];
      if (!first.resolvable) {
        // comentário geral no MR (sem linha)
        reviews.push({ author: first.author?.username ?? '?', state: 'commented', body: first.body ?? '', at: ts(first.created_at) });
        continue;
      }
      threads.push({
        id: String(d.id),
        path: first.position?.new_path ?? first.position?.old_path,
        line: first.position?.new_line ?? first.position?.old_line ?? undefined,
        resolved: notes.every((n: any) => !n.resolvable || n.resolved),
        comments: notes.map((n: any) => ({ author: n.author?.username ?? '?', body: n.body ?? '', at: ts(n.created_at), url: `${pr.url}#note_${n.id}` })),
      });
    }
    return { threads, reviews };
  }

  async retarget(pr: PullRequestInfo, target: string) {
    await this.req('PUT', `/projects/${this.project}/merge_requests/${pr.id}`, { target_branch: target });
  }

  async resolveThread(pr: PullRequestInfo, id: string, reply?: string) {
    const base = `/projects/${this.project}/merge_requests/${pr.id}/discussions/${id}`;
    if (reply) await this.req('POST', `${base}/notes`, { body: reply });
    await this.req('PUT', `${base}?resolved=true`);
  }
}

// ---------------------------------------------------------------- Bitbucket / Azure: só listagem

/** Para plataformas sem suporte completo: lista os abertos pelo cliente que já existe. */
export class ListOnlyPrBrowser implements PrBrowser {
  readonly can = { files: false, comments: false, checks: false, merge: false, draft: false, reviewRequested: false, threads: false };
  constructor(private readonly client: HostClient) {}

  get kind() {
    return this.client.kind;
  }

  get label() {
    return this.client.label;
  }

  whoami() {
    return this.client.whoami();
  }

  async groups(me: string): Promise<PrGroups> {
    const open = (await this.client.listOpen()).map(
      (p): PullRequestInfo => ({ ...p, author: '', createdAt: 0, updatedAt: 0, reviewers: [] }),
    );
    return { mine: [], reviewRequested: [], open, recentlyMerged: [] };
  }

  private unsupported(): never {
    throw new HostError(0, t('Not available on this platform yet; open it in the browser.'));
  }

  async files(): Promise<PrFile[]> {
    return this.unsupported();
  }
  async comments(): Promise<PrComment[]> {
    return this.unsupported();
  }
  async checks(): Promise<PrCheck[]> {
    return this.unsupported();
  }
  async merge(): Promise<void> {
    return this.unsupported();
  }
  async setDraft(): Promise<void> {
    return this.unsupported();
  }
  async feedback(): Promise<PrFeedback> {
    return this.unsupported();
  }
  async resolveThread(): Promise<void> {
    return this.unsupported();
  }
  async retarget(): Promise<void> {
    return this.unsupported();
  }
}

/** Ref local para trazer o PR: a própria branch, ou refs/pull/N/head → pr/N quando vem de fork (GitHub). */
export function fetchSpecFor(pr: PullRequestInfo, kind: HostKind): { refspec: string; localBranch: string } {
  if (pr.fork && kind === 'github') return { refspec: `refs/pull/${pr.id}/head:refs/heads/pr/${pr.id}`, localBranch: `pr/${pr.id}` };
  if (pr.fork && kind === 'gitlab') return { refspec: `refs/merge-requests/${pr.id}/head:refs/heads/mr/${pr.id}`, localBranch: `mr/${pr.id}` };
  return { refspec: `refs/heads/${pr.source}:refs/remotes/origin/${pr.source}`, localBranch: pr.source };
}

/** Conversas que ainda pedem algo: não resolvidas (as desatualizadas também, o agente confere). */
export function openThreads(fb: PrFeedback): ReviewThread[] {
  return fb.threads.filter(x => !x.resolved);
}

/** O que a revisão pediu, em Markdown, para o agente (e para a ferramenta MCP pr_feedback). */
export function feedbackText(pr: Pick<PullRequestInfo, 'ref' | 'title' | 'url'>, fb: PrFeedback, me?: string): string {
  const open = openThreads(fb);
  const lines = [`${pr.ref} "${pr.title}" — ${pr.url}`, ''];
  const reviews = fb.reviews.filter(r => !me || r.author.toLowerCase() !== me.toLowerCase());
  if (reviews.length) {
    lines.push('## Reviews', '');
    for (const r of reviews) lines.push(`- ${r.author} (${r.state}): ${r.body.trim().replace(/\n+/g, ' ')}`);
    lines.push('');
  }
  if (open.length) {
    lines.push('## Unresolved review threads', '');
    for (const th of open) {
      lines.push(`### ${th.path ?? '(general)'}${th.line ? `:${th.line}` : ''}${th.outdated ? ' (outdated: the code changed since)' : ''} [thread ${th.id}]`);
      for (const c of th.comments) lines.push(`- ${c.author}: ${c.body.trim()}`);
      lines.push('');
    }
  }
  if (!reviews.length && !open.length) lines.push('No unresolved review threads.');
  return lines.join('\n');
}
