import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import type { AgentTerminals, OpenAgent } from '../agents';
import type { Controller } from '../controller';
import { t } from '../i18n';
import { contextFile, mentionOf, pickClaude } from './sendContext';
import type { ClaudeService, SessionItem } from './view';
import { curateMemoryPrompt, hasLearningBlock, improveSkillPrompt, learningBlock, LearnTargets, learnPrompt, moveAllMemories, moveMemory, withLearningBlock, withoutLearningBlock } from './learn';
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
  constructor(readonly scope: Scope, readonly group: Group, label: string, count: number | string, readonly memDir?: string, readonly cwd?: string, warn?: string, worktree = false) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `claudeConfig:${scope}:${group}:${cwd ?? ''}`;
    this.description = `${count}${warn ? '  ⚠' : ''}`;
    this.tooltip = warn ?? (memDir ? memDir : undefined);
    this.iconPath = new vscode.ThemeIcon({ skills: 'lightbulb', commands: 'terminal', config: 'settings-gear', memory: 'book', worktreeMemories: 'git-branch' }[group]);
    this.contextValue = `claudeGroup-${group}${worktree ? 'Wt' : ''}`;
  }
}

export class SkillNode extends vscode.TreeItem {
  readonly kind = 'skill';
  constructor(readonly entry: SkillEntry) {
    super(entry.kind === 'command' ? `/${entry.name}` : entry.name, vscode.TreeItemCollapsibleState.None);
    this.description = entry.error ? '⚠ ' + entry.error : entry.readOnly ? t('synced') : '';
    this.tooltip = new vscode.MarkdownString(`**${entry.name}**${entry.readOnly ? ' ' + t('(synced from the account, read-only)') : ''}\n\n${entry.description || t('_no description_')}\n\n\`${entry.file}\``);
    this.iconPath = new vscode.ThemeIcon(entry.error ? 'warning' : entry.kind === 'command' ? 'symbol-event' : entry.readOnly ? 'cloud' : 'lightbulb');
    this.resourceUri = vscode.Uri.file(entry.file);
    this.contextValue = entry.kind === 'command' ? 'claudeCommand' : entry.readOnly ? 'claudeSkillRo' : 'claudeSkill';
    this.command = { command: 'vscode.open', title: t('Open'), arguments: [vscode.Uri.file(entry.file)] };
    this.label = entry.kind === 'command' ? `/${entry.name}` : entry.name;
  }
}

export class ConfigNode extends vscode.TreeItem {
  readonly kind = 'config';
  constructor(readonly cfg: ConfigFile) {
    super(cfg.label, vscode.TreeItemCollapsibleState.None);
    const isSettings = cfg.kind === 'settings' || cfg.kind === 'settings-local';
    let desc = cfg.exists ? '' : t('doesn\'t exist · click to create');
    if (cfg.exists && isSettings) {
      const s = readSettings(cfg.file);
      if (s.error) desc = '⚠ ' + s.error;
      else {
        const p = listPermissions(cfg.file);
        desc = [s.data.model ? t('model {0}', s.data.model) : '', `${p.allow.length} allow · ${p.deny.length} deny · ${p.ask.length} ask`, listHooks(cfg.file).length ? t('{0} hook(s)', listHooks(cfg.file).length) : '']
          .filter(Boolean)
          .join(' · ');
      }
    }
    this.description = desc;
    this.tooltip = cfg.file;
    this.iconPath = new vscode.ThemeIcon(isSettings ? 'json' : cfg.kind === 'mcp' ? 'plug' : 'markdown', cfg.exists ? undefined : new vscode.ThemeColor('disabledForeground'));
    this.contextValue = isSettings ? 'claudeSettings' : 'claudeFile';
    this.command = { command: 'worktreeGraph.claudeConfig.openFile', title: t('Open'), arguments: [this] };
  }
}

