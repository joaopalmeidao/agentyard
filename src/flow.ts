import * as vscode from 'vscode';
import type { Controller } from './controller';
import { Repo } from './git';
import { t } from './i18n';
import { branchNames } from './promotion/core';

export interface FlowStage {
  branch: string;
  /** Nome de exibição: "Dev", "QA", "Homologação", "Produção". */
  label: string;
}

export interface FlowStep {
  from: FlowStage;
  to: FlowStage;
  /** Commits de `from` esperando promoção para `to`. */
  pending: number;
  /** Commits em `to` que `from` não tem (hotfix feito direto no estágio seguinte). */
  hotfix: number;
  fromExists: boolean;
  toExists: boolean;
  fromDate: number;
  toDate: number;
}

const DEFAULT_STAGES: Record<string, 'dev' | 'qa' | 'staging' | 'prod'> = {
  develop: 'dev', dev: 'dev', development: 'dev',
  qa: 'qa', test: 'qa', testing: 'qa',
  homolog: 'staging', homologacao: 'staging', staging: 'staging', stage: 'staging', hml: 'staging', uat: 'staging',
  main: 'prod', master: 'prod', production: 'prod', prod: 'prod', release: 'prod',
};

/** Nome de exibição padrão do estágio pela branch (traduzido na hora, não no carregamento do módulo). */
function defaultLabel(branch: string): string | undefined {
  const kind = DEFAULT_STAGES[branch.toLowerCase()];
  return kind && { dev: 'Dev', qa: 'QA', staging: t('Staging'), prod: t('Production') }[kind];
}

/** Estágios em ordem de promoção (dev primeiro). A configuração tem precedência; senão, o que foi salvo pelo assistente. */
export function flowStages(ctl: Controller): FlowStage[] {
  const cfg = ctl.cfg().get<(FlowStage | string)[]>('flow', []);
  const raw = cfg.length ? cfg : ctl.repo ? ctl.ctx.globalState.get<FlowStage[]>(`flow:${ctl.repo.commonDir.toLowerCase()}`, []) : [];
  return raw
    .map(s => (typeof s === 'string' ? { branch: s, label: defaultLabel(s) ?? s } : { branch: s.branch, label: s.label || defaultLabel(s.branch) || s.branch }))
    .filter(s => s.branch);
}

export async function computeFlow(repo: Repo, stages: FlowStage[], refs: { name: string; kind: string; date: number }[]): Promise<FlowStep[]> {
  const local = new Map(refs.filter(r => r.kind === 'head').map(r => [r.name, r]));
  const steps: FlowStep[] = [];
  for (let i = 0; i + 1 < stages.length; i++) {
    const from = stages[i];
    const to = stages[i + 1];
    const fe = local.has(from.branch);
    const te = local.has(to.branch);
    const [hotfix, pending] = fe && te ? await repo.aheadBehind(to.branch, from.branch) : [0, 0];
    steps.push({ from, to, pending, hotfix, fromExists: fe, toExists: te, fromDate: local.get(from.branch)?.date ?? 0, toDate: local.get(to.branch)?.date ?? 0 });
  }
  return steps;
}

/** Assistente: escolher as branches do fluxo, em ordem. */
export async function configureFlow(ctl: Controller) {
  const repo = ctl.repo;
  if (!repo) return;
  // locais e as do remoto (qa/hml/prd muitas vezes só existem lá)
  const names = await branchNames(repo, ctl.cfg().get<string>('remote', 'origin'));
  const current = flowStages(ctl);
  const guess = ['develop', 'dev', 'qa', 'homolog', 'hml', 'staging', 'prd', 'prod', 'production', 'main', 'master'].filter(n => names.includes(n));
  const chosen: FlowStage[] = [];
  const order = [
    t('Branch for the 1st stage (where features land, e.g. dev)'),
    t('Branch for the 2nd stage (e.g. QA)'),
    t('Branch for the 3rd stage (e.g. staging)'),
    t('Branch for the 4th stage (e.g. production)'),
    t('Branch for the 5th stage'),
    t('Branch for the 6th stage'),
  ];
  for (let i = 0; i < order.length; i++) {
    const items: vscode.QuickPickItem[] = [
      ...(i >= 2 ? [{ label: `$(check) ${t('Done')}`, description: `${chosen.map(s => s.branch).join(' → ')}` }] : []),
      ...(i === 0 && current.length ? [{ label: `$(trash) ${t('Remove the flow')}`, description: current.map(s => s.branch).join(' → ') }] : []),
      ...names
        .filter(n => !chosen.some(s => s.branch === n))
        .sort((a, b) => Number(guess.includes(b)) - Number(guess.includes(a)))
        .map(n => ({ label: n, description: defaultLabel(n) ?? '' })),
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: t('Environment flow: {0}?', chosen.length ? chosen.map(s => s.branch).join(' → ') + ' → ' : ''),
      placeHolder: order[i],
    });
    if (!pick) return;
    if (pick.label.startsWith('$(check)')) break;
    if (pick.label.startsWith('$(trash)')) {
      await ctl.ctx.globalState.update(`flow:${repo.commonDir.toLowerCase()}`, []);
      ctl.scheduleRefresh(20);
      return;
    }
    const label = await vscode.window.showInputBox({ title: t('Name of stage "{0}"', pick.label), value: defaultLabel(pick.label) ?? pick.label });
    if (label === undefined) return;
    chosen.push({ branch: pick.label, label: label || pick.label });
  }
  if (chosen.length < 2) return;
  await ctl.ctx.globalState.update(`flow:${repo.commonDir.toLowerCase()}`, chosen);
  const useBase = await vscode.window.showInformationMessage(
    t('Flow saved: {0}.', chosen.map(s => `${s.label} (${s.branch})`).join(' → ')),
    { detail: t('New worktrees and sync now use {0} as the base, unless worktreeGraph.baseBranch is set.', chosen[0].branch) },
    t('Generate back-merge CI'),
  );
  if (useBase) await vscode.commands.executeCommand('worktreeGraph.generateCiWorkflow');
  ctl.scheduleRefresh(20);
}

/** Promover um estágio para o seguinte: PR/MR (se houver remoto reconhecido) ou merge direto. */
export async function promote(ctl: Controller, from: string, to: string, merge: (s: string, target: string) => Promise<unknown>, analyze: (s: string, target: string) => Promise<unknown>) {
  const label = ctl.requests.label;
  const items: (vscode.QuickPickItem & { v: string })[] = [
    ...(ctl.requests.remote ? [{ label: t('Open {0} {1} → {2}', label, from, to), detail: t('Review and CI on the server before it goes in'), v: 'request' }] : []),
    { label: t('Analyze the merge {0} → {1}', from, to), detail: t('Commits, files and conflicts, without touching anything'), v: 'analyze' },
    { label: t('Merge {0} into {1} now', from, to), detail: t('Local merge; you need to push afterwards'), v: 'merge' },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: t('Promote {0} → {1}', from, to) });
  if (!pick) return;
  if (pick.v === 'analyze') return analyze(from, to);
  if (pick.v === 'merge') return merge(from, to);
  return ctl.requests.publish(from, to);
}
