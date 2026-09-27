import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Controller } from './controller';

export interface CiOptions {
  base: string;
  patterns: string[];
  exclude: string[];
  testCommand: string;
}

/** O case do bash já deixa "*" atravessar "/", então "**" vira "*". */
const toBashPatterns = (list: string[]) => list.map(p => p.replace(/\*\*/g, '*')).join(' ');

export function buildWorkflow(template: string, o: CiOptions): string {
  const test = o.testCommand.trim()
    ? [
        '      # Prepare o ambiente antes da verificação, por exemplo:',
        '      # - uses: actions/setup-node@v4',
        '      #   with: { node-version: 20, cache: npm }',
        '      # - run: npm ci',
        '      - name: Verificação',
        '        shell: bash',
        '        run: |',
        ...o.testCommand.split(/\r?\n/).map(l => `          ${l}`),
      ].join('\n')
    : ['      # Sem verificação configurada. Para rodar testes antes do push, adicione aqui:', '      # - name: Verificação', '      #   run: npm test'].join('\n');
  return template
    .replace(/__BASE__/g, o.base)
    .replace(/__PATTERNS__/g, toBashPatterns(o.patterns))
    .replace(/__EXCLUDE__/g, toBashPatterns(o.exclude))
    .replace('__TEST_STEPS__', test);
}

export async function generateCiWorkflow(ctl: Controller) {
  const repo = ctl.repo;
  if (!repo) throw new Error('Nenhum repositório git aberto.');
  const { base } = await ctl.base();
  const c = ctl.cfg();

  const patternsRaw = await vscode.window.showInputBox({
    title: 'CI: quais branches recebem a base automaticamente?',
    prompt: 'Padrões separados por espaço. * casa qualquer coisa (inclusive "/"). Ex.: feat/* ai/*',
    value: c.get<string[]>('autoSync.branches', ['**']).join(' '),
  });
  if (patternsRaw === undefined) return;
  const testCommand = await vscode.window.showInputBox({
    title: 'CI: comando de verificação depois do merge',
    prompt: 'Rodado antes do push. Vazio = sem verificação. Ex.: npm test',
    value: c.get<string>('autoSync.testCommand', ''),
  });
  if (testCommand === undefined) return;

  const template = fs.readFileSync(path.join(ctl.ctx.extensionPath, 'media', 'ci-template.yml'), 'utf8');
  const yaml = buildWorkflow(template, {
    base,
    patterns: patternsRaw.split(/\s+/).filter(Boolean),
    exclude: c.get<string[]>('autoSync.exclude', []),
    testCommand,
  });

  const file = path.join(repo.root, '.github', 'workflows', `sync-${base.replace(/[^\w.-]/g, '-')}-into-branches.yml`);
  if (fs.existsSync(file)) {
    const ok = await vscode.window.showWarningMessage(`${path.relative(repo.root, file)} já existe.`, { modal: true }, 'Sobrescrever');
    if (!ok) return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml);
  await vscode.window.showTextDocument(vscode.Uri.file(file));
  vscode.window.showInformationMessage(`Workflow criado em ${path.relative(repo.root, file)}. Revise, faça commit e push na ${base} para ativar.`);
}
