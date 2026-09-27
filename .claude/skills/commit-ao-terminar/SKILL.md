---
name: commit-ao-terminar
description: Use ao concluir qualquer tarefa de código neste repositório (implementação compilou e testes passaram) — faz o commit na branch atual sem perguntar ao usuário.
---

# Commitar ao terminar

Ao terminar uma implementação (compilou e testes passaram), faça o commit na branch atual **sem pedir confirmação**.

1. `git add` apenas dos arquivos que fazem parte da tarefa — não inclua mudanças alheias que já estavam no working tree.
2. Commit com mensagem em português, no estilo do repo: uma frase descritiva do que mudou (ex.: "Sobreposição de arquivos numa tela própria em vez da lista no topo").
3. **Não** faça push, merge, bump de versão nem atualize o CHANGELOG — isso só quando o usuário pedir.
