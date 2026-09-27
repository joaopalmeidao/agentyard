# Worktree Graph

Extensão do VS Code para quem trabalha com vários agentes de IA em paralelo, cada um na sua
`git worktree`. Mostra todas as worktrees e branches num painel só, deixa mesclar com um clique
(ou arrastando uma branch sobre outra) e mantém as branches em dia com a base — localmente, pela
própria extensão, e no GitHub, por um workflow que ela gera.

![VS Code com o Worktree Graph](docs/prints/00-vscode.png)

## O que tem

| | |
|---|---|
| **Cards de worktree** | branch, pasta, alterações não commitadas, `↓atrás ↑à frente` da base, previsão de conflito (`git merge-tree`, sem tocar em nada), upstream e status do sync. |
| **Merge fácil** | `↓ Trazer master`, `↑ Mesclar em master`, arrastar card/branch sobre outro, ou botão direito → *Mesclar em…*. Sempre com confirmação mostrando quantos commits entram e se a simulação prevê conflito. |
| **Branch sem worktree** | o merge acontece numa worktree temporária; se der conflito, nada muda e a extensão oferece criar uma worktree para resolver. |
| **Revisar** | lista os arquivos que a branch mudou desde que saiu da base (inclui o que ainda não foi commitado) e abre cada um num diff. |
| **Agentes no terminal** | botão **✦ Claude Code** em cada card abre o CLI do agente num terminal já dentro da worktree (reaproveita se já estiver aberto). A lista é configurável: Claude Code, Codex, Gemini ou qualquer comando; `{prompt}` pede a tarefa antes de abrir. |
| **Navegar arquivos** | na barra lateral, cada worktree expande em *Alterações × base* (clique abre o diff) e na árvore de pastas; branches sem worktree também, lidas direto do git. **Arquivos** busca e abre qualquer arquivo de outra worktree sem trocar de janela. |
| **Nova worktree** | cria branch + pasta a partir da base (ou de qualquer branch/commit) e roda um comando de setup (`npm install`, etc.). |
| **Grafo** | histórico de todas as branches, worktrees (`▣`), remotas e tags, com filtro. |
| **Sync automático** | quando a base anda, mescla nas worktrees que casam com os padrões — só se estiver limpa, sem conflito previsto, e roda um comando de verificação (desfaz o merge se falhar). |
| **CI** | gera `.github/workflows/sync-<base>-into-branches.yml`, que faz o mesmo no GitHub a cada push na base. |

## Instalar

```bash
npm install
npm run compile
npm run package        # gera worktree-graph-0.1.0.vsix
code --install-extension worktree-graph-0.1.0.vsix
```

Para desenvolver: abra a pasta no VS Code e aperte **F5**.

Requer git ≥ 2.38 (previsão de conflito usa `git merge-tree --write-tree`).

## Agentes

```jsonc
"worktreeGraph.agents": [
  { "name": "Claude Code", "command": "claude" },
  { "name": "Claude Code (com tarefa)", "command": "claude {prompt}" },
  { "name": "Codex CLI", "command": "codex" }
],
"worktreeGraph.agentTerminalLocation": "editor"   // ou "panel"
```

O primeiro da lista é o do botão do card; os outros aparecem no botão direito. Cada terminal
recebe `WTGRAPH_BRANCH`, `WTGRAPH_BASE` e `WTGRAPH_WORKTREE`. Um terminal por worktree e agente:
clicar de novo só traz o terminal para frente.

## Sync automático (local)

Ligue pelo botão **Sync** do painel, pelo ícone na barra da árvore ou pela barra de status. O
estado fica guardado por repositório (não em `settings.json`, para não sujar nenhuma worktree).

A cada `autoSync.intervalSeconds`, para cada worktree cuja branch casa com `autoSync.branches`:

