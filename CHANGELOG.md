# Changelog

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