export class MemoryNode extends vscode.TreeItem {
  readonly kind = 'memory';
  constructor(readonly entry: MemoryEntry, readonly memDir: string, worktree = false) {
    super(entry.name, vscode.TreeItemCollapsibleState.None);
    this.description = [entry.type, entry.indexed ? '' : '⚠ ' + t('not in the index'), entry.error ? `⚠ ${entry.error}` : ''].filter(Boolean).join(' · ');
    this.tooltip = new vscode.MarkdownString(`**${entry.name}** (${entry.type})\n\n${entry.description}\n\n\`${entry.file}\``);
    this.iconPath = new vscode.ThemeIcon({ user: 'person', feedback: 'comment-discussion', project: 'project', reference: 'link' }[entry.type] ?? 'note');
    this.resourceUri = vscode.Uri.file(entry.file);
    this.contextValue = worktree ? 'claudeMemoryWt' : 'claudeMemory';
    this.command = { command: 'vscode.open', title: t('Open'), arguments: [vscode.Uri.file(entry.file)] };
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

/** "Aprender com o uso": liga/desliga o bloco no CLAUDE.md do usuário e dá acesso às ações de aprendizado. */
export class LearnNode extends vscode.TreeItem {
  readonly kind = 'learn';
  constructor(on: boolean) {
    super(t('Learn from use'), vscode.TreeItemCollapsibleState.None);
    this.id = 'claudeConfig:learn';
    this.description = on ? t('on · Claude saves memories and skills by itself') : t('off · click to turn on');
    this.tooltip = new vscode.MarkdownString(
      [
        on ? t('**On**: your CLAUDE.md asks Claude to save corrections as memories and repeated procedures as skills while it works.') : t('**Off**: Claude only saves what you ask for.'),
        '',
        on ? t('Click to turn it off.') : t('Click to turn it on.'),
        t('The buttons on the right make Claude learn from the current session or tidy up the memory.'),
      ].join('\n\n'),
    );
    this.iconPath = new vscode.ThemeIcon('mortar-board', on ? new vscode.ThemeColor('charts.green') : undefined);
    this.contextValue = 'claudeLearn';
    this.command = { command: 'worktreeGraph.claudeConfig.toggleLearning', title: t('Learn from use') };
  }
}

type Node = LearnNode | ScopeNode | GroupNode | SkillNode | ConfigNode | MemoryNode | InfoNode;

export interface ClaudeConfigDeps {
  agentTerms?: AgentTerminals;
  claude?: ClaudeService;
}

/** View "Claude: configuração": skills, comandos, configurações e memória, do usuário e do projeto ativo. */
export class ClaudeConfigService implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private watchers: vscode.Disposable[] = [];
  private readonly disposables: vscode.Disposable[] = [this.emitter];
  private debounce?: NodeJS.Timeout;

  constructor(
    private readonly ctl: Controller,
    private readonly deps: ClaudeConfigDeps = {},
  ) {
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
        const out: Node[] = [new LearnNode(this.learningOn()), new ScopeNode('user', t('User'), dir.replace(os.homedir(), '~'))];
        if (proj) out.push(new ScopeNode('project', t('Project: {0}', path.basename(proj)), proj));
        return out;
      }
      if (n instanceof ScopeNode) {
        const skills = listSkills(n.scope, dir, proj);
        const commands = listCommands(n.scope, dir, proj);
        const files = configFiles(dir, proj).filter(f => f.scope === n.scope);
        const groups: Node[] = [
          new GroupNode(n.scope, 'skills', 'Skills', skills.length),
          new GroupNode(n.scope, 'commands', t('Commands'), commands.length),
          new GroupNode(n.scope, 'config', t('Settings'), files.filter(f => f.exists).length + '/' + files.length),
        ];
        if (n.scope === 'project' && proj) {
          const mem = this.memoryDir(proj)!;
          const chk = checkIndex(mem);
          const issues = chk.missingInIndex.length + chk.dangling.length;
          groups.push(new GroupNode('project', 'memory', t('Memory'), listMemories(mem).length, mem, proj, issues ? t('{0} problem(s) in the MEMORY.md index', issues) : undefined));
          const wts = this.worktreeMemories();
          if (wts.length) groups.push(new GroupNode('project', 'worktreeMemories', t('Worktree memory'), wts.length));
        }
        return groups;
      }
      if (n instanceof GroupNode) {
        if (n.group === 'skills') {
          const list = listSkills(n.scope, dir, proj).map(e => new SkillNode(e));
          return list.length ? list : [new InfoNode(t('No skills'), t('Create one with the group\'s +'), { command: 'worktreeGraph.claudeConfig.newSkill', title: t('New skill'), arguments: [n] }, 'add')];
        }
        if (n.group === 'commands') return listCommands(n.scope, dir, proj).map(e => new SkillNode(e));
        if (n.group === 'config') return configFiles(dir, proj).filter(f => f.scope === n.scope).map(f => new ConfigNode(f));
        if (n.group === 'memory') return this.memoryChildren(n.memDir!);
        if (n.group === 'worktreeMemories') {
          return this.worktreeMemories().map(w => {
            const mem = this.memoryDir(w.path)!;
            return new GroupNode('project', 'memory', w.name, listMemories(mem).length, mem, w.path, undefined, true);
          });
        }
      }
    } catch (e) {
      return [new InfoNode(t('Error: {0}', (e as Error).message), String((e as Error).stack), undefined, 'error')];
    }
    return [];
  }

  private memoryChildren(mem: string): Node[] {
    const worktree = mem !== this.memoryDir();
    const out: Node[] = [];
    const chk = checkIndex(mem);
    if (chk.missingInIndex.length || chk.dangling.length) {
      out.push(
        new InfoNode(
          t('Index: {0} not in MEMORY.md, {1} broken link(s)', chk.missingInIndex.length, chk.dangling.length),
          t('Click to fix'),
          { command: 'worktreeGraph.claudeConfig.checkMemoryIndex', title: t('Check index'), arguments: [mem] },
          'warning',
        ),
      );
    }
    out.push(...listMemories(mem).map(m => new MemoryNode(m, mem, worktree)));
    if (fs.existsSync(path.join(mem, 'MEMORY.md'))) {
      const idx = path.join(mem, 'MEMORY.md');
      out.push(new InfoNode(t('MEMORY.md (index)'), idx, { command: 'vscode.open', title: t('Open'), arguments: [vscode.Uri.file(idx)] }, 'list-unordered'));
    }
    if (!out.length) out.push(new InfoNode(t('No memories'), t('Create one with the group\'s +'), { command: 'worktreeGraph.claudeConfig.newMemory', title: t('New memory'), arguments: [mem] }, 'add'));
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
          { label: t('User'), description: t('applies to all projects'), v: 'user' as Scope },
          ...(this.projectDir() ? [{ label: t('Project'), description: t('{0}/.claude/skills, versioned with the repository', path.basename(this.projectDir()!)), v: 'project' as Scope }] : []),
        ],
        { title: t('New skill: where?') },
      );
      if (!p) return;
      scope = p.v;
    }
    const name = await vscode.window.showInputBox({ title: t('New skill: name'), prompt: t('lowercase and hyphens, e.g. review-pr'), validateInput: validSkillName });
    if (!name) return;
    const description = await vscode.window.showInputBox({
      title: t('New skill: description'),
      prompt: t('Claude uses this sentence to decide when to load the skill. Say what it does and when to use it.'),
      ignoreFocusOut: true,
    });
    if (description === undefined) return;
    const file = createSkill(scope, this.claudeDir(), this.projectDir(), name, description);
    this.refresh();
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  }

  async copySkill(n: SkillNode) {
    const target: Scope = n.entry.scope === 'user' ? 'project' : 'user';
    if (target === 'project' && !this.projectDir()) throw new Error(t('No active project.'));
    const file = copyToScope(n.entry, target, this.claudeDir(), this.projectDir());
    this.refresh();
    vscode.window.showInformationMessage(target === 'user' ? t('{0} copied to the user: {1}', n.entry.name, file) : t('{0} copied to the project: {1}', n.entry.name, file));
  }

  async renameSkill(n: SkillNode) {
    const newName = await vscode.window.showInputBox({
      title: t('Rename {0}', n.entry.name),
      value: n.entry.kind === 'skill' ? path.basename(n.entry.dir!) : path.basename(n.entry.file, '.md'),
      validateInput: v => (n.entry.kind === 'skill' ? validSkillName(v) : v.trim() ? undefined : t('Enter a name.')),
    });
    if (!newName) return;
    renameEntry(n.entry, newName);
    this.refresh();
  }

  async deleteSkill(n: SkillNode) {
    const question = n.entry.kind === 'skill' ? t('Delete the skill {0} (whole folder)?', n.entry.name) : t('Delete the command /{0}?', n.entry.name);
    const ok = await vscode.window.showWarningMessage(question, { modal: true, detail: n.entry.dir ?? n.entry.file }, t('Delete'));
    if (!ok) return;
    deleteEntry(n.entry);
    this.refresh();
  }

  async openFile(n: ConfigNode) {
    const f = n.cfg;
    if (!f.exists) {
      const ok = await vscode.window.showInformationMessage(t('{0} doesn\'t exist. Create it?', f.label), { modal: true, detail: f.file }, t('Create'));
      if (!ok) return;
      fs.mkdirSync(path.dirname(f.file), { recursive: true });
      const initial = f.kind === 'settings' || f.kind === 'settings-local' ? '{\n  "permissions": {\n    "allow": []\n  }\n}\n' : f.kind === 'mcp' ? '{\n  "mcpServers": {}\n}\n' : `# ${f.kind === 'claude-local-md' ? t('My own instructions') : t('Instructions for Claude')}\n\n`;
      fs.writeFileSync(f.file, initial);
      this.refresh();
    }
    await vscode.window.showTextDocument(vscode.Uri.file(f.file));
  }

  /** Lista as regras; escolher uma remove, os itens "+" adicionam. Repete até Esc. */
  async editPermissions(n: ConfigNode) {
    const file = n.cfg.file;
    const lists: PermissionList[] = ['allow', 'ask', 'deny'];
    const labels: Record<PermissionList, string> = { allow: t('allow without asking'), ask: t('always ask'), deny: t('block') };
    for (;;) {
      const cur = readSettings(file);
      if (cur.error) {
        vscode.window.showErrorMessage(t('{0}: {1}. Fix the file first.', path.basename(file), cur.error));
        await vscode.window.showTextDocument(vscode.Uri.file(file));
        return;
      }
      const p = listPermissions(file);
      type It = vscode.QuickPickItem & { add?: PermissionList; rm?: [PermissionList, string] };
      const items: It[] = [];
      for (const l of lists) {
        items.push({ label: `${l} — ${labels[l]}`, kind: vscode.QuickPickItemKind.Separator });
        items.push({ label: '$(add) ' + t('Add rule to {0}', l), add: l });
        for (const r of p[l]) items.push({ label: r, description: t('select to remove'), rm: [l, r] });
      }
      const pick = await vscode.window.showQuickPick(items, {
        title: t('Permissions: {0}', n.cfg.label),
        placeHolder: t('Example rules: Bash(npm run test:*), Read(./src/**), WebFetch(domain:github.com), mcp__server'),
      });
      if (!pick) return;
      let backup: string | undefined;
      if (pick.add) {
        const rule = await vscode.window.showInputBox({
          title: t('New rule ({0})', pick.add),
          prompt: t('Tool with optional pattern: Bash(git status), Bash(npm run *), Edit(src/**), Read, WebFetch(domain:example.com)'),
          ignoreFocusOut: true,
        });
        if (!rule) continue;
        backup = addPermission(file, pick.add, rule);
      } else if (pick.rm) {
        const ok = await vscode.window.showWarningMessage(t('Remove "{0}" from {1}?', pick.rm[1], pick.rm[0]), { modal: true }, t('Remove'));
        if (!ok) continue;
        backup = removePermission(file, pick.rm[0], pick.rm[1]);
      }
      this.refresh();
      if (backup) this.ctl.log(t('{0} updated (previous copy at {1}).', path.basename(file), backup));
    }
  }

  async setModel(n: ConfigNode) {
    const cur = readSettings(n.cfg.file);
    if (cur.error) throw new Error(cur.error);
    const options = [
      { label: t('Claude Code default'), description: t('removes the "model" key'), v: '' },
      { label: 'opus', v: 'opus' },
      { label: 'sonnet', v: 'sonnet' },
      { label: 'haiku', v: 'haiku' },
      { label: 'claude-opus-5-5', v: 'claude-opus-5-5' },
      { label: 'claude-sonnet-5', v: 'claude-sonnet-5' },
      { label: '$(edit) ' + t('Other…'), v: '?' },
    ].map(o => ({ ...o, description: o.v === cur.data.model ? t('current') : o.description }));
    const pick = await vscode.window.showQuickPick(options, { title: t('Default model: {0}', n.cfg.label), placeHolder: t('Current: {0}', cur.data.model ?? t('default')) });
    if (!pick) return;
    let model = pick.v;
    if (model === '?') {
      model = (await vscode.window.showInputBox({ title: t('Model ID'), value: cur.data.model ?? '' })) ?? '';
      if (!model) return;
    }
    setModel(n.cfg.file, model || undefined);
    this.refresh();
    vscode.window.showInformationMessage(model ? t('Default model: {0} (applies to new sessions).', model) : t('Model goes back to the Claude Code default.'));
  }

  async showHooks(n: ConfigNode) {
    const hooks = listHooks(n.cfg.file);
    const md = hooks.length
      ? `# ${t('Hooks in {0}', n.cfg.label)}\n\n${hooks.map(h => `- \`${h.replace(/`/g, "'")}\``).join('\n')}\n\n${t('To edit, open the file: {0}', n.cfg.file)}\n`
      : `# ${t('Hooks in {0}', n.cfg.label)}\n\n${t('No hooks configured.')}\n`;
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  /** `arg`: grupo de memória (ou a pasta); sem nada, usa a memória do projeto ativo. */
  async newMemory(arg?: GroupNode | string) {
    const mem = typeof arg === 'string' ? arg : arg?.memDir ?? this.memoryDir();
    if (!mem) throw new Error(t('No active project.'));
    const types: { label: string; description: string; v: MemoryType }[] = [
      { label: 'user', description: t('who the user is: role, experience, preferences'), v: 'user' },
      { label: 'feedback', description: t('guidance on how to work (corrections and what worked)'), v: 'feedback' },
      { label: 'project', description: t('ongoing work, goals, constraints'), v: 'project' },
      { label: 'reference', description: t('where to find things: URLs, dashboards, tickets'), v: 'reference' },
    ];
    const type = await vscode.window.showQuickPick(types, { title: t('New memory: type') });
    if (!type) return;
    const title = await vscode.window.showInputBox({ title: t('New memory: title'), prompt: t('Becomes the file name and the link in MEMORY.md'), ignoreFocusOut: true });
    if (!title) return;
    const description = await vscode.window.showInputBox({ title: t('New memory: one-line description'), prompt: t('Used to decide when the memory is relevant'), ignoreFocusOut: true });
    if (description === undefined) return;
    const body = await vscode.window.showInputBox({ title: t('New memory: the fact (you can edit it later in the file)'), ignoreFocusOut: true });
    if (body === undefined) return;
    const file = createMemory(mem, { type: type.v, title, description, body });
    this.refresh();
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  }

  async deleteMemory(n: MemoryNode) {
    const ok = await vscode.window.showWarningMessage(t('Delete the memory "{0}"?', n.entry.name), { modal: true, detail: `${n.entry.file}\n${t('Its line in MEMORY.md is removed too.')}` }, t('Delete'));
    if (!ok) return;
    deleteMemory(n.memDir, n.entry.fileName);
    this.refresh();
  }

  async checkMemoryIndex(arg?: GroupNode | string) {
    const mem = typeof arg === 'string' ? arg : arg?.memDir ?? this.memoryDir();
    if (!mem) return;
    const chk = checkIndex(mem);
    if (!chk.missingInIndex.length && !chk.dangling.length) {
      vscode.window.showInformationMessage(t('MEMORY.md index is in order.'));
      return;
    }
    const actions: string[] = [];
    const addAction = t('Add {0} to the index', chk.missingInIndex.length);
    if (chk.missingInIndex.length) actions.push(addAction);
    if (chk.dangling.length) actions.push(t('Remove {0} broken link(s)', chk.dangling.length));
    const pick = await vscode.window.showWarningMessage(
      t('MEMORY.md index out of sync'),
      {
        modal: true,
        detail: [
          chk.missingInIndex.length ? `${t('Not in the index:')}\n${chk.missingInIndex.map(f => `• ${f}`).join('\n')}` : '',
          chk.dangling.length ? `${t('Links to files that do not exist:')}\n${chk.dangling.map(f => `• ${f}`).join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
      ...actions,
    );
    if (!pick) return;
    if (pick === addAction) {
      for (const m of listMemories(mem).filter(x => !x.indexed)) addIndexLine(mem, m.fileName, m.name, m.description || m.type);
    } else {
      for (const f of chk.dangling) removeIndexLines(mem, f);
    }
    this.refresh();
  }

  // ------------------------------------------------------------ aprender com o uso

  private userClaudeMd() {
    return path.join(this.claudeDir(), 'CLAUDE.md');
  }

  learningOn(): boolean {
    try {
      return hasLearningBlock(fs.readFileSync(this.userClaudeMd(), 'utf8'));
    } catch {
      return false;
    }
  }

  /** Liga/desliga o bloco "Aprender com o uso" no CLAUDE.md do usuário (vale para as próximas sessões). */
  async toggleLearning() {
    const file = this.userClaudeMd();
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const on = hasLearningBlock(cur);
    const go = on ? t('Turn off') : t('Turn on');
    const ok = await vscode.window.showInformationMessage(
      on ? t('Stop asking Claude to learn from use?') : t('Ask Claude to learn from use?'),
      {
        modal: true,
        detail: on
          ? t('The block is removed from {0}. Memories and skills already saved stay.', file)
          : t('This block goes into {0} and applies to new sessions in every project:', file) + '\n\n' + learningBlock().split('\n').slice(1, -1).join('\n'),
      },
      go,
    );
    if (ok !== go) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, on ? withoutLearningBlock(cur) : withLearningBlock(cur));
    this.refresh();
    vscode.window.showInformationMessage(on ? t('Learning from use turned off.') : t('Learning from use turned on: new Claude sessions will save memories and skills as they work.'));
  }

  /** Onde o Claude grava o que aprende, para um Claude aberto em `cwd`. */
  learnTargets(cwd: string): LearnTargets {
    const key = (p: string) => path.normalize(p).toLowerCase();
    const inProject = this.ctl.state?.worktrees.some(w => key(w.path) === key(cwd));
    return {
      memoryDir: inProject ? this.memoryDir() : memoryDirFor(this.claudeDir(), cwd),
      userSkillsDir: path.join(this.claudeDir(), 'skills'),
      projectSkillsDir: path.join(cwd, '.claude', 'skills'),
    };
  }

  /** Claude do terminal ativo; senão pergunta (o da worktree atual primeiro). */
  private async targetClaude(placeHolder: string): Promise<OpenAgent | undefined> {
    const terms = this.deps.agentTerms;
    if (!terms) throw new Error(t('Claude terminals are not available.'));
    const active = vscode.window.activeTerminal && terms.byTerminal(vscode.window.activeTerminal);
    if (active?.claude) return active;
    return pickClaude(this.ctl, terms, this.ctl.state?.worktrees.find(w => w.isCurrent), placeHolder);
  }

  /** Manda um pedido longo (vai num arquivo, o Claude recebe a menção) e aperta Enter. */
  private async ask(target: OpenAgent, name: string, prompt: string, lead: string) {
    const file = contextFile(name, prompt);
    await this.deps.agentTerms!.type(target, `${lead} ${mentionOf(file, target.path)}`, true);
  }

  /** "Aprender com esta sessão": a sessão do item (retomada se estiver fechada) ou um Claude aberto. */
  async learn(item?: SessionItem) {
    let target: OpenAgent | undefined;
    if (item?.session) {
      if (!this.deps.claude) throw new Error(t('Claude sessions are not available.'));
      target = await this.deps.claude.resume(item.session);
    } else {
      target = await this.targetClaude(t('Which Claude should learn from its session?'));
    }
    if (!target) return;
    await this.ask(target, 'learn.md', learnPrompt(this.learnTargets(target.path)), t('Learn from this session following'));
  }

  async curateMemory(arg?: GroupNode) {
    const target = await this.targetClaude(t('Which Claude should tidy up the memory?'));
    if (!target) return;
    const targets = { ...this.learnTargets(target.path), ...(arg?.memDir ? { memoryDir: arg.memDir } : {}) };
    await this.ask(target, 'memory.md', curateMemoryPrompt(targets), t('Tidy up the memory following'));
  }

  async improveSkill(n: SkillNode) {
    if (n.entry.readOnly) throw new Error(t('Synced skill: managed by Claude.'));
    const target = await this.targetClaude(t('Which Claude should improve {0}?', n.entry.name));
    if (!target) return;
    await this.ask(target, 'skill.md', improveSkillPrompt(n.entry.file), t('Improve the skill following'));
  }

  /** Memória que ficou na pasta de uma worktree vai para a do projeto (que sobrevive à worktree). */
  async moveMemoryToProject(n: MemoryNode) {
    const dst = this.memoryDir();
    if (!dst) throw new Error(t('No active project.'));
    const file = moveMemory(n.memDir, n.entry.fileName, dst);
    this.refresh();
    vscode.window.showInformationMessage(t('{0} moved to the project memory: {1}', n.entry.name, path.basename(file)));
  }

  async mergeWorktreeMemories(n?: GroupNode) {
    const dst = this.memoryDir();
    if (!dst) throw new Error(t('No active project.'));
    const dirs = n?.memDir ? [n.memDir] : this.worktreeMemories().map(w => this.memoryDir(w.path)!);
    const count = dirs.reduce((k, d) => k + listMemories(d).length, 0);
    if (!count) {
      vscode.window.showInformationMessage(t('No worktree memories to move.'));
      return;
    }
    const go = t('Move');
    const ok = await vscode.window.showInformationMessage(
      t('Move {0} memory file(s) to the project memory?', count),
      { modal: true, detail: t('They go to {0} and into its MEMORY.md, so they are not lost when the worktree is removed. Repeated names get a suffix.', dst) },
      go,
    );
    if (ok !== go) return;
    for (const d of dirs) moveAllMemories(d, dst);
    this.refresh();
  }

  // ------------------------------------------------------------ pastas

  /** Pasta (ou arquivo) de um nó da view. */
  pathOf(n: Node): string | undefined {
    const proj = this.projectDir();
    const base = (scope: Scope) => (scope === 'user' ? this.claudeDir() : proj && path.join(proj, '.claude'));
    if (n instanceof ScopeNode) return base(n.scope);
    if (n instanceof GroupNode) {
      if (n.group === 'memory') return n.memDir;
      if (n.group === 'worktreeMemories') return path.join(this.claudeDir(), 'projects');
      if (n.group === 'config') return n.scope === 'user' ? this.claudeDir() : proj;
      const b = base(n.scope);
      return b && path.join(b, n.group);
    }
    if (n instanceof SkillNode) return n.entry.dir ?? n.entry.file;
    if (n instanceof MemoryNode) return n.entry.file;
    if (n instanceof ConfigNode) return n.cfg.file;
    return undefined;
  }

  /** Abre a pasta no gerenciador de arquivos (Explorer, Finder…); arquivo: a pasta dele, com ele selecionado. */
  async openInOS(p: string) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(p));
    let dir = p;
    while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
    return vscode.env.openExternal(vscode.Uri.file(dir));
  }

  /** Escolhe entre as pastas do Claude (usuário, projeto, memória, sessões) e abre no sistema ou no VS Code. */
  async openFolder() {
    const dir = this.claudeDir();
    const proj = this.projectDir();
    type It = vscode.QuickPickItem & { p?: string };
    const inWindow = { iconPath: new vscode.ThemeIcon('empty-window'), tooltip: t('Open in a new VS Code window') };
    const addWs = { iconPath: new vscode.ThemeIcon('root-folder'), tooltip: t('Add to the workspace') };
    const item = (label: string, p: string | undefined, detail?: string): It | undefined =>
      p ? { label, description: p.replace(os.homedir(), '~') + (fs.existsSync(p) ? '' : '  ' + t('(does not exist yet)')), detail, p, buttons: [inWindow, addWs] } : undefined;
    const sessionsDir = proj ? path.dirname(this.memoryDir(proj)!) : undefined;
    const items = [
      { label: t('User'), kind: vscode.QuickPickItemKind.Separator } as It,
      item('$(folder) ' + t('Claude folder'), dir, t('settings.json, CLAUDE.md, skills, commands, sessions and memory')),
      item('$(lightbulb) ' + t('User skills'), path.join(dir, 'skills')),
      item('$(terminal) ' + t('User commands'), path.join(dir, 'commands')),
      item('$(folder-library) ' + t('All projects (sessions and memory)'), path.join(dir, 'projects')),
      ...(proj
        ? [
            { label: t('Project: {0}', path.basename(proj)), kind: vscode.QuickPickItemKind.Separator } as It,
            item('$(repo) ' + t('.claude folder of the project'), path.join(proj, '.claude')),
            item('$(lightbulb) ' + t('Project skills'), path.join(proj, '.claude', 'skills')),
            item('$(book) ' + t('Project memory'), this.memoryDir(proj)),
            item('$(comment-discussion) ' + t('Project sessions (.jsonl transcripts)'), sessionsDir),
          ]
        : []),
    ].filter((x): x is It => !!x);
    const qp = vscode.window.createQuickPick<It>();
    qp.title = t('Claude files');
    qp.placeholder = t('Pick a folder to open in the file manager (buttons: new window, add to workspace)');
    qp.items = items;
    const done = new Promise<void>(resolve => {
      qp.onDidAccept(() => {
        const p = qp.selectedItems[0]?.p;
        qp.hide();
        if (p) void this.openInOS(p);
      });
      qp.onDidTriggerItemButton(e => {
        const p = e.item.p;
        if (!p) return;
        qp.hide();
        fs.mkdirSync(p, { recursive: true });
        if (e.button === inWindow) void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p), { forceNewWindow: true });
        else vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: vscode.Uri.file(p), name: `claude: ${path.basename(p)}` });
      });
      qp.onDidHide(() => {
        qp.dispose();
        resolve();
      });
    });
    qp.show();
    await done;
  }

  dispose() {
    this.watchers.forEach(w => w.dispose());
    this.disposables.forEach(d => d.dispose());
  }
}

/** Registra a view e os comandos; devolve o serviço (usado nos testes). */
export function registerClaudeConfig(ctx: vscode.ExtensionContext, ctl: Controller, deps: ClaudeConfigDeps = {}): ClaudeConfigService {
  const svc = new ClaudeConfigService(ctl, deps);
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
    if (mem) return svc.openInOS(mem);
  });
  reg('reveal', (n?: Node) => {
    const p = n ? svc.pathOf(n) : svc.claudeDir();
    if (p) return svc.openInOS(p);
  });
  reg('openFolder', () => svc.openFolder());
  reg('toggleLearning', () => svc.toggleLearning());
  reg('learn', (item?: SessionItem) => svc.learn(item));
  reg('curateMemory', (n?: GroupNode) => svc.curateMemory(n));
  reg('improveSkill', (n: SkillNode) => svc.improveSkill(n));
  reg('moveMemoryToProject', (n: MemoryNode) => svc.moveMemoryToProject(n));
  reg('mergeWorktreeMemories', (n?: GroupNode) => svc.mergeWorktreeMemories(n));
  return svc;
}
