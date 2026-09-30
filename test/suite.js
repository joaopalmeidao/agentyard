const assert = require('assert');
const vscode = require('vscode');

const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const v = await fn();
    if (v) return v;
    await wait(200);
  }
  throw new Error('timeout esperando condição');
}

exports.run = async () => {
  const results = [];
  const check = async (name, fn) => {
    try {
      console.log(`[teste] começando: ${name}`);
      await fn();
      results.push(`ok   ${name}`);
      console.log(`[teste] ok: ${name}`);
    } catch (e) {
      results.push(`FAIL ${name}: ${e.stack || e}`);
      console.log(`[teste] FAIL: ${name}`);
    }
  };

  const ext = vscode.extensions.getExtension('joaopalmeidao.worktree-graph');
  const api = await ext.activate();
  const { ctl, tree, agentTerms } = api;

  // Vídeo e print rodam sozinhos, no demo recém-criado: depois da suíte ele fica cheio de branches de teste.
  if (process.env.WTGRAPH_VIDEO || process.env.WTGRAPH_PRINT) {
    await until(() => ctl.state && ctl.state.pending === 0, 30000);
    if (process.env.WTGRAPH_PRINT) await printScene(ctl, tree);
    if (process.env.WTGRAPH_VIDEO) await videoScene(api);
    return;
  }

  await check('estado carregado com 4 worktrees', async () => {
    const s = await until(() => ctl.state);
    assert.strictEqual(s.base, 'master');
    assert.strictEqual(s.worktrees.length, 4);
    assert.strictEqual(s.graphFilter, 'unmerged', 'histórico abre em "Não mescladas" por padrão');
    assert.ok(s.agentNames.includes('Claude Code'));
  });

  await check('uma mensagem de boas-vindas por view e condição', async () => {
    // o VS Code mostra todas as entradas que casam, então duplicatas aparecem repetidas na view
    const seen = new Set();
    for (const w of ext.packageJSON.contributes.viewsWelcome) {
      const k = `${w.view}|${w.when || ''}`;
      assert.ok(!seen.has(k), `viewsWelcome duplicado: ${k}`);
      seen.add(k);
    }
  });

  await check('comandos registrados', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const c of ['openGraph', 'launchAgent', 'openFileInWorktree', 'mergeBaseInto', 'generateCiWorkflow', 'branchSummary', 'askAgentAboutBranch', 'copyBranchContext', 'showUncommitted', 'showUncommittedPatch', 'newWorktreeWithTask']) assert.ok(all.includes(`worktreeGraph.${c}`), c);
    // o painel foca views pelos comandos <view>.focus que o VS Code cria para cada view declarada
    for (const v of ['remote', 'schedules']) assert.ok(all.includes(`worktreeGraph.${v}.focus`), `${v}.focus`);
  });

  await check('árvore: worktrees + branches sem worktree', async () => {
    const root = await tree.getChildren();
    const labels = root.map(n => (typeof n.label === 'string' ? n.label : n.label.label));
    // principal primeiro, depois as mais recentes
    assert.deepStrictEqual(labels, ['master', 'ai/precos-promo', 'ai/refatorar-api', 'ai/login-oauth', 'Branches without a worktree', 'Stashes']);
    // os grupos da worktree dependem do estado detalhado (alterações, à frente), que chega em segundo plano
    await until(() => ctl.state.pending === 0, 30000);
  });

  await check('árvore: alterações × base incluem não commitados', async () => {
    const root = await tree.getChildren();
    const wt = root.find(n => n.branch === 'ai/refatorar-api');
    const kids = await tree.getChildren(wt);
    assert.deepStrictEqual(kids.slice(0, 3).map(k => k.kind), ['uncommitted', 'commits', 'changes']);
    const changes = await tree.getChildren(kids[2]);
    const names = changes.map(c => c.label).sort();
    assert.deepStrictEqual(names, ['api.ts', 'novo.ts']);
    assert.strictEqual(changes[0].command.command, 'vscode.diff');
    assert.ok(kids.some(k => k.kind === 'dir'), 'lista pastas da worktree');
  });

  await check('árvore: "Não commitadas" lista só o que não entrou em commit (HEAD ↔ disco)', async () => {
    const root = await tree.getChildren();
    const wt = root.find(n => n.branch === 'ai/refatorar-api');
    const kids = await tree.getChildren(wt);
    assert.strictEqual(kids[0].kind, 'uncommitted');
    const files = await tree.getChildren(kids[0]);
    assert.ok(files.length > 0);
    assert.strictEqual(files[0].command.command, 'vscode.diff');
    const { uncommittedFiles } = require('../out/actions');
    const direct = await uncommittedFiles(ctl.repo, wt.path);
    assert.deepStrictEqual(files.map(f => f.file).sort(), direct.map(f => f.file).sort());
  });

  await check('árvore: commits × base na worktree e na branch sem worktree; resumo copiado', async () => {
    const root = await tree.getChildren();
    const wt = root.find(n => n.branch === 'ai/login-oauth');
    const group = (await tree.getChildren(wt)).find(k => k.kind === 'commits');
    const commits = await tree.getChildren(group);
    assert.ok(commits.length >= 1, 'lista commits');
    assert.strictEqual(String(commits.length), group.description);
    assert.strictEqual(commits[0].command.command, 'worktreeGraph.showCommitSha');
    const branches = await tree.getChildren(root.find(n => n.kind === 'branches'));
    const fix = branches.find(b => b.branch === 'fix/typo-readme');
    const fixKids = await tree.getChildren(fix);
    if (fix.b.ahead) assert.strictEqual(fixKids[0].kind, 'commits');
    await vscode.commands.executeCommand('worktreeGraph.copyBranchContext', wt);
    const text = await vscode.env.clipboard.readText();
    assert.match(text, /^# ai\/login-oauth/);
    assert.ok(text.includes(commits[0].label), 'resumo traz o commit mais recente');
    assert.match(text, /## Uncommitted changes/);
  });

  await check('árvore: navegar pasta da worktree e abrir arquivo', async () => {
    const root = await tree.getChildren();
    const wt = root.find(n => n.branch === 'ai/login-oauth');
    const src = (await tree.getChildren(wt)).find(k => k.kind === 'dir' && k.dir.endsWith('src'));
    const files = await tree.getChildren(src);
    const oauth = files.find(f => f.resourceUri.fsPath.endsWith('oauth.ts'));
    assert.ok(oauth);
    await vscode.commands.executeCommand(oauth.command.command, ...oauth.command.arguments);
    assert.ok(vscode.window.activeTextEditor.document.getText().includes('oauth'));
  });

  await check('árvore: branch sem worktree navegável via git (somente leitura)', async () => {
    const root = await tree.getChildren();
    const group = root.find(n => n.kind === 'branches');
    const fix = (await tree.getChildren(group)).find(b => b.branch === 'fix/typo-readme');
    const entries = await tree.getChildren(fix);
    const readme = entries.find(e => e.entryPath === 'README.md');
    await vscode.commands.executeCommand(readme.command.command, ...readme.command.arguments);
    const doc = vscode.window.activeTextEditor.document;
    assert.strictEqual(doc.uri.scheme, 'wtgraph-git');
    assert.ok(doc.getText().includes('loja online'));
  });

  await check('agente: abre terminal na worktree e reaproveita', async () => {
    await vscode.workspace.getConfiguration('worktreeGraph').update('agents', [{ name: 'Eco', command: 'echo agente-ok' }], vscode.ConfigurationTarget.Global);
    const wt = ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth');
    const before = vscode.window.terminals.length;
    await vscode.commands.executeCommand('worktreeGraph.launchAgent', { path: wt.path, branch: wt.branch });
    await until(() => vscode.window.terminals.length === before + 1);
    const t = vscode.window.terminals.find(x => x.name === 'Eco · ai/login-oauth');
    assert.ok(t, 'terminal com nome do agente');
    assert.strictEqual(t.creationOptions.cwd, wt.path);
    // já aberto: o padrão pergunta; com "reuse" só traz para frente
    await vscode.workspace.getConfiguration('worktreeGraph').update('agentWhenOpen', 'reuse', vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('worktreeGraph.launchAgent', { path: wt.path, branch: wt.branch });
    assert.strictEqual(vscode.window.terminals.length, before + 1, 'não duplica');
    await ctl.refresh();
    assert.deepStrictEqual(ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth').agents, ['Eco']);
  });

  await check('agente: abre outro terminal na mesma worktree mesmo com um rodando', async () => {
    const wt = ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth');
    const before = vscode.window.terminals.length;
    await vscode.commands.executeCommand('worktreeGraph.launchAgentNew', { path: wt.path, branch: wt.branch }, 'Eco');
    await until(() => vscode.window.terminals.length === before + 1);
    assert.ok(vscode.window.terminals.find(x => x.name === 'Eco · ai/login-oauth #2'), 'segundo terminal numerado');
    await ctl.refresh();
    assert.deepStrictEqual(ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth').agents, ['Eco', 'Eco']);
    assert.strictEqual(agentTerms.list(wt.path, 'Eco').length, 2);
    await vscode.workspace.getConfiguration('worktreeGraph').update('agentWhenOpen', undefined, vscode.ConfigurationTarget.Global);
  });

  await check('claude: estado pelos hooks, sessão do terminal e chip do card', async () => {
    const fs = require('fs');
    const path = require('path');
    const cfg = vscode.workspace.getConfiguration('worktreeGraph');
    await cfg.update('claude.notify', 'off', vscode.ConfigurationTarget.Global);
    const wt = ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth');
    // "claude --version" sai logo (ou nem existe na máquina); os eventos são escritos aqui como o hook faria
    const o = await agentTerms.start(wt.path, wt.branch, 'Claude Code', 'claude --version');
    assert.ok(o.claude);
    assert.strictEqual(o.state, 'starting');
    assert.strictEqual(o.terminal.creationOptions.env.WTGRAPH_AGENT_ID, o.id);
    const settings = JSON.parse(fs.readFileSync(path.join(agentTerms.eventsDir(), 'hooks.bridge.settings.json'), 'utf8'));
    assert.ok(settings.hooks.Stop && settings.hooks.Notification, 'settings com os hooks');
    assert.ok(settings.hooks.PreToolUse.some(g => g.hooks[0].command.includes('--launched')), 'hooks da ponte');
    assert.strictEqual(o.terminal.creationOptions.env.WTGRAPH_BRIDGE, '1');
    assert.ok(o.bridged);
    const file = path.join(agentTerms.eventsDir(), `${o.id}.jsonl`);
    const emit = e => fs.appendFileSync(file, JSON.stringify({ session_id: 'sessao-teste', ...e }) + '\n');
    emit({ hook_event_name: 'SessionStart' });
    await until(() => o.state === 'idle');
    assert.strictEqual(agentTerms.findBySession('sessao-teste'), o, 'terminal ligado à sessão');
    emit({ hook_event_name: 'UserPromptSubmit' });
    emit({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    await until(() => o.state === 'waiting');
    await until(() => ctl.state.worktrees.find(w => w.path === wt.path).agentStates?.waiting === 1);
    assert.strictEqual(ctl.state.worktrees.find(w => w.path === wt.path).agentStates.message, 'Claude needs your permission to use Bash');
    emit({ hook_event_name: 'PostToolUse' });
    await until(() => o.state === 'working');
    emit({ hook_event_name: 'Stop' });
    await until(() => o.state === 'idle');
    o.terminal.dispose();
    await until(() => !fs.existsSync(file));
    await cfg.update('claude.notify', undefined, vscode.ConfigurationTarget.Global);
  });

  await check('claude: permissão respondida, fim da sessão retomado e fechado', async () => {
    const fs = require('fs');
    const path = require('path');
    const cfg = vscode.workspace.getConfiguration('worktreeGraph');
    const G = vscode.ConfigurationTarget.Global;
    await cfg.update('claude.notify', 'off', G);
    await cfg.update('claude.onSessionEnd', 'keep', G);
    // retomar usa o comando configurado: "claude --version" sai logo, sem abrir um Claude de verdade
    const agentsBefore = cfg.inspect('agents').globalValue;
    await cfg.update('agents', [{ name: 'Claude Code', command: 'claude --version' }], G);
    const wt = ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth');
    const o = await agentTerms.start(wt.path, wt.branch, 'Claude Code', 'claude --version');
    const file = path.join(agentTerms.eventsDir(), `${o.id}.jsonl`);
    const emit = e => fs.appendFileSync(file, JSON.stringify({ session_id: 'sessao-fim', ...e }) + '\n');
    emit({ hook_event_name: 'SessionStart' });
    await until(() => o.state === 'idle');
    assert.strictEqual(agentTerms.answerPermission(o, true), false, 'sem pedido em aberto não responde');
    emit({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    await until(() => o.state === 'waiting');
    assert.strictEqual(o.notificationType, 'permission_prompt');
    assert.strictEqual(agentTerms.answerPermission(o, false), true);
    emit({ hook_event_name: 'PostToolUse' });
    await until(() => o.state === 'working');
    assert.strictEqual(o.notificationType, undefined);
    emit({ hook_event_name: 'SessionEnd' });
    await until(() => o.state === 'ended');
    assert.ok(o.terminal.exitStatus === undefined, 'keep: o terminal fica');
    agentTerms.resumeInPlace(o);
    assert.strictEqual(o.state, 'starting', 'retomado no mesmo terminal');
    await cfg.update('claude.onSessionEnd', 'close', G);
    emit({ hook_event_name: 'SessionEnd' });
    await until(() => !agentTerms.list().includes(o));
    await cfg.update('claude.onSessionEnd', undefined, G);
    await cfg.update('claude.notify', undefined, G);
    await cfg.update('agents', agentsBefore, G);
  });

  await check('terminal de agente: ao lado, dividido, mover e grade', async () => {
    const cfg = vscode.workspace.getConfiguration('worktreeGraph');
    const G = vscode.ConfigurationTarget.Global;
    const wt = ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth');
    await cfg.update('agentTerminalLocation', 'editorBeside', G);
    const a = await agentTerms.start(wt.path, wt.branch, 'Eco', 'echo ao-lado', { name: 'Eco · lado' });
    await until(() => agentTerms.inEditor(a.terminal));
    await agentTerms.moveTo(a, 'panel');
    await until(() => !agentTerms.inEditor(a.terminal));
    await cfg.update('agentTerminalLocation', 'split', G);
    const b = await agentTerms.start(wt.path, wt.branch, 'Eco', 'echo dividido', { name: 'Eco · dividido' });
    assert.strictEqual(b.terminal.creationOptions.location.parentTerminal, a.terminal, 'dividido com o da mesma worktree');
    await vscode.commands.executeCommand('worktreeGraph.agents.grid', { path: wt.path });
    await until(() => agentTerms.inEditor(a.terminal) && agentTerms.inEditor(b.terminal));
    const groupOf = term => vscode.window.tabGroups.all.findIndex(g => g.tabs.some(t => t.input instanceof vscode.TabInputTerminal && t.label === term.name));
    assert.notStrictEqual(groupOf(a.terminal), groupOf(b.terminal), 'uma coluna para cada');
    a.terminal.dispose();
    b.terminal.dispose();
    await until(() => !agentTerms.list(wt.path).some(o => o === a || o === b));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('workbench.action.editorLayoutSingle');
    await cfg.update('agentTerminalLocation', undefined, G);
  });

  await check('estado detalhado (status e comparação) chega em segundo plano', async () => {
    await until(() => ctl.state && ctl.state.pending === 0, 30000);
    const wt = ctl.state.worktrees.find(w => w.branch === 'ai/refatorar-api');
    assert.strictEqual(wt.changes, 2);
    assert.strictEqual(ctl.state.worktrees.find(w => w.branch === 'ai/precos-promo').preview.conflict, true);
  });

  await check('cores do git na árvore: arquivo modificado em outra worktree', async () => {
    const wt = ctl.state.worktrees.find(w => w.branch === 'ai/refatorar-api');
    const d = api.decorations.provideFileDecoration(vscode.Uri.file(require('path').join(wt.path, 'src', 'api.ts')));
    assert.strictEqual(d && d.badge, 'M');
    const u = api.decorations.provideFileDecoration(vscode.Uri.file(require('path').join(wt.path, 'src', 'novo.ts')));
    assert.strictEqual(u && u.badge, 'U');
  });

  await check('analisar merge abre o painel', async () => {
    await vscode.commands.executeCommand('worktreeGraph.analyzeMerge', 'ai/precos-promo', 'master');
    await until(() => vscode.window.tabGroups.activeTabGroup.activeTab?.label === 'Merge: ai/precos-promo → master');
  });

  await check('filtro "não mescladas" mostra só commits pendentes e o ponto de saída', async () => {
    await ctl.ctx.workspaceState.update('graphFilter', 'unmerged');
    await ctl.refresh();
    assert.deepStrictEqual([...ctl.state.unmerged].sort(), ['ai/login-oauth', 'ai/precos-promo', 'ai/refatorar-api']);
    assert.ok(ctl.state.commits.some(c => c.boundary), 'tem commit de fronteira');
    assert.ok(ctl.state.commits.length < 8);
    await ctl.ctx.workspaceState.update('graphFilter', 'all');
    await ctl.refresh();
  });

  await check('fluxo de ambientes: promoção pendente e base = 1º estágio', async () => {
    await vscode.workspace.getConfiguration('worktreeGraph').update('flow', ['release/1.0', 'master'], vscode.ConfigurationTarget.Global);
    await ctl.refresh();
    assert.strictEqual(ctl.state.base, 'release/1.0');
    assert.strictEqual(ctl.state.flow[0].hotfix, 4, 'master tem 4 commits que release/1.0 não tem');
    await vscode.workspace.getConfiguration('worktreeGraph').update('flow', [], vscode.ConfigurationTarget.Global);
    await ctl.refresh();
    assert.strictEqual(ctl.state.base, 'master');
  });

  await check('prompt vira UM argumento em pwsh, bash e cmd', async () => {
    const { promptArgument, promptCommandOf } = require('../out/agents');
    const fs = require('fs');
    const ps = promptArgument('a\nb "c"', 'C:/Program Files/PowerShell/7/pwsh.exe');
    assert.ok(ps.arg.startsWith("(Get-Content -Raw -LiteralPath '") && fs.readFileSync(ps.file, 'utf8') === 'a\nb "c"');
    assert.ok(promptArgument('x', '/bin/bash').arg.startsWith('"$(cat \''));
    assert.strictEqual(promptArgument('a\nb "c"', 'C:/Windows/System32/cmd.exe').arg, `"a b 'c'"`);
    // longo demais para a linha de comando: vai só o caminho do arquivo com a tarefa inteira
    const long = 'x'.repeat(30000);
    for (const sh of ['C:/Program Files/PowerShell/7/pwsh.exe', '/bin/bash', 'C:/Windows/System32/cmd.exe']) {
      const p = promptArgument(long, sh);
      assert.ok(p.arg.length < 1000 && p.arg.includes(p.file) && fs.readFileSync(p.file, 'utf8') === long, sh);
    }
    assert.ok(promptArgument('y'.repeat(7000), 'C:/Windows/System32/cmd.exe').arg.length < 1000, 'cmd tem limite menor');
    const { attachmentText } = require('../out/taskInput');
    const pathMod = require('path');
    const cwd = pathMod.resolve('/repo/wt');
    assert.strictEqual(
      attachmentText([pathMod.join(cwd, 'src', 'a.ts'), pathMod.join(cwd, 'docs'), pathMod.join(cwd, 'src', 'a.ts'), pathMod.join(cwd, 'my notes.md')], cwd),
      '@src/a.ts @docs @"my notes.md"',
    );
    assert.ok(attachmentText([pathMod.resolve('/outro/b.ts')], cwd).startsWith('@') && attachmentText([pathMod.resolve('/outro/b.ts')], cwd).endsWith('/outro/b.ts'));
    assert.strictEqual(promptCommandOf({ name: 'G', command: 'gemini' }), 'gemini -i {prompt}');
    assert.strictEqual(promptCommandOf({ name: 'X', command: 'aider' }), 'aider {prompt}');
  });

  await check('conflito: "Resolver com agente" abre terminal na worktree com a tarefa', async () => {
    const fs = require('fs');
    await vscode.workspace.getConfiguration('worktreeGraph').update('agents', [{ name: 'Eco', command: 'echo', promptCommand: 'echo {prompt}' }], vscode.ConfigurationTarget.Global);
    const wt = ctl.state.worktrees.find(w => w.branch === 'ai/precos-promo');
    const before = vscode.window.terminals.length;
    await vscode.commands.executeCommand('worktreeGraph.resolveConflict', 'ai/precos-promo');
    await until(() => vscode.window.terminals.length === before + 1);
    const t = vscode.window.terminals.find(x => x.name === 'Eco · ai/precos-promo · task');
    assert.ok(t, 'terminal da tarefa');
    assert.strictEqual(t.creationOptions.cwd, wt.path);
    const text = fs.readFileSync(api.agentTerms.lastPromptFile, 'utf8');
    assert.ok(text.includes('src/precos.ts'), text);
    assert.ok(text.includes('git merge master'), text);
  });

  await check('contrato worktreeGraph.launchAgentWithPrompt (por branch, prompt multilinha)', async () => {
    const fs = require('fs');
    const before = vscode.window.terminals.length;
    await vscode.commands.executeCommand('worktreeGraph.launchAgentWithPrompt', { branch: 'ai/login-oauth', prompt: 'linha 1\nlinha 2' });
    await until(() => vscode.window.terminals.length === before + 1);
    assert.ok(vscode.window.terminals.some(x => x.name === 'Eco · ai/login-oauth · task'));
    assert.strictEqual(fs.readFileSync(api.agentTerms.lastPromptFile, 'utf8'), 'linha 1\nlinha 2');
  });

  await check('nova worktree com tarefa: cria a partir da branch escolhida e entrega o prompt', async () => {
    const fs = require('fs');
    await vscode.commands.executeCommand('worktreeGraph.newWorktreeWithTask', { startPoint: 'ai/login-oauth', prompt: 'tarefa nova', name: 'ai/tarefa-teste' });
    const wt = (await ctl.repo.worktreesFast()).find(w => w.branch === 'ai/tarefa-teste');
    assert.ok(wt, 'worktree criada');
    const oauth = (await ctl.repo.exec(['rev-parse', 'ai/login-oauth'])).trim();
    assert.strictEqual((await ctl.repo.exec(['rev-parse', 'HEAD'], wt.path)).trim(), oauth);
    await until(() => fs.readFileSync(api.agentTerms.lastPromptFile, 'utf8') === 'tarefa nova');
    await ctl.repo.removeWorktree(wt.path, true);
    await ctl.repo.exec(['branch', '-D', 'ai/tarefa-teste']);
    ctl.scheduleRefresh(10);
  });

  await check('issues: a view abre sem rede nem credenciais', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.worktreeGraph');
    await vscode.commands.executeCommand('worktreeGraph.remote.focus');
    await api.issues.refresh(true);
    assert.deepStrictEqual(api.issues.groups, [], 'demo sem remoto e sem Redmine: nenhum grupo');
  });

  await check('issues: Jira configurado sem credencial aparece com "Conectar ao Jira"', async () => {
    const cfg = vscode.workspace.getConfiguration('worktreeGraph');
    await cfg.update('jira.url', 'https://jira.exemplo.invalid', vscode.ConfigurationTarget.Global);
    await api.issues.refresh(true);
    const g = api.issues.groups.find(x => x.provider === 'jira');
    assert.ok(g && g.needsConnect, JSON.stringify(api.issues.groups));
    await cfg.update('jira.url', undefined, vscode.ConfigurationTarget.Global);
    await api.issues.refresh(true);
    assert.ok(!api.issues.groups.some(x => x.provider === 'jira'));
  });

  await check('issues: começar cria a worktree da issue e entrega o prompt', async () => {
    const issue = { provider: 'github', id: 99, key: '#99', title: 'Teste de issue', body: 'corpo da issue', url: 'https://example.com/99', labels: [], updated: 0 };
    await api.issues.start(issue, true);
    await ctl.refresh();
    const wt = ctl.state.worktrees.find(w => w.branch === 'issue/99-teste-de-issue');
    assert.ok(wt, 'worktree criada');
    // com launchAgentWithPrompt disponível, o prompt vai para o agente (arquivo da tarefa)
    await until(() => api.agentTerms.lastPromptFile && require('fs').readFileSync(api.agentTerms.lastPromptFile, 'utf8').includes('Work on issue #99: Teste de issue'));
    assert.deepStrictEqual(api.issues.trailers('issue/99-teste-de-issue'), ['Closes #99']);
    // de novo: reaproveita a worktree, não cria outra
    await api.issues.start(issue, false);
    await ctl.refresh();
    assert.strictEqual(ctl.state.worktrees.filter(w => w.branch === 'issue/99-teste-de-issue').length, 1);
  });

  await check('sessões do Claude: mapeadas para a worktree, chip no estado, view e transcrição', async () => {
    await until(() => api.claude.loaded, 20000);
    await ctl.refresh();
    const wt = ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth');
    assert.deepStrictEqual({ s: wt.claude.sessions, t: wt.claude.tokens }, { s: 1, t: 3500 });
    const m = api.claude.byWorktree();
    assert.strictEqual(m.get(wt.path)[0].firstPrompt, 'Implemente o login OAuth');
    await vscode.commands.executeCommand('worktreeGraph.claudeSessions.focus');
    const { ClaudeSessionsProvider, SessionItem } = require('../out/claude/view');
    const prov = new ClaudeSessionsProvider(api.claude, ctl);
    const groups = prov.getChildren();
    assert.strictEqual(groups[0].label, 'ai/login-oauth');
    const item = prov.getChildren(groups[0])[0];
    await vscode.commands.executeCommand('worktreeGraph.claude.transcript', item);
    const doc = await until(() => vscode.workspace.textDocuments.find(d => d.uri.scheme === 'wtgraph-claude'));
    assert.ok(doc.getText().includes('Feito: cliente OAuth criado.'));
  });

  await check('Claude: configuração lista skill, comando, settings e memória sintéticos; nova memória entra no índice', async () => {
    const svc = api.claudeConfig;
    await vscode.commands.executeCommand('worktreeGraph.claudeConfig.focus');
    const root = svc.getChildren();
    const scopes = root;
    assert.deepStrictEqual(scopes.map(n => n.scope), ['user', 'project']);
    assert.strictEqual(svc.pathOf(scopes[0]), svc.claudeDir());
    const userGroups = svc.getChildren(scopes[0]);
    const skills = svc.getChildren(userGroups.find(g => g.group === 'skills'));
    assert.ok(skills.some(n => n.entry && n.entry.name === 'revisar-pr'), 'skill sintética');
    const cmds = svc.getChildren(userGroups.find(g => g.group === 'commands'));
    assert.ok(cmds.some(n => n.entry && n.entry.name === 'ola'), 'comando sintético');
    const cfgs = svc.getChildren(userGroups.find(g => g.group === 'config'));
    assert.ok(String(cfgs.find(n => n.cfg && n.cfg.kind === 'settings').description).includes('1 allow'));
    const memGroup = svc.getChildren(scopes[1]).find(g => g.group === 'memory');
    assert.ok(memGroup, 'grupo de memória do projeto');
    const mems = svc.getChildren(memGroup);
    assert.ok(mems.some(n => n.entry && n.entry.name === 'preferencia-teste'), 'memória sintética');
    const { createMemory, checkIndex } = require('../out/claude/config');
    createMemory(memGroup.memDir, { type: 'project', title: 'Nova via API', description: 'teste', body: 'x' });
    assert.ok(require('fs').readFileSync(require('path').join(memGroup.memDir, 'MEMORY.md'), 'utf8').includes('(nova-via-api.md)'));
    assert.deepStrictEqual(checkIndex(memGroup.memDir), { missingInIndex: [], dangling: [] });
    assert.ok(svc.getChildren(memGroup).some(n => n.entry && n.entry.name === 'nova-via-api'));
  });

  await check('pipelines: a view abre sem rede e o último pipeline de cada branch chega ao estado', async () => {
    await vscode.commands.executeCommand('worktreeGraph.remote.focus');
    await api.pipelines.refresh(true);
    assert.strictEqual(api.pipelines.unavailable, 'noRemote', 'demo sem remoto');
    const { PipelineTreeProvider } = require('../out/hosting/pipelinesView');
    const kids = await new PipelineTreeProvider(api.pipelines).getChildren();
    assert.strictEqual(kids.length, 1);
    assert.ok(String(kids[0].label).includes('Remote'), String(kids[0].label));
    // dados injetados: o gancho do estado escolhe o mais recente por branch
    const now = Math.floor(Date.now() / 1000);
    api.pipelines.pipelines = [
      { id: 2, provider: 'github', name: 'CI', branch: 'ai/login-oauth', sha: 'b', status: 'failed', event: 'push', url: 'https://x/2', createdAt: now, updatedAt: now },
      { id: 1, provider: 'github', name: 'CI', branch: 'ai/login-oauth', sha: 'a', status: 'success', event: 'push', url: 'https://x/1', createdAt: now - 100, updatedAt: now - 90 },
    ];
    await ctl.refresh();
    assert.deepStrictEqual(ctl.state.pipelines['ai/login-oauth'], { id: 2, status: 'failed', name: 'CI', url: 'https://x/2', updatedAt: now });
    api.pipelines.scope = 'worktrees';
    assert.strictEqual(api.pipelines.visible().length, 2, 'branch com worktree entra no filtro');
    api.pipelines.pipelines = [];
    await ctl.refresh();
  });

  await check('uso do Claude: statusline grava os limites reais e a tela abre', async () => {
    const ev = api.agentTerms.eventsDir();
    require('fs').mkdirSync(ev, { recursive: true });
    const soon = Math.floor(Date.now() / 1000) + 3600;
    const status = {
      session_id: 'sess-uso',
      model: { display_name: 'Opus 5.5' },
      cost: { total_cost_usd: 0.5 },
      context_window: { used_percentage: 12 },
      rate_limits: { five_hour: { used_percentage: 95, resets_at: soon }, seven_day: { used_percentage: 40, resets_at: soon + 86400 } },
    };
    const file = require('path').join(ev, 'teste-uso.status.json');
    require('fs').writeFileSync(file, JSON.stringify(status));
    api.usage.poll();
    assert.strictEqual(api.usage.limits().fiveHour.pct, 95);
    assert.strictEqual(api.agentTerms.statusLineOptions().mode, 'keep');
    await vscode.commands.executeCommand('worktreeGraph.claude.usage');
    await until(() => vscode.window.tabGroups.activeTabGroup.activeTab?.label === 'Claude usage');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    require('fs').rmSync(file, { force: true });
  });

  await check('atividade: painel abre e soma commits e tokens por branch; custo por tarefa com preço', async () => {
    await until(() => api.claude.loaded, 20000);
    await vscode.commands.executeCommand('worktreeGraph.activity');
    await until(() => vscode.window.tabGroups.activeTabGroup.activeTab?.label === 'Activity');
    const week = await api.activity.compute('week');
    const row = week.report.rows.find(r => r.branch === 'ai/login-oauth');
    assert.ok(row, 'linha da worktree com sessão sintética');
    assert.strictEqual(row.tokens, 3500);
    assert.ok(week.report.totals.commits >= 3, 'commits da demo nos últimos 7 dias');
    const cost = week.costs.find(c => c.branch === 'ai/login-oauth');
    assert.strictEqual(cost.tokens, 3500);
    assert.strictEqual(cost.usd, undefined, 'sem preço, sem custo');

    const cfg = vscode.workspace.getConfiguration('worktreeGraph');
    await cfg.update('claude.pricePerMTokInput', 3, vscode.ConfigurationTarget.Global);
    await cfg.update('claude.pricePerMTokOutput', 15, vscode.ConfigurationTarget.Global);
    await ctl.refresh();
    const wt = ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth');
    assert.strictEqual(wt.claude.usd.toFixed(4), ((1500 * 3 + 2000 * 15) / 1e6).toFixed(4), 'chip do card com custo estimado');
    await cfg.update('claude.pricePerMTokInput', undefined, vscode.ConfigurationTarget.Global);
    await cfg.update('claude.pricePerMTokOutput', undefined, vscode.ConfigurationTarget.Global);
  });

  await check('revisão: agente recebe a tarefa; review.json vira painel com os comentários; pasta fora do git', async () => {
    const fs = require('fs');
    const path = require('path');
    const { execSync } = require('child_process');
    const wt = ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth');
    await api.review.start('ai/login-oauth');
    const prompt = fs.readFileSync(api.agentTerms.lastPromptFile, 'utf8');
    assert.ok(prompt.includes('.worktree-graph/review.json') && prompt.includes('src/oauth.ts'), prompt);
    fs.writeFileSync(
      path.join(wt.path, '.worktree-graph', 'review.json'),
      JSON.stringify({ summary: 'Revisão sintética', comments: [{ path: 'src/auth.ts', line: 2, severity: 'bug', body: 'verify sem tratar erro' }, { path: 'src/oauth.ts', body: 'nit', severity: 'nit' }] }),
    );
    await until(() => api.review.panel?.current?.review.comments.length === 2, 15000);
    assert.strictEqual(api.review.panel.current.review.summary, 'Revisão sintética');
    assert.ok(!execSync('git status --porcelain', { cwd: wt.path }).toString().includes('.worktree-graph'), 'fora do git');
    const exclude = fs.readFileSync(path.join(ctl.repo.commonDir, 'info', 'exclude'), 'utf8');
    assert.ok(exclude.includes('.worktree-graph/'));
  });

  await check('painel do grafo abre', async () => {
    await vscode.commands.executeCommand('worktreeGraph.openGraph');
    await wait(1500);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab.label.startsWith('AgentYard'), tab.label);
  });

  await check('vários projetos: adicionar, trocar e voltar sem abrir outra janela', async () => {
    const path = require('path');
    const first = ctl.repo.root;
    // outros testes podem ter criado worktrees na demo (ex.: a da issue); compara com o que havia
    const before = ctl.state.worktrees.length;
    const second = path.join(first, '..', '..', 'itest2', 'loja-app');
    const main = await api.projects.addPath(second);
    assert.ok(main, 'segundo repositório reconhecido');
    const names = api.projects.list().map(p => p.path.toLowerCase());
    assert.ok(names.includes(path.normalize(second).toLowerCase()), 'aparece na lista');
    assert.strictEqual(api.projects.list().find(p => p.active).path.toLowerCase(), path.normalize(first).toLowerCase());

    await vscode.commands.executeCommand('worktreeGraph.switchProject', second);
    await until(() => ctl.state && ctl.state.root.toLowerCase() === path.normalize(second).toLowerCase());
    assert.strictEqual(ctl.state.worktrees.length, 5, 'o segundo projeto tem uma worktree a mais');
    assert.ok(ctl.state.worktrees.some(w => w.branch === 'ai/extra'));
    const root = await tree.getChildren();
    assert.ok(root.some(n => n.branch === 'ai/extra'), 'a árvore mostra o projeto novo');

    await vscode.commands.executeCommand('worktreeGraph.switchProject', first);
    await until(() => ctl.state && ctl.state.root.toLowerCase() === path.normalize(first).toLowerCase());
    assert.strictEqual(ctl.state.worktrees.length, before);
    await api.projects.remove(second);
    assert.ok(!api.projects.list().some(p => p.path.toLowerCase() === path.normalize(second).toLowerCase()));
  });

  await check('push: publica branch nova (push -u) e envia commit novo', async () => {
    const path = require('path');
    const { execSync } = require('child_process');
    const root = ctl.repo.root;
    const bare = path.join(root, '..', 'origin-push.git');
    execSync(`git init -q --bare "${bare}"`);
    execSync(`git remote add origin "${bare}"`, { cwd: root });
    await ctl.refresh();
    let wt = ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth');
    assert.strictEqual(wt.remote.published, false, 'antes: não publicada');

    await vscode.commands.executeCommand('worktreeGraph.pushBranch', { branch: 'ai/login-oauth' });
    await ctl.refresh();
    wt = ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth');
    assert.strictEqual(wt.remote.published, true, 'publicada');
    assert.strictEqual(wt.upstream, 'origin/ai/login-oauth');
    execSync('git rev-parse --verify refs/heads/ai/login-oauth', { cwd: bare });

    execSync('git -c user.name=t -c user.email=t@t commit -q --allow-empty -m "mais um"', { cwd: wt.path });
    await ctl.refresh();
    assert.strictEqual(ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth').remote.ahead, 1, '1 commit a enviar');
    await vscode.commands.executeCommand('worktreeGraph.pushBranch', { branch: 'ai/login-oauth' });
    await ctl.refresh();
    assert.strictEqual(ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth').remote.ahead, 0, 'enviado');
  });

  await check('push das selecionadas: base e branches de CI vêm marcadas', async () => {
    const { defaultPushBranches } = require('../out/push');
    assert.deepStrictEqual(defaultPushBranches(ctl), [ctl.state.base], 'sem CI: só a base');
    const cfg = vscode.workspace.getConfiguration('worktreeGraph');
    await cfg.update('ciBranches', ['ai/login-*', 'nao-existe'], vscode.ConfigurationTarget.Global);
    try {
      assert.deepStrictEqual(defaultPushBranches(ctl), [ctl.state.base, 'ai/login-oauth'], 'base + CI existentes');
    } finally {
      await cfg.update('ciBranches', undefined, vscode.ConfigurationTarget.Global);
    }
    const cmds = await vscode.commands.getCommands(true);
    for (const c of ['worktreeGraph.pushSelected', 'worktreeGraph.launchAgentHere']) assert.ok(cmds.includes(c), `${c} registrado (botões da barra de status)`);
  });

  await check('commits: URL no GitHub/GitLab e branch criada num commit', async () => {
    const { commitUrl } = require('../out/commits');
    assert.strictEqual(commitUrl({ kind: 'github', webBase: 'https://github.com', projectPath: 'a/b' }, 'abc'), 'https://github.com/a/b/commit/abc');
    assert.strictEqual(commitUrl({ kind: 'gitlab', webBase: 'https://git.x:8443', projectPath: 'g/s/p' }, 'abc'), 'https://git.x:8443/g/s/p/-/commit/abc');
  });

  await check('proteções: checagem bloqueia e libera merge, cache, branch protegida e lembrete de limpeza', async () => {
    const path = require('path');
    const { execSync } = require('child_process');
    const cfg = vscode.workspace.getConfiguration('worktreeGraph');
    const G = vscode.ConfigurationTarget.Global;
    const guards = api.guards;
    const originalUi = guards.ui;
    const seen = [];
    let answers = [];
    let typed;
    guards.ui = {
      warn: async (m, o, ...items) => (seen.push(m), answers.shift()),
      input: async () => typed,
    };
    const root = ctl.repo.root;
    const git = (c, cwd = root) => execSync(`git -c user.name=t -c user.email=t@t ${c}`, { cwd }).toString().trim();
    try {
      // lista automática: base protegida
      await ctl.refresh();
      assert.ok(ctl.state.protectedBranches.includes('master'), 'master protegida por padrão');

      // branches descartáveis: guard/teste (com worktree e um commit) → guard/alvo
      const wtTeste = path.join(root, '..', 'guard-teste');
      git('branch guard/alvo master');
      git(`worktree add -q -b guard/teste "${wtTeste}" master`);
      git('commit -q --allow-empty -m "trabalho do agente"', wtTeste);
      const alvoAntes = git('rev-parse guard/alvo');

      await cfg.update('protection.mode', 'off', G);
      await cfg.update('checks.mode', 'block', G);
      await cfg.update('checks.beforeMerge', ['node -e "process.exit(3)"'], G);
      answers = [undefined]; // fecha o aviso de falha sem escolher nada
      let ok = await api.actions.mergeBranches(ctl, 'guard/teste', 'guard/alvo', { confirm: false, quiet: true });
      assert.strictEqual(ok, false, 'checagem falhando bloqueia');
      assert.strictEqual(guards.lastCheck.ok, false);
      assert.ok(guards.lastCheck.failed.includes('process.exit(3)'));
      assert.strictEqual(git('rev-parse guard/alvo'), alvoAntes, 'destino intacto');

      await cfg.update('checks.beforeMerge', ['node -e "process.exit(0)"'], G);
      ok = await api.actions.mergeBranches(ctl, 'guard/teste', 'guard/alvo', { confirm: false, quiet: true });
      assert.strictEqual(ok, true, 'checagem passando libera');
      assert.notStrictEqual(git('rev-parse guard/alvo'), alvoAntes, 'merge feito');
      assert.strictEqual(await guards.runChecks('merge', 'guard/teste'), true);
      assert.strictEqual(guards.lastCheck.cached, true, 'mesmo commit, worktree limpa: não roda de novo');
      await cfg.update('checks.beforeMerge', undefined, G);

      // merge direto na master protegida
      const masterAntes = git('rev-parse master');
      await cfg.update('protection.mode', 'require-pr', G);
      answers = [undefined];
      ok = await api.actions.mergeBranches(ctl, 'guard/teste', 'master', { confirm: false, quiet: true });
      assert.strictEqual(ok, false, 'require-pr bloqueia');
      assert.ok(seen.some(m => m.includes('master is protected')), seen.join(' | '));
      await cfg.update('protection.mode', 'confirm', G);
      typed = 'errado';
      ok = await api.actions.mergeBranches(ctl, 'guard/teste', 'master', { confirm: false, quiet: true });
      assert.strictEqual(ok, false, 'confirm sem digitar o nome certo bloqueia');
      assert.strictEqual(git('rev-parse master'), masterAntes, 'master intacta');

      // lembrete: uma worktree mesclada e limpa, limite 1, sem espera de dias
      git(`worktree add -q -b guard/parada "${path.join(root, '..', 'guard-parada')}" master`);
      await cfg.update('cleanup.remindThreshold', 1, G);
      await cfg.update('cleanup.staleDays', 0, G);
      await ctl.refresh();
      await until(() => ctl.state.pending === 0, 30000);
      await ctl.ctx.globalState.update(`cleanupRemind:${ctl.repo.commonDir.toLowerCase()}`, undefined);
      guards.lastReminder = undefined;
      guards.maybeRemind();
      assert.ok(guards.lastReminder && guards.lastReminder.stale >= 1, JSON.stringify(guards.lastReminder));
      assert.ok(seen.some(m => /leftover worktrees/.test(m)));
      const again = guards.lastReminder.at;
      guards.maybeRemind();
      assert.strictEqual(guards.lastReminder.at, again, 'no máximo um aviso por dia');
    } finally {
      guards.ui = originalUi;
      for (const k of ['protection.mode', 'checks.mode', 'checks.beforeMerge', 'cleanup.remindThreshold', 'cleanup.staleDays']) await cfg.update(k, undefined, G);
    }
  });

  await check('agentes: "pronto para revisar" quando o agente deixa commits e a worktree fica limpa', async () => {
    const { execSync } = require('child_process');
    await vscode.workspace.getConfiguration('worktreeGraph').update('agents', [{ name: 'Eco', command: 'echo', promptCommand: 'echo {prompt}' }], vscode.ConfigurationTarget.Global);
    const wt = ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth');
    const watch = api.agentFlow.watch;
    await vscode.commands.executeCommand('worktreeGraph.launchAgentWithPrompt', { branch: 'ai/login-oauth', prompt: 'tarefa de teste' });
    await until(() => watch.isWatching(wt.path));
    assert.strictEqual(await watch.checkNow(wt.path), false, 'sem commits novos ainda não está pronto');
    execSync('git -c user.name=t -c user.email=t@t commit -q --allow-empty -m "agente: feito"', { cwd: wt.path });
    assert.strictEqual(await watch.checkNow(wt.path), true, 'commit novo + limpa = pronto');
    await ctl.refresh();
    const v = ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth');
    assert.ok(v.review && v.review.commits === 1, JSON.stringify(v.review));
    await vscode.commands.executeCommand('worktreeGraph.agents.dismissReady', { path: wt.path });
    await ctl.refresh();
    assert.ok(!ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth').review);
  });

  await check('tentativas: cria worktrees try/* com agente em cada e abre o painel de comparação', async () => {
    const g = await api.agentFlow.attempts.tryApproaches({ prompt: 'Implementar cache de preços', n: 2, quiet: true });
    assert.deepStrictEqual(g.attempts.map(a => a.branch), ['try/implementar-cache-de-precos-a', 'try/implementar-cache-de-precos-b']);
    await until(() => vscode.window.tabGroups.activeTabGroup.activeTab?.label === 'Attempts: Implementar cache de preços');
    await ctl.refresh();
    assert.ok(ctl.state.worktrees.some(w => w.branch === 'try/implementar-cache-de-precos-b'));
    assert.ok(vscode.window.terminals.some(t => t.name === 'Eco · try/implementar-cache-de-precos-a · task'));
    assert.strictEqual(api.agentFlow.attempts.groups()[0].attempts[1].variation.length > 0, true, 'B recebe uma variação');
  });

  await check('pull: fetch mostra ↓1 e o pull faz fast-forward', async () => {
    const path = require('path');
    const { execSync } = require('child_process');
    const root = ctl.repo.root;
    const bare = path.join(root, '..', 'origin-push.git');
    const clone = path.join(root, '..', 'clone-pull');
    // outros testes podem ter feito commits em ai/login-oauth: o remoto parte do estado atual dela
    execSync(`git push -q -f "${bare}" ai/login-oauth`, { cwd: root });
    execSync('git fetch -q origin', { cwd: root });
    execSync(`git clone -q "${bare}" "${clone}"`);
    execSync('git checkout -q ai/login-oauth', { cwd: clone });
    execSync('git -c user.name=o -c user.email=o@o commit -q --allow-empty -m "do remoto"', { cwd: clone });
    execSync('git push -q origin ai/login-oauth', { cwd: clone });
    await api.gitOps.fetchNow({ quiet: true });
    let wt = ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth');
    assert.strictEqual(wt.remote.behind, 1, 'um commit novo no remoto');
    assert.strictEqual(await api.gitOps.pull('ai/login-oauth', { quiet: true }), true);
    await ctl.refresh();
    wt = ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth');
    assert.strictEqual(wt.remote.behind, 0);
    assert.strictEqual(execSync('git log -1 --format=%s', { cwd: wt.path, encoding: 'utf8' }).trim(), 'do remoto');
  });

  await check('stash: guarda numa worktree e move as alterações para outra', async () => {
    const path = require('path');
    const fs = require('fs');
    const from = ctl.state.worktrees.find(w => w.branch === 'ai/precos-promo');
    const to = ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth');
    fs.writeFileSync(path.join(from.path, 'nota.txt'), 'rascunho\n');
    const sha = await api.gitOps.stashCreate(from.path, 'nota de teste', { quiet: true });
    assert.ok(sha, 'stash criado');
    assert.ok(!fs.existsSync(path.join(from.path, 'nota.txt')), 'saiu da origem');
    const list = await api.gitOps.stashes();
    assert.strictEqual(list[0].branch, 'ai/precos-promo');
    assert.strictEqual(await api.gitOps.stashApply(sha, to.path, true, { quiet: true }), true);
    assert.ok(fs.existsSync(path.join(to.path, 'nota.txt')), 'chegou no destino');
    assert.ok(!(await api.gitOps.stashes()).some(e => e.sha === sha), 'pop removeu o stash');
    fs.unlinkSync(path.join(to.path, 'nota.txt'));
    const root = await tree.getChildren();
    assert.ok(root.some(n => n.kind === 'stashes'), 'grupo Stashes na árvore');
  });

  await check('trocar de branch: a worktree passa para outra branch e volta', async () => {
    const { execSync } = require('child_process');
    const wt = ctl.state.worktrees.find(w => w.branch === 'ai/precos-promo');
    const head = p => execSync('git branch --show-current', { cwd: p, encoding: 'utf8' }).trim();
    execSync('git branch tmp/troca', { cwd: wt.path });
    assert.strictEqual(await api.gitOps.switchBranch(wt.path, 'tmp/troca', { confirm: false }), true);
    assert.strictEqual(head(wt.path), 'tmp/troca');
    await ctl.refresh();
    assert.ok(ctl.state.worktrees.some(w => w.path === wt.path && w.branch === 'tmp/troca'), 'estado mostra a branch nova');
    assert.strictEqual(await api.gitOps.switchBranch(wt.path, 'ai/precos-promo', { confirm: false }), true);
    assert.strictEqual(head(wt.path), 'ai/precos-promo');
    execSync('git branch -D tmp/troca', { cwd: wt.path });
    await ctl.refresh();
  });

  await check('reorganizar commits: fixup junta dois commits e "Desfazer" volta', async () => {
    const { execSync } = require('child_process');
    const wt = ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth');
    const before = execSync('git rev-parse HEAD', { cwd: wt.path, encoding: 'utf8' }).trim();
    const { commits } = await api.gitOps.commitsSinceBase(wt.path);
    const plan = commits.map((c, i) => ({ sha: c.sha, subject: c.subject, action: i === commits.length - 1 ? 'fixup' : 'pick' }));
    assert.strictEqual(await api.gitOps.reorganize(wt.path, plan), true);
    const after = await api.gitOps.commitsSinceBase(wt.path);
    assert.strictEqual(after.commits.length, commits.length - 1, 'um commit a menos');
    assert.strictEqual(await api.gitOps.undoReorganize('ai/login-oauth'), true);
    assert.strictEqual(execSync('git rev-parse HEAD', { cwd: wt.path, encoding: 'utf8' }).trim(), before);
  });

  await check('cherry-pick: commit de ai/precos-promo aplicado em ai/login-oauth', async () => {
    const { execSync } = require('child_process');
    const src = ctl.state.worktrees.find(w => w.branch === 'ai/precos-promo');
    const sha = execSync('git rev-parse HEAD', { cwd: src.path, encoding: 'utf8' }).trim();
    assert.strictEqual(await api.gitOps.cherryPick(sha, 'ai/login-oauth', { confirm: false }), true);
    const dst = ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth');
    assert.strictEqual(execSync('git log -1 --format=%s', { cwd: dst.path, encoding: 'utf8' }).trim(), 'feat(precos): preços da promoção');
  });

  await check('comparar duas worktrees: arquivos diferentes, inclusive não commitados', async () => {
    const files = await api.gitOps.compareFiles('ai/refatorar-api', 'ai/precos-promo');
    const paths = files.map(f => f.path);
    assert.ok(paths.includes('src/api.ts'), paths.join(','));
    assert.ok(paths.includes('src/novo.ts'), 'não rastreado em ai/refatorar-api');
    assert.strictEqual(files.find(f => f.path === 'src/novo.ts').status, 'D', 'só existe no lado A');
  });

  await check('remover mescladas: entram só as limpas com a branch inteira na base', async () => {
    const path = require('path');
    const fs = require('fs');
    const { execSync } = require('child_process');
    const root = ctl.repo.root;
    const pronta = path.join(root, '..', 'limpeza-pronta');
    const suja = path.join(root, '..', 'limpeza-suja');
    execSync(`git worktree add -q -b limpeza/pronta "${pronta}" master`, { cwd: root });
    execSync(`git worktree add -q -b limpeza/suja "${suja}" master`, { cwd: root });
    fs.writeFileSync(path.join(suja, 'rascunho.txt'), 'x');
    await ctl.refresh();
    await until(() => ctl.state.pending === 0, 30000);
    const { removable, dirty } = api.actions.mergedWorktrees(ctl);
    const names = removable.map(w => w.branch);
    assert.ok(names.includes('limpeza/pronta'), names.join(','));
    assert.ok(!names.includes('limpeza/suja') && dirty.some(w => w.branch === 'limpeza/suja'), 'suja fica de fora');
    assert.ok(!names.includes('ai/login-oauth'), 'branch com commits fora da base não entra');
    assert.ok(!names.includes('master'), 'base nunca entra');
    execSync(`git worktree remove --force "${pronta}"`, { cwd: root });
    execSync(`git worktree remove --force "${suja}"`, { cwd: root });
  });

  await check('pull requests: sem remoto pede conexão; com API falsa agrupa e traz a branch para uma worktree', async () => {
    const path = require('path');
    const { execSync } = require('child_process');
    const prs = api.prs;
    prs.svc.setBrowser(undefined);
    prs.svc.resetForProject();
    await prs.svc.refresh(true);
    let root = await prs.tree.getChildren();
    if (!ctl.requests.remote) assert.ok(String(root[0].label).startsWith('Connect'), String(root[0].label));

    // remoto local com uma branch que ainda não existe aqui
    const repoRoot = ctl.repo.root;
    const hasOrigin = execSync('git remote', { cwd: repoRoot, encoding: 'utf8' }).split(/\r?\n/).includes('origin');
    if (!hasOrigin) {
      const bare = path.join(repoRoot, '..', 'origin-prs.git');
      execSync(`git init -q --bare "${bare}"`);
      execSync(`git remote add origin "${bare}"`, { cwd: repoRoot });
    }
    execSync('git push -q origin master:refs/heads/prs/feature', { cwd: repoRoot });
    const pr = (id, author, source, extra = {}) => ({ id, ref: `#${id}`, url: `https://example.com/pull/${id}`, title: `PR ${id}`, state: 'open', source, target: 'master', author, reviewers: [], createdAt: 0, updatedAt: 0, ...extra });
    const open = [pr(1, 'eu', 'prs/feature'), pr(2, 'ana', 'ana/x', { reviewers: ['eu'], review: { state: 'changes', approvals: 0, by: ['ana'] } })];
    prs.svc.setBrowser({
      kind: 'github', label: 'PR',
      can: { files: false, comments: false, checks: false, merge: false, draft: false, reviewRequested: true },
      whoami: async () => 'eu',
      groups: async () => ({ mine: [open[0]], reviewRequested: [open[1]], open, recentlyMerged: [] }),
    });
    await prs.svc.refresh(true);
    root = await prs.tree.getChildren();
    const labels = root.map(n => `${n.label}:${n.description}`);
    assert.deepStrictEqual(labels, ['Mine:1', 'Awaiting my review:1', 'All open:2', 'Merged (7 days):0']);
    const mine = await prs.tree.getChildren(root[0]);
    assert.ok(String(mine[0].label).startsWith('#1'), String(mine[0].label));
    assert.ok(mine[0].contextValue.includes('nowt'));
    const rev = await prs.tree.getChildren(root[1]);
    assert.ok(rev[0].description.includes('changes requested'), rev[0].description);

    await vscode.commands.executeCommand('worktreeGraph.pullRequests.bringWorktree', '#1');
    await ctl.refresh();
    const wt = ctl.state.worktrees.find(w => w.branch === 'prs/feature');
    assert.ok(wt, 'worktree da branch do PR criada');
    assert.ok((await prs.tree.getChildren(root[0]))[0].contextValue.includes('-wt'), 'item passa a indicar a worktree');

    // issues, pipelines e PRs ficam na mesma view, uma seção para cada
    const sections = await api.remote.getChildren();
    assert.deepStrictEqual(sections.map(s => s.contextValue), ['remoteSection-issues', 'remoteSection-pipelines', 'remoteSection-prs']);
    const prGroups = await api.remote.getChildren(sections[2]);
    assert.strictEqual(String(prGroups[0].label), 'Mine');
    const firstPr = (await api.remote.getChildren(prGroups[0]))[0];
    assert.ok(String(firstPr.label).startsWith('#1'), 'a seção delega os filhos para a árvore de PRs');
    assert.strictEqual((await api.remote.getParent(prGroups[0])).id, 'remote:prs', 'o grupo tem a seção como pai (reveal)');
    await ctl.repo.removeWorktree(wt.path, true);
    prs.svc.setBrowser(undefined);
  });

  await check('histórico: filtro CI lista as branches do workflow e detalhes do commit vêm sob demanda', async () => {
    const path = require('path');
    const fs = require('fs');
    const root = ctl.repo.root;
    const dir = path.join(root, '.github', 'workflows');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ci.yml'), 'on:\n  push:\n    branches: [master, "release/*"]\njobs: {}\n');
    try {
      await vscode.commands.executeCommand('worktreeGraph.refresh');
      await ctl.ctx.workspaceState.update('graphFilter', 'ci');
      await ctl.refresh();
      const names = ctl.state.ciBranches.map(b => b.name);
      assert.ok(names.includes('master') && names.includes('release/1.0'), names.join(','));
      assert.ok(ctl.state.ciBranches.find(b => b.name === 'release/1.0').sources.includes('.github/workflows/ci.yml'));
      assert.ok(!names.includes('ai/login-oauth'), 'branch de trabalho não entra');
      assert.ok(ctl.state.commits.length > 0 && !ctl.state.commits.some(c => c.subject === 'feat(auth): login via OAuth'), 'só commits das branches de CI');
      const { commitDetails } = require('../out/commits');
      const sha = ctl.state.commits[0].sha;
      assert.ok(!('files' in ctl.state.commits[0]), 'estado não carrega detalhes');
      const d = await commitDetails(ctl, sha);
      assert.strictEqual(d.sha, sha);
      assert.ok(d.authorEmail && d.message && Array.isArray(d.files));
    } finally {
      fs.rmSync(path.join(root, '.github'), { recursive: true, force: true });
      await ctl.ctx.workspaceState.update('graphFilter', 'all');
      await ctl.refresh();
    }
  });

  await check('histórico: "Mostrar só esta branch" deixa no grafo só os commits dela', async () => {
    await ctl.ctx.workspaceState.update('graphFilter', 'unmerged');
    try {
      await api.panelAction('historyOfBranch', { branch: 'ai/login-oauth' });
      assert.strictEqual(ctl.state.graphFilter, 'all');
      assert.deepStrictEqual(ctl.state.graphBranches, ['ai/login-oauth']);
      const head = ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth').head;
      assert.ok(ctl.state.commits.some(c => c.sha === head), 'topo da branch aparece');
      const own = new Set(require('child_process').execSync('git rev-list refs/heads/ai/login-oauth', { cwd: ctl.repo.root, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean));
      const other = ctl.state.commits.filter(c => !own.has(c.sha));
      assert.deepStrictEqual(other.map(c => c.subject), [], 'commit de outra branch não aparece');
    } finally {
      await ctl.ctx.workspaceState.update('graphBranches', []);
      await ctl.ctx.workspaceState.update('graphFilter', 'all');
      await ctl.refresh();
    }
  });

  await check('agendamentos: o relógio dispara o agente e "só se limpa" pula a suja', async () => {
    const path = require('path');
    const fs = require('fs');
    const { execSync } = require('child_process');
    const sch = api.schedules;
    const root = ctl.repo.root;
    await vscode.workspace.getConfiguration('worktreeGraph').update('agents', [{ name: 'Eco', command: 'echo', promptCommand: 'echo {prompt}' }], vscode.ConfigurationTarget.Global);
    const limpa = path.join(root, '..', 'sched-limpa');
    const suja = path.join(root, '..', 'sched-suja');
    execSync(`git worktree add -q -b sched/limpa "${limpa}" master`, { cwd: root });
    execSync(`git worktree add -q -b sched/suja "${suja}" master`, { cwd: root });
    fs.writeFileSync(path.join(suja, 'rascunho.txt'), 'x');
    const base = { agent: 'Eco', conditions: {}, missed: 'run', enabled: true, scope: 'local' };

    // 1. "a cada minuto", criado há 5 min: o tick executa uma vez e abre o agente com o prompt montado
    const t0 = Date.now();
    sch.now = () => t0;
    await sch.save({ ...base, id: 'teste-launch', name: 'Revisão diária', when: 'a cada minuto', target: { kind: 'branch', branch: 'sched/limpa' }, prompt: 'Revise ${branch} contra ${base}', createdAt: t0 - 5 * 60_000 });
    const before = vscode.window.terminals.length;
    await sch.tick();
    assert.ok(before >= 0);
    try {
      await until(() => vscode.window.terminals.some(x => x.name === 'Eco · sched/limpa · task'), 15000);
    } catch {
      assert.fail(`terminal da tarefa não abriu: ${vscode.window.terminals.map(x => x.name).join(' | ')} · histórico: ${JSON.stringify(sch.history().slice(0, 3))}`);
    }
    assert.strictEqual(fs.readFileSync(api.agentTerms.lastPromptFile, 'utf8'), 'Revise sched/limpa contra master');
    await until(() => sch.runtime('teste-launch').lastRun === t0);
    const n = vscode.window.terminals.length;
    await sch.tick(); // mesmo minuto: nada a fazer
    assert.strictEqual(vscode.window.terminals.length, n, 'não executa duas vezes no mesmo horário');
    await sch.remove('teste-launch');

    // 2. "só se limpa" em ai/* e sched/*: a suja fica de fora e vai para o histórico
    await sch.save({ ...base, id: 'teste-limpa', name: 'Só limpas', when: 'dias úteis às 08:30', target: { kind: 'pattern', pattern: 'sched/*' }, prompt: 'x', conditions: { onlyClean: true, skipIfAgentOpen: true }, createdAt: t0 });
    const res = await sch.run(sch.get('teste-limpa'), { manual: true });
    const byBranch = Object.fromEntries(res.map(x => [x.target, x.result]));
    assert.strictEqual(byBranch['sched/suja'], 'skipped', JSON.stringify(res));
    assert.strictEqual(byBranch['sched/limpa'], 'skipped', 'já há agente aberto (do passo 1)');
    assert.ok(sch.history().some(h => h.scheduleId === 'teste-limpa' && /change/.test(h.message)), JSON.stringify(sch.history().filter(h => h.scheduleId === 'teste-limpa')));
    await sch.remove('teste-limpa');

    // 3. horário perdido com política "pular": registra e não executa
    await sch.save({ ...base, id: 'teste-perdido', name: 'Perdido', when: 'todo dia às 03:00', target: { kind: 'branch', branch: 'sched/limpa' }, prompt: 'x', missed: 'skip', createdAt: t0 - 3 * 86400_000 });
    const n2 = vscode.window.terminals.length;
    await sch.tick();
    assert.strictEqual(vscode.window.terminals.length, n2);
    assert.ok(sch.history().some(h => h.scheduleId === 'teste-perdido' && h.result === 'skipped'));
    await sch.remove('teste-perdido');
    sch.now = () => Date.now();
    execSync(`git worktree remove --force "${suja}"`, { cwd: root });
  });

  await check('coordenação: sobreposição e tarefa em lote', async () => {
    const path = require('path');
    const fs = require('fs');
    const { execSync } = require('child_process');
    const root = ctl.repo.root;
    const git = (c, cwd = root) => execSync(`git -c user.name=t -c user.email=t@t ${c}`, { cwd, encoding: 'utf8' }).trim();
    const cfg = vscode.workspace.getConfiguration('worktreeGraph');
    const G = vscode.ConfigurationTarget.Global;
    const coord = api.coord;

    // sobreposição: coord/x commita em src/api.ts, que ai/refatorar-api tem alterado sem commit
    const x = path.join(root, '..', 'coord-x');
    git(`worktree add -q -b coord/x "${x}" master`);
    fs.writeFileSync(path.join(x, 'src', 'api.ts'), 'export function api() { return "v3"; }\n');
    git('commit -qam "coord: api v3"', x);
    await ctl.refresh();
    await until(() => ctl.state.pending === 0, 30000);
    await coord.recompute();
    const o = coord.overlaps.find(v => [v.a, v.b].some(p => p.toLowerCase() === x.toLowerCase()));
    assert.ok(o, 'sobreposição encontrada');
    assert.ok(o.files.includes('src/api.ts'), o.files.join(','));
    await ctl.refresh();
    assert.ok(ctl.state.worktrees.find(w => w.branch === 'coord/x').overlap, 'chip no estado');

    // tarefa em lote: 3 worktrees, 2 vagas → 2 terminais agora e 1 esperando
    for (const n of ['a', 'b']) git(`worktree add -q -b lote/${n} "${path.join(root, '..', `lote-${n}`)}" master`);
    await ctl.refresh();
    await cfg.update('agents', [{ name: 'Eco', command: 'echo', promptCommand: 'echo {prompt}' }], G);
    const running = [...api.agentTerms.running().values()].reduce((n, l) => n + l.length, 0);
    await cfg.update('batch.maxParallel', running + 2, G);
    const targets = ['coord/x', 'lote/a', 'lote/b'].map(b => ctl.state.worktrees.find(w => w.branch === b).path);
    const before = vscode.window.terminals.length;
    await coord.batch({ paths: targets, prompt: 'rode os testes em ${branch}' });
    await until(() => vscode.window.terminals.length === before + 2);
    assert.strictEqual(coord.batchPending, 1, 'um esperando vaga');
    assert.ok(require('fs').readFileSync(api.agentTerms.lastPromptFile, 'utf8').startsWith('rode os testes em '));
    await cfg.update('batch.maxParallel', undefined, G);
  });

  await check('ambiente: nova worktree ganha .env da principal com a porta dela (fora do git)', async () => {
    const path = require('path');
    const fs = require('fs');
    const { execSync } = require('child_process');
    const cfg = vscode.workspace.getConfiguration('worktreeGraph');
    const G = vscode.ConfigurationTarget.Global;
    const root = ctl.repo.root;
    fs.appendFileSync(path.join(ctl.repo.commonDir, 'info', 'exclude'), '\n.env\n');
    fs.writeFileSync(path.join(root, '.env'), '# app\nPORT=8000\nDB_URL=sqlite://x\n');
    await cfg.update('env.ports', { base: 4100, step: 10, vars: ['PORT', 'VITE_PORT'] }, G);
    try {
      const dir = await api.actions.createWorktree(ctl, { branch: 'env/teste', quiet: true });
      const text = fs.readFileSync(path.join(dir, '.env'), 'utf8');
      assert.ok(/^PORT=41\d0$/m.test(text), text);
      assert.ok(text.includes('DB_URL=sqlite://x') && text.includes('VITE_PORT='), text);
      assert.strictEqual(execSync('git status --porcelain', { cwd: dir, encoding: 'utf8' }).trim(), '', '.env fora do git');
      await ctl.refresh();
      const port = Number(/^PORT=(\d+)$/m.exec(text)[1]);
      assert.strictEqual(ctl.state.worktrees.find(w => w.branch === 'env/teste').port, port, 'porta no estado');
      execSync(`git worktree remove --force "${dir}"`, { cwd: root });
    } finally {
      await cfg.update('env.ports', undefined, G);
      fs.unlinkSync(path.join(root, '.env'));
    }
  });

  await check('modelo de tarefa: prompt renderizado vai para o agente', async () => {
    const fs = require('fs');
    await vscode.workspace.getConfiguration('worktreeGraph').update('agents', [{ name: 'Eco', command: 'echo', promptCommand: 'echo {prompt}' }], vscode.ConfigurationTarget.Global);
    const wt = ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth');
    const all = await api.templates.list();
    const t = all.find(x => x.id === 'simplify-diff');
    assert.ok(t && all.length >= 6);
    await api.templates.send({ path: wt.path, branch: wt.branch }, t);
    const text = fs.readFileSync(api.agentTerms.lastPromptFile, 'utf8');
    assert.ok(text.includes('ai/login-oauth') && text.includes('master') && !text.includes('${'), text);
  });

  await check('integração Claude: MCP e hooks falam com a janela pela ponte local', async () => {
    const core = require('../out/bridge/core');
    const path = require('path');
    const wt = ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth');
    const other = ctl.state.worktrees.find(w => w.branch === 'ai/precos-promo');
    await until(() => api.bridge.running() && core.findBridge(wt.path));
    const info = core.findBridge(path.join(wt.path, 'src'));
    assert.strictEqual(info.port, api.bridge.port());
    const st = await core.callBridge(info, 'tool', { name: 'status', args: {}, cwd: wt.path });
    assert.ok(!st.isError && st.text.includes('ai/login-oauth') && st.text.includes('base'), st.text);
    const all = await core.callBridge(info, 'tool', { name: 'list_worktrees', args: {}, cwd: wt.path });
    assert.ok(all.text.includes('ai/precos-promo'), all.text);
    assert.ok((await core.callBridge(info, 'tool', { name: 'status', args: { worktree: 'nao/existe' }, cwd: wt.path })).isError);
    // sem travas: editar arquivo de outra worktree ou rodar git em outra branch passa
    const edit = await core.callBridge(info, 'hook', { hook_event_name: 'PreToolUse', cwd: wt.path, tool_name: 'Edit', tool_input: { file_path: path.join(other.path, 'x.ts') } });
    assert.ok(!edit.stdout, edit.stdout);
    const git = await core.callBridge(info, 'hook', { hook_event_name: 'PreToolUse', cwd: wt.path, tool_name: 'Bash', tool_input: { command: 'git checkout master' } });
    assert.ok(!git.stdout, git.stdout);
    // contexto da sessão
    const ctxOut = await core.callBridge(info, 'hook', { hook_event_name: 'SessionStart', cwd: wt.path, source: 'startup' });
    const add = JSON.parse(ctxOut.stdout).hookSpecificOutput.additionalContext;
    assert.ok(add.includes('ai/login-oauth') && add.includes('master'), add);
    // turno: checkpoint no começo e no fim, com o que mudou
    await core.callBridge(info, 'hook', { hook_event_name: 'UserPromptSubmit', cwd: wt.path, session_id: 'sessao-ponte', prompt: 'crie turno.txt' });
    require('fs').writeFileSync(path.join(wt.path, 'turno.txt'), 'oi\n');
    await core.callBridge(info, 'hook', { hook_event_name: 'Stop', cwd: wt.path, session_id: 'sessao-ponte' });
    const log = await until(() => api.claudeIntegration.logsFor(wt.path).find(l => l.session === 'sessao-ponte' && l.turns[0]?.end));
    assert.strictEqual(log.turns[0].files, 1);
    const diff = await core.callBridge(info, 'tool', { name: 'turn_diff', args: {}, cwd: wt.path });
    assert.ok(diff.text.includes('turno.txt') && diff.text.includes('+oi'), diff.text);
    require('fs').rmSync(path.join(wt.path, 'turno.txt'));
    await assert.rejects(core.callBridge({ ...info, token: 'errado' }, 'ping', {}), /denied/);
  });

  await check('espaço em disco: calculado em segundo plano e no estado', async () => {
    await api.env.recomputeSizes();
    await ctl.refresh();
    const sized = ctl.state.worktrees.filter(w => w.size && w.size.bytes > 0);
    assert.ok(sized.length >= 3, `${sized.length} com tamanho`);
  });

  await check('entrega: linha do tempo tem as branches ai/* e abre o painel', async () => {
    const rows = await api.delivery.timeline(30);
    const names = rows.map(r => r.branch);
    for (const b of ['ai/login-oauth', 'ai/precos-promo', 'ai/refatorar-api']) assert.ok(names.includes(b), names.join(','));
    assert.deepStrictEqual((await api.delivery.timeline(30, 'ai/*')).every(r => r.branch.startsWith('ai/')), true);
    await vscode.commands.executeCommand('worktreeGraph.timeline');
    await until(() => vscode.window.tabGroups.activeTabGroup.activeTab?.label === 'Timeline');
  });

  await check('entrega: relatório do dia lista as branches com commits hoje', async () => {
    const { execSync } = require('child_process');
    const wt = ctl.state.worktrees.find(w => w.branch === 'ai/precos-promo');
    execSync('git -c user.name=t -c user.email=t@t commit -q --allow-empty -m "feat: ajuste do relatório"', { cwd: wt.path });
    const md = await api.delivery.report('today');
    assert.ok(md.startsWith('# Report for today'), md.slice(0, 80));
    assert.ok(md.includes('### `ai/precos-promo`'), md);
    assert.ok(md.includes('feat: ajuste do relatório'));
  });

  await check('entrega: preparar versão num clone descartável cria a tag v1.2.0 e o CHANGELOG', async () => {
    const path = require('path');
    const fs = require('fs');
    const os = require('os');
    const { execSync } = require('child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentyard-release-'));
    const clone = path.join(tmp, 'repo');
    execSync(`git clone -q "${ctl.repo.root}" "${clone}"`);
    const g = c => execSync(`git -c user.name=t -c user.email=t@t ${c}`, { cwd: clone, encoding: 'utf8' }).trim();
    g('checkout -q master');
    fs.writeFileSync(path.join(clone, 'CHANGELOG.md'), '# Changelog\n\n## 1.1.0\n- versão anterior\n');
    g('add CHANGELOG.md');
    g('commit -q -m "docs: changelog inicial"');
    g('commit -q --allow-empty -m "feat(api): rota nova"');
    execSync('git config user.name t && git config user.email t@t', { cwd: clone });
    const plan = await api.delivery.prepareRelease({ cwd: clone, confirm: false });
    assert.strictEqual(plan.version, '1.2.0');
    assert.strictEqual(plan.tag, 'v1.2.0');
    assert.strictEqual(g('describe --tags --abbrev=0'), 'v1.2.0');
    const cl = fs.readFileSync(path.join(clone, 'CHANGELOG.md'), 'utf8');
    assert.ok(cl.indexOf('## 1.2.0') < cl.indexOf('## 1.1.0') && cl.includes('versão anterior'), cl);
    assert.ok(cl.includes('**api:** rota nova'), cl);
    assert.strictEqual(g('log -1 --format=%s'), 'Version 1.2.0');
    // o repositório da demo não ganhou tag
    assert.strictEqual(execSync('git tag', { cwd: ctl.repo.root, encoding: 'utf8' }).includes('v1.2.0'), false);
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      // no Windows algum arquivo pode seguir aberto; a pasta é temporária
    }
  });

  await check('excluir branches mescladas: só as sem worktree e já inteiras na base', async () => {
    const { execSync } = require('child_process');
    const g = c => execSync(`git -c user.name=t -c user.email=t@t ${c}`, { cwd: ctl.repo.root, encoding: 'utf8' }).trim();
    g('branch velha/mesclada master');
    g(`branch velha/pendente ${g('commit-tree "master^{tree}" -p master -m pendente')}`);
    await ctl.refresh();
    const actions = require('../out/actions');
    const candidates = await actions.mergedBranches(ctl);
    assert.ok(candidates.includes('velha/mesclada') && candidates.includes('fix/typo-readme'), candidates.join(','));
    assert.ok(!candidates.includes('velha/pendente'), 'com commit fora da base fica');
    assert.ok(!candidates.includes('master') && !candidates.some(b => b.startsWith('ai/')), 'base e branches de worktree ficam');

    const original = vscode.window.showWarningMessage;
    const stub = async () => 'Delete branches';
    vscode.window.showWarningMessage = stub;
    assert.strictEqual(vscode.window.showWarningMessage, stub, 'consegue substituir o diálogo');
    try {
      await vscode.commands.executeCommand('worktreeGraph.removeMergedBranches');
    } finally {
      vscode.window.showWarningMessage = original;
    }
    const heads = g('for-each-ref --format=%(refname:short) refs/heads').split(/\r?\n/);
    assert.ok(!heads.includes('velha/mesclada') && !heads.includes('fix/typo-readme'), heads.join(','));
    assert.ok(heads.includes('velha/pendente') && heads.includes('master') && heads.includes('ai/login-oauth'), heads.join(','));
    g('branch -D velha/pendente');
  });

  await check('status depois do commit: watcher vence o cache e mark_ready lê do git na hora', async () => {
    const fs = require('fs');
    const path = require('path');
    const { execSync } = require('child_process');
    const { worktreeOfGitFile } = require('../out/model');
    const wt = ctl.state.worktrees.find(w => w.branch === 'ai/precos-promo');
    const g = c => execSync(`git -c user.name=t -c user.email=t@t ${c}`, { cwd: wt.path, encoding: 'utf8' }).trim();
    const k = path.normalize(wt.path).toLowerCase();
    const common = ctl.repo.commonDir;
    const name = fs.readdirSync(path.join(common, 'worktrees')).find(n => worktreeOfGitFile(common, path.join(common, 'worktrees', n, 'index')) && path.normalize(worktreeOfGitFile(common, path.join(common, 'worktrees', n, 'index'))).toLowerCase() === k);
    assert.ok(name, 'worktrees/<nome>/index aponta para a worktree');
    assert.strictEqual(worktreeOfGitFile(common, path.join(common, 'refs', 'heads', 'x')), undefined);

    fs.writeFileSync(path.join(wt.path, 'status-cache.txt'), 'x');
    const dirty = await ctl.freshWorktree(wt.path);
    assert.ok(dirty.changes >= 1, JSON.stringify(dirty));
    const aheadBefore = dirty.ahead;
    g('add status-cache.txt');
    g('commit -q -m status-cache');
    try {
      // sem esperar o statusRefresh.activeSeconds: o commit mexe no index e o watcher vence o status
      await until(() => ctl.cache.statuses.get(k)?.at === 0 || ctl.state.worktrees.find(w => w.path === wt.path)?.changes === 0);
      const now = await ctl.freshWorktree(wt.path);
      assert.strictEqual(now.changes, dirty.changes - 1);
      assert.strictEqual(now.ahead, aheadBefore + 1);
      assert.strictEqual(ctl.cache.statuses.get(k).changes, now.changes, 'status lido vai para o cache');
    } finally {
      // desfaz só o commit do teste (a worktree pode ter outras mudanças da demo)
      g('reset -q --soft HEAD~1');
      g('rm -q --cached status-cache.txt');
      fs.unlinkSync(path.join(wt.path, 'status-cache.txt'));
    }
  });

  console.log('\n' + results.join('\n'));
  if (results.some(r => r.startsWith('FAIL'))) throw new Error('falhas nos testes');
};

/** Monta a tela para o print real (scripts/print-vscode.ps1 captura a janela quando o marcador aparece). */
async function printScene(ctl) {
  const fs = require('fs');
  const cfg = vscode.workspace.getConfiguration('worktreeGraph');
  await cfg.update('agents', [{ name: 'Claude Code', command: 'claude --version' }, { name: 'Codex CLI', command: 'codex' }], vscode.ConfigurationTarget.Global);
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Default Dark Modern', vscode.ConfigurationTarget.Global);
  vscode.window.terminals.forEach(t => t.dispose());
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('workbench.view.extension.worktreeGraph');
  const wt = ctl.state.worktrees.find(w => w.branch === 'ai/refatorar-api');
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await ctl.ctx.globalState.update('panelUi', { layout: 'rows', split: 46, tab: 'b' });
  await ctl.ctx.workspaceState.update('graphFilter', 'all');
  await vscode.commands.executeCommand('worktreeGraph.openGraph');
  await vscode.commands.executeCommand('worktreeGraph.launchAgent', { path: wt.path, branch: wt.branch }, 'Claude Code');
  await wait(2500);
  await ctl.refresh();
  await wait(4000);
  fs.writeFileSync(process.env.WTGRAPH_PRINT, 'ready');
  await wait(12000);
}

/**
 * Roteiro do vídeo. scripts/record-vscode.ps1 grava a janela entre os marcadores start/stop e
 * scripts/make-video.sh monta o MP4 com as legendas registradas aqui.
 */
async function videoScene(api) {
  const fs = require('fs');
  const path = require('path');
  const { ctl, treeView, tree, actions, sync, GraphPanel } = api;
  const dir = process.env.WTGRAPH_VIDEO;
  const captions = [];
  const caption = text => captions.push({ t: Date.now(), text });

  const cfg = vscode.workspace.getConfiguration('worktreeGraph');
  await cfg.update('agents', [{ name: 'Claude Code', command: 'claude --version' }, { name: 'Codex CLI', command: 'codex' }], vscode.ConfigurationTarget.Global);
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Default Dark Modern', vscode.ConfigurationTarget.Global);
  vscode.window.terminals.forEach(t => t.dispose());
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('workbench.action.closePanel');
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('workbench.view.extension.worktreeGraph');
  // Painel empilhado (cards em cima, histórico embaixo) e histórico completo.
  await ctl.ctx.globalState.update('panelUi', { layout: 'rows', split: 46, tab: 'b' });
  await ctl.ctx.workspaceState.update('graphFilter', 'all');
  await ctl.refresh();
  await vscode.commands.executeCommand('notifications.clearAll');
  await wait(1500);
  fs.writeFileSync(path.join(dir, 'start'), '');
  await wait(1200);

  caption('AgentYard: as worktrees dos seus agentes de IA num painel só');
  await vscode.commands.executeCommand('worktreeGraph.openGraph');
  await wait(4500);

  caption('Cada card mostra se está limpa, quanto está atrás da master e se vai conflitar');
  await wait(4500);

  caption('Botão direito: merge, tarefas para o agente e revisão');
  GraphPanel.demo({ scene: 'menu', branch: 'ai/refatorar-api' });
  await wait(4500);
  GraphPanel.demo({ scene: 'hide' });

  caption('Histórico com o grafo de todas as branches e os detalhes de cada commit');
  GraphPanel.demo({ scene: 'expand', index: 3 });
  await wait(4500);
  GraphPanel.demo({ scene: 'expand', index: 3 });

  caption('Um clique abre o Claude Code já dentro da worktree');
  const wt = ctl.state.worktrees.find(w => w.branch === 'ai/refatorar-api');
  await vscode.commands.executeCommand('worktreeGraph.launchAgent', { path: wt.path, branch: wt.branch }, 'Claude Code');
  await wait(4500);

  caption('Na barra lateral: o que o agente mudou, com diff, sem trocar de janela');
  const root = await tree.getChildren();
  const node = root.find(n => n.branch === 'ai/refatorar-api');
  await treeView.reveal(node, { expand: true, select: true });
  await wait(800);
  const changes = (await tree.getChildren(node))[0];
  await treeView.reveal(changes, { expand: true });
  await wait(1200);
  const files = await tree.getChildren(changes);
  const apiFile = files.find(f => f.label === 'api.ts');
  await vscode.commands.executeCommand(apiFile.command.command, ...apiFile.command.arguments);
  await wait(4500);

  caption('Sessões do Claude Code e tokens de cada worktree');
  await vscode.commands.executeCommand('worktreeGraph.claudeSessions.focus');
  await wait(4000);

  caption('Analisar merge: commits que entram e conflitos previstos, antes de mesclar');
  await vscode.commands.executeCommand('worktreeGraph.analyzeMerge', 'ai/precos-promo', 'master');
  await wait(5000);

  caption('Atividade do dia: commits, sessões e tokens por worktree');
  await vscode.commands.executeCommand('worktreeGraph.activity');
  await wait(4500);

  caption('Linha do tempo de cada branch: commits, PR, aprovação e merge');
  await vscode.commands.executeCommand('worktreeGraph.timeline');
  await wait(4500);

  caption('Trazer a master para a branch com um clique');
  await vscode.commands.executeCommand('workbench.view.extension.worktreeGraph');
  await vscode.commands.executeCommand('worktreeGraph.openGraph');
  await wait(1500);
  await actions.mergeBranches(ctl, 'master', 'ai/login-oauth', { confirm: false, quiet: true });
  await ctl.refresh();
  await wait(4500);

  caption('Sync automático: mescla onde é seguro e espera onde o agente ainda trabalha');
  await ctl.setAutoSyncEnabled(true);
  sync.reschedule();
  await sync.tick(true);
  await ctl.refresh();
  await wait(5500);

  caption('AgentYard · no VS Code Marketplace e no Open VSX');
  await wait(3000);
  fs.writeFileSync(path.join(dir, 'captions.json'), JSON.stringify(captions));
  fs.writeFileSync(path.join(dir, 'stop'), '');
  await wait(1500);
}
