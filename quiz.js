/* Unified player client (Questions + inline Answer) with cleaned UI strings */
(function () {
  /**
   * Constants and lightweight enums
   */
  const POLL_MS = 60000;
  const CMDS = /** @type {const} */ ({ STATUS: 'status', GUESS: 'guess', RENAME: 'rename', ROUND: 'round', DEFINE: 'define', RESET: 'reset' });
  const REASONS = /** @type {const} */ ({ COOLDOWN: 'cooldown_active', NO_LETTER: 'no_letter', NO_ACTIVE: 'no_active', NOT_ACCEPTED: 'not_accepted' });
  const SELECTORS = /** @type {const} */ ({
    tabsButtons: '#tabs button',
    tab: '.tab',
    adminTab: '#adminTab',
    guessTabBtn: '#tabs button[data-tab="guess"]',
    guessSection: '#guess',
    historyTabBtn: '#tabs button[data-tab="history"]',
    historySection: '#history',
    questionsList: '#questionsList',
    scoreboard: '#scoreboard',
    roundButtons: '#roundButtons',
    progressFilter: '#progressFilter',
    progress: '#progress',
    progressSummary: '#progressSummary',
    adminTeams: '#adminTeams',
    roundResult: '#roundResult',
    defineFile: '#defineFile',
    defineBtn: '#defineBtn',
    openMaster: '#openMaster',
    startRound: '#startRound',
    finishRound: '#finishRound',
    closeRound: '#closeRound',
    resetBtn: '#resetBtn',
    foot: '#foot'
  });

  /**
   * @typedef {{ round:number, letter:string, question:string, hint1?:string, hint2?:string, question_type?:string }} Question
   * @typedef {{ round:number, active:number, name?:string, value?:number, length?:number, started?:string }} Round
   * @typedef {{ time:string, round:number, letter:string, answered:string }} Action
   * @typedef {{
   *   team?: { team_id?:string, name?:string, is_admin?:boolean },
   *   current_round?: Round | null,
   *   all_rounds?: Round[],
   *   overall_totals?: { team_id:string, round:number, score:number }[],
   *   my_actions?: Action[],
   *   questions?: Question[],
   *   round_progress?: { team?:string, name?:string, letter?:string, answered?:string, points?:number }[],
   * }} StatusResponse
   */
  const qs = new URLSearchParams(location.search);
  const TEAM = (qs.get('team') || '').toUpperCase();
  const API = (cmd, params = {}) => {
    const u = new URL(location.href);
    u.searchParams.set('team', TEAM);
    u.searchParams.set('cmd', cmd);
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
    return u.toString();
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const toBool = (v) => {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return ['t', 'true', '1', 'y', 'yes'].includes(v.toLowerCase());
    return false;
  };

  // Countdown functions
  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
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

  function computeNextTransition(roundData) {
    if (!roundData || !roundData.started || !roundData.length) return null;
    const start = new Date(roundData.started).getTime();
    const L = Number(roundData.length) * 1000;
    const now = Date.now() + serverSkewMs;
    const t1 = start + L;           // Hint 1
    const t2 = start + L + L / 2;   // Hint 2
    const t3 = start + 2 * L;       // End
    if (now < t1) return t1;
    if (now < t2) return t2;
    if (now < t3) return t3;
    return null;
  }

  function secondsUntilNextTransition(roundData) {
    const nextTransition = computeNextTransition(roundData);
    if (!nextTransition) return 0;
    return Math.max(0, (nextTransition - (Date.now() + serverSkewMs)) / 1000);
  }

  function updateCountdown(data) {
    const countdownEl = document.getElementById('countdown');
    if (!countdownEl) return;

    const hasActiveRound = data.current_round && Number(data.current_round.active) === 1;
    
    if (hasActiveRound) {
      const seconds = secondsUntilNextTransition(data.current_round);
      countdownEl.textContent = fmtClock(seconds);
      countdownEl.classList.remove('hidden');
    } else {
      countdownEl.classList.add('hidden');
    }
  }

  function startCountdownTimer() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
    }
    countdownTimer = setInterval(() => {
      if (lastStatus) {
        updateCountdown(lastStatus);
      }
    }, 1000);
  }

  // Initial caption fallback to team code
  const cap = document.getElementById('caption');
  if (cap) cap.textContent = TEAM || 'Pub Quiz';

  // Tabs
  $$(SELECTORS.tabsButtons).forEach((btn) =>
    btn.addEventListener('click', () => {
      $$(SELECTORS.tabsButtons).forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const id = btn.dataset.tab;
      $$(SELECTORS.tab).forEach((s) => s.classList.remove('active'));
      document.getElementById(id).classList.add('active');
    })
  );

  // State
  let isAdmin = false;
  let currentRound = null;
  let selectedLetter = null;
  let selectedRound = null;
  let editingCaption = false;
  let progressFilter = null; // admin: letter filter for round progress
  // Preserve inline answer drafts across refreshes
  let editingAnswer = false;
  let answerDraft = '';
  let answerDraftLetter = null;
  let lastStatus = null;
  // Countdown state
  let countdownTimer = null;
  let serverSkewMs = 0;

  function setSelectedRound(r) {
    selectedRound = Number(r);
    const btns = Array.from(document.querySelectorAll('#roundButtons button'));
    btns.forEach((b) => b.classList.toggle('selected', Number(b.dataset.round) === selectedRound));
  }

  function setProgressFilter(letter) {
    progressFilter = letter || null;
    const btns = Array.from(document.querySelectorAll('#progressFilter button'));
    btns.forEach((b) => {
      const isAll = b.textContent === 'All';
      const match = progressFilter ? (b.textContent === progressFilter) : isAll;
      b.classList.toggle('selected', !!match);
    });
    if (lastStatus) renderRoundProgress(lastStatus);
  }

  function canEditTeamName(data) {
    const rounds = Array.isArray(data.all_rounds) ? data.all_rounds : [];
    // If no rounds are defined, allow editing (initial setup state)
    if (rounds.length === 0) return true;
    // NEW BEHAVIOR: Only allow editing before game starts (all rounds have active = 0)
    return rounds.every(r => Number(r.active) === 0);
  }

  function renderRoundProgressFilter(data) {
    const row = document.querySelector(SELECTORS.progressFilter);
    if (!row) return;
    row.replaceChildren();
    const qs = Array.isArray(data.questions) ? data.questions : [];
    const letters = Array.from(new Set(qs.map(q => q.letter))).sort();
    if (!letters.length) return;
    // All button
    const allBtn = document.createElement('button');
    allBtn.textContent = 'All';
    allBtn.addEventListener('click', () => setProgressFilter(null));
    row.appendChild(allBtn);
    letters.forEach((L) => {
      const b = document.createElement('button');
      b.textContent = L;
      b.addEventListener('click', () => setProgressFilter(L));
      row.appendChild(b);
    });
    // Re-apply selection
    setProgressFilter(progressFilter);
  }

  function renderRoundProgress(data) {
    const wrap = document.querySelector(SELECTORS.progress);
    if (!wrap) return;
    wrap.replaceChildren();
    const rows = Array.isArray(data.round_progress) ? data.round_progress : [];
    if (!rows.length) { wrap.textContent = 'No guesses yet.'; return; }
    const filtered = progressFilter ? rows.filter(r => (r.letter || '').toUpperCase() === progressFilter) : rows;
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    ['Team', 'Letter', 'Answer', 'Result'].forEach((h) => { const th = document.createElement('th'); th.textContent = h; trh.appendChild(th); });
    thead.appendChild(trh);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    filtered.forEach((r) => {
      const tr = document.createElement('tr');
      const teamLabel = (r.team || r.name || r["?column?"] || r.coalesce || r.team_id || '').toString();
      const letter = (r.letter || '').toString();
      const ans = (r.answered || '').toString();
      const pts = Number(r.points);
      const res = isFinite(pts) ? (pts >= 0 ? 'OK' : 'X') : '';
      [teamLabel, letter, ans, res].forEach((val) => { const td = document.createElement('td'); td.textContent = val; tr.appendChild(td); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  function renderRoundProgressSummary(data) {
    const wrap = document.querySelector(SELECTORS.progressSummary);
    if (!wrap) return;
    wrap.replaceChildren();
    const rows = Array.isArray(data.round_progress) ? data.round_progress : [];
    if (!rows.length) { wrap.textContent = 'No data.'; return; }
    // Count correct per letter (points >= 0 considered correct, including very late 0)
    const counts = new Map();
    rows.forEach(r => {
      const letter = (r.letter || '').toUpperCase();
      const pts = Number(r.points);
      if (letter && isFinite(pts) && pts >= 0) counts.set(letter, (counts.get(letter) || 0) + 1);
    });
    // Build list in letter order A..Z for current questions
    const qs = Array.isArray(data.questions) ? data.questions : [];
    const letters = Array.from(new Set(qs.map(q => q.letter))).sort();
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    ['Letter', 'Correct guesses'].forEach((h) => { const th = document.createElement('th'); th.textContent = h; trh.appendChild(th); });
    thead.appendChild(trh);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    (letters.length ? letters : Array.from(counts.keys()).sort()).forEach(L => {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td'); td1.textContent = L; tr.appendChild(td1);
      const td2 = document.createElement('td'); td2.textContent = counts.get(L) || 0; tr.appendChild(td2);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  function renderHistory(data) {
    const wrap = $('#historyList');
    if (!wrap) return;
    wrap.replaceChildren();
    const actions = data.my_actions || [];
    if (!actions.length) { wrap.textContent = 'No actions yet.'; return; }

    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    ['Time', 'Round', 'Letter', 'Answer'].forEach((h) => {
      const th = document.createElement('th'); th.textContent = h; trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    actions.forEach((a) => {
      const tr = document.createElement('tr');
      const t = new Date(a.time);
      const timeStr = isNaN(t.getTime()) ? '' : t.toLocaleTimeString();
      const ans = (a.answered || '').toString();
      const pretty = '"' + ans.slice(0, 60) + (ans.length > 60 ? '...' : '') + '"';
      const cells = [ timeStr, 'R' + (a.round ?? ''), (a.letter || ''), pretty ];
      cells.forEach((val) => { const td = document.createElement('td'); td.textContent = val; tr.appendChild(td); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  function renderCurrentRound(data) {
    const el = $('#currentRound');
    if (!el) return;
    el.replaceChildren();
    const cr = data.current_round;
    if (!cr) { el.textContent = 'No active round.'; return; }
    currentRound = Number(cr.round);
    const started = cr.started ? new Date(cr.started).toLocaleTimeString() : '-';
    el.innerHTML = `Round ${cr.round} | ${cr.name || ''} | value=${cr.value} | length=${cr.length}s | started=${started}`;

    // Default admin round selection to current round if none selected
    if (selectedRound == null && currentRound) setSelectedRound(currentRound);

    // Rounds summary using all_rounds (if present)
    if (Array.isArray(data.all_rounds)) {
      const total = data.all_rounds.length;
      const currentIdx = data.all_rounds.findIndex(r => Number(r.round) === currentRound);
      const remaining = currentIdx >= 0 ? (total - currentIdx - 1) : (total - 1);
      const summary = document.createElement('div');
      summary.textContent = `Rounds: ${total} total - ${remaining} remaining`;
      el.appendChild(summary);
    }
  }

  function renderRoundsOverview(data) {
    const all = Array.isArray(data.all_rounds) ? data.all_rounds : [];
    const byActive = { '0': [], '1': [], '2': [] };
    all.forEach(r => { const a = Number(r.active); (byActive[a] || byActive['0']).push(r); });
    const mkList = (arr) => {
      if (!arr.length) return 'None';
      const ul = document.createElement('ul');
      arr.sort((a,b)=>Number(a.round)-Number(b.round)).forEach(r => {
        const li = document.createElement('li');
        const name = (r.name || '').toString();
        const value = (r.value != null) ? `, value ${r.value}` : '';
        li.textContent = `R${r.round}${name ? `: ${name}` : ''}${value}`;
        ul.appendChild(li);
      });
      return ul;
    };
    const mount = (id, nodeOrText) => { const el = document.getElementById(id); if (!el) return; el.replaceChildren(); if (typeof nodeOrText === 'string') { el.textContent = nodeOrText; } else { el.appendChild(nodeOrText); } };
    mount('roundsCompleted', mkList(byActive['2']));
    mount('roundsCurrent', mkList(byActive['1']));
    mount('roundsFuture', mkList(byActive['0']));
  }

  function renderAdminTeams(data) {
    const mount = document.querySelector(SELECTORS.adminTeams);
    if (!mount) return;
    mount.replaceChildren();
    const rows = Array.isArray(data.all_teams) ? data.all_teams : [];
    if (!rows.length) { mount.textContent = 'No teams.'; return; }
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    ['Team ID', 'Name', 'Last seen (s)'].forEach((h) => { const th = document.createElement('th'); th.textContent = h; trh.appendChild(th); });
    thead.appendChild(trh);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    rows
      .slice()
      .sort((a,b)=>String(a.team_id).localeCompare(String(b.team_id)))
      .forEach(t => {
        const tr = document.createElement('tr');
        const idCell = document.createElement('td');
        const a = document.createElement('a');
        a.href = `quiz.php?team=${encodeURIComponent(String(t.team_id || '').toUpperCase())}`;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = String(t.team_id || '').toUpperCase();
        idCell.appendChild(a);
        const nameCell = document.createElement('td');
        nameCell.textContent = String(t.name || '');
        const ageCell = document.createElement('td');
        const age = Number(t.age_last_seen);
        ageCell.textContent = isFinite(age) ? Math.floor(age).toString() : '';
        tr.appendChild(idCell);
        tr.appendChild(nameCell);
        tr.appendChild(ageCell);
        tbody.appendChild(tr);
      });
    table.appendChild(tbody);
    mount.appendChild(table);
  }

  function renderQuestions(data) {
    const list = document.querySelector(SELECTORS.questionsList);
    if (!list) return;
    // Preserve scroll position and focus target (answer textarea) across re-render
    const prevScroll = list.scrollTop;
    const activeId = document.activeElement && document.activeElement.classList.contains('answer-input') ? document.activeElement.id : '';
    list.replaceChildren();
    const qs = data.questions || [];
    
    // Determine if we should use team_answers (no active round) or my_actions (active round)
    const hasActiveRound = data.current_round && Number(data.current_round.active) === 1;
    let latest = {};
    
    if (hasActiveRound) {
      // Build latest answer map per letter for the current round using my_actions
      const acts = Array.isArray(data.my_actions) ? data.my_actions : [];
      const roundFilter = Number(currentRound || 0);
      for (const a of acts) {
        const L = (a.letter || '').toUpperCase();
        const r = Number(a.round || 0);
        if (!L) continue;
        if (roundFilter && r !== roundFilter) continue;
        if (!(L in latest)) latest[L] = (a.answered || '').toString(); // actions are newest-first
      }
    } else {
      // Use team_answers when no round is active
      const teamAnswers = Array.isArray(data.team_answers) ? data.team_answers : [];
      for (const answer of teamAnswers) {
        const L = (answer.letter || '').toUpperCase();
        if (!L) continue;
        latest[L] = {
          answered: (answer.answered || '').toString(),
          points: Number(answer.points),
          value: Number(answer.value)
        };
      }
    }
    if (!qs.length) {
      list.textContent = 'Questions will appear when a round is active.';
      return;
    }

    // If answering a selected letter, show only that question with inline controls (players only)
    if (!isAdmin && data.current_round && selectedLetter) {
      const q = qs.find((x) => x.letter === selectedLetter);
      if (!q) {
        selectedLetter = null;
      } else {
        const card = document.createElement('div');
        card.className = 'q';
        card.style.margin = '0 0 .75rem 0';
        card.setAttribute('data-letter', q.letter);
        const parts = [];
        if (q.question_type === 'image/png') {
          parts.push(`<div><b>${q.letter}.</b></div>`);
          parts.push(`<img alt="Question ${q.letter}" src="data:image/png;base64,${q.question}" />`);
        } else {
          parts.push(`<div><b>${q.letter}.</b> ${q.question || ''}</div>`);
        }
        if (q.hint1) parts.push(`<div><small>Hint 1:</small> ${q.hint1}</div>`);
        if (q.hint2) parts.push(`<div><small>Hint 2:</small> ${q.hint2}</div>`);
        // Latest personal answer under the question
        const mine = latest[q.letter];
        if (mine) {
          if (typeof mine === 'string') {
            // Active round - simple string display
            parts.push(`<div><small>You answered:</small> ${mine}</div>`);
          } else {
            // No active round - show with color background based on validity
            const isValid = mine.points >= 0;
            const answerClass = isValid ? 'team-answer correct' : 'team-answer incorrect';
            parts.push(`<div><small>You answered:</small> <span class="${answerClass}">${mine.answered}</span></div>`);
          }
        }
        parts.push(`
          <label>
            <span>Answer</span>
            <textarea class="answer-input" id="answer-${q.letter}" rows="3" placeholder="Type your answer" aria-label="Answer for question ${q.letter}" enterkeyhint="send" autocomplete="off" autocapitalize="none" autocorrect="off" inputmode="text"></textarea>
          </label>
          <div class="row">
            <button data-action="submit" class="primary">Submit</button>
            <button data-action="back">Back</button>
          </div>
          <div class="result" data-role="guessResult" role="status" aria-live="polite" aria-atomic="true"></div>
        `);
        card.innerHTML = parts.join('');
        list.appendChild(card);

        const back = card.querySelector('[data-action="back"]');
        if (back) back.addEventListener('click', () => {
          selectedLetter = null;
          editingAnswer = false;
          answerDraft = '';
          answerDraftLetter = null;
          renderQuestions(lastStatus || { questions: [] });
        });
        const submit = card.querySelector('[data-action="submit"]');
        if (submit) submit.addEventListener('click', submitGuess);
        const ansEl = card.querySelector('.answer-input');
        if (ansEl) {
          if (editingAnswer && typeof answerDraft === 'string' && answerDraftLetter === selectedLetter) ansEl.value = answerDraft;
          ansEl.addEventListener('input', () => { answerDraft = ansEl.value; editingAnswer = true; answerDraftLetter = selectedLetter; });
          // Keyboard-first: Enter submits when not using Shift (single-line answers). Ctrl/Cmd+Enter also submits. Escape goes back.
          ansEl.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault(); back && back.click(); return; }
            if (e.key === 'Enter' && ((e.ctrlKey || e.metaKey) || !e.shiftKey)) {
              e.preventDefault(); submit && submit.click();
            }
          });
          // Move focus into the answer textbox
          setTimeout(() => { try { ansEl.focus(); ansEl.selectionStart = ansEl.value.length; } catch(_) {} }, 0);
        }
        return;
      }
    }

    // Default list view (Answer buttons only for players)
    const frag = document.createDocumentFragment();
    qs.forEach((q) => {
      const card = document.createElement('div');
      card.className = 'q';
      card.style.margin = '0 0 .75rem 0';
      card.setAttribute('data-letter', q.letter);
      const parts = [];
      if (q.question_type === 'image/png') {
        parts.push(`<div><b>${q.letter}.</b></div>`);
        parts.push(`<img alt="Question ${q.letter}" src="data:image/png;base64,${q.question}" />`);
      } else {
        parts.push(`<div><b>${q.letter}.</b> ${q.question || ''}</div>`);
      }
      if (q.hint1) parts.push(`<div><small>Hint 1:</small> ${q.hint1}</div>`);
      if (q.hint2) parts.push(`<div><small>Hint 2:</small> ${q.hint2}</div>`);
      // Latest personal answer summary line
      const mine = latest[q.letter];
      if (mine) {
        if (typeof mine === 'string') {
          // Active round - simple string display
          parts.push(`<div><small>You answered:</small> ${mine}</div>`);
        } else {
          // No active round - show with color background based on validity
          const isValid = mine.points >= 0;
          const answerClass = isValid ? 'team-answer correct' : 'team-answer incorrect';
          parts.push(`<div><small>You answered:</small> <span class="${answerClass}">${mine.answered}</span></div>`);
        }
      }
      card.appendChild(document.createRange().createContextualFragment(parts.join('')));
      if (!isAdmin && data.current_round) {
        const act = document.createElement('div');
        act.className = 'row';
        const ansBtn = document.createElement('button');
        ansBtn.textContent = 'Answer';
        ansBtn.className = 'primary';
        ansBtn.setAttribute('aria-label', `Answer question ${q.letter}`);
        ansBtn.addEventListener('click', () => { selectedLetter = q.letter; renderQuestions(lastStatus || { questions: [] }); });
        act.appendChild(ansBtn);
        card.appendChild(act);
      }
      frag.appendChild(card);
    });
    list.appendChild(frag);
    // Restore scroll position and focus if applicable
    list.scrollTop = prevScroll;
    if (activeId) {
      const el = document.getElementById(activeId);
      if (el) { try { el.focus(); el.selectionStart = el.value.length; } catch(_) {} }
    }
  }

  function renderScoreboard(data) {
    const totals = {};
    const rounds = new Set();
    (data.overall_totals || []).forEach((r) => {
      const t = r.team_id;
      const rn = Number(r.round);
      const sc = Number(r.score);
      rounds.add(rn);
      totals[t] = totals[t] || { team_id: t, per: {}, total: 0 };
      totals[t].per[rn] = sc;
      totals[t].total += sc;
    });

    const roundList = Array.from(rounds).sort((a, b) => a - b);
    const teamList = Object.values(totals).sort((a, b) => b.total - a.total);

    let html = '<table><thead><tr><th>Team</th>' +
      roundList.map((r) => `<th>R${r}</th>`).join('') +
      '<th>Total</th></tr></thead><tbody>';
    teamList.forEach((t) => {
      html += `<tr><td>${t.team_id}</td>`;
      roundList.forEach((r) => (html += `<td>${t.per[r] ?? ''}</td>`));
      html += `<td><b>${t.total}</b></td></tr>`;
    });
    html += '</tbody></table>';
    const sc = document.querySelector(SELECTORS.scoreboard);
    if (sc) sc.innerHTML = html;

    if (teamList.length) {
      const winner = teamList[0];
      const note = document.createElement('div');
      note.innerHTML = `Overall leader: <b>${winner.team_id}</b> (${winner.total} pts)`;
      if (sc) sc.prepend(note);
    }
  }

  function renderAdminRoundButtons(data) {
    const wrap = document.querySelector(SELECTORS.roundButtons);
    if (!wrap) return;
    wrap.replaceChildren();
    let list = Array.isArray(data.all_rounds) ? data.all_rounds.map(r => Number(r.round)) : [];
    list = Array.from(new Set(list)).sort((a, b) => a - b);
    if (!list.length) list = Array.from({ length: 20 }, (_, i) => i + 1);
    list.forEach((r) => {
      const b = document.createElement('button');
      b.textContent = 'R' + r;
      b.dataset.round = String(r);
      b.addEventListener('click', () => setSelectedRound(r));
      wrap.appendChild(b);
    });
    if (selectedRound != null && list.includes(selectedRound)) setSelectedRound(selectedRound);
    else if (currentRound) setSelectedRound(currentRound);
    // After buttons exist, compute and highlight the next logical action
    suggestAdminNextAction(data);
  }

  function suggestAdminNextAction(data) {
    const startBtn = document.getElementById('startRound');
    const finishBtn = document.getElementById('finishRound');
    const closeBtn = document.getElementById('closeRound');
    [startBtn, finishBtn, closeBtn].forEach(b => b && b.classList.remove('suggest'));

    const rounds = Array.isArray(data.all_rounds) ? data.all_rounds.slice() : [];
    // If any round is active==1, suggest finishing that round
    const active = rounds.find(r => Number(r.active) === 1);
    if (active) {
      setSelectedRound(Number(active.round));
      if (finishBtn) finishBtn.classList.add('suggest');
      return;
    }
    // Otherwise, suggest starting the first not-started round (active==0)
    const pending = rounds.filter(r => Number(r.active) === 0).sort((a,b)=>Number(a.round)-Number(b.round));
    if (pending.length) {
      setSelectedRound(Number(pending[0].round));
      if (startBtn) startBtn.classList.add('suggest');
    }
  }

  async function fetchStatus() {
    try {
      // Preserve current inline answer (if any) before re-rendering
      const activeAnswer = document.querySelector('.answer-input');
      if (activeAnswer) { answerDraft = activeAnswer.value; editingAnswer = true; answerDraftLetter = selectedLetter; }
      const resp = await fetch(API(CMDS.STATUS));
      const data = await resp.json();

      isAdmin = toBool(data.team?.is_admin);
      document.querySelector(SELECTORS.adminTab).classList.toggle('hidden', !isAdmin);
      // Hide legacy Guess tab/section now that answering is inline
      const guessBtn = document.querySelector(SELECTORS.guessTabBtn);
      const guessSection = document.querySelector(SELECTORS.guessSection);
      if (guessBtn) guessBtn.classList.add('hidden');
      if (guessSection) guessSection.classList.add('hidden');

      // Hide History for admin teams
      const historyBtn = document.querySelector(SELECTORS.historyTabBtn);
      const historySection = document.querySelector(SELECTORS.historySection);
      if (historyBtn) historyBtn.classList.toggle('hidden', isAdmin);
      if (historySection) historySection.classList.toggle('hidden', isAdmin);
      // If admin and History was active, switch to Admin or Questions
      if (isAdmin && historyBtn && historyBtn.classList.contains('active')) {
        const fallback = document.querySelector('#tabs button[data-tab="round"]') || document.querySelector('#tabs button[data-tab="questions"]');
        if (fallback) fallback.click();
      }

      // Team name and caption
      const teamName = (data.team?.name || '').trim();
      if (!editingCaption && cap) {
        cap.textContent = teamName || TEAM;
        
        // Update caption styling based on editing availability
        const editingAllowed = canEditTeamName(data);
        if (editingAllowed) {
          cap.style.cursor = 'pointer';
          cap.title = 'Click to edit team name';
          cap.classList.remove('locked');
        } else {
          cap.style.cursor = 'default';
          cap.title = 'Team name cannot be changed after game starts';
          cap.classList.add('locked');
        }
      }

      lastStatus = data;
      // Update server time skew for countdown accuracy
      updateServerSkew(data);
      // Batch DOM updates in a frame to reduce layout thrash
      requestAnimationFrame(() => {
        renderCurrentRound(data);
        renderQuestions(data);
        renderScoreboard(data);
        renderHistory(data);
        renderRoundsOverview(data);
        renderAdminRoundButtons(data);
        updateCountdown(data);
        if (isAdmin) {
          renderRoundProgressFilter(data);
          renderRoundProgress(data);
          renderRoundProgressSummary(data);
          renderAdminTeams(data);
        }
        const foot = document.querySelector(SELECTORS.foot);
        if (foot) foot.textContent = `Team ${TEAM}`;
      });
      // Restore inline answer draft after DOM update
      if (selectedLetter) {
        const restored = document.querySelector('.answer-input');
        if (restored && typeof answerDraft === 'string' && editingAnswer && answerDraftLetter === selectedLetter) restored.value = answerDraft;
      }
    } catch (e) {
      const foot = document.querySelector(SELECTORS.foot);
      if (foot) foot.textContent = 'Disconnected. Retrying...';
    }
  }

  async function submitGuess(ev) {
    const container = ev && ev.target ? ev.target.closest('.q') : null;
    const question = (selectedLetter || '').toUpperCase().slice(0, 1);
    const ansEl = container ? container.querySelector('.answer-input') : $('#answer');
    const resEl = container ? container.querySelector('[data-role="guessResult"]') : $('#guessResult');
    const answer = ansEl ? ansEl.value.trim() : '';
    if (!question) { if (resEl) resEl.textContent = 'Select a question letter first.'; return; }
    if (!answer) { if (resEl) resEl.textContent = 'Choose a question and enter an answer.'; return; }
    
    // Check if there's an active round
    if (!lastStatus || !lastStatus.current_round) {
      if (resEl) resEl.textContent = 'No active round.';
      return;
    }
    if (resEl) resEl.textContent = 'Submitting...';
    try {
      const resp = await fetch(API(CMDS.GUESS, { letter: question }), {
        method: 'POST',
        body: answer,
        headers: { 'Content-Type': 'text/plain' },
      });
      const data = await resp.json();
      if (typeof data.points === 'number') {
        const pts = data.points;
        if (pts > 0) {
          if (resEl) { resEl.textContent = 'Submitted!'; try { resEl.focus(); } catch(_) {} }
          setTimeout(() => { selectedLetter = null; editingAnswer = false; answerDraft = ''; answerDraftLetter = null; fetchStatus(); }, 1500);
        } else {
          const reason = data.reason || REASONS.NOT_ACCEPTED;
          const msgs = /** @type {Record<string,string>} */ ({
            [REASONS.COOLDOWN]: 'On cooldown. Try later.',
            [REASONS.NO_LETTER]: 'No question selected.',
            [REASONS.NO_ACTIVE]: 'No active round.',
            [REASONS.NOT_ACCEPTED]: 'Not accepted.',
          });
          const msg = msgs[reason] || 'Not accepted.';
          if (resEl) { resEl.textContent = msg; try { resEl.focus(); } catch(_) {} }
        }
      } else {
        if (resEl) resEl.textContent = 'Server error.';
        selectedLetter = null;
        if (lastStatus) renderQuestions(lastStatus);
      }
    } catch (e) {
      if (resEl) resEl.textContent = 'Network error.';
      selectedLetter = null;
      if (lastStatus) renderQuestions(lastStatus);
    }
  }

  async function setActive(active) {
    const round = Number(selectedRound || 0);
    if (!round) { $('#roundResult').textContent = 'Pick a round.'; return; }
    const map = { 0: 'Closing...', 1: 'Starting...', 2: 'Finishing...' };
    $('#roundResult').textContent = map[active] || 'Updating...';
    try {
      const resp = await fetch(API(CMDS.ROUND, { round, active }));
      const data = await resp.json();
      if (data.ok) {
        const done = { 0: 'Closed.', 1: 'Started.', 2: 'Finished and scored.' };
        $('#roundResult').textContent = done[active] || 'Updated.';
        fetchStatus();
      } else {
        $('#roundResult').textContent = 'Failed.';
      }
    } catch (e) {
      $('#roundResult').textContent = 'Network error.';
    }
  }

  async function resetAll() {
    const resEl = $('#roundResult');
    const conf = (prompt('Type RESET to confirm wiping actions, round states, and cooldowns:') || '').trim().toUpperCase();
    if (conf !== 'RESET') { resEl.textContent = 'Reset cancelled.'; return; }
    resEl.textContent = 'Resetting...';
    const btn = $('#resetBtn');
    if (btn) btn.disabled = true;
    try {
      const resp = await fetch(API(CMDS.RESET));
      const data = await resp.json();
      resEl.textContent = data.ok ? 'Reset complete.' : 'Reset failed.';
      fetchStatus();
    } catch (e) {
      resEl.textContent = 'Network error.';
    } finally { if (btn) btn.disabled = false; }
  }

  function bindDefine() {
    const input = $('#defineFile');
    const resEl = $('#roundResult');
    if (!input) return;
    input.onchange = async () => {
      if (!input.files || !input.files[0]) return;
      const file = input.files[0];
      try {
        const text = await file.text();
        JSON.parse(text); // sanity check
        resEl.textContent = 'Uploading...';
        const resp = await fetch(API(CMDS.DEFINE), { method: 'POST', body: text, headers: { 'Content-Type': 'application/json' } });
        const data = await resp.json();
        resEl.textContent = data.ok ? 'Define completed.' : 'Define failed.';
        fetchStatus();
      } catch (e) {
        resEl.textContent = 'Invalid JSON or network error.';
      } finally {
        input.value = '';
      }
    };
  }

  async function submitCaptionRename(name) {
    const newName = (name || '').trim();
    if (!newName) return false;
    try {
      const resp = await fetch(API(CMDS.RENAME), { method: 'POST', body: newName, headers: { 'Content-Type': 'text/plain' } });
      const data = await resp.json();
      return !!data.updated;
    } catch (e) {
      return false;
    }
  }

  // Wire up
  $('#startRound') && $('#startRound').addEventListener('click', () => setActive(1));
  $('#finishRound') && $('#finishRound').addEventListener('click', () => setActive(2));
  $('#closeRound') && $('#closeRound').addEventListener('click', () => setActive(0));
  $('#resetBtn') && $('#resetBtn').addEventListener('click', resetAll);
  $('#defineBtn') && $('#defineBtn').addEventListener('click', () => { const f = $('#defineFile'); if (f) { f.click(); } });
  bindDefine();
  // Normalize Define button text if encoded oddly
  const defBtnEl = $('#defineBtn');
  if (defBtnEl && defBtnEl.textContent.trim() === 'Define.') defBtnEl.textContent = 'Define…';
  // Open Quiz Master
  $('#openMaster') && $('#openMaster').addEventListener('click', () => {
    const w = 1280, h = 720; // 16:9 window
    const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
    const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
    const features = `width=${w},height=${h},left=${left},top=${top}`;
    try { localStorage.setItem('QUIZ_TEAM', TEAM); } catch(e) {}
    try { sessionStorage.setItem('QUIZ_TEAM', TEAM); } catch(e) {}
    document.cookie = `QUIZ_TEAM=${encodeURIComponent(TEAM)}; Max-Age=600; Path=/; SameSite=Strict`;
    window.open(`master.html`, 'quiz_master', features);
  });

  // Caption inline rename
  if (cap) {
    cap.addEventListener('click', () => {
      if (editingCaption) return;
      
      // Check if editing is allowed - only before game starts (all rounds have active = 0)
      if (lastStatus && !canEditTeamName(lastStatus)) {
        return; // Game has started, don't allow editing
      }
      
      editingCaption = true;
      const current = cap.textContent || '';
      cap.innerHTML = '';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = current === TEAM ? '' : current;
      input.maxLength = 16; // Server truncates to 16 characters
      input.style.width = '70%';
      input.style.marginRight = '.5rem';
      
      // Add character counter
      const charCounter = document.createElement('small');
      charCounter.style.color = 'var(--muted)';
      charCounter.style.fontSize = '0.8rem';
      charCounter.style.marginLeft = '0.5rem';
      
      const updateCharCounter = () => {
        const length = input.value.length;
        charCounter.textContent = `${length}/16`;
        charCounter.style.color = length > 16 ? '#ef4444' : 'var(--muted)';
      };
      
      input.addEventListener('input', updateCharCounter);
      updateCharCounter();
      const btn = document.createElement('button');
      btn.textContent = 'Submit';
      
      // Add validation function
      const validateTeamName = (name) => {
        const trimmed = (name || '').trim();
        if (!trimmed) {
          return { valid: false, message: 'Team name cannot be empty' };
        }
        if (trimmed.length > 16) {
          return { valid: false, message: 'Team name must be 16 characters or less' };
        }
        
        // Check for duplicates using overall_totals (available to all teams)
        if (lastStatus && Array.isArray(lastStatus.overall_totals)) {
          const existingNames = lastStatus.overall_totals
            .map(t => (t.team_id || '').trim().toLowerCase())
            .filter(name => name && name !== TEAM.toLowerCase()); // Exclude current team
          
          if (existingNames.includes(trimmed.toLowerCase())) {
            return { valid: false, message: 'Team name already exists' };
          }
        }
        
        return { valid: true };
      };
      
      btn.addEventListener('click', async () => {
        const validation = validateTeamName(input.value);
        if (!validation.valid) {
          const old = btn.textContent;
          btn.textContent = validation.message;
          btn.style.background = '#ef4444';
          setTimeout(() => {
            btn.textContent = old;
            btn.style.background = '';
          }, 2000);
          return;
        }
        
        btn.disabled = true;
        const ok = await submitCaptionRename(input.value);
        btn.disabled = false;
        if (ok) {
          editingCaption = false;
          cap.textContent = input.value.trim() || TEAM;
          fetchStatus();
        } else {
          const old = btn.textContent;
          btn.textContent = 'Not allowed';
          setTimeout(() => (btn.textContent = old), 1200);
        }
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') btn.click();
        if (e.key === 'Escape') { editingCaption = false; cap.textContent = current; }
      });
      cap.appendChild(input);
      cap.appendChild(charCounter);
      cap.appendChild(btn);
      input.focus();
      input.selectionStart = input.value.length;
    });
  }

  // Startup
  if (!TEAM) { alert('Missing team code in URL.'); }
  fetchStatus();
  setInterval(fetchStatus, 60000);
  startCountdownTimer();
})();
