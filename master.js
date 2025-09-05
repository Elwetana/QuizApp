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

  function nextHintSeconds() {
    if (!current.started || !current.length) return 0;
    const now = new Date();
    const t1 = new Date(current.started.getTime() + current.length * 1000);
    const t2 = new Date(current.started.getTime() + 2 * current.length * 1000);
    if (now < t1) return (t1 - now) / 1000;
    if (now < t2) return (t2 - now) / 1000;
    return 0;
  }

  function tickClock() {
    const el = slots.info && slots.info.querySelector('.clock');
    if (el) el.textContent = fmtClock(nextHintSeconds());
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
        if (q.hint1) { const h = document.createElement('div'); h.className = 'hint'; h.textContent = 'Hint 1: ' + q.hint1; body.appendChild(h); }
        if (q.hint2) { const h = document.createElement('div'); h.className = 'hint'; h.textContent = 'Hint 2: ' + q.hint2; body.appendChild(h); }
      }
      wrap.appendChild(title);
      wrap.appendChild(body);
      t.appendChild(wrap);

      // Text auto-sizes via CSS container units
    });
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
      if (q.hint1) { const h = document.createElement('div'); h.className = 'hint'; h.textContent = 'Hint 1: ' + q.hint1; body.appendChild(h); }
      if (q.hint2) { const h = document.createElement('div'); h.className = 'hint'; h.textContent = 'Hint 2: ' + q.hint2; body.appendChild(h); }
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
      if (mode === 'present') {
        // Clamp idx and re-render
        if (idx >= questions.length) idx = Math.max(0, questions.length - 1);
        renderPresent();
      } else {
        renderQuestions({});
      }
    } catch (e) {
      // best-effort display; keep clock ticking
    }
  }

  // Boot
  fetchStatus();
  setMode('present');
  setInterval(fetchStatus, 10000);
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
    if (mode !== 'present') return;
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); next(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
  });
  window.addEventListener('click', () => { if (mode === 'present') next(); });
  window.addEventListener('resize', () => {
    if (mode === 'present') renderPresent(); else renderQuestions({});
  });
})();
