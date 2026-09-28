/**
 * O painel principal (media/graph.js, o mesmo do VS Code) servido para o celular: as variáveis do
 * tema do VS Code (Dark/Light Modern, pelo tema do aparelho), um acquireVsCodeApi que fala com a
 * extensão por HTTP e a interface dos diálogos (confirmação, lista, texto) e avisos.
 */

export interface PanelTexts {
  title: string;
  loading: string;
  offline: string;
  denied: string;
  noToken: string;
  agents: string;
  cancel: string;
  ok: string;
  filter: string;
}

const DARK = `--vscode-editor-background:#1f1f1f;--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-widget-border:#313131;
--vscode-sideBar-background:#181818;--vscode-list-hoverBackground:#2a2d2e;--vscode-list-inactiveSelectionBackground:#37373d;--vscode-focusBorder:#0078d4;
--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#cccccc;--vscode-button-secondaryHoverBackground:#3c3c3c;
--vscode-button-background:#0078d4;--vscode-button-foreground:#ffffff;--vscode-button-hoverBackground:#026ec1;--vscode-button-border:#ffffff12;
--vscode-testing-iconPassed:#73c991;--vscode-editorWarning-foreground:#cca700;--vscode-errorForeground:#f85149;--vscode-textLink-foreground:#4daafc;
--vscode-input-background:#313131;--vscode-input-foreground:#cccccc;--vscode-input-border:#3c3c3c;--vscode-input-placeholderForeground:#989898;
--vscode-menu-background:#1f1f1f;--vscode-menu-foreground:#cccccc;--vscode-menu-border:#454545;--vscode-menu-selectionBackground:#0078d4;
--vscode-menu-selectionForeground:#ffffff;--vscode-menu-separatorBackground:#454545;--vscode-panel-border:#2b2b2b;--vscode-panelTitle-activeBorder:#0078d4;
--vscode-charts-blue:#3794ff;--vscode-charts-green:#89d185;--vscode-charts-yellow:#cca700;--vscode-charts-orange:#d18616;--vscode-charts-red:#f14c4c;
--vscode-charts-purple:#b180d7;--vscode-badge-background:#616161;--vscode-badge-foreground:#f8f8f8;--vscode-toolbar-hoverBackground:#5a5d5e50;
--vscode-editorHoverWidget-background:#202020;--vscode-editorHoverWidget-foreground:#cccccc;--vscode-widget-shadow:#0000005c`;

const LIGHT = `--vscode-editor-background:#ffffff;--vscode-foreground:#3b3b3b;--vscode-descriptionForeground:#717171;--vscode-widget-border:#e5e5e5;
--vscode-sideBar-background:#f8f8f8;--vscode-list-hoverBackground:#f2f2f2;--vscode-list-inactiveSelectionBackground:#e4e6f1;--vscode-focusBorder:#005fb8;
--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryForeground:#3b3b3b;--vscode-button-secondaryHoverBackground:#cccccc;
--vscode-button-background:#005fb8;--vscode-button-foreground:#ffffff;--vscode-button-hoverBackground:#0258a8;--vscode-button-border:#0000001a;
--vscode-testing-iconPassed:#388a34;--vscode-editorWarning-foreground:#bf8803;--vscode-errorForeground:#f85149;--vscode-textLink-foreground:#005fb8;
--vscode-input-background:#ffffff;--vscode-input-foreground:#3b3b3b;--vscode-input-border:#cecece;--vscode-input-placeholderForeground:#767676;
--vscode-menu-background:#ffffff;--vscode-menu-foreground:#3b3b3b;--vscode-menu-border:#cecece;--vscode-menu-selectionBackground:#005fb8;
--vscode-menu-selectionForeground:#ffffff;--vscode-menu-separatorBackground:#d4d4d4;--vscode-panel-border:#e5e5e5;--vscode-panelTitle-activeBorder:#005fb8;
--vscode-charts-blue:#1a85ff;--vscode-charts-green:#388a34;--vscode-charts-yellow:#bf8803;--vscode-charts-orange:#d18616;--vscode-charts-red:#e51400;
--vscode-charts-purple:#652d90;--vscode-badge-background:#cccccc;--vscode-badge-foreground:#3b3b3b;--vscode-toolbar-hoverBackground:#b8b8b850;
--vscode-editorHoverWidget-background:#f8f8f8;--vscode-editorHoverWidget-foreground:#3b3b3b;--vscode-widget-shadow:#00000029`;

