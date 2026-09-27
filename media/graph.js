// @ts-check
(function () {
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage() {}, getState() {}, setState() {} };
  const ROW = 26;
  const COL = 16;
  const DOT = 4.5;
  const COLORS = ['#4fc1ff', '#c586c0', '#e5c07b', '#89d185', '#f48771', '#56b6c2', '#d19a66', '#b180d7'];

  /** @type {any} */
  let state = null;
  let filter = '';
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));

  const send = (action, args = {}) => vscode.postMessage({ type: 'action', action, args });
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function ago(unix) {
    if (!unix) return '';
    const s = Math.max(0, Date.now() / 1000 - unix);
    if (s < 60) return 'agora';
    if (s < 3600) return `${Math.floor(s / 60)} min`;
    if (s < 86400) return `${Math.floor(s / 3600)} h`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)} d`;
    return new Date(unix * 1000).toLocaleDateString('pt-BR');
  }

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'state') {
      state = m.state;
      render();
    } else if (m.type === 'busy') {
      document.body.classList.toggle('busy', !!m.busy);
    }
  });

  // ---------- layout do grafo ----------
  /** Cada commit ganha uma coluna; cada aresta sabe em que coluna viaja até o pai. */
  function layout(commits) {
    const index = new Map(commits.map((c, i) => [c.sha, i]));
    /** @type {(string|null)[]} */
    const lanes = [];
    const edges = [];
    let width = 1;
    commits.forEach((c, i) => {
      let col = lanes.indexOf(c.sha);
      if (col === -1) {
        col = lanes.indexOf(null);
        if (col === -1) col = lanes.push(null) - 1;
      }
      for (let k = 0; k < lanes.length; k++) if (lanes[k] === c.sha) lanes[k] = null;
      c.x = col;
      c.y = i;
      c.parents.forEach((p, pi) => {
        let lane;
        if (pi === 0) {
          lane = col;
        } else {
          lane = lanes.indexOf(p);
          if (lane === -1) {
            lane = lanes.indexOf(null);
            if (lane === -1 || lane === col) lane = lanes.findIndex((v, k) => v === null && k !== col);
            if (lane === -1) lane = lanes.length;
          }
        }
        while (lanes.length <= lane) lanes.push(null);
        lanes[lane] = p;
        edges.push({ from: i, x: col, lane, to: p, merge: pi > 0 });
      });
      while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
      width = Math.max(width, lanes.length, col + 1);
    });
    for (const e of edges) {
      const t = index.get(e.to);
      e.ty = t === undefined ? commits.length : t;
      e.tx = t === undefined ? e.lane : commits[t].x;
    }
    return { edges, width };
  }

  const X = col => COL / 2 + col * COL + 2;
  const Y = row => row * ROW + ROW / 2;

  function edgePath(e) {
    let d = `M${X(e.x)},${Y(e.from)}`;
    let row = e.from;
    if (e.lane !== e.x) {
      d += ` C${X(e.x)},${Y(row) + ROW * 0.6} ${X(e.lane)},${Y(row + 1) - ROW * 0.6} ${X(e.lane)},${Y(row + 1)}`;
      row++;
    }
    if (e.ty > row) {
      if (e.tx === e.lane) {
        d += ` L${X(e.lane)},${Y(e.ty)}`;
      } else {
        if (e.ty - 1 > row) d += ` L${X(e.lane)},${Y(e.ty - 1)}`;
        d += ` C${X(e.lane)},${Y(e.ty - 1) + ROW * 0.6} ${X(e.tx)},${Y(e.ty) - ROW * 0.6} ${X(e.tx)},${Y(e.ty)}`;
      }
    }
    return d;
  }

  // ---------- render ----------
  function render() {
    if (!state) {
      app.innerHTML = '<div class="empty">Nenhum repositório git aberto neste workspace.</div>';
      return;
    }
    const scroll = document.querySelector('.graph-scroll');
    const top = scroll ? scroll.scrollTop : 0;
    const pageTop = document.scrollingElement ? document.scrollingElement.scrollTop : 0;
    const hadFocus = document.activeElement?.id === 'filter';
    app.innerHTML = toolbar() + worktreesSection() + branchesSection() + graphSection();
    const s2 = document.querySelector('.graph-scroll');
    if (s2) s2.scrollTop = top;
    if (document.scrollingElement) document.scrollingElement.scrollTop = pageTop;
    const f = /** @type {HTMLInputElement|null} */ (document.getElementById('filter'));
    if (f) {
      f.value = filter;
      if (hadFocus) f.focus();
    }
  }

  function toolbar() {
    const s = state.autoSync;
    return `<header class="toolbar">
      <div class="title"><span class="repo">${esc(state.repoName)}</span>
        <span class="muted">base</span> <span class="ref ref-base">${esc(state.baseRef)}</span></div>
      <div class="tools">
        <button data-action="createWorktree" class="primary">＋ Nova worktree</button>
        <button data-action="toggleAutoSync" class="${s.enabled ? 'on' : ''}" title="Mescla a base automaticamente nas worktrees limpas">
          ⟳ Sync ${s.enabled ? (s.mode === 'notify' ? 'ligado (avisar)' : 'ligado') : 'desligado'}</button>
        <button data-action="syncNow" title="Roda o sync uma vez agora">Sincronizar agora</button>
        <button data-action="generateCi" title="Gera .github/workflows para fazer o mesmo no GitHub">Gerar CI</button>
        <button data-action="refresh" title="Atualizar">↻</button>
      </div>
    </header>
    ${state.error ? `<div class="error">${esc(state.error)}</div>` : ''}`;
  }

  const arrows = (behind, ahead) => [behind ? `↓${behind}` : '', ahead ? `↑${ahead}` : ''].filter(Boolean).join(' ');

  function chip(text, cls = '', title = '') {
    return `<span class="chip ${cls}" ${title ? `title="${esc(title)}"` : ''}>${text}</span>`;
  }

  function syncChip(w) {
    if (w.isBase || !state.autoSync.enabled) return w.paused ? chip('‖ sync pausado', 'muted') : '';
    if (w.paused) return chip('‖ sync pausado', 'muted');
    const s = w.sync;
    if (!s) return chip('⟳ aguardando sync', 'muted');
    const map = {
      uptodate: ['⟳ em dia', 'ok'],
      merged: ['⟳ base mesclada', 'ok'],
      behind: ['⟳ atrás (avisar)', 'info'],
      'waiting-dirty': ['⟳ esperando commit', 'warn'],
      conflict: ['⟳ conflito', 'bad'],
      testing: ['⟳ testando…', 'info'],
      'test-failed': ['⟳ testes falharam', 'bad'],
      paused: ['‖ pausado', 'muted'],
      error: ['⟳ erro', 'bad'],
    };
    const [t, c] = map[s.kind] || [s.kind, ''];
    return chip(`${t} · ${ago(s.at / 1000)}`, c, s.message);
  }

  function worktreesSection() {
    const cards = state.worktrees
      .map(w => {
        const b = esc(w.branch || '');
        const chips = [];
        if (w.bare) chips.push(chip('bare', 'muted'));
        if (w.prunable) chips.push(chip('pasta sumiu (prunable)', 'bad'));
        if (w.operation) chips.push(chip(`${esc(w.operation)} em andamento`, 'bad'));
        chips.push(w.changes ? chip(`● ${w.changes} não commitada(s)`, 'warn') : chip('✓ limpa', 'ok'));
        if (!w.isBase && w.branch) {
          if (w.behind === 0 && w.ahead === 0) chips.push(chip(`= ${esc(state.baseRef)}`, 'muted'));
          else chips.push(chip(arrows(w.behind, w.ahead), w.behind ? 'info' : 'muted', `${w.behind} commit(s) da base que faltam aqui · ${w.ahead} commit(s) desta branch que a base não tem`));
          if (w.preview) chips.push(w.preview.conflict ? chip(`⚠ conflita com ${esc(state.base)}`, 'bad', w.preview.files.join('\n')) : chip('merge limpo', 'ok'));
        } else if (w.isBase && (w.behind || w.ahead)) {
          chips.push(chip(`${arrows(w.behind, w.ahead)} ${esc(state.baseRef)}`, 'info'));
        }
        if (w.track) chips.push(chip(esc(w.track.replace('ahead', '↑').replace('behind', '↓')), 'muted', `em relação a ${w.upstream}`));
        else if (w.branch && !w.upstream && !w.isBase) chips.push(chip('não publicada', 'muted'));
        if (w.branch) chips.push(syncChip(w));
        if (w.agents && w.agents.length) chips.push(chip(`✦ ${w.agents.map(esc).join(', ')}`, 'agent', 'Terminal de agente aberto nesta worktree'));

        const agent = state.agentNames && state.agentNames[0];
        const act = [
          agent && !w.bare && !w.prunable
            ? `<button data-action="launchAgent" data-path="${esc(w.path)}" data-branch="${b}" data-agent="${esc(agent)}" class="agent" title="Abre ${esc(agent)} num terminal dentro desta worktree (botão direito no card para outros agentes)">✦ ${esc(agent)}</button>`
            : '',
          `<button data-action="openWorktree" data-path="${esc(w.path)}" title="Abrir em nova janela">Abrir</button>`,
          `<button data-action="openFile" data-path="${esc(w.path)}" title="Buscar e abrir um arquivo desta worktree aqui mesmo">Arquivos</button>`,
          `<button data-action="openTerminal" data-path="${esc(w.path)}" title="Terminal nesta pasta">Terminal</button>`,
        ].filter(Boolean);
        if (w.branch && !w.isBase) {
          act.push(`<button data-action="diffWithBase" data-branch="${b}" title="Arquivos alterados desde que saiu da base">Revisar</button>`);
          act.push(`<button data-action="mergeBaseInto" data-branch="${b}" ${w.behind ? '' : 'disabled'} title="git merge ${esc(state.baseRef)}">↓ Trazer ${esc(state.base)}</button>`);
          act.push(`<button data-action="mergeIntoBase" data-branch="${b}" class="primary" ${w.ahead ? '' : 'disabled'} title="Mesclar em ${esc(state.base)}">↑ Mesclar em ${esc(state.base)}</button>`);
          act.push(`<button data-action="togglePause" data-branch="${b}" title="${w.paused ? 'Retomar' : 'Pausar'} o sync automático desta branch">${w.paused ? 'Retomar sync' : 'Pausar sync'}</button>`);
          act.push(`<button data-action="removeWorktree" data-branch="${b}" class="danger" title="Remover worktree (pede confirmação)">Remover</button>`);
        }
        const cls = ['card', w.isCurrent ? 'current' : '', w.isBase ? 'base' : '', w.preview?.conflict || w.operation ? 'conflict' : w.changes ? 'dirty' : ''].join(' ');
        return `<div class="${cls}" ${w.branch ? `draggable="true" data-drag="${b}" data-drop="${b}"` : ''} data-menu="${b}">
          <div class="card-head">
            <span class="branch">${esc(w.name)}</span>
            ${w.isBase ? '<span class="tag">base</span>' : ''}
            ${w.isMain ? '<span class="tag">principal</span>' : ''}
            ${w.isCurrent ? '<span class="tag accent">esta janela</span>' : ''}
          </div>
          <div class="path" title="${esc(w.path)}">${esc(w.path)}</div>
          <div class="chips">${chips.join('')}</div>
          <div class="last" title="${esc(w.subject)}">${esc(w.subject || '—')} <span class="muted">${ago(w.date)}</span></div>
          <div class="actions">${act.join('')}</div>
        </div>`;
      })
      .join('');
    return `<section>
      <h2>Worktrees <span class="count">${state.worktrees.length}</span>
        <span class="hint">arraste um card ou branch sobre outro para mesclar · botão direito para mais opções</span></h2>
      <div class="cards">${cards}</div>
    </section>`;
  }

  function branchesSection() {
    const list = state.branches.filter(b => !b.isBase);
    if (!list.length) return '';
    const rows = list
      .map(b => {
        const n = esc(b.name);
        return `<tr draggable="true" data-drag="${n}" data-drop="${n}" data-menu="${n}">
          <td><span class="ref ref-head">${n}</span></td>
          <td>${b.ahead === 0 ? chip('já mesclada', 'ok') : chip(arrows(b.behind, b.ahead), 'info')}
              ${b.preview ? (b.preview.conflict ? chip('⚠ conflito', 'bad', b.preview.files.join('\n')) : chip('merge limpo', 'ok')) : ''}</td>
          <td class="subject" title="${esc(b.subject)}">${esc(b.subject)}</td>
          <td class="muted">${ago(b.date)}</td>
          <td class="row-actions">
            <button data-action="createWorktree" data-existing="${n}">Worktree</button>
            <button data-action="diffWithBase" data-branch="${n}">Revisar</button>
            <button data-action="mergeIntoBase" data-branch="${n}" ${b.ahead ? '' : 'disabled'}>↑ ${esc(state.base)}</button>
            <button data-action="deleteBranch" data-branch="${n}" class="danger">Excluir</button>
          </td></tr>`;
      })
      .join('');
    return `<section><details ${list.length <= 8 ? 'open' : ''}>
      <summary><h2>Branches sem worktree <span class="count">${list.length}</span></h2></summary>
      <table class="branches">${rows}</table></details></section>`;
  }

  function badge(r) {
    const cls = { head: 'ref-head', remote: 'ref-remote', tag: 'ref-tag', detached: 'ref-detached' }[r.kind];
    const base = r.name === state.base && r.kind === 'head' ? ' ref-base' : '';
    const wt = r.worktree ? ' ref-wt' : '';
    const cur = r.current ? ' ref-current' : '';
    const drag = r.kind === 'head' || r.kind === 'remote' ? `draggable="true" data-drag="${esc(r.name)}"` : '';
    const drop = r.kind === 'head' ? `data-drop="${esc(r.name)}" data-menu="${esc(r.name)}"` : r.kind === 'remote' ? `data-menu-remote="${esc(r.name)}"` : '';
    const title = r.kind === 'head' ? (r.worktree ? 'branch com worktree' : 'branch local') : r.kind;
    return `<span class="ref ${cls}${base}${wt}${cur}" ${drag} ${drop} title="${title}">${r.worktree ? '▣ ' : ''}${esc(r.name)}</span>`;
  }

  function graphSection() {
    const commits = state.commits;
    if (!commits.length) return '<section><h2>Histórico</h2><div class="empty">Sem commits.</div></section>';
    const { edges, width } = layout(commits);
    const W = width * COL + 8;
    const H = commits.length * ROW;
    const paths = edges
      .map(e => `<path d="${edgePath(e)}" stroke="${COLORS[(e.merge ? e.lane : e.x) % COLORS.length]}" />`)
      .join('');
    const dots = commits
      .map(c => {
        const color = COLORS[c.x % COLORS.length];
        const isMerge = c.parents.length > 1;
        return `<circle cx="${X(c.x)}" cy="${Y(c.y)}" r="${isMerge ? DOT - 1 : DOT}" fill="${isMerge ? 'var(--bg)' : color}" stroke="${color}" stroke-width="2"/>`;
      })
      .join('');
    const q = filter.toLowerCase();
    const rows = commits
      .map(c => {
        const hide = q && !(c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.sha.startsWith(q) || c.refs.some(r => r.name.toLowerCase().includes(q)));
        return `<div class="row ${hide ? 'dim' : ''}" data-sha="${c.sha}" style="padding-left:${W}px">
          <span class="desc">${c.refs.map(badge).join('')}<span class="subject">${esc(c.subject)}</span></span>
          <span class="author">${esc(c.author)}</span>
          <span class="date">${ago(c.date)}</span>
          <span class="sha">${c.sha.slice(0, 7)}</span>
        </div>`;
      })
      .join('');
    return `<section class="graph-section">
      <h2>Histórico <span class="count">${commits.length}</span>
        <input id="filter" type="search" placeholder="Filtrar por mensagem, autor, hash ou branch" /></h2>
      <div class="graph-scroll"><div class="graph" style="height:${H}px">
        <svg class="lanes" width="${W}" height="${H}" fill="none" stroke-width="2">${paths}${dots}</svg>
        ${rows}
      </div></div>
    </section>`;
  }

  // ---------- interação ----------
  document.addEventListener('click', e => {
    const t = /** @type {HTMLElement} */ (e.target);
    hideMenu(t);
    const el = /** @type {HTMLElement|null} */ (t.closest('[data-action]'));
    if (!el || /** @type {HTMLButtonElement} */ (el).disabled) return;
    const { action, ...args } = el.dataset;
    send(action, args);
  });

  document.addEventListener('input', e => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (t.id !== 'filter') return;
    filter = t.value;
    const q = filter.toLowerCase();
    document.querySelectorAll('.row').forEach(r => {
      const text = r.textContent?.toLowerCase() ?? '';
      r.classList.toggle('dim', !!q && !text.includes(q) && !(r.getAttribute('data-sha') || '').startsWith(q));
    });
  });

  let dragging = '';
  document.addEventListener('dragstart', e => {
    const el = /** @type {HTMLElement} */ (e.target).closest?.('[data-drag]');
    if (!el) return;
    dragging = /** @type {HTMLElement} */ (el).dataset.drag || '';
    e.dataTransfer?.setData('text/plain', dragging);
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragend', () => {
    dragging = '';
    document.body.classList.remove('dragging');
    document.querySelectorAll('.drop-over').forEach(x => x.classList.remove('drop-over'));
  });
  document.addEventListener('dragover', e => {
    const el = /** @type {HTMLElement} */ (e.target).closest?.('[data-drop]');
    if (!el || !dragging || /** @type {HTMLElement} */ (el).dataset.drop === dragging) return;
    e.preventDefault();
    document.querySelectorAll('.drop-over').forEach(x => x !== el && x.classList.remove('drop-over'));
    el.classList.add('drop-over');
  });
  document.addEventListener('drop', e => {
    const el = /** @type {HTMLElement} */ (e.target).closest?.('[data-drop]');
    if (!el || !dragging) return;
    e.preventDefault();
    const target = /** @type {HTMLElement} */ (el).dataset.drop;
    if (target && target !== dragging) send('mergeBranches', { source: dragging, target });
  });

  // menu de contexto próprio (o do VS Code não sabe nada de branches)
  const menu = document.createElement('div');
  menu.className = 'menu';
  document.body.appendChild(menu);
  function hideMenu(t) {
    if (!t || !menu.contains(t)) menu.style.display = 'none';
  }
  document.addEventListener('contextmenu', e => {
    const t = /** @type {HTMLElement} */ (e.target);
    const local = /** @type {HTMLElement|null} */ (t.closest('[data-menu]'));
    const remote = /** @type {HTMLElement|null} */ (t.closest('[data-menu-remote]'));
    const row = /** @type {HTMLElement|null} */ (t.closest('.row'));
    const items = [];
    if (local && local.dataset.menu) {
      const b = local.dataset.menu;
      const wt = state.worktrees.find(w => w.branch === b);
      const isBase = b === state.base;
      items.push(`<div class="menu-title">${esc(b)}</div>`);
      if (!isBase) {
        items.push(item('mergeBaseInto', `↓ Trazer ${state.baseRef} para cá`, { branch: b }));
        items.push(item('mergeIntoBase', `↑ Mesclar em ${state.base}`, { branch: b }));
      }
      items.push(item('mergeInto', 'Mesclar em…', { branch: b }));
      items.push('<hr>');
      if (wt) {
        for (const a of state.agentNames || []) items.push(item('launchAgent', `✦ ${a}`, { path: wt.path, branch: b, agent: a }, 'agent'));
        if ((state.agentNames || []).length) items.push('<hr>');
        items.push(item('openWorktree', 'Abrir worktree em nova janela', { path: wt.path }));
        items.push(item('openFile', 'Buscar arquivo nesta worktree…', { path: wt.path }));
        items.push(item('openTerminal', 'Abrir terminal', { path: wt.path }));
      } else {
        items.push(item('createWorktree', 'Criar worktree desta branch', { existing: b }));
      }
      items.push(item('createWorktree', 'Nova branch + worktree a partir daqui', { startPoint: b }));
      if (!isBase) items.push(item('diffWithBase', `Revisar alterações × ${state.base}`, { branch: b }));
      if (!isBase) {
        items.push('<hr>');
        if (wt) items.push(item('togglePause', wt.paused ? 'Retomar sync' : 'Pausar sync', { branch: b }));
        items.push(wt ? item('removeWorktree', 'Remover worktree…', { branch: b }, 'danger') : item('deleteBranch', 'Excluir branch…', { branch: b }, 'danger'));
      }
    } else if (remote && remote.dataset.menuRemote) {
      const r = remote.dataset.menuRemote;
      items.push(`<div class="menu-title">${esc(r)}</div>`);
      items.push(item('mergeInto', 'Mesclar em…', { branch: r }));
      items.push(item('createWorktree', 'Nova branch + worktree a partir daqui', { startPoint: r }));
    } else if (row && row.dataset.sha) {
      const sha = row.dataset.sha;
      items.push(`<div class="menu-title">${sha.slice(0, 10)}</div>`);
      items.push(item('copy', 'Copiar hash', { text: sha }));
      items.push(item('createWorktree', 'Nova branch + worktree a partir deste commit', { startPoint: sha }));
    }
    if (!items.length) return;
    e.preventDefault();
    menu.innerHTML = items.join('');
    menu.style.display = 'block';
    const x = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8);
    const y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8);
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  });
  function item(action, label, args, cls = '') {
    const data = Object.entries(args)
      .map(([k, v]) => `data-${k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())}="${esc(v)}"`)
      .join(' ');
    return `<div class="menu-item ${cls}" data-action="${action}" ${data}>${esc(label)}</div>`;
  }
  document.addEventListener('keydown', e => e.key === 'Escape' && hideMenu(null));
  window.addEventListener('blur', () => hideMenu(null));

  // usado pelos prints da documentação (docs/make-prints.mjs)
  // @ts-ignore
  window.__wtgraphSetState = s => {
    state = s;
    render();
  };

  vscode.postMessage({ type: 'ready' });
})();
