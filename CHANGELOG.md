# Changelog

## Não lançado
- Sync local da base agora acontece no push, por padrão: antes de enviar uma branch pela extensão, a
  base é mesclada nela (mesmas regras: worktree limpa, sem conflito previsto, testes). A verificação
  periódica só mostra quem está atrás. Para voltar ao comportamento anterior (mesclar a cada
  verificação), use `worktreeGraph.autoSync.trigger: "interval"`.
- Migrations nos merges: quando a branch e o destino criaram migrations novas, o git mescla sem
  conflito, mas a cadeia quebra (duas `0005` no Django, duas heads no Alembic, `V5__` repetida no
  Flyway). Antes do merge o AgentYard avisa e oferece "Reencadear e mesclar": renumera as da branch
  depois da última do destino e aponta a dependência/`down_revision` para ela, num commit na branch.
  Funciona também depois de a base já ter sido trazida. Suporta Django, Alembic, Flyway,
  golang-migrate e arquivos numerados em pastas de migrations (timestamps não colidem e ficam de fora).
- "Reencadear migrations após a base" no menu da worktree, "Conferir migrations das worktrees" na
  view Worktrees, seção "Migrations" no Analisar merge, e o sync automático reencadeia antes de trazer
  a base (`worktreeGraph.migrations.rechainOnSync`; `migrations.checkOnMerge` desliga o aviso).
- Vários agentes na mesma worktree: com um já aberto, o ✦ pergunta se vai para um dos terminais
  abertos ou abre outro (`worktreeGraph.agentWhenOpen`: perguntar, reaproveitar ou sempre novo).
  Ctrl/Alt+clique no ✦ e "Abrir outro agente na worktree" sempre abrem um terminal novo (`#2`, `#3`…).
- View "Agentes abertos": terminais de agente agrupados por worktree, com há quanto tempo estão
  abertos; clicar traz o terminal para frente, ➕ abre outro na worktree e ✕ fecha. Badge com o total.
- "Agentes abertos…" (paleta, menu da worktree e chip ✦ do card) lista os terminais agrupados;
  o chip mostra "Claude Code ×2" quando há mais de um.

## 0.14.0
- Grupo "Não commitadas" em cada worktree da view Worktrees (inclusive a principal): cada arquivo
  com a letra (M/A/D/?), as linhas (+/−) e se está no stage; clique abre o diff com o último commit.
- "Ver alterações não commitadas": o patch completo num editor, com os arquivos novos inteiros.
- "Descartar alterações não commitadas…": por arquivo (ou vários selecionados) ou da worktree toda,
  escolhendo na lista o que sai. Antes de confirmar, abre o patch do que vai ser descartado e a
  confirmação diz o efeito em cada arquivo ("volta ao último commit (+3 −1)", "apagado (arquivo
  novo)", "volta a existir"). Nada se perde: o descarte guarda uma cópia num stash, com "Desfazer"
  e "Ver o que saiu" logo em seguida.

## 0.13.0
- "Excluir mescladas" nas branches sem worktree: um clique exclui as branches locais cujos commits
  já estão todos na base (a base e as protegidas nunca entram; as do remoto continuam). Confirmação
  com a lista e "Escolher na lista…" para manter alguma. Também no menu da view Worktrees e na paleta.

## 0.12.1
- O botão de PRs/MRs do painel não dá mais "command 'worktreeGraph.pullRequests.focus' not found"
  quando a janela ainda está com uma versão anterior ativa: abre a barra do AgentYard e oferece
  recarregar a janela.

## 0.12.0
- View "Pull requests": grupos Meus, Pedem minha revisão, Abertos e Mesclados (7 dias), com a
  situação da revisão, CI, conflitos, rascunho e se a branch já tem worktree local.
- Ao expandir um PR/MR: comentários recentes e checks. Ações: abrir no navegador, trazer para uma
  worktree (inclusive PR de fork no GitHub, como `pr/N`), revisar arquivos, ✦ revisar com o agente,
  analisar merge, mesclar pela API (com confirmação), sair/entrar em rascunho e copiar link.
- Botão de PRs/MRs na barra do painel; o chip de PR abre o PR na view (Ctrl/Alt+clique abre no navegador).
- GitHub e GitLab (inclusive self-hosted) completos; Bitbucket e Azure DevOps com listagem.

