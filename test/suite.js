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
      await fn();
      results.push(`ok   ${name}`);
    } catch (e) {
      results.push(`FAIL ${name}: ${e.stack || e}`);
    }
  };

  const ext = vscode.extensions.getExtension('worktree-graph.worktree-graph');
  const api = await ext.activate();
  const { ctl, tree, agentTerms } = api;

  await check('estado carregado com 4 worktrees', async () => {
    const s = await until(() => ctl.state);
    assert.strictEqual(s.base, 'master');
    assert.strictEqual(s.worktrees.length, 4);
    assert.strictEqual(s.graphFilter, 'unmerged', 'histórico abre em "Não mescladas" por padrão');
    assert.ok(s.agentNames.includes('Claude Code'));
  });

  await check('comandos registrados', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const c of ['openGraph', 'launchAgent', 'openFileInWorktree', 'mergeBaseInto', 'generateCiWorkflow']) assert.ok(all.includes(`worktreeGraph.${c}`), c);
  });

  await check('árvore: worktrees + branches sem worktree', async () => {
    const root = await tree.getChildren();
    const labels = root.map(n => (typeof n.label === 'string' ? n.label : n.label.label));
    // principal primeiro, depois as mais recentes
    assert.deepStrictEqual(labels, ['master', 'ai/precos-promo', 'ai/refatorar-api', 'ai/login-oauth', 'Branches sem worktree', 'Stashes']);
  });

  await check('árvore: alterações × base incluem não commitados', async () => {
    const root = await tree.getChildren();
    const wt = root.find(n => n.branch === 'ai/refatorar-api');
    const kids = await tree.getChildren(wt);
    assert.strictEqual(kids[0].kind, 'changes');
    const changes = await tree.getChildren(kids[0]);
    const names = changes.map(c => c.label).sort();
    assert.deepStrictEqual(names, ['api.ts', 'novo.ts']);
    assert.strictEqual(changes[0].command.command, 'vscode.diff');
    assert.ok(kids.some(k => k.kind === 'dir'), 'lista pastas da worktree');
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
    await vscode.commands.executeCommand('worktreeGraph.launchAgent', { path: wt.path, branch: wt.branch });
    assert.strictEqual(vscode.window.terminals.length, before + 1, 'não duplica');
    await ctl.refresh();
    assert.deepStrictEqual(ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth').agents, ['Eco']);
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
    const t = vscode.window.terminals.find(x => x.name === 'Eco · ai/precos-promo · tarefa');
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
    assert.ok(vscode.window.terminals.some(x => x.name === 'Eco · ai/login-oauth · tarefa'));
    assert.strictEqual(fs.readFileSync(api.agentTerms.lastPromptFile, 'utf8'), 'linha 1\nlinha 2');
  });

  await check('issues: a view abre sem rede nem credenciais', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.worktreeGraph');
    await vscode.commands.executeCommand('worktreeGraph.issues.focus');
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
    await until(() => api.agentTerms.lastPromptFile && require('fs').readFileSync(api.agentTerms.lastPromptFile, 'utf8').includes('Trabalhe na issue #99: Teste de issue'));
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
    const scopes = svc.getChildren();
    assert.deepStrictEqual(scopes.map(n => n.scope), ['user', 'project']);
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
    await vscode.commands.executeCommand('worktreeGraph.pipelines.focus');
    await api.pipelines.refresh(true);
    assert.strictEqual(api.pipelines.unavailable, 'noRemote', 'demo sem remoto');
    const { PipelineTreeProvider } = require('../out/hosting/pipelinesView');
    const kids = await new PipelineTreeProvider(api.pipelines).getChildren();
    assert.strictEqual(kids.length, 1);
    assert.ok(String(kids[0].label).includes('Remoto'), String(kids[0].label));
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

  await check('atividade: painel abre e soma commits e tokens por branch; custo por tarefa com preço', async () => {
    await until(() => api.claude.loaded, 20000);
    await vscode.commands.executeCommand('worktreeGraph.activity');
    await until(() => vscode.window.tabGroups.activeTabGroup.activeTab?.label === 'Atividade');
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
      assert.ok(seen.some(m => m.includes('master é protegida')), seen.join(' | '));
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
      assert.ok(seen.some(m => /worktrees sobrando/.test(m)));
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

  await check('fila de tarefas: a próxima vai sozinha quando a atual fica pronta', async () => {
    const fs = require('fs');
    const { execSync } = require('child_process');
    const wt = ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth');
    const q = api.agentFlow.tasks;
    await q.add(wt.path, wt.branch, 'tarefa 1: criar endpoint');
    await until(() => fs.readFileSync(api.agentTerms.lastPromptFile, 'utf8') === 'tarefa 1: criar endpoint');
    await q.add(wt.path, wt.branch, 'tarefa 2: escrever testes');
    assert.deepStrictEqual(q.queue(wt.path).tasks.map(t => t.status), ['running', 'waiting']);
    execSync('git -c user.name=t -c user.email=t@t commit -q --allow-empty -m "tarefa 1"', { cwd: wt.path });
    await api.agentFlow.watch.checkNow(wt.path);
    await until(() => fs.readFileSync(api.agentTerms.lastPromptFile, 'utf8') === 'tarefa 2: escrever testes');
    await until(() => q.queue(wt.path).tasks.map(t => t.status).join() === 'done,running');
    await ctl.refresh();
    assert.deepStrictEqual(ctl.state.worktrees.find(w => w.branch === 'ai/login-oauth').tasks, { waiting: 0, running: 'tarefa 2: escrever testes' });
    await api.agentFlow.watch.clearReady(wt.path);
  });

  await check('tentativas: cria worktrees try/* com agente em cada e abre o painel de comparação', async () => {
    const g = await api.agentFlow.attempts.tryApproaches({ prompt: 'Implementar cache de preços', n: 2, quiet: true });
    assert.deepStrictEqual(g.attempts.map(a => a.branch), ['try/implementar-cache-de-precos-a', 'try/implementar-cache-de-precos-b']);
    await until(() => vscode.window.tabGroups.activeTabGroup.activeTab?.label === 'Tentativas: Implementar cache de preços');
    await ctl.refresh();
    assert.ok(ctl.state.worktrees.some(w => w.branch === 'try/implementar-cache-de-precos-b'));
    assert.ok(vscode.window.terminals.some(t => t.name === 'Eco · try/implementar-cache-de-precos-a · tarefa'));
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

  await check('agendamentos: o relógio dispara o agente, a fila recebe a tarefa e "só se limpa" pula a suja', async () => {
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
    await sch.save({ ...base, id: 'teste-launch', name: 'Revisão diária', when: 'a cada minuto', target: { kind: 'branch', branch: 'sched/limpa' }, prompt: 'Revise ${branch} contra ${base}', delivery: 'launch', createdAt: t0 - 5 * 60_000 });
    const before = vscode.window.terminals.length;
    await sch.tick();
    assert.ok(before >= 0);
    try {
      await until(() => vscode.window.terminals.some(x => x.name === 'Eco · sched/limpa · tarefa'), 15000);
    } catch {
      assert.fail(`terminal da tarefa não abriu: ${vscode.window.terminals.map(x => x.name).join(' | ')} · histórico: ${JSON.stringify(sch.history().slice(0, 3))}`);
    }
    assert.strictEqual(fs.readFileSync(api.agentTerms.lastPromptFile, 'utf8'), 'Revise sched/limpa contra master');
    assert.strictEqual(sch.runtime('teste-launch').lastRun, t0);
    const n = vscode.window.terminals.length;
    await sch.tick(); // mesmo minuto: nada a fazer
    assert.strictEqual(vscode.window.terminals.length, n, 'não executa duas vezes no mesmo horário');
    await sch.remove('teste-launch');

    // 2. modo fila: a tarefa entra na fila da worktree
    await sch.save({ ...base, id: 'teste-fila', name: 'Fila', when: 'todo dia às 09:00', target: { kind: 'branch', branch: 'sched/limpa' }, prompt: 'tarefa da fila', delivery: 'queue', createdAt: t0 });
    const r = await sch.run(sch.get('teste-fila'), { manual: true });
    assert.strictEqual(r[0].result, 'ok', JSON.stringify(r));
    assert.ok(api.agentFlow.tasks.queue(limpa).tasks.some(t => t.text === 'tarefa da fila'));
    await sch.remove('teste-fila');

    // 3. "só se limpa" em ai/* e sched/*: a suja fica de fora e vai para o histórico
    await sch.save({ ...base, id: 'teste-limpa', name: 'Só limpas', when: 'dias úteis às 08:30', target: { kind: 'pattern', pattern: 'sched/*' }, prompt: 'x', delivery: 'launch', conditions: { onlyClean: true, skipIfAgentOpen: true }, createdAt: t0 });
    const res = await sch.run(sch.get('teste-limpa'), { manual: true });
    const byBranch = Object.fromEntries(res.map(x => [x.target, x.result]));
    assert.strictEqual(byBranch['sched/suja'], 'skipped', JSON.stringify(res));
    assert.strictEqual(byBranch['sched/limpa'], 'skipped', 'já há agente aberto (do passo 1)');
    assert.ok(sch.history().some(h => h.scheduleId === 'teste-limpa' && /alteraç/.test(h.message)), JSON.stringify(sch.history().filter(h => h.scheduleId === 'teste-limpa')));
    await sch.remove('teste-limpa');

    // 4. horário perdido com política "pular": registra e não executa
    await sch.save({ ...base, id: 'teste-perdido', name: 'Perdido', when: 'todo dia às 03:00', target: { kind: 'branch', branch: 'sched/limpa' }, prompt: 'x', delivery: 'launch', missed: 'skip', createdAt: t0 - 3 * 86400_000 });
    const n2 = vscode.window.terminals.length;
    await sch.tick();
    assert.strictEqual(vscode.window.terminals.length, n2);
    assert.ok(sch.history().some(h => h.scheduleId === 'teste-perdido' && h.result === 'skipped'));
    await sch.remove('teste-perdido');
    sch.now = () => Date.now();
    execSync(`git worktree remove --force "${suja}"`, { cwd: root });
  });

  await check('coordenação: sobreposição, fila de merge numa base descartável e tarefa em lote', async () => {
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

    // fila de merge: duas branches limpas entram em fila/base, uma por vez
    git('branch fila/base master');
    for (const n of ['a', 'b']) {
      const d = path.join(root, '..', `fila-${n}`);
      git(`worktree add -q -b fila/${n} "${d}" master`);
      fs.writeFileSync(path.join(d, `fila-${n}.txt`), n);
      git('add -A', d);
      git(`commit -qm "fila ${n}"`, d);
    }
    await coord.enqueue('fila/a', 'fila/base');
    await coord.enqueue('fila/b', 'fila/base');
    await coord.runQueue();
    await until(() => coord.queue().filter(i => i.target === 'fila/base').every(i => i.status === 'done'), 60000);
    assert.strictEqual(git('merge-base --is-ancestor fila/a fila/base && echo sim'), 'sim');
    assert.strictEqual(git('merge-base --is-ancestor fila/b fila/base && echo sim'), 'sim');
    assert.notStrictEqual(git('rev-parse master'), git('rev-parse fila/base'), 'master intacta');
    await coord.clearFinished();

    // tarefa em lote: 3 worktrees, 2 vagas → 2 terminais agora e 1 esperando
    await cfg.update('agents', [{ name: 'Eco', command: 'echo', promptCommand: 'echo {prompt}' }], G);
    const running = [...api.agentTerms.running().values()].reduce((n, l) => n + l.length, 0);
    await cfg.update('batch.maxParallel', running + 2, G);
    const targets = ['coord/x', 'fila/a', 'fila/b'].map(b => ctl.state.worktrees.find(w => w.branch === b).path);
    const before = vscode.window.terminals.length;
    await coord.batch({ paths: targets, prompt: 'rode os testes em ${branch}', mode: 'now' });
    await until(() => vscode.window.terminals.length === before + 2);
    assert.strictEqual(coord.batchPending, 1, 'um esperando vaga');
    assert.ok(require('fs').readFileSync(api.agentTerms.lastPromptFile, 'utf8').startsWith('rode os testes em '));
    await cfg.update('batch.maxParallel', undefined, G);
  });

  if (process.env.WTGRAPH_PRINT) await printScene(ctl, tree);
  if (process.env.WTGRAPH_VIDEO) await videoScene(api);
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
  await wait(1500);
  fs.writeFileSync(path.join(dir, 'start'), '');
  await wait(1200);

  caption('AgentYard: todas as worktrees dos seus agentes num painel');
  await vscode.commands.executeCommand('worktreeGraph.openGraph');
  await wait(4500);

  caption('Cada card mostra se está limpa, quanto está atrás da master e se vai conflitar');
  await wait(4500);

  caption('Botão direito: merge, agentes, arquivos e revisão');
  GraphPanel.demo({ scene: 'menu', branch: 'ai/login-oauth' });
  await wait(4000);
  GraphPanel.demo({ scene: 'hide' });

  caption('✦ Abre o Claude Code já dentro da worktree');
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

  caption('Trazer a master para a branch com um clique');
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

  caption('github.com/joaopalmeidao/worktree-graph');
  await wait(3000);
  fs.writeFileSync(path.join(dir, 'captions.json'), JSON.stringify(captions));
  fs.writeFileSync(path.join(dir, 'stop'), '');
  await wait(1500);
}
