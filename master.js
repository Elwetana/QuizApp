(function () {
  /**
   * Constants and lightweight enums
   */
  const POLL_MS = 360000;
  const TRANSITION_BUFFER_MS = 50;
  const CLOCK_TICK_MS = 1000;
  const CMDS = /** @type {const} */ ({ STATUS: 'status' });
  const MODES = /** @type {const} */ ({ PRESENT: 'present', GRID: 'grid' });
  const SELECTORS = /** @type {const} */ ({
    present: '#present',
    layout: '#layout',
    strip: '#strip',
    q1: '[data-slot="q1"]',
    q2: '[data-slot="q2"]',
    q3: '[data-slot="q3"]',
    q4: '[data-slot="q4"]',
    q5: '[data-slot="q5"]',
    info: '[data-slot="info"]'
  });

  /**
   * @typedef {{ round:number, letter:string, question:string, hint1?:string, hint2?:string, question_type?:string }} Question
   * @typedef {{ round:number, active:number, name?:string, value?:number, length?:number, started?:string }} Round
   * @typedef {{ team_id?:string, name?:string, is_admin?:boolean, now?:string|number }} Team
   * @typedef {{
   *   team?: Team,
   *   current_round?: Round | null,
   *   all_rounds?: Round[],
   *   overall_totals?: { team_id:string, round:number, score:number }[],
   *   questions?: Question[],
   * }} StatusResponse
   */

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
    document.cookie = `QUIZ_TEAM=${encodeURIComponent(t)}; Max-Age=86400; Path=/; SameSite=Strict`;
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
    q1: document.querySelector(SELECTORS.q1),
    q2: document.querySelector(SELECTORS.q2),
    q3: document.querySelector(SELECTORS.q3),
    q4: document.querySelector(SELECTORS.q4),
    q5: document.querySelector(SELECTORS.q5),
    info: document.querySelector(SELECTORS.info),
  };

  let current = { round: null, started: null, length: null };
  let nextTransitionAt = null; // number ms since epoch in server time domain
  let transitionTimer = null;  // Timeout id for precise refresh
  let transitionArmed = false; // gate to avoid duplicate refresh on zero
  let serverSkewMs = 0;        // server_now_ms - Date.now()
  let questions = [];
  let mode = MODES.PRESENT;
  let idx = 0; // current question index in present mode
  let lastError = null; // Track last error for user feedback
  let finishedRoundMode = false; // Track if we're in finished round results mode
  let finishedQuestions = []; // Cache finished round questions (legacy)
  let finishedSlides = []; // Expanded slides for finished round (supports image/hints)

  const presentRoot = document.querySelector(SELECTORS.present);
  const layoutRoot = document.querySelector(SELECTORS.layout);

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
    const now = Date.now() + serverSkewMs; // compare in server time domain
    const t1 = start + L;           // Hint 1
    const t2 = start + L + L / 2;   // Hint 2
    const t3 = start + 2 * L;       // End
    if (now < t1) return t1;
    if (now < t2) return t2;
    if (now < t3) return t3;
    return null;
  }

  function secondsUntilNextTransition() {
    if (!nextTransitionAt) return 0;
    return Math.max(0, (nextTransitionAt - (Date.now() + serverSkewMs)) / 1000);
  }

  function tickClock() {
    const el = slots.info && slots.info.querySelector('.clock');
    if (el) el.textContent = fmtClock(secondsUntilNextTransition());
    if (nextTransitionAt && transitionArmed && (Date.now() + serverSkewMs) >= nextTransitionAt) {
      transitionArmed = false;
      if (transitionTimer) { clearTimeout(transitionTimer); transitionTimer = null; }
      fetchStatus();
    }
  }

  function armTransitionTimer() {
    if (transitionTimer) { clearTimeout(transitionTimer); transitionTimer = null; }
    nextTransitionAt = computeNextTransition();
    transitionArmed = !!nextTransitionAt;
    if (nextTransitionAt) {
      const nowAdj = Date.now() + serverSkewMs;
      const delay = Math.max(0, nextTransitionAt - nowAdj) + TRANSITION_BUFFER_MS;
      transitionTimer = setTimeout(() => {
        if (!transitionArmed) return; // de-dup if clock tick already triggered
        transitionArmed = false;
        fetchStatus();
      }, delay);
    }
  }
  function updateServerSkew(data) {
    try {
      if (!data) return;
      const src = (data.team && data.team.now != null) ? data.team.now : null;
      if (src == null) return;
      let t = null;
      if (typeof src === 'number') {
        t = src < 1e12 ? src * 1000 : src;
      } else {
        const d = new Date(src);
        if (!isNaN(d.getTime())) t = d.getTime();
      }
      if (t != null) serverSkewMs = t - Date.now();
    } catch (_) {
      // ignore
    }
  }

  /**
   * Get appropriate CSS class for text length
   * @param {string} text - Text content
   * @param {string} hint1 - Hint 1 content (for space calculation)
   * @param {string} hint2 - Hint 2 content (for space calculation)
   * @returns {string} CSS class name
   */
  function getTextSizeClass(text, hint1 = '', hint2 = '') {
    if (!text) return '';
    const length = text.length;
    
    // Calculate total hint content length to determine space pressure
    const hint1Length = hint1 ? hint1.length : 0;
    const hint2Length = hint2 ? hint2.length : 0;
    const totalHintLength = hint1Length + hint2Length;
    const hasHints = hint1Length > 0 || hint2Length > 0;
    
    // If no hints present, we can use larger fonts for the question
    if (!hasHints) {
      if (length > 768) return 'text-extremely-long';
      if (length > 384) return 'text-very-long';
      if (length > 192) return 'text-long';
      return '';
    }
    
    // With hints present, adjust based on hint content length
    if (totalHintLength > 200) {
      // Two long hints or one very long hint - very conservative
      if (length > 256) return 'text-extremely-long';
      if (length > 128) return 'text-very-long';
      if (length > 64) return 'text-long';
      return '';
    } else if (totalHintLength > 100) {
      // One long hint or two medium hints - conservative
      if (length > 280) return 'text-extremely-long';
      if (length > 192) return 'text-very-long';
      if (length > 96) return 'text-long';
      return '';
    } else {
      // Short hints - moderate sizing
      if (length > 512) return 'text-extremely-long';
      if (length > 256) return 'text-very-long';
      if (length > 128) return 'text-long';
      return '';
    }
  }

   function renderTextQuestion(q, body, wrap, title, isGrid = false) {
     // Regular text question
     const text = document.createElement('div');
     text.className = 'text ' + getTextSizeClass(q.question || '', q.hint1 || '', q.hint2 || '');
     text.textContent = q.question || '';
     body.appendChild(text);
     
     let h1 = null, h2 = null;
     if (q.hint1) { 
       h1 = document.createElement('div'); 
       h1.className = 'hint ' + getTextSizeClass(q.hint1, q.question, ''); // Hints use their own sizing
       h1.textContent = 'Hint 1: ' + q.hint1; 
       body.appendChild(h1); 
     }
     if (q.hint2) { 
       h2 = document.createElement('div'); 
       h2.className = 'hint ' + getTextSizeClass(q.hint2, q.question, ''); // Hints use their own sizing
       h2.textContent = 'Hint 2: ' + q.hint2; 
       body.appendChild(h2); 
     }
     
     // In grid mode, promote the latest hint
     if (isGrid) {
       const promote = h2 || h1;
       if (promote) { 
         promote.classList.add('promote'); 
         wrap.classList.add('has-promote'); 
       }
     }
   }

  function renderImageQuestion(q, body, wrap, title, isGrid = false) {
    let textQuestions = {}
    let isImage = false;
    let imageData = '';
    
    ["question", "hint1", "hint2"].forEach(qName => {
      if (!(qName in q))
        return;
      if (q[qName] === null)
        return;
      let qText = q[qName];
      if (qText && qText !== 'not_found' && qText.length > 0 && qText.length <= 1000) {
        textQuestions[qName] = qText;
        isImage = false;
      } else {
        isImage = true;
        textQuestions[qName] = '';
        imageData = qText;
      }
    });

    if(isImage) {
      const img = document.createElement('img');
      img.alt = 'Question ' + q.letter;
      img.src = 'data:image/png;base64,' + imageData;
      body.appendChild(img);
      if (!isGrid) {
        wrap.classList.add('overlay-letter');
        title.classList.add('image-overlay');
      }
    } else {
      renderTextQuestion(textQuestions, body, wrap, title, isGrid);
    }      
  } 
  
  /**
   * Common question rendering logic
   * @param {Question} q - Question object
   * @param {boolean} isGrid - Whether this is for grid mode (affects hint promotion)
   * @returns {HTMLElement} Rendered question wrapper
   */
  function createQuestionElement(q, isGrid = false) {
    const wrap = document.createElement('div');
    wrap.className = 'qwrap';
    
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = q.letter + '.';
    
    const body = document.createElement('div');
    body.className = 'body';
    
    if (q.question_type === 'image/png') {
      renderImageQuestion(q, body, wrap, title, isGrid);
    } else {
      renderTextQuestion(q, body, wrap, title, isGrid);
    }

    wrap.appendChild(title);
    wrap.appendChild(body);
    return wrap;
  }

  function renderQuestions(data) {
    const qs = questions.slice(0, 5);
    const targets = [slots.q1, slots.q2, slots.q3, slots.q4, slots.q5];
    targets.forEach((t, i) => {
      if (!t) return;
      const q = qs[i];
      t.replaceChildren();
      if (!q) return;
      
      const wrap = createQuestionElement(q, true);
      t.appendChild(wrap);

      // Allow clicking a grid cell to switch to Present mode on that question
      t.style.cursor = 'pointer';
      t.onclick = () => { idx = i; setMode(MODES.PRESENT); };
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

  function renderPresent() {
    if (!presentRoot) return;
    presentRoot.replaceChildren();
    const q = questions[idx];
    if (!q) return;
    
    const panel = document.createElement('div');
    panel.className = 'panel';
    const wrap = createQuestionElement(q, false); // No hint promotion in presentation mode
    panel.appendChild(wrap);
    presentRoot.appendChild(panel);
  }

  function setMode(newMode) {
    mode = newMode;
    if (mode === MODES.PRESENT) {
      layoutRoot && layoutRoot.classList.add('hidden');
      presentRoot && presentRoot.classList.remove('hidden');
      renderPresent();
    } else {
      presentRoot && presentRoot.classList.add('hidden');
      layoutRoot && layoutRoot.classList.remove('hidden');
      renderQuestions({});
    }
  }

  /**
   * Show error message to user
   * @param {string} message - Error message to display
   */
  function showError(message) {
    lastError = message;
    if (presentRoot) {
      presentRoot.replaceChildren();
      const errorDiv = document.createElement('div');
      errorDiv.className = 'error-message';
      errorDiv.style.cssText = 'display: flex; align-items: center; justify-content: center; height: 100%; color: #ef4444; font-size: 2rem; text-align: center;';
      errorDiv.textContent = message;
      presentRoot.appendChild(errorDiv);
    }
  }

  /**
   * Show "Game haven't started yet" message
   */
  function showGameNotStarted() {
    if (presentRoot) {
      presentRoot.replaceChildren();
      const messageDiv = document.createElement('div');
      messageDiv.className = 'game-not-started';
      messageDiv.style.cssText = 'display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text); font-size: 3rem; text-align: center; font-weight: 600;';
      messageDiv.textContent = "Game hasn't started yet";
      presentRoot.appendChild(messageDiv);
    }
  }

  /**
   * Initialize finished round results mode with slide-based navigation
   * @param {StatusResponse} data - Status data containing finished round info
   */
  function initFinishedRoundResults(data) {
    // Get the last finished round
    const finishedRounds = (data.all_rounds || []).filter(r => Number(r.active) === 2);
    if (!finishedRounds.length) {
      showError('No finished rounds to display.');
      return;
    }
    
    const lastRound = finishedRounds.sort((a, b) => Number(b.round) - Number(a.round))[0];
    const roundQuestions = (data.questions || []).filter(q => Number(q.round) === Number(lastRound.round));
    
    if (!roundQuestions.length) {
      showError('No questions found for finished round.');
      return;
    }
    
    // Helper to group answers by text and correctness
    const groupAnswers = (answers) => {
      const grouped = {};
      (answers || []).forEach(answer => {
        const text = answer.answered;
        const points = Number(answer.points);
        const key = String(text);
        if (!grouped[key]) {
          grouped[key] = { text, count: 0, anyCorrect: false };
        }
        grouped[key].count++;
        if (points > -1) grouped[key].anyCorrect = true;
      });
      return Object.values(grouped).sort((a, b) => (b.anyCorrect === a.anyCorrect ? b.count - a.count : (b.anyCorrect ? 1 : -1)));
    };

    // Build expanded slides per question
    finishedSlides = [];
    roundQuestions
      .slice()
      .sort((a,b) => a.letter.localeCompare(b.letter))
      .forEach(q => {
        const answers = (data.all_answers || []).filter(answer => 
          Number(answer.round) === Number(lastRound.round) && answer.letter === q.letter
        );
        const grouped = groupAnswers(answers);
        if (q.question_type === 'image/png') {
          // Create separate slides for each image (question, hint1, hint2)
          // Only create slides for fields that are actually images (base64 encoded, much longer than text)
          
          // Question slide (image or text)
          if (q.question && q.question !== 'not_found' && q.question.length > 0) {
            if (q.question.length > 1000) {
              // Question is an image
              finishedSlides.push({ kind: 'image', letter: q.letter, img: q.question, hint: null, grouped, slideType: 'question' });
            } else {
              // Question is text
              finishedSlides.push({ kind: 'text', letter: q.letter, text: `${q.letter}. ${q.question}`, grouped });
            }
          }
          
          // Hint 1 image slide (if hint1 exists and is an image)
          if (q.hint1 && q.hint1 !== 'not_found' && q.hint1.length > 1000) {
            finishedSlides.push({ kind: 'image', letter: q.letter, img: q.hint1, hint: 'Hint 1', grouped, slideType: 'hint1' });
          }
          
          // Hint 2 image slide (if hint2 exists and is an image)
          if (q.hint2 && q.hint2 !== 'not_found' && q.hint2.length > 1000) {
            finishedSlides.push({ kind: 'image', letter: q.letter, img: q.hint2, hint: 'Hint 2', grouped, slideType: 'hint2' });
          }
        } else {
          // Text question: single slide, no hints in finished view
          finishedSlides.push({ kind: 'text', letter: q.letter, text: `${q.letter}. ${q.question}`, grouped });
        }
      });
    
    // Append round results slide (team vs round_score) from overall_totals
    try {
      const totals = Array.isArray(data.overall_totals) ? data.overall_totals : [];
      const rows = totals
        .filter(r => Number(r.round) === Number(lastRound.round))
        .map(r => ({ team: String(r.team_id || ''), round_score: Number(r.round_score || 0) }))
        .sort((a, b) => b.round_score - a.round_score);
      if (rows.length) {
        finishedSlides.push({ kind: 'results', round: Number(lastRound.round), rows });
      }
    } catch(_) { /* ignore */ }

    // Append overall leaderboard slide
    try {
      const rows = data && Array.isArray(data.overall_totals) ? data.overall_totals : [];
      const totals = new Map();
      const lastRoundScores = new Map();
      
      for (const r of rows) {
        const id = r.team_id;
        const sc = Number(r.score) || 0;
        const round = Number(r.round);
        totals.set(id, (totals.get(id) || 0) + sc);
        
        // Store last round scores
        if (round === Number(lastRound.round)) {
          lastRoundScores.set(id, Number(r.round_score) || 0);
        }
      }
      const leaderboard = Array.from(totals.entries())
        .map(([team_id, total]) => ({ 
          team_id, 
          total, 
          lastRoundScore: lastRoundScores.get(team_id) || 0 
        }))
        .sort((a, b) => b.total - a.total);
      if (leaderboard.length) {
        finishedSlides.push({ kind: 'leaderboard', leaderboard });
      }
    } catch(_) { /* ignore */ }

    finishedRoundMode = true;
    if (!finishedSlides.length) { showError('No slides to display.'); return; }
    idx = 0; // Start at first slide
    renderFinishedRoundSlide();
  }

  /**
   * Render a single finished round question slide with its results
   */
  function renderFinishedRoundSlide() {
    if (!presentRoot || !finishedRoundMode || !finishedSlides.length) return;
    
    const slide = finishedSlides[idx];
    if (!slide) return;
    
    presentRoot.replaceChildren();
    
    if (slide.kind === 'image') {
      // Use the same question rendering pathway as active rounds for consistency
      const panel = document.createElement('div');
      panel.className = 'panel';
      panel.style.position = 'relative'; // Make panel a positioned parent for the overlay
      
      // Create a question object that matches the expected format
      const questionObj = {
        letter: slide.letter,
        question: slide.img,
        question_type: 'image/png'
      };
      
      const wrap = createQuestionElement(questionObj, false); // Use same function as active rounds
      panel.appendChild(wrap);
      
      // Add hint label to the question body if present
      if (slide.hint) {
        const hintDiv = document.createElement('div');
        hintDiv.className = 'hint';
        hintDiv.textContent = slide.hint;
        wrap.querySelector('.body').appendChild(hintDiv);
      }
      
      // Create overlay for answers on top of the image
      const overlay = document.createElement('div');
      overlay.className = 'fin-overlay';
      const box = document.createElement('div');
      box.className = 'fin-overlay-box';
      
      const answersContainer = document.createElement('div');
      answersContainer.className = 'fin-answers';
      slide.grouped.forEach(group => {
        const answerDiv = document.createElement('div');
        answerDiv.className = 'fin-answer ' + (group.anyCorrect ? 'correct' : 'incorrect');
        const answerText = document.createElement('div');
        answerText.className = 'fin-answer-text';
        answerText.textContent = group.count > 1 ? `${group.count} × ${group.text}` : group.text;
        answerDiv.appendChild(answerText);
        answersContainer.appendChild(answerDiv);
      });
      box.appendChild(answersContainer);
      overlay.appendChild(box);
      
      // Add overlay to the panel (not to the wrap, so it covers the entire panel)
      panel.appendChild(overlay);
      presentRoot.appendChild(panel);
    } else if (slide.kind === 'results') {
      const panel = document.createElement('div');
      panel.className = 'panel';
      const header = document.createElement('div');
      header.className = 'fin-header';
      header.textContent = `Round ${slide.round} results`;
      panel.appendChild(header);
      const box = document.createElement('div');
      box.className = 'fin-results';
      const perCol = 10;
      for (let i = 0; i < slide.rows.length; i += perCol) {
        const chunk = slide.rows.slice(i, i + perCol);
        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const trh = document.createElement('tr');
        const th1 = document.createElement('th'); th1.textContent = 'Team'; trh.appendChild(th1);
        const th2 = document.createElement('th'); th2.textContent = 'Round score'; trh.appendChild(th2);
        thead.appendChild(trh);
        table.appendChild(thead);
        const tbody = document.createElement('tbody');
        chunk.forEach((r, index) => {
          const tr = document.createElement('tr');
          const globalIndex = i + index; // Calculate global position in the full list
          const isUpperHalf = globalIndex < Math.ceil(slide.rows.length / 2);
          const hasScore = r.round_score > 0;
          if (isUpperHalf && hasScore) {
            tr.classList.add('upper-half');
          }
          const tdTeam = document.createElement('td'); tdTeam.textContent = r.team; tr.appendChild(tdTeam);
          const tdScore = document.createElement('td'); tdScore.textContent = String(r.round_score); tdScore.className = 'score'; tr.appendChild(tdScore);
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        box.appendChild(table);
      }
      panel.appendChild(box);
      presentRoot.appendChild(panel);
    } else if (slide.kind === 'text') {
      // Use the same question rendering pathway as active rounds for consistency
      const panel = document.createElement('div');
      panel.className = 'panel';
      
      // Create a question object that matches the expected format
      const questionObj = {
        letter: slide.letter,
        question: slide.text ? slide.text.replace(/^[A-E]\.\s*/, '') : '', // Remove letter prefix if present
        question_type: 'text' // Force text type for finished round display
      };
      
      const wrap = createQuestionElement(questionObj, false); // Use same function as active rounds
      panel.appendChild(wrap);
      
      // Add answers below the question using the same structure
      const answersContainer = document.createElement('div');
      answersContainer.className = 'fin-answers';
      slide.grouped.forEach(group => {
        const answerDiv = document.createElement('div');
        answerDiv.className = 'fin-answer ' + (group.anyCorrect ? 'correct' : 'incorrect');
        const answerText = document.createElement('div');
        answerText.className = 'fin-answer-text';
        answerText.textContent = group.count > 1 ? `${group.count} × ${group.text}` : group.text;
        answerDiv.appendChild(answerText);
        answersContainer.appendChild(answerDiv);
      });
      panel.appendChild(answersContainer);
      presentRoot.appendChild(panel);
    } else if (slide.kind === 'leaderboard') {
      const panel = document.createElement('div');
      panel.className = 'panel';
      
      const header = document.createElement('div');
      header.className = 'fin-header';
      header.textContent = 'Overall Leaderboard';
      panel.appendChild(header);
      
      const boardContainer = document.createElement('div');
      boardContainer.className = 'fin-results';
      
      if (!slide.leaderboard.length) {
        const emptyDiv = document.createElement('div');
        emptyDiv.textContent = 'No scores yet.';
        emptyDiv.style.textAlign = 'center';
        emptyDiv.style.fontSize = 'clamp(16px, min(6cqh, 5cqw), 48px)';
        boardContainer.appendChild(emptyDiv);
      } else {
        const perCol = 10;
        for (let i = 0; i < slide.leaderboard.length; i += perCol) {
          const chunk = slide.leaderboard.slice(i, i + perCol);
          const table = document.createElement('table');
          const thead = document.createElement('thead');
          const trh = document.createElement('tr');
          const th1 = document.createElement('th'); th1.textContent = 'Team'; trh.appendChild(th1);
          const th2 = document.createElement('th'); th2.textContent = 'Last Round'; trh.appendChild(th2);
          const th3 = document.createElement('th'); th3.textContent = 'Total Score'; trh.appendChild(th3);
          thead.appendChild(trh);
          table.appendChild(thead);
          const tbody = document.createElement('tbody');
          chunk.forEach((t, index) => {
            const tr = document.createElement('tr');
            const tdTeam = document.createElement('td'); tdTeam.textContent = t.team_id; tr.appendChild(tdTeam);
            const tdLastRound = document.createElement('td'); tdLastRound.textContent = String(t.lastRoundScore); tdLastRound.className = 'score'; tr.appendChild(tdLastRound);
            const tdScore = document.createElement('td'); tdScore.textContent = String(t.total); tdScore.className = 'score'; tr.appendChild(tdScore);
            tbody.appendChild(tr);
          });
          table.appendChild(tbody);
          boardContainer.appendChild(table);
        }
      }
      
      panel.appendChild(boardContainer);
      presentRoot.appendChild(panel);
    }
  }

  async function fetchStatus() {
    try {
      if (!getTeam()) { ensureTeamPrompt(); return; }
      const resp = await fetch(API(CMDS.STATUS));
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }
      const data = await resp.json();
      lastError = null; // Clear any previous errors
      
      // Check game state and render accordingly
      const allRounds = data.all_rounds || [];
      const hasActiveRound = allRounds.some(r => Number(r.active) === 1);
      const hasFinishedRounds = allRounds.some(r => Number(r.active) === 2);
      const allRoundsInactive = allRounds.every(r => Number(r.active) === 0);
      
      if (allRoundsInactive) {
        // Game haven't started yet
        showGameNotStarted();
        return;
      } else if (!hasActiveRound && hasFinishedRounds) {
        // Show finished round results
        initFinishedRoundResults(data);
        return;
      } else if (hasActiveRound) {
        // Active round - normal operation
        finishedRoundMode = false; // Reset finished round mode
        // Keep questions sorted A..E and cached
        questions = (data.questions || []).slice().sort((a, b) => a.letter.localeCompare(b.letter));
        // Align client to server clock if provided
        updateServerSkew(data);
        renderInfo(data);
        renderLeaderboard(data);
        if (mode === MODES.PRESENT) {
          // Clamp idx and re-render
          if (idx >= questions.length) idx = Math.max(0, questions.length - 1);
          renderPresent();
        } else {
          renderQuestions({});
        }
        // Re-arm countdown to next hint/end based on new status
        armTransitionTimer();
      }
    } catch (e) {
      console.error('Fetch error:', e);
      const errorMsg = e instanceof Error ? e.message : 'Network error';
      showError(`Connection Error: ${errorMsg}`);
      // Keep clock ticking even on error
    }
  }

  // Boot
  fetchStatus();
  setMode(MODES.PRESENT);
  setInterval(tickClock, CLOCK_TICK_MS);

  // Navigation: Right/Space/Click -> next, Left -> prev. After last, switch to grid mode.
  function next() {
    if (finishedRoundMode) {
      // In finished round mode, navigate through slides
      if (idx < finishedSlides.length - 1) {
        idx++;
        renderFinishedRoundSlide();
      }
      // Stay on last question (don't switch to grid mode)
      return;
    }
    
    if (mode !== MODES.PRESENT) return;
    if (idx < Math.min(5, questions.length) - 1) {
      idx++;
      renderPresent();
    } else {
      setMode(MODES.GRID);
    }
  }
  function prev() {
    if (finishedRoundMode) {
      // In finished round mode, navigate through slides
      if (idx > 0) {
        idx--;
        renderFinishedRoundSlide();
      }
      return;
    }
    
    if (mode !== MODES.PRESENT) return;
    if (idx > 0) {
      idx--;
      renderPresent();
    }
  }
  window.addEventListener('keydown', (e) => {
    const k = e.key;
    // Global toggles (only work when not in finished round mode)
    if (!finishedRoundMode) {
      if (k === 'g' || k === 'G' || k === 'Escape') { setMode(MODES.GRID); return; }
      if (k === 'p' || k === 'P') { idx = 0; setMode(MODES.PRESENT); return; }
    }
    // Present-mode and finished-round navigation
    if (mode === MODES.PRESENT || finishedRoundMode) {
      if (k === 'ArrowRight' || k === ' ' || k === 'Spacebar') { e.preventDefault(); next(); }
      if (k === 'ArrowLeft') { e.preventDefault(); prev(); }
    }
  });
  window.addEventListener('click', () => { 
    if (mode === MODES.PRESENT || finishedRoundMode) next(); 
  });
  window.addEventListener('resize', () => {
    if (finishedRoundMode) {
      renderFinishedRoundSlide();
    } else if (mode === MODES.PRESENT) {
      renderPresent();
    } else {
      renderQuestions({});
    }
  });
})();
