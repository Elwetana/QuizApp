(function () {
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

  // Initial caption fallback to team code
  const cap = document.getElementById('caption');
  if (cap) cap.textContent = TEAM || 'Pub Quiz';

  // Tabs
  $$('#tabs button').forEach((btn) =>
    btn.addEventListener('click', () => {
      $$('#tabs button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const id = btn.dataset.tab;
      $$('.tab').forEach((s) => s.classList.remove('active'));
      document.getElementById(id).classList.add('active');
    })
  );

  // State
  let isAdmin = false;
  let currentRound = null;
  let selectedLetter = null;
  let selectedRound = null;
  let editingCaption = false;

  function setSelected(letter) {
    selectedLetter = letter || null;
    const btns = Array.from(document.querySelectorAll('#questionButtons button'));
    btns.forEach((b) => b.classList.toggle('selected', b.textContent === selectedLetter));
  }

  function renderHistory(data) {
    const list = $('#historyList');
    list.innerHTML = '';
    (data.my_actions || []).forEach((a) => {
      const li = document.createElement('li');
      const pts = Number(a.points);
      const s = new Date(a.time).toLocaleTimeString();
      const ans = (a.answered || '').toString();
      li.textContent = `${s} – R${a.round}${a.letter ? '/' + a.letter : ''} – "${ans.slice(0, 60)}${ans.length > 60 ? '…' : ''}" – ${pts >= 0 ? '+' + pts : pts}`;
      list.appendChild(li);
    });
  }

  function renderCurrentRound(data) {
    const el = $('#currentRound');
    el.innerHTML = '';
    const cr = data.current_round;
    if (!cr) {
      el.textContent = 'No active round.';
      return;
    }
    currentRound = Number(cr.round);
    const started = cr.started ? new Date(cr.started).toLocaleTimeString() : '—';
    el.innerHTML = `Round ${cr.round} • ${cr.name || ''} • value=${cr.value} • length=${cr.length}s • started=${started}`;

    // Current round leaderboard (live)
    const live = data.current_scores || [];
    if (live.length) {
      const top = [...live].sort((a, b) => Number(b.pts) - Number(a.pts))[0];
      const div = document.createElement('div');
      div.innerHTML = `✨ Leading this round: <b>${top.team_id}</b> (${top.pts} pts)`;
      el.appendChild(div);
    }

    // Default admin round selection to current round if none selected
    if (selectedRound == null && currentRound) {
      setSelectedRound(currentRound);
    }
  }

  function renderQuestions(data) {
    const list = $('#questionsList');
    const btnRow = $('#questionButtons');
    list.innerHTML = '';
    btnRow.innerHTML = '';
    const qs = data.questions || [];
    if (!qs.length) {
      list.textContent = 'Questions will appear when a round is active.';
      return;
    }
    qs.forEach((q) => {
      // Buttons for quick letter select
      const b = document.createElement('button');
      b.textContent = q.letter;
      b.addEventListener('click', () => {
        setSelected(q.letter);
      });
      btnRow.appendChild(b);

      // Full list with hints
      const card = document.createElement('div');
      card.className = 'q';
      card.style.margin = '0 0 .75rem 0';
      const h = [];
      if (q.hint1) h.push(`<div><small>Hint 1:</small> ${q.hint1}</div>`);
      if (q.hint2) h.push(`<div><small>Hint 2:</small> ${q.hint2}</div>`);
      card.innerHTML = `
        <div><b>${q.letter}.</b> ${q.question}</div>
        ${h.join('')}
        <div class="row" style="margin-top:.25rem">
          <button class="primary">Answer</button>
        </div>`;
      card.querySelector('button').addEventListener('click', () => {
        setSelected(q.letter);
        document.querySelector('#tabs button[data-tab="guess"]').click();
      });
      list.appendChild(card);
    });

    // Re-apply selection highlight if it’s still valid
    if (selectedLetter && qs.some((x) => x.letter === selectedLetter)) {
      setSelected(selectedLetter);
    }
  }

  function renderScoreboard(data) {
    // Build totals per team from overall_totals
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
    $('#scoreboard').innerHTML = html;

    // Overall leader note
    if (teamList.length) {
      const winner = teamList[0];
      const note = document.createElement('div');
      note.innerHTML = `🏆 Overall leader: <b>${winner.team_id}</b> (${winner.total} pts)`;
      $('#scoreboard').prepend(note);
    }
  }

  function setSelectedRound(r) {
    selectedRound = Number(r);
    const btns = Array.from(document.querySelectorAll('#roundButtons button'));
    btns.forEach((b) => b.classList.toggle('selected', Number(b.dataset.round) === selectedRound));
  }

  function renderAdminRoundButtons(data) {
    const wrap = $('#roundButtons');
    if (!wrap) return;
    wrap.innerHTML = '';
    const rounds = new Set((data.overall_totals || []).map((r) => Number(r.round)));
    if (data.current_round?.round) rounds.add(Number(data.current_round.round));
    // If no known rounds, render a default range 1..20
    let list = Array.from(rounds).sort((a, b) => a - b);
    if (!list.length) {
      list = Array.from({ length: 20 }, (_, i) => i + 1);
    }
    list.forEach((r) => {
      const b = document.createElement('button');
      b.textContent = 'R' + r;
      b.dataset.round = String(r);
      b.addEventListener('click', () => setSelectedRound(r));
      wrap.appendChild(b);
    });
    // Reapply highlight
    if (selectedRound != null && list.includes(selectedRound)) {
      setSelectedRound(selectedRound);
    } else if (currentRound) {
      setSelectedRound(currentRound);
    }
  }

  async function fetchStatus() {
    try {
      const resp = await fetch(API('status'));
      const data = await resp.json();

      // Admin flag may come as 't'/'f', true/false, 1/0
      isAdmin = toBool(data.team?.is_admin);
      $('#adminTab').classList.toggle('hidden', !isAdmin);
      const guessBtn = document.querySelector('#tabs button[data-tab="guess"]');
      const guessSection = document.getElementById('guess');
      if (guessBtn && guessSection) {
        guessBtn.classList.toggle('hidden', isAdmin);
        guessSection.classList.toggle('hidden', isAdmin);
        // If admin and Guess was active, switch to Admin tab
        if (isAdmin && guessBtn.classList.contains('active')) {
          const adminBtn = document.querySelector('#tabs button[data-tab="round"]') || document.querySelector('#tabs button[data-tab="questions"]');
          if (adminBtn) adminBtn.click();
        }
      }

      // Team name and caption
      const teamName = (data.team?.name || '').trim();
      if (!editingCaption && cap) cap.textContent = teamName || TEAM;

      renderCurrentRound(data);
      renderQuestions(data);
      renderScoreboard(data);
      renderHistory(data);
      renderAdminRoundButtons(data);
      $('#foot').textContent = `Team ${TEAM}`;
    } catch (e) {
      $('#foot').textContent = 'Disconnected. Retrying…';
    }
  }

  async function submitGuess() {
    const question = (selectedLetter || '').toUpperCase().slice(0, 1);
    const answer = $('#answer').value.trim();
    if (!question) {
      $('#guessResult').textContent = 'Select a question letter first.';
      return;
    }
    if (!answer) {
      $('#guessResult').textContent = 'Choose a question and enter an answer.';
      return;
    }
    $('#guessResult').textContent = 'Submitting…';
    try {
      const resp = await fetch(API('guess', { letter: question }), {
        method: 'POST',
        body: answer,
        headers: { 'Content-Type': 'text/plain' },
      });
      const data = await resp.json();
      if (typeof data.points === 'number') {
        const pts = data.points;
        if (pts > 0) {
          $('#guessResult').textContent = 'Submitted!';
          $('#answer').value = '';
        } else {
          const reason = data.reason || 'not_accepted';
          const msg = {
            cooldown_active: 'On cooldown. Try later.',
            no_letter: 'No question selected.',
            no_active: 'No active round.',
            not_accepted: 'Not accepted.',
          }[reason] || 'Not accepted.';
          $('#guessResult').textContent = msg;
        }
        fetchStatus();
      } else {
        $('#guessResult').textContent = 'Server error.';
      }
    } catch (e) {
      $('#guessResult').textContent = 'Network error.';
    }
  }

  async function setActive(active) {
    const round = Number(selectedRound || 0);
    if (!round) { $('#roundResult').textContent = 'Pick a round.'; return; }
    const map = { 0: 'Closing…', 1: 'Starting…', 2: 'Finishing…' };
    $('#roundResult').textContent = map[active] || 'Updating…';
    try {
      const resp = await fetch(API('round', { round, active }));
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
    resEl.textContent = 'Resetting…';
    const btn = $('#resetBtn');
    if (btn) btn.disabled = true;
    try {
      const resp = await fetch(API('reset'));
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
        // Optional sanity check
        JSON.parse(text);
        resEl.textContent = 'Uploading…';
        const resp = await fetch(API('define'), { method: 'POST', body: text, headers: { 'Content-Type': 'application/json' } });
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
      const resp = await fetch(API('rename'), { method: 'POST', body: newName, headers: { 'Content-Type': 'text/plain' } });
      const data = await resp.json();
      return !!data.updated;
    } catch (e) {
      return false;
    }
  }

  // Wire up
  $('#submitGuess') && $('#submitGuess').addEventListener('click', submitGuess);
  $('#startRound') && $('#startRound').addEventListener('click', () => setActive(1));
  $('#finishRound') && $('#finishRound').addEventListener('click', () => setActive(2));
  $('#closeRound') && $('#closeRound').addEventListener('click', () => setActive(0));
  $('#resetBtn') && $('#resetBtn').addEventListener('click', resetAll);
  $('#defineBtn') && $('#defineBtn').addEventListener('click', () => { const f = $('#defineFile'); if (f) { f.click(); } });
  bindDefine();

  // Caption inline rename
  if (cap) {
    cap.addEventListener('click', () => {
      if (editingCaption) return;
      editingCaption = true;
      const current = cap.textContent || '';
      cap.innerHTML = '';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = current === TEAM ? '' : current;
      input.maxLength = 32;
      input.style.width = '70%';
      input.style.marginRight = '.5rem';
      const btn = document.createElement('button');
      btn.textContent = 'Submit';
      btn.addEventListener('click', async () => {
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
        if (e.key === 'Escape') {
          editingCaption = false;
          cap.textContent = current;
        }
      });
      cap.appendChild(input);
      cap.appendChild(btn);
      input.focus();
      input.selectionStart = input.value.length;
    });
  }

  // Startup
  if (!TEAM) {
    alert('Missing team code in URL.');
  }
  fetchStatus();
  setInterval(fetchStatus, 60000);
})();
