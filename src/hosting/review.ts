/**
 * Revisão de PR/MR feita por um agente: formato do arquivo que o agente escreve e a postagem dos
 * comentários no GitHub (review com comentários em linha) ou no GitLab (discussões com posição).
 * Sem dependência do VS Code, para testar contra um servidor falso (test/review.test.js).
 */
import type { RemoteInfo } from './core';
import { HostError } from './core';
import { t } from '../i18n';

export type Severity = 'bug' | 'risco' | 'sugestao' | 'nit';

export interface ReviewComment {
  path: string;
  line?: number;
  body: string;
  severity?: Severity | string;
}

export interface ReviewFile {
  summary: string;
  comments: ReviewComment[];
}

export interface PostResult {
  /** Comentários que entraram na linha do diff. */
  inline: number;
  /** Comentários que foram para o texto geral (linha fora do diff ou sem linha). */
  general: number;
  url?: string;
}

/** Lê o review.json do agente; tolera cercas de markdown e campos a mais. Lança erro legível. */
export function parseReviewFile(text: string): ReviewFile {
  const cleaned = text.replace(/^﻿/, '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  let raw: any;
  try {
    raw = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(t('review.json is not valid JSON: {0}', (e as Error).message));
  }
  if (!raw || typeof raw !== 'object') throw new Error(t('review.json must be an object {0}.', '{ summary, comments }'));
  const comments: ReviewComment[] = (Array.isArray(raw.comments) ? raw.comments : [])
    .filter((c: any) => c && typeof c.body === 'string' && c.body.trim())
    .map((c: any) => ({
      path: String(c.path ?? c.file ?? '').replace(/\\/g, '/').replace(/^\.\//, ''),
      line: Number.isFinite(Number(c.line)) && Number(c.line) > 0 ? Number(c.line) : undefined,
      body: String(c.body).trim(),
      severity: c.severity ? String(c.severity) : undefined,
    }));
  return { summary: String(raw.summary ?? '').trim(), comments };
}

/**
 * Linhas do lado novo (adicionadas ou de contexto) de um patch unificado: só nelas o GitHub e o
 * GitLab aceitam comentário em linha.
 */
export function newSideLines(patch: string): Set<number> {
  const out = new Set<number>();
  let line = 0;
  for (const l of patch.split(/\r?\n/)) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      line = Number(h[1]);
      continue;
    }
    if (!line) continue;
    if (l.startsWith('+')) out.add(line++);
    else if (l.startsWith(' ') || l === '') out.add(line++);
    // linhas "-" só existem do lado antigo; "\ No newline" não conta
  }
  return out;
}

function sevLabel(s: string): string | undefined {
  const labels: Record<string, string> = { bug: '🐞 bug', risco: t('⚠ risk'), sugestao: t('💡 suggestion'), nit: 'nit' };
  return labels[s];
}

export function commentText(c: ReviewComment): string {
  const sev = c.severity ? `**${sevLabel(c.severity) ?? c.severity}** ` : '';
  return `${sev}${c.body}`;
}

/** Texto geral: resumo + comentários que não couberam numa linha do diff. */
export function generalBody(summary: string, loose: ReviewComment[]): string {
  const parts = [summary ? summary : ''];
  if (loose.length) {
    parts.push(
      '',
      t('**Comments outside the changed lines:**'),
      ...loose.map(c => `- \`${c.path}${c.line ? `:${c.line}` : ''}\` — ${commentText(c)}`),
    );
  }
  parts.push('', t('_Review by an agent, via AgentYard._'));
  return parts.join('\n').trim();
}

type Fetch = typeof fetch;

