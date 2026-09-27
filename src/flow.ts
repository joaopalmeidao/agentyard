import * as vscode from 'vscode';
import type { Controller } from './controller';
import { Repo } from './git';

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

const DEFAULT_LABELS: Record<string, string> = {
  develop: 'Dev', dev: 'Dev', development: 'Dev',
  qa: 'QA', test: 'QA', testing: 'QA',
  homolog: 'Homologação', homologacao: 'Homologação', staging: 'Homologação', stage: 'Homologação', hml: 'Homologação', uat: 'Homologação',
  main: 'Produção', master: 'Produção', production: 'Produção', prod: 'Produção', release: 'Produção',
};

/** Estágios em ordem de promoção (dev primeiro). A configuração tem precedência; senão, o que foi salvo pelo assistente. */
export function flowStages(ctl: Controller): FlowStage[] {
  const cfg = ctl.cfg().get<(FlowStage | string)[]>('flow', []);
  const raw = cfg.length ? cfg : ctl.repo ? ctl.ctx.globalState.get<FlowStage[]>(`flow:${ctl.repo.commonDir.toLowerCase()}`, []) : [];
  return raw
    .map(s => (typeof s === 'string' ? { branch: s, label: DEFAULT_LABELS[s.toLowerCase()] ?? s } : { branch: s.branch, label: s.label || DEFAULT_LABELS[s.branch.toLowerCase()] || s.branch }))
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
  const names = (await repo.refs()).filter(r => r.kind === 'head').map(r => r.name);
  const current = flowStages(ctl);
  const guess = ['develop', 'dev', 'qa', 'homolog', 'staging', 'main', 'master'].filter(n => names.includes(n));
  const chosen: FlowStage[] = [];
  const order = ['1º (onde as features entram, ex.: dev)', '2º (ex.: QA)', '3º (ex.: homologação)', '4º (ex.: produção)', '5º', '6º'];
  for (let i = 0; i < order.length; i++) {
    const items: vscode.QuickPickItem[] = [
      ...(i >= 2 ? [{ label: '$(check) Concluir', description: `${chosen.map(s => s.branch).join(' → ')}` }] : []),
      ...(i === 0 && current.length ? [{ label: '$(trash) Remover o fluxo', description: current.map(s => s.branch).join(' → ') }] : []),
      ...names
        .filter(n => !chosen.some(s => s.branch === n))
        .sort((a, b) => Number(guess.includes(b)) - Number(guess.includes(a)))
        .map(n => ({ label: n, description: DEFAULT_LABELS[n.toLowerCase()] ?? '' })),
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: `Fluxo de ambientes: ${chosen.length ? chosen.map(s => s.branch).join(' → ') + ' → ' : ''}?`,
      placeHolder: `Branch do ${order[i]} estágio`,
    });
    if (!pick) return;
    if (pick.label.startsWith('$(check)')) break;
    if (pick.label.startsWith('$(trash)')) {
      await ctl.ctx.globalState.update(`flow:${repo.commonDir.toLowerCase()}`, []);
      ctl.scheduleRefresh(20);
      return;
    }
    const label = await vscode.window.showInputBox({ title: `Nome do estágio "${pick.label}"`, value: DEFAULT_LABELS[pick.label.toLowerCase()] ?? pick.label });
    if (label === undefined) return;
    chosen.push({ branch: pick.label, label: label || pick.label });
  }
  if (chosen.length < 2) return;
  await ctl.ctx.globalState.update(`flow:${repo.commonDir.toLowerCase()}`, chosen);
  const useBase = await vscode.window.showInformationMessage(
    `Fluxo salvo: ${chosen.map(s => `${s.label} (${s.branch})`).join(' → ')}.`,
    { detail: `Novas worktrees e o sync passam a usar ${chosen[0].branch} como base, a menos que worktreeGraph.baseBranch esteja definido.` },
    'Gerar CI de back-merge',
  );
  if (useBase) await vscode.commands.executeCommand('worktreeGraph.generateCiWorkflow');
  ctl.scheduleRefresh(20);
}

/** Promover um estágio para o seguinte: PR/MR (se houver remoto reconhecido) ou merge direto. */
export async function promote(ctl: Controller, from: string, to: string, merge: (s: string, t: string) => Promise<unknown>, analyze: (s: string, t: string) => Promise<unknown>) {
  const label = ctl.requests.label;
  const items: (vscode.QuickPickItem & { v: string })[] = [
    ...(ctl.requests.remote ? [{ label: `Abrir ${label} ${from} → ${to}`, detail: 'Revisão e CI no servidor antes de entrar', v: 'request' }] : []),
    { label: `Analisar o merge ${from} → ${to}`, detail: 'Commits, arquivos e conflitos, sem mexer em nada', v: 'analyze' },
    { label: `Mesclar ${from} em ${to} agora`, detail: 'Merge local; depois é preciso dar push', v: 'merge' },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: `Promover ${from} → ${to}` });
  if (!pick) return;
  if (pick.v === 'analyze') return analyze(from, to);
  if (pick.v === 'merge') return merge(from, to);
  return ctl.requests.publish(from, to);
}
