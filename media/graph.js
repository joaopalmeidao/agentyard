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
  /** Layout do painel (fica guardado pelo VS Code entre recargas do webview). */
  // Padrão: abas, abrindo no Histórico. A escolha do usuário fica no VS Code (mensagem 'saveUi').
  const ui = Object.assign({ layout: 'tabs', split: 46, tab: 'b' }, (vscode.getState() || {}).ui);
  delete ui.histMode; // havia dois modos de histórico; agora é um só
  const saveUi = () => {
    vscode.setState({ ...(vscode.getState() || {}), ui });
    vscode.postMessage({ type: 'saveUi', ui: { ...ui } });
  };
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
    } else if (m.type === 'ui') {
      if (m.ui) {
        Object.assign(ui, m.ui);
        vscode.setState({ ...(vscode.getState() || {}), ui });
        if (state) render();
      }
    } else if (m.type === 'commitDetails') {
      if (expanded && expanded.sha === m.sha) {
        expanded.details = m.details;
        expanded.error = m.error;
        const box = document.querySelector('.commit-details');
        if (box) box.innerHTML = detailsHtml(expanded);
      }
    } else if (m.type === 'demo') {
      demo(m);
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
  const defaultY = row => row * ROW + ROW / 2;

  function edgePath(e, Y = defaultY) {
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
  // O que já está na tela, para só trocar o pedaço que mudou (o grafo é a parte cara).
  let skeletonKey = '';
  let topHtml = '';
  let paneAHtml = '';
  let graphKey = '';

  /** Muda quando algo que o grafo mostra muda; o minuto entra para os "há 5 min" não envelhecerem. */
  function graphKeyOf() {
    const shown = new Set();
    for (const c of state.commits) for (const r of c.refs) if (r.kind === 'head') shown.add(r.name);
    return JSON.stringify([
      Math.floor(Date.now() / 60000),
      filter,
      state.graphFilter,
      expanded ? expanded.sha : '',
      state.graphBranches || [],
      state.showRemotes,
      (state.ciBranches || []).map(b => b.name + b.sources.join('+')),
      state.headSha || '',
      state.graphFilter === 'ci' && !state.pending ? (state.flow || []).map(f => f.pending + ':' + f.hotfix) : '',
      state.graphFilter === 'ci' ? Object.entries(state.pipelines || {}).map(([k, p]) => k + p.status) : '',
      state.base,
      state.unmerged,
      state.commits.map(c => c.sha + c.refs.map(r => r.name + (r.current ? '*' : '')).join(',')),
      state.worktrees.filter(w => w.changes && w.head).map(w => w.head + ':' + w.changes),
      [...shown].map(n => n + ':' + (state.pending ? '' : aheadOf(n)) + ':' + (requestOf(n) ? requestOf(n).ref + requestOf(n).state + (requestOf(n).review ? requestOf(n).review.state + requestOf(n).review.approvals : '') : '')),
    ]);
  }

  function render() {
    if (!state) {
      app.innerHTML = '<div class="empty">Nenhum repositório git aberto neste workspace.</div>';
      skeletonKey = '';
      return;
    }
    const focused = document.activeElement?.id;
    const sk = `${ui.layout}|${ui.tab}`;
    if (sk !== skeletonKey || !document.querySelector('.split')) {
      app.innerHTML = `<div id="top"></div>
        <div class="split layout-${ui.layout} ${ui.layout === 'tabs' ? `show-${ui.tab}` : ''}" style="--split:${ui.split}%">
          <div class="pane pane-a"></div>
          <div class="splitter" title="Arraste para redimensionar"></div>
          <div class="pane pane-b"></div>
        </div>`;
      skeletonKey = sk;
      topHtml = paneAHtml = graphKey = '';
    }
    const tab = ui.layout === 'tabs' ? `<nav class="tabs">
        <button data-local="tab" data-tab="a" class="${ui.tab === 'a' ? 'on' : ''}">Worktrees</button>
        <button data-local="tab" data-tab="b" class="${ui.tab === 'b' ? 'on' : ''}">Histórico</button></nav>` : '';
    const top = toolbar() + tab;
    if (top !== topHtml) {
      /** @type {HTMLElement} */ (document.getElementById('top')).innerHTML = top;
      topHtml = top;
    }
    const a = flowSection() + worktreesSection() + branchesSection();
    if (a !== paneAHtml) {
      const pane = /** @type {HTMLElement} */ (document.querySelector('.pane-a'));
      const y = pane.scrollTop;
      pane.innerHTML = a;
      pane.scrollTop = y;
      paneAHtml = a;
    }
    const gk = graphKeyOf();
    if (gk !== graphKey) {
      const pane = /** @type {HTMLElement} */ (document.querySelector('.pane-b'));
      const y = pane.scrollTop;
      pane.innerHTML = graphSection();
      pane.scrollTop = y;
      graphKey = gk;
    }
    for (const [id, value] of [['filter', filter], ['wtfilter', wtFilter]]) {
      const f = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
      if (!f) continue;
      f.value = value;
      if (focused === id) {
        f.focus();
        f.setSelectionRange(value.length, value.length);
      }
    }
  }

  function toolbar() {
    const s = state.autoSync;
    return `<header class="toolbar">
      <div class="title"><button class="repo" data-action="switchProject" title="${esc(state.root)} · trocar de projeto">${esc(state.repoName)} ▾</button>
        <span class="muted">base</span> <span class="ref ref-base">${esc(state.baseRef)}</span></div>
      <div class="tools">
        <button data-action="createWorktree" class="primary">＋ Nova worktree</button>
        <button data-action="toggleAutoSync" class="${s.enabled ? 'on' : ''}" title="Mescla a base automaticamente nas worktrees limpas">
          ⟳ Sync ${s.enabled ? (s.mode === 'notify' ? 'ligado (avisar)' : 'ligado') : 'desligado'}</button>
        <button data-action="chooseSyncWhere" title="Escolher onde o sync roda: só local, só CI (GitHub Actions/GitLab CI), dividido ou ambos">onde: ${{ local: 'local', github: 'só CI', split: 'dividido', both: 'local + CI' }[s.where] || 'local'}</button>
        <button data-action="syncNow" title="Roda o sync uma vez agora">Sincronizar agora</button>
        ${toPull() ? `<button data-action="pullMany" title="Trazer do remoto as branches com novidades (lista para escolher)">☁↓ Trazer ${toPull()}</button>` : ''}
        ${toPush() ? `<button data-action="pushMany" title="Enviar branches com commits não enviados (lista para escolher)">☁↑ Enviar ${toPush()}</button>` : ''}
        <button data-action="activity" title="Commits, sessões e tokens do dia por worktree, e custo por tarefa">Atividade</button>
        <button data-action="timeline" title="Quando cada branch nasceu, virou PR/MR e foi mesclada">Linha do tempo</button>
        <button data-action="generateCi" title="Gera o workflow de sync para o GitHub Actions ou o GitLab CI">Gerar CI</button>
        ${state.hosting && !state.hosting.connected ? `<button data-action="connectHosting" title="Para publicar e acompanhar ${state.hosting.label}s em ${esc(state.hosting.host)}">Conectar ${esc(state.hosting.name || state.hosting.kind)}</button>` : ''}
        <span class="layouts" title="Layout do painel">
          <button data-local="layout" data-layout="rows" class="${ui.layout === 'rows' ? 'on' : ''}" title="Empilhado: worktrees em cima, histórico embaixo">⬒</button>
          <button data-local="layout" data-layout="cols" class="${ui.layout === 'cols' ? 'on' : ''}" title="Lado a lado">◫</button>
          <button data-local="layout" data-layout="tabs" class="${ui.layout === 'tabs' ? 'on' : ''}" title="Abas">▭</button>
        </span>
        <button data-action="refresh" title="Atualizar">↻</button>
      </div>
      ${progressBar()}
    </header>
    ${state.error ? `<div class="error">${esc(state.error)}</div>` : ''}`;
  }

  /** Faixa dev → QA → homologação → produção, com o que espera promoção entre cada par. */
  function flowSection() {
    const f = state.flow;
    if (!f || !f.length) {
      return `<div class="flow-empty"><button class="link" data-action="configureFlow" title="Branches de ambiente em ordem de promoção">＋ Configurar fluxo de ambientes (dev → QA → homologação → produção)</button></div>`;
    }
    const L = state.hosting ? state.hosting.label : 'PR';
    const stage = (s, date) => `<div class="stage" data-menu="${esc(s.branch)}" data-drop="${esc(s.branch)}">
        <span class="stage-label">${esc(s.label)}</span>
        <span class="ref ref-head ${s.branch === state.base ? 'ref-base' : ''}">${esc(s.branch)}</span>
        <span class="muted">${date ? ago(date) : ''}</span>
        ${pipelineFor(s.branch) ? pipelineChip(pipelineFor(s.branch)) : ''}</div>`;
    const reqFor = (from, to) => {
      const r = (state.worktrees.find(w => w.branch === from) || state.branches.find(b => b.name === from) || {}).request;
      return r && r.target === to ? r : undefined;
    };
    let html = stage(f[0].from, f[0].fromDate);
    for (const s of f) {
      const req = reqFor(s.from.branch, s.to.branch);
      html += `<div class="step">
        ${!s.fromExists || !s.toExists
          ? `<span class="chip bad">branch ${esc(!s.fromExists ? s.from.branch : s.to.branch)} não existe</span>`
          : `<span class="arrow">→</span>
             ${s.pending ? `<span class="chip info" title="${s.pending} commit(s) de ${esc(s.from.branch)} ainda não estão em ${esc(s.to.branch)}">↑${s.pending} para promover</span>` : `<span class="chip ok">em dia</span>`}
             ${s.hotfix ? `<span class="chip warn" title="${s.hotfix} commit(s) feitos direto em ${esc(s.to.branch)} que ${esc(s.from.branch)} não tem (hotfix?)">↓${s.hotfix} só em ${esc(s.to.label)}</span>` : ''}
             ${req ? requestChip(req) : ''}
             <span class="step-actions">
               <button data-action="promote" data-from="${esc(s.from.branch)}" data-to="${esc(s.to.branch)}" ${s.pending ? '' : 'disabled'} title="${L}, análise ou merge de ${esc(s.from.branch)} em ${esc(s.to.branch)}">Promover</button>
               ${s.hotfix ? `<button data-action="mergeBranches" data-source="${esc(s.to.branch)}" data-target="${esc(s.from.branch)}" title="Mesclar ${esc(s.to.branch)} em ${esc(s.from.branch)} (back-merge)">↓ Trazer</button>` : ''}
             </span>`}
      </div>${stage(s.to, s.toDate)}`;
    }
    return `<section class="flow"><h2>Fluxo de ambientes <button class="link" data-action="configureFlow">editar</button></h2><div class="flow-strip">${html}</div></section>`;
  }

  /** Progresso do detalhamento: some quando todas as worktrees têm status e comparação. */
  function progressBar() {
    const total = state.worktrees.filter(w => !w.prunable && !w.bare).length;
    if (!state.pending || !total) return '';
    const done = total - state.pending;
    return `<div class="progress" title="git status e comparação com ${esc(state.baseRef)}, das mais recentes para as mais antigas">
      <div class="bar"><div style="width:${Math.round((done / total) * 100)}%"></div></div>
      <span>Detalhando worktrees: ${done} de ${total}</span></div>`;
  }

  function claudeChip(w) {
    const c = w.claude;
    return `<span class="chip agent link" data-action="claudeResumeLast" data-id="${esc(c.lastId)}" title="${c.sessions} sessão(ões) do Claude Code nesta worktree, ${fmtTokens(c.tokens)} tokens; última ${ago(c.last / 1000)}. Clique para retomar a última.">✦ ${c.sessions} · ${fmtTokens(c.tokens)}${c.usd !== undefined ? ` · ≈US$ ${c.usd.toFixed(2).replace('.', ',')}` : ''}</span>`;
  }
  const fmtTokens = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} mi` : n >= 1e3 ? `${Math.round(n / 1e3)} mil` : String(n));

  /** Situação no remoto: não publicada, ↑ a enviar, ↓ a receber, ou em dia. */
  function remoteChip(w) {
    const r = w.remote || {};
    if (w.isBase && r.published && !r.ahead && !r.behind) return '';
    if (r.gone) return chip('☁ apagada no remoto', 'warn', 'O upstream desta branch não existe mais no remoto');
    if (!r.published) return w.isBase ? '' : chip('☁ não publicada', 'muted', 'Ainda não existe no remoto; Publicar faz o push -u');
    const parts = [r.ahead ? `↑${r.ahead}` : '', r.behind ? `↓${r.behind}` : ''].filter(Boolean).join(' ');
    return parts ? chip(`☁ ${parts}`, r.ahead ? 'warn' : 'info', `${r.ahead} commit(s) a enviar · ${r.behind} a receber de ${w.upstream}`) : chip('☁ em dia', 'ok', `Em dia com ${w.upstream}`);
  }

  function pushButton(branch, r, compact) {
    const label = !r.published ? (compact ? '☁ publicar' : '☁ Publicar') : compact ? `☁↑${r.ahead}` : `☁ Push ↑${r.ahead}`;
    return `<button data-action="push" data-branch="${esc(branch)}" title="${!r.published ? 'git push -u (cria a branch no remoto)' : `Enviar ${r.ahead} commit(s)`}">${label}</button>`;
  }

  function pullButton(branch, behind, compact) {
    return `<button data-action="pullBranch" data-branch="${esc(branch)}" title="Trazer ${behind} commit(s) do remoto (fast-forward; se divergir, pergunta merge ou rebase)">${compact ? `☁↓${behind}` : `☁↓ Trazer ${behind}`}</button>`;
  }

  /** Branches publicadas com commits no remoto que ainda não estão aqui. */
  function toPull() {
    return [...state.worktrees.filter(w => w.branch && !w.prunable), ...state.branches].filter(x => x.remote && x.remote.published && x.remote.behind > 0).length;
  }

  /** Branches publicadas com commits pendentes de envio. */
  function toPush() {
    return [...state.worktrees.filter(w => w.branch && !w.prunable), ...state.branches].filter(x => x.remote && x.remote.published && x.remote.ahead > 0).length;
  }

  const pipelineFor = b => (state.pipelines || {})[b];

  /** Último pipeline da branch: ✓/✗/⟳ com cor; clique abre no navegador; falha oferece o agente. */
  function pipelineChip(p, compact) {
    const map = {
      success: ['✓', 'ok', 'passou'], failed: ['✗', 'bad', 'falhou'], running: ['⟳', 'info', 'rodando'], queued: ['…', 'muted', 'na fila'],
      canceled: ['⊘', 'muted', 'cancelado'], skipped: ['↷', 'muted', 'pulado'], manual: ['▶', 'warn', 'aguardando ação manual'],
    };
    const [sym, cls, txt] = map[p.status] || ['?', 'muted', p.status];
    const main = `<span class="chip ${cls} link" data-action="openUrl" data-url="${esc(p.url)}" title="${esc(p.name)}: ${txt} — abrir no navegador">${sym} CI${compact ? '' : ` ${txt}`}</span>`;
    const fix = p.status === 'failed' && !compact
      ? `<span class="chip agent link" data-action="fixPipeline" data-id="${p.id}" title="Abrir o agente na worktree com o log da falha">✦ corrigir</span>`
      : '';
    return main + fix;
  }

  /** Revisão do PR/MR: aprovado, mudanças pedidas, comentado, aguardando, conversas abertas. */
  function reviewInfo(r) {
    if (r.state === 'draft') return ['rascunho', 'muted', 'rascunho: ainda não pede revisão'];
    if (r.state === 'merged') return ['mesclado', 'ok', 'mesclado'];
    if (r.state === 'closed') return ['fechado', 'muted', 'fechado sem mesclar'];
    const v = r.review;
    if (!v) return ['aberto', 'info', 'aberto'];
    const by = v.by && v.by.length ? ` (${v.by.join(', ')})` : '';
    const left = v.approvalsLeft ? `, faltam ${v.approvalsLeft}` : '';
    return {
      approved: [`✓ aprovado${v.approvals > 1 ? ` ×${v.approvals}` : ''}`, 'ok', `aprovado${by}${left}`],
      changes: ['✎ mudanças pedidas', 'bad', `mudanças pedidas${by}`],
      discussions: ['💬 conversas abertas', 'warn', `há conversas não resolvidas${left}`],
      commented: ['💬 comentado', 'info', `comentado${by}, sem aprovação`],
      pending: [`◷ aguardando revisão${v.approvals ? ` (${v.approvals} ok)` : ''}`, 'muted', `aguardando revisão${by}${left}`],
    }[v.state] || ['aberto', 'info', 'aberto'];
  }

  function overlapChip(w) {
    const o = w.overlap;
    return `<span class="chip warn link" data-action="showOverlaps" data-path="${esc(w.path)}" title="Arquivos em comum com: ${esc(o.with.join(', '))}">⚠ sobrepõe com ${esc(o.with[0])}${o.with.length > 1 ? ` +${o.with.length - 1}` : ''} (${o.files})</span>`;
  }

  function budgetChip(w) {
    const b = w.budget;
    return `<span class="chip ${b.level === 'over' ? 'bad' : 'warn'}" title="Orçamento por worktree (${b.by === 'usd' ? 'US$' : 'tokens'})">${b.level === 'over' ? 'orçamento estourado' : `orçamento ${b.pct}%`}</span>`;
  }

  function requestChip(r) {
    const [txt, cls, tip] = reviewInfo(r);
    return `<span class="chip ${cls} link" data-action="openUrl" data-url="${esc(r.url)}" title="${esc(r.ref)} ${esc(r.title)} — ${esc(tip)}. Clique para abrir no navegador.">${esc(r.ref)} ${txt}</span>`;
  }

  /** PR/MR aberto da branch (worktree ou branch sem worktree). */
  function requestOf(name) {
    const v = state.worktrees.find(w => w.branch === name) || state.branches.find(b => b.name === name);
    return v && v.request;
  }

  /** O agente terminou e deixou commits: clique abre a revisão. */
  function reviewChip(w) {
    return `<span class="chip ok link" data-action="reviewReady" data-path="${esc(w.path)}" data-branch="${esc(w.branch || '')}" title="O agente terminou${w.review.commits ? ` com ${w.review.commits} commit(s) novos` : ''}. Clique para revisar.">✓ pronto para revisar</span>`;
  }

  function tasksChip(w) {
    const t = w.tasks;
    const n = t.waiting + (t.running ? 1 : 0);
    return `<span class="chip info link" data-action="openTasks" title="${t.running ? `Rodando: ${esc(t.running)}\n` : ''}${t.waiting} na fila">☰ ${n} tarefa(s)</span>`;
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
      remote: ['⟳ via GitHub Actions', 'muted'],
      error: ['⟳ erro', 'bad'],
    };
    const [t, c] = map[s.kind] || [s.kind, ''];
    return chip(`${t} · ${ago(s.at / 1000)}`, c, s.message);
  }

  /** Em destaque (card): a principal, as favoritas, as com agente aberto e a desta janela. */
  const featured = w => !w.prunable && (w.isMain || w.favorite || w.isCurrent || (w.agents && w.agents.length > 0) || w.changes > 0 || !!w.operation);
  const starBtn = w =>
    `<button class="star ${w.favorite ? 'on' : ''}" data-action="toggleFavorite" data-path="${esc(w.path)}" title="${w.favorite ? 'Desfavoritar' : 'Favoritar: vira card e sobe na lista'}">${w.favorite ? '★' : '☆'}</button>`;

  function worktreesSection() {
    const all = state.worktrees.filter(w => !w.prunable);
    const cards = all.filter(featured).map(card).join('');
    return `<section>
      <h2>Em destaque <span class="count">${all.filter(featured).length}</span>
        <span class="hint">principal, favoritas (☆), com agente aberto e com trabalho não commitado · arraste um sobre outro para mesclar</span></h2>
      <div class="cards">${cards}</div>
    </section>${tableSection()}`;
  }

  // ---------- tabela compacta ----------
  let wtFilter = '';
  let onlyDirty = false;
  let bySize = false;

  function formatBytes(n) {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) (n /= 1024), i++;
    return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1).replace('.', ',')} ${u[i]}`;
  }

  function sizeChip(sz) {
    return chip(`💾 ${sz.complete ? '' : '≥'}${formatBytes(sz.bytes)}`, 'muted', sz.complete ? 'Espaço em disco (links como node_modules compartilhado não contam)' : 'Contagem interrompida pelo limite de tempo: valor mínimo');
  }
  let rowLimit = 60;

  function tableSection() {
    const rest = state.worktrees.filter(w => !w.prunable && !featured(w));
    const orphans = state.worktrees.filter(w => w.prunable).length;
    if (!rest.length && !orphans) return '';
    return `<section>
      <h2>Todas as worktrees <span class="count">${rest.length}</span>
        ${orphans ? `<button class="link" data-action="pruneWorktrees" title="Pastas que não existem mais (git worktree prune)">${orphans} órfã(s) · remover</button>` : ''}
        ${mergedCount() ? `<button class="link" data-action="removeMerged" title="Worktrees limpas cuja branch já está inteira em ${esc(state.base)} (favoritas, com agente e protegidas ficam de fora)">remover mescladas (${mergedCount()})</button>` : ''}
        <button class="link" data-action="cleanupWorktrees" title="Remover várias de uma vez; já marca as mescladas e limpas">limpar em lote…</button>
        <button class="link ${onlyDirty ? 'on' : ''}" data-local="dirty" title="Mostrar só worktrees com alterações não commitadas">${onlyDirty ? '✓ ' : ''}com alterações (${state.worktrees.filter(w => w.changes > 0).length})</button>
        <button class="link ${bySize ? 'on' : ''}" data-local="bysize" title="Ordenar pelo espaço em disco">${bySize ? '✓ ' : ''}por espaço</button>
        <input id="wtfilter" type="search" placeholder="Filtrar por branch, pasta ou commit" /></h2>
      <div class="table-wrap"><table class="wts"><tbody id="wt-rows">${tableRows()}</tbody></table></div>
    </section>`;
  }

  function tableRows() {
    const q = wtFilter.toLowerCase();
    const rest = state.worktrees.filter(w => !w.prunable && !featured(w));
    const match = rest.filter(w => (!q || `${w.name} ${w.path} ${w.subject}`.toLowerCase().includes(q)) && (!onlyDirty || w.changes > 0));
    if (bySize) match.sort((a, b) => ((b.size && b.size.bytes) || 0) - ((a.size && a.size.bytes) || 0));
    const agent = state.agentNames && state.agentNames[0];
    const rows = match.slice(0, rowLimit).map(w => {
      const b = esc(w.branch || '');
      const st = !w.statusKnown ? chip('…', 'muted', 'lendo status') : w.operation ? chip(esc(w.operation), 'bad') : w.changes ? chip(`● ${w.changes}`, 'warn', 'alterações não commitadas') : chip('✓', 'ok', 'limpa');
      const cmp = !w.compareKnown
        ? chip('…', 'muted', 'comparando com a base')
        : w.behind || w.ahead
          ? chip(arrows(w.behind, w.ahead), w.behind ? 'info' : 'muted', `${w.behind} atrás · ${w.ahead} à frente de ${state.baseRef}`)
          : chip('=', 'muted', `igual a ${state.baseRef}`);
      const conf = w.preview?.conflict
        ? chip('⚠', 'bad', `conflita com ${state.base}: ${w.preview.files.join(', ')}`) +
          (agent ? `<button class="agent mini" data-action="resolveConflict" data-branch="${b}" title="Resolver com ${esc(agent)}: traz ${esc(state.base)} e resolve os conflitos">✦ resolver</button>` : '')
        : '';
      return `<tr class="${w.changes ? 'dirty' : ''}" draggable="true" data-drag="${b}" data-drop="${b}" data-menu="${b}">
        <td class="c-star">${starBtn(w)}</td>
        <td class="c-name"><span class="branch">${esc(w.name)}</span><div class="path" title="${esc(w.path)}">${esc(w.path)}</div></td>
        <td class="c-chips">${w.size ? sizeChip(w.size) : ''}${w.review ? reviewChip(w) : ''}${w.tasks ? tasksChip(w) : ''}${st}${cmp}${conf}${w.remote.ahead || !w.remote.published ? remoteChip(w) : ''}${w.request ? requestChip(w.request) : ''}${w.overlap ? overlapChip(w) : ''}${w.budget ? budgetChip(w) : ''}${w.branch && pipelineFor(w.branch) ? pipelineChip(pipelineFor(w.branch), true) : ''}${w.sync && state.autoSync.enabled ? syncChip(w) : ''}</td>
        <td class="subject" title="${esc(w.subject)}">${esc(w.subject)} <span class="muted">${ago(w.date)}</span></td>
        <td class="row-actions">
          ${agent ? `<button class="agent" data-action="launchAgent" data-path="${esc(w.path)}" data-branch="${b}" data-agent="${esc(agent)}" title="Abrir ${esc(agent)} nesta worktree">✦</button>` : ''}
          ${w.remote.ahead || !w.remote.published ? pushButton(w.branch, w.remote, true) : ''}
          ${w.remote.published && w.remote.behind ? pullButton(w.branch, w.remote.behind, true) : ''}
          <button data-action="openWorktree" data-path="${esc(w.path)}" title="Abrir em nova janela">Abrir</button>
          <button data-action="diffWithBase" data-branch="${b}" title="Revisar alterações × ${esc(state.base)}">Revisar</button>
          <button data-action="analyzeMerge" data-branch="${b}" title="Analisar o merge em ${esc(state.base)}">Analisar</button>
          <button data-action="mergeBaseInto" data-branch="${b}" ${w.behind ? '' : 'disabled'} title="Trazer ${esc(state.baseRef)}">↓</button>
          <button data-action="mergeIntoBase" data-branch="${b}" ${w.ahead ? '' : 'disabled'} title="Mesclar em ${esc(state.base)}">↑</button>
          <button data-action="removeWorktree" data-branch="${b}" class="danger" title="Remover worktree">✕</button>
        </td></tr>`;
    });
    if (match.length > rowLimit) rows.push(`<tr><td colspan="5" class="more"><button data-local="more">Mostrar mais ${Math.min(60, match.length - rowLimit)} de ${match.length - rowLimit}</button></td></tr>`);
    if (!match.length) rows.push(`<tr><td colspan="5" class="muted">Nenhuma worktree com “${esc(wtFilter)}”.</td></tr>`);
    return rows.join('');
  }

  function card(w) {
        const b = esc(w.branch || '');
        const chips = [];
        if (w.bare) chips.push(chip('bare', 'muted'));
        if (w.operation) chips.push(chip(`${esc(w.operation)} em andamento`, 'bad'));
        chips.push(!w.statusKnown ? chip('… lendo status', 'muted') : w.changes ? chip(`● ${w.changes} não commitada(s)`, 'warn') : chip('✓ limpa', 'ok'));
        if (!w.compareKnown) chips.push(chip('… comparando', 'muted'));
        else if (!w.isBase && w.branch) {
          if (w.behind === 0 && w.ahead === 0) chips.push(chip(`= ${esc(state.baseRef)}`, 'muted'));
          else chips.push(chip(arrows(w.behind, w.ahead), w.behind ? 'info' : 'muted', `${w.behind} commit(s) da base que faltam aqui · ${w.ahead} commit(s) desta branch que a base não tem`));
          if (w.preview) chips.push(w.preview.conflict ? chip(`⚠ conflita com ${esc(state.base)}`, 'bad', w.preview.files.join('\n')) : chip('merge limpo', 'ok'));
        } else if (w.isBase && (w.behind || w.ahead)) {
          chips.push(chip(`${arrows(w.behind, w.ahead)} ${esc(state.baseRef)}`, 'info'));
        }
        if (w.branch) chips.push(remoteChip(w));
        if (w.branch) chips.push(syncChip(w));
        if (w.agents && w.agents.length) chips.push(chip(`✦ ${w.agents.map(esc).join(', ')}`, 'agent', 'Terminal de agente aberto nesta worktree'));
        if (w.review) chips.push(reviewChip(w));
        if (w.tasks) chips.push(tasksChip(w));
        if (w.request) chips.push(requestChip(w.request));
        if (w.overlap) chips.push(overlapChip(w));
        if (w.budget) chips.push(budgetChip(w));
        if (w.branch && pipelineFor(w.branch)) chips.push(pipelineChip(pipelineFor(w.branch)));
        if (w.claude) chips.push(claudeChip(w));
        if (w.port) chips.push(`<span class="chip info link" data-action="env.openBrowser" data-path="${esc(w.path)}" data-branch="${b}" title="Porta desta worktree; clique para abrir http://localhost:${w.port}">🌐 :${w.port}</span>`);
        if (w.size) chips.push(sizeChip(w.size));

        const agent = state.agentNames && state.agentNames[0];
        const act = [
          agent && !w.bare && !w.prunable
            ? `<button data-action="launchAgent" data-path="${esc(w.path)}" data-branch="${b}" data-agent="${esc(agent)}" class="agent" title="Abre ${esc(agent)} num terminal dentro desta worktree (botão direito no card para outros agentes)">✦ ${esc(agent)}</button>`
            : '',
          w.branch && (w.remote.ahead || !w.remote.published) && !w.prunable ? pushButton(w.branch, w.remote) : '',
          w.branch && w.remote.published && w.remote.behind && !w.prunable ? pullButton(w.branch, w.remote.behind) : '',
          `<button data-action="openWorktree" data-path="${esc(w.path)}" title="Abrir em nova janela">Abrir</button>`,
          `<button data-action="openFile" data-path="${esc(w.path)}" title="Buscar e abrir um arquivo desta worktree aqui mesmo">Arquivos</button>`,
          `<button data-action="openTerminal" data-path="${esc(w.path)}" title="Terminal nesta pasta">Terminal</button>`,
        ].filter(Boolean);
        if (w.branch && !w.isBase) {
          act.push(`<button data-action="diffWithBase" data-branch="${b}" title="Arquivos alterados desde que saiu da base">Revisar</button>`);
          act.push(`<button data-action="analyzeMerge" data-branch="${b}" title="Simular o merge em ${esc(state.base)}: commits, arquivos e conflitos">Analisar</button>`);
          if (w.request && (w.request.state === 'open' || w.request.state === 'draft'))
            act.push(`<button class="agent" data-action="reviewWithAgent" data-branch="${b}" title="O agente revisa o ${esc(w.request.ref)} e você escolhe o que postar">✦ Revisar ${esc(w.request.ref)}</button>`);
          if (w.preview?.conflict && agent) act.unshift(`<button data-action="resolveConflict" data-branch="${b}" class="agent" title="Abre ${esc(agent)} nesta worktree com a tarefa de trazer ${esc(state.base)} e resolver os conflitos">✦ Resolver com ${esc(agent)}</button>`);
          if (state.hosting && !w.request && w.ahead) act.push(`<button data-action="publishRequest" data-branch="${b}" title="Push + ${state.hosting.label} para ${esc(state.base)}">Publicar ${state.hosting.label}</button>`);
          act.push(`<button data-action="mergeBaseInto" data-branch="${b}" ${w.behind ? '' : 'disabled'} title="git merge ${esc(state.baseRef)}">↓ Trazer ${esc(state.base)}</button>`);
          act.push(`<button data-action="mergeIntoBase" data-branch="${b}" class="primary" ${w.ahead ? '' : 'disabled'} title="Mesclar em ${esc(state.base)}">↑ Mesclar em ${esc(state.base)}</button>`);
          act.push(`<button data-action="togglePause" data-branch="${b}" title="${w.paused ? 'Retomar' : 'Pausar'} o sync automático desta branch">${w.paused ? 'Retomar sync' : 'Pausar sync'}</button>`);
          act.push(`<button data-action="removeWorktree" data-branch="${b}" class="danger" title="Remover worktree (pede confirmação)">Remover</button>`);
        }
        const cls = ['card', w.isCurrent ? 'current' : '', w.isBase ? 'base' : '', w.preview?.conflict || w.operation ? 'conflict' : w.changes ? 'dirty' : ''].join(' ');
        return `<div class="${cls}" ${w.branch ? `draggable="true" data-drag="${b}" data-drop="${b}"` : ''} data-menu="${b}">
          <div class="card-head">
            ${w.isMain ? '' : starBtn(w)}
            <span class="branch">${esc(w.name)}</span>
            ${w.isBase ? '<span class="tag">base</span>' : ''}
            ${w.branch && isProtected(w.branch) ? '<span class="tag" title="Branch protegida: merge e push direto pedem confirmação ou PR/MR">🔒 protegida</span>' : ''}
            ${w.isMain ? '<span class="tag">principal</span>' : ''}
            ${w.isCurrent ? '<span class="tag accent">esta janela</span>' : ''}
          </div>
          <div class="path" title="${esc(w.path)}">${esc(w.path)}</div>
          <div class="chips">${chips.join('')}</div>
          <div class="last" title="${esc(w.subject)}">${esc(w.subject || '—')} <span class="muted">${ago(w.date)}</span></div>
          <div class="actions">${act.join('')}</div>
        </div>`;
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

  function aheadOf(name) {
    const v = state.worktrees.find(w => w.branch === name) || state.branches.find(b => b.name === name);
    return v && v.compareKnown ? v.ahead : 0;
  }

  const isProtected = name => (state.protectedBranches || []).includes(name);

  /** Mesma regra de actions.mergedWorktrees (a pasta desta janela é conferida na hora de remover). */
  function mergedCount() {
    return state.worktrees.filter(
      w => !w.isMain && !w.isBase && !w.bare && !w.prunable && w.branch && !isProtected(w.branch) && !w.isCurrent &&
        w.compareKnown && w.ahead === 0 && !w.favorite && !(w.agents && w.agents.length) &&
        w.statusKnown && w.changes === 0 && !w.operation,
    ).length;
  }

  function badge(r) {
    const cls = { head: 'ref-head', remote: 'ref-remote', tag: 'ref-tag', detached: 'ref-detached' }[r.kind];
    const base = r.name === state.base && r.kind === 'head' ? ' ref-base' : '';
    const wt = r.worktree ? ' ref-wt' : '';
    const cur = r.current ? ' ref-current' : '';
    const drag = r.kind === 'head' || r.kind === 'remote' ? `draggable="true" data-drag="${esc(r.name)}"` : '';
    const drop = r.kind === 'head' ? `data-drop="${esc(r.name)}" data-menu="${esc(r.name)}"` : r.kind === 'remote' ? `data-menu-remote="${esc(r.name)}"` : '';
    const pending = r.kind === 'head' && r.name !== state.base ? state.unmerged.includes(r.name) : undefined;
    const ahead = pending ? aheadOf(r.name) : 0;
    const merged = pending === false ? ' ref-merged' : '';
    const title = r.kind === 'head' ? `${r.worktree ? 'branch com worktree' : 'branch local'}${pending ? ` · ${ahead || 'com'} commit(s) fora de ${state.base}` : pending === false ? ` · já mesclada em ${state.base}` : ''}` : r.kind;
    const req = r.kind === 'head' ? requestOf(r.name) : undefined;
    const lock = r.kind === 'head' && isProtected(r.name) ? '🔒 ' : '';
    return `<span class="ref ${cls}${base}${wt}${cur}${merged}${pending ? ' ref-pending' : ''}" ${drag} ${drop} title="${esc(title)}${lock ? ' · protegida' : ''}">${lock}${r.worktree ? '▣ ' : ''}${esc(r.name)}${ahead ? ` <b>↑${ahead}</b>` : ''}</span>${req ? requestChip(req) : ''}`;
  }

  function graphHeader(n, extra = '') {
    const f = state.graphFilter;
    const sel = state.graphBranches || [];
    const controls = `<div class="hist-controls">
        ${f === 'all' ? `<button class="branch-picker-btn" data-local="branchPicker" title="Escolher quais branches o histórico mostra">Branches: <b>${sel.length ? (sel.length === 1 ? esc(sel[0]) : `${sel.length} escolhidas`) : 'Mostrar todas'}</b> ▾</button>` : ''}
        ${f === 'all' ? `<label class="check"><input type="checkbox" data-local="showRemotes" ${state.showRemotes ? 'checked' : ''}> Mostrar branches remotas</label>` : ''}
        <button data-action="refresh" title="Atualizar">↻</button>
        <input id="filter" type="search" placeholder="Filtrar por mensagem, autor, hash ou branch" />
      </div>`;
    return `<div class="graph-head-wrap"><h2 class="graph-head">Histórico <span class="count">${n}</span>
      <span class="seg" title="O que o grafo mostra">
        <button data-action="setGraphFilter" data-value="all" class="${f === 'all' ? 'on' : ''}">Tudo</button>
        <button data-action="setGraphFilter" data-value="unmerged" class="${f === 'unmerged' ? 'on' : ''}" title="Só commits de branches e worktrees que ainda não entraram em ${esc(state.base)}">Não mescladas <b>${state.unmerged.length}</b></button>
        <button data-action="setGraphFilter" data-value="ci" class="${f === 'ci' ? 'on' : ''}" title="Só as branches que o CI usa: fluxo de ambientes, base, arquivos de CI e worktreeGraph.ciBranches">CI</button>
      </span></h2>${controls}${f === 'ci' ? ciStrip() : ''}${extra}</div>`;
  }

  /** Filtro CI: as branches achadas, de onde vieram e o que espera promoção entre os estágios. */
  function ciStrip() {
    const list = state.ciBranches || [];
    if (!list.length)
      return `<div class="ci-strip muted">Nenhuma branch de CI encontrada. <button class="link" data-action="openCiBranchesSettings">configurar…</button></div>`;
    const step = (from, to) => (state.flow || []).find(s => s.from.branch === from && s.to.branch === to);
    const parts = list.map((b, i) => {
      const next = list[i + 1];
      const s = next ? step(b.name, next.name) : undefined;
      const p = pipelineFor(b.name);
      return `<span class="ci-branch" title="${esc(b.name)} — ${esc(b.sources.join(', '))}">
          <span class="ref ref-head ${b.name === state.base ? 'ref-base' : ''}">${esc(b.name)}</span>${p ? pipelineChip(p, true) : ''}</span>${
        s && !state.pending
          ? `<span class="ci-arrow" title="${s.pending} commit(s) de ${esc(s.from.branch)} esperam promoção para ${esc(s.to.branch)}${s.hotfix ? `; ${s.hotfix} só em ${esc(s.to.branch)}` : ''}">→ ${s.pending ? `<b>↑${s.pending}</b>` : '✓'}${s.hotfix ? ` <span class="warn">↓${s.hotfix}</span>` : ''} →</span>`
          : next ? '<span class="ci-sep">·</span>' : ''
      }`;
    });
    return `<div class="ci-strip">${parts.join('')} <button class="link" data-action="openCiBranchesSettings" title="Branches extras (worktreeGraph.ciBranches)">configurar…</button></div>`;
  }

  function graphSection() {
    return historySection();
  }

  // ---------- histórico: colunas e detalhes do commit ao clicar ----------
  /** Commit com o painel de detalhes aberto: { sha, details?, error? }. */
  let expanded = null;
  const GAP = 250;

  /** Commits com as linhas de "alterações não commitadas" inseridas acima do HEAD de cada worktree. */
  function withWip(commits) {
    const wip = [];
    state.worktrees.forEach((w, i) => {
      if (!w.changes || !w.head) return;
      const at = commits.findIndex(c => c.sha === w.head);
      if (at >= 0) wip.push({ at, c: { sha: `wip-${i}`, parents: [w.head], author: '', date: Date.now() / 1000, subject: `Alterações não commitadas em ${w.name}: ${w.changes} arquivo(s)`, refs: [], wip: true, branch: w.branch, path: w.path } });
    });
    if (!wip.length) return commits;
    const out = commits.slice();
    wip.sort((a, b) => b.at - a.at).forEach(x => out.splice(x.at, 0, x.c));
    return out;
  }

  const fullDate = unix =>
    new Date(unix * 1000).toLocaleString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  /** "main" e "origin/main" no mesmo commit viram uma etiqueta só. */
  function groupedBadges(refs) {
    const heads = refs.filter(r => r.kind === 'head');
    const used = new Set();
    const out = [];
    for (const h of refs) {
      if (h.kind !== 'head') continue;
      const remotes = refs.filter(r => r.kind === 'remote' && r.name.replace(/^[^/]+\//, '') === h.name);
      remotes.forEach(r => used.add(r.name));
      out.push(badge(h).replace('</span>', remotes.map(r => `<span class="ref-origin" title="${esc(r.name)} aponta para o mesmo commit">${esc(r.name.split('/')[0])}</span>`).join('') + '</span>'));
    }
    for (const r of refs) if (r.kind !== 'head' && !used.has(r.name)) out.push(badge(r));
    return heads.length || out.length ? out.join('') : '';
  }

  function historySection() {
    const commits = withWip(state.commits);
    if (!commits.length)
      return `<section class="graph-section gg">${graphHeader(0)}<div class="empty">${state.graphFilter === 'unmerged' ? `Tudo já está mesclado em ${esc(state.base)}.` : 'Sem commits.'}</div></section>`;
    const openAt = expanded ? commits.findIndex(c => c.sha === expanded.sha) : -1;
    if (expanded && openAt < 0) expanded = null;
    const Yg = row => row * ROW + ROW / 2 + (openAt >= 0 && row > openAt ? GAP : 0);
    const { edges, width } = layout(commits);
    const W = Math.max(width * COL + 8, 56);
    const H = commits.length * ROW + (openAt >= 0 ? GAP : 0);
    const head = graphHeader(
      state.commits.length,
      `<div class="gg-head" style="--gw:${W}px"><span class="gg-graph">Graph</span><span class="desc">Description</span><span class="date">Date</span><span class="author">Author</span><span class="sha">Commit</span></div>`,
    );
    const paths = edges.map(e => `<path d="${edgePath(e, Yg)}" stroke="${COLORS[(e.merge ? e.lane : e.x) % COLORS.length]}" />`).join('');
    const dots = commits
      .map(c => {
        const color = COLORS[c.x % COLORS.length];
        if (c.wip) return `<circle cx="${X(c.x)}" cy="${Yg(c.y)}" r="${DOT}" fill="var(--bg)" stroke="var(--warn)" stroke-width="2" stroke-dasharray="2 2"/>`;
        if (c.sha === state.headSha) return `<circle cx="${X(c.x)}" cy="${Yg(c.y)}" r="${DOT + 1.5}" fill="var(--bg)" stroke="${color}" stroke-width="3"/>`;
        const isMerge = c.parents.length > 1;
        return `<circle cx="${X(c.x)}" cy="${Yg(c.y)}" r="${isMerge ? DOT - 1 : DOT}" fill="${isMerge ? 'var(--bg)' : color}" stroke="${color}" stroke-width="2"/>`;
      })
      .join('');
    const q = filter.toLowerCase();
    const rows = commits
      .map((c, i) => {
        const hide = q && !(c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.sha.startsWith(q) || c.refs.some(r => r.name.toLowerCase().includes(q)));
        if (c.wip)
          return `<div class="row gg-row wip ${hide ? 'dim' : ''}" data-menu="${esc(c.branch || '')}">
            <span class="gg-graph"></span><span class="desc"><span class="subject">● ${esc(c.subject)}</span>
            <button class="link" data-action="diffWithBase" data-branch="${esc(c.branch || '')}">revisar</button></span>
            <span class="date">agora</span><span class="author"></span><span class="sha">*</span></div>`;
        const isHead = c.sha === state.headSha;
        const row = `<div class="row gg-row ${hide ? 'dim' : ''} ${c.boundary ? 'boundary' : ''} ${isHead ? 'head-row' : ''} ${i === openAt ? 'open' : ''}" data-sha="${c.sha}" data-parents="${c.parents.join(' ')}" ${c.boundary ? '' : `draggable="true" data-drag-commit="${c.sha}" `}${c.boundary ? `title="Ponto de ${esc(state.base)} de onde branches pendentes saíram"` : ''}>
          <span class="gg-graph"></span>
          <span class="desc">${groupedBadges(c.refs)}<span class="subject">${esc(c.subject)}</span></span>
          <span class="date" title="${ago(c.date)}">${fullDate(c.date)}</span>
          <span class="author">${esc(c.author)}</span>
          <span class="sha">${c.sha.slice(0, 8)}</span>
        </div>`;
        return i === openAt ? row + `<div class="commit-details" data-sha="${c.sha}" style="height:${GAP}px">${detailsHtml(expanded)}</div>` : row;
      })
      .join('');
    return `<section class="graph-section gg">${head}
      <div class="gg-table" style="--gw:${W}px">
        <div class="graph-scroll"><div class="graph" style="height:${H}px">
          <svg class="lanes" width="${W}" height="${H}" fill="none" stroke-width="2">${paths}${dots}</svg>
          ${rows}
        </div></div>
      </div>
    </section>`;
  }

  /** Painel abaixo do commit clicado: hash, pais, autor, committer, mensagem e arquivos com +/−. */
  function detailsHtml(x) {
    if (!x) return '';
    if (x.error) return `<div class="cd-body error">${esc(x.error)}</div>`;
    const d = x.details;
    if (!d) return '<div class="cd-body muted">Carregando detalhes do commit…</div>';
    const parent = d.parents[0] || '';
    const files = d.files
      .map(f => `<div class="cd-file" data-action="openCommitFile" data-sha="${esc(d.sha)}" data-parent="${esc(parent)}" data-path="${esc(f.path)}" data-status="${esc(f.status)}" title="Abrir o diff de ${esc(f.path)} contra o pai">
          <span class="cd-st st-${esc(f.status)}">${esc(f.status)}</span><span class="cd-path">${esc(f.path)}</span>
          <span class="cd-num">${f.added < 0 ? 'binário' : `<span class="add">+${f.added}</span> <span class="del">−${f.deleted}</span>`}</span></div>`)
      .join('');
    return `<div class="cd-body">
      <div class="cd-meta">
        <div><b>Commit:</b> <span class="mono">${esc(d.sha)}</span></div>
        <div><b>Pais:</b> ${d.parents.length ? d.parents.map(p => `<a class="cd-parent mono" data-local="goParent" data-sha="${esc(p)}" title="Ir para o commit">${esc(p.slice(0, 8))}</a>`).join(' ') : '<span class="muted">nenhum</span>'}</div>
        <div><b>Autor:</b> ${esc(d.author)} &lt;${esc(d.authorEmail)}&gt; · ${fullDate(d.authorDate)}</div>
        ${d.committer !== d.author || d.committerDate !== d.authorDate ? `<div><b>Committer:</b> ${esc(d.committer)} &lt;${esc(d.committerEmail)}&gt; · ${fullDate(d.committerDate)}</div>` : ''}
        <pre class="cd-msg">${esc(d.message)}</pre>
      </div>
      <div class="cd-files"><div class="cd-files-head">${d.files.length} arquivo(s) alterado(s)${d.parents.length > 1 ? ' (em relação ao 1º pai)' : ''}</div>${files || '<div class="muted">Nenhum arquivo.</div>'}</div>
      <button class="cd-close" data-local="closeDetails" title="Fechar (Esc)">✕</button>
    </div>`;
  }

  function toggleDetails(sha) {
    expanded = expanded && expanded.sha === sha ? null : { sha };
    if (expanded) vscode.postMessage({ type: 'commitDetails', sha });
    graphKey = ''; // força redesenhar o grafo com (ou sem) o vão
    render();
    if (expanded) document.querySelector('.commit-details')?.scrollIntoView({ block: 'nearest' });
  }

  // seletor "Branches:" (fica fora do painel para não fechar a cada redesenho)
  const picker = document.createElement('div');
  picker.className = 'menu branch-picker';
  document.body.appendChild(picker);
  let pickerSel = new Set();
  function openPicker(btn) {
    pickerSel = new Set(state.graphBranches || []);
    const names = [...(state.refNames?.heads || []), ...(state.showRemotes ? state.refNames?.remotes || [] : [])];
    picker.innerHTML = `<input id="picker-q" type="search" placeholder="Buscar branch" />
      <div class="picker-actions"><button data-local="pickAll">Mostrar todas</button><button class="primary" data-local="pickApply">Aplicar</button></div>
      <div class="picker-list">${names.map(n => `<label class="picker-item" data-name="${esc(n.toLowerCase())}"><input type="checkbox" data-local="pick" data-name="${esc(n)}" ${pickerSel.has(n) ? 'checked' : ''}> ${esc(n)}</label>`).join('')}</div>`;
    const r = btn.getBoundingClientRect();
    picker.style.display = 'block';
    picker.style.left = `${Math.min(r.left, window.innerWidth - 320)}px`;
    picker.style.top = `${r.bottom + 4}px`;
    /** @type {HTMLInputElement} */ (document.getElementById('picker-q')).focus();
  }
  const closePicker = () => (picker.style.display = 'none');

  // ---------- interação ----------
  document.addEventListener('click', e => {
    const t = /** @type {HTMLElement} */ (e.target);
    hideMenu(t);
    const local = /** @type {HTMLElement|null} */ (t.closest('[data-local]'));
    if (local && local.dataset.local === 'layout') {
      ui.layout = local.dataset.layout;
      saveUi();
      render();
      return;
    }
    if (local && local.dataset.local === 'tab') {
      ui.tab = local.dataset.tab;
      saveUi();
      render();
      return;
    }
    if (local && local.dataset.local === 'bysize') {
      bySize = !bySize;
      render();
      return;
    }
    if (local && local.dataset.local === 'branchPicker') {
      if (picker.style.display === 'block') closePicker();
      else openPicker(local);
      return;
    }
    if (local && local.dataset.local === 'pick') return; // checkbox: aplica no botão
    if (local && local.dataset.local === 'pickAll') {
      closePicker();
      send('setGraphOptions', { branches: '' });
      return;
    }
    if (local && local.dataset.local === 'pickApply') {
      const chosen = [...picker.querySelectorAll('input[data-local="pick"]:checked')].map(i => /** @type {HTMLElement} */ (i).dataset.name);
      closePicker();
      send('setGraphOptions', { branches: chosen.join('\n') });
      return;
    }
    if (local && local.dataset.local === 'showRemotes') {
      send('setGraphOptions', { showRemotes: String(/** @type {HTMLInputElement} */ (local).checked) });
      return;
    }
    if (local && local.dataset.local === 'closeDetails') {
      if (expanded) toggleDetails(expanded.sha);
      return;
    }
    if (local && local.dataset.local === 'goParent') {
      const sha = local.dataset.sha;
      const row = document.querySelector(`.row[data-sha="${sha}"]`);
      if (row) {
        toggleDetails(sha);
        document.querySelector(`.row[data-sha="${sha}"]`)?.scrollIntoView({ block: 'center' });
      }
      return;
    }
    if (!picker.contains(t) && !t.closest('[data-local="branchPicker"]')) closePicker();
    if (!t.closest('[data-action], .ref, button, input, a, .commit-details')) {
      const row = /** @type {HTMLElement|null} */ (t.closest('.gg-row[data-sha]'));
      if (row && !row.classList.contains('boundary')) {
        toggleDetails(row.dataset.sha);
        return;
      }
    }
    if (local && local.dataset.local === 'dirty') {
      onlyDirty = !onlyDirty;
      render();
      return;
    }
    if (local && local.dataset.local === 'more') {
      rowLimit += 60;
      const body = document.getElementById('wt-rows');
      if (body) body.innerHTML = tableRows();
      return;
    }
    const el = /** @type {HTMLElement|null} */ (t.closest('[data-action]'));
    if (el && el.dataset.action === 'setGraphFilter' && !el.classList.contains('on')) {
      el.parentElement?.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === el));
      const pane = document.querySelector('.pane-b .graph-scroll');
      if (pane) pane.classList.add('loading');
    }
    if (!el || /** @type {HTMLButtonElement} */ (el).disabled) return;
    const { action, ...args } = el.dataset;
    send(action, args);
  });

  document.addEventListener('input', e => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (t.id === 'wtfilter') {
      wtFilter = t.value;
      rowLimit = 60;
      const body = document.getElementById('wt-rows');
      if (body) body.innerHTML = tableRows();
      return;
    }
    if (t.id === 'picker-q') {
      const q = t.value.toLowerCase();
      picker.querySelectorAll('.picker-item').forEach(el => ((/** @type {HTMLElement} */ (el)).style.display = !q || (el.getAttribute('data-name') || '').includes(q) ? '' : 'none'));
      return;
    }
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
    const commit = /** @type {HTMLElement} */ (e.target).closest?.('[data-drag-commit]');
    if (commit) {
      dragging = 'commit:' + /** @type {HTMLElement} */ (commit).dataset.dragCommit;
      e.dataTransfer?.setData('text/plain', dragging);
      document.body.classList.add('dragging');
      return;
    }
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
    if (target && dragging.startsWith('commit:')) send('cherryPick', { sha: dragging.slice(7), target });
    else if (target && target !== dragging) send('mergeBranches', { source: dragging, target });
  });

  // divisor entre worktrees e histórico
  document.addEventListener('mousedown', e => {
    const sp = /** @type {HTMLElement} */ (e.target).closest?.('.splitter');
    if (!sp) return;
    e.preventDefault();
    const box = /** @type {HTMLElement} */ (sp.parentElement);
    const cols = box.classList.contains('layout-cols');
    const move = ev => {
      const r = box.getBoundingClientRect();
      const pct = cols ? ((ev.clientX - r.left) / r.width) * 100 : ((ev.clientY - r.top) / r.height) * 100;
      ui.split = Math.min(85, Math.max(15, Math.round(pct)));
      box.style.setProperty('--split', `${ui.split}%`);
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing');
      saveUi();
    };
    document.body.classList.add('resizing');
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
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
      if (!isBase) items.push(item('mergeQueueAdd', `Pôr na fila de merge → ${state.base}`, { branch: b }));
      if (wt && wt.overlap) items.push(item('showOverlaps', `⚠ Ver sobreposição (${wt.overlap.files} arquivo(s))`, { path: wt.path }));
      if (wt) items.push(item('addTask', '☰ Adicionar tarefa para o agente…', { path: wt.path, branch: b }));
      items.push(item('push', 'Push (enviar para o remoto)', { branch: b }));
      items.push(item('pullBranch', 'Pull (trazer do remoto)', { branch: b }));
      items.push(item('compareWith', 'Comparar com…', { branch: b }));
      if (wt) {
        items.push(item('stashCreate', 'Guardar alterações (stash)…', { path: wt.path }));
        items.push(item('moveChanges', 'Mover alterações para outra worktree…', { path: wt.path }));
        if (!isBase) items.push(item('reorganizeCommits', 'Reorganizar commits (juntar, reordenar, descartar)…', { path: wt.path }));
      }
      items.push('<hr>');
      if (wt) {
        for (const a of state.agentNames || []) items.push(item('launchAgent', `✦ ${a}`, { path: wt.path, branch: b, agent: a }, 'agent'));
        if ((state.agentNames || []).length) items.push('<hr>');
        items.push(item('toggleFavorite', wt.favorite ? '★ Desfavoritar' : '☆ Favoritar', { path: wt.path }));
        items.push(item('templates.use', '✦ Usar modelo de tarefa…', { path: wt.path, branch: b }, 'agent'));
        items.push(item('env.configure', 'Configurar ambiente (.env, portas, dependências)', { path: wt.path, branch: b }));
        if (wt.port) items.push(item('env.runDev', `Rodar dev (:${wt.port})`, { path: wt.path, branch: b }));
        items.push(item('openWorktree', 'Abrir worktree em nova janela', { path: wt.path }));
        items.push(item('openFile', 'Buscar arquivo nesta worktree…', { path: wt.path }));
        items.push(item('openTerminal', 'Abrir terminal', { path: wt.path }));
      } else {
        items.push(item('createWorktree', 'Criar worktree desta branch', { existing: b }));
      }
      items.push(item('createWorktree', 'Nova branch + worktree a partir daqui', { startPoint: b }));
      if (!isBase) items.push(item('diffWithBase', `Revisar alterações × ${state.base}`, { branch: b }));
      if (!isBase) items.push(item('analyzeMerge', `Analisar merge em ${state.base}…`, { branch: b }));
      if (!isBase) items.push(item('reviewWithAgent', '✦ Revisar PR/MR com o agente', { branch: b }, 'agent'));
      const req = (wt && wt.request) || (state.branches.find(x => x.name === b) || {}).request;
      if (!isBase && state.hosting) items.push(req ? item('openUrl', `Abrir ${req.ref} no navegador`, { url: req.url }) : item('publishRequest', `Publicar ${state.hosting.label}…`, { branch: b }));
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
      items.push(item('showCommit', 'Ver alterações do commit', { sha }));
      if (state.agentNames && state.agentNames[0]) items.push(item('explainCommit', `✦ Explicar com ${state.agentNames[0]}`, { sha }, 'agent'));
      if (state.hosting) items.push(item('openCommitOnWeb', `Abrir no ${state.hosting.kind === 'gitlab' ? 'GitLab' : 'GitHub'}`, { sha }));
      items.push('<hr>');
      items.push(item('copy', 'Copiar hash', { text: sha }));
      items.push(item('copyMessage', 'Copiar mensagem', { sha }));
      items.push('<hr>');
      items.push(item('cherryPick', 'Cherry-pick em…', { sha }));
      items.push(item('createWorktree', 'Nova branch + worktree a partir deste commit', { startPoint: sha }));
      items.push(item('branchAt', 'Criar branch aqui (sem worktree)…', { sha }));
      items.push(item('tagAt', 'Criar tag aqui…', { sha }));
      items.push('<hr>');
      items.push(item('revertCommit', 'Reverter este commit em…', { sha }));
      items.push(item('resetTo', 'Voltar uma branch até aqui…', { sha }, 'danger'));
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
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    hideMenu(null);
    closePicker();
    if (expanded) toggleDetails(expanded.sha);
  });
  window.addEventListener('blur', () => hideMenu(null));

  function demo(m) {
    if (m.scene === 'menu') {
      const el = document.querySelector(`.card[data-menu="${m.branch}"] .branch`);
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 80, clientY: r.top + 12 }));
    } else if (m.scene === 'expand') {
      const row = /** @type {HTMLElement|null} */ (document.querySelectorAll('.gg-row[data-sha]')[m.index || 0]);
      if (row) toggleDetails(row.dataset.sha);
      if (m.details) {
        expanded.details = m.details;
        const box = document.querySelector('.commit-details');
        if (box) box.innerHTML = detailsHtml(expanded);
      }
    } else if (m.scene === 'hide') {
      hideMenu(null);
    } else if (m.scene === 'scroll') {
      document.querySelector(m.selector)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // usado pelos prints da documentação (scripts/make-prints.sh)
  // @ts-ignore
  window.__wtgraphSetState = s => {
    state = s;
    render();
  };

  vscode.postMessage({ type: 'ready' });
})();
