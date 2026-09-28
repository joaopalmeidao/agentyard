import * as path from 'path';
import * as vscode from 'vscode';
import { t } from '../i18n';
import { hooksDisabled, listMcpjsonServers, listPlugins, setHooksDisabled, setMcpjsonServer, setPlugin } from './config';
import type { ClaudeConfigService } from './configView';

const PREFIX = 'worktreeGraph.';

interface Feature extends vscode.QuickPickItem {
  on: boolean;
  apply(on: boolean): unknown;
}

/** Primeira frase da descrição de uma configuração, sem markdown, para caber numa linha. */
export function shortDescription(text: string, max = 80): string {
  const plain = text
    .replace(/`#?([^`#]+)#?`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const first = /^(.+?[.:;])(\s|$)/.exec(plain)?.[1] ?? plain;
  return first.length > max ? `${first.slice(0, max - 1)}…` : first.replace(/[.:;]$/, '');
}

/** Todas as opções liga/desliga da extensão, lidas do package.json (nenhuma fica de fora). */
function extensionFeatures(ctx: vscode.ExtensionContext): Feature[] {
  const conf = ctx.extension.packageJSON?.contributes?.configuration;
  const sections: { properties?: Record<string, any> }[] = Array.isArray(conf) ? conf : conf ? [conf] : [];
  const cfg = vscode.workspace.getConfiguration();
  const out: Feature[] = [];
  for (const s of sections) {
    for (const [key, p] of Object.entries(s.properties ?? {})) {
      if (p.type !== 'boolean' || key === `${PREFIX}claude.mcp`) continue;
      const text = String(p.markdownDescription ?? p.description ?? '');
      const inWorkspace = cfg.inspect(key)?.workspaceValue !== undefined;
      out.push({
        label: text && !text.startsWith('%') ? shortDescription(text) : key.slice(PREFIX.length),
        description: key.slice(PREFIX.length) + (inWorkspace ? ` · ${t('workspace')}` : ''),
        on: cfg.get<boolean>(key, p.default === true),
        apply: on => cfg.update(key, on, inWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global),
      });
    }
  }
  return out.sort((a, b) => String(a.description).localeCompare(String(b.description)));
}

/**
 * "Ligar/desligar recursos": uma lista com caixas de seleção de tudo que dá para ligar e desligar —
 * aprender com o uso, hooks do usuário, servidores MCP (o do AgentYard e os do .mcp.json), plugins
 * do Claude e todas as opções liga/desliga do AgentYard. Aplica só o que mudou.
 */
export async function featuresMenu(ctx: vscode.ExtensionContext, svc: ClaudeConfigService) {
  const dir = svc.claudeDir();
  const proj = svc.projectDir();
  const userSettings = path.join(dir, 'settings.json');
  const cfg = vscode.workspace.getConfiguration('worktreeGraph');
  const sep = (label: string) => ({ label, kind: vscode.QuickPickItemKind.Separator }) as Feature;

  const claude: Feature[] = [
    {
      label: '$(mortar-board) ' + t('Learn from use'),
      description: t('memories and skills saved by Claude itself (user CLAUDE.md)'),
      on: svc.learningOn(),
      apply: on => svc.setLearning(on),
    },
    {
      label: '$(zap) ' + t('Your Claude Code hooks'),
      description: t('disableAllHooks in {0}', userSettings.replace(dir, '~/.claude')),
      on: !hooksDisabled(userSettings),
      apply: on => setHooksDisabled(userSettings, !on),
    },
  ];
  const mcp: Feature[] = [
    {
      label: '$(plug) agentyard',
      description: t('AgentYard MCP tools (status, overlaps, mark_ready…)'),
      on: cfg.get<boolean>('claude.mcp', true),
      apply: on => cfg.update('claude.mcp', on, vscode.ConfigurationTarget.Global),
    },
    ...(proj
      ? listMcpjsonServers(proj).map(s => ({
          label: '$(plug) ' + s.name,
          description: t('.mcp.json of the project · only for you (settings.local.json)'),
          on: s.on,
          apply: (on: boolean) => setMcpjsonServer(proj, s.name, on),
        }))
      : []),
  ];
  const pluginFiles = [userSettings, ...(proj ? [path.join(proj, '.claude', 'settings.json')] : [])];
  const plugins: Feature[] = pluginFiles.flatMap(f =>
    listPlugins(f).map(p => ({
      label: '$(extensions) ' + p.name,
      description: f === userSettings ? t('user') : t('project'),
      on: p.on,
      apply: (on: boolean) => setPlugin(f, p.name, on),
    })),
  );
  const ext = extensionFeatures(ctx);

  const items: Feature[] = [
    sep('Claude Code'),
    ...claude,
    sep(t('MCP servers')),
    ...mcp,
    ...(plugins.length ? [sep(t('Claude plugins')), ...plugins] : []),
    sep('AgentYard'),
    ...ext,
  ];
  const qp = vscode.window.createQuickPick<Feature>();
  qp.title = t('Turn features on and off');
  qp.placeholder = t('Checked = on. Type to filter; Enter applies (new Claude sessions pick up Claude changes).');
  qp.canSelectMany = true;
  qp.matchOnDescription = true;
  qp.items = items;
  qp.selectedItems = items.filter(i => i.kind !== vscode.QuickPickItemKind.Separator && i.on);
  const chosen = await new Promise<readonly Feature[] | undefined>(resolve => {
    let done = false;
    qp.onDidAccept(() => {
      done = true;
      resolve(qp.selectedItems);
      qp.hide();
    });
    qp.onDidHide(() => {
      if (!done) resolve(undefined);
      qp.dispose();
    });
    qp.show();
  });
  if (!chosen) return;
  const picked = new Set(chosen);
  const changed = items.filter(i => i.kind !== vscode.QuickPickItemKind.Separator && picked.has(i) !== i.on);
  const errors: string[] = [];
  for (const f of changed) {
    try {
      await f.apply(!f.on);
    } catch (e) {
      errors.push(`${f.label}: ${(e as Error).message}`);
    }
  }
  svc.refresh();
  if (errors.length) vscode.window.showErrorMessage(errors.join('\n'));
  else if (changed.length) {
    const on = changed.filter(f => !f.on).length;
    vscode.window.showInformationMessage(t('{0} feature(s) turned on, {1} turned off.', on, changed.length - on));
  }
}
