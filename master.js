(function () {
  function readCookie(name) {
    const all = typeof document !== 'undefined' && typeof document.cookie === 'string' ? document.cookie : '';
    const parts = all.split(';');
    const prefix = name + '=';
    for (const part of parts) {
      const s = part.trim();
      if (s.startsWith(prefix)) return decodeURIComponent(s.slice(prefix.length));
    }
    return '';
  }
  function getTeam() {
    let t = readCookie('QUIZ_TEAM');
    if (!t && typeof localStorage !== 'undefined') { try { t = localStorage.getItem('QUIZ_TEAM') || ''; } catch(e) {} }
    if (!t && typeof sessionStorage !== 'undefined') { try { t = sessionStorage.getItem('QUIZ_TEAM') || ''; } catch(e) {} }
    return (t || '').toUpperCase();
  }

  function saveTeam(team) {
    const t = (team || '').toUpperCase();
    if (!t) return;
    try { localStorage.setItem('QUIZ_TEAM', t); } catch(e) {}
    try { sessionStorage.setItem('QUIZ_TEAM', t); } catch(e) {}
    document.cookie = `QUIZ_TEAM=${encodeURIComponent(t)}; Max-Age=600; Path=/; SameSite=Strict`;
  }

  let overlayShown = false;
  function ensureTeamPrompt() {
    if (overlayShown || getTeam()) return;
    overlayShown = true;
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `
      <div class="modal">
        <h2>Enter Admin Team Code</h2>
        <label>
          <input type="password" class="team-input" placeholder="8-hex code e.g. DEAD1337" maxlength="8" autocomplete="off" />
        </label>
        <div class="row">
          <button class="primary" data-action="ok">Continue</button>
        </div>
        <div class="result" data-role="msg"></div>
      </div>`;
    document.body.appendChild(ov);
    const input = ov.querySelector('.team-input');
    const ok = ov.querySelector('[data-action="ok"]');
    const msg = ov.querySelector('[data-role="msg"]');
    const submit = () => {
      const v = (input.value || '').toUpperCase().trim();
      if (!/^[A-F0-9]{8}$/.test(v)) { if (msg) msg.textContent = 'Please enter 8 hex characters (0-9, A-F).'; return; }
      saveTeam(v);
      ov.remove();
      overlayShown = false;
      fetchStatus();
      renderPresent();
    };
    ok.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    input.addEventListener('input', () => { input.value = input.value.toUpperCase(); });
    setTimeout(() => input.focus(), 0);
  }
  const API = (cmd, params = {}) => {
    const u = new URL(location.origin + location.pathname.replace(/[^/]*$/, 'quiz.php'));
    const team = getTeam();
    if (team) u.searchParams.set('team', team);
    u.searchParams.set('cmd', cmd);
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
    return u.toString();
  };

  const slots = {
    q1: document.querySelector('[data-slot="q1"]'),
    q2: document.querySelector('[data-slot="q2"]'),
    q3: document.querySelector('[data-slot="q3"]'),
    q4: document.querySelector('[data-slot="q4"]'),
    q5: document.querySelector('[data-slot="q5"]'),
    info: document.querySelector('[data-slot="info"]'),
  };

  let current = { round: null, started: null, length: null };
  let nextTransitionAt = null; // Date | null for next hint/end boundary
  let transitionTimer = null;  // Timeout id for precise refresh
  let transitionArmed = false; // gate to avoid duplicate refresh on zero
  let questions = [];
  let mode = 'present';
  let idx = 0; // current question index in present mode

  const presentRoot = document.getElementById('present');
  const layoutRoot = document.getElementById('layout');

  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function renderInfo(data) {
    const cr = data.current_round;
    const roundName = cr ? (cr.name || ('Round ' + cr.round)) : 'No Active Round';
    current.round = cr ? Number(cr.round) : null;
    current.length = cr ? Number(cr.length) : null;
    current.started = cr && cr.started ? new Date(cr.started) : null;
    const info = slots.info;
    if (!info) return;
    info.innerHTML = '<div class="round"></div><div class="clock"></div>';
    info.querySelector('.round').textContent = roundName;
  }

  // Phases: L to Hint1, then L/2 to Hint2, then L/2 to End (total 2L)
  function computeNextTransition() {
    if (!current.started || !current.length) return null;
    const start = current.started.getTime();
    const L = current.length * 1000;
    const now = Date.now();
    const t1 = start + L;           // Hint 1
    const t2 = start + L + L / 2;   // Hint 2
    const t3 = start + 2 * L;       // End
    if (now < t1) return new Date(t1);
    if (now < t2) return new Date(t2);
    if (now < t3) return new Date(t3);
    return null;
  }

  function secondsUntilNextTransition() {
    if (!nextTransitionAt) return 0;
    return Math.max(0, (nextTransitionAt.getTime() - Date.now()) / 1000);
  }

  function tickClock() {
    const el = slots.info && slots.info.querySelector('.clock');
    if (el) el.textContent = fmtClock(secondsUntilNextTransition());
    if (nextTransitionAt && transitionArmed && Date.now() >= nextTransitionAt.getTime()) {
      transitionArmed = false;
      fetchStatus();
    }
  }

  function armTransitionTimer() {
    if (transitionTimer) { clearTimeout(transitionTimer); transitionTimer = null; }
    nextTransitionAt = computeNextTransition();
    transitionArmed = !!nextTransitionAt;
    if (nextTransitionAt) {
      const delay = Math.max(0, nextTransitionAt.getTime() - Date.now()) + 50; // buffer
      transitionTimer = setTimeout(() => {
        transitionArmed = false;
        fetchStatus();
      }, delay);
    }
  }

  function renderQuestions(data) {
    const qs = questions.slice(0, 5);
    const targets = [slots.q1, slots.q2, slots.q3, slots.q4, slots.q5];
    targets.forEach((t, i) => {
      if (!t) return;
      const q = qs[i];
      t.innerHTML = '';
      if (!q) return;
      const wrap = document.createElement('div');
      wrap.className = 'qwrap';
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = q.letter + '.';
      const body = document.createElement('div');
      body.className = 'body';
      if (q.question_type === 'image/png') {
        const img = document.createElement('img');
        img.alt = 'Question ' + q.letter;
        img.src = 'data:image/png;base64,' + q.question;
        body.appendChild(img);
      } else {
        const text = document.createElement('div');
        text.className = 'text';
        text.textContent = q.question || '';
        body.appendChild(text);
        let h1 = null, h2 = null;
        if (q.hint1) { h1 = document.createElement('div'); h1.className = 'hint'; h1.textContent = 'Hint 1: ' + q.hint1; body.appendChild(h1); }
        if (q.hint2) { h2 = document.createElement('div'); h2.className = 'hint'; h2.textContent = 'Hint 2: ' + q.hint2; body.appendChild(h2); }
        const promote = h2 || h1;
        if (promote) { promote.classList.add('promote'); wrap.classList.add('has-promote'); }
      }
      wrap.appendChild(title);
      wrap.appendChild(body);
      t.appendChild(wrap);

      // Allow clicking a grid cell to switch to Present mode on that question
      t.style.cursor = 'pointer';
      t.onclick = () => { idx = i; setMode('present'); };

      // Text auto-sizes via CSS container units
    });
  }

  function renderLeaderboard(data) {
    const strip = document.getElementById('strip');
    if (!strip) return;
    const rows = data && Array.isArray(data.overall_totals) ? data.overall_totals : [];
    const totals = new Map();
    for (const r of rows) {
      const id = r.team_id;
      const sc = Number(r.score) || 0;
      totals.set(id, (totals.get(id) || 0) + sc);
    }
    const list = Array.from(totals.entries())
      .map(([team_id, total]) => ({ team_id, total }))
      .sort((a, b) => b.total - a.total);

    const doc = document.createElement('div');
    doc.className = 'board';
    const title = document.createElement('div');
    title.className = 'board-title';
    title.textContent = 'Leaderboard';
    doc.appendChild(title);
    const ul = document.createElement('ol');
    ul.className = 'board-list';
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No scores yet.';
      ul.appendChild(li);
    } else {
      list.forEach((t, i) => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="rank">${i + 1}.</span> <span class="team">${t.team_id}</span> <span class="pts">${t.total}</span>`;
        ul.appendChild(li);
      });
    }
    doc.appendChild(ul);
    strip.innerHTML = '';
    strip.appendChild(doc);
  }

  // Removed JS font fitting — handled by CSS container query units now

  function renderPresent() {
    if (!presentRoot) return;
    presentRoot.innerHTML = '';
    const q = questions[idx];
    if (!q) return;
    const panel = document.createElement('div');
    panel.className = 'panel';
    const wrap = document.createElement('div');
    wrap.className = 'qwrap';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = q.letter + '.';
    const body = document.createElement('div');
    body.className = 'body';
    if (q.question_type === 'image/png') {
      const img = document.createElement('img');
      img.alt = 'Question ' + q.letter;
      img.src = 'data:image/png;base64,' + q.question;
      body.appendChild(img);
    } else {
      const text = document.createElement('div');
      text.className = 'text';
      text.textContent = q.question || '';
      body.appendChild(text);
      let h1 = null, h2 = null;
      if (q.hint1) { h1 = document.createElement('div'); h1.className = 'hint'; h1.textContent = 'Hint 1: ' + q.hint1; body.appendChild(h1); }
      if (q.hint2) { h2 = document.createElement('div'); h2.className = 'hint'; h2.textContent = 'Hint 2: ' + q.hint2; body.appendChild(h2); }
      const promote = h2 || h1;
      if (promote) { promote.classList.add('promote'); wrap.classList.add('has-promote'); }
    }
    wrap.appendChild(title);
    wrap.appendChild(body);
    panel.appendChild(wrap);
    presentRoot.appendChild(panel);

    // Text auto-sizes via CSS container units
  }

  function setMode(newMode) {
    mode = newMode;
    if (mode === 'present') {
      layoutRoot && layoutRoot.classList.add('hidden');
      presentRoot && presentRoot.classList.remove('hidden');
      renderPresent();
    } else {
      presentRoot && presentRoot.classList.add('hidden');
      layoutRoot && layoutRoot.classList.remove('hidden');
      renderQuestions({});
    }
  }

  async function fetchStatus() {
    try {
      if (!getTeam()) { ensureTeamPrompt(); return; }
      const resp = await fetch(API('status'));
      const data = await resp.json();
      // Keep questions sorted A..E and cached
      questions = (data.questions || []).slice().sort((a, b) => a.letter.localeCompare(b.letter));
      renderInfo(data);
      renderLeaderboard(data);
      if (mode === 'present') {
        // Clamp idx and re-render
        if (idx >= questions.length) idx = Math.max(0, questions.length - 1);
        renderPresent();
      } else {
        renderQuestions({});
      }
      // Re-arm countdown to next hint/end based on new status
      armTransitionTimer();
    } catch (e) {
      // best-effort display; keep clock ticking
    }
  }

  // Boot
  fetchStatus();
  setMode('present');
  setInterval(fetchStatus, 60000);
  setInterval(tickClock, 1000);

  // Navigation: Right/Space/Click -> next, Left -> prev. After last, switch to grid mode.
  function next() {
    if (mode !== 'present') return;
    if (idx < Math.min(5, questions.length) - 1) {
      idx++;
      renderPresent();
    } else {
      setMode('grid');
    }
  }
  function prev() {
    if (mode !== 'present') return;
    if (idx > 0) {
      idx--;
      renderPresent();
    }
  }
  window.addEventListener('keydown', (e) => {
    const k = e.key;
    // Global toggles
    if (k === 'g' || k === 'G' || k === 'Escape') { setMode('grid'); return; }
    if (k === 'p' || k === 'P') { idx = 0; setMode('present'); return; }
    // Present-mode navigation
    if (mode === 'present') {
      if (k === 'ArrowRight' || k === ' ' || k === 'Spacebar') { e.preventDefault(); next(); }
      if (k === 'ArrowLeft') { e.preventDefault(); prev(); }
    }
  });
  window.addEventListener('click', () => { if (mode === 'present') next(); });
  window.addEventListener('resize', () => {
    if (mode === 'present') renderPresent(); else renderQuestions({});
  });
})();
