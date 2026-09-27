// Confere as traduções: todo t('…') do código e do webview tem entrada em l10n/bundle.l10n.pt-br.json,
// o bundle não tem sobras, e package.nls.json e package.nls.pt-br.json cobrem as mesmas chaves do package.json.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const files = [];
const walk = d => {
  for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
    const rel = path.join(d, e.name);
    if (e.isDirectory()) walk(rel);
    else if (/\.ts$/.test(e.name)) files.push(rel);
  }
};
walk('src');
files.push('media/graph.js');

// primeiro argumento de t(): literal entre aspas simples (a regra do src/i18n.ts)
const used = new Map();
const unquote = s => JSON.parse('"' + s.replace(/\\'/g, "'").replace(/"/g, '\\"') + '"');
for (const f of files) {
  const src = read(f);
  for (const m of src.matchAll(/\bt\(\s*'((?:[^'\\\n]|\\.)*)'/g)) used.set(unquote(m[1]), f);
  // t() com template literal ou variável não é extraível
  for (const m of src.matchAll(/\bt\(\s*[`"]/g)) assert.fail(`${f}: t() com o texto fora de aspas simples perto de "${src.slice(m.index, m.index + 60)}"`);
}

const bundle = JSON.parse(read('l10n/bundle.l10n.pt-br.json'));
const missing = [...used.keys()].filter(k => !(k in bundle));
assert.deepStrictEqual(missing.map(k => `${used.get(k)}: ${k}`), [], 'textos sem tradução para pt-BR');
const extra = Object.keys(bundle).filter(k => !used.has(k));
assert.deepStrictEqual(extra, [], 'traduções que o código não usa mais');
for (const [en, pt] of Object.entries(bundle)) {
  const ph = s => (s.match(/\{\d+\}/g) || []).sort().join();
  assert.strictEqual(ph(pt), ph(en), `marcadores diferentes em "${en}"`);
}

const pkg = read('package.json');
const keys = new Set([...pkg.matchAll(/"%([^%"]+)%"/g)].map(m => m[1]));
for (const f of ['package.nls.json', 'package.nls.pt-br.json']) {
  const nls = JSON.parse(read(f));
  assert.deepStrictEqual([...keys].filter(k => !(k in nls)), [], `${f}: chaves do package.json sem texto`);
  assert.deepStrictEqual(Object.keys(nls).filter(k => !keys.has(k)), [], `${f}: chaves que o package.json não usa`);
}
console.log(`ok   l10n: ${used.size} textos com tradução pt-BR, ${keys.size} chaves no package.json`);
