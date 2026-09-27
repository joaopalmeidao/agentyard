// Branches usadas pelo CI (GitHub, GitLab, Bitbucket, Azure). Uso: node test/ciBranches.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseYaml, fromGithubWorkflow, fromGitlabCi, fromBitbucket, fromAzure, expandPattern, discoverCiBranches } = require('../out/ciBranches');

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${e.stack || e}`);
  }
};

const GITHUB = `
name: CI  # comentário
on:
  push:
    branches: [ main, "release/**" ]
    tags: ['v*']
  pull_request:
    branches:
      - develop
      - 'hotfix/*'
  workflow_dispatch:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          echo "branches: [nao, conta]"
`;

const GITLAB = `
stages: [build, deploy]
deploy_qa:
  stage: deploy
  script: [./deploy.sh qa]
  rules:
    - if: '$CI_COMMIT_BRANCH == "qa"'
    - if: $CI_COMMIT_REF_NAME == 'homolog' && $CI_PIPELINE_SOURCE == "push"
old_job:
  only:
    - main
    - merge_requests
    - /^feature-.*$/
other:
  only:
    refs: [production, tags]
`;

const BITBUCKET = `
image: node:20
pipelines:
  default:
    - step:
        script: [npm test]
  branches:
    master:
      - step:
          script: [npm run deploy]
    'staging':
      - step:
          script: [npm run stage]
`;

const AZURE1 = `
trigger:
  branches:
    include:
      - main
      - refs/heads/release/*
    exclude:
      - experimental
pr:
  branches:
    include: [develop]
`;
const AZURE2 = `trigger: [ main, dev ]`;

check('leitor de YAML: mapas, listas, inline, bloco literal', () => {
  const y = parseYaml(GITHUB);
  assert.deepStrictEqual(y.on.push.branches, ['main', 'release/**']);
  assert.deepStrictEqual(y.on.pull_request.branches, ['develop', 'hotfix/*']);
  assert.strictEqual(typeof y.jobs.test.steps[1].run, 'string');
});

check('GitHub Actions: push e pull_request, sem pegar texto de dentro do script', () => {
  assert.deepStrictEqual(fromGithubWorkflow(GITHUB), ['main', 'release/**', 'develop', 'hotfix/*']);
  assert.deepStrictEqual(fromGithubWorkflow('on: [push]\njobs: {}'), []);
});

check('GitLab CI: rules com $CI_COMMIT_BRANCH/$CI_COMMIT_REF_NAME e only (sem palavras-chave nem regex)', () => {
  assert.deepStrictEqual(fromGitlabCi(GITLAB).sort(), ['homolog', 'main', 'production', 'qa']);
});

check('Bitbucket Pipelines: pipelines.branches', () => {
  assert.deepStrictEqual(fromBitbucket(BITBUCKET), ['master', 'staging']);
});

check('Azure Pipelines: trigger.branches.include, pr e trigger em lista', () => {
  assert.deepStrictEqual(fromAzure(AZURE1), ['main', 'release/*', 'develop']);
  assert.deepStrictEqual(fromAzure(AZURE2), ['main', 'dev']);
});

check('padrões expandem contra as branches existentes', () => {
  const existing = ['main', 'release/1.0', 'release/2.0/rc', 'hotfix/x', 'develop'];
  assert.deepStrictEqual(expandPattern('release/**', existing), ['release/1.0', 'release/2.0/rc']);
  assert.deepStrictEqual(expandPattern('release/*', existing), ['release/1.0']);
  assert.deepStrictEqual(expandPattern('main', existing), ['main']);
});

check('descoberta junta fluxo, base, arquivos de CI e configuração, com a origem de cada uma', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wtgraph-ci-'));
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), GITHUB);
  fs.writeFileSync(path.join(root, '.gitlab-ci.yml'), GITLAB);
  fs.writeFileSync(path.join(root, 'bitbucket-pipelines.yml'), BITBUCKET);
  fs.writeFileSync(path.join(root, 'azure-pipelines.yml'), AZURE1);
  const r = discoverCiBranches(root, {
    base: 'main',
    flow: ['develop', 'qa', 'main'],
    extras: ['extra-branch'],
    existing: ['main', 'develop', 'qa', 'release/1.0', 'hotfix/x', 'extra-branch'],
  });
  const by = Object.fromEntries(r.map(b => [b.name, b.sources]));
  assert.deepStrictEqual(r.slice(0, 3).map(b => b.name), ['develop', 'qa', 'main'], 'fluxo primeiro, na ordem');
  assert.ok(by.main.includes('base') && by.main.includes('.github/workflows/ci.yml') && by.main.includes('.gitlab-ci.yml'));
  assert.deepStrictEqual(by['release/1.0'], ['.github/workflows/ci.yml', 'azure-pipelines.yml']);
  assert.ok(by['hotfix/x'], 'padrão hotfix/* expandido');
  assert.ok(by.staging && by.master, 'Bitbucket');
  assert.deepStrictEqual(by['extra-branch'], ['settings (worktreeGraph.ciBranches)']);
  fs.rmSync(root, { recursive: true, force: true });
});

if (failures) process.exit(1);
