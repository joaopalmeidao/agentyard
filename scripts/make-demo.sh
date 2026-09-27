#!/usr/bin/env bash
# Cria um repositório de demonstração com worktrees "de agentes" para testar a extensão e gerar os prints.
set -e
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)/docs/.tmp/demo}"; mkdir -p "$ROOT"; ROOT="$(cd "$ROOT" && pwd)"
rm -rf "$ROOT" && mkdir -p "$ROOT"
REPO="$ROOT/loja-app"; WT="$ROOT/worktrees"
now=$(date +%s)
c() { # c <minutos atrás> <autor> <mensagem>
  local t=$((now - $1 * 60)); export GIT_AUTHOR_DATE="@$t" GIT_COMMITTER_DATE="@$t"
  git -c user.name="$2" -c user.email="dev@example.com" commit -q -am "$3" 2>/dev/null || git -c user.name="$2" -c user.email="dev@example.com" commit -q -m "$3"
}
git init -q -b master "$REPO" && cd "$REPO" && git config core.autocrlf false && git config user.name "João" && git config user.email "dev@example.com"
mkdir -p src tests
printf 'export const precos = { camiseta: 59, caneca: 35 };\n' > src/precos.ts
printf 'export function login(u, s) {\n  return u === "admin";\n}\n' > src/auth.ts
printf 'export function api() { return "v1"; }\n' > src/api.ts
printf '# Loja App\n' > README.md
git add . && c 3000 "João" "chore: estrutura inicial"
echo 'export const frete = 15;' > src/frete.ts; git add .; c 2600 "João" "feat: cálculo de frete"
echo '- rodar com npm start' >> README.md; c 2200 "Maria" "docs: como rodar"

git branch release/1.0
git worktree add -q -b ai/login-oauth "$WT/ai-login-oauth"
git worktree add -q -b ai/refatorar-api "$WT/ai-refatorar-api"
git worktree add -q -b ai/precos-promo "$WT/ai-precos-promo"
git branch fix/typo-readme

( cd "$WT/ai-login-oauth"
  printf 'export function login(u, s) {\n  return oauth.verify(u, s);\n}\n' > src/auth.ts; c 1500 "Claude (agente)" "feat(auth): login via OAuth"
  echo 'export const oauth = { verify: () => true };' > src/oauth.ts; git add .; c 1400 "Claude (agente)" "feat(auth): cliente OAuth"
  mkdir -p tests; echo 'test("login")' > tests/auth.test.ts; git add .; c 1300 "Claude (agente)" "test(auth): cobre login OAuth" )

( cd "$WT/ai-refatorar-api"
  echo 'export function api() { return "v2"; }' > src/api.ts; c 900 "Codex (agente)" "refactor(api): versão 2 do endpoint"
  echo '// TODO: paginação' >> src/api.ts; echo 'export const x = 1;' > src/novo.ts )   # alterações não commitadas

( cd "$WT/ai-precos-promo"
  printf 'export const precos = { camiseta: 49, caneca: 29 };\n' > src/precos.ts; c 700 "Claude (agente)" "feat(precos): preços da promoção" )

git checkout -q fix/typo-readme; sed -i 's/Loja App/Loja App — loja online/' README.md; c 600 "Maria" "fix: título do README"; git checkout -q master

printf 'export const precos = { camiseta: 65, caneca: 39 };\n' > src/precos.ts; c 400 "João" "feat(precos): reajuste de preços"
git merge -q --no-ff fix/typo-readme -m "Merge branch 'fix/typo-readme'" 
echo 'export const cupom = (v) => v * 0.9;' > src/cupom.ts; git add .; c 120 "Maria" "feat: cupom de desconto"
git tag v1.1
echo "Demo pronta em $REPO"
