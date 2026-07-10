/* =========================================================================
   kunj landing — interactions
   ========================================================================= */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- year ---------- */
  const yr = $('#year'); if (yr) yr.textContent = new Date().getFullYear();

  /* ---------- nav ---------- */
  const nav = $('#nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 20);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
  const navToggle = $('#navToggle');
  if (navToggle) navToggle.addEventListener('click', () => nav.classList.toggle('open'));
  $$('.nav-links a').forEach(a => a.addEventListener('click', () => nav.classList.remove('open')));

  /* ---------- reveal on scroll ---------- */
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: 0.12 });
  $$('.reveal').forEach(el => io.observe(el));

  /* ---------- animated stat counters ---------- */
  const statObs = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      const el = e.target;
      const target = parseInt(el.dataset.count, 10);
      const suffix = el.dataset.suffix || '';
      if (reduceMotion) { el.textContent = target + suffix; statObs.unobserve(el); return; }
      let cur = 0; const step = Math.max(1, Math.ceil(target / 30));
      const tick = () => {
        cur = Math.min(target, cur + step);
        el.textContent = cur + suffix;
        if (cur < target) requestAnimationFrame(tick);
      };
      tick();
      statObs.unobserve(el);
    });
  }, { threshold: 0.5 });
  $$('.num[data-count]').forEach(el => statObs.observe(el));

  /* ---------- card spotlight ---------- */
  $$('.card').forEach(card => {
    card.addEventListener('mousemove', (ev) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', (ev.clientX - r.left) + 'px');
      card.style.setProperty('--my', (ev.clientY - r.top) + 'px');
    });
  });

  /* ---------- copy to clipboard ---------- */
  $$('[data-copy]').forEach(el => {
    const btn = $('.copy-btn', el);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(el.dataset.copy); } catch (_) {}
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 1500);
    });
  });

  /* =====================================================================
     Hero terminal — typed scenario, loops
     ===================================================================== */
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const heroScript = [
    { type: 'cmd', text: 'kunj create feat/checkout -d "new checkout flow"' },
    { type: 'out', html: '<span class="ok">✓</span> stashed 3 changes on <span class="branch">main</span>' },
    { type: 'out', html: '<span class="ok">✓</span> created &amp; switched to <span class="branch">feat/checkout</span>' },
    { type: 'out', html: '<span class="dim">  desc: new checkout flow</span>' },
    { type: 'gap' },
    { type: 'cmd', text: 'kunj commit --auto' },
    { type: 'out', html: '<span class="ai">✨ asking Claude to describe your changes…</span>' },
    { type: 'out', html: '<span class="ok">✓</span> <span class="cmd">feat(checkout): add express one-click checkout</span>' },
    { type: 'out', html: '<span class="ok">✓</span> committed &amp; pushed to origin' },
    { type: 'gap' },
    { type: 'cmd', text: 'kunj pr --web' },
    { type: 'out', html: '<span class="ai">✨ generating PR description from 4 commits…</span>' },
    { type: 'out', html: '<span class="ok">✓</span> opened <span class="info">#128</span> · Add one-click checkout flow' },
    { type: 'out', html: '<span class="dim">  → https://github.com/you/repo/pull/128</span>' },
  ];

  function typeTerminal(container, script, { loop = true } = {}) {
    let i = 0;
    const cursor = document.createElement('span');
    cursor.className = 'cursor';

    function reset() { container.innerHTML = ''; i = 0; run(); }

    function addLine(html) {
      const ln = document.createElement('span');
      ln.className = 'ln';
      ln.innerHTML = html;
      container.appendChild(ln);
      container.scrollTop = container.scrollHeight;
      return ln;
    }

    function run() {
      if (i >= script.length) {
        if (loop && !reduceMotion) setTimeout(reset, 3400);
        return;
      }
      const step = script[i++];
      if (step.type === 'gap') { addLine('&nbsp;'); return run(); }
      if (step.type === 'out') {
        addLine(step.html);
        return setTimeout(run, reduceMotion ? 60 : 360);
      }
      // cmd — type it out char by char
      const ln = addLine('<span class="prompt">$</span> <span class="cmd"></span>');
      const target = $('.cmd', ln);
      ln.appendChild(cursor);
      if (reduceMotion) { target.innerHTML = esc(step.text); return setTimeout(run, 120); }
      let c = 0;
      (function typeChar() {
        target.innerHTML = esc(step.text.slice(0, ++c));
        if (c < step.text.length) setTimeout(typeChar, 28 + Math.random() * 34);
        else { setTimeout(() => { if (cursor.parentNode === ln) ln.removeChild(cursor); run(); }, 480); }
      })();
    }
    run();
  }

  const termBody = $('#termBody');
  if (termBody) {
    // start when hero visible
    const heroObs = new IntersectionObserver((e) => {
      if (e[0].isIntersecting) { typeTerminal(termBody, heroScript); heroObs.disconnect(); }
    }, { threshold: 0.3 });
    heroObs.observe(termBody);
  }

  /* =====================================================================
     Command explorer
     ===================================================================== */
  const COMMANDS = [
    {
      cmd: 'create', title: 'kunj create <branch>',
      desc: 'Create a new branch and switch to it — stashing any uncommitted work first.',
      flags: [
        ['--no-stash', 'Disable automatic stashing of changes'],
        ['-d, --desc <text>', 'Set a description for the new branch'],
        ['-t, --tag <tags...>', 'Add tags to the new branch'],
      ],
      output: [
        ['cmd', 'kunj create feat/auth -d "OAuth login" -t backend security'],
        ['ok', '✓ stashed 2 uncommitted changes on main'],
        ['ok', '✓ created branch feat/auth'],
        ['info', '↳ switched to feat/auth'],
        ['dim', '  desc: OAuth login   tags: backend, security'],
      ],
    },
    {
      cmd: 'switch', title: 'kunj switch [branch]',
      desc: 'Switch branches (interactive if no name). Auto-stashes current work and restores the target branch’s stash.',
      flags: [['--no-stash', 'Disable automatic stashing']],
      output: [
        ['cmd', 'kunj switch'],
        ['info', '? Select a branch to switch to:'],
        ['dim', '  main'],
        ['ok', '❯ feat/checkout   (2 stashed changes)'],
        ['dim', '  fix/logout-bug'],
        ['ok', '✓ restored 2 stashed changes on feat/checkout'],
      ],
    },
    {
      cmd: 'commit', title: 'kunj commit',
      desc: 'Interactive commit — pick files, then let AI write the message. --auto stages, writes, and pushes in one shot.',
      flags: [
        ['-a, --all', 'Stage all changed files automatically'],
        ['-m, --message', 'Provide message, skip prompt'],
        ['--auto', 'AI message + auto-push'],
        ['--amend', 'Amend the last commit'],
      ],
      output: [
        ['cmd', 'kunj commit --auto'],
        ['ai', '✨ analyzing staged diff with Claude…'],
        ['ok', '✓ feat(auth): add JWT session with redis store'],
        ['dim', '  - sign short-lived tokens'],
        ['dim', '  - persist sessions in redis'],
        ['ok', '✓ committed 3a9f2c1 · pushed to origin/feat/auth'],
      ],
    },
    {
      cmd: 'pr', title: 'kunj pr',
      desc: 'Create or view GitHub PRs with an AI-written description. Track status and GitHub Actions checks.',
      flags: [
        ['-d, --draft', 'Create as draft PR'],
        ['-w, --web', 'Open in browser after creating'],
        ['-s, --status', "View current branch's PR status"],
        ['--detailed', 'Show detailed GitHub Actions steps'],
      ],
      output: [
        ['cmd', 'kunj pr --web'],
        ['ai', '✨ summarizing 4 commits into a description…'],
        ['ok', '✓ opened PR #128 · Add one-click checkout flow'],
        ['info', '  checks: build ✓  test ✓  lint ⣷ running'],
        ['dim', '  → https://github.com/you/repo/pull/128'],
      ],
    },
    {
      cmd: 'graph', title: 'kunj graph',
      desc: 'Visualize commit history as a colorful subway-map graph. Filter by branch, author, or date.',
      flags: [
        ['--all', 'Show all branches'],
        ['-n, --limit <n>', 'Limit commits (default 20)'],
        ['--pretty', 'Unicode box-drawing graph'],
        ['--author <name>', 'Filter by author'],
      ],
      output: [
        ['cmd', 'kunj graph --all --pretty'],
        ['ok', '● feat/checkout  add one-click checkout   3a9f2c1'],
        ['info', '┃╲'],
        ['info', '┃ ● fix/logout   clear session on logout  8b1d0e4'],
        ['ai', '●╱  main         merge #127                 f42aa90'],
        ['dim', '┃   main         bump deps                  1c77b3a'],
      ],
    },
    {
      cmd: 'tree', title: 'kunj tree [branch]',
      desc: 'Create or switch to a git worktree for a branch and jump your IDE into it. Parallel work, zero checkouts.',
      flags: [
        ['-n, --new-window', 'Open IDE in a new window'],
        ['--no-ide', 'Only print the worktree path'],
        ['-b, --base <branch>', 'Base branch for new branches'],
        ['--rm', 'Remove the worktree'],
      ],
      output: [
        ['cmd', 'kunj tree feat/reports -b main'],
        ['ok', '✓ worktree created at ../repo.worktrees/feat-reports'],
        ['info', '↳ opening in VS Code…'],
        ['dim', '  main stays checked out in your current window'],
      ],
    },
    {
      cmd: 'stash', title: 'kunj stash',
      desc: 'Stash changes with an AI-generated, human-readable label instead of “WIP on main”.',
      flags: [['(interactive)', 'Browse, apply, and drop stashes']],
      output: [
        ['cmd', 'kunj stash'],
        ['ai', '✨ describing your changes…'],
        ['ok', '✓ stashed: "refactor checkout validation + add tests"'],
        ['dim', '  stash@{0} on feat/checkout'],
      ],
    },
    {
      cmd: 'log', title: 'kunj log',
      desc: 'Daily work-log journal. Every commit is recorded; generate an AI standup summary on demand.',
      flags: [
        ['--yesterday', "View yesterday's log"],
        ['(default)', 'View today’s activity'],
      ],
      output: [
        ['cmd', 'kunj log --yesterday'],
        ['info', '📓 2026-07-09 · 6 commits across 2 branches'],
        ['ai', '✨ standup:'],
        ['dim', '  • Shipped one-click checkout (#128)'],
        ['dim', '  • Fixed logout session bug (#125)'],
        ['dim', '  • Reviewed 3 PRs'],
      ],
    },
    {
      cmd: 'list', title: 'kunj list',
      desc: 'List branches with descriptions, tags, notes, and stash counts. Filter to just your WIP.',
      flags: [
        ['-w, --wip', 'Only work-in-progress branches'],
        ['-c, --configured', 'Only branches with metadata'],
        ['-v, --verbose', 'Show notes & details'],
        ['-a, --all', 'Override filters'],
      ],
      output: [
        ['cmd', 'kunj list --wip'],
        ['ok', '❯ feat/checkout   [backend]  2 stashed   "new checkout flow"'],
        ['dim', '  fix/logout-bug  [bug]      1 stashed   "clear session"'],
        ['dim', '  chore/deps                             "monthly bumps"'],
      ],
    },
    {
      cmd: 'team', title: 'kunj team',
      desc: 'Roll up PRs and activity across your team into a web dashboard and Slack reports.',
      flags: [
        ['--no-ai', 'Structured report only'],
        ['--max <n>', 'Max PRs to fetch (default 50)'],
        ['--refresh', 'Force re-fetch all diffs'],
      ],
      output: [
        ['cmd', 'kunj team'],
        ['info', '📊 fetching open PRs across the org…'],
        ['ai', '✨ summarizing team activity…'],
        ['ok', '✓ 12 open PRs · 4 ready to merge · 2 blocked'],
        ['dim', '  posted digest to #eng-standup on Slack'],
      ],
    },
    {
      cmd: 'ui', title: 'kunj ui',
      desc: 'Launch the local web dashboard — a visual view of branches, PRs, and team activity.',
      flags: [
        ['-p, --port <n>', 'Port (default 3333)'],
        ['--no-open', "Don't open the browser"],
      ],
      output: [
        ['cmd', 'kunj ui'],
        ['ok', '✓ dashboard running at http://localhost:3333'],
        ['info', '↳ opened in your browser'],
        ['dim', '  live branch + PR overview'],
      ],
    },
    {
      cmd: 'setup', title: 'kunj setup',
      desc: 'Interactive onboarding — installs handy aliases (kj, ksw, kcom, kpr…) and shell config.',
      flags: [
        ['-s, --shell <sh>', 'bash, zsh, or fish'],
        ['-f, --force', 'Overwrite existing aliases'],
      ],
      output: [
        ['cmd', 'kunj setup'],
        ['info', '? Which shell? › zsh'],
        ['ok', '✓ added aliases: kj, ksw, kcom, kpr, klist'],
        ['ok', '✓ tab completion installed'],
        ['dim', '  run: source ~/.zshrc'],
      ],
    },
  ];

  const tabsEl = $('#explorerTabs');
  const exBody = $('#exBody');
  const exTitle = $('#exTitle');
  const exName = $('#exName');
  const exDesc = $('#exDesc');
  const exFlags = $('#exFlags');
  let exTimer = null;

  function renderExplorer(idx) {
    const c = COMMANDS[idx];
    $$('.ex-tab', tabsEl).forEach((t, i) => t.classList.toggle('active', i === idx));
    exTitle.textContent = c.title;
    exName.textContent = c.title;
    exDesc.textContent = c.desc;
    exFlags.innerHTML = c.flags.map(([k, v]) =>
      `<div class="flag-row"><span class="fk">${esc(k)}</span><span class="fv">${esc(v)}</span></div>`).join('');
    // animate output
    if (exTimer) { clearTimeout(exTimer); exTimer = null; }
    exBody.innerHTML = '';
    let li = 0;
    const rows = c.output;
    function nextRow() {
      if (li >= rows.length) return;
      const [cls, text] = rows[li++];
      const ln = document.createElement('span');
      ln.className = 'ln';
      if (cls === 'cmd') ln.innerHTML = `<span class="prompt">$</span> <span class="cmd">${esc(text)}</span>`;
      else ln.innerHTML = `<span class="${cls}">${esc(text)}</span>`;
      exBody.appendChild(ln);
      exBody.scrollTop = exBody.scrollHeight;
      exTimer = setTimeout(nextRow, reduceMotion ? 40 : (cls === 'cmd' ? 340 : 240));
    }
    nextRow();
  }

  if (tabsEl) {
    COMMANDS.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'ex-tab';
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.textContent = c.cmd;
      b.addEventListener('click', () => renderExplorer(i));
      tabsEl.appendChild(b);
    });
    let started = false;
    const exObs = new IntersectionObserver((e) => {
      if (e[0].isIntersecting && !started) { started = true; renderExplorer(0); }
    }, { threshold: 0.25 });
    exObs.observe(tabsEl);
  }

  /* =====================================================================
     AI commit style switcher
     ===================================================================== */
  const AI_STYLES = {
    conventional: { t: 'feat(auth): add JWT session with redis store', b: ['Sign short-lived (15m) access tokens', 'Persist sessions in redis for revocation', 'Log session creation for auditing'] },
    semantic:     { t: 'Add JWT session management backed by redis', b: ['Introduces short-lived signed tokens', 'Stores sessions in redis with a 15m TTL'] },
    gitmoji:      { t: '✨ Add JWT session with redis-backed store', b: ['🔐 Short-lived signed access tokens', '🗄️  Session state persisted in redis'] },
    simple:       { t: 'Add redis-backed JWT sessions', b: ['short-lived tokens, stored in redis'] },
  };
  const aiOut = $('#aiOut');
  function renderAI(style) {
    const s = AI_STYLES[style];
    if (!aiOut || !s) return;
    aiOut.innerHTML =
      `<span class="ct">${esc(s.t)}</span>\n\n` +
      s.b.map(l => `<span class="cb">- ${esc(l)}</span>`).join('\n');
  }
  $$('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      $$('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      renderAI(chip.dataset.style);
    });
  });
  renderAI('conventional');

  /* =====================================================================
     Animated git graph (SVG, draws itself)
     ===================================================================== */
  const NS = 'http://www.w3.org/2000/svg';
  const colors = { main: '#5eead4', feat: '#38bdf8', fix: '#fb7185', release: '#a78bfa' };
  // lane x positions
  const lane = { main: 70, feat: 150, fix: 230, release: 310 };
  // nodes: y descends; commits from top (new) to bottom (old) visually reversed -> we go bottom old to top new
  const nodes = [
    { id: 'a', lane: 'main', y: 328, label: 'init repo', hash: '1a2b' },
    { id: 'b', lane: 'main', y: 296, label: 'add core git ops', hash: 'c3d4', from: 'a' },
    { id: 'c', lane: 'feat', y: 264, label: 'feat: auto-stash', hash: 'e5f6', from: 'b' },
    { id: 'd', lane: 'fix', y: 232, label: 'fix: logout bug', hash: '7a8b', from: 'b' },
    { id: 'e', lane: 'main', y: 200, label: 'merge #124', hash: '9c0d', from: 'b', merge: 'c' },
    { id: 'f', lane: 'feat', y: 168, label: 'feat: AI commits', hash: '1e2f', from: 'c' },
    { id: 'g', lane: 'release', y: 136, label: 'release v1.0', hash: '3a4b', from: 'e' },
    { id: 'h', lane: 'main', y: 104, label: 'merge #127', hash: '5c6d', from: 'e', merge: 'd' },
    { id: 'i', lane: 'feat', y: 72,  label: 'feat: checkout', hash: '7e8f', from: 'f' },
    { id: 'j', lane: 'main', y: 40,  label: 'merge #128', hash: '9a0b', from: 'h', merge: 'f' },
  ];
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));

  function drawGraph(svg) {
    const mk = (name, attrs) => { const el = document.createElementNS(NS, name); for (const k in attrs) el.setAttribute(k, attrs[k]); return el; };
    const anims = [];

    // edges first
    nodes.forEach(n => {
      const x = lane[n.lane];
      const parents = [];
      if (n.from) parents.push({ p: byId[n.from], color: colors[n.lane] });
      if (n.merge) parents.push({ p: byId[n.merge], color: colors[byId[n.merge].lane] });
      parents.forEach(({ p, color }) => {
        const px = lane[p.lane];
        const d = `M ${px} ${p.y} C ${px} ${(p.y + n.y) / 2}, ${x} ${(p.y + n.y) / 2}, ${x} ${n.y}`;
        const path = mk('path', { d, class: 'graph-edge', stroke: color });
        svg.appendChild(path);
        anims.push({ el: path, kind: 'edge', order: p.y });
      });
    });

    // nodes + labels
    nodes.forEach(n => {
      const x = lane[n.lane];
      const c = mk('circle', { cx: x, cy: n.y, r: 6, class: 'graph-node', fill: colors[n.lane], stroke: '#080b11', 'stroke-width': 2 });
      svg.appendChild(c);
      const label = mk('text', { x: 340, y: n.y + 4, class: 'graph-label', fill: '#e6edf3' });
      label.textContent = n.label;
      const hash = mk('text', { x: 600, y: n.y + 4, class: 'graph-hash', 'text-anchor': 'end' });
      hash.textContent = n.hash;
      svg.appendChild(label); svg.appendChild(hash);
      anims.push({ el: c, kind: 'node', order: n.y, extra: [label, hash] });
    });

    // reveal from bottom (old) to top (new)
    anims.sort((a, b) => b.order - a.order);
    if (reduceMotion) {
      anims.forEach(a => { a.el.style.opacity = 1; (a.extra || []).forEach(x => x.style.opacity = 1); });
      return;
    }
    anims.forEach((a, i) => {
      setTimeout(() => {
        if (a.kind === 'edge') {
          const len = a.el.getTotalLength();
          a.el.style.strokeDasharray = len;
          a.el.style.strokeDashoffset = len;
          a.el.style.opacity = 1;
          a.el.style.transition = 'stroke-dashoffset .5s ease';
          requestAnimationFrame(() => { a.el.style.strokeDashoffset = 0; });
        } else {
          a.el.style.transition = 'opacity .35s ease';
          a.el.style.opacity = 1;
          (a.extra || []).forEach(x => { x.style.transition = 'opacity .4s ease'; x.style.opacity = 1; });
        }
      }, i * 130);
    });
  }

  const svg = $('#gitGraph');
  if (svg) {
    let drawn = false;
    const gObs = new IntersectionObserver((e) => {
      if (e[0].isIntersecting && !drawn) { drawn = true; drawGraph(svg); }
    }, { threshold: 0.3 });
    gObs.observe(svg);
  }
})();
