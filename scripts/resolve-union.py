"""
Resolve conflitos de "soma" deixados por frentes paralelas: os dois lados acrescentaram código no
mesmo ponto. Uso: python scripts/resolve-union.py <arquivo> <modo>
  tests  : blocos de check() em test/suite.js — mantém os dois (o `});` final é comum)
  concat : mantém os dois blocos, na ordem nosso → deles
Confira sempre o resultado (node --check / tsc) — conflito que não é soma precisa de mão.
"""
import re
import sys

PAT = re.compile(r'<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n', re.S)
path, mode = sys.argv[1], sys.argv[2]
s = open(path, encoding='utf8').read()


def tests(m):
    return m.group(1).rstrip('\n') + '\n  });\n\n' + m.group(2)


def concat(m):
    return m.group(1) + m.group(2)


s, n = PAT.subn(tests if mode == 'tests' else concat, s)
open(path, 'w', encoding='utf8').write(s)
print(f'{path}: {n} bloco(s) resolvido(s) ({mode})')
