import * as path from 'path';
import { t } from '../i18n';

/** Linha curta que descreve o pedido de permissão (notificação e barra de status). */
export function describeToolRequest(tool: string | undefined, input: Record<string, unknown> | undefined): string {
  const ti = input ?? {};
  const one = (s: unknown, max = 160) => {
    const x = String(s ?? '').replace(/\s+/g, ' ').trim();
    return x.length > max ? `${x.slice(0, max - 1)}…` : x;
  };
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return `${tool}: ${one(ti.command)}`;
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      return `${tool}: ${one(path.basename(String(ti.file_path ?? ti.notebook_path ?? '')))}`;
    case 'WebFetch':
      return `WebFetch: ${one(ti.url)}`;
    case 'WebSearch':
      return `WebSearch: ${one(ti.query)}`;
    case 'ExitPlanMode':
      return t('approve the plan');
  }
  if (tool?.startsWith('mcp__')) return tool.split('__').slice(1).join(' · ');
  return tool ?? '?';
}
