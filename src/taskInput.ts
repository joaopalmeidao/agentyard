import * as vscode from 'vscode';
import { t } from './i18n';

/** Extensão que dá ao VS Code o reconhecimento de voz (roda local, sem mandar o áudio para fora). */
export const SPEECH_EXTENSION = 'ms-vscode.vscode-speech';
const DICTATION_START = 'workbench.action.editorDictation.start';
const DICTATION_STOP = 'workbench.action.editorDictation.stop';
/** Depois de parar o ditado, o VS Code ainda escreve o fim da frase no editor. */
const SETTLE_MS = 400;

export interface TaskInputOptions {
  title: string;
  prompt?: string;
  value?: string;
  /** Já começa ditando, sem mostrar a caixa antes. */
  voice?: boolean;
}

/**
 * Pede o texto de uma tarefa como o showInputBox (undefined = cancelou, '' = Enter vazio), com um
 * botão de microfone: a tarefa é ditada (VS Code Speech) e volta para a caixa para revisar e enviar.
 */
export async function askTask(o: TaskInputOptions): Promise<string | undefined> {
  let value = o.value ?? '';
  if (o.voice) {
    const spoken = await dictate(o.title, value);
    if (spoken !== undefined) value = spoken;
  }
  for (;;) {
    const r = await showBox(o, value);
    if (r.kind !== 'voice') return r.value;
    const spoken = await dictate(o.title, r.value);
    value = spoken ?? r.value;
  }
}

type BoxResult = { kind: 'done'; value: string | undefined } | { kind: 'voice'; value: string };

function showBox(o: TaskInputOptions, value: string): Promise<BoxResult> {
  return new Promise(resolve => {
    const box = vscode.window.createInputBox();
    const mic: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('mic'), tooltip: t('Dictate the task (VS Code Speech)') };
    let result: BoxResult = { kind: 'done', value: undefined };
    box.title = o.title;
    box.prompt = o.prompt;
    box.value = value;
    box.ignoreFocusOut = true;
    box.buttons = [mic];
    box.onDidTriggerButton(() => {
      result = { kind: 'voice', value: box.value };
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
export async function dictate(title: string, initial = ''): Promise<string | undefined> {
  if (!(await ensureSpeech())) return undefined;
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: initial ? `${initial.trimEnd()} ` : '' });
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const end = doc.lineAt(doc.lineCount - 1).range.end;
  editor.selection = new vscode.Selection(end, end);
  try {
    await vscode.commands.executeCommand(DICTATION_START);
  } catch (e) {
    vscode.window.showWarningMessage(t('Could not start voice dictation: {0}', e instanceof Error ? e.message : String(e)));
  }
  const done = t('Use this text');
  const closed = new Promise<undefined>(resolve => {
    const sub = vscode.workspace.onDidCloseTextDocument(d => {
      if (d !== doc) return;
      sub.dispose();
      resolve(undefined);
    });
  });
  const answer = await Promise.race([
    vscode.window.showInformationMessage(t('{0}: speak the task in the draft (you can also type or fix it there). Press Escape to pause the dictation.', title), done, t('Cancel')),
    closed,
  ]);
  await vscode.commands.executeCommand(DICTATION_STOP).then(undefined, () => undefined);
  if (doc.isClosed) return undefined;
  await new Promise(r => setTimeout(r, SETTLE_MS));
  const text = doc.getText().trim();
  await vscode.window.showTextDocument(doc, { preview: false });
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  return answer === done ? text : undefined;
}
