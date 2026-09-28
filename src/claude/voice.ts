import * as vscode from 'vscode';
import { AgentTerminals, OpenAgent } from '../agents';
import { openAgentOf } from '../agentsView';
import type { Controller } from '../controller';
import { t } from '../i18n';
import { pickClaude, worktreeOfFile } from './sendContext';

/** Extensão que dá ao VS Code o reconhecimento de voz (roda local, sem mandar o áudio para fora). */
export const SPEECH_EXTENSION = 'ms-vscode.vscode-speech';
const START = 'workbench.action.terminal.startVoice';
const STOP = 'workbench.action.terminal.stopVoice';
/** Depois de parar o ditado, o VS Code ainda escreve o fim da frase no terminal; o Enter vem depois. */
const SUBMIT_DELAY_MS = 400;

/**
 * Comandos de voz para o Claude: "Falar com o Claude" foca o terminal do Claude da worktree e liga
 * o ditado do VS Code nele (extensão VS Code Speech); o mesmo atalho de novo para o ditado e aperta
 * Enter, enviando a mensagem (`worktreeGraph.claude.voiceSubmit`).
 */
export function registerClaudeVoice(ctx: vscode.ExtensionContext, ctl: Controller, agentTerms: AgentTerminals) {
  /** Terminal ativo se for um Claude; senão o da worktree do arquivo aberto, ou desta janela. */
  const target = async (node?: unknown): Promise<OpenAgent | undefined> => {
    const fromView = openAgentOf(node);
    if (fromView) return fromView;
    const active = vscode.window.activeTerminal && agentTerms.byTerminal(vscode.window.activeTerminal);
    if (active?.claude && active.terminal.exitStatus === undefined) return active;
    const file = vscode.window.activeTextEditor?.document.uri;
    const wt = (file?.scheme === 'file' && worktreeOfFile(ctl, file.fsPath)) || ctl.state?.worktrees.find(w => w.isCurrent);
    return pickClaude(ctl, agentTerms, wt, t('Talk to which Claude?'));
  };

  /** Sem a VS Code Speech não há ditado: oferece instalar ou escrever a mensagem. */
  const ensureSpeech = async (o: OpenAgent): Promise<boolean> => {
    if (vscode.extensions.getExtension(SPEECH_EXTENSION)) return true;
    const install = t('Install VS Code Speech');
    const typeIt = t('Type instead');
    const pick = await vscode.window.showInformationMessage(
      t('Voice dictation uses the VS Code Speech extension (recognition runs on your machine; the audio is not sent anywhere).'),
      install,
      typeIt,
    );
    if (pick === install) {
      await vscode.commands.executeCommand('workbench.extensions.installExtension', SPEECH_EXTENSION);
      return true;
    }
    if (pick === typeIt) {
      const text = await vscode.window.showInputBox({ prompt: t('Message to {0}', o.terminal.name), ignoreFocusOut: true });
      if (text?.trim()) await agentTerms.type(o, text, true);
    }
    return false;
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand('worktreeGraph.claude.voice', async (node?: unknown) => {
      const o = await target(node);
      if (!o || !(await agentTerms.confirmIfWaiting(o)) || !(await ensureSpeech(o))) return;
      o.terminal.show(false);
      try {
        await vscode.commands.executeCommand(START);
      } catch (e) {
        vscode.window.showWarningMessage(t('Could not start voice dictation: {0}', e instanceof Error ? e.message : String(e)));
      }
    }),
    vscode.commands.registerCommand('worktreeGraph.claude.voiceStop', async () => {
      await vscode.commands.executeCommand(STOP);
      const term = vscode.window.activeTerminal;
      const o = term && agentTerms.byTerminal(term);
      if (!o?.claude || !ctl.cfg().get<boolean>('claude.voiceSubmit', true)) return;
      setTimeout(() => o.terminal.exitStatus === undefined && o.terminal.sendText('', true), SUBMIT_DELAY_MS);
    }),
  );
}
