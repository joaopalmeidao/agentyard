/**
 * Texto que o hook SessionStart entrega ao Claude (additionalContext): em que worktree ele está, a
 * base, o que outras worktrees estão mexendo e o que a revisão/CI pediu. Sem VS Code (testado em
 * test/claudeGuard.test.js).
 */

export interface SessionFacts {
  repo: string;
  worktree: string;
  branch?: string;
  base: string;
  ahead?: number;
  behind?: number;
  changes?: number;
  /** Arquivos com conflito previsto no merge com a base. */
  conflicts?: string[];
  /** Arquivos que outras worktrees ativas também estão mexendo. */
  overlaps?: { with: string; files: string[] }[];
  /** Outras worktrees com agente aberto agora. */
  busy?: string[];
  request?: { ref: string; url: string; state: string; review?: string };
  ci?: { status: string; name?: string };
  /** Migrations novas na branch e no destino que vão colidir. */
  migrations?: string;
  /** O servidor MCP do AgentYard está disponível. */
  mcp?: boolean;
  /** Instruções extras do usuário (worktreeGraph.claude.sessionContext). */
  extra?: string;
}

const MAX_FILES = 15;

export function sessionContext(f: SessionFacts): string {
  const lines: string[] = [];
  lines.push(`AgentYard: you are working in the git worktree ${f.worktree} (branch ${f.branch ?? 'detached'}) of the repository ${f.repo}. The base branch is ${f.base}.`);
  lines.push('Other agents may be working in parallel in other worktrees of this repository.');
  const status: string[] = [];
  if (f.ahead !== undefined && f.behind !== undefined) status.push(`${f.ahead} commit(s) ahead and ${f.behind} behind ${f.base}`);
  if (f.changes) status.push(`${f.changes} uncommitted file(s)`);
  if (status.length) lines.push(`Current state: ${status.join(', ')}.`);
  if (f.conflicts?.length) lines.push(`Merging ${f.base} into this branch is predicted to conflict in: ${f.conflicts.slice(0, MAX_FILES).join(', ')}.`);
  for (const o of f.overlaps ?? []) {
    const files = o.files.slice(0, MAX_FILES).join(', ') + (o.files.length > MAX_FILES ? ` (+${o.files.length - MAX_FILES})` : '');
    lines.push(`The worktree ${o.with} is also changing: ${files}. Avoid unrelated changes there to keep the merge simple.`);
  }
  if (f.busy?.length) lines.push(`Agents currently open in other worktrees: ${f.busy.join(', ')}.`);
  if (f.request) lines.push(`This branch has ${f.request.ref} (${f.request.state}${f.request.review ? `, review: ${f.request.review}` : ''}): ${f.request.url}`);
  if (f.ci) lines.push(`Latest CI on this branch: ${f.ci.status}${f.ci.name ? ` (${f.ci.name})` : ''}.`);
  if (f.migrations) lines.push(f.migrations);
  if (f.mcp) {
    lines.push(
      'The `agentyard` MCP tools are available: `status`, `overlaps`, `pr_feedback`, `ci_status`, `review_comments`, `turn_diff`, `create_worktree`, and `mark_ready` (call it after committing, when the work is done and ready for review).',
    );
  }
  if (f.extra?.trim()) lines.push(f.extra.trim());
  return lines.join('\n');
}
