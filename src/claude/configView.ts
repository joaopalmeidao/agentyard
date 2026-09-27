import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import type { Controller } from '../controller';
import {
  addIndexLine,
  addPermission,
  checkIndex,
  ConfigFile,
  configFiles,
  copyToScope,
  createMemory,
  createSkill,
  deleteEntry,
  deleteMemory,
  listCommands,
  listHooks,
  listMemories,
  listPermissions,
  listSkills,
  MemoryEntry,
  MemoryType,
  memoryDirFor,
  PermissionList,
  readSettings,
  removeIndexLines,
  removePermission,
  renameEntry,
  Scope,
  setModel,
  SkillEntry,
  validSkillName,
} from './config';

type Group = 'skills' | 'commands' | 'config' | 'memory' | 'worktreeMemories';

export class ScopeNode extends vscode.TreeItem {
  readonly kind = 'scope';
  constructor(readonly scope: Scope, label: string, description: string) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `claudeConfig:${scope}`;
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(scope === 'user' ? 'account' : 'repo');
    this.contextValue = `claudeScope-${scope}`;
  }
}

export class GroupNode extends vscode.TreeItem {
  readonly kind = 'group';
  constructor(readonly scope: Scope, readonly group: Group, label: string, count: number | string, readonly memDir?: string, readonly cwd?: string, warn?: string) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `claudeConfig:${scope}:${group}:${cwd ?? ''}`;
    this.description = `${count}${warn ? '  ⚠' : ''}`;
    this.tooltip = warn ?? (memDir ? memDir : undefined);
    this.iconPath = new vscode.ThemeIcon({ skills: 'lightbulb', commands: 'terminal', config: 'settings-gear', memory: 'book', worktreeMemories: 'git-branch' }[group]);
    this.contextValue = `claudeGroup-${group}`;
  }
}

export class SkillNode extends vscode.TreeItem {
  readonly kind = 'skill';
  constructor(readonly entry: SkillEntry) {
    super(entry.kind === 'command' ? `/${entry.name}` : entry.name, vscode.TreeItemCollapsibleState.None);
    this.description = entry.error ? '⚠ ' + entry.error : entry.readOnly ? 'sincronizada' : '';
    this.tooltip = new vscode.MarkdownString(`**${entry.name}**${entry.readOnly ? ' (sincronizada da conta, só leitura)' : ''}\n\n${entry.description || '_sem descrição_'}\n\n\`${entry.file}\``);
    this.iconPath = new vscode.ThemeIcon(entry.error ? 'warning' : entry.kind === 'command' ? 'symbol-event' : entry.readOnly ? 'cloud' : 'lightbulb');
    this.resourceUri = vscode.Uri.file(entry.file);
    this.contextValue = entry.kind === 'command' ? 'claudeCommand' : entry.readOnly ? 'claudeSkillRo' : 'claudeSkill';
    this.command = { command: 'vscode.open', title: 'Abrir', arguments: [vscode.Uri.file(entry.file)] };
    this.label = entry.kind === 'command' ? `/${entry.name}` : entry.name;
  }
}

export class ConfigNode extends vscode.TreeItem {
  readonly kind = 'config';
  constructor(readonly cfg: ConfigFile) {
    super(cfg.label, vscode.TreeItemCollapsibleState.None);
    const isSettings = cfg.kind === 'settings' || cfg.kind === 'settings-local';
    let desc = cfg.exists ? '' : 'não existe · clique para criar';
    if (cfg.exists && isSettings) {
      const s = readSettings(cfg.file);
      if (s.error) desc = '⚠ ' + s.error;
      else {
        const p = listPermissions(cfg.file);
        desc = [s.data.model ? `modelo ${s.data.model}` : '', `${p.allow.length} allow · ${p.deny.length} deny · ${p.ask.length} ask`, listHooks(cfg.file).length ? `${listHooks(cfg.file).length} hook(s)` : '']
          .filter(Boolean)
          .join(' · ');
      }
    }
    this.description = desc;
    this.tooltip = cfg.file;
    this.iconPath = new vscode.ThemeIcon(isSettings ? 'json' : cfg.kind === 'mcp' ? 'plug' : 'markdown', cfg.exists ? undefined : new vscode.ThemeColor('disabledForeground'));
    this.contextValue = isSettings ? 'claudeSettings' : 'claudeFile';
    this.command = { command: 'worktreeGraph.claudeConfig.openFile', title: 'Abrir', arguments: [this] };
  }
}

