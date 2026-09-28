import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Controller } from '../controller';
import { t } from '../i18n';
import { defaultTemplates, parseTemplateFile, placeholdersOf, renderTemplate, slug, sourceLabel, TaskTemplate, templateFileText } from './core';

type Guard = <T extends unknown[]>(fn: (...args: T) => unknown) => (...args: T) => Promise<void>;
type Arg = { path?: string; branch?: string } | undefined;
const TEMPLATE_DIR = path.join('.agentyard', 'templates');
const k = (p: string) => path.normalize(p).toLowerCase();

/** Biblioteca de prompts reutilizáveis: padrões, configuração e `.agentyard/templates/*.md` do repositório. */
export class TemplateService {
  private readonly sent = new vscode.EventEmitter<{ template: string; path: string; branch?: string }>();
  /** Um modelo foi para um agente (agora ou pela fila). */
  readonly onDidSend = this.sent.event;

  constructor(private readonly ctl: Controller, private readonly issueOf: (branch: string) => string | undefined) {}

  private async mainPath() {
    const repo = this.ctl.repo;
    return repo ? (await repo.worktreesFast())[0]?.path ?? repo.root : undefined;
  }

  async list(): Promise<TaskTemplate[]> {
    const fromCfg = this.ctl
      .cfg()
      .get<{ name: string; description?: string; prompt: string }[]>('taskTemplates', [])
      .filter(c => c?.name && c?.prompt)
      .map((c): TaskTemplate => ({ id: `cfg:${slug(c.name)}`, name: c.name, description: c.description, prompt: c.prompt, source: 'settings' }));
    const fromRepo: TaskTemplate[] = [];
    const main = await this.mainPath();
    if (main) {
      const dir = path.join(main, TEMPLATE_DIR);
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith('.md'));
      } catch {
        // sem modelos no repositório
      }
      for (const n of names) {
        try {
          fromRepo.push({ ...parseTemplateFile(fs.readFileSync(path.join(dir, n), 'utf8'), n), file: path.join(dir, n) });
        } catch {
          // arquivo ilegível: ignora
        }
      }
    }
    // repositório > configuração > padrão, pelo nome
    const out = new Map<string, TaskTemplate>();
    for (const tpl of [...defaultTemplates(), ...fromCfg, ...fromRepo]) out.set(tpl.name.toLowerCase(), tpl);
    return [...out.values()];
  }

  /** Worktree do argumento; senão a do arquivo aberto; senão pergunta. */
  private async target(arg: Arg): Promise<{ path: string; branch?: string } | undefined> {
    const wts = this.ctl.repo ? (await this.ctl.repo.worktreesFast()).filter(w => !w.prunable && !w.bare) : [];
    if (arg?.path) return { path: arg.path, branch: arg.branch ?? wts.find(w => k(w.path) === k(arg.path!))?.branch };
    if (arg?.branch) {
      const w = wts.find(x => x.branch === arg.branch);
      if (w) return { path: w.path, branch: w.branch };
    }
    const file = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (file) {
      const own = wts.filter(w => k(file).startsWith(k(w.path) + path.sep)).sort((a, b) => b.path.length - a.path.length)[0];
      if (own) return { path: own.path, branch: own.branch };
    }
    const pick = await vscode.window.showQuickPick(wts.map(w => ({ label: w.branch ?? path.basename(w.path), description: w.path, w })), {
      placeHolder: t('Use the template in which worktree?'),
    });
    return pick ? { path: pick.w.path, branch: pick.w.branch } : undefined;
  }

  /** Variáveis do modelo: branch, base, arquivo e seleção do editor (relativos à worktree), issue ligada. */
  async vars(wt: { path: string; branch?: string }): Promise<Record<string, string>> {
    const { base } = this.ctl.state ?? (await this.ctl.base());
    const ed = vscode.window.activeTextEditor;
    let file = '';
    let selection = '';
    if (ed && ed.document.uri.scheme === 'file') {
      const p = ed.document.uri.fsPath;
      file = k(p).startsWith(k(wt.path) + path.sep) ? path.relative(wt.path, p).split(path.sep).join('/') : vscode.workspace.asRelativePath(p, false);
      if (!ed.selection.isEmpty) selection = ed.document.getText(ed.selection);
    }
    return { branch: wt.branch ?? path.basename(wt.path), base, file, selection, issue: (wt.branch && this.issueOf(wt.branch)) || '' };
  }

  /** Envia o modelo pronto: agente agora (terminal novo) ou fila de tarefas da worktree. */
  async send(wt: { path: string; branch?: string }, tpl: TaskTemplate, how: 'now' | 'queue', extra: Record<string, string> = {}) {
    const prompt = renderTemplate(tpl.prompt, { ...(await this.vars(wt)), ...extra });
    if (how === 'queue') await vscode.commands.executeCommand('worktreeGraph.tasks.add', { path: wt.path, branch: wt.branch }, prompt);
    else await vscode.commands.executeCommand('worktreeGraph.launchAgentWithPrompt', { path: wt.path, branch: wt.branch, prompt });
    this.ctl.log(how === 'queue' ? t('Template "{0}" sent to {1} (queue)', tpl.name, wt.branch ?? wt.path) : t('Template "{0}" sent to {1} (agent)', tpl.name, wt.branch ?? wt.path));
    this.sent.fire({ template: tpl.name, path: wt.path, branch: wt.branch });
    return prompt;
  }

  async use(arg: Arg) {
    const wt = await this.target(arg);
    if (!wt) return;
    const all = await this.list();
    const pick = await vscode.window.showQuickPick(
      all.map(tpl => ({ label: tpl.name, description: sourceLabel(tpl.source), detail: tpl.description, tpl })),
      { title: '✦ ' + t('Task template for {0}', wt.branch ?? path.basename(wt.path)), matchOnDetail: true },
    );
    if (!pick) return;
    const tpl = pick.tpl;
    const v = await this.vars(wt);
    const need = placeholdersOf(tpl.prompt);
    if (need.includes('file') && !v.file) {
      vscode.window.showWarningMessage(t('"{0}" uses the open file: open the file in the editor and try again.', tpl.name));
      return;
    }
    const extra: Record<string, string> = {};
    if (need.includes('selection') && !v.selection) {
      const typed = await vscode.window.showInputBox({ title: tpl.name, prompt: t('Nothing selected in the editor: paste the error or the snippet here'), ignoreFocusOut: true });
      if (!typed) return;
      extra.selection = typed;
    }
    const how = await vscode.window.showQuickPick(
      [
        { label: t('Open the agent now'), description: t('in a new terminal of the worktree'), v: 'now' as const },
        { label: t('Add to the worktree\'s queue'), description: t('runs when the current task is ready'), v: 'queue' as const },
      ],
      { title: tpl.name },
    );
    if (how) await this.send(wt, tpl, how.v, extra);
  }

  async create() {
    const main = await this.mainPath();
    if (!main) return;
    const name = await vscode.window.showInputBox({ title: t('New task template'), prompt: t('Name (e.g. Migrate to the new API)'), ignoreFocusOut: true });
    if (!name) return;
    const description = (await vscode.window.showInputBox({ title: name, prompt: t('Short description (optional)'), ignoreFocusOut: true })) ?? '';
    const file = path.join(main, TEMPLATE_DIR, `${slug(name)}.md`);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, templateFileText(name, description, t('On branch {0} (base {1}), …', '${branch}', '${base}') + '\n\nPlaceholders: ${branch}, ${base}, ${file}, ${selection}, ${issue}'));
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    vscode.window.showInformationMessage(t('Template at {0}: commit it to share with the team.', path.relative(main, file)));
  }

  /** Modelos do repositório abrem direto; os padrões e da configuração viram um .md para editar. */
  async edit() {
    const main = await this.mainPath();
    if (!main) return;
    const pick = await vscode.window.showQuickPick((await this.list()).map(tpl => ({ label: tpl.name, description: sourceLabel(tpl.source), tpl })), { title: t('Edit which template?') });
    if (!pick) return;
    let file = pick.tpl.file;
    if (!file) {
      file = path.join(main, TEMPLATE_DIR, `${slug(pick.tpl.name)}.md`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, templateFileText(pick.tpl.name, pick.tpl.description ?? '', pick.tpl.prompt));
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  }
}

export function registerTemplates(ctx: vscode.ExtensionContext, ctl: Controller, guard: Guard, issueOf: (branch: string) => string | undefined): TemplateService {
  const svc = new TemplateService(ctl, issueOf);
  const reg = (id: string, fn: (...args: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(`worktreeGraph.${id}`, guard(fn)));
  reg('templates.use', (arg?: Arg) => svc.use(arg));
  reg('templates.new', () => svc.create());
  reg('templates.edit', () => svc.edit());
  return svc;
}
