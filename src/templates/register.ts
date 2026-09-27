import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Controller } from '../controller';
import { DEFAULT_TEMPLATES, parseTemplateFile, placeholdersOf, renderTemplate, slug, TaskTemplate, templateFileText } from './core';

type Guard = <T extends unknown[]>(fn: (...args: T) => unknown) => (...args: T) => Promise<void>;
type Arg = { path?: string; branch?: string } | undefined;
const TEMPLATE_DIR = path.join('.agentyard', 'templates');
const k = (p: string) => path.normalize(p).toLowerCase();

/** Biblioteca de prompts reutilizáveis: padrões, configuração e `.agentyard/templates/*.md` do repositório. */
export class TemplateService {
  constructor(private readonly ctl: Controller, private readonly issueOf: (branch: string) => string | undefined) {}

  private async mainPath() {
    const repo = this.ctl.repo;
    return repo ? (await repo.worktreesFast())[0]?.path ?? repo.root : undefined;
  }

  async list(): Promise<TaskTemplate[]> {
    const fromCfg = this.ctl
      .cfg()
      .get<{ name: string; description?: string; prompt: string }[]>('taskTemplates', [])
      .filter(t => t?.name && t?.prompt)
      .map((t): TaskTemplate => ({ id: `cfg:${slug(t.name)}`, name: t.name, description: t.description, prompt: t.prompt, source: 'configuração' }));
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
    for (const t of [...DEFAULT_TEMPLATES, ...fromCfg, ...fromRepo]) out.set(t.name.toLowerCase(), t);
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
      placeHolder: 'Usar o modelo em qual worktree?',
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
  async send(wt: { path: string; branch?: string }, t: TaskTemplate, how: 'now' | 'queue', extra: Record<string, string> = {}) {
    const prompt = renderTemplate(t.prompt, { ...(await this.vars(wt)), ...extra });
    if (how === 'queue') await vscode.commands.executeCommand('worktreeGraph.tasks.add', { path: wt.path, branch: wt.branch }, prompt);
    else await vscode.commands.executeCommand('worktreeGraph.launchAgentWithPrompt', { path: wt.path, branch: wt.branch, prompt });
    this.ctl.log(`Modelo "${t.name}" enviado para ${wt.branch ?? wt.path} (${how === 'queue' ? 'fila' : 'agente'})`);
    return prompt;
  }

  async use(arg: Arg) {
    const wt = await this.target(arg);
    if (!wt) return;
    const all = await this.list();
    const pick = await vscode.window.showQuickPick(
      all.map(t => ({ label: t.name, description: t.source, detail: t.description, t })),
      { title: `✦ Modelo de tarefa para ${wt.branch ?? path.basename(wt.path)}`, matchOnDetail: true },
    );
    if (!pick) return;
    const t = pick.t;
    const v = await this.vars(wt);
    const need = placeholdersOf(t.prompt);
    if (need.includes('file') && !v.file) {
      vscode.window.showWarningMessage(`"${t.name}" usa o arquivo aberto: abra o arquivo no editor e tente de novo.`);
      return;
    }
    const extra: Record<string, string> = {};
    if (need.includes('selection') && !v.selection) {
      const typed = await vscode.window.showInputBox({ title: t.name, prompt: 'Nada selecionado no editor: cole aqui o erro ou o trecho', ignoreFocusOut: true });
      if (!typed) return;
      extra.selection = typed;
    }
    const how = await vscode.window.showQuickPick(
      [
        { label: 'Abrir o agente agora', description: 'num terminal novo da worktree', v: 'now' as const },
        { label: 'Colocar na fila da worktree', description: 'roda quando a tarefa atual ficar pronta', v: 'queue' as const },
      ],
      { title: t.name },
    );
    if (how) await this.send(wt, t, how.v, extra);
  }

  async create() {
    const main = await this.mainPath();
    if (!main) return;
    const name = await vscode.window.showInputBox({ title: 'Novo modelo de tarefa', prompt: 'Nome (ex.: Migrar para a nova API)', ignoreFocusOut: true });
    if (!name) return;
    const description = (await vscode.window.showInputBox({ title: name, prompt: 'Descrição curta (opcional)', ignoreFocusOut: true })) ?? '';
    const file = path.join(main, TEMPLATE_DIR, `${slug(name)}.md`);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, templateFileText(name, description, 'Na branch ${branch} (base ${base}), …\n\nPlaceholders: ${branch}, ${base}, ${file}, ${selection}, ${issue}'));
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    vscode.window.showInformationMessage(`Modelo em ${path.relative(main, file)}: faça commit para compartilhar com o time.`);
  }

  /** Modelos do repositório abrem direto; os padrões e da configuração viram um .md para editar. */
  async edit() {
    const main = await this.mainPath();
    if (!main) return;
    const pick = await vscode.window.showQuickPick((await this.list()).map(t => ({ label: t.name, description: t.source, t })), { title: 'Editar qual modelo?' });
    if (!pick) return;
    let file = pick.t.file;
    if (!file) {
      file = path.join(main, TEMPLATE_DIR, `${slug(pick.t.name)}.md`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, templateFileText(pick.t.name, pick.t.description ?? '', pick.t.prompt));
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