## 0.11.0
**Correção importante**
- Remover uma worktree que tinha um atalho (junction/symlink) para fora dela — como o `node_modules`
  compartilhado com a principal ou um pacote de `npm link` — apagava o conteúdo do destino (o git no
  Windows segue a junction). Agora os atalhos são desfeitos antes da remoção, em todos os caminhos
  (remover, limpar em lote, remover mescladas, merge em worktree temporária).

**Histórico**
- Um desenho só: colunas (Graph, Description, Date, Author, Commit) e, ao clicar num commit, os
  detalhes logo abaixo (pais, autor, mensagem completa, arquivos com +/− e diff). Etiquetas locais e
  `origin/` do mesmo commit agrupadas.
- Seletor "Branches:", "Mostrar branches remotas" e busca; as escolhas ficam salvas por projeto.
- Filtro "CI": só as branches que o CI usa (fluxo, base, GitHub Actions, GitLab CI, Bitbucket
  Pipelines, Azure Pipelines e `worktreeGraph.ciBranches`), com o que espera promoção e o último pipeline.

**Agentes**
- Agendamentos: tarefas enviadas aos agentes por cron ou atalho ("todo dia às 9h", "dias úteis às
  08:30", "a cada 2 h", "uma vez em …"), para uma branch, uma worktree nova ou todas de um padrão;
  condições (só limpa, só se a base andou), horário perdido, uma janela por repositório e histórico.
- Modelos de tarefa ("✦ Usar modelo…") prontos e do projeto (`.agentyard/templates/*.md`).
- Resumo quando o agente fica pronto: commits, arquivos e +/−, com Revisar, Analisar merge e Publicar.
- Coordenação: detector de sobreposição de arquivos entre worktrees, fila de merge (uma branch por
  vez, com a base trazida e checagens), tarefa em lote (`batch.maxParallel`) e orçamento por worktree.

**Ambiente por worktree**
- Porta e `.env` por worktree (`env.ports`), setup automático (npm/pnpm/yarn/bun/pip/poetry/uv ou
  `node_modules` compartilhado) e espaço em disco (💾) na tabela, na limpeza e no "Remover mescladas".

**Entrega**
- Linha do tempo das branches (nascimento, commits, PR/MR, aprovação e merge).
- Relatório do dia em Markdown (commits, PRs, pipelines, issues, tokens e custo por branch).
- "Preparar versão": changelog por seções desde a última tag, versão por semver, commit e tag locais.

## 0.10.0
- Nome novo: **AgentYard** (antes Worktree Graph), com logo e ícone novos: três trilhos de agentes
  convergindo num merge, formando um Y. Repositório em github.com/joaopalmeidao/agentyard (o link
  antigo redireciona). Comandos e configurações continuam com os mesmos IDs (`worktreeGraph.*`).

## 0.9.2
- Repositórios com centenas de worktrees: menos processos git em paralelo (4), status das worktrees
  paradas menos frequente, painel redesenhado no máximo 1×/s e o grafo não é refeito enquanto as
  worktrees são detalhadas. O clique em "Tudo"/"Não mescladas" responde na hora.

## 0.9.1
- O histórico abre em "Não mescladas" por padrão; a escolha entre "Tudo" e "Não mescladas" fica salva.

## 0.9.0
**Histórico e commits**
- Painel abre no layout de abas, na aba Histórico; layout, aba e divisor ficam salvos no VS Code.
- Comandos nos commits (botão direito ou duplo clique): ver alterações, ✦ explicar com o agente,
  abrir no GitHub/GitLab, copiar hash/mensagem, criar branch/tag/worktree, cherry-pick em…,
  reverter e voltar uma branch até o commit (com backup e Desfazer).
- Situação da revisão do PR/MR ao lado da branch (✓ aprovado, ✎ mudanças pedidas, ◷ aguardando,
  💬 conversas abertas) no histórico, nos cards e na tabela — GitHub, GitLab, Bitbucket e Azure DevOps.

**Git do dia a dia**
- Pull: "☁↓ Trazer" por branch (fast-forward; se divergir, merge ou rebase; worktree suja pode
  guardar num stash e devolver), "Trazer n" em lote e fetch manual ou periódico.
- Stash por worktree (grupo "Stashes"): guardar, aplicar, ver diff, apagar e mover alterações entre worktrees.
- Cherry-pick arrastando um commit do histórico sobre uma branch; "Reorganizar commits" (reordenar,
  squash/fixup, reword, drop) sem editor, com backup e Desfazer; "Comparar com…" entre duas worktrees.
- "Remover mescladas (n)": remove de uma vez as worktrees limpas cuja branch já está na base
  (e as branches, se quiser); favoritas, com agente e protegidas ficam de fora.

**Agentes**
- "✓ Pronto para revisar" quando o agente termina deixando commits e a worktree limpa.
- Fila de tarefas por worktree, com a próxima indo sozinha para o agente.
- "Tentar N abordagens": várias worktrees try/* com agentes em paralelo e painel para comparar,
  escolher uma e descartar as outras.
- "✦ Revisar PR/MR com o agente": comentários do agente num painel para postar no GitHub/GitLab.

**Qualidade**
- Checagens antes de mesclar e de enviar (lint/testes), com cache por commit e "✦ Corrigir com o agente".
- Branches protegidas (base, estágios do fluxo, main/master): merge e push direto pedem confirmação
  digitando o nome, ou exigem PR/MR; push forçado bloqueado. 🔒 no painel e na árvore.
- Lembrete de limpeza quando se acumulam worktrees mescladas e paradas.

**Métricas**
- Painel "Atividade" (hoje, ontem, 7 dias): commits, arquivos, sessões e tokens por worktree, PRs e pipelines.
- Custo por tarefa: tokens por branch ligados à issue ou PR/MR, com custo estimado em US$ se configurado.

**Plataformas**
- Bitbucket Cloud e Server/Data Center, Azure DevOps Services e Server: PRs, pipelines/builds,
  issues/work items. Jira Cloud e Server na view Issues.
- "Conectar ao GitLab" informando a URL (self-hosted, porta, instalação em subcaminho).

## 0.8.0
- View "Pipelines": GitHub Actions e GitLab CI (inclusive self-hosted), com jobs, log, re-executar
  (inclusive só os falhos), cancelar, disparar numa branch e iniciar job manual.
- Último pipeline de cada branch no painel (cards, tabela e estágios do fluxo) e na árvore; o clique
  abre no navegador.
- "✦ Corrigir com o agente" num pipeline que falhou: abre o agente na worktree com o final do log
  (template `worktreeGraph.prompts.fixPipeline`); aviso quando um pipeline de worktree falha.
- Painel mais leve: só o pedaço que mudou é redesenhado; o grafo não é refeito enquanto as
  worktrees são detalhadas.

## 0.7.0
- Push fácil: botão "☁ Push ↑n" nos cards e na tabela quando há commits não enviados, "☁ Publicar"
  (push -u) para branches que ainda não estão no remoto, chip com a situação no remoto (↑ a enviar,
  ↓ a receber, apagada) e ícone na árvore.
- Push recusado: oferece trazer do remoto e tentar de novo, ou forçar com --force-with-lease.
- "☁↑ Enviar n": envia em lote as branches com commits pendentes (lista já marcada).
- Nova issue no GitHub, GitLab (inclusive self-hosted) ou Redmine, pela view Issues ou com o botão
  direito numa seleção do editor ("Criar issue com a seleção", que leva arquivo, linhas e código);
  a notificação oferece "✦ Começar com Claude".

## 0.6.1
- View "Claude: configuração": skills, comandos, configurações e memória do Claude Code, do usuário
  e do projeto ativo, num lugar só.
- Skills e comandos: criar com esqueleto, copiar entre usuário e projeto, renomear e excluir; skills
  sincronizadas da conta aparecem só para leitura.
- Configurações: editor de permissões (allow/ask/deny), modelo padrão e hooks; a gravação preserva
  chaves desconhecidas, aceita comentários e guarda um `.bak`.
- Memória por projeto e por worktree: criar no formato do Claude (com a linha no MEMORY.md),
  excluir junto com a linha do índice e verificar o índice.
- Redmine: o projeto escolhido fica por repositório, fora do `.vscode/settings.json`.

## 0.6.0
- Logo novo: monograma "W" feito de arestas do grafo, com o ✦ do agente; prévia social do GitHub.
- "✦ Resolver com Claude" em conflitos (card, tabela, árvore, análise de merge e notificações): o
  agente abre na worktree com a tarefa de trazer a base, resolver, testar e commitar. Se a branch
  não tem worktree, ela é criada antes.
- Tarefas para agentes vão por arquivo e entram como um único argumento (PowerShell, bash e cmd);
  campo `promptCommand` por agente e comando `worktreeGraph.launchAgentWithPrompt`.
- Issues do GitHub, do GitLab (inclusive self-hosted) e do Redmine numa view própria, com
  "minhas/todas"; "Começar com Claude" cria branch e worktree da issue e abre o agente com o prompt
  (`worktreeGraph.prompts.issue`). O PR/MR ganha "Closes #N" ou "Refs #N".
- Vários projetos na mesma janela: view Projetos, "Adicionar projeto…" (pasta ou varredura de uma
  pasta de repositórios) e troca do projeto ativo pelo nome ▾ no painel.
- Sessões do Claude Code por worktree: retomar, nova sessão, transcrição, chip com sessões e tokens
  nos cards; uso estimado da janela de 5 h e da semana na barra de status (com orçamento opcional);
  "Comandos do Claude Code…" com comandos e skills do projeto e do usuário.

## 0.5.0
- PR/MR com um clique: push da branch, título e descrição a partir dos commits, rascunho opcional;
  `PR #12`/`MR !5` aparece no card, na tabela e na árvore. GitHub (login nativo do VS Code),
  GitHub Enterprise e GitLab, inclusive self-hosted (token no cofre do VS Code).
- Analisar merge: painel com commits que entram, arquivos (marcando os alterados nos dois lados) e
  conflitos previstos; cada conflito abre como ficaria depois do merge, com os marcadores.
  O diálogo de merge ganhou "Analisar antes".
- Árvore de arquivos como a do Explorer: cores e letras do git (M/U/A/D), pastas compactas,
  `files.exclude`, abrir ao lado, revelar no sistema, copiar caminho, comparar com a base e
  "Adicionar ao Explorer".
- Gerar CI: escolha da base, GitLab CI (jobs em sh POSIX, token SYNC_TOKEN, funciona em self-hosted)
  e back-merge do fluxo de ambientes.
- Fluxo de ambientes (dev → QA → homologação → produção): faixa no painel com o que espera
  promoção e hotfixes que precisam descer; Promover abre PR/MR, analisa ou mescla.
- Painel dividido (empilhado, lado a lado ou abas) com divisor arrastável; worktrees e histórico
  rolam separados.
- Histórico "Só não mescladas", com o ponto de saída de cada branch; etiquetas já mescladas apagadas.
- Trabalho não commitado em destaque: vira card, filtro na tabela e linha "● alterações não
  commitadas" no grafo.

## 0.4.0
- Repositórios grandes: a ativação não espera mais a leitura do repositório; a lista aparece em ~1 s
  (lida direto de `.git/worktrees`) e cada worktree é detalhada em segundo plano, com barra de
  progresso no painel e contador na árvore. Testado com 274 worktrees: 1,3 s até a lista, 28 s até o
  detalhe completo na primeira vez, 2,3 s nas seguintes.
- Cache de ahead/behind e previsão de conflito por par de commits, persistido entre sessões.
- Status por prioridade: worktrees ativas a cada 30 s, as demais a cada 10 min.
- Favoritas (★): viram card no painel e sobem na árvore.
- Painel: cards só para a principal, favoritas e com agente aberto; as demais numa tabela compacta com filtro.
- Limpeza em lote ("Limpar worktrees…"), já marcando as mescladas e limpas; seleção múltipla na árvore.
- "Remover worktrees órfãs" (`git worktree prune`) para registros cuja pasta foi apagada.
- Publisher do Marketplace: `worktree-graph`.

## 0.3.0
- Escolha de onde o sync roda, por repositório: só local, só GitHub Actions, dividido (local para branches não publicadas, CI para as publicadas) ou ambos.
- Vídeo de demonstração gravado num VS Code real (`scripts/make-video.sh`).

## 0.2.0
- Botão de agente em cada worktree: abre Claude Code, Codex, Gemini ou qualquer CLI configurado num terminal dentro da worktree, com `{prompt}` opcional.
- Barra lateral navegável: alterações × base com diff, árvore de pastas de cada worktree e conteúdo de branches sem worktree.
- "Abrir arquivo de outra worktree…" com busca.
- Correção: um refresh pedido durante outro agora espera o estado novo.
- Testes de integração num VS Code real (`node test/run.js`).

## 0.1.0
- Painel com cards de worktree, branches sem worktree e grafo de commits.
- Merge por botão, arrastar-e-soltar e menu de contexto, com previsão de conflito.
- Nova worktree, revisão de alterações contra a base, remoção de worktree/branch.
- Sync automático local da base nas worktrees limpas, com verificação e rollback.
- Gerador de workflow do GitHub Actions para sincronizar a base nas branches remotas.
