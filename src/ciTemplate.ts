import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Controller } from './controller';
import { flowStages } from './flow';
import { t } from './i18n';

export interface CiOptions {
  base: string;
  patterns: string[];
  exclude: string[];
  testCommand: string;
}

/** Um par "base → branches que recebem a base": o sync normal, ou um degrau do back-merge do fluxo. */
export interface SyncPair {
  base: string;
  patterns: string[];
  exclude: string[];
  /** Nome do arquivo/job, sem extensão. */
  name: string;
  description: string;
}

/** O case do sh já deixa "*" atravessar "/", então "**" vira "*". */
const toShPatterns = (list: string[]) => list.map(p => p.replace(/\*\*/g, '*')).join(' ');
const slug = (s: string) => s.replace(/[^\w.-]+/g, '-');

export function buildWorkflow(template: string, o: CiOptions): string {
  const test = o.testCommand.trim()
    ? [
        `      # ${t('Prepare the environment before the check, for example:')}`,
        '      # - uses: actions/setup-node@v4',
        '      #   with: { node-version: 20, cache: npm }',
        '      # - run: npm ci',
        `      - name: ${t('Check')}`,
        '        shell: bash',
        '        run: |',
        ...o.testCommand.split(/\r?\n/).map(l => `          ${l}`),
      ].join('\n')
    : [`      # ${t('No check configured. To run tests before the push, add them here:')}`, `      # - name: ${t('Check')}`, '      #   run: npm test'].join('\n');
  return template
    .replace(/__BASE__/g, o.base)
    .replace(/__PATTERNS__/g, toShPatterns(o.patterns))
    .replace(/__EXCLUDE__/g, toShPatterns(o.exclude))
    .replace('__TEST_STEPS__', test);
}

/** Um job por par, em sh POSIX (roda em alpine, debian, node, python…). */
export function buildGitLabCi(template: string, pairs: SyncPair[], testCommand: string, image: string): string {
  const test = testCommand.trim() ? testCommand.trim().split(/\r?\n/).join(' && ') : 'true';
  const jobs = pairs.map(p =>
    [
      `# ${p.description}`,
      `wtgraph-${slug(p.name)}:`,
      `  # ${t('The "deploy" stage exists by default; if your .gitlab-ci.yml defines "stages:", use one that exists.')}`,
      '  stage: deploy',
      `  image: ${image}`,
      '  rules:',
      `    - if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "${p.base}"'`,
      `    - if: '$CI_PIPELINE_SOURCE == "web" && $CI_COMMIT_BRANCH == "${p.base}"'`,
      '  variables:',
      '    GIT_DEPTH: "0"',
      '    GIT_STRATEGY: clone',
      `    BASE_BRANCH: "${p.base}"`,
      `    BRANCH_PATTERNS: "${toShPatterns(p.patterns)}"`,
      `    EXCLUDE_PATTERNS: "${toShPatterns(p.exclude)}"`,
      '  script:',
      '    - |',
      '      set -eu',
      '      : "${SYNC_TOKEN:?' + t('set the SYNC_TOKEN variable in Settings > CI/CD > Variables') + '}"',
      '      command -v git >/dev/null 2>&1 || apk add --no-cache git',
      '      git config user.name "worktree-graph-sync"',
      '      git config user.email "worktree-graph-sync@${CI_SERVER_HOST}"',
      '      PUSH_URL="${CI_SERVER_PROTOCOL}://oauth2:${SYNC_TOKEN}@${CI_SERVER_HOST}:${CI_SERVER_PORT}/${CI_PROJECT_PATH}.git"',
      "      git fetch --prune origin '+refs/heads/*:refs/remotes/origin/*'",
      '      set -f',
      '      synced=""; failed=""',
      "      for ref in $(git for-each-ref --format='%(refname:lstrip=3)' refs/remotes/origin); do",
      '        [ "$ref" = "HEAD" ] && continue',
      '        [ "$ref" = "$BASE_BRANCH" ] && continue',
      '        match=0',
      '        for p in $BRANCH_PATTERNS; do case "$ref" in $p) match=1 ;; esac; done',
      '        for p in $EXCLUDE_PATTERNS; do case "$ref" in $p) match=0 ;; esac; done',
      '        [ "$match" = 1 ] || continue',
      '        if git merge-base --is-ancestor "origin/$BASE_BRANCH" "origin/$ref"; then continue; fi',
      '        echo "== $ref"',
      '        git checkout -q -B "$ref" "origin/$ref"',
      '        if ! git merge --no-edit -m "Merge $BASE_BRANCH into $ref (auto sync)" "origin/$BASE_BRANCH"; then',
      `          echo "${t('conflict merging {0} into {1}:', '$BASE_BRANCH', '$ref')}"`,
      "          git diff --name-only --diff-filter=U | sed 's/^/  - /'",
      '          git merge --abort; failed="$failed $ref"; continue',
      '        fi',
      `        if ! ( ${test} ); then`,
      `          echo "${t('check failed on {0}; nothing was pushed', '$ref')}"`,
      '          git reset -q --hard "origin/$ref"; failed="$failed $ref"; continue',
      '        fi',
      '        git push -q "$PUSH_URL" "HEAD:refs/heads/$ref"',
      '        synced="$synced $ref"',
      '      done',
      '      echo "' + t('synced:') + '${synced:- ' + t('(none)') + '}"',
      '      if [ -n "$failed" ]; then echo "' + t('with conflicts or failing check:') + '$failed"; exit 1; fi',
    ].join('\n'),
  );
  const desc = pairs.map(p => p.description).join('\n# ');
  return template.replace('__DESCRIPTION__', desc).replace('__JOBS__', jobs.join('\n\n'));
}

