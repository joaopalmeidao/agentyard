import { execFile } from 'child_process';
import type { Controller } from '../controller';
import { t } from '../i18n';

/** Comando que mostra uma notificação do sistema; o texto vai por variável de ambiente ou argumento, nunca no script. */
export function osNotifyCommand(platform: NodeJS.Platform, title: string, body: string): { file: string; args: string[]; env?: Record<string, string> } | undefined {
  if (platform === 'win32') {
    // AppId do PowerShell: registrado em todo Windows 10/11, então o toast aparece sem instalar nada
    const script = [
      '$ErrorActionPreference="Stop"',
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
      '$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
      '$n = $x.GetElementsByTagName("text")',
      '$n.Item(0).AppendChild($x.CreateTextNode($env:AGENTYARD_TITLE)) > $null',
      '$n.Item(1).AppendChild($x.CreateTextNode($env:AGENTYARD_BODY)) > $null',
      '$id = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"',
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($x))',
    ].join('; ');
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script], env: { AGENTYARD_TITLE: title, AGENTYARD_BODY: body } };
  }
  if (platform === 'darwin') {
    return { file: 'osascript', args: ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body] };
  }
  if (platform === 'linux') return { file: 'notify-send', args: ['--app-name=AgentYard', title, body] };
  return undefined;
}

/**
 * Notificação do sistema operacional, para quando o VS Code está sem foco (a notificação do VS Code
 * só aparece dentro da janela). `worktreeGraph.claude.osNotify` desliga.
 */
export function osNotify(ctl: Controller, title: string, body: string) {
  if (!ctl.cfg().get<boolean>('claude.osNotify', true)) return;
  const c = osNotifyCommand(process.platform, title, body.slice(0, 300));
  if (!c) return;
  execFile(c.file, c.args, { windowsHide: true, timeout: 15_000, env: { ...process.env, ...c.env } }, err => {
    if (err) ctl.log(t('System notification failed: {0}', err.message));
  });
}
