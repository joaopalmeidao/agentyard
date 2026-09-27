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
    assert.deepStrictEqual(labels, ['master', 'ai/precos-promo', 'ai/refatorar-api', 'ai/login-oauth', 'Branches sem worktree']);
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

  await check('painel do grafo abre', async () => {
    await vscode.commands.executeCommand('worktreeGraph.openGraph');
    await wait(1500);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.strictEqual(tab.label, 'Worktree Graph');
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