export class MemoryNode extends vscode.TreeItem {
  readonly kind = 'memory';
  constructor(readonly entry: MemoryEntry, readonly memDir: string) {
    super(entry.name, vscode.TreeItemCollapsibleState.None);
    this.description = [entry.type, entry.indexed ? '' : '⚠ fora do índice', entry.error ? `⚠ ${entry.error}` : ''].filter(Boolean).join(' · ');
    this.tooltip = new vscode.MarkdownString(`**${entry.name}** (${entry.type})\n\n${entry.description}\n\n\`${entry.file}\``);
    this.iconPath = new vscode.ThemeIcon({ user: 'person', feedback: 'comment-discussion', project: 'project', reference: 'link' }[entry.type] ?? 'note');
    this.resourceUri = vscode.Uri.file(entry.file);
    this.contextValue = 'claudeMemory';
    this.command = { command: 'vscode.open', title: 'Abrir', arguments: [vscode.Uri.file(entry.file)] };
    this.label = entry.name;
  }
}

class InfoNode extends vscode.TreeItem {
  readonly kind = 'info';
  constructor(label: string, tooltip: string, command?: vscode.Command, icon = 'info') {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.tooltip = tooltip;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = command;
  }
}

type Node = ScopeNode | GroupNode | SkillNode | ConfigNode | MemoryNode | InfoNode;

