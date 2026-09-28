import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { runHeadless } from '../claude/headless';
import type { ClaudeIntegration } from '../claude/integration';
import type { ClaudeService } from '../claude/view';
import type { Controller } from '../controller';
import { t } from '../i18n';
import type { WorktreeView } from '../model';
import { lessonsPrompt, parseLessons, userMessages } from './core';
import type { AutoReviewer } from './reviewer';

const MAX_SESSIONS = 6;

/**
 * Lições da worktree: um Claude sem terminal lê o que você precisou dizer ao agente depois da tarefa
 * (correções, regras), as intervenções e a revisão automática, e propõe o que acrescentar ao
 * CLAUDE.md para os próximos agentes não precisarem das mesmas correções. Nada é gravado sem você ver.
 */
export class Lessons {
  constructor(
    private readonly ctl: Controller,
    private readonly claude: ClaudeService,
    private readonly integration: ClaudeIntegration,
    private readonly reviewer: AutoReviewer,
  ) {}

  async run(w: WorktreeView) {
    const repo = this.ctl.repo;
    if (!repo) return;
    await this.claude.scan();
    const sessions = (this.claude.byWorktree().get(w.path) ?? []).sort((a, b) => b.end - a.end).slice(0, MAX_SESSIONS);
    const msgs = sessions.map(s => {
      try {
        return userMessages(fs.readFileSync(s.file, 'utf8'));
      } catch {
        return [];
      }
    });
    if (!msgs.some(m => m.length > 1)) {
      vscode.window.showInformationMessage(t('No corrections in the Claude sessions of {0}: nothing to learn from yet.', w.branch ?? w.name));
      return;
    }
    const c = this.integration.countersFor(w.path);
    const interventions = c
      ? [
          c.deniedInVsCode ? `${c.deniedInVsCode} permission request(s) denied by the person` : '',
          c.guardBlocks ? `${c.guardBlocks} action(s) blocked by the worktree guard (editing other worktrees, force push, protected branches)` : '',
          c.budgetBlocks ? `${c.budgetBlocks} prompt(s) blocked by the budget` : '',
        ].filter(Boolean)
      : [];
    const file = path.join(w.path, 'CLAUDE.md');
    let claudeMd = '';
    try {
      claudeMd = fs.readFileSync(file, 'utf8');
    } catch {
      // ainda não existe
    }
    const { base } = await this.ctl.base();
    const stat = (await repo.run(['diff', '--stat', `${base}...HEAD`], w.path)).stdout.trim();
    const rec = this.reviewer.recordFor(w.path);
    const prompt = lessonsPrompt({ branch: w.branch ?? w.name, sessions: msgs.reverse(), interventions, review: rec?.issues, claudeMd, diffStat: stat.split(/\r?\n/).slice(-40).join('\n') });
    let parsed: { lessons: string[]; append: string };
    try {
      parsed = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Claude is reading the sessions of {0}…', w.branch ?? w.name) }, async () => {
        const r = await runHeadless(prompt, {
          cwd: w.path,
          bin: this.ctl.cfg().get<string>('claude.headlessCommand', 'claude'),
          model: this.ctl.cfg().get<string>('agents.autoReview.model', '') || undefined,
          timeoutMs: 10 * 60_000,
        });
        return parseLessons(r.text);
      });
    } catch (e) {
      vscode.window.showErrorMessage(t('Could not extract the lessons: {0}', (e as Error).message));
      return;
    }
    if (!parsed.lessons.length || !parsed.append) {
      vscode.window.showInformationMessage(t('Nothing new worth adding to CLAUDE.md from {0}.', w.branch ?? w.name));
      return;
    }
    const md = [`# ${t('Lessons from {0}', w.branch ?? w.name)}`, '', ...parsed.lessons.map(l => `- ${l}`), '', `## ${t('To append to CLAUDE.md')}`, '', parsed.append, ''].join('\n');
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
    await vscode.commands.executeCommand('markdown.showPreview', doc.uri).then(undefined, () => vscode.window.showTextDocument(doc, { preview: true }));
    const append = t('Append to CLAUDE.md of {0}', w.branch ?? w.name);
    const edit = t('Edit before');
    const pick = await vscode.window.showInformationMessage(t('{0} lesson(s) from {1}.', parsed.lessons.length, w.branch ?? w.name), append, edit);
    if (!pick) return;
    let text = parsed.append;
    if (pick === edit) {
      const draft = await vscode.workspace.openTextDocument({ language: 'markdown', content: parsed.append + '\n' });
      await vscode.window.showTextDocument(draft, { preview: false });
      const done = t('Append this text');
      const ok = await vscode.window.showInformationMessage(t('Edit the text in the editor and click "{0}".', done), done);
      if (!ok) return;
      text = draft.getText().trim();
      if (!text) return;
    }
    const sep = claudeMd && !claudeMd.endsWith('\n\n') ? (claudeMd.endsWith('\n') ? '\n' : '\n\n') : '';
    fs.writeFileSync(file, `${claudeMd}${sep}${text}\n`, 'utf8');
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
    vscode.window.showInformationMessage(t('CLAUDE.md of {0} updated: commit it with the branch so the next agents get it.', w.branch ?? w.name));
  }
}
