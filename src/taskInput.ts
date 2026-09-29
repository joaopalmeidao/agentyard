import * as path from 'path';
import * as vscode from 'vscode';
import { mentionOf } from './claude/sendContext';
import { t } from './i18n';

/** Extensão que dá ao VS Code o reconhecimento de voz (roda local, sem mandar o áudio para fora). */
export const SPEECH_EXTENSION = 'ms-vscode.vscode-speech';
const DICTATION_START = 'workbench.action.editorDictation.start';
const DICTATION_STOP = 'workbench.action.editorDictation.stop';
/** Depois de parar o ditado, o VS Code ainda escreve o fim da frase no editor. */
const SETTLE_MS = 400;
/** Contexto ligado enquanto o editor ativo é o rascunho de uma tarefa (Ctrl+Enter e os botões do título). */
const DRAFT_KEY = 'worktreeGraph.taskDraftFocused';

export interface TaskInputOptions {
  title: string;
  prompt?: string;
  value?: string;
  /** Já começa ditando, sem mostrar a caixa antes. */
  voice?: boolean;
  /** Pasta onde o agente vai rodar: os anexos dentro dela viram menções relativas, e a escolha de arquivos abre nela. */
  cwd?: string;
}

/**
 * Pede o texto de uma tarefa como o showInputBox (undefined = cancelou, '' = Enter vazio), com botões
 * para ditar (VS Code Speech), anexar arquivos e pastas (@menções) e escrever num editor, onde cabe
 * um prompt longo, de várias linhas.
 */
export async function askTask(o: TaskInputOptions): Promise<string | undefined> {
  let value = o.value ?? '';
  if (o.voice) {
    const spoken = await dictate(o.title, value, o.cwd);
    if (spoken !== undefined) value = spoken;
  }
  for (;;) {
    // a caixa é de uma linha só (junta as quebras): texto de várias linhas segue no editor
    if (/\n/.test(value.trim())) return writeTask(o.title, value, o.cwd);
    const r = await showBox(o, value);
    if (r.kind === 'done') return r.value;
    if (r.kind === 'editor') return writeTask(o.title, r.value, o.cwd);
    if (r.kind === 'voice') {
      value = (await dictate(o.title, r.value, o.cwd)) ?? r.value;
      continue;
    }
    const mentions = await pickAttachments(o.cwd);
    value = mentions ? `${r.value.trimEnd()}${r.value.trim() ? ' ' : ''}${mentions} ` : r.value;
  }
}

type BoxResult = { kind: 'done'; value: string | undefined } | { kind: 'voice' | 'attach' | 'editor'; value: string };

function showBox(o: TaskInputOptions, value: string): Promise<BoxResult> {
  return new Promise(resolve => {
    const box = vscode.window.createInputBox();
    const buttons: Record<'voice' | 'attach' | 'editor', vscode.QuickInputButton> = {
      attach: { iconPath: new vscode.ThemeIcon('files'), tooltip: t('Attach files or folders (@mentions)') },
      editor: { iconPath: new vscode.ThemeIcon('edit'), tooltip: t('Write in an editor (long prompts, several lines)') },
      voice: { iconPath: new vscode.ThemeIcon('mic'), tooltip: t('Dictate the task (VS Code Speech)') },
    };
    let result: BoxResult = { kind: 'done', value: undefined };
    box.title = o.title;
    box.prompt = o.prompt;
    box.value = value;
    box.ignoreFocusOut = true;
    box.buttons = [buttons.attach, buttons.editor, buttons.voice];
    box.onDidTriggerButton(b => {
      const kind = (Object.keys(buttons) as (keyof typeof buttons)[]).find(k => buttons[k] === b) ?? 'voice';
      result = { kind, value: box.value };
      box.hide();
    });
    box.onDidAccept(() => {
      result = { kind: 'done', value: box.value };
      box.hide();
    });
    box.onDidHide(() => {
      box.dispose();
      resolve(result);
    });
    box.show();
  });
}

