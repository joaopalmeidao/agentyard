import * as vscode from 'vscode';
import type { AgentTerminals } from '../agents';
import type { AgentFlow } from '../agentFlow/register';
import { keyOf } from '../agentFlow/head';
import type { ReadyInfo } from '../agentFlow/watch';
import type { ClaudeBridge } from '../bridge/register';
import { runHeadless } from '../claude/headless';
import type { ClaudeIntegration } from '../claude/integration';
import type { Controller } from '../controller';
import { t } from '../i18n';
import { parseReview, reviewFeedback, reviewPrompt } from './core';

export type AutoReviewMode = 'off' | 'ready';

export interface ReviewRecord {
  at: number;
  head: string;
  round: number;
  ok: boolean;
  summary: string;
  issues: string[];
  costUsd?: number;
}

/**
 * Revisor automático: quando o agente termina e a worktree vai virar "pronta para revisar", outro
 * Claude, sem terminal (`claude -p`), revisa o diff contra a base. Achou problemas: eles voltam para o
 * Claude da worktree (pela ferramenta MCP `auto_review`) e o "pronto" espera a próxima rodada, até
 * `agents.autoReview.maxRounds`. Sem problemas (ou sem rodadas), a notificação de pronto traz o parecer.
 */
export class AutoReviewer implements vscode.Disposable {
  private readonly records = new Map<string, ReviewRecord>();
  /** Rodadas desde que o agente foi aberto na worktree. */
  private readonly rounds = new Map<string, number>();
  private readonly running = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly ctl: Controller,
    bridge: ClaudeBridge,
    private readonly integration: ClaudeIntegration,
    private readonly flow: AgentFlow,
    private readonly agentTerms: AgentTerminals,
  ) {
    flow.watch.gates.push(info => this.gate(info));
    flow.watch.describers.push(p => this.describe(p));
    // agente novo na worktree: as rodadas recomeçam
    this.disposables.push(agentTerms.onDidLaunch(l => !l.project && this.rounds.delete(keyOf(l.path))));
    bridge.addTool('auto_review', async (_args, { cwd, open }) => {
      const w = bridge.worktreeAt(open?.path ?? cwd);
      const r = w && this.records.get(keyOf(w.path));
      if (!r) return 'No automatic review of this worktree yet.';
      if (r.ok) return `Automatic review (round ${r.round}): no problems found. ${r.summary}`;
      return reviewFeedback(r.issues, r.round, this.maxRounds());
    });
  }

  private cfg() {
    return this.ctl.cfg();
  }

  mode(): AutoReviewMode {
    return this.cfg().get<AutoReviewMode>('agents.autoReview', 'off');
  }

  private maxRounds() {
    return Math.max(1, this.cfg().get<number>('agents.autoReview.maxRounds', 2));
  }

  recordFor(p: string): ReviewRecord | undefined {
    return this.records.get(keyOf(p));
  }

  describe(p: string): string | undefined {
    const r = this.recordFor(p);
    if (!r) return undefined;
    return r.ok ? t('automatic review: OK') : t('automatic review: {0} open problem(s)', r.issues.length);
  }

  private async gate(info: ReadyInfo): Promise<boolean> {
    if (this.mode() === 'off' || !info.branch) return true;
    const k = keyOf(info.path);
    if (this.running.has(k)) return false;
    const round = (this.rounds.get(k) ?? 0) + 1;
    const max = this.maxRounds();
    // sem Claude aberto para receber a revisão, ou sem rodadas: não segura
    const canSendBack = round <= max && this.agentTerms.claudeIn(info.path).some(o => o.state !== 'ended');
    const head = (await this.ctl.repo?.revParse('HEAD', info.path)) ?? '';
    const prev = this.records.get(k);
    if (prev && prev.head === head) return prev.ok || !canSendBack;
    if (round > max) return true;
    this.running.add(k);
    let rec: ReviewRecord;
    try {
      rec = await this.review(info, head, round);
    } catch (e) {
      this.ctl.log(t('Automatic review of {0} failed: {1}', info.branch, (e as Error).message));
      return true;
    } finally {
      this.running.delete(k);
    }
    this.records.set(k, rec);
    this.rounds.set(k, round);
    if (rec.ok || !canSendBack) return true;
    const where = info.branch;
    this.ctl.log(t('Automatic review of {0} (round {1}): {2} problem(s); sent back to Claude.', where, round, rec.issues.length));
    const oneLine = `AgentYard's automatic review found ${rec.issues.length} problem(s) in this branch. Read them with the agentyard auto_review tool, fix the real ones, commit and finish.`;
    await this.integration.sendTask(info.path, info.branch, oneLine, reviewFeedback(rec.issues, round, max));
    return false;
  }

  private async review(info: ReadyInfo, head: string, round: number): Promise<ReviewRecord> {
    const repo = this.ctl.repo!;
    const s = this.ctl.state;
    const w = s?.worktrees.find(x => keyOf(x.path) === keyOf(info.path));
    // branch empilhada: compara com o pai, não com a base
    const base = w?.stack?.parent ?? s?.baseRef ?? (await this.ctl.base()).base;
    const mb = (await repo.run(['merge-base', base, 'HEAD'], info.path)).stdout.trim() || base;
    const [diff, log] = await Promise.all([repo.run(['diff', '--no-color', `${mb}..HEAD`], info.path), repo.run(['log', '--format=%s', `${mb}..HEAD`], info.path)]);
    const task = this.flow.tasks.queue(info.path)?.tasks.find(x => x.status === 'running')?.text;
    const prompt = reviewPrompt({
      branch: info.branch ?? '',
      base,
      task,
      subjects: log.stdout.split(/\r?\n/).filter(Boolean),
      diff: diff.stdout,
      focus: this.cfg().get<string>('agents.autoReview.focus', ''),
    });
    const job = runHeadless(prompt, {
      cwd: info.path,
      bin: this.cfg().get<string>('claude.headlessCommand', 'claude'),
      model: this.cfg().get<string>('agents.autoReview.model', '') || undefined,
      timeoutMs: 10 * 60_000,
    });
    vscode.window.setStatusBarMessage(t('$(sync~spin) Automatic review of {0}…', info.branch ?? ''), job);
    const r = await job;
    const v = parseReview(r.text);
    return { at: Date.now(), head, round, ok: v.ok, summary: v.summary, issues: v.ok ? [] : v.issues, costUsd: r.costUsd };
  }

  /** Mostra o último parecer de uma worktree. */
  async show(p: string) {
    const r = this.recordFor(p);
    if (!r) {
      vscode.window.showInformationMessage(t('No automatic review of this worktree yet.'));
      return;
    }
    const md = [
      `# ${t('Automatic review')} · ${new Date(r.at).toLocaleString()}`,
      '',
      `- ${t('Round')}: ${r.round}`,
      `- ${t('Verdict')}: ${r.ok ? 'OK' : t('changes requested')}`,
      r.summary ? `- ${r.summary}` : '',
      r.costUsd !== undefined ? `- US$ ${r.costUsd.toFixed(3)}` : '',
      '',
      ...r.issues.map((x, i) => `${i + 1}. ${x}`),
    ].filter((l, i, a) => l !== '' || a[i - 1] !== '');
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md.join('\n') + '\n' });
    await vscode.commands.executeCommand('markdown.showPreview', doc.uri).then(undefined, () => vscode.window.showTextDocument(doc));
  }

  /** Revisa agora, sem esperar o agente terminar (e sem mandar nada de volta). */
  async reviewNow(p: string, branch: string | undefined) {
    const head = (await this.ctl.repo?.revParse('HEAD', p)) ?? '';
    const k = keyOf(p);
    const round = (this.rounds.get(k) ?? 0) + 1;
    const rec = await this.review({ path: p, branch, at: Date.now(), commits: 0 }, head, round);
    this.records.set(k, rec);
    await this.show(p);
  }

  async configure() {
    const cur = this.mode();
    const pick = await vscode.window.showQuickPick(
      [
        { label: t('Review when the agent finishes'), detail: t('Another Claude reviews the diff before the worktree becomes "ready for review"; problems go back to the agent.'), m: 'ready' as AutoReviewMode },
        { label: t('Off'), m: 'off' as AutoReviewMode },
      ].map(i => ({ ...i, description: i.m === cur ? t('current') : undefined })),
      { title: t('Automatic review') },
    );
    if (!pick) return;
    await this.cfg().update('agents.autoReview', pick.m, vscode.ConfigurationTarget.Workspace);
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
  }
}
