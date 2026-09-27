# Changelog

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
