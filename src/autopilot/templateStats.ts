import * as vscode from 'vscode';
import type { AgentFlow } from '../agentFlow/register';
import { keyOf } from '../agentFlow/head';
import type { ClaudeIntegration } from '../claude/integration';
import type { Controller } from '../controller';
import { t } from '../i18n';
import type { TemplateService } from '../templates/register';
import { TemplateRun, templateStats } from './core';
import type { AutoReviewer } from './reviewer';

const MAX_RUNS = 300;

/**
 * Qualidade por modelo de tarefa: cada vez que um modelo vai para um agente, guarda os contadores da
 * worktree; quando o agente termina, a diferença (turnos, intervenções, tokens, rodadas da revisão
 * automática e tempo até ficar pronto). O relatório compara os modelos.
 */
export class TemplateStats implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly ctl: Controller,
    templates: TemplateService,
    flow: AgentFlow,
    private readonly integration: ClaudeIntegration,
    private readonly reviewer: AutoReviewer,
  ) {
    this.disposables.push(
      templates.onDidSend(e => void this.started(e.template, e.path, e.branch)),
      flow.watch.onDidFinish(f => void this.finished(f.path, f.ready)),
    );
  }

  private storeKey() {
    return `autopilot.templateRuns:${this.ctl.repo?.commonDir.toLowerCase() ?? ''}`;
  }

  runs(): TemplateRun[] {
    return this.ctl.ctx.workspaceState.get<TemplateRun[]>(this.storeKey(), []);
  }

  private async save(runs: TemplateRun[]) {
    await this.ctl.ctx.workspaceState.update(this.storeKey(), runs.slice(-MAX_RUNS));
  }

  private counters(p: string) {
    const c = this.integration.countersFor(p);
    const w = this.ctl.state?.worktrees.find(x => keyOf(x.path) === keyOf(p));
    const turns = this.integration
      .logsFor(p)
      .flatMap(l => l.turns)
      .filter(x => x.end).length;
    return { interventions: (c?.permissions ?? 0) + (c?.guardBlocks ?? 0), tokens: w?.claude?.tokens ?? 0, turns };
  }

  private async started(template: string, p: string, branch?: string) {
    const runs = this.runs();
    runs.push({ template, path: p, branch, at: Date.now(), start: this.counters(p) });
    await this.save(runs);
  }

  private async finished(p: string, ready: boolean) {
    const runs = this.runs();
    const r = [...runs].reverse().find(x => !x.finished && keyOf(x.path) === keyOf(p));
    if (!r) return;
    const now = this.counters(p);
    r.finished = Date.now();
    r.ready = ready;
    r.turns = Math.max(0, now.turns - (r.start?.turns ?? 0));
    r.interventions = Math.max(0, now.interventions - (r.start?.interventions ?? 0));
    r.tokens = Math.max(0, now.tokens - (r.start?.tokens ?? 0)) || undefined;
    r.reviewRounds = this.reviewer.recordFor(p)?.round;
    delete r.start;
    await this.save(runs);
  }

  async report() {
    const stats = templateStats(this.runs());
    const n = (x: number | undefined, d = 1) => (x === undefined ? '—' : x.toFixed(d));
    const k = (x: number | undefined) => (x === undefined ? '—' : x >= 1e6 ? `${(x / 1e6).toFixed(1)} M` : x >= 1e3 ? `${(x / 1e3).toFixed(0)} k` : x.toFixed(0));
    const md = [
      `# ${t('Task templates: how well they work')}`,
      '',
      stats.length
        ? [
            `| ${[t('Template'), t('Runs'), t('Ready'), t('Minutes'), t('Turns'), t('Interventions'), t('Tokens'), t('Review rounds')].join(' | ')} |`,
            `|${' --- |'.repeat(8)}`,
            ...stats.map(s => `| ${[s.template, s.runs, `${s.ready}/${s.finished}`, n(s.avgMinutes, 0), n(s.avgTurns), n(s.avgInterventions), k(s.avgTokens), n(s.avgReviewRounds)].join(' | ')} |`),
          ].join('\n')
        : t('No template sent to an agent yet. Use "✦ Use Task Template…" on a worktree.'),
      '',
      t('Averages of the runs that became ready. Fewer turns, interventions and review rounds mean the template gives the agent what it needs; rewrite the ones at the bottom (Edit Task Template…).'),
      '',
    ].join('\n');
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
    await vscode.commands.executeCommand('markdown.showPreview', doc.uri).then(undefined, () => vscode.window.showTextDocument(doc));
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
  }
}
