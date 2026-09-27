/** Resumo de uma branch/worktree (commits × base, arquivos, não commitado) e prompts para o agente. Sem vscode, testável. */

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
  out.push(`- Base: \`${f.baseRef}\` — ${f.commits.length} commit(s) à frente, ${f.behind} atrás`);
  out.push(f.path ? `- Worktree: \`${f.path}\`` : '- Sem worktree (lida do git)');
  if (f.commits.length) {
    const first = f.commits[f.commits.length - 1].date;
    const last = f.commits[0].date;
    out.push(`- Período: ${day(first)}${day(first) === day(last) ? '' : ` a ${day(last)}`}`);
    const authors = [...new Set(f.commits.map(c => c.author))];
    out.push(`- Autor(es): ${authors.join(', ')}`);
  }
  out.push('', '## Commits', '');
  if (!f.commits.length) out.push('_Nenhum commit além da base._');
  for (const c of f.commits.slice(0, maxCommits)) {
    out.push(`- \`${c.sha.slice(0, 7)}\` ${c.subject} — ${c.author}, ${day(c.date)}`);
    if (c.body) out.push(...c.body.split(/\r?\n/).map(l => (l.trim() ? `  > ${l}` : '  >')));
  }
  if (f.commits.length > maxCommits) out.push(`- … e mais ${f.commits.length - maxCommits} commit(s) antigo(s)`);
  if (f.diffStat.trim()) out.push('', `## Arquivos alterados × ${f.baseRef}`, '', '```', f.diffStat.trimEnd(), '```');
  if (f.path) {
    out.push('', '## Não commitado', '');
    if (f.uncommitted.length) out.push('```', ...f.uncommitted.slice(0, 60), ...(f.uncommitted.length > 60 ? [`… e mais ${f.uncommitted.length - 60}`] : []), '```');
    else out.push('_Worktree limpa._');
  }
  return out.join('\n') + '\n';
}

export type AskKind = 'summary' | 'review' | 'pr' | 'free';

export const ASK_PRESETS: { ask: AskKind; label: string; detail: string }[] = [
  { ask: 'summary', label: '$(note) Resumir o que foi feito', detail: 'Explica em linguagem simples o que a branch mudou e por quê' },
  { ask: 'review', label: '$(eye) Riscos e o que testar', detail: 'Aponta bugs prováveis, pontas soltas e um roteiro de teste' },
  { ask: 'pr', label: '$(git-pull-request) Escrever descrição de PR', detail: 'Título e corpo prontos para colar no PR/MR' },
  { ask: 'free', label: '$(comment-discussion) Pergunta livre…', detail: 'Você escreve a pergunta; o agente recebe o contexto da branch' },
];

const TASK: Record<Exclude<AskKind, 'free'>, string> = {
  summary: 'Resuma o que foi feito nesta branch: o objetivo aparente, as mudanças principais agrupadas por tema e o que ainda parece incompleto. Seja direto.',
  review: 'Revise as mudanças desta branch: aponte bugs prováveis, casos de borda, riscos de regressão e pontas soltas (com arquivo e linha), e termine com um roteiro curto do que testar.',
  pr: 'Escreva uma descrição de PR para esta branch: um título curto e um corpo em Markdown com contexto, o que mudou, como testar e riscos. Entregue só o texto, pronto para colar.',
};

/** Prompt para o agente com o contexto da branch; a pergunta livre vai no lugar da tarefa. */
export function askPrompt(f: BranchFacts, kind: AskKind, question?: string): string {
  const range = `${f.baseRef}..${f.ref}`;
  const lines = [
    kind === 'free' ? (question ?? '').trim() : TASK[kind],
    '',
    `Contexto: branch ${f.label}, comparada com ${f.baseRef} (${f.commits.length} commit(s) à frente, ${f.behind} atrás).`,
    f.path
      ? `A worktree é esta pasta. Veja os commits com \`git log ${range}\`, o diff com \`git diff ${f.baseRef}...${f.ref}\` e o não commitado com \`git status\` / \`git diff\`.`
      : `A branch não tem worktree: não faça checkout. Leia com \`git log ${range}\`, \`git show <sha>\` e \`git diff ${f.baseRef}...${f.ref}\`.`,
    '',
    'Commits (mais recente primeiro):',
    ...f.commits.slice(0, 50).map(c => `- ${c.sha.slice(0, 7)} ${c.subject}`),
    ...(f.commits.length > 50 ? [`- … e mais ${f.commits.length - 50}`] : []),
  ];
  if (f.diffStat.trim()) lines.push('', 'Arquivos alterados:', ...f.diffStat.trimEnd().split(/\r?\n/).slice(-40));
  if (f.uncommitted.length) lines.push('', `Não commitado (${f.uncommitted.length}):`, ...f.uncommitted.slice(0, 30));
  lines.push('', kind === 'free' ? 'Se a pergunta não pedir alterações, não altere nenhum arquivo.' : 'Não altere nenhum arquivo.');
  return lines.join('\n');
}
