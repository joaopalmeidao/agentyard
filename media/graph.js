// @ts-check
(function () {
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage() {}, getState() {}, setState() {} };
  // Tradução: texto-fonte em inglês; a extensão injeta window.__L10N (src/graphPanel.ts) com o bundle do idioma.
  // @ts-ignore
  const L10N = window.__L10N || { bundle: {}, locale: 'en' };
  /** @param {string} m @param {...(string|number)} a */
  const t = (m, ...a) => (L10N.bundle[m] ?? m).replace(/\{(\d+)\}/g, (x, i) => (Number(i) < a.length ? String(a[Number(i)]) : x));
  const LOCALE = L10N.locale;
  const ROW = 26;
  const COL = 16;
  const DOT = 4.5;
  // Cores das linhas: variáveis de graph.css tiradas da paleta do tema (claro, escuro e alto contraste).
  const COLORS = [0, 1, 2, 3, 4, 5, 6, 7].map(i => `var(--lane-${i})`);

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
    if (s < 60) return t('now');
    if (s < 3600) return `${Math.floor(s / 60)} min`;
    if (s < 86400) return `${Math.floor(s / 3600)} h`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)} d`;
    return new Date(unix * 1000).toLocaleDateString(LOCALE);
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
      const ti = index.get(e.to);
      e.ty = ti === undefined ? commits.length : ti;
      e.tx = ti === undefined ? e.lane : commits[ti].x;
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
      app.innerHTML = `<div class="empty">${t('No git repository open in this workspace.')}</div>`;
      skeletonKey = '';
      return;
    }
    const focused = document.activeElement?.id;
    const sk = `${ui.layout}|${ui.tab}`;
    if (sk !== skeletonKey || !document.querySelector('.split')) {
      app.innerHTML = `<div id="top"></div>
        <div class="split layout-${ui.layout} ${ui.layout === 'tabs' ? `show-${ui.tab}` : ''}" style="--split:${ui.split}%">
          <div class="pane pane-a"></div>
          <div class="splitter" title="${t('Drag to resize')}"></div>
          <div class="pane pane-b"></div>
        </div>`;
      skeletonKey = sk;
      topHtml = paneAHtml = graphKey = '';
    }
    const tab = ui.layout === 'tabs' ? `<nav class="tabs">
        <button data-local="tab" data-tab="a" class="${ui.tab === 'a' ? 'on' : ''}">${t('Worktrees')}<span class="count">${state.worktrees.filter(w => !w.prunable).length}</span></button>
        <button data-local="tab" data-tab="b" class="${ui.tab === 'b' ? 'on' : ''}">${t('History')}<span class="count">${state.commits.length}</span></button></nav>` : '';
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
    // Grupos: criar · sync · remoto · outras telas · layout e menu. Ações raras ficam no "⋯".
    return `<header class="toolbar">
      <div class="title"><button class="repo" data-action="switchProject" title="${esc(state.root)} · ${t('switch project')}">${esc(state.repoName)} ▾</button>
        <span class="muted">${t('base')}</span> <span class="ref ref-base">${esc(state.baseRef)}</span></div>
      <div class="tools">
        <span class="group">
          <button data-action="createWorktree" class="primary">＋ ${t('New worktree')}</button>
          <button data-action="newWorktreeWithTask" class="primary" title="${t('New worktree with task: pick the source branch, create the worktree and send the task to the agent')}">✦ ${t('with task')}</button>
        </span>
        <span class="sep"></span>
        <span class="group">
          <button data-action="toggleAutoSync" class="${s.enabled ? 'on' : ''}" title="${s.trigger === 'push' ? t('Merges the base into the branch before each push (worktreeGraph.autoSync.trigger)') : t('Automatically merges the base into clean worktrees')}. ${s.enabled ? t('Click to turn off.') : t('Click to turn on.')}">⟳ ${s.enabled ? (s.mode === 'notify' ? t('Sync on (notify)') : s.trigger === 'push' ? t('Sync on push') : t('Sync on')) : t('Sync off')}</button>
          <button data-action="chooseSyncWhere" title="${t('Choose where sync runs: local only, CI only (GitHub Actions/GitLab CI), split or both')}">${{ local: t('local'), github: t('CI only'), split: t('split'), both: t('local + CI') }[s.where] || t('local')} ▾</button>
          <button data-action="syncNow" title="${t('Run sync once now')}">${t('Sync now')}</button>
        </span>
        ${toPull() || toPush() ? '<span class="sep"></span>' : ''}
        ${toPull() ? `<button data-action="pullMany" title="${t('Pull branches with new commits from the remote (pick from a list)')}">☁↓ ${t('Pull {0}', toPull())}</button>` : ''}
        ${toPush() ? `<button data-action="pushMany" title="${t('Push branches with unpushed commits (pick from a list)')}">☁↑ ${t('Push {0}', toPush())}</button>` : ''}
        ${state.hosting && !state.hosting.connected ? `<button data-action="connectHosting" title="${t('To publish and track {0}s on {1}', state.hosting.label, esc(state.hosting.host))}">${t('Connect {0}', esc(state.hosting.name || state.hosting.kind))}</button>` : ''}
        <span class="sep"></span>
        <button class="ghost" data-action="activity" title="${t('Commits, sessions and tokens of the day per worktree, and cost per task')}">${t('Activity')}</button>
        ${state.hosting ? `<button class="ghost" data-action="focusPrs" title="${t('Pull requests / merge requests on the remote')}">${state.hosting.label}s</button>` : ''}
        <button class="ghost" data-action="timeline" title="${t('When each branch was created, became a PR/MR and was merged')}">${t('Timeline')}</button>
        <span class="sep"></span>
        <span class="layouts" title="${t('Panel layout')}">
          <button data-local="layout" data-layout="rows" class="${ui.layout === 'rows' ? 'on' : ''}" title="${t('Stacked: worktrees on top, history below')}">⬒</button>
          <button data-local="layout" data-layout="cols" class="${ui.layout === 'cols' ? 'on' : ''}" title="${t('Side by side')}">◫</button>
          <button data-local="layout" data-layout="tabs" class="${ui.layout === 'tabs' ? 'on' : ''}" title="${t('Tabs')}">▭</button>
        </span>
        <button class="ghost icon" data-action="refresh" title="${t('Refresh')}">↻</button>
        <button class="ghost icon" data-local="toolsMenu" title="${t('More actions')}">⋯</button>
      </div>
      ${progressBar()}
    </header>
    ${state.error ? `<div class="error">${esc(state.error)}</div>` : ''}`;
  }

  /** Faixa dev → QA → homologação → produção, com o que espera promoção entre cada par. */
  function flowSection() {
    const f = state.flow;
    if (!f || !f.length) {
      return `<div class="flow-empty"><button class="link" data-action="configureFlow" title="${t('Environment branches in promotion order')}">＋ ${t('Configure environment flow (dev → QA → staging → production)')}</button></div>`;
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
          ? `<span class="chip bad">${t('branch {0} does not exist', esc(!s.fromExists ? s.from.branch : s.to.branch))}</span>`
          : `<span class="arrow">→</span>
             ${s.pending ? `<span class="chip info" title="${t('{0} commit(s) from {1} are not in {2} yet', s.pending, esc(s.from.branch), esc(s.to.branch))}">${t('↑{0} to promote', s.pending)}</span>` : `<span class="chip ok">${t('up to date')}</span>`}
             ${s.hotfix ? `<span class="chip warn" title="${t('{0} commit(s) made directly on {1} that {2} does not have (hotfix?)', s.hotfix, esc(s.to.branch), esc(s.from.branch))}">${t('↓{0} only in {1}', s.hotfix, esc(s.to.label))}</span>` : ''}
             ${req ? requestChip(req) : ''}
             <span class="step-actions">
               <button data-action="promote" data-from="${esc(s.from.branch)}" data-to="${esc(s.to.branch)}" ${s.pending ? '' : 'disabled'} title="${t('{0}, analysis or merge of {1} into {2}', L, esc(s.from.branch), esc(s.to.branch))}">${t('Promote')}</button>
               ${s.hotfix ? `<button data-action="mergeBranches" data-source="${esc(s.to.branch)}" data-target="${esc(s.from.branch)}" title="${t('Merge {0} into {1} (back-merge)', esc(s.to.branch), esc(s.from.branch))}">↓ ${t('Bring back')}</button>` : ''}
             </span>`}
      </div>${stage(s.to, s.toDate)}`;
    }
    return `<section class="flow"><h2>${t('Environment flow')} <button class="link" data-action="promotionMap" title="${t('What is still to be promoted between environments, by stage and by branch')}">${t('view promotion map')}</button> <button class="link" data-action="configureFlow">${t('edit')}</button></h2><div class="flow-strip">${html}</div></section>`;
  }

  /** Progresso do detalhamento: some quando todas as worktrees têm status e comparação. */
  function progressBar() {
    const total = state.worktrees.filter(w => !w.prunable && !w.bare).length;
    if (!state.pending || !total) return '';
    const done = total - state.pending;
    return `<div class="progress" title="${t('git status and comparison with {0}, newest to oldest', esc(state.baseRef))}">
      <div class="bar"><div style="width:${Math.round((done / total) * 100)}%"></div></div>
      <span>${t('Inspecting worktrees: {0} of {1}', done, total)}</span></div>`;
  }

  /** ["Claude Code", "Claude Code", "Codex"] → "Claude Code ×2, Codex" */
  function agentsLabel(names) {
    const n = new Map();
    for (const a of names) n.set(a, (n.get(a) || 0) + 1);
    return [...n].map(([a, c]) => (c > 1 ? `${a} ×${c}` : a)).join(', ');
  }

  function claudeChip(w) {
    const c = w.claude;
    return `<span class="chip agent link" data-action="claudeResumeLast" data-id="${esc(c.lastId)}" title="${t('{0} Claude Code session(s) in this worktree, {1} tokens; last {2}. Click to resume the last one.', c.sessions, fmtTokens(c.tokens), ago(c.last / 1000))}">✦ ${c.sessions} · ${fmtTokens(c.tokens)}${c.usd !== undefined ? ` · ≈US$ ${c.usd.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ''}</span>`;
  }
  const fmtTokens = n => (n >= 1e6 ? t('{0}M', (n / 1e6).toFixed(1)) : n >= 1e3 ? t('{0}k', Math.round(n / 1e3)) : String(n));

  /** Situação no remoto: não publicada, ↑ a enviar, ↓ a receber, ou em dia. */
  function remoteChip(w) {
    const r = w.remote || {};
    if (w.isBase && r.published && !r.ahead && !r.behind) return '';
    if (r.gone) return chip(`☁ ${t('deleted on remote')}`, 'warn', t('The upstream of this branch no longer exists on the remote'));
    if (!r.published) return w.isBase ? '' : chip(`☁ ${t('not published')}`, 'muted', t('Not on the remote yet; Publish runs push -u'));
    const parts = [r.ahead ? `↑${r.ahead}` : '', r.behind ? `↓${r.behind}` : ''].filter(Boolean).join(' ');
    return parts ? chip(`☁ ${parts}`, r.ahead ? 'warn' : 'info', t('{0} commit(s) to push · {1} to pull from {2}', r.ahead, r.behind, w.upstream)) : chip(`☁ ${t('up to date')}`, 'ok', t('Up to date with {0}', w.upstream));
  }

  function pushButton(branch, r, compact) {
    const label = !r.published ? (compact ? `☁ ${t('publish')}` : `☁ ${t('Publish')}`) : compact ? `☁↑${r.ahead}` : `☁ Push ↑${r.ahead}`;
    return `<button data-action="push" data-branch="${esc(branch)}" title="${!r.published ? t('git push -u (creates the branch on the remote)') : t('Push {0} commit(s)', r.ahead)}">${label}</button>`;
  }

  function pullButton(branch, behind, compact) {
    return `<button data-action="pullBranch" data-branch="${esc(branch)}" title="${t('Pull {0} commit(s) from the remote (fast-forward; if diverged, asks merge or rebase)', behind)}">${compact ? `☁↓${behind}` : `☁↓ ${t('Pull {0}', behind)}`}</button>`;
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
      success: ['✓', 'ok', t('passed')], failed: ['✗', 'bad', t('failed')], running: ['⟳', 'info', t('running')], queued: ['…', 'muted', t('queued')],
      canceled: ['⊘', 'muted', t('canceled')], skipped: ['↷', 'muted', t('skipped')], manual: ['▶', 'warn', t('waiting for manual action')],
    };
    const [sym, cls, txt] = map[p.status] || ['?', 'muted', p.status];
    const main = `<span class="chip ${cls} link" data-action="openUrl" data-url="${esc(p.url)}" title="${esc(p.name)}: ${txt} — ${t('open in browser')}">${sym} CI${compact ? '' : ` ${txt}`}</span>`;
    const fix = p.status === 'failed' && !compact
      ? `<span class="chip agent link" data-action="fixPipeline" data-id="${p.id}" title="${t('Open the agent in the worktree with the failure log')}">✦ ${t('fix')}</span>`
      : '';
    return main + fix;
  }

  /** Revisão do PR/MR: aprovado, mudanças pedidas, comentado, aguardando, conversas abertas. */
  function reviewInfo(r) {
    if (r.state === 'draft') return [t('draft'), 'muted', t('draft: not asking for review yet')];
    if (r.state === 'merged') return [t('PR/MR merged'), 'ok', t('PR/MR merged')];
    if (r.state === 'closed') return [t('closed'), 'muted', t('closed without merging')];
    const v = r.review;
    if (!v) return [t('PR/MR open'), 'info', t('PR/MR open')];
    const by = v.by && v.by.length ? ` (${v.by.join(', ')})` : '';
    const left = v.approvalsLeft ? t(', {0} more needed', v.approvalsLeft) : '';
    return {
      approved: [`✓ ${t('approved')}${v.approvals > 1 ? ` ×${v.approvals}` : ''}`, 'ok', `${t('approved')}${by}${left}`],
      changes: [`✎ ${t('changes requested')}`, 'bad', `${t('changes requested')}${by}`],
      discussions: [`💬 ${t('open discussions')}`, 'warn', `${t('there are unresolved discussions')}${left}`],
      commented: [`💬 ${t('commented')}`, 'info', t('commented{0}, not approved', by)],
      pending: [`◷ ${t('awaiting review')}${v.approvals ? ` (${v.approvals} ok)` : ''}`, 'muted', `${t('awaiting review')}${by}${left}`],
    }[v.state] || [t('PR/MR open'), 'info', t('PR/MR open')];
  }

  function overlapChip(w) {
    const o = w.overlap;
    return `<span class="chip warn link" data-action="showOverlaps" data-path="${esc(w.path)}" title="${t('Files in common with: {0}', esc(o.with.join(', ')))}">⚠ ${t('overlaps with {0}', esc(o.with[0]))}${o.with.length > 1 ? ` +${o.with.length - 1}` : ''} (${o.files})</span>`;
  }

  function budgetChip(w) {
    const b = w.budget;
    return `<span class="chip ${b.level === 'over' ? 'bad' : 'warn'}" title="${t('Budget per worktree ({0})', b.by === 'usd' ? 'US$' : 'tokens')}">${b.level === 'over' ? t('over budget') : t('budget {0}%', b.pct)}</span>`;
  }

  function requestChip(r) {
    const [txt, cls, tip] = reviewInfo(r);
    return `<span class="chip ${cls} link" data-action="showPr" data-ref="${esc(r.ref)}" data-url="${esc(r.url)}" title="${esc(r.ref)} ${esc(r.title)} — ${esc(tip)}. ${t('Click: view in the PR list · Ctrl/Alt+click: browser.')}">${esc(r.ref)} ${txt}</span>`;
  }

  /** PR/MR aberto da branch (worktree ou branch sem worktree). */
  function requestOf(name) {
    const v = state.worktrees.find(w => w.branch === name) || state.branches.find(b => b.name === name);
    return v && v.request;
  }

  /** O agente terminou e deixou commits: clique abre a revisão. */
  function reviewChip(w) {
    return `<span class="chip ok link" data-action="reviewReady" data-path="${esc(w.path)}" data-branch="${esc(w.branch || '')}" title="${w.review.commits ? t('The agent finished with {0} new commit(s). Click to review.', w.review.commits) : t('The agent finished. Click to review.')}">✓ ${t('ready for review')}</span>`;
  }

  function tasksChip(w) {
    const tk = w.tasks;
    const n = tk.waiting + (tk.running ? 1 : 0);
    return `<span class="chip info link" data-action="openTasks" title="${tk.running ? `${t('Running: {0}', esc(tk.running))}\n` : ''}${t('{0} queued', tk.waiting)}">☰ ${t('{0} task(s)', n)}</span>`;
  }

  const arrows = (behind, ahead) => [behind ? `↓${behind}` : '', ahead ? `↑${ahead}` : ''].filter(Boolean).join(' ');

  /** Branch empilhada: o pai; ↻ quando precisa de restack (clique faz o restack, ou mostra a pilha). */
  function stackChip(w) {
    const st = w.stack;
    const tips = {
      ok: t('Stacked on {0}: its PR targets {0}. Click to see the stack.', esc(st.parent)),
      behind: t('{0} got new commits: click to restack onto it.', esc(st.parent)),
      'parent-merged': t('{0} is already in the base: click to move this branch onto the base.', esc(st.parent)),
      'parent-gone': t('{0} was deleted: click to move this branch onto the base.', esc(st.parent)),
    };
    const ok = st.state === 'ok';
    return `<span class="chip ${ok ? 'muted' : 'warn'} link" data-action="${ok ? 'stack.show' : 'stack.restack'}" data-branch="${esc(w.branch || '')}" title="${tips[st.state] || ''}">↳ ${esc(st.parent)}${ok ? '' : ' ↻'}</span>`;
  }

  function chip(text, cls = '', title = '') {
    return `<span class="chip ${cls}" ${title ? `title="${esc(title)}"` : ''}>${text}</span>`;
  }

  /** "● N": clicar lista os arquivos não commitados da worktree e abre o diff de cada um. */
  function uncommittedChip(w, text) {
    return `<span class="chip warn" style="cursor:pointer" data-action="showUncommitted" data-path="${esc(w.path)}" title="${t('Uncommitted changes: click to see the files')}">${text}</span>`;
  }

  function syncChip(w) {
    if (w.isBase || !state.autoSync.enabled) return w.paused ? chip(`‖ ${t('sync paused')}`, 'muted') : '';
    if (w.paused) return chip(`‖ ${t('sync paused')}`, 'muted');
    const s = w.sync;
    if (!s) return chip(`⟳ ${t('waiting for sync')}`, 'muted');
    const map = {
      uptodate: [`⟳ ${t('up to date')}`, 'ok'],
      merged: [`⟳ ${t('base merged')}`, 'ok'],
      behind: [state.autoSync.mode !== 'notify' && state.autoSync.trigger === 'push' ? `⟳ ${t('behind (merges on push)')}` : `⟳ ${t('behind (notify)')}`, 'info'],
      'waiting-dirty': [`⟳ ${t('waiting for commit')}`, 'warn'],
      conflict: [`⟳ ${t('conflict')}`, 'bad'],
      testing: [`⟳ ${t('testing…')}`, 'info'],
      'test-failed': [`⟳ ${t('tests failed')}`, 'bad'],
      paused: [`‖ ${t('paused')}`, 'muted'],
      remote: ['⟳ via GitHub Actions', 'muted'],
      error: [`⟳ ${t('error')}`, 'bad'],
    };
    const [label, c] = map[s.kind] || [s.kind, ''];
    return chip(`${label} · ${ago(s.at / 1000)}`, c, s.message);
  }

  /** Em destaque (card): a principal, as favoritas, as com agente aberto e a desta janela. */
  const featured = w => !w.prunable && (w.isMain || w.favorite || w.isCurrent || (w.agents && w.agents.length > 0) || w.changes > 0 || !!w.operation);
  const starBtn = w =>
    `<button class="star ${w.favorite ? 'on' : ''}" data-action="toggleFavorite" data-path="${esc(w.path)}" title="${w.favorite ? t('Unfavorite') : t('Favorite: becomes a card and moves up the list')}">${w.favorite ? '★' : '☆'}</button>`;

  /** "⋯": abre o menu do botão direito do card ou da linha em que está. */
  const moreBtn = () => `<button class="more" data-local="itemMenu" title="${t('More actions (the same menu as right-click)')}">⋯</button>`;

  function worktreesSection() {
    const all = state.worktrees.filter(w => !w.prunable);
    const cards = all.filter(featured).map(card).join('');
    return `<section>
      <h2>${t('Featured')} <span class="count">${all.filter(featured).length}</span>
        <span class="hint" title="${t('Shown here: the main one, favorites (☆), those with an open agent and those with uncommitted work')}">${t('drag a card onto another to merge · right-click or ⋯ for more actions')}</span></h2>
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
    return `${n >= 100 || i === 0 ? Math.round(n) : n.toLocaleString(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${u[i]}`;
  }

  function sizeChip(sz) {
    return chip(`💾 ${sz.complete ? '' : '≥'}${formatBytes(sz.bytes)}`, 'muted', sz.complete ? t('Disk space (links such as a shared node_modules do not count)') : t('Count stopped by the time limit: minimum value'));
  }
  let rowLimit = 60;

  function tableSection() {
    const rest = state.worktrees.filter(w => !w.prunable && !featured(w));
    const orphans = state.worktrees.filter(w => w.prunable).length;
    if (!rest.length && !orphans) return '';
    return `<section>
      <h2>${t('All worktrees')} <span class="count">${rest.length}</span>
        ${orphans ? `<button class="link" data-action="pruneWorktrees" title="${t('Folders that no longer exist (git worktree prune)')}">${t('{0} orphan(s) · remove', orphans)}</button>` : ''}
        ${mergedCount() ? `<button class="link" data-action="removeMerged" title="${t('Clean worktrees whose branch is fully in {0} (favorites, with an agent and protected ones are left out)', esc(state.base))}">${t('remove merged ({0})', mergedCount())}</button>` : ''}
        <button class="link" data-action="cleanupWorktrees" title="${t('Remove several at once; merged and clean ones come pre-selected')}">${t('bulk cleanup…')}</button>
        <button class="link ${onlyDirty ? 'on' : ''}" data-local="dirty" title="${t('Show only worktrees with uncommitted changes')}">${onlyDirty ? '✓ ' : ''}${t('with changes ({0})', state.worktrees.filter(w => w.changes > 0).length)}</button>
        <button class="link ${bySize ? 'on' : ''}" data-local="bysize" title="${t('Sort by disk space')}">${bySize ? '✓ ' : ''}${t('by size')}</button>
        <input id="wtfilter" type="search" placeholder="${t('Filter by branch, folder or commit')}" /></h2>
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
      const st = !w.statusKnown ? chip('…', 'muted', t('reading status')) : w.operation ? chip(esc(w.operation), 'bad') : w.changes ? uncommittedChip(w, `● ${w.changes}`) : chip('✓', 'ok', t('clean'));
      const cmp = !w.compareKnown
        ? chip('…', 'muted', t('comparing with the base'))
        : w.behind || w.ahead
          ? chip(arrows(w.behind, w.ahead), w.behind ? 'info' : 'muted', t('{0} behind · {1} ahead of {2}', w.behind, w.ahead, state.baseRef))
          : chip('=', 'muted', t('same as {0}', state.baseRef));
      const conf = w.preview?.conflict
        ? chip('⚠', 'bad', t('conflicts with {0}: {1}', state.base, w.preview.files.join(', '))) +
          (agent ? `<button class="agent mini" data-action="resolveConflict" data-branch="${b}" title="${t('Resolve with {0}: brings in {1} and resolves the conflicts', esc(agent), esc(state.base))}">✦ ${t('resolve')}</button>` : '')
        : '';
      return `<tr class="${w.changes ? 'dirty' : ''}" draggable="true" data-drag="${b}" data-drop="${b}" data-menu="${b}">
        <td class="c-star">${starBtn(w)}</td>
        <td class="c-name"><span class="branch">${esc(w.name)}</span><div class="path" title="${esc(w.path)}">${esc(w.path)}</div></td>
        <td class="c-chips">${w.size ? sizeChip(w.size) : ''}${w.review ? reviewChip(w) : ''}${w.tasks ? tasksChip(w) : ''}${st}${cmp}${conf}${w.remote.ahead || !w.remote.published ? remoteChip(w) : ''}${w.request ? requestChip(w.request) : ''}${w.overlap ? overlapChip(w) : ''}${w.budget ? budgetChip(w) : ''}${w.branch && pipelineFor(w.branch) ? pipelineChip(pipelineFor(w.branch), true) : ''}${w.sync && state.autoSync.enabled ? syncChip(w) : ''}</td>
        <td class="subject" title="${esc(w.subject)}">${esc(w.subject)} <span class="muted">${ago(w.date)}</span></td>
        <td class="row-actions">
          ${agent ? `<button class="agent" data-action="launchAgent" data-path="${esc(w.path)}" data-branch="${b}" data-agent="${esc(agent)}" title="${t('Open {0} in this worktree (Ctrl/Alt+click opens another, even with one already running)', esc(agent))}">✦</button>` : ''}
          ${w.remote.ahead || !w.remote.published ? pushButton(w.branch, w.remote, true) : ''}
          ${w.remote.published && w.remote.behind ? pullButton(w.branch, w.remote.behind, true) : ''}
          <button data-action="openWorktree" data-path="${esc(w.path)}" title="${t('Open in new window')}">${t('Open')}</button>
          <button data-action="diffWithBase" data-branch="${b}" title="${t('Review changes × {0}', esc(state.base))}">${t('Review')}</button>
          ${w.behind ? `<button data-action="mergeBaseInto" data-branch="${b}" title="${t('Bring in {0}', esc(state.baseRef))}">↓</button>` : ''}
          ${w.ahead ? `<button data-action="mergeIntoBase" data-branch="${b}" title="${t('Merge into {0}', esc(state.base))}">↑</button>` : ''}
          ${moreBtn()}
        </td></tr>`;
    });
    if (match.length > rowLimit) rows.push(`<tr><td colspan="5" class="more"><button data-local="more">${t('Show {0} more of {1}', Math.min(60, match.length - rowLimit), match.length - rowLimit)}</button></td></tr>`);
    if (!match.length) rows.push(`<tr><td colspan="5" class="muted">${t('No worktree matching “{0}”.', esc(wtFilter))}</td></tr>`);
    return rows.join('');
  }

  function card(w) {
        const b = esc(w.branch || '');
        const chips = [];
        if (w.bare) chips.push(chip('bare', 'muted'));
        if (w.operation) chips.push(chip(t('{0} in progress', esc(w.operation)), 'bad'));
        chips.push(!w.statusKnown ? chip(`… ${t('reading status')}`, 'muted') : w.changes ? uncommittedChip(w, `● ${t('{0} uncommitted', w.changes)}`) : chip(`✓ ${t('clean')}`, 'ok'));
        if (!w.compareKnown) chips.push(chip(`… ${t('comparing')}`, 'muted'));
        else if (!w.isBase && w.branch) {
          if (w.behind === 0 && w.ahead === 0) chips.push(chip(`= ${esc(state.baseRef)}`, 'muted'));
          else chips.push(chip(arrows(w.behind, w.ahead), w.behind ? 'info' : 'muted', t('{0} commit(s) from the base missing here · {1} commit(s) on this branch that the base does not have', w.behind, w.ahead)));
          if (w.preview) chips.push(w.preview.conflict ? chip(`⚠ ${t('conflicts with {0}', esc(state.base))}`, 'bad', w.preview.files.join('\n')) : chip(t('clean merge'), 'ok'));
        } else if (w.isBase && (w.behind || w.ahead)) {
          chips.push(chip(`${arrows(w.behind, w.ahead)} ${esc(state.baseRef)}`, 'info'));
        }
        if (w.branch) chips.push(remoteChip(w));
        if (w.branch) chips.push(syncChip(w));
        if (w.agents && w.agents.length) {
          // estado pelos hooks do Claude: esperando você (pedido de permissão) ou trabalhando
          const st = w.agentStates;
          const waiting = st && st.waiting;
          const status = waiting ? ` · ${t('waiting for you')}` : st && st.working ? ` · ${t('working')}` : '';
          const tip = (waiting && st.message ? st.message + '\n' : '') + t('{0} agent terminal(s) open in this worktree. Click to choose which one to bring to the front.', w.agents.length);
          chips.push(`<span class="chip ${waiting ? 'warn' : 'agent'} link" data-action="agents.pick" data-path="${esc(w.path)}" title="${esc(tip)}">${waiting ? '●' : '✦'} ${esc(agentsLabel(w.agents))}${status}</span>`);
        }
        if (w.review) chips.push(reviewChip(w));
        if (w.tasks) chips.push(tasksChip(w));
        if (w.request) chips.push(requestChip(w.request));
        if (w.stack) chips.push(stackChip(w));
        if (w.overlap) chips.push(overlapChip(w));
        if (w.budget) chips.push(budgetChip(w));
        if (w.branch && pipelineFor(w.branch)) chips.push(pipelineChip(pipelineFor(w.branch)));
        if (w.claude) chips.push(claudeChip(w));
        if (w.port) chips.push(`<span class="chip info link" data-action="env.openBrowser" data-path="${esc(w.path)}" data-branch="${b}" title="${t('Port of this worktree; click to open {0}', `http://localhost:${w.port}`)}">🌐 :${w.port}</span>`);
        if (w.size) chips.push(sizeChip(w.size));

        const agent = state.agentNames && state.agentNames[0];
        const act = [
          agent && !w.bare && !w.prunable
            ? `<button data-action="launchAgent" data-path="${esc(w.path)}" data-branch="${b}" data-agent="${esc(agent)}" class="agent" title="${t('Opens {0} in a terminal inside this worktree. Ctrl/Alt+click opens another, even with one already running (right-click the card for other agents)', esc(agent))}">✦ ${esc(agent)}</button>`
            : '',
          w.branch && (w.remote.ahead || !w.remote.published) && !w.prunable ? pushButton(w.branch, w.remote) : '',
          w.branch && w.remote.published && w.remote.behind && !w.prunable ? pullButton(w.branch, w.remote.behind) : '',
          `<button data-action="openWorktree" data-path="${esc(w.path)}" title="${t('Open in new window')}">${t('Open')}</button>`,
          `<button data-action="openTerminal" data-path="${esc(w.path)}" title="${t('Terminal in this folder')}">${t('Terminal')}</button>`,
        ].filter(Boolean);
        // Só as ações do dia a dia ficam à mostra; Arquivos, Analisar, Pausar sync, Remover etc. estão no ⋯ (o mesmo menu do botão direito).
        if (w.branch && !w.isBase) {
          act.push(`<button data-action="diffWithBase" data-branch="${b}" title="${t('Files changed since it branched off the base')}">${t('Review')}</button>`);
          if (w.request && (w.request.state === 'open' || w.request.state === 'draft'))
            act.push(`<button class="agent" data-action="reviewWithAgent" data-branch="${b}" title="${t('The agent reviews {0} and you choose what to post', esc(w.request.ref))}">✦ ${t('Review {0}', esc(w.request.ref))}</button>`);
          if (w.preview?.conflict && agent) act.unshift(`<button data-action="resolveConflict" data-branch="${b}" class="agent" title="${t('Opens {0} in this worktree with the task of bringing in {1} and resolving the conflicts', esc(agent), esc(state.base))}">✦ ${t('Resolve with {0}', esc(agent))}</button>`);
          if (state.hosting && !w.request && w.ahead) act.push(`<button data-action="publishRequest" data-branch="${b}" title="${t('Push + {0} to {1}', state.hosting.label, esc(state.base))}">${t('Publish {0}', state.hosting.label)}</button>`);
          act.push('<span class="spacer"></span>');
          if (w.behind) act.push(`<button data-action="mergeBaseInto" data-branch="${b}" title="git merge ${esc(state.baseRef)}">↓ ${t('Bring in {0}', esc(state.base))}</button>`);
          if (w.ahead) act.push(`<button data-action="mergeIntoBase" data-branch="${b}" class="primary" title="${t('Merge into {0}', esc(state.base))}">↑ ${t('Merge into {0}', esc(state.base))}</button>`);
        }
        const cls = ['card', w.isCurrent ? 'current' : '', w.isBase ? 'base' : '', w.preview?.conflict || w.operation ? 'conflict' : w.changes ? 'dirty' : ''].join(' ');
        return `<div class="${cls}" ${w.branch ? `draggable="true" data-drag="${b}" data-drop="${b}"` : ''} data-menu="${b}">
          <div class="card-head">
            ${w.isMain ? '' : starBtn(w)}
            <span class="branch" title="${esc(w.name)}">${esc(w.name)}</span>
            <span class="tags">
              ${w.isBase ? `<span class="tag">${t('base')}</span>` : ''}
              ${w.branch && isProtected(w.branch) ? `<span class="tag" title="${t('Protected branch: direct merge and push ask for confirmation or a PR/MR')}">🔒 ${t('protected')}</span>` : ''}
              ${w.isMain ? `<span class="tag">${t('main')}</span>` : ''}
              ${w.isCurrent ? `<span class="tag accent">${t('this window')}</span>` : ''}
            </span>
            ${w.branch ? moreBtn() : ''}
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
          <td>${b.ahead === 0 ? chip(t('already merged'), 'ok') : chip(arrows(b.behind, b.ahead), 'info')}
              ${b.preview ? (b.preview.conflict ? chip(`⚠ ${t('conflict')}`, 'bad', b.preview.files.join('\n')) : chip(t('clean merge'), 'ok')) : ''}</td>
          <td class="subject" title="${esc(b.subject)}">${esc(b.subject)}</td>
          <td class="muted">${ago(b.date)}</td>
          <td class="row-actions">
            <button data-action="createWorktree" data-existing="${n}">${t('Worktree')}</button>
            <button data-action="diffWithBase" data-branch="${n}">${t('Review')}</button>
            ${b.ahead ? `<button data-action="mergeIntoBase" data-branch="${n}" title="${t('Merge into {0}', esc(state.base))}">↑ ${esc(state.base)}</button>` : ''}
            ${moreBtn()}
          </td></tr>`;
      })
      .join('');
    return `<section><details ${list.length <= 8 ? 'open' : ''}>
      <summary><h2>${t('Branches without a worktree')} <span class="count">${list.length}</span>
        ${mergedBranchCount() ? `<button class="link" data-action="removeMergedBranches" title="${t('Local branches without a worktree whose commits are all in {0} (the base and protected ones are left out)', esc(state.base))}">${t('delete merged ({0})', mergedBranchCount())}</button>` : ''}</h2></summary>
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

  /** Mesma regra de actions.mergedBranches (que confere de novo com o git antes de excluir). */
  function mergedBranchCount() {
    if (!state.baseSha) return 0;
    const unmerged = new Set(state.unmerged || []);
    return state.branches.filter(b => !b.isBase && b.name !== state.base && !isProtected(b.name) && !unmerged.has(b.name)).length;
  }

  /** lane: coluna do commit no grafo; com ela, a etiqueta de branch pega a cor da linha. */
  function badge(r, lane) {
    const cls = { head: 'ref-head', remote: 'ref-remote', tag: 'ref-tag', detached: 'ref-detached' }[r.kind];
    const base = r.name === state.base && r.kind === 'head' ? ' ref-base' : '';
    const wt = r.worktree ? ' ref-wt' : '';
    const cur = r.current ? ' ref-current' : '';
    const drag = r.kind === 'head' || r.kind === 'remote' ? `draggable="true" data-drag="${esc(r.name)}"` : '';
    const drop = r.kind === 'head' ? `data-drop="${esc(r.name)}" data-menu="${esc(r.name)}"` : r.kind === 'remote' ? `data-menu-remote="${esc(r.name)}"` : '';
    const pending = r.kind === 'head' && r.name !== state.base ? state.unmerged.includes(r.name) : undefined;
    const ahead = pending ? aheadOf(r.name) : 0;
    const merged = pending === false ? ' ref-merged' : '';
    const title = r.kind === 'head' ? `${r.worktree ? t('branch with worktree') : t('local branch')}${pending ? ` · ${ahead ? t('{0} commit(s) not in {1}', ahead, state.base) : t('commits not in {0}', state.base)}` : pending === false ? ` · ${t('already merged into {0}', state.base)}` : ''}` : r.kind;
    const req = r.kind === 'head' ? requestOf(r.name) : undefined;
    const lock = r.kind === 'head' && isProtected(r.name) ? '🔒 ' : '';
    const tone = lane !== undefined && (r.kind === 'head' || r.kind === 'remote') ? ` ref-lane" style="--tone:${COLORS[lane % COLORS.length]}` : '';
    return `<span class="ref ${cls}${base}${wt}${cur}${merged}${pending ? ' ref-pending' : ''}${tone}" ${drag} ${drop} title="${esc(title)}${lock ? ` · ${t('protected')}` : ''}">${lock}${r.worktree ? '▣ ' : ''}${esc(r.name)}${ahead ? ` <b>↑${ahead}</b>` : ''}</span>${req ? requestChip(req) : ''}`;
  }

  function graphHeader(n, extra = '') {
    const f = state.graphFilter;
    const sel = state.graphBranches || [];
    const controls = `<div class="hist-controls">
        ${f === 'all' ? `<button class="branch-picker-btn" data-local="branchPicker" title="${t('Choose which branches the history shows')}">${t('Branches:')} <b>${sel.length ? (sel.length === 1 ? esc(sel[0]) : t('{0} selected', sel.length)) : t('Show all')}</b> ▾</button>` : ''}
        ${f === 'all' ? `<label class="check"><input type="checkbox" data-local="showRemotes" ${state.showRemotes ? 'checked' : ''}> ${t('Show remote branches')}</label>` : ''}
        <button data-action="refresh" title="${t('Refresh')}">↻</button>
        <input id="filter" type="search" placeholder="${t('Filter by message, author, hash or branch')}" />
      </div>`;
    return `<div class="graph-head-wrap"><h2 class="graph-head">${t('History')} <span class="count">${n}</span>
      <span class="seg" title="${t('What the graph shows')}">
        <button data-action="setGraphFilter" data-value="all" class="${f === 'all' ? 'on' : ''}">${t('All')}</button>
        <button data-action="setGraphFilter" data-value="unmerged" class="${f === 'unmerged' ? 'on' : ''}" title="${t('Only commits from branches and worktrees not yet in {0}', esc(state.base))}">${t('Unmerged')} <b>${state.unmerged.length}</b></button>
        <button data-action="setGraphFilter" data-value="ci" class="${f === 'ci' ? 'on' : ''}" title="${t('Only the branches CI uses: environment flow, base, CI files and worktreeGraph.ciBranches')}">CI</button>
      </span></h2>${controls}${f === 'ci' ? ciStrip() : ''}${extra}</div>`;
  }

  /** Filtro CI: as branches achadas, de onde vieram e o que espera promoção entre os estágios. */
  function ciStrip() {
    const list = state.ciBranches || [];
    if (!list.length)
      return `<div class="ci-strip muted">${t('No CI branches found.')} <button class="link" data-action="openCiBranchesSettings">${t('configure…')}</button></div>`;
    const step = (from, to) => (state.flow || []).find(s => s.from.branch === from && s.to.branch === to);
    const parts = list.map((b, i) => {
      const next = list[i + 1];
      const s = next ? step(b.name, next.name) : undefined;
      const p = pipelineFor(b.name);
      return `<span class="ci-branch" title="${esc(b.name)} — ${esc(b.sources.join(', '))}">
          <span class="ref ref-head ${b.name === state.base ? 'ref-base' : ''}">${esc(b.name)}</span>${p ? pipelineChip(p, true) : ''}</span>${
        s && !state.pending
          ? `<span class="ci-arrow" title="${t('{0} commit(s) from {1} waiting for promotion to {2}', s.pending, esc(s.from.branch), esc(s.to.branch))}${s.hotfix ? `; ${t('{0} only in {1}', s.hotfix, esc(s.to.branch))}` : ''}">→ ${s.pending ? `<b>↑${s.pending}</b>` : '✓'}${s.hotfix ? ` <span class="warn">↓${s.hotfix}</span>` : ''} →</span>`
          : next ? '<span class="ci-sep">·</span>' : ''
      }`;
    });
    return `<div class="ci-strip">${parts.join('')} <button class="link" data-action="openCiBranchesSettings" title="${t('Extra branches (worktreeGraph.ciBranches)')}">${t('configure…')}</button></div>`;
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
      if (at >= 0) wip.push({ at, c: { sha: `wip-${i}`, parents: [w.head], author: '', date: Date.now() / 1000, subject: t('Uncommitted changes in {0}: {1} file(s)', w.name, w.changes), refs: [], wip: true, branch: w.branch, path: w.path } });
    });
    if (!wip.length) return commits;
    const out = commits.slice();
    wip.sort((a, b) => b.at - a.at).forEach(x => out.splice(x.at, 0, x.c));
    return out;
  }

  const fullDate = unix =>
    new Date(unix * 1000).toLocaleString(LOCALE, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  /** "main" e "origin/main" no mesmo commit viram uma etiqueta só. */
  function groupedBadges(refs, lane) {
    const heads = refs.filter(r => r.kind === 'head');
    const used = new Set();
    const out = [];
    for (const h of refs) {
      if (h.kind !== 'head') continue;
      const remotes = refs.filter(r => r.kind === 'remote' && r.name.replace(/^[^/]+\//, '') === h.name);
      remotes.forEach(r => used.add(r.name));
      out.push(badge(h, lane).replace('</span>', remotes.map(r => `<span class="ref-origin" title="${t('{0} points to the same commit', esc(r.name))}">${esc(r.name.split('/')[0])}</span>`).join('') + '</span>'));
    }
    for (const r of refs) if (r.kind !== 'head' && !used.has(r.name)) out.push(badge(r, lane));
    return heads.length || out.length ? out.join('') : '';
  }

  function historySection() {
    const commits = withWip(state.commits);
    if (!commits.length)
      return `<section class="graph-section gg">${graphHeader(0)}<div class="empty">${state.graphFilter === 'unmerged' ? t('Everything is already merged into {0}.', esc(state.base)) : t('No commits.')}</div></section>`;
    const openAt = expanded ? commits.findIndex(c => c.sha === expanded.sha) : -1;
    if (expanded && openAt < 0) expanded = null;
    const Yg = row => row * ROW + ROW / 2 + (openAt >= 0 && row > openAt ? GAP : 0);
    const { edges, width } = layout(commits);
    const W = Math.max(width * COL + 8, 56);
    const H = commits.length * ROW + (openAt >= 0 ? GAP : 0);
    const head = graphHeader(
      state.commits.length,
      `<div class="gg-head" style="--gw:${W}px"><span class="gg-graph">${t('Graph')}</span><span class="desc">${t('Description')}</span><span class="date">${t('Date')}</span><span class="author">${t('Author')}</span><span class="sha">${t('Commit')}</span></div>`,
    );
    const paths = edges.map(e => `<path d="${edgePath(e, Yg)}" style="stroke:${COLORS[(e.merge ? e.lane : e.x) % COLORS.length]}" />`).join('');
    const dots = commits
      .map(c => {
        const color = COLORS[c.x % COLORS.length];
        if (c.wip) return `<circle cx="${X(c.x)}" cy="${Yg(c.y)}" r="${DOT}" style="fill:var(--bg);stroke:var(--warn)" stroke-width="2" stroke-dasharray="2 2"/>`;
        if (c.sha === state.headSha) return `<circle cx="${X(c.x)}" cy="${Yg(c.y)}" r="${DOT + 1.5}" style="fill:var(--bg);stroke:${color}" stroke-width="3"/>`;
        const isMerge = c.parents.length > 1;
        return `<circle cx="${X(c.x)}" cy="${Yg(c.y)}" r="${isMerge ? DOT - 1 : DOT}" style="fill:${isMerge ? 'var(--bg)' : color};stroke:${color}" stroke-width="2"/>`;
      })
      .join('');
    const q = filter.toLowerCase();
    const rows = commits
      .map((c, i) => {
        const hide = q && !(c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.sha.startsWith(q) || c.refs.some(r => r.name.toLowerCase().includes(q)));
        if (c.wip)
          return `<div class="row gg-row wip ${hide ? 'dim' : ''}" data-menu="${esc(c.branch || '')}">
            <span class="gg-graph"></span><span class="desc"><span class="subject">● ${esc(c.subject)}</span>
            <button class="link" data-action="showUncommitted" data-path="${esc(c.path || '')}">${t('view files')}</button>
            <button class="link" data-action="diffWithBase" data-branch="${esc(c.branch || '')}">${t('review')}</button></span>
            <span class="date">${t('now')}</span><span class="author"></span><span class="sha">*</span></div>`;
        const isHead = c.sha === state.headSha;
        const row = `<div class="row gg-row ${hide ? 'dim' : ''} ${c.boundary ? 'boundary' : ''} ${isHead ? 'head-row' : ''} ${i === openAt ? 'open' : ''}" data-sha="${c.sha}" data-parents="${c.parents.join(' ')}" ${c.boundary ? '' : `draggable="true" data-drag-commit="${c.sha}" `}${c.boundary ? `title="${t('Point on {0} where pending branches branched off', esc(state.base))}"` : ''}>
          <span class="gg-graph"></span>
          <span class="desc">${groupedBadges(c.refs, c.x)}<span class="subject">${esc(c.subject)}</span></span>
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
    if (!d) return `<div class="cd-body muted">${t('Loading commit details…')}</div>`;
    const parent = d.parents[0] || '';
    const files = d.files
      .map(f => `<div class="cd-file" data-action="openCommitFile" data-sha="${esc(d.sha)}" data-parent="${esc(parent)}" data-path="${esc(f.path)}" data-status="${esc(f.status)}" title="${t('Open the diff of {0} against the parent', esc(f.path))}">
          <span class="cd-st st-${esc(f.status)}">${esc(f.status)}</span><span class="cd-path">${esc(f.path)}</span>
          <span class="cd-num">${f.added < 0 ? t('binary') : `<span class="add">+${f.added}</span> <span class="del">−${f.deleted}</span>`}</span></div>`)
      .join('');
    return `<div class="cd-body">
      <div class="cd-meta">
        <div><b>${t('Commit:')}</b> <span class="mono">${esc(d.sha)}</span></div>
        <div><b>${t('Parents:')}</b> ${d.parents.length ? d.parents.map(p => `<a class="cd-parent mono" data-local="goParent" data-sha="${esc(p)}" title="${t('Go to commit')}">${esc(p.slice(0, 8))}</a>`).join(' ') : `<span class="muted">${t('none')}</span>`}</div>
        <div><b>${t('Author:')}</b> ${esc(d.author)} &lt;${esc(d.authorEmail)}&gt; · ${fullDate(d.authorDate)}</div>
        ${d.committer !== d.author || d.committerDate !== d.authorDate ? `<div><b>${t('Committer:')}</b> ${esc(d.committer)} &lt;${esc(d.committerEmail)}&gt; · ${fullDate(d.committerDate)}</div>` : ''}
        <pre class="cd-msg">${esc(d.message)}</pre>
      </div>
      <div class="cd-files"><div class="cd-files-head">${t('{0} file(s) changed', d.files.length)}${d.parents.length > 1 ? ` ${t('(relative to the 1st parent)')}` : ''}</div>${files || `<div class="muted">${t('No files.')}</div>`}</div>
      <button class="cd-close" data-local="closeDetails" title="${t('Close (Esc)')}">✕</button>
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
    picker.innerHTML = `<input id="picker-q" type="search" placeholder="${t('Search branch')}" />
      <div class="picker-actions"><button data-local="pickAll">${t('Show all')}</button><button class="primary" data-local="pickApply">${t('Apply')}</button></div>
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
    const openedBy = menu.style.display === 'block' ? menuAnchor : null;
    const subEl = /** @type {HTMLElement|null} */ (t.closest('.menu-sub'));
    if (subEl && menu.contains(subEl)) return openSub(subEl);
    hideMenu(t);
    const local = /** @type {HTMLElement|null} */ (t.closest('[data-local]'));
    if (local && (local.dataset.local === 'itemMenu' || local.dataset.local === 'toolsMenu')) {
      if (openedBy === local) return; // segundo clique no mesmo ⋯ fecha
      const items = local.dataset.local === 'toolsMenu' ? toolsMenuItems() : menuItemsFor(local);
      if (items.length) showMenuAt(local, items);
      return;
    }
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
    // botão dentro do <summary> não abre/fecha a seção
    if (el.closest('summary')) e.preventDefault();
    const { action, ...args } = el.dataset;
    if (e.ctrlKey || e.altKey || e.metaKey) args.modifier = '1';
    if (inMenu(el)) hideMenu(null);
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
  /** Dica flutuante que diz o que acontece ao soltar sobre o alvo atual. */
  const dragHint = document.createElement('div');
  dragHint.className = 'drag-hint';
  document.body.appendChild(dragHint);
  const startDrag = (e, value) => {
    dragging = value;
    e.dataTransfer?.setData('text/plain', dragging);
    document.body.classList.add('dragging');
  };
  // O render() troca o innerHTML (ex.: o estado chega logo após o drop); se o elemento arrastado
  // sai do DOM, o dragend não chega ao document e os contornos tracejados ficariam para sempre.
  // Por isso a limpeza também roda no drop e em qualquer sinal de que o arrasto já acabou.
  const endDrag = () => {
    if (!dragging && !document.body.classList.contains('dragging')) return;
    dragging = '';
    document.body.classList.remove('dragging');
    document.querySelectorAll('.drop-over').forEach(x => x.classList.remove('drop-over'));
    dragHint.style.display = 'none';
  };
  document.addEventListener('dragstart', e => {
    const commit = /** @type {HTMLElement} */ (e.target).closest?.('[data-drag-commit]');
    if (commit) return startDrag(e, 'commit:' + /** @type {HTMLElement} */ (commit).dataset.dragCommit);
    const el = /** @type {HTMLElement} */ (e.target).closest?.('[data-drag]');
    if (el) startDrag(e, /** @type {HTMLElement} */ (el).dataset.drag || '');
  });
  document.addEventListener('dragend', endDrag);
  // Durante um arrasto nativo o navegador não emite mousemove/mousedown: se chegarem, o arrasto acabou.
  for (const ev of ['mousemove', 'mousedown']) document.addEventListener(ev, () => dragging && endDrag());
  window.addEventListener('blur', endDrag);
  document.addEventListener('dragover', e => {
    const el = /** @type {HTMLElement} */ (e.target).closest?.('[data-drop]');
    if (!el || !dragging || /** @type {HTMLElement} */ (el).dataset.drop === dragging) {
      document.querySelectorAll('.drop-over').forEach(x => x.classList.remove('drop-over'));
      dragHint.style.display = 'none';
      return;
    }
    e.preventDefault();
    document.querySelectorAll('.drop-over').forEach(x => x !== el && x.classList.remove('drop-over'));
    el.classList.add('drop-over');
    const target = /** @type {HTMLElement} */ (el).dataset.drop || '';
    dragHint.innerHTML = dragging.startsWith('commit:')
      ? `Cherry-pick <b>${esc(dragging.slice(7, 14))}</b> → <b>${esc(target)}</b>`
      : `Merge <b>${esc(dragging)}</b> → <b>${esc(target)}</b>`;
    dragHint.style.display = 'block';
    const x = Math.min(e.clientX + 14, window.innerWidth - dragHint.offsetWidth - 8);
    const y = Math.min(e.clientY + 18, window.innerHeight - dragHint.offsetHeight - 8);
    dragHint.style.left = Math.max(8, x) + 'px';
    dragHint.style.top = Math.max(8, y) + 'px';
  });
  document.addEventListener('drop', e => {
    const el = /** @type {HTMLElement} */ (e.target).closest?.('[data-drop]');
    const source = dragging;
    endDrag();
    if (!el || !source) return;
    e.preventDefault();
    const target = /** @type {HTMLElement} */ (el).dataset.drop;
    if (target && source.startsWith('commit:')) send('cherryPick', { sha: source.slice(7), target });
    else if (target && target !== source) send('mergeBranches', { source, target });
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
  // submenu: painel fixo à parte, para não ser cortado pela rolagem do menu principal
  const submenu = document.createElement('div');
  submenu.className = 'menu submenu';
  document.body.appendChild(submenu);
  /** Itens de cada submenu do menu aberto, pelo índice em data-sub. */
  let subs = [];
  const inMenu = t => !!t && (menu.contains(t) || submenu.contains(t));
  function hideMenu(t) {
    if (!t || !inMenu(t)) {
      menu.style.display = 'none';
      submenu.style.display = 'none';
    }
  }
  /** Entrada que abre um submenu ao passar o mouse (ou clicar). */
  function sub(label, list, cls = '') {
    return `<div class="menu-item menu-sub ${cls}" data-sub="${subs.push(list) - 1}">${esc(label)}<span class="menu-arrow">›</span></div>`;
  }
  function openSub(el) {
    menu.querySelectorAll('.menu-sub.on').forEach(x => x !== el && x.classList.remove('on'));
    el.classList.add('on');
    submenu.innerHTML = subs[Number(el.dataset.sub)].join('');
    submenu.style.display = 'block';
    const r = el.getBoundingClientRect();
    const w = submenu.offsetWidth;
    const x = r.right + w + 4 <= window.innerWidth ? r.right + 2 : r.left - w - 2; // à direita; sem espaço, à esquerda
    submenu.style.left = `${Math.max(8, x)}px`;
    submenu.style.top = `${Math.max(8, Math.min(r.top - 5, window.innerHeight - submenu.offsetHeight - 8))}px`;
  }
  menu.addEventListener('mouseover', e => {
    const el = /** @type {HTMLElement} */ (e.target).closest?.('.menu-item');
    if (!el) return;
    if (el.classList.contains('menu-sub')) openSub(/** @type {HTMLElement} */ (el));
    else {
      submenu.style.display = 'none';
      menu.querySelectorAll('.menu-sub.on').forEach(x => x.classList.remove('on'));
    }
  });
  /** Botão ⋯ que abriu o menu (para o segundo clique fechar); null quando veio do botão direito. */
  /** @type {HTMLElement|null} */
  let menuAnchor = null;
  function showMenu(items, x, y, anchor = null) {
    menuAnchor = anchor;
    submenu.style.display = 'none';
    menu.innerHTML = items.join('');
    menu.style.display = 'block';
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
  }
  /** Abre o menu logo abaixo do botão, alinhado pela direita (botões ⋯). */
  function showMenuAt(btn, items) {
    const r = btn.getBoundingClientRect();
    showMenu(items, 0, 0);
    showMenu(items, r.right - menu.offsetWidth, r.bottom + 4, btn);
  }
  /** "⋯" da barra: o que é raro demais para ter botão próprio. */
  function toolsMenuItems() {
    return [
      item('switchProject', t('Switch project…'), {}),
      item('configureFlow', t('Configure environment flow…'), {}),
      (state.flow || []).length ? item('promotionMap', t('Promotion map'), {}) : '',
      '<hr>',
      item('generateCi', t('Generate sync CI (GitHub Actions / GitLab CI)…'), {}),
      item('openCiBranchesSettings', t('CI branches…'), {}),
      '<hr>',
      item('cleanupWorktrees', t('Bulk clean up worktrees…'), {}),
    ].filter(Boolean);
  }

  document.addEventListener('contextmenu', e => {
    const items = menuItemsFor(/** @type {HTMLElement} */ (e.target));
    if (!items.length) return;
    e.preventDefault();
    showMenu(items, e.clientX, e.clientY);
  });
  /** Itens do menu de contexto para o que está sob o elemento: branch, branch remota ou commit. */
  function menuItemsFor(tgt) {
    subs = [];
    const local = /** @type {HTMLElement|null} */ (tgt.closest('[data-menu]'));
    const remote = /** @type {HTMLElement|null} */ (tgt.closest('[data-menu-remote]'));
    const row = /** @type {HTMLElement|null} */ (tgt.closest('.row'));
    const items = [];
    if (local && local.dataset.menu) {
      // Topo: o que mais se usa. O resto fica em submenus (Agente, Git, Worktree) para o menu caber na tela.
      const b = local.dataset.menu;
      const wt = state.worktrees.find(w => w.branch === b);
      const isBase = b === state.base;
      const req = (wt && wt.request) || (state.branches.find(x => x.name === b) || {}).request;
      items.push(`<div class="menu-title">${esc(b)}</div>`);
      if (!isBase) {
        items.push(item('mergeBaseInto', `↓ ${t('Bring {0} in here', state.baseRef)}`, { branch: b }));
        items.push(item('mergeIntoBase', `↑ ${t('Merge into {0}', state.base)}`, { branch: b }));
      }
      items.push(item('mergeInto', t('Merge into…'), { branch: b }));
      if (!isBase) items.push(item('mergeQueueAdd', t('Add to merge queue → {0}', state.base), { branch: b }));
      if (wt && wt.overlap) items.push(item('showOverlaps', `⚠ ${t('View overlap ({0} file(s))', wt.overlap.files)}`, { path: wt.path }));
      if (wt && wt.changes) items.push(item('showUncommitted', `● ${t('View uncommitted changes ({0})', wt.changes)}`, { path: wt.path }));
      items.push('<hr>');

      const agent = [];
      if (wt) {
        for (const a of state.agentNames || []) {
          agent.push(item('launchAgent', `✦ ${a}`, { path: wt.path, branch: b, agent: a }, 'agent'));
          if ((wt.agents || []).includes(a)) agent.push(item('launchAgentNew', `✦ ${t('Another {0} (new terminal)', a)}`, { path: wt.path, branch: b, agent: a }, 'agent'));
        }
        if (wt.agents && wt.agents.length) agent.push(item('agents.pick', t('Agents open here ({0})…', wt.agents.length), { path: wt.path }, 'agent'));
        if (agent.length) agent.push('<hr>');
        agent.push(item('claude.launchWithOptions', `✦ ${t('Claude Code with options (model, permission mode)…')}`, { path: wt.path, branch: b }, 'agent'));
        agent.push(item('addTask', `☰ ${t('Add task for the agent…')}`, { path: wt.path, branch: b }));
        agent.push(item('templates.use', `✦ ${t('Use task template…')}`, { path: wt.path, branch: b }, 'agent'));
        if (req) agent.push(item('sendPrFeedback', `✦ ${t('Send the {0} review feedback to the agent', esc(req.ref))}`, { path: wt.path, branch: b }, 'agent'));
        agent.push(item('turns.pick', t('Agent turns (checkpoints)…'), { path: wt.path, branch: b }));
      }
      agent.push(item('newWorktreeWithTask', `✦ ${t('New worktree from here, with task…')}`, { startPoint: b }, 'agent'));
      if (!isBase) agent.push(item('reviewWithAgent', `✦ ${t('Review PR/MR with the agent')}`, { branch: b }, 'agent'));
      items.push(sub(`✦ ${t('Agent')}`, agent, 'agent'));

      const git = [
        item('push', t('Push (send to the remote)'), { branch: b }),
        item('pullBranch', t('Pull (bring from the remote)'), { branch: b }),
        item('compareWith', t('Compare with…'), { branch: b }),
      ];
      if (wt) {
        git.push('<hr>');
        git.push(item('switchBranch', t('Switch branch…'), { path: wt.path }));
        git.push(item('stashCreate', t('Stash changes…'), { path: wt.path }));
        git.push(item('moveChanges', t('Move changes to another worktree…'), { path: wt.path }));
        if (!isBase) git.push(item('reorganizeCommits', t('Reorganize commits (squash, reorder, drop)…'), { path: wt.path }));
        git.push(item('claude.commitMessage', `✦ ${t('Commit with a message written by Claude…')}`, { path: wt.path, branch: b }, 'agent'));
        git.push('<hr>');
        git.push(item('bisect', t('Find the commit that broke it (bisect)…'), { path: wt.path, branch: b }));
        git.push(item('sparseCheckout', t('Partial checkout (sparse)…'), { path: wt.path, branch: b }));
      }
      items.push(sub('Git', git));

      const tree = [];
      if (wt) {
        tree.push(item('openWorktree', t('Open worktree in new window'), { path: wt.path }));
        tree.push(item('openFile', t('Find file in this worktree…'), { path: wt.path }));
        tree.push(item('openTerminal', t('Open terminal'), { path: wt.path }));
        tree.push('<hr>');
        tree.push(item('env.configure', t('Configure environment (.env, ports, dependencies)'), { path: wt.path, branch: b }));
        if (wt.port) tree.push(item('env.runDev', t('Run dev (:{0})', wt.port), { path: wt.path, branch: b }));
        tree.push('<hr>');
      } else {
        tree.push(item('createWorktree', t('Create worktree for this branch'), { existing: b }));
      }
      tree.push(item('createWorktree', t('New branch + worktree from here'), { startPoint: b }));
      tree.push(item('stack.newChild', `↳ ${t('New worktree stacked on this branch…')}`, { branch: b }));
      if (wt && wt.stack) tree.push(item('stack.restack', `↻ ${t('Restack onto {0}', esc(wt.stack.parent))}`, { branch: b }));
      items.push(sub(t('Worktree'), tree));

      items.push('<hr>');
      if (!isBase) items.push(item('diffWithBase', t('Review changes × {0}', state.base), { branch: b }));
      if (!isBase) items.push(item('analyzeMerge', t('Analyze merge into {0}…', state.base), { branch: b }));
      if (!isBase && state.hosting) items.push(req ? item('openUrl', t('Open {0} in browser', req.ref), { url: req.url }) : item('publishRequest', t('Publish {0}…', state.hosting.label), { branch: b }));
      if (wt) items.push(item('toggleFavorite', wt.favorite ? `★ ${t('Unfavorite')}` : `☆ ${t('Favorite')}`, { path: wt.path }));
      if (!isBase) {
        items.push('<hr>');
        if (wt) items.push(item('togglePause', wt.paused ? t('Resume sync') : t('Pause sync'), { branch: b }));
        items.push(wt ? item('removeWorktree', t('Remove worktree…'), { branch: b }, 'danger') : item('deleteBranch', t('Delete branch…'), { branch: b }, 'danger'));
      }
    } else if (remote && remote.dataset.menuRemote) {
      const r = remote.dataset.menuRemote;
      items.push(`<div class="menu-title">${esc(r)}</div>`);
      items.push(item('mergeInto', t('Merge into…'), { branch: r }));
      items.push(item('createWorktree', t('New branch + worktree from here'), { startPoint: r }));
      items.push(item('newWorktreeWithTask', `✦ ${t('New worktree from here, with task…')}`, { startPoint: r }, 'agent'));
    } else if (row && row.dataset.sha) {
      const sha = row.dataset.sha;
      items.push(`<div class="menu-title">${sha.slice(0, 10)}</div>`);
      items.push(item('showCommit', t('View commit changes'), { sha }));
      if (state.agentNames && state.agentNames[0]) items.push(item('explainCommit', `✦ ${t('Explain with {0}', state.agentNames[0])}`, { sha }, 'agent'));
      if (state.hosting) items.push(item('openCommitOnWeb', t('Open on {0}', state.hosting.kind === 'gitlab' ? 'GitLab' : 'GitHub'), { sha }));
      items.push('<hr>');
      items.push(item('copy', t('Copy hash'), { text: sha }));
      items.push(item('copyMessage', t('Copy message'), { sha }));
      items.push('<hr>');
      items.push(item('cherryPick', t('Cherry-pick into…'), { sha }));
      items.push(item('createWorktree', t('New branch + worktree from this commit'), { startPoint: sha }));
      items.push(item('branchAt', t('Create branch here (no worktree)…'), { sha }));
      items.push(item('tagAt', t('Create tag here…'), { sha }));
      items.push('<hr>');
      items.push(item('revertCommit', t('Revert this commit in…'), { sha }));
      items.push(item('resetTo', t('Reset a branch to here…'), { sha }, 'danger'));
    }
    return items;
  }
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