function guessImage(test: string): string {
  if (/\b(npm|npx|yarn|pnpm|node)\b/.test(test)) return 'node:20';
  if (/\b(pytest|python|pip|poetry|uv)\b/.test(test)) return 'python:3.12';
  if (/\b(go )/.test(test)) return 'golang:1.22';
  if (/\b(mvn|gradle)\b/.test(test)) return 'eclipse-temurin:21';
  return 'alpine:3.20';
}

async function writeFile(root: string, rel: string, content: string): Promise<boolean> {
  const file = path.join(root, rel);
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== content) {
    const ok = await vscode.window.showWarningMessage(t('{0} already exists.', rel), { modal: true }, t('Overwrite'));
    if (!ok) return false;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return true;
}

export async function generateCiWorkflow(ctl: Controller) {
  const repo = ctl.repo;
  if (!repo) throw new Error(t('No git repository open.'));
  const c = ctl.cfg();
  const { base: detectedBase } = await ctl.base();
  const stages = flowStages(ctl);

  // 1. Onde
  const remote = await ctl.requests.detectRemote(true);
  let provider: 'github' | 'gitlab' | undefined = remote?.kind === 'github' || remote?.kind === 'gitlab' ? remote.kind : undefined;
  if (remote && !provider) {
    // Bitbucket Pipelines e Azure Pipelines ainda não têm template de sync
    const name = remote.kind === 'azure' ? 'Azure Pipelines' : 'Bitbucket Pipelines';
    const go = await vscode.window.showInformationMessage(
      t('There is no sync template for {0} yet.', name),
      { modal: true, detail: t('The extension\'s local sync works normally with this remote. If you want, you can generate the GitHub Actions or GitLab CI workflow as a starting point.') },
      t('Generate for GitHub/GitLab anyway'),
    );
    if (!go) return;
  }
  if (!provider) {
    const p = await vscode.window.showQuickPick(
      [
        { label: 'GitHub Actions', value: 'github' as const },
        { label: 'GitLab CI', value: 'gitlab' as const, detail: t('GitLab.com or self-hosted') },
      ],
      { title: t('Generate CI: for which platform?') },
    );
    if (!p) return;
    provider = p.value;
  }

  // 2. O quê
  type Mode = 'sync' | 'backmerge';
  const modes: (vscode.QuickPickItem & { value: Mode[] })[] = [
    { label: t('Keep work branches up to date with a base'), detail: t('On each push to the base, it is merged into the branches that match the patterns.'), value: ['sync'] },
  ];
  if (stages.length > 1) {
    const chain = [...stages].reverse().map(s => s.branch).join(' → ');
    modes.push(
      { label: t('Environment flow back-merge'), detail: t('A fix that lands in a stage flows down to the previous ones: {0}.', chain), value: ['backmerge'] },
      { label: t('Sync and back-merge'), value: ['sync', 'backmerge'] },
    );
  }
  const mode = modes.length === 1 ? modes[0] : await vscode.window.showQuickPick(modes, { title: t('Generate CI: what to automate?') });
  if (!mode) return;

  const pairs: SyncPair[] = [];
  if (mode.value.includes('sync')) {
    // 3. Qual base
    const refs = await repo.refs();
    const names = [...new Set([detectedBase, ...stages.map(s => s.branch), ...refs.filter(r => r.kind === 'head').map(r => r.name)])];
    const picked = await vscode.window.showQuickPick(
      names.map(n => ({
        label: n,
        description: [n === detectedBase ? t('current base') : '', stages.find(s => s.branch === n)?.label ?? ''].filter(Boolean).join(' · '),
      })),
      { title: t('Generate CI: which branch is the base that flows down to the work branches?'), placeHolder: detectedBase },
    );
    if (!picked) return;
    const base = picked.label;
    const patternsRaw = await vscode.window.showInputBox({
      title: t('Generate CI: which branches receive {0}?', base),
      prompt: t('Space-separated patterns; * matches anything, including "/". E.g. feat/* ai/* fix/*'),
      value: c.get<string[]>('autoSync.branches', ['**']).join(' '),
    });
    if (patternsRaw === undefined) return;
    // estágios do fluxo nunca recebem a base por aqui: eles andam por promoção
    const exclude = [...c.get<string[]>('autoSync.exclude', []), ...stages.map(s => s.branch).filter(b => b !== base)];
    pairs.push({
      base,
      patterns: patternsRaw.split(/\s+/).filter(Boolean),
      exclude,
      name: `sync-${slug(base)}-into-branches`,
      description: t('When {0} receives commits, {0} is merged into each branch that matches the patterns; runs the check and pushes.', base),
    });
  }
  if (mode.value.includes('backmerge')) {
    for (let i = stages.length - 1; i > 0; i--) {
      const from = stages[i].branch;
      const to = stages[i - 1].branch;
      pairs.push({
        base: from,
        patterns: [to],
        exclude: [],
        name: `backmerge-${slug(from)}-into-${slug(to)}`,
        description: t('Back-merge: what lands in {0} ({1}) flows down to {2} ({3}).', from, stages[i].label, to, stages[i - 1].label),
      });
    }
  }

  const testCommand = await vscode.window.showInputBox({
    title: t('Generate CI: check command after the merge'),
    prompt: t('Runs before the push; if it fails, the branch is not changed. Empty = no check. E.g. npm ci && npm test'),
    value: c.get<string>('autoSync.testCommand', ''),
  });
  if (testCommand === undefined) return;

  const written: string[] = [];
  if (provider === 'github') {
    const template = fs.readFileSync(path.join(ctl.ctx.extensionPath, 'media', 'ci-template.yml'), 'utf8');
    for (const p of pairs) {
      const rel = path.join('.github', 'workflows', `${p.name}.yml`);
      const yaml = buildWorkflow(template, { base: p.base, patterns: p.patterns, exclude: p.exclude, testCommand }).replace(
        /^name: .*$/m,
        `name: ${p.name.startsWith('backmerge') ? `Back-merge ${p.base} → ${p.patterns[0]}` : `Sync ${p.base} into branches`}`,
      );
      if (await writeFile(repo.root, rel, yaml)) written.push(rel);
    }
  } else {
    const image = await vscode.window.showInputBox({
      title: t('Generate CI: Docker image for the job'),
      prompt: t('It must have what the check uses (git is installed if missing).'),
      value: guessImage(testCommand),
    });
    if (!image) return;
    const template = fs.readFileSync(path.join(ctl.ctx.extensionPath, 'media', 'gitlab-ci-template.yml'), 'utf8');
    const rel = path.join('.gitlab', 'worktree-graph-sync.gitlab-ci.yml');
    if (await writeFile(repo.root, rel, buildGitLabCi(template, pairs, testCommand, image))) written.push(rel);
    await ensureGitLabInclude(repo.root, rel.split(path.sep).join('/'));
  }
  if (!written.length) return;
  for (const w of written) await vscode.window.showTextDocument(vscode.Uri.file(path.join(repo.root, w)), { preview: false });
  vscode.window.showInformationMessage(
    provider === 'gitlab'
      ? t('{0} CI file(s) created. Create the SYNC_TOKEN variable (write_repository) in the project, commit and push to activate.', written.length)
      : t('{0} CI file(s) created. Commit and push to activate.', written.length),
  );
}

/** Garante o include no .gitlab-ci.yml sem estragar um pipeline que já existe. */
async function ensureGitLabInclude(root: string, rel: string) {
  const main = path.join(root, '.gitlab-ci.yml');
  const line = `  - local: ${rel}`;
  if (!fs.existsSync(main)) {
    fs.writeFileSync(main, `include:\n${line}\n`);
    return;
  }
  const text = fs.readFileSync(main, 'utf8');
  if (text.includes(rel)) return;
  if (/^include:\s*$/m.test(text)) {
    fs.writeFileSync(main, text.replace(/^include:\s*$/m, `include:\n${line}`));
    return;
  }
  if (/^include:/m.test(text)) {
    await vscode.window.showTextDocument(vscode.Uri.file(main));
    vscode.window.showWarningMessage(t('Add "{0}" to the include in .gitlab-ci.yml (the current format cannot be edited automatically).', rel));
    return;
  }
  fs.writeFileSync(main, `include:\n${line}\n\n${text}`);
}
