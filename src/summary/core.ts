/** Resumo de uma branch/worktree (commits × base, arquivos, não commitado) e prompts para o agente. Sem vscode, testável. */
import { t } from '../i18n';

export interface LogCommit {
  sha: string;
  author: string;
  date: number;
  subject: string;
  body: string;
}

/** Formato de `git log` que `parseLog` entende. */
export const LOG_FORMAT = '--format=%H%x1f%an%x1f%at%x1f%s%x1f%b%x1e';

export function parseLog(out: string): LogCommit[] {
  return out
    .split('\x1e')
    .map(r => r.replace(/^\s+/, ''))
    .filter(Boolean)
    .map(r => {
      const [sha, author, at, subject, body] = r.split('\x1f');
      return { sha, author, date: Number(at), subject: subject ?? '', body: (body ?? '').trim() };
    });
}

export interface BranchFacts {
  /** Nome da branch, ou "HEAD destacado". */
  label: string;
  /** Ref usada nos comandos git (branch ou HEAD). */
  ref: string;
  baseRef: string;
  /** Pasta da worktree; ausente para branch sem worktree. */
  path?: string;
  commits: LogCommit[];
  /** Commits da base que a branch não tem. */
  behind: number;
  /** Saída de `git diff --stat base...ref`. */
  diffStat: string;
  /** Linhas de `git status --short` (só worktree). */
  uncommitted: string[];
}

const day = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

/** Markdown para ler, copiar ou colar no Claude. */
export function summaryMarkdown(f: BranchFacts, maxCommits = 100): string {
  const out: string[] = [`# ${f.label}`, ''];
  out.push(`- ${t('Base: {0} — {1} commit(s) ahead, {2} behind', `\`${f.baseRef}\``, f.commits.length, f.behind)}`);
  out.push(f.path ? `- Worktree: \`${f.path}\`` : `- ${t('No worktree (read from git)')}`);
  if (f.commits.length) {
    const first = f.commits[f.commits.length - 1].date;
    const last = f.commits[0].date;
    out.push(`- ${day(first) === day(last) ? t('Period: {0}', day(first)) : t('Period: {0} to {1}', day(first), day(last))}`);
    const authors = [...new Set(f.commits.map(c => c.author))];
    out.push(`- ${t('Author(s): {0}', authors.join(', '))}`);
  }
  out.push('', '## Commits', '');
  if (!f.commits.length) out.push(`_${t('No commits beyond the base.')}_`);
  for (const c of f.commits.slice(0, maxCommits)) {
    out.push(`- \`${c.sha.slice(0, 7)}\` ${c.subject} — ${c.author}, ${day(c.date)}`);
    if (c.body) out.push(...c.body.split(/\r?\n/).map(l => (l.trim() ? `  > ${l}` : '  >')));
  }
  if (f.commits.length > maxCommits) out.push(`- … ${t('and {0} more older commit(s)', f.commits.length - maxCommits)}`);
  if (f.diffStat.trim()) out.push('', `## ${t('Changed files × {0}', f.baseRef)}`, '', '```', f.diffStat.trimEnd(), '```');
  if (f.path) {
    out.push('', `## ${t('Uncommitted changes')}`, '');
    if (f.uncommitted.length) out.push('```', ...f.uncommitted.slice(0, 60), ...(f.uncommitted.length > 60 ? [`… ${t('and {0} more', f.uncommitted.length - 60)}`] : []), '```');
    else out.push(`_${t('Clean worktree.')}_`);
  }
  return out.join('\n') + '\n';
}

export type AskKind = 'summary' | 'review' | 'pr' | 'free';

export function askPresets(): { ask: AskKind; label: string; detail: string }[] {
  return [
    { ask: 'summary', label: '$(note) ' + t('Summarize what was done'), detail: t('Explains in plain language what the branch changed and why') },
    { ask: 'review', label: '$(eye) ' + t('Risks and what to test'), detail: t('Points out likely bugs, loose ends and a test plan') },
    { ask: 'pr', label: '$(git-pull-request) ' + t('Write a PR description'), detail: t('Title and body ready to paste into the PR/MR') },
    { ask: 'free', label: '$(comment-discussion) ' + t('Free question…'), detail: t('You write the question; the agent gets the branch context') },
  ];
}

function task(kind: Exclude<AskKind, 'free'>): string {
  if (kind === 'summary') return t('Summarize what was done on this branch: the apparent goal, the main changes grouped by theme and what still looks incomplete. Be direct.');
  if (kind === 'review') return t('Review the changes on this branch: point out likely bugs, edge cases, regression risks and loose ends (with file and line), and finish with a short plan of what to test.');
  return t('Write a PR description for this branch: a short title and a Markdown body with context, what changed, how to test and risks. Deliver only the text, ready to paste.');
}

/** Prompt para o agente com o contexto da branch; a pergunta livre vai no lugar da tarefa. */
export function askPrompt(f: BranchFacts, kind: AskKind, question?: string): string {
  const range = `${f.baseRef}..${f.ref}`;
  const lines = [
    kind === 'free' ? (question ?? '').trim() : task(kind),
    '',
    t('Context: branch {0}, compared with {1} ({2} commit(s) ahead, {3} behind).', f.label, f.baseRef, f.commits.length, f.behind),
    f.path
      ? t('The worktree is this folder. See the commits with {0}, the diff with {1} and the uncommitted changes with {2} / {3}.', `\`git log ${range}\``, `\`git diff ${f.baseRef}...${f.ref}\``, '`git status`', '`git diff`')
      : t('The branch has no worktree: don\'t check it out. Read it with {0}, {1} and {2}.', `\`git log ${range}\``, '`git show <sha>`', `\`git diff ${f.baseRef}...${f.ref}\``),
    '',
    t('Commits (most recent first):'),
    ...f.commits.slice(0, 50).map(c => `- ${c.sha.slice(0, 7)} ${c.subject}`),
    ...(f.commits.length > 50 ? [`- … ${t('and {0} more', f.commits.length - 50)}`] : []),
  ];
  if (f.diffStat.trim()) lines.push('', t('Changed files:'), ...f.diffStat.trimEnd().split(/\r?\n/).slice(-40));
  if (f.uncommitted.length) lines.push('', t('Uncommitted ({0}):', f.uncommitted.length), ...f.uncommitted.slice(0, 30));
  lines.push('', kind === 'free' ? t('If the question doesn\'t ask for changes, don\'t change any file.') : t('Don\'t change any file.'));
  return lines.join('\n');
}