/** View "Claude: configuração": skills, comandos, configurações e memória, do usuário e do projeto ativo. */
export class ClaudeConfigService implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private watchers: vscode.Disposable[] = [];
  private readonly disposables: vscode.Disposable[] = [this.emitter];
  private debounce?: NodeJS.Timeout;

  constructor(private readonly ctl: Controller) {
    this.disposables.push(
      ctl.onDidChangeRepo(() => {
        this.watch();
        this.refresh();
      }),
      vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('worktreeGraph.claude.configDir') && (this.watch(), this.refresh())),
    );
    this.watch();
  }

  claudeDir(): string {
    return vscode.workspace.getConfiguration('worktreeGraph.claude').get<string>('configDir', '') || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  }

  /** Pasta principal do projeto ativo (a worktree principal, onde ficam .claude e CLAUDE.md versionados). */
  projectDir(): string | undefined {
    return this.ctl.state?.worktrees.find(w => w.isMain)?.path ?? this.ctl.repo?.root;
  }

  memoryDir(cwd = this.projectDir()): string | undefined {
    return cwd ? memoryDirFor(this.claudeDir(), cwd) : undefined;
  }

  refresh() {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.emitter.fire(), 250);
  }

  private watch() {
    this.watchers.forEach(w => w.dispose());
    this.watchers = [];
    const kick = () => this.refresh();
    const add = (base: string, glob: string) => {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), glob));
      this.watchers.push(w, w.onDidChange(kick), w.onDidCreate(kick), w.onDidDelete(kick));
    };
    add(this.claudeDir(), '{skills/**,commands/**,settings.json,CLAUDE.md,projects/*/memory/**}');
    const p = this.projectDir();
    if (p) add(p, '{.claude/**,CLAUDE.md,CLAUDE.local.md,.mcp.json}');
  }

  getTreeItem(n: Node) {
    return n;
  }

  getChildren(n?: Node): Node[] {
    const dir = this.claudeDir();
    const proj = this.projectDir();
    try {
      if (!n) {
        const out: Node[] = [new ScopeNode('user', 'Usuário', dir.replace(os.homedir(), '~'))];
        if (proj) out.push(new ScopeNode('project', `Projeto: ${path.basename(proj)}`, proj));
        return out;
      }
      if (n instanceof ScopeNode) {
        const skills = listSkills(n.scope, dir, proj);
        const commands = listCommands(n.scope, dir, proj);
        const files = configFiles(dir, proj).filter(f => f.scope === n.scope);
        const groups: Node[] = [
          new GroupNode(n.scope, 'skills', 'Skills', skills.length),
          new GroupNode(n.scope, 'commands', 'Comandos', commands.length),
          new GroupNode(n.scope, 'config', 'Configurações', files.filter(f => f.exists).length + '/' + files.length),
        ];
        if (n.scope === 'project' && proj) {
          const mem = this.memoryDir(proj)!;
          const chk = checkIndex(mem);
          const issues = chk.missingInIndex.length + chk.dangling.length;
          groups.push(new GroupNode('project', 'memory', 'Memória', listMemories(mem).length, mem, proj, issues ? `${issues} problema(s) no índice MEMORY.md` : undefined));
          const wts = this.worktreeMemories();
          if (wts.length) groups.push(new GroupNode('project', 'worktreeMemories', 'Memória das worktrees', wts.length));
        }
        return groups;
      }
      if (n instanceof GroupNode) {
        if (n.group === 'skills') {
          const list = listSkills(n.scope, dir, proj).map(e => new SkillNode(e));
          return list.length ? list : [new InfoNode('Nenhuma skill', 'Crie uma pelo + do grupo', { command: 'worktreeGraph.claudeConfig.newSkill', title: 'Nova skill', arguments: [n] }, 'add')];
        }
        if (n.group === 'commands') return listCommands(n.scope, dir, proj).map(e => new SkillNode(e));
        if (n.group === 'config') return configFiles(dir, proj).filter(f => f.scope === n.scope).map(f => new ConfigNode(f));
        if (n.group === 'memory') return this.memoryChildren(n.memDir!);
        if (n.group === 'worktreeMemories') {
          return this.worktreeMemories().map(w => {
            const mem = this.memoryDir(w.path)!;
            return new GroupNode('project', 'memory', w.name, listMemories(mem).length, mem, w.path);
          });
        }
      }
    } catch (e) {
      return [new InfoNode(`Erro: ${(e as Error).message}`, String((e as Error).stack), undefined, 'error')];
    }
    return [];
  }

  private memoryChildren(mem: string): Node[] {
    const out: Node[] = [];
    const chk = checkIndex(mem);
    if (chk.missingInIndex.length || chk.dangling.length) {
      out.push(
        new InfoNode(
          `Índice: ${chk.missingInIndex.length} fora do MEMORY.md, ${chk.dangling.length} link(s) quebrado(s)`,
          'Clique para corrigir',
          { command: 'worktreeGraph.claudeConfig.checkMemoryIndex', title: 'Verificar índice', arguments: [mem] },
          'warning',
        ),
      );
    }
    out.push(...listMemories(mem).map(m => new MemoryNode(m, mem)));
    if (fs.existsSync(path.join(mem, 'MEMORY.md'))) {
      const idx = path.join(mem, 'MEMORY.md');
      out.push(new InfoNode('MEMORY.md (índice)', idx, { command: 'vscode.open', title: 'Abrir', arguments: [vscode.Uri.file(idx)] }, 'list-unordered'));
    }
    if (!out.length) out.push(new InfoNode('Nenhuma memória', 'Crie uma pelo + do grupo', { command: 'worktreeGraph.claudeConfig.newMemory', title: 'Nova memória', arguments: [mem] }, 'add'));
    return out;
  }

  /** Worktrees (fora a principal) que já têm memória própria. */
  private worktreeMemories() {
    return (this.ctl.state?.worktrees ?? []).filter(w => !w.isMain && !w.prunable && !w.bare && fs.existsSync(this.memoryDir(w.path)!));
  }

  // ------------------------------------------------------------ ações

  async newSkill(arg?: GroupNode | ScopeNode | Scope) {
    let scope: Scope | undefined = typeof arg === 'string' ? arg : arg?.scope;
    if (!scope) {
      const p = await vscode.window.showQuickPick(
        [
          { label: 'Usuário', description: 'vale em todos os projetos', v: 'user' as Scope },
          ...(this.projectDir() ? [{ label: 'Projeto', description: `${path.basename(this.projectDir()!)}/.claude/skills, versionada com o repositório`, v: 'project' as Scope }] : []),
        ],
        { title: 'Nova skill: onde?' },
      );
      if (!p) return;
      scope = p.v;
    }
    const name = await vscode.window.showInputBox({ title: 'Nova skill: nome', prompt: 'minúsculas e hífens, ex.: revisar-pr', validateInput: validSkillName });
    if (!name) return;
    const description = await vscode.window.showInputBox({
      title: 'Nova skill: descrição',
      prompt: 'O Claude usa esta frase para decidir quando carregar a skill. Diga o que ela faz e quando usar.',
      ignoreFocusOut: true,
    });
    if (description === undefined) return;
    const file = createSkill(scope, this.claudeDir(), this.projectDir(), name, description);
    this.refresh();
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  }

  async copySkill(n: SkillNode) {
    const target: Scope = n.entry.scope === 'user' ? 'project' : 'user';
    if (target === 'project' && !this.projectDir()) throw new Error('Nenhum projeto ativo.');
    const file = copyToScope(n.entry, target, this.claudeDir(), this.projectDir());
    this.refresh();
    vscode.window.showInformationMessage(`${n.entry.name} copiada para ${target === 'user' ? 'o usuário' : 'o projeto'}: ${file}`);
  }

  async renameSkill(n: SkillNode) {
    const newName = await vscode.window.showInputBox({
      title: `Renomear ${n.entry.name}`,
      value: n.entry.kind === 'skill' ? path.basename(n.entry.dir!) : path.basename(n.entry.file, '.md'),
      validateInput: v => (n.entry.kind === 'skill' ? validSkillName(v) : v.trim() ? undefined : 'Informe um nome.'),
    });
    if (!newName) return;
    renameEntry(n.entry, newName);
    this.refresh();
  }

  async deleteSkill(n: SkillNode) {
    const what = n.entry.kind === 'skill' ? `a skill ${n.entry.name} (pasta inteira)` : `o comando /${n.entry.name}`;
    const ok = await vscode.window.showWarningMessage(`Excluir ${what}?`, { modal: true, detail: n.entry.dir ?? n.entry.file }, 'Excluir');
    if (!ok) return;
    deleteEntry(n.entry);
    this.refresh();
  }

  async openFile(n: ConfigNode) {
    const f = n.cfg;
    if (!f.exists) {
      const ok = await vscode.window.showInformationMessage(`${f.label} não existe. Criar?`, { modal: true, detail: f.file }, 'Criar');
      if (!ok) return;
      fs.mkdirSync(path.dirname(f.file), { recursive: true });
      const initial = f.kind === 'settings' || f.kind === 'settings-local' ? '{\n  "permissions": {\n    "allow": []\n  }\n}\n' : f.kind === 'mcp' ? '{\n  "mcpServers": {}\n}\n' : `# ${f.kind === 'claude-local-md' ? 'Instruções só minhas' : 'Instruções para o Claude'}\n\n`;
      fs.writeFileSync(f.file, initial);
      this.refresh();
    }
    await vscode.window.showTextDocument(vscode.Uri.file(f.file));
  }

  /** Lista as regras; escolher uma remove, os itens "+" adicionam. Repete até Esc. */
  async editPermissions(n: ConfigNode) {
    const file = n.cfg.file;
    const lists: PermissionList[] = ['allow', 'ask', 'deny'];
    const labels: Record<PermissionList, string> = { allow: 'permitir sem perguntar', ask: 'sempre perguntar', deny: 'bloquear' };
    for (;;) {
      const cur = readSettings(file);
      if (cur.error) {
        vscode.window.showErrorMessage(`${path.basename(file)}: ${cur.error}. Corrija o arquivo antes.`);
        await vscode.window.showTextDocument(vscode.Uri.file(file));
        return;
      }
      const p = listPermissions(file);
      type It = vscode.QuickPickItem & { add?: PermissionList; rm?: [PermissionList, string] };
      const items: It[] = [];
      for (const l of lists) {
        items.push({ label: `${l} — ${labels[l]}`, kind: vscode.QuickPickItemKind.Separator });
        items.push({ label: `$(add) Adicionar regra em ${l}`, add: l });
        for (const r of p[l]) items.push({ label: r, description: 'selecione para remover', rm: [l, r] });
      }
      const pick = await vscode.window.showQuickPick(items, {
        title: `Permissões: ${n.cfg.label}`,
        placeHolder: 'Ex. de regras: Bash(npm run test:*), Read(./src/**), WebFetch(domain:github.com), mcp__servidor',
      });
      if (!pick) return;
      let backup: string | undefined;
      if (pick.add) {
        const rule = await vscode.window.showInputBox({
          title: `Nova regra (${pick.add})`,
          prompt: 'Ferramenta com padrão opcional: Bash(git status), Bash(npm run *), Edit(src/**), Read, WebFetch(domain:exemplo.com)',
          ignoreFocusOut: true,
        });
        if (!rule) continue;
        backup = addPermission(file, pick.add, rule);
      } else if (pick.rm) {
        const ok = await vscode.window.showWarningMessage(`Remover "${pick.rm[1]}" de ${pick.rm[0]}?`, { modal: true }, 'Remover');
        if (!ok) continue;
        backup = removePermission(file, pick.rm[0], pick.rm[1]);
      }
      this.refresh();
      if (backup) this.ctl.log(`${path.basename(file)} atualizado (cópia anterior em ${backup}).`);
    }
  }

  async setModel(n: ConfigNode) {
    const cur = readSettings(n.cfg.file);
    if (cur.error) throw new Error(cur.error);
    const options = [
      { label: 'Padrão do Claude Code', description: 'remove a chave "model"', v: '' },
      { label: 'opus', v: 'opus' },
      { label: 'sonnet', v: 'sonnet' },
      { label: 'haiku', v: 'haiku' },
      { label: 'claude-opus-5-5', v: 'claude-opus-5-5' },
      { label: 'claude-sonnet-5', v: 'claude-sonnet-5' },
      { label: '$(edit) Outro…', v: '?' },
    ].map(o => ({ ...o, description: o.v === cur.data.model ? 'atual' : o.description }));
    const pick = await vscode.window.showQuickPick(options, { title: `Modelo padrão: ${n.cfg.label}`, placeHolder: `Atual: ${cur.data.model ?? 'padrão'}` });
    if (!pick) return;
    let model = pick.v;
    if (model === '?') {
      model = (await vscode.window.showInputBox({ title: 'ID do modelo', value: cur.data.model ?? '' })) ?? '';
      if (!model) return;
    }
    setModel(n.cfg.file, model || undefined);
    this.refresh();
    vscode.window.showInformationMessage(model ? `Modelo padrão: ${model} (vale para novas sessões).` : 'Modelo volta ao padrão do Claude Code.');
  }

  async showHooks(n: ConfigNode) {
    const hooks = listHooks(n.cfg.file);
    const md = hooks.length
      ? `# Hooks em ${n.cfg.label}\n\n${hooks.map(h => `- \`${h.replace(/`/g, "'")}\``).join('\n')}\n\nPara editar, abra o arquivo: ${n.cfg.file}\n`
      : `# Hooks em ${n.cfg.label}\n\nNenhum hook configurado.\n`;
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  /** `arg`: grupo de memória (ou a pasta); sem nada, usa a memória do projeto ativo. */
  async newMemory(arg?: GroupNode | string) {
    const mem = typeof arg === 'string' ? arg : arg?.memDir ?? this.memoryDir();
    if (!mem) throw new Error('Nenhum projeto ativo.');
    const types: { label: string; description: string; v: MemoryType }[] = [
      { label: 'user', description: 'quem é o usuário: papel, experiência, preferências', v: 'user' },
      { label: 'feedback', description: 'orientação de como trabalhar (correções e o que deu certo)', v: 'feedback' },
      { label: 'project', description: 'trabalho em andamento, metas, restrições', v: 'project' },
      { label: 'reference', description: 'onde achar coisas: URLs, painéis, tickets', v: 'reference' },
    ];
    const type = await vscode.window.showQuickPick(types, { title: 'Nova memória: tipo' });
    if (!type) return;
    const title = await vscode.window.showInputBox({ title: 'Nova memória: título', prompt: 'Vira o nome do arquivo e o link no MEMORY.md', ignoreFocusOut: true });
    if (!title) return;
    const description = await vscode.window.showInputBox({ title: 'Nova memória: descrição de uma linha', prompt: 'Usada para decidir quando a memória é relevante', ignoreFocusOut: true });
    if (description === undefined) return;
    const body = await vscode.window.showInputBox({ title: 'Nova memória: o fato (dá para editar depois no arquivo)', ignoreFocusOut: true });
    if (body === undefined) return;
    const file = createMemory(mem, { type: type.v, title, description, body });
    this.refresh();
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  }

  async deleteMemory(n: MemoryNode) {
    const ok = await vscode.window.showWarningMessage(`Excluir a memória "${n.entry.name}"?`, { modal: true, detail: `${n.entry.file}\nA linha dela no MEMORY.md também sai.` }, 'Excluir');
    if (!ok) return;
    deleteMemory(n.memDir, n.entry.fileName);
    this.refresh();
  }

  async checkMemoryIndex(arg?: GroupNode | string) {
    const mem = typeof arg === 'string' ? arg : arg?.memDir ?? this.memoryDir();
    if (!mem) return;
    const chk = checkIndex(mem);
    if (!chk.missingInIndex.length && !chk.dangling.length) {
      vscode.window.showInformationMessage('Índice MEMORY.md em ordem.');
      return;
    }
    const actions: string[] = [];
    if (chk.missingInIndex.length) actions.push(`Adicionar ${chk.missingInIndex.length} ao índice`);
    if (chk.dangling.length) actions.push(`Remover ${chk.dangling.length} link(s) quebrado(s)`);
    const pick = await vscode.window.showWarningMessage(
      'Índice MEMORY.md desalinhado',
      {
        modal: true,
        detail: [
          chk.missingInIndex.length ? `Fora do índice:\n${chk.missingInIndex.map(f => `• ${f}`).join('\n')}` : '',
          chk.dangling.length ? `Links para arquivos que não existem:\n${chk.dangling.map(f => `• ${f}`).join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
      ...actions,
    );
    if (!pick) return;
    if (pick.startsWith('Adicionar')) {
      for (const m of listMemories(mem).filter(x => !x.indexed)) addIndexLine(mem, m.fileName, m.name, m.description || m.type);
    } else {
      for (const f of chk.dangling) removeIndexLines(mem, f);
    }
    this.refresh();
  }

  dispose() {
    this.watchers.forEach(w => w.dispose());
    this.disposables.forEach(d => d.dispose());
  }
}

/** Registra a view e os comandos; devolve o serviço (usado nos testes). */
export function registerClaudeConfig(ctx: vscode.ExtensionContext, ctl: Controller): ClaudeConfigService {
  const svc = new ClaudeConfigService(ctl);
  const view = vscode.window.createTreeView('worktreeGraph.claudeConfig', { treeDataProvider: svc, showCollapseAll: true });
  ctx.subscriptions.push(svc, view, ctl.onDidChange(() => svc.refresh()));
  const reg = (id: string, fn: (...a: any[]) => unknown) =>
    ctx.subscriptions.push(
      vscode.commands.registerCommand(`worktreeGraph.claudeConfig.${id}`, async (...a: any[]) => {
        try {
          await fn(...a);
        } catch (e) {
          vscode.window.showErrorMessage(`Claude: ${(e as Error).message}`);
        }
      }),
    );
  reg('refresh', () => svc.refresh());
  reg('newSkill', n => svc.newSkill(n));
  reg('copySkill', n => svc.copySkill(n));
  reg('renameSkill', n => svc.renameSkill(n));
  reg('deleteSkill', n => svc.deleteSkill(n));
  reg('revealSkill', (n: SkillNode) => vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(n.entry.dir ?? n.entry.file)));
  reg('openFile', n => svc.openFile(n));
  reg('editPermissions', n => svc.editPermissions(n));
  reg('setModel', n => svc.setModel(n));
  reg('showHooks', n => svc.showHooks(n));
  reg('newMemory', n => svc.newMemory(n));
  reg('deleteMemory', n => svc.deleteMemory(n));
  reg('checkMemoryIndex', n => svc.checkMemoryIndex(n));
  reg('revealMemory', (n?: GroupNode) => {
    const mem = n?.memDir ?? svc.memoryDir();
    if (mem) return vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(fs.existsSync(mem) ? mem : path.dirname(mem)));
  });
  return svc;
}
