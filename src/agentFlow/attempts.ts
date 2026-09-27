import { exec } from 'child_process';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import * as actions from '../actions';
import type { AgentTerminals } from '../agents';
import type { Controller } from '../controller';
import { gitUri } from '../diff';
import { locale, t } from '../i18n';

/** Um grupo de tentativas da mesma tarefa, cada uma numa worktree `try/<slug>-a`, `-b`… */
export interface AttemptGroup {
  id: string;
  title: string;
  prompt: string;
  base: string;
  created: number;
  attempts: { letter: string; branch: string; path: string; variation: string }[];
}

function defaultVariations(): string[] {
  return [
    '',
    t('Favor the simplest possible solution, with as little new code as possible.'),
    t('Favor performance and robustness, even if the code gets bigger.'),
    t('Favor test coverage: write the tests before the implementation.'),
    t('Follow the patterns already in the code as closely as possible, with no new abstractions.'),
  ];
}

export function slugify(s: string) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 5)
    .join('-') || 'tarefa';
}

export interface TryOptions {
  title?: string;
  prompt?: string;
  n?: number;
  variations?: string[];
  /** Sem perguntas (testes e chamadas programáticas). */
  quiet?: boolean;
}

export class Attempts {
  constructor(private readonly ctl: Controller, private readonly agentTerms: AgentTerminals) {}

  private storeKey() {
    return `agentFlow.attempts:${this.ctl.repo?.commonDir.toLowerCase() ?? ''}`;
  }

  groups(): AttemptGroup[] {
    return this.ctl.ctx.workspaceState.get<AttemptGroup[]>(this.storeKey(), []);
  }

  private async saveGroup(g: AttemptGroup) {
    await this.ctl.ctx.workspaceState.update(this.storeKey(), [g, ...this.groups().filter(x => x.id !== g.id)].slice(0, 20));
  }

  /** Cria N worktrees a partir da base e abre um agente em cada, com a mesma tarefa e uma variação. */
  async tryApproaches(o: TryOptions = {}): Promise<AttemptGroup | undefined> {
    const repo = this.ctl.repo;
    if (!repo) return undefined;
    const { base } = await this.ctl.base();
    let prompt = o.prompt;
    if (!prompt) {
      prompt = await vscode.window.showInputBox({ title: t('Try several approaches'), prompt: t('The task all the agents will get'), ignoreFocusOut: true });
      if (!prompt?.trim()) return undefined;
    }
    const title = o.title ?? prompt.split(/\r?\n/)[0].slice(0, 60);
    let n = o.n;
    if (!n) {
      const pick = await vscode.window.showQuickPick(['2', '3', '4', '5'].map(l => ({ label: l, description: t('{0} worktrees and {0} agents in parallel', l) })), {
        title: t('How many approaches for "{0}"?', title),
      });
      if (!pick) return undefined;
      n = Number(pick.label);
    }
    const letters = 'abcdefgh'.slice(0, n).split('');
    const variations: string[] = [];
    const defaults = defaultVariations();
    for (let i = 0; i < n; i++) {
      const def = o.variations?.[i] ?? defaults[i] ?? '';
      if (o.quiet || o.variations) {
        variations.push(def);
        continue;
      }
      const v = await vscode.window.showInputBox({
        title: t('Approach {0} ({1}/{2})', letters[i].toUpperCase(), i + 1, n),
        prompt: t('Extra guidance just for this attempt (empty = just the task)'),
        value: def,
        ignoreFocusOut: true,
      });
      if (v === undefined) return undefined;
      variations.push(v.trim());
    }

    const slug = slugify(title);
    const existing = new Set((await repo.refs()).filter(r => r.kind === 'head').map(r => r.name));
    let prefix = `try/${slug}`;
    for (let k = 2; letters.some(l => existing.has(`${prefix}-${l}`)); k++) prefix = `try/${slug}-${k}`;

    const group: AttemptGroup = { id: crypto.randomBytes(4).toString('hex'), title, prompt, base, created: Date.now(), attempts: [] };
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Creating {0} attempts…', n) }, async progress => {
      for (let i = 0; i < n!; i++) {
        const branch = `${prefix}-${letters[i]}`;
        progress.report({ message: branch, increment: 100 / n! });
        const dir = await actions.createWorktree(this.ctl, { branch, startPoint: base, quiet: true });
        if (!dir) continue;
        group.attempts.push({ letter: letters[i].toUpperCase(), branch, path: dir, variation: variations[i] });
      }
    });
    if (!group.attempts.length) return undefined;
    await this.saveGroup(group);
    for (const a of group.attempts) {
      const text = a.variation ? `${prompt}\n\n${t('Approach {0}: {1}', a.letter, a.variation)}` : prompt;
      await this.agentTerms.launchWithPrompt(a.path, a.branch, text);
    }
    this.ctl.scheduleRefresh(50);
    await ComparePanel.show(this.ctl, group, this);
    return group;
  }

  async pickAndCompare() {
    const gs = this.groups();
    if (!gs.length) {
      vscode.window.showInformationMessage(t('No attempt groups yet. Use "Try N Approaches…".'));
      return;
    }
    const pick = await vscode.window.showQuickPick(
      gs.map(g => ({ label: g.title, description: t('{0} attempts · {1}', g.attempts.length, new Date(g.created).toLocaleString(locale())), g })),
      { title: t('Compare attempts') },
    );
    if (pick) await ComparePanel.show(this.ctl, pick.g, this);
  }

  async forget(id: string) {
    await this.ctl.ctx.workspaceState.update(this.storeKey(), this.groups().filter(g => g.id !== id));
  }
}

