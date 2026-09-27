/** Modelos de tarefa para agentes, sem depender do VS Code (testado em test/env.test.js). */
import { t } from '../i18n';

export interface TaskTemplate {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  source: 'default' | 'settings' | 'repository';
  /** Arquivo .md de origem (modelos do repositório). */
  file?: string;
}

/** Modelos padrão, no idioma da interface. Os placeholders `${…}` entram como argumentos do t(). */
export function defaultTemplates(): TaskTemplate[] {
  return [
    {
      id: 'fix-tests',
      name: t('Fix failing tests'),
      description: t('Runs the suite, investigates and fixes the failures'),
      prompt: t('On branch {0}, run the project\'s test suite, investigate each failure and fix the cause (not the test, unless the test is wrong). Run it again until it passes and make small commits explaining each fix.',
        '${branch}',
      ),
      source: 'default',
    },
    {
      id: 'update-deps',
      name: t('Update dependencies'),
      description: t('Updates dependencies safely and runs the tests'),
      prompt: t('On branch {0}, update the project\'s dependencies to compatible versions (no major version jumps unless needed). Read the relevant changelogs, adjust the code if something breaks, run the tests and make one commit per group of dependencies.',
        '${branch}',
      ),
      source: 'default',
    },
    {
      id: 'write-tests',
      name: t('Write tests for the open file'),
      description: t('Tests for {0}', '${file}'),
      prompt: t(
        'Write tests for {0} on branch {1}, following the testing pattern the project already uses. Cover the main paths and the edge cases, run the tests and commit.',
        '${file}',
        '${branch}',
      ),
      source: 'default',
    },
    {
      id: 'simplify-diff',
      name: t('Review and simplify the diff'),
      description: t('Reviews what the branch changed compared to the base'),
      prompt: t(
        'Review what branch {0} changed compared to {1} (git diff {1}...HEAD). Simplify what is too complex, remove dead code and duplication, without changing the behavior. Run the tests and commit.',
        '${branch}',
        '${base}',
      ),
      source: 'default',
    },
    {
      id: 'document-branch',
      name: t('Document the branch in the README'),
      description: t('Updates the documentation with what the branch brings'),
      prompt: t('Document in the README (or in the project\'s documentation) what branch {0} brings compared to {1}: how to use it, new settings and limitations. Keep the style of the existing documentation and commit.',
        '${branch}',
        '${base}',
      ),
      source: 'default',
    },
    {
      id: 'investigate-error',
      name: t('Investigate error'),
      description: t('Investigates the error selected in the editor'),
      prompt:
        t('Investigate the error below on branch {0}. Find the cause, propose the minimal fix, implement it, run the tests and commit. If you can\'t reproduce it, explain what you checked.',
          '${branch}',
        ) + '\n\n```\n${selection}\n```',
      source: 'default',
    },
  ];
}

/** Nome do tipo de origem, para mostrar. */
export function sourceLabel(source: TaskTemplate['source']): string {
  if (source === 'settings') return t('settings');
  if (source === 'repository') return t('repository');
  return t('default');
}

/** Troca ${nome}; placeholders sem valor viram texto vazio (exceto os desconhecidos, que ficam). */
export function renderTemplate(prompt: string, vars: Record<string, string | undefined>): string {
  return prompt.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] ?? '' : m));
}

/** Placeholders usados pelo modelo (para avisar quando falta arquivo ou seleção). */
export function placeholdersOf(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(/\$\{(\w+)\}/g)].map(m => m[1]))];
}

/**
 * Arquivo `.agentyard/templates/<id>.md`: frontmatter opcional (name, description) e o prompt no corpo.
 */
export function parseTemplateFile(text: string, fileName: string): TaskTemplate {
  const id = fileName.replace(/\.md$/i, '');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const field = (k: string) => (fm ? new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(fm[1])?.[1].replace(/^["']|["']$/g, '').trim() : undefined);
  return {
    id,
    name: field('name') ?? id,
    description: field('description'),
    prompt: (fm ? text.slice(fm[0].length) : text).trim(),
    source: 'repository',
  };
}

export function templateFileText(name: string, description: string, prompt: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${prompt}\n`;
}

export function slug(s: string): string {
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'modelo'
  );
}
