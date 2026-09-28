/**
 * Projetos longos: o plano e o diário moram no repositório, o Claude recebe o marco atual pelo hook
 * SessionStart e o hook Stop só deixa parar com o marco feito (ver src/claude/hooks.ts). Aqui fica o
 * que não depende do VS Code (testado em test/longProject.test.js).
 */
import * as fs from 'fs';
import * as path from 'path';
import { t } from '../i18n';

/** Pasta dos projetos dentro da worktree. */
export const PROJECTS_DIR = path.join('.agentyard', 'projects');

export type ReviewMode = 'auto' | 'milestone';

/** `project.json`: escrito na criação e commitado junto com o plano. */
export interface ProjectConfig {
  title: string;
  goal: string;
  /** Branch dona do projeto: depois de mesclado, ele não aparece nas worktrees que saírem da base. */
  branch?: string;
  /** Comando que precisa passar antes de o agente parar (vazio: sem verificação). */
  verify: string;
  /** 'auto': o próximo marco começa sozinho; 'milestone': para para revisão a cada marco. */
  review: ReviewMode;
  /** Portão no Stop ligado. */
  gate: boolean;
  created: number;
}

export interface ChecklistItem {
  text: string;
  done: boolean;
}

export interface Milestone {
  id: string;
  title: string;
  items: ChecklistItem[];
}

export type ProjectStatus = 'planning' | 'planned' | 'running' | 'review' | 'paused' | 'blocked' | 'done';
export type MilestoneStatus = 'pending' | 'active' | 'done' | 'blocked' | 'stuck';

export interface MilestoneRuntime {
  status: MilestoneStatus;
  started?: number;
  finished?: number;
  /** Sessões do Claude abertas para este marco. */
  sessions: number;
  sessionIds: string[];
  /** Último resultado do portão ("fail verify", "pass"…). */
  lastGate?: string;
  /** Vezes que o portão mandou continuar. */
  gateBlocks: number;
  /** Já avisou que passou do tempo. */
  overtime?: boolean;
}

/** Estado de execução, guardado pela extensão (fora da worktree, para não sujar o `git status`). */
export interface ProjectRuntime {
  status: ProjectStatus;
  current?: string;
  reason?: string;
  terminalId?: string;
  /** mtime do PLAN.md quando o "plano pronto" foi avisado. */
  planNotified?: number;
  milestones: Record<string, MilestoneRuntime>;
}

/** Caminhos de um projeto numa worktree. */
export function projectPaths(worktree: string, slug: string) {
  const dir = path.join(worktree, PROJECTS_DIR, slug);
  return {
    dir,
    config: path.join(dir, 'project.json'),
    plan: path.join(dir, 'PLAN.md'),
    progress: path.join(dir, 'PROGRESS.md'),
    blocked: path.join(dir, 'BLOCKED.md'),
    /** Caminho relativo à worktree, com barras normais (para os prompts). */
    rel: [...PROJECTS_DIR.split(path.sep), slug].join('/'),
  };
}

export function slugOf(s: string): string {
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .slice(0, 6)
      .join('-') || 'projeto'
  );
}

/**
 * Marcos do PLAN.md: cada `## [M1] Título` abre um marco, e os `- [ ]` / `- [x]` até o próximo `## `
 * são o checklist dele (inclusive dentro de `###`).
 */
export function parsePlan(md: string): Milestone[] {
  const out: Milestone[] = [];
  let cur: Milestone | undefined;
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^##\s+\[([A-Za-z0-9._-]+)\]\s*(.*)$/);
    if (h) {
      cur = { id: h[1], title: h[2].trim(), items: [] };
      out.push(cur);
      continue;
    }
    if (/^##\s/.test(line)) {
      cur = undefined;
      continue;
    }
    const c = cur && line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (cur && c) cur.items.push({ text: c[2].trim(), done: c[1] !== ' ' });
  }
  return out;
}

export function checklistDone(m: Milestone): boolean {
  return m.items.length > 0 && m.items.every(i => i.done);
}

/** Primeiro marco que ainda não terminou (pelo estado da extensão, ou pelo checklist se ela não sabe). */
export function nextMilestone(plan: Milestone[], rt: ProjectRuntime): Milestone | undefined {
  return plan.find(m => {
    const r = rt.milestones[m.id];
    return r ? r.status !== 'done' : !checklistDone(m);
  });
}

