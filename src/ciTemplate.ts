import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Controller } from './controller';
import { flowStages } from './flow';

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
        '      # Prepare o ambiente antes da verificação, por exemplo:',
        '      # - uses: actions/setup-node@v4',
        '      #   with: { node-version: 20, cache: npm }',
        '      # - run: npm ci',
        '      - name: Verificação',
        '        shell: bash',
        '        run: |',
        ...o.testCommand.split(/\r?\n/).map(l => `          ${l}`),
      ].join('\n')
    : ['      # Sem verificação configurada. Para rodar testes antes do push, adicione aqui:', '      # - name: Verificação', '      #   run: npm test'].join('\n');
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
      '  # O estágio "deploy" existe por padrão; se o seu .gitlab-ci.yml define "stages:", use um que exista.',
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
      '      : "${SYNC_TOKEN:?defina a variável SYNC_TOKEN em Settings > CI/CD > Variables}"',
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
      '        if ! git merge --no-edit -m "Merge $BASE_BRANCH into $ref (sync automático)" "origin/$BASE_BRANCH"; then',
      '          echo "conflito ao mesclar $BASE_BRANCH em $ref:"',
      "          git diff --name-only --diff-filter=U | sed 's/^/  - /'",
      '          git merge --abort; failed="$failed $ref"; continue',
      '        fi',
      `        if ! ( ${test} ); then`,
      '          echo "verificação falhou em $ref; nada foi enviado"',
      '          git reset -q --hard "origin/$ref"; failed="$failed $ref"; continue',
      '        fi',
      '        git push -q "$PUSH_URL" "HEAD:refs/heads/$ref"',
      '        synced="$synced $ref"',
      '      done',
      '      echo "sincronizadas:${synced:- nenhuma}"',
      '      if [ -n "$failed" ]; then echo "com conflito ou verificação falhando:$failed"; exit 1; fi',
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
    const ok = await vscode.window.showWarningMessage(`${rel} já existe.`, { modal: true }, 'Sobrescrever');
    if (!ok) return false;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return true;
}

export async function generateCiWorkflow(ctl: Controller) {
  const repo = ctl.repo;
  if (!repo) throw new Error('Nenhum repositório git aberto.');
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
      `Ainda não há template de sync para ${name}.`,
      { modal: true, detail: 'O sync local da extensão funciona normalmente com este remoto. Se quiser, dá para gerar o workflow do GitHub Actions ou do GitLab CI como ponto de partida.' },
      'Gerar para GitHub/GitLab mesmo assim',
    );
    if (!go) return;
  }
  if (!provider) {
    const p = await vscode.window.showQuickPick(
      [
        { label: 'GitHub Actions', value: 'github' as const },
        { label: 'GitLab CI', value: 'gitlab' as const, detail: 'GitLab.com ou self-hosted' },
      ],
      { title: 'Gerar CI: para qual plataforma?' },
    );
    if (!p) return;
    provider = p.value;
  }

  // 2. O quê
  type Mode = 'sync' | 'backmerge';
  const modes: (vscode.QuickPickItem & { value: Mode[] })[] = [
    { label: 'Manter as branches de trabalho em dia com uma base', detail: 'A cada push na base, ela é mesclada nas branches que casam com os padrões.', value: ['sync'] },
  ];
  if (stages.length > 1) {
    const chain = [...stages].reverse().map(s => s.branch).join(' → ');
    modes.push(
      { label: 'Back-merge do fluxo de ambientes', detail: `Correção que entra num estágio desce para os anteriores: ${chain}.`, value: ['backmerge'] },
      { label: 'Os dois', value: ['sync', 'backmerge'] },
    );
  }
  const mode = modes.length === 1 ? modes[0] : await vscode.window.showQuickPick(modes, { title: 'Gerar CI: o que automatizar?' });
  if (!mode) return;

  const pairs: SyncPair[] = [];
  if (mode.value.includes('sync')) {
    // 3. Qual base
    const refs = await repo.refs();
    const names = [...new Set([detectedBase, ...stages.map(s => s.branch), ...refs.filter(r => r.kind === 'head').map(r => r.name)])];
    const picked = await vscode.window.showQuickPick(
      names.map(n => ({
        label: n,
        description: [n === detectedBase ? 'base atual' : '', stages.find(s => s.branch === n)?.label ?? ''].filter(Boolean).join(' · '),
      })),
      { title: 'Gerar CI: qual branch é a base que desce para as branches de trabalho?', placeHolder: detectedBase },
    );
    if (!picked) return;
    const base = picked.label;
    const patternsRaw = await vscode.window.showInputBox({
      title: `Gerar CI: quais branches recebem ${base}?`,
      prompt: 'Padrões separados por espaço; * casa qualquer coisa, inclusive "/". Ex.: feat/* ai/* fix/*',
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
      description: `Quando ${base} recebe commits, ${base} é mesclada em cada branch que casa com os padrões; roda a verificação e faz push.`,
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
        description: `Back-merge: o que entra em ${from} (${stages[i].label}) desce para ${to} (${stages[i - 1].label}).`,
      });
    }
  }

  const testCommand = await vscode.window.showInputBox({
    title: 'Gerar CI: comando de verificação depois do merge',
    prompt: 'Roda antes do push; se falhar, a branch não é alterada. Vazio = sem verificação. Ex.: npm ci && npm test',
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
      title: 'Gerar CI: imagem Docker do job',
      prompt: 'Precisa ter o que a verificação usa (git é instalado se faltar).',
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
  const where = provider === 'gitlab' ? 'Crie a variável SYNC_TOKEN (write_repository) no projeto, faça' : 'Faça';
  vscode.window.showInformationMessage(`${written.length} arquivo(s) de CI criado(s). ${where} commit e push para ativar.`);
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
    vscode.window.showWarningMessage(`Adicione "${rel}" ao include do .gitlab-ci.yml (o formato atual não dá para editar automaticamente).`);
    return;
  }
  fs.writeFileSync(main, `include:\n${line}\n\n${text}`);
}
