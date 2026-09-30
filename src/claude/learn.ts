/**
 * Pedidos que fazem o Claude arrumar a memória ou melhorar uma skill, e a mudança de memória de
 * uma worktree para a do projeto. Sem VS Code (testado em test/claudeConfig.test.js).
 */
import * as fs from 'fs';
import * as path from 'path';
import { t } from '../i18n';
import { addIndexLine, listMemories, removeIndexLines } from './config';

export interface LearnTargets {
  /** Memória do projeto (a da worktree principal, que sobrevive às worktrees). */
  memoryDir?: string;
  /** `<config>/skills`: skills do usuário, valem em todos os projetos. */
  userSkillsDir: string;
  /** `<worktree>/.claude/skills`: skills do projeto, versionadas com a branch. */
  projectSkillsDir?: string;
}

const MEMORY_FORMAT = [
  'Memory format: one fact per file, with frontmatter `name` (kebab-case slug), `description` (one line, used to decide relevance) and `metadata:` / `  type:` (user | feedback | project | reference); for feedback and project, follow the fact with **Why:** and **How to apply:** lines.',
  'After writing a memory file, add one line to MEMORY.md in the same folder: `- [Title](file.md) — hook`. Update an existing memory instead of creating a duplicate, and delete memories that turned out to be wrong.',
];

const SKILL_FORMAT =
  'Skill format: `<skills>/<kebab-name>/SKILL.md` with frontmatter `name` and `description` (what it does and when to use it — Claude decides from this sentence alone), then short, concrete steps. Prefer improving an existing skill over creating a similar one.';

function where(x: LearnTargets): string[] {
  return [
    x.memoryDir ? `- Memory folder: ${x.memoryDir}` : '',
    `- User skills (all projects): ${x.userSkillsDir}`,
    x.projectSkillsDir ? `- Project skills (versioned with this branch; commit them): ${x.projectSkillsDir}` : '',
  ].filter(Boolean);
}

/** Pedido de revisar a memória: juntar duplicadas, apagar o que ficou velho, arrumar o índice. */
export function curateMemoryPrompt(x: LearnTargets): string {
  return [
    '# Tidy up the memory',
    '',
    `Read every file in ${x.memoryDir ?? 'the memory folder'} and its MEMORY.md index, then:`,
    '',
    '1. Merge memories that say the same thing; keep the clearer file and delete the other.',
    '2. Check facts against the current code and repository; update or delete the ones that are no longer true.',
    '3. Make each `description` a precise one-liner that says when the memory matters.',
    '4. A memory that is really a step-by-step procedure → move it into a skill (and delete the memory).',
    '5. Leave MEMORY.md with exactly one line per file, no broken links.',
    '',
    'Where to write:',
    ...where(x),
    '',
    ...MEMORY_FORMAT,
    SKILL_FORMAT,
    '',
    'Before deleting anything you are unsure about, ask. Finish with the list of changes, in the language of the conversation.',
  ].join('\n');
}

/** Pedido de melhorar uma skill com o que a sessão atual mostrou. */
export function improveSkillPrompt(skillFile: string): string {
  return [
    `# Improve the skill ${skillFile}`,
    '',
    'Read the skill and improve it with what this session showed (mistakes, missing steps, commands that changed). Also:',
    '- The `description` must say what it does and when to use it, so it loads exactly when needed.',
    '- Keep the steps short and concrete; move long reference material to separate files next to SKILL.md.',
    '- Keep the frontmatter valid (`---`, `name`, `description`, `---`).',
    '',
    'Show what changed in a few lines, in the language of the conversation.',
  ].join('\n');
}

// ---------------------------------------------------------------- memória de worktree → projeto

/**
 * Move uma memória para outra pasta (ex.: da worktree para o projeto), com a linha no MEMORY.md
 * de destino e sem a de origem. Nome repetido ganha sufixo (-2, -3…). Devolve o novo arquivo.
 */
export function moveMemory(srcDir: string, fileName: string, dstDir: string): string {
  const src = path.join(srcDir, fileName);
  if (!fs.existsSync(src)) throw new Error(t('{0} does not exist.', src));
  const entry = listMemories(srcDir).find(m => m.fileName === fileName);
  fs.mkdirSync(dstDir, { recursive: true });
  const stem = fileName.replace(/\.md$/, '');
  let target = fileName;
  for (let n = 2; fs.existsSync(path.join(dstDir, target)); n++) target = `${stem}-${n}.md`;
  fs.copyFileSync(src, path.join(dstDir, target));
  addIndexLine(dstDir, target, entry?.name ?? stem, entry?.description || entry?.type || '');
  fs.rmSync(src, { force: true });
  removeIndexLines(srcDir, fileName);
  return path.join(dstDir, target);
}

/** Move todas as memórias de uma pasta; apaga a pasta de origem se sobrar só o índice vazio. */
export function moveAllMemories(srcDir: string, dstDir: string): string[] {
  const moved = listMemories(srcDir).map(m => moveMemory(srcDir, m.fileName, dstDir));
  const index = path.join(srcDir, 'MEMORY.md');
  try {
    if (fs.existsSync(index) && !fs.readFileSync(index, 'utf8').trim()) fs.rmSync(index);
    if (!fs.readdirSync(srcDir).length) fs.rmdirSync(srcDir);
  } catch {
    // pasta em uso ou com outros arquivos: fica
  }
  return moved;
}