/** Últimas entradas do PROGRESS.md (cada `## ` é uma), sem passar de `maxLines`. */
export function lastProgress(md: string, maxLines = 60): string {
  const lines = md.replace(/\s+$/, '').split(/\r?\n/);
  const starts = lines.map((l, i) => (/^##\s/.test(l) ? i : -1)).filter(i => i >= 0);
  if (!starts.length) return lines.slice(-maxLines).join('\n');
  let from = starts[starts.length - 1];
  for (let k = starts.length - 2; k >= 0 && lines.length - starts[k] <= maxLines; k--) from = starts[k];
  return lines.slice(from).slice(-maxLines).join('\n');
}

/** Texto entre aspas simples para o bash. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface GateEnv {
  projectDir: string;
  worktree: string;
  milestone: string;
  verify: string;
  gate: boolean;
  maxRetries: number;
}

/** Conteúdo do `<id>.project`, lido (com `.`) pelo script dos hooks. */
export function gateEnvFile(e: GateEnv): string {
  const slash = (p: string) => p.replace(/\\/g, '/');
  const vars: [string, string][] = [
    ['PROJECT_DIR', slash(e.projectDir)],
    ['WORKTREE', slash(e.worktree)],
    ['MILESTONE', e.milestone],
    ['VERIFY', e.verify],
    ['GATE', e.gate ? '1' : '0'],
    ['MAX_RETRIES', String(Math.max(0, Math.floor(e.maxRetries)))],
    ['MSG_CHECKLIST', t('AgentYard: milestone [{0}] still has unchecked items in PLAN.md. Finish them and check them off, or, if you depend on a person, write BLOCKED.md in the project folder explaining what you need.', e.milestone)],
    ['MSG_PROGRESS', t('AgentYard: before stopping, add an entry to PROGRESS.md: what was done, decisions made, the next step and open problems.')],
    ['MSG_COMMIT', t('AgentYard: there are uncommitted changes. Commit everything, including PLAN.md and PROGRESS.md.')],
    ['MSG_VERIFY', t('AgentYard: the verification "{0}" failed. Fix the cause and try again. Last lines:', e.verify)],
  ];
  return vars.map(([k, v]) => `${k}=${shellQuote(v)}`).join('\n') + '\n';
}

export interface ContextInput {
  config: ProjectConfig;
  rel: string;
  status: ProjectStatus;
  milestone?: Milestone;
  milestones: Milestone[];
  progress: string;
}

/** O que o Claude recebe no início de cada sessão (e depois de compactar): a memória do projeto. */
export function renderContext(c: ContextInput): string {
  const out: string[] = [];
  out.push(`# ${t('AgentYard: long-running project "{0}"', c.config.title)}`, '');
  out.push(t('Your memory between sessions lives in files, not in this conversation:'));
  out.push(`- ${t('Plan')}: \`${c.rel}/PLAN.md\``);
  out.push(`- ${t('Progress log')}: \`${c.rel}/PROGRESS.md\``, '');
  out.push(`**${t('Goal')}:** ${c.config.goal}`, '');
  if (c.status === 'planning') {
    out.push(t('Phase: PLANNING. Write the plan; do not write code yet.'));
    return out.join('\n') + '\n';
  }
  if (c.milestones.length) {
    out.push(`## ${t('Milestones')}`);
    for (const m of c.milestones) {
      const done = m.items.filter(i => i.done).length;
      out.push(`- ${m.id === c.milestone?.id ? '→ ' : ''}[${m.id}] ${m.title} (${done}/${m.items.length})`);
    }
    out.push('');
  }
  if (c.milestone) {
    out.push(`## ${t('Current milestone: [{0}] {1}', c.milestone.id, c.milestone.title)}`);
    for (const i of c.milestone.items) out.push(`- [${i.done ? 'x' : ' '}] ${i.text}`);
    out.push('');
  }
  if (c.progress.trim()) out.push(`## ${t('Latest progress entries')}`, c.progress.trim(), '');
  out.push(`## ${t('Rules')}`);
  out.push(`- ${t('Work only on the current milestone. Do not start the next one.')}`);
  if (c.config.verify) out.push(`- ${t('The command `{0}` must pass before you stop.', c.config.verify)}`);
  out.push(`- ${t('Before stopping: check off the finished items in PLAN.md, add an entry to PROGRESS.md (done, decisions, next step, problems) and commit everything.')}`);
  out.push(`- ${t('If you depend on a decision or access only a person can give, write BLOCKED.md in the project folder with the question and stop.')}`);
  out.push(`- ${t('If you find that the plan is wrong, adjust PLAN.md and explain why in PROGRESS.md.')}`);
  return out.join('\n') + '\n';
}

/** Tarefa da sessão de planejamento: só o plano, no formato que a extensão lê. */
export function planningPrompt(config: ProjectConfig, rel: string): string {
  return [
    t('You are going to plan a long-running project that will be executed by agents in several sessions, one milestone per session.'),
    '',
    `${t('Goal')}: ${config.goal}`,
    '',
    t('1. Explore the code and ask me what is needed to remove ambiguities (one question at a time, only what really matters).'),
    t('2. Write {0}/PLAN.md with: goal, acceptance criteria, decisions/constraints and the milestones. Each milestone is a heading exactly like `## [M1] Title` (M2, M3…), followed by a checklist with `- [ ]` of small, verifiable items. Each milestone must fit in one work session and leave the project working (tests passing).', rel),
    config.verify ? t('3. Each milestone will only be considered done when `{0}` passes. If that command is not right for this project, tell me.', config.verify) : t('3. Suggest the command that verifies the project (tests, build).'),
    t('4. Commit {0}/ (PLAN.md, PROGRESS.md and project.json). Do not write code in this session.', rel),
  ].join('\n');
}

/** Tarefa de uma sessão de marco: curta, porque o contexto vem do hook SessionStart. */
export function milestonePrompt(config: ProjectConfig, rel: string, m: Milestone, resumed: boolean): string {
  return [
    t('Long-running project "{0}": work on milestone [{1}] {2}.', config.title, m.id, m.title),
    resumed
      ? t('A previous session already worked on this milestone: read {0}/PROGRESS.md and the git log to continue from where it stopped.', rel)
      : t('Read {0}/PLAN.md and {0}/PROGRESS.md before starting.', rel),
    t('Follow the AgentYard rules loaded at the start of the session. When the milestone is done, stop.'),
  ].join('\n');
}

export function initialProgress(config: ProjectConfig): string {
  return `# ${t('Progress: {0}', config.title)}\n\n${t('One entry per session, the most recent at the end: `## <date> [milestone]`, then what was done, decisions, the next step and problems.')}\n`;
}

/** Comando de verificação sugerido: o `autoSync.testCommand` configurado, ou o que o projeto usa. */
export function detectVerify(worktree: string, configured = ''): string {
  if (configured.trim()) return configured.trim();
  const has = (f: string) => fs.existsSync(path.join(worktree, f));
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(worktree, 'package.json'), 'utf8'));
    const test = pkg?.scripts?.test;
    if (typeof test === 'string' && !/no test specified/.test(test)) {
      if (has('pnpm-lock.yaml')) return 'pnpm test';
      if (has('yarn.lock')) return 'yarn test';
      if (has('bun.lockb') || has('bun.lock')) return 'bun test';
      return 'npm test';
    }
  } catch {
    // sem package.json
  }
  if (has('Cargo.toml')) return 'cargo test';
  if (has('go.mod')) return 'go test ./...';
  if (has('pyproject.toml') || has('pytest.ini') || has('setup.py')) return 'pytest';
  if (has('pom.xml')) return 'mvn -q test';
  if (has('gradlew')) return './gradlew test';
  return '';
}

/** Resultado do portão gravado pelo script em `<id>.gate`. */
export type GateResult = { kind: 'running' | 'pass' | 'blocked' | 'giveup' } | { kind: 'fail'; why: string };

export function parseGate(text: string): GateResult | undefined {
  const s = text.trim();
  if (s === 'running' || s === 'pass' || s === 'blocked' || s === 'giveup') return { kind: s };
  const m = s.match(/^fail\s+(\S+)/);
  return m ? { kind: 'fail', why: m[1] } : undefined;
}

export function emptyMilestone(): MilestoneRuntime {
  return { status: 'pending', sessions: 0, sessionIds: [], gateBlocks: 0 };
}

/** "42 min", "2 h 5 min". */
export function durationText(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return t('{0} min', m);
  const h = Math.floor(m / 60);
  return m % 60 ? t('{0} h {1} min', h, m % 60) : t('{0} h', h);
}
