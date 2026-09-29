import * as fs from 'fs';
import * as path from 'path';
import { runGit } from './git';
import { t } from './i18n';

export type GitignoreKind = 'none' | 'generic' | 'node' | 'python' | 'dotnet';

export interface NewProjectOptions {
  /** Branch inicial; vazio = init.defaultBranch do git, senão "main". */
  branch?: string;
  readme: boolean;
  gitignore: GitignoreKind;
  /** Faz o commit inicial (worktrees precisam de um HEAD com commit). */
  commit: boolean;
}

export interface NewProjectResult {
  path: string;
  branch: string;
  committed: boolean;
  /** Motivo de o commit inicial não ter saído (ex.: user.name/user.email não configurados). */
  commitError?: string;
}

const COMMON = ['.DS_Store', 'Thumbs.db', '.env', '*.log'];
const GITIGNORE: Record<Exclude<GitignoreKind, 'none'>, string[]> = {
  generic: COMMON,
  node: ['node_modules/', 'dist/', 'out/', 'coverage/', ...COMMON],
  python: ['__pycache__/', '*.py[cod]', '.venv/', 'venv/', '.pytest_cache/', 'build/', 'dist/', '*.egg-info/', ...COMMON],
  dotnet: ['bin/', 'obj/', '.vs/', '*.user', 'TestResults/', ...COMMON],
};

/** Mensagem de erro para o nome da pasta, ou undefined se servir. */
export function validateProjectName(name: string): string | undefined {
  const n = name.trim();
  if (!n) return t('Type a name for the project folder.');
  if (/[<>:"/\\|?*\x00-\x1f]/.test(n)) return t('The name cannot contain any of {0}', '< > : " / \\ | ? *');
  if (n === '.' || n === '..' || /[. ]$/.test(n)) return t('The name cannot end with a dot or a space.');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) return t('{0} is a reserved name on Windows.', n);
  return undefined;
}

/** Problema com a pasta de destino (já é repositório), ou undefined. Pasta existente sem git vira projeto. */
export function checkTarget(dir: string): string | undefined {
  if (fs.existsSync(path.join(dir, '.git'))) return t('{0} is already a git repository. Use "Add project…".', dir);
  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) return t('{0} exists and is not a folder.', dir);
  return undefined;
}

/** Cria (ou aproveita) a pasta, faz `git init` e, se pedido, README, .gitignore e commit inicial. Não sobrescreve arquivos existentes. */
export async function createProject(parent: string, name: string, opts: NewProjectOptions): Promise<NewProjectResult> {
  const dir = path.join(parent, name.trim());
  const problem = checkTarget(dir);
  if (problem) throw new Error(problem);
  fs.mkdirSync(dir, { recursive: true });

  const init = await runGit(dir, ['init']);
  if (init.code) throw new Error(t('git init failed: {0}', (init.stderr || init.stdout).trim()));
  let branch = opts.branch?.trim() || '';
  if (!branch) branch = (await runGit(dir, ['config', '--get', 'init.defaultBranch'])).stdout.trim() || 'main';
  // `git init -b` só existe a partir do git 2.28; o symbolic-ref funciona em qualquer versão.
  await runGit(dir, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);

  const write = (file: string, content: string) => {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) fs.writeFileSync(p, content);
  };
  if (opts.readme) write('README.md', `# ${name.trim()}\n`);
  if (opts.gitignore !== 'none') write('.gitignore', GITIGNORE[opts.gitignore].join('\n') + '\n');

  if (!opts.commit) return { path: dir, branch, committed: false };
  await runGit(dir, ['add', '-A']);
  const commit = await runGit(dir, ['commit', '--allow-empty', '-m', 'Initial commit']);
  if (commit.code) return { path: dir, branch, committed: false, commitError: (commit.stderr || commit.stdout).trim() };
  return { path: dir, branch, committed: true };
}