interface AttemptStats {
  commits: number;
  files: number;
  added: number;
  deleted: number;
  changes: number;
  tokens?: number;
  exists: boolean;
  test?: { ok: boolean; at: number; tail: string } | 'running';
}

/** Painel "Comparar tentativas": uma coluna por tentativa, com números e ações. */
export class ComparePanel {
  private static readonly open = new Map<string, ComparePanel>();
  private readonly tests = new Map<string, AttemptStats['test']>();

  static async show(ctl: Controller, g: AttemptGroup, attempts: Attempts) {
    const cur = ComparePanel.open.get(g.id);
    if (cur) {
      cur.panel.reveal();
      await cur.load();
      return cur;
    }
    const panel = vscode.window.createWebviewPanel('worktreeGraph.attempts', t('Attempts: {0}', g.title), vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(ctl.ctx.extensionUri, 'media')],
    });
    const p = new ComparePanel(panel, ctl, g, attempts);
    ComparePanel.open.set(g.id, p);
    panel.onDidDispose(() => ComparePanel.open.delete(g.id));
    await p.load();
    return p;
  }

  private constructor(readonly panel: vscode.WebviewPanel, private readonly ctl: Controller, private readonly g: AttemptGroup, private readonly attempts: Attempts) {
    panel.iconPath = vscode.Uri.joinPath(ctl.ctx.extensionUri, 'media', 'icon.svg');
    panel.webview.onDidReceiveMessage(m => this.onMessage(m));
  }

  private async stats(): Promise<Map<string, AttemptStats>> {
    const repo = this.ctl.repo!;
    const wts = await repo.worktreesFast();
    const out = new Map<string, AttemptStats>();
    await Promise.all(
      this.g.attempts.map(async a => {
        const exists = wts.some(w => w.branch === a.branch && !w.prunable);
        const s: AttemptStats = { commits: 0, files: 0, added: 0, deleted: 0, changes: 0, exists, test: this.tests.get(a.branch) };
        if (exists) {
          const [c, num, st] = await Promise.all([
            repo.run(['rev-list', '--count', `${this.g.base}..${a.branch}`]),
            repo.run(['diff', '--numstat', `${this.g.base}...${a.branch}`]),
            repo.status(a.path),
          ]);
          s.commits = Number(c.stdout.trim()) || 0;
          for (const l of num.stdout.split(/\r?\n/).filter(Boolean)) {
            const [ad, de] = l.split('\t');
            s.files++;
            s.added += Number(ad) || 0;
            s.deleted += Number(de) || 0;
          }
          s.changes = st.changes;
          s.tokens = this.ctl.state?.worktrees.find(w => w.branch === a.branch)?.claude?.tokens;
        }
        out.set(a.branch, s);
      }),
    );
    return out;
  }

  async load() {
    const stats = await this.stats();
    this.panel.webview.html = this.html(stats);
  }

  private async onMessage(m: { action: string; branch?: string }) {
    const a = this.g.attempts.find(x => x.branch === m.branch);
    const repo = this.ctl.repo!;
    switch (m.action) {
      case 'refresh':
        return this.load();
      case 'terminal':
        if (a) vscode.window.createTerminal({ name: a.branch, cwd: a.path }).show();
        return;
      case 'review':
        if (a) await actions.diffWithBase(this.ctl, a.branch);
        return;
      case 'test': {
        if (!a) return;
        const cmd = this.ctl.cfg().get<string>('autoSync.testCommand', '').trim();
        if (!cmd) {
          const go = await vscode.window.showWarningMessage(t('Configure worktreeGraph.autoSync.testCommand to run the attempts\' tests.'), t('Open settings'));
          if (go) vscode.commands.executeCommand('workbench.action.openSettings', 'worktreeGraph.autoSync.testCommand');
          return;
        }
        this.tests.set(a.branch, 'running');
        await this.load();
        const res = await new Promise<{ ok: boolean; out: string }>(r =>
          exec(cmd, { cwd: a.path, timeout: 15 * 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, so, se) => r({ ok: !err, out: `${so}${se}` })),
        );
        this.tests.set(a.branch, { ok: res.ok, at: Date.now(), tail: res.out.split(/\r?\n/).slice(-15).join('\n') });
        this.ctl.log(`[${t('attempt {0}', a.branch)}] ${cmd} → ${res.ok ? 'ok' : t('failed')}`);
        return this.load();
      }
      case 'diff': {
        if (!a) return;
        const others = this.g.attempts.filter(x => x.branch !== a.branch);
        const other = others.length === 1 ? others[0] : (await vscode.window.showQuickPick(others.map(o => ({ label: `${o.letter}: ${o.branch}`, o })), { title: t('Compare {0} with…', a.letter) }))?.o;
        if (!other) return;
        const files = (await repo.exec(['diff', '--name-only', other.branch, a.branch])).split(/\r?\n/).filter(Boolean);
        if (!files.length) {
          vscode.window.showInformationMessage(t('{0} and {1} have the same content.', a.branch, other.branch));
          return;
        }
        const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { f: string }>();
        qp.title = t('{0} ↔ {1}: {2} different file(s)', other.letter, a.letter, files.length);
        qp.items = files.map(f => ({ label: f, f }));
        qp.ignoreFocusOut = true;
        qp.onDidAccept(() => {
          const it = qp.selectedItems[0];
          if (it) vscode.commands.executeCommand('vscode.diff', gitUri(repo.root, other.branch, it.f), gitUri(repo.root, a.branch, it.f), `${it.f.split('/').pop()} (${other.letter} ↔ ${a.letter})`, { preview: true, preserveFocus: true });
        });
        qp.onDidHide(() => qp.dispose());
        qp.show();
        return;
      }
      case 'choose': {
        if (!a) return;
        const L = this.ctl.requests.label;
        const pick = await vscode.window.showQuickPick(
          [
            { label: t('Merge {0} into {1}', a.branch, this.g.base), v: 'merge' },
            { label: t('Publish {0} for {1}', L, a.branch), v: 'pr' },
          ],
          { title: t('Choose attempt {0}', a.letter) },
        );
        if (pick?.v === 'merge') await actions.mergeBranches(this.ctl, a.branch, this.g.base);
        if (pick?.v === 'pr') await this.ctl.requests.publish(a.branch, this.g.base);
        if (pick) {
          const others = this.g.attempts.filter(x => x.branch !== a.branch);
          const drop = await vscode.window.showInformationMessage(t('Discard the other {0} attempt(s)?', others.length), t('Discard the others'));
          if (drop) await this.discardOthers(a.branch);
        }
        return this.load();
      }
      case 'discard':
        if (a) await this.discardOthers(a.branch);
        return this.load();
    }
  }

  private async discardOthers(keep: string) {
    await this.ctl.refresh();
    const paths = this.g.attempts.filter(x => x.branch !== keep).map(x => x.path);
    await actions.cleanupWorktrees(this.ctl, paths);
  }

  private html(stats: Map<string, AttemptStats>) {
    const w = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.ctl.ctx.extensionUri, 'media', 'graph.css'));
    const cols = this.g.attempts
      .map(a => {
        const s = stats.get(a.branch)!;
        const test =
          s.test === 'running'
            ? `<span class="chip info">${t('testing…')}</span>`
            : s.test
              ? `<span class="chip ${s.test.ok ? 'ok' : 'bad'}" title="${esc(s.test.tail)}">${s.test.ok ? '✓ ' + t('tests passed') : '✗ ' + t('tests failed')}</span>`
              : `<span class="chip muted">${t('tests not run')}</span>`;
        const b = esc(a.branch);
        return `<div class="card attempt ${s.exists ? '' : 'conflict'}">
          <div class="card-head"><span class="branch">${esc(a.letter)} · ${b}</span></div>
          <div class="last">${a.variation ? esc(a.variation) : `<span class="muted">${t('just the task')}</span>`}</div>
          ${s.exists
            ? `<div class="stats">
                <div><b>${s.commits}</b><span>commits</span></div>
                <div><b>${s.files}</b><span>${t('files')}</span></div>
                <div><b><span class="add">+${s.added}</span> <span class="del">−${s.deleted}</span></b><span>${t('lines')}</span></div>
                <div class="${s.changes ? 'warn' : ''}"><b>${s.changes}</b><span>${t('uncommitted')}</span></div>
                ${s.tokens !== undefined ? `<div><b>${fmt(s.tokens)}</b><span>${t('Claude tokens')}</span></div>` : ''}
              </div>
              <div class="chips">${test}</div>
              <div class="actions">
                <button data-action="review" data-branch="${b}">${t('Review')}</button>
                <button data-action="diff" data-branch="${b}">${t('Diff with another')}</button>
                <button data-action="test" data-branch="${b}">${t('Run tests')}</button>
                <button data-action="terminal" data-branch="${b}">Terminal</button>
                <button data-action="choose" data-branch="${b}" class="primary">${t('Choose this one')}</button>
                <button data-action="discard" data-branch="${b}" class="danger" title="${t('Removes the worktrees of the other attempts')}">${t('Discard the others')}</button>
              </div>`
            : `<div class="muted">${t('worktree removed')}</div>`}
        </div>`;
      })
      .join('');
    return `<!DOCTYPE html><html lang="${locale()}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body class="attempts-page">
<header class="toolbar"><div class="title"><span class="repo">${t('Compare attempts')}</span><span class="muted">${esc(this.g.title)} · ${esc(t('from {0}', this.g.base))}</span></div>
<div class="tools"><button data-action="refresh" title="${t('Refresh numbers')}">↻</button></div></header>
<div class="verdict ok">${esc(this.g.prompt.split(/\r?\n/)[0])}</div>
<div class="cards attempts">${cols}</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (el && !el.disabled) vscode.postMessage({ action: el.dataset.action, branch: el.dataset.branch });
});
</script></body></html>`;
  }
}

const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} k` : String(n));
