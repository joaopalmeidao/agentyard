# Changelog

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
