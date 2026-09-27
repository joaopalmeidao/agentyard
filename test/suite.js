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

  await check('painel do grafo abre', async () => {
    await vscode.commands.executeCommand('worktreeGraph.openGraph');
    await wait(1500);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab.label.startsWith('Worktree Graph'), tab.label);
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

  await check('pull: fetch mostra ↓1 e o pull faz fast-forward', async () => {
    const path = require('path');
    const { execSync } = require('child_process');
    const root = ctl.repo.root;
    const bare = path.join(root, '..', 'origin-push.git');
    const clone = path.join(root, '..', 'clone-pull');
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

  caption('Worktree Graph: todas as worktrees dos seus agentes num painel');
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
