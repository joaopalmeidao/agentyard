// Testes de src/remote/dialogs com um vscode falso em que vscode.env é congelado, como no VS Code.
// Uso: node test/remoteDialogs.test.js
const assert = require('assert');
const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'vscode' ? 'vscode' : orig.call(this, r, ...a);
};
const opened = [];
const ran = [];
const vscode = {
  window: {
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    showTextDocument: async () => 'editor',
    createTerminal: () => 'terminal',
    createWebviewPanel: () => 'panel',
    showNotebookDocument: async () => 'notebook',
  },
  env: Object.freeze({ openExternal: async uri => (opened.push(uri.toString(true)), true), appName: 'Code' }),
  commands: { executeCommand: async id => (ran.push(id), 'ran') },
};
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscode };
const { installRemoteDialogs, runAsRemote } = require('../out/remote/dialogs');

const uri = s => ({ toString: () => s });
const sent = [];
const hub = { size: 1, has: c => c === 'tab', send: (c, m) => sent.push({ c, ...m }), request: () => ({ promise: Promise.resolve(undefined), cancel() {} }) };

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${e.stack || e}`);
  }
};

(async () => {
  const frozenEnv = vscode.env;
  const d = installRemoteDialogs(hub);

  await check('vscode.env congelado não impede instalar; o resto do env continua lá', () => {
    assert.strictEqual(vscode.env.appName, 'Code');
  });

  await check('fora do celular o link abre no computador', async () => {
    assert.strictEqual(await vscode.env.openExternal(uri('https://example.com/pr/1')), true);
    assert.deepStrictEqual(opened, ['https://example.com/pr/1']);
    assert.strictEqual(sent.length, 0);
  });

  await check('ação do celular: link da web vai para a aba; localhost vira aviso', async () => {
    await runAsRemote('tab', () => vscode.env.openExternal(uri('https://example.com/pr/2')));
    assert.ok(sent.some(m => m.c === 'tab' && m.type === 'open' && m.url === 'https://example.com/pr/2'));
    assert.strictEqual(await runAsRemote('tab', () => vscode.env.openExternal(uri('http://localhost:3000'))), false);
    assert.ok(sent.some(m => m.type === 'toast' && /localhost:3000/.test(m.message)));
    assert.strictEqual(opened.length, 1);
  });

  await check('editor e diff abrem no computador e a aba recebe um aviso por ação', async () => {
    sent.length = 0;
    await runAsRemote('tab', async () => {
      assert.strictEqual(await vscode.window.showTextDocument(), 'editor');
      await vscode.commands.executeCommand('vscode.diff');
    });
    assert.strictEqual(sent.filter(m => m.type === 'toast').length, 1);
    assert.deepStrictEqual(ran, ['vscode.diff']);
  });

  await check('dispose devolve o vscode.env original', () => {
    d.dispose();
    assert.strictEqual(vscode.env, frozenEnv);
  });

  if (failures) {
    console.log(`\n${failures} falha(s)`);
    process.exit(1);
  }
  console.log('\nremoteDialogs: tudo ok');
})();