async function req(f: Fetch, url: string, init: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await f(url, init);
  } catch (e) {
    throw new HostError(0, t('Could not reach {0}: {1}', new URL(url).host, (e as Error).message));
  }
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = (body && (body.message || body.error)) || text || res.statusText;
    throw new HostError(res.status, `${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return body;
}

export interface ReviewPoster {
  post(requestId: number, review: ReviewFile): Promise<PostResult>;
}

export class GitHubReviewPoster implements ReviewPoster {
  private readonly api: string;

  constructor(private readonly remote: RemoteInfo, private readonly token: string, apiBase?: string, private readonly f: Fetch = fetch) {
    this.api = (apiBase || (remote.host === 'github.com' ? 'https://api.github.com' : `${remote.webBase}/api/v3`)).replace(/\/+$/, '');
  }

  private call(method: string, p: string, body?: unknown) {
    return req(this.f, `${this.api}/repos/${this.remote.projectPath}${p}`, {
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

  async post(n: number, review: ReviewFile): Promise<PostResult> {
    // Linhas válidas por arquivo, a partir dos patches do PR.
    const valid = new Map<string, Set<number>>();
    for (let page = 1; page <= 10; page++) {
      const files: any[] = await this.call('GET', `/pulls/${n}/files?per_page=100&page=${page}`);
      for (const f of files) if (f.patch) valid.set(f.filename, newSideLines(f.patch));
      if (files.length < 100) break;
    }
    const inline = review.comments.filter(c => c.line && valid.get(c.path)?.has(c.line));
    const loose = review.comments.filter(c => !inline.includes(c));
    const r = await this.call('POST', `/pulls/${n}/reviews`, {
      event: 'COMMENT',
      body: generalBody(review.summary, loose),
      comments: inline.map(c => ({ path: c.path, line: c.line, side: 'RIGHT', body: commentText(c) })),
    });
    return { inline: inline.length, general: loose.length, url: r?.html_url };
  }
}

export class GitLabReviewPoster implements ReviewPoster {
  private readonly api: string;
  private readonly project: string;

  constructor(private readonly remote: RemoteInfo, private readonly token: string, apiBase?: string, private readonly f: Fetch = fetch) {
    this.api = (apiBase || `${remote.webBase}/api/v4`).replace(/\/+$/, '');
    this.project = encodeURIComponent(remote.projectPath);
  }

  private call(method: string, p: string, body?: unknown) {
    return req(this.f, `${this.api}/projects/${this.project}${p}`, {
      method,
      headers: { 'PRIVATE-TOKEN': this.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async post(iid: number, review: ReviewFile): Promise<PostResult> {
    const versions: any[] = await this.call('GET', `/merge_requests/${iid}/versions`);
    const v = versions[0];
    const changes: any = await this.call('GET', `/merge_requests/${iid}/changes`);
    const valid = new Map<string, { lines: Set<number>; oldPath: string }>();
    for (const c of changes?.changes ?? []) valid.set(c.new_path, { lines: newSideLines(c.diff ?? ''), oldPath: c.old_path ?? c.new_path });

    const loose: ReviewComment[] = [];
    let inline = 0;
    for (const c of review.comments) {
      const file = c.line ? valid.get(c.path) : undefined;
      if (!v || !file || !file.lines.has(c.line!)) {
        loose.push(c);
        continue;
      }
      try {
        await this.call('POST', `/merge_requests/${iid}/discussions`, {
          body: commentText(c),
          position: {
            position_type: 'text',
            base_sha: v.base_commit_sha,
            start_sha: v.start_commit_sha,
            head_sha: v.head_commit_sha,
            old_path: file.oldPath,
            new_path: c.path,
            new_line: c.line,
          },
        });
        inline++;
      } catch (e) {
        // o GitLab recusa posições que ele não reconhece: vai para o texto geral
        if (e instanceof HostError && e.status === 400) loose.push(c);
        else throw e;
      }
    }
    const note = await this.call('POST', `/merge_requests/${iid}/notes`, { body: generalBody(review.summary, loose) });
    return { inline, general: loose.length, url: note?.id ? `${this.remote.webBase}/${this.remote.projectPath}/-/merge_requests/${iid}#note_${note.id}` : undefined };
  }
}

export function reviewPoster(remote: RemoteInfo, token: string, apiBase?: string, f: Fetch = fetch): ReviewPoster {
  return remote.kind === 'gitlab' ? new GitLabReviewPoster(remote, token, apiBase, f) : new GitHubReviewPoster(remote, token, apiBase, f);
}

/** Montado ao carregar o módulo (o bundle de tradução do VS Code já está disponível na ativação). */
export const DEFAULT_REVIEW_PROMPT = [
  t('Review the {0} "{1}" ({2}): branch {3} against {4}.', '${kind}', '${title}', '${url}', '${branch}', '${base}'),
  '',
  t('Changed files:'),
  '${diffStat}',
  '',
  t('See the diff with {0}. Focus on real bugs and risks: wrong logic, edge cases,', '`git diff ${base}...${branch}`'),
  t('unhandled errors, concurrency, security, broken compatibility and missing tests for what changed.'),
  t('Ignore style and personal preferences, unless they hide a bug.'),
  '',
  t('Do not change any project file. Write the result to {0}, exactly in this format:', '`.worktree-graph/review.json`'),
  `{ "summary": "${t('summary in 2-4 sentences')}", "comments": [ { "path": "${t('relative/path.ts')}", "line": 42, "severity": "bug|risco|sugestao|nit", "body": "${t('what is wrong and how to fix it')}" } ] }`,
  t('"line" is the line in the new file (right side of the diff). With no comments, use {0}.', '"comments": []'),
].join('\n');