/** Menções (`@caminho`) dos arquivos e pastas, relativas a `cwd` quando estão dentro dela. */
export function attachmentText(paths: string[], cwd?: string): string {
  return [...new Set(paths)].map(p => mentionOf(p, cwd ?? p)).join(' ');
}

/**
 * Escolhe arquivos, pastas ou abas abertas para anexar à tarefa e devolve as menções, ou undefined.
 * Arquivos e pastas são escolhas separadas: no Windows e no Linux o diálogo não pega os dois juntos.
 */
export async function pickAttachments(cwd?: string): Promise<string | undefined> {
  const open = [
    ...new Set(
      vscode.window.tabGroups.all
        .flatMap(g => g.tabs)
        .map(tab => tab.input)
        .filter((i): i is vscode.TabInputText => i instanceof vscode.TabInputText && i.uri.scheme === 'file')
        .map(i => i.uri.fsPath),
    ),
  ];
  type Item = vscode.QuickPickItem & { what: 'files' | 'folders' | 'tabs' };
  const items: Item[] = [
    { label: `$(file) ${t('Files…')}`, what: 'files' },
    { label: `$(folder) ${t('Folders…')}`, what: 'folders' },
    ...(open.length ? [{ label: `$(files) ${t('Files open in the editor…')}`, description: String(open.length), what: 'tabs' as const }] : []),
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: t('Attach to the task'),
    placeHolder: t('The agent gets an @mention of each one and reads what it needs'),
    ignoreFocusOut: true,
  });
  if (!pick) return undefined;
  let paths: string[];
  if (pick.what === 'tabs') {
    const where = (f: string) => {
      const rel = cwd ? path.relative(cwd, path.dirname(f)) : '';
      return cwd && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : path.dirname(f);
    };
    const chosen = await vscode.window.showQuickPick(
      open.map(f => ({ label: path.basename(f), description: where(f), f })),
      { title: t('Attach to the task'), placeHolder: t('Files open in the editor'), canPickMany: true, matchOnDescription: true, ignoreFocusOut: true },
    );
    paths = chosen?.map(c => c.f) ?? [];
  } else {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: pick.what === 'files',
      canSelectFolders: pick.what === 'folders',
      canSelectMany: true,
      defaultUri: cwd ? vscode.Uri.file(cwd) : undefined,
      openLabel: t('Attach'),
      title: t('Attach to the task'),
    });
    paths = uris?.filter(u => u.scheme === 'file').map(u => u.fsPath) ?? [];
  }
  return paths.length ? attachmentText(paths, cwd) : undefined;
}

type DraftEnd = 'send' | 'attach' | 'cancel' | 'closed';
let current: { doc: vscode.TextDocument; finish: (end: DraftEnd) => void } | undefined;

function syncDraftKey() {
  const on = !!current && vscode.window.activeTextEditor?.document === current.doc;
  void vscode.commands.executeCommand('setContext', DRAFT_KEY, on);
}

/** Ctrl+Enter e os botões "enviar" e "anexar" no título do rascunho. */
export function registerTaskDraft(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('worktreeGraph.taskDraft.send', () => current?.finish('send')),
    vscode.commands.registerCommand('worktreeGraph.taskDraft.attach', () => current?.finish('attach')),
    vscode.window.onDidChangeActiveTextEditor(syncDraftKey),
  );
}

interface DraftOptions {
  initial: string;
  message: string;
  sendLabel: string;
  cwd?: string;
  /** Com o rascunho aberto (ligar o ditado). */
  onOpen?: () => Promise<void>;
  /** Antes de ler o texto (parar o ditado). */
  onEnd?: () => Promise<void>;
}

/**
 * Rascunho num editor temporário: espera enviar (botão da notificação, Ctrl+Enter ou o título),
 * anexa arquivos na posição do cursor quantas vezes quiser e devolve o texto, ou undefined se cancelou.
 */