1. em dia com a base → nada;
2. alterações não commitadas ou merge/rebase em andamento → **espera** (o agente pode estar no meio do trabalho);
3. `git merge-tree` prevê conflito → não mexe, avisa uma vez por commit da base;
4. modo `notify` → só avisa, com botão *Mesclar agora*;
5. senão → `git merge <base>`; se `autoSync.testCommand` estiver definido, roda na worktree e,
   se falhar, desfaz com `git reset --keep` (preserva qualquer edição feita durante os testes).

Com várias janelas abertas no mesmo repositório (uma por worktree), só uma roda o sync: elas
disputam um lock em `<.git>/worktree-graph-sync.lock`.

![Depois do sync](docs/prints/05-depois-do-sync.png)

## Sync no GitHub (CI)

**Gerar CI** pergunta os padrões de branch e o comando de verificação e escreve o workflow. Ele:

- roda a cada push na base (e manualmente, via *workflow_dispatch*);
- lista as branches remotas que casam com os padrões e estão atrás da base;
- para cada uma (matrix): mescla a base, roda a verificação, faz push; conflito ou verificação
  quebrada → não altera a branch e registra no *Summary* da execução.

Push feito com `GITHUB_TOKEN` não dispara outros workflows. Se quiser que o CI da branch rode depois
do sync, use um PAT em `secrets.SYNC_TOKEN` (linha comentada no checkout).

**Local ou CI?** Os dois podem mesclar a mesma base na mesma branch e gerar commits de merge
diferentes. Use o sync local para worktrees ainda não publicadas e o CI para branches
compartilhadas — os padrões (`autoSync.branches`/`exclude`) ajudam a separar.

## Configurações

| chave | padrão | |
|---|---|---|
| `worktreeGraph.baseBranch` | *(detecta)* | origin/HEAD → main → master → develop |
| `worktreeGraph.worktreeRoot` | `<repo>.worktrees` | onde novas worktrees nascem (ex.: `G:\worktrees`) |
| `worktreeGraph.postCreateCommand` | | rodado num terminal após criar a worktree |
| `worktreeGraph.agents` | Claude Code, Codex, Gemini | CLIs do botão de agente |
| `worktreeGraph.agentTerminalLocation` | `panel` | `panel` ou `editor` |
| `worktreeGraph.noFastForwardIntoBase` | `true` | `--no-ff` ao mesclar na base |
| `worktreeGraph.refreshIntervalSeconds` | `15` | atualização do painel |
| `worktreeGraph.graph.maxCommits` | `400` | |
| `worktreeGraph.graph.showRemoteBranches` | `true` | |
| `worktreeGraph.autoSync.enabledByDefault` | `false` | |
| `worktreeGraph.autoSync.mode` | `merge` | `merge` ou `notify` |
| `worktreeGraph.autoSync.branches` | `["**"]` | `*` = um segmento, `**` = qualquer coisa |
| `worktreeGraph.autoSync.exclude` | `[]` | |
| `worktreeGraph.autoSync.intervalSeconds` | `60` | |
| `worktreeGraph.autoSync.fetchRemote` | `false` | `git fetch` e sincroniza a partir de `origin/<base>` |
| `worktreeGraph.autoSync.testCommand` | | ex.: `npm test` |
| `worktreeGraph.autoSync.testTimeoutSeconds` | `900` | |
| `worktreeGraph.autoSync.rollbackOnTestFailure` | `true` | |

## Testes

```bash
node test/run.js                 # integração num VS Code real, perfil isolado
node scripts/test-sync.js <repo> # sync contra um repositório, sem VS Code
```

## Scripts

- `scripts/make-demo.sh` — cria um repositório de demonstração com worktrees "de agentes" (uma limpa, uma suja, uma que conflita).
- `scripts/test-sync.js <repo> [teste] [status.json]` — roda o sync de verdade contra um repositório, sem VS Code.
- `scripts/make-prints.sh` — regera `docs/prints/` renderizando o painel num Edge headless.