export function panelPage(x: PanelTexts, l10n: { bundle: Record<string, string>; locale: string }): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const json = (o: unknown) => JSON.stringify(o).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="${esc(l10n.locale)}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>${esc(x.title)}</title>
<link rel="stylesheet" href="media/graph.css">
<style>
:root{${DARK};--vscode-font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--vscode-font-size:14px;--vscode-editor-font-family:ui-monospace,Menlo,Consolas,monospace;color-scheme:dark}
@media (prefers-color-scheme: light){:root{${LIGHT};color-scheme:light}}
html,body{background:var(--vscode-editor-background);color:var(--vscode-foreground);-webkit-text-size-adjust:100%}
#ay-bar{position:sticky;top:0;z-index:50;display:flex;align-items:center;gap:10px;padding:8px 12px;padding-top:max(8px,env(safe-area-inset-top));background:var(--vscode-sideBar-background);border-bottom:1px solid var(--vscode-widget-border);font-size:13px}
#ay-bar a{color:var(--vscode-textLink-foreground);text-decoration:none}
#ay-bar .grow{flex:1}
#ay-conn{color:var(--vscode-descriptionForeground)}
#ay-conn.off{color:var(--vscode-editorWarning-foreground)}
#ay-toasts{position:fixed;left:12px;right:12px;bottom:max(12px,env(safe-area-inset-bottom));z-index:200;display:flex;flex-direction:column;gap:8px;pointer-events:none}
.ay-toast{pointer-events:auto;background:var(--vscode-editorHoverWidget-background);color:var(--vscode-editorHoverWidget-foreground);border:1px solid var(--vscode-widget-border);border-left:4px solid var(--vscode-charts-blue);border-radius:6px;padding:10px 12px;box-shadow:0 4px 16px var(--vscode-widget-shadow);white-space:pre-wrap;overflow-wrap:anywhere}
.ay-toast.warning{border-left-color:var(--vscode-editorWarning-foreground)}.ay-toast.error{border-left-color:var(--vscode-errorForeground)}
#ay-dlg{position:fixed;inset:0;z-index:300;background:#0008;display:none;align-items:flex-end;justify-content:center}
#ay-dlg.open{display:flex}
.ay-sheet{width:100%;max-width:640px;max-height:85vh;display:flex;flex-direction:column;background:var(--vscode-editor-background);border:1px solid var(--vscode-widget-border);border-radius:12px 12px 0 0;padding:14px 14px max(14px,env(safe-area-inset-bottom))}
.ay-sheet h3{margin:0 0 6px;font-size:15px;white-space:pre-wrap;overflow-wrap:anywhere}
.ay-sheet .ay-detail{color:var(--vscode-descriptionForeground);white-space:pre-wrap;overflow-wrap:anywhere;margin-bottom:8px;max-height:30vh;overflow:auto}
.ay-sheet input[type=text],.ay-sheet input[type=password],.ay-sheet input[type=search]{width:100%;box-sizing:border-box;font-size:16px;padding:8px 10px;margin:4px 0 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px}
.ay-list{overflow:auto;flex:1;margin:0 -14px;border-top:1px solid var(--vscode-widget-border)}
.ay-item{display:flex;gap:10px;align-items:flex-start;padding:10px 14px;border-bottom:1px solid var(--vscode-widget-border);cursor:pointer}
.ay-item:active{background:var(--vscode-list-hoverBackground)}
.ay-item .d{color:var(--vscode-descriptionForeground);font-size:12px;overflow-wrap:anywhere}
.ay-sep{padding:8px 14px 4px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--vscode-descriptionForeground)}
.ay-err{color:var(--vscode-errorForeground);min-height:1em;margin-bottom:6px}
.ay-btns{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;padding-top:10px}
.ay-btns button{font-size:15px;padding:9px 14px;border-radius:6px;border:1px solid var(--vscode-button-border);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.ay-btns button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.ay-msg{padding:32px 16px;text-align:center;color:var(--vscode-descriptionForeground)}
/* celular: sem rolagem lateral, uma coluna de cards, histórico só com grafo, descrição e data */
@media (max-width: 700px){
  body{padding:0 10px 16px;overflow-x:hidden}
  #ay-bar{margin:0 -10px}
  #top > .toolbar,#top > .tabs,#top > .error{padding-inline:10px}
  .group,.tools{flex-wrap:wrap;max-width:100%}
  .cards,.cards.attempts{grid-template-columns:minmax(0,1fr)}
  .graph{min-width:0}
  .pane{padding-inline:0}
  .gg-head,.gg-row{grid-template-columns:var(--gw) minmax(0,1fr) 72px}
  .gg-head .author,.gg-row .author,.gg-head .sha,.gg-row .sha{display:none}
  button{min-height:32px}
  .tabs button{min-height:40px}
}
</style></head><body>
<div id="ay-bar"><strong>${esc(x.title)}</strong><span class="grow"></span><span id="ay-conn"></span><a href="./">${esc(x.agents)}</a></div>
<div id="app"><div class="ay-msg">${esc(x.loading)}</div></div>
<div id="ay-dlg"></div><div id="ay-toasts"></div>
<script>window.__L10N = ${json(l10n)};</script>
<script>
(function () {
  const T = ${json(x)};
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // ícones do VS Code ($(name)) não existem aqui
  const plain = s => String(s ?? '').replace(/\\$\\([a-z0-9~-]+\\)\\s*/gi, '');
  let key = '';
  try { key = localStorage.getItem('agentyard.k') || ''; } catch {}
  const m = /[#&]k=([^&]+)/.exec(location.hash);
  if (m) {
    key = decodeURIComponent(m[1]);
    try { localStorage.setItem('agentyard.k', key); } catch {}
    history.replaceState(null, '', location.pathname);
  }
  const client = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const conn = document.getElementById('ay-conn');
  const fail = msg => { document.getElementById('app').innerHTML = '<div class="ay-msg">' + esc(msg) + '</div>'; };
  let connected = false;
  const queue = [];
  const send = msg => fetch('api/msg', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify({ c: client, msg }) }).catch(() => {});
  const post = msg => (connected ? send(msg) : queue.push(msg));
  let state;
  try { state = JSON.parse(localStorage.getItem('agentyard.panelState') || 'null'); } catch {}
  window.acquireVsCodeApi = () => ({
    postMessage: post,
    getState: () => state,
    setState: s => { state = s; try { localStorage.setItem('agentyard.panelState', JSON.stringify(s)); } catch {} },
  });
  const deliver = data => window.dispatchEvent(new MessageEvent('message', { data }));

  // ---------- avisos e diálogos
  const toasts = document.getElementById('ay-toasts');
  function toast(t) {
    const el = document.createElement('div');
    el.className = 'ay-toast ' + (t.level || 'info');
    el.textContent = plain(t.message) + (t.detail ? '\\n' + t.detail : '');
    el.onclick = () => el.remove();
    toasts.appendChild(el);
    setTimeout(() => el.remove(), t.level === 'error' ? 12000 : 6000);
  }
  const dlg = document.getElementById('ay-dlg');
  let open = null;
  const answer = (id, value) => send({ type: 'answer', id, value });
  function close(id) {
    if (!open || (id && open.id !== id)) return;
    open = null;
    dlg.classList.remove('open');
    dlg.innerHTML = '';
  }
  function show(d) {
    open = d;
    const head = (d.title ? '<h3>' + esc(plain(d.title)) + '</h3>' : '');
    if (d.kind === 'message') {
      dlg.innerHTML = '<div class="ay-sheet"><h3>' + esc(plain(d.message)) + '</h3>' + (d.detail ? '<div class="ay-detail">' + esc(d.detail) + '</div>' : '') +
        '<div class="ay-btns"><button data-v="">' + esc(T.cancel) + '</button>' + d.items.map((l, i) => '<button class="' + (i === 0 ? 'primary' : '') + '" data-v="' + i + '">' + esc(plain(l)) + '</button>').join('') + '</div></div>';
      dlg.querySelectorAll('button').forEach(b => b.onclick = () => answer(d.id, b.dataset.v === '' ? undefined : Number(b.dataset.v)));
    } else if (d.kind === 'input') {
      dlg.innerHTML = '<div class="ay-sheet">' + head + (d.prompt ? '<div class="ay-detail">' + esc(plain(d.prompt)) + '</div>' : '') +
        '<input type="' + (d.password ? 'password' : 'text') + '" autocomplete="off" autocapitalize="off" spellcheck="false"><div class="ay-err"></div>' +
        '<div class="ay-btns"><button data-c>' + esc(T.cancel) + '</button><button class="primary" data-ok>' + esc(T.ok) + '</button></div></div>';
      const inp = dlg.querySelector('input');
      inp.value = d.value || '';
      inp.placeholder = d.placeHolder || '';
      const ok = () => answer(d.id, inp.value);
      inp.onkeydown = e => { if (e.key === 'Enter') ok(); };
      dlg.querySelector('[data-ok]').onclick = ok;
      dlg.querySelector('[data-c]').onclick = () => answer(d.id, undefined);
      setTimeout(() => inp.focus(), 50);
    } else if (d.kind === 'pick') {
      const chosen = new Set(d.items.map((it, i) => (it.picked ? i : -1)).filter(i => i >= 0));
      dlg.innerHTML = '<div class="ay-sheet">' + head + '<input type="search" placeholder="' + esc(plain(d.placeHolder) || T.filter) + '"><div class="ay-list"></div>' +
        '<div class="ay-btns"><button data-c>' + esc(T.cancel) + '</button>' + (d.many ? '<button class="primary" data-ok>' + esc(T.ok) + '</button>' : '') + '</div></div>';
      const list = dlg.querySelector('.ay-list');
      const inp = dlg.querySelector('input');
      const draw = () => {
        const q = inp.value.trim().toLowerCase();
        list.innerHTML = d.items.map((it, i) => {
          if (it.separator) return q ? '' : '<div class="ay-sep">' + esc(plain(it.label)) + '</div>';
          const hay = (plain(it.label) + ' ' + (it.description || '') + ' ' + (it.detail || '')).toLowerCase();
          if (q && !hay.includes(q)) return '';
          return '<div class="ay-item" data-i="' + i + '">' + (d.many ? '<input type="checkbox" ' + (chosen.has(i) ? 'checked' : '') + '>' : '') +
            '<div><div>' + esc(plain(it.label)) + (it.description ? ' <span class="d">' + esc(plain(it.description)) + '</span>' : '') + '</div>' +
            (it.detail ? '<div class="d">' + esc(plain(it.detail)) + '</div>' : '') + '</div></div>';
        }).join('');
        list.querySelectorAll('.ay-item').forEach(el => el.onclick = () => {
          const i = Number(el.dataset.i);
          if (!d.many) return answer(d.id, i);
          chosen.has(i) ? chosen.delete(i) : chosen.add(i);
          el.querySelector('input').checked = chosen.has(i);
        });
      };
      inp.oninput = draw;
      draw();
      dlg.querySelector('[data-c]').onclick = () => answer(d.id, undefined);
      const okb = dlg.querySelector('[data-ok]');
      if (okb) okb.onclick = () => answer(d.id, [...chosen]);
    }
    dlg.classList.add('open');
  }

  // ---------- conexão: fluxo NDJSON de /api/events, reconecta sozinho
  async function stream() {
    if (!key) return fail(T.noToken);
    try {
      const r = await fetch('api/events?c=' + client, { headers: { authorization: 'Bearer ' + key }, cache: 'no-store' });
      if (r.status === 401) return fail(T.denied);
      if (!r.ok || !r.body) throw new Error(String(r.status));
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.type === 'hello') {
            connected = true;
            conn.textContent = '';
            conn.className = '';
            // sempre pede o estado de novo (primeira vez ou depois de cair)
            send({ type: 'ready' });
            queue.splice(0).filter(q => q.type !== 'ready').forEach(send);
          } else if (msg.type === 'dialog') show(msg);
          else if (msg.type === 'dialogClose') close(msg.id);
          else if (msg.type === 'dialogError') { const e = dlg.querySelector('.ay-err'); if (e && open && open.id === msg.id) e.textContent = msg.message; }
          else if (msg.type === 'toast') toast(msg);
          else deliver(msg);
        }
      }
    } catch {}
    connected = false;
    conn.textContent = T.offline;
    conn.className = 'off';
    setTimeout(stream, 2000);
  }
  stream();
})();
</script>
<script src="media/graph.js"></script>
</body></html>`;
}