async function draft(o: DraftOptions): Promise<string | undefined> {
  current?.finish('cancel');
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: o.initial });
  let editor = await vscode.window.showTextDocument(doc, { preview: false });
  const end = doc.lineAt(doc.lineCount - 1).range.end;
  editor.selection = new vscode.Selection(end, end);
  await o.onOpen?.();
  const attach = t('Attach files or folders…');
  const cancel = t('Cancel');
  let noticeOpen = false;
  const notify = () => {
    noticeOpen = true;
    void vscode.window.showInformationMessage(o.message, o.sendLabel, attach, cancel).then(a => {
      noticeOpen = false;
      if (current?.doc !== doc) return;
      if (a === o.sendLabel) current.finish('send');
      else if (a === attach) current.finish('attach');
      else if (a === cancel) current.finish('cancel');
      // fechar a notificação no X não cancela: ainda dá para enviar pelo Ctrl+Enter ou pelo título
    });
  };
  let ending: DraftEnd;
  for (;;) {
    if (!noticeOpen) notify();
    ending = await new Promise<DraftEnd>(resolve => {
      const sub = vscode.workspace.onDidCloseTextDocument(d => d === doc && finish('closed'));
      const finish = (e: DraftEnd) => {
        sub.dispose();
        resolve(e);
      };
      current = { doc, finish };
      syncDraftKey();
    });
    if (ending !== 'attach') break;
    const mentions = await pickAttachments(o.cwd);
    if (doc.isClosed) {
      ending = 'closed';
      break;
    }
    editor = await vscode.window.showTextDocument(doc, { preview: false });
    if (mentions) {
      const at = editor.selection.active;
      const before = at.character > 0 ? doc.lineAt(at.line).text[at.character - 1] : '';
      await editor.edit(e => e.insert(at, `${before && !/\s/.test(before) ? ' ' : ''}${mentions} `));
    }
  }
  current = undefined;
  syncDraftKey();
  await o.onEnd?.();
  if (doc.isClosed) return undefined;
  const text = doc.getText().trim();
  await vscode.window.showTextDocument(doc, { preview: false });
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  return ending === 'send' ? text : undefined;
}

/** Escreve a tarefa num editor (cabe um prompt longo, de várias linhas) e devolve o texto, ou undefined. */
export function writeTask(title: string, initial = '', cwd?: string): Promise<string | undefined> {
  return draft({
    initial: initial.trim() ? `${initial.trimEnd()}${/\n/.test(initial.trim()) ? '\n' : ' '}` : '',
    message: t('{0}: write the task in the draft (several lines are fine). Ctrl+Enter or the send button in the title sends it; the files button attaches files and folders.', title),
    sendLabel: t('Send task'),
    cwd,
  });
}

/** Sem a VS Code Speech não há ditado: oferece instalar. */
export async function ensureSpeech(): Promise<boolean> {
  if (vscode.extensions.getExtension(SPEECH_EXTENSION)) return true;
  const install = t('Install VS Code Speech');
  const pick = await vscode.window.showInformationMessage(
    t('Voice dictation uses the VS Code Speech extension (recognition runs on your machine; the audio is not sent anywhere).'),
    install,
  );
  if (pick !== install) return false;
  await vscode.commands.executeCommand('workbench.extensions.installExtension', SPEECH_EXTENSION);
  return true;
}

/**
 * Dita num editor temporário (o ditado do VS Code só escreve em editor ou terminal): abre um rascunho
 * com o texto que já havia, liga o ditado e espera "Pronto". Devolve o texto, ou undefined se cancelou.
 */
export async function dictate(title: string, initial = '', cwd?: string): Promise<string | undefined> {
  if (!(await ensureSpeech())) return undefined;
  return draft({
    initial: initial ? `${initial.trimEnd()} ` : '',
    message: t('{0}: speak the task in the draft (you can also type or fix it there). Press Escape to pause the dictation.', title),
    sendLabel: t('Use this text'),
    cwd,
    onOpen: async () => {
      try {
        await vscode.commands.executeCommand(DICTATION_START);
      } catch (e) {
        vscode.window.showWarningMessage(t('Could not start voice dictation: {0}', e instanceof Error ? e.message : String(e)));
      }
    },
    onEnd: async () => {
      await vscode.commands.executeCommand(DICTATION_STOP).then(undefined, () => undefined);
      await new Promise(r => setTimeout(r, SETTLE_MS));
    },
  });
}
