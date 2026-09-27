#!/usr/bin/env bash
# Roda de verdade o script do job de GitLab CI gerado (e valida os YAMLs), contra a demo.
# Uso: bash test/ci.test.sh
set -e
cd "$(dirname "$0")/.."
T=docs/.tmp/citest
rm -rf "$T" && mkdir -p "$T"
bash scripts/make-demo.sh "$(pwd)/$T/demo" >/dev/null 2>&1
ORIGIN="$(pwd)/$T/origin.git"
git clone -q --bare "$T/demo/loja-app" "$ORIGIN"

# gera os YAMLs com as funções da extensão (sem VS Code)
node -e '
const fs = require("fs"); const M = require("module"); const o = M._resolveFilename;
M._resolveFilename = function (r, ...a) { return r === "vscode" ? "vscode" : o.call(this, r, ...a); };
require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: {} };
const { buildGitLabCi, buildWorkflow } = require("./out/ciTemplate");
const pairs = [
  { base: "master", patterns: ["ai/**"], exclude: ["ai/refatorar-*"], name: "sync-master-into-branches", description: "sync" },
  { base: "master", patterns: ["release/1.0"], exclude: [], name: "backmerge-master-into-release", description: "back-merge" },
];
fs.writeFileSync(process.argv[1] + "/gitlab.yml", buildGitLabCi(fs.readFileSync("media/gitlab-ci-template.yml", "utf8"), pairs, "test -f src/cupom.ts", "alpine:3.20"));
fs.writeFileSync(process.argv[1] + "/github.yml", buildWorkflow(fs.readFileSync("media/ci-template.yml", "utf8"), { base: "develop", patterns: ["feat/**"], exclude: ["qa"], testCommand: "" }));
' "$T"

python - "$T" <<'PY'
import sys, yaml
t = sys.argv[1]
gl = yaml.safe_load(open(f"{t}/gitlab.yml", encoding="utf8"))
gh = yaml.safe_load(open(f"{t}/github.yml", encoding="utf8"))
assert set(gl) == {"wtgraph-sync-master-into-branches", "wtgraph-backmerge-master-into-release"}, gl.keys()
assert (gh.get("on") or gh[True])["push"]["branches"] == ["develop"]  # PyYAML lê "on:" como True
open(f"{t}/job1.sh", "w", encoding="utf8").write(gl["wtgraph-sync-master-into-branches"]["script"][0])
open(f"{t}/job2.sh", "w", encoding="utf8").write(gl["wtgraph-backmerge-master-into-release"]["script"][0])
v = gl["wtgraph-sync-master-into-branches"]["variables"]
open(f"{t}/vars1.sh", "w").write(f'export BASE_BRANCH="{v["BASE_BRANCH"]}" BRANCH_PATTERNS="{v["BRANCH_PATTERNS"]}" EXCLUDE_PATTERNS="{v["EXCLUDE_PATTERNS"]}"\n')
v = gl["wtgraph-backmerge-master-into-release"]["variables"]
open(f"{t}/vars2.sh", "w").write(f'export BASE_BRANCH="{v["BASE_BRANCH"]}" BRANCH_PATTERNS="{v["BRANCH_PATTERNS"]}" EXCLUDE_PATTERNS="{v["EXCLUDE_PATTERNS"]}"\n')
print("YAML ok:", ", ".join(gl))
PY

run_job() { # run_job <n>: executa o script como o runner faria, num clone novo, com push para o remoto local
  rm -rf "$T/runner" && git clone -q "$ORIGIN" "$T/runner"
  ( cd "$T/runner"
    . "../vars$1.sh"
    export SYNC_TOKEN=x CI_SERVER_PROTOCOL=https CI_SERVER_HOST=gitlab.exemplo CI_SERVER_PORT=443 CI_PROJECT_PATH=g/p
    sed "s#^PUSH_URL=.*#PUSH_URL=\"$ORIGIN\"#" "../job$1.sh" > job.sh
    sh job.sh ) 2>&1 | sed 's/^/    /' || true
}
echo "--- job sync (ai/** menos ai/refatorar-*)"; run_job 1
echo "--- job back-merge (master → release/1.0)"; run_job 2
echo "--- resultado no remoto"
for b in ai/login-oauth ai/precos-promo ai/refatorar-api release/1.0; do
  if git -C "$ORIGIN" merge-base --is-ancestor master "$b"; then echo "  $b: contém master"; else echo "  $b: NÃO contém master"; fi
done
