"""
Mescla o package.json de duas branches pela estrutura (contribuições são listas e mapas que as
frentes só acrescentam). Uso: python scripts/merge-package-json.py <ref-nosso> <ref-deles>
Escreve package.json no diretório atual.
"""
import json
import subprocess
import sys


def load(ref):
    return json.loads(subprocess.check_output(['git', 'show', f'{ref}:package.json']).decode('utf8'))


def union_list(a, b, key):
    out, seen = [], set()
    for item in a + b:
        k = key(item)
        if k in seen:
            continue
        seen.add(k)
        out.append(item)
    return out


ours, theirs = load(sys.argv[1]), load(sys.argv[2])
c, t = ours['contributes'], theirs['contributes']

c['commands'] = union_list(c['commands'], t['commands'], lambda x: x['command'])
for name, items in t['menus'].items():
    c['menus'][name] = union_list(c['menus'].get(name, []), items, lambda x: json.dumps(x, sort_keys=True))
for container, views in t['views'].items():
    c['views'][container] = union_list(c['views'].get(container, []), views, lambda x: x['id'])
c['viewsWelcome'] = union_list(c.get('viewsWelcome', []), t.get('viewsWelcome', []), lambda x: json.dumps(x, sort_keys=True))
props = c['configuration']['properties']
for k, v in t['configuration']['properties'].items():
    props.setdefault(k, v)
ours['activationEvents'] = sorted(set(ours.get('activationEvents', [])) | set(theirs.get('activationEvents', [])))

# scripts: os testes das duas frentes rodam juntos
def steps(s):
    return [x.strip() for x in s.split('&&')]
test = union_list(steps(ours['scripts'].get('test', '')), steps(theirs['scripts'].get('test', '')), lambda x: x)
test = [x for x in test if 'test/run.js' not in x] + [x for x in test if 'test/run.js' in x]
ours['scripts']['test'] = ' && '.join(x for x in test if x)
for k, v in theirs['scripts'].items():
    ours['scripts'].setdefault(k, v)

json.dump(ours, open('package.json', 'w', encoding='utf8'), ensure_ascii=False, indent=2)
open('package.json', 'a').write('\n')
cmds = [x['command'] for x in c['commands']]
print('comandos:', len(cmds), '| views:', [v['id'] for v in c['views']['worktreeGraph']], '| test:', ours['scripts']['test'])
