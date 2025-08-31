(function() {
    const qs = new URLSearchParams(location.search);
    const TEAM = (qs.get('team') || '').toUpperCase();
    const API = (cmd, params = {}) => {
        const u = new URL(location.href);
        u.searchParams.set('team', TEAM);
        u.searchParams.set('cmd', cmd);
        Object.entries(params).forEach(([k,v]) => u.searchParams.set(k, v));
        return u.toString();
    };

    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => Array.from(document.querySelectorAll(sel));

    // Tabs
    $$('#tabs button').forEach(btn => btn.addEventListener('click', () => {
        $$('#tabs button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const id = btn.dataset.tab;
        $$('.tab').forEach(s => s.classList.remove('active'));
        document.getElementById(id).classList.add('active');
    }));

    // State
    let isAdmin = false;
    let currentRound = null;

    function renderScoreboard(data) {
        const sb = data.scoreboard || [];
        const rounds = new Set();
        sb.forEach(t => Object.keys(t.per_round||{}).forEach(r => rounds.add(Number(r))));
        const sortedRounds = Array.from(rounds).sort((a,b)=>a-b);
        let html = '<table><thead><tr><th>Team</th>' + sortedRounds.map(r=>`<th>R${r}</th>`).join('') + '<th>Total</th></tr></thead><tbody>';
        sb.sort((a,b)=>b.total - a.total).forEach(t => {
            html += `<tr><td>${t.team_id}</td>`;
            sortedRounds.forEach(r => html += `<td>${(t.per_round||{})[r] ?? ''}</td>`);
            html += `<td><b>${t.total}</b></td></tr>`;
        });
        html += '</tbody></table>';
        $('#scoreboard').innerHTML = html;
        // Winner indicator
        if (sb.length) {
            const winner = sb[0];
            $('#currentRound').insertAdjacentHTML('beforeend', `<div>\u2728 Leading: <b>${winner.team_id}</b> (${winner.total} pts)</div>`);
        }
    }

    function renderHistory(data) {
        const list = $('#historyList');
        list.innerHTML = '';
        (data.my_actions || []).forEach(a => {
            const li = document.createElement('li');
            const pts = Number(a.points);
            const s = new Date(a.time).toLocaleTimeString();
            li.textContent = `${s} — R${a.round}${a.question ? ('/'+a.question):''} — “${(a.answered||'').slice(0,60)}${(a.answered||'').length>60?'…':''}” — ${pts>=0?('+'+pts):pts}`;
            list.appendChild(li);
        });
    }

    function renderCurrentRound(data) {
        $('#currentRound').innerHTML = '';
        const cr = data.current_round;
        if (!cr) { $('#currentRound').textContent = 'No active round.'; return; }
        currentRound = Number(cr.round);
        const info = `Round ${cr.round} | value=${cr.value} | active=${cr.active} | first team=${cr.first_team ?? '—'}`;
        $('#currentRound').textContent = info;
        // Prefill round input
        $('#roundInput').value = currentRound;
    }

    function ensureQuestionButtons() {
        const wrap = $('#questionButtons');
        if (wrap.childElementCount) return;
        const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
        letters.slice(0, 10).forEach(ch => {
            const b = document.createElement('button'); b.textContent = ch;
            b.addEventListener('click', ()=> $('#questionInput').value = ch);
            wrap.appendChild(b);
        });
    }

    function ensureRoundButtons() {
        const wrap = $('#roundButtons');
        if (wrap.childElementCount) return;
        for (let r=1; r<=20; r++) {
            const b = document.createElement('button'); b.textContent = 'R'+r;
            b.addEventListener('click', ()=> $('#roundInput').value = r);
            wrap.appendChild(b);
        }
    }

    async function fetchStatus() {
        try {
            const resp = await fetch(API('status'));
            const data = await resp.json();
            isAdmin = !!data.team?.is_admin;
            $('#adminTab').classList.toggle('hidden', !isAdmin);
            renderCurrentRound(data);
            renderScoreboard(data);
            renderHistory(data);
            $('#foot').textContent = `Team ${TEAM} • ${new Date(data.now).toLocaleTimeString()}`;
        } catch (e) {
            $('#foot').textContent = 'Disconnected. Retrying…';
        }
    }

    async function submitGuess() {
        const round = Number($('#roundInput').value || currentRound || 0);
        const question = ($('#questionInput').value || 'A').toUpperCase().slice(0,1);
        const answer = $('#answer').value.trim();
        if (!round || !question || !answer) { $('#guessResult').textContent = 'Fill round, question, and answer.'; return; }
        $('#guessResult').textContent = 'Submitting…';
        try {
            const resp = await fetch(API('guess', {round, question}), { method:'POST', body: answer, headers: {'Content-Type':'text/plain'} });
            const data = await resp.json();
            if (typeof data.points === 'number') {
                const pts = data.points;
                $('#guessResult').textContent = pts > 0 ? `Correct! +${pts} pts` : (pts === 0 ? 'Not accepted (cooldown/inactive/already answered).' : 'Wrong answer.');
                if (pts <= 0) {
                    // Clear field but keep question
                    $('#answer').value = '';
                }
                fetchStatus();
            } else {
                $('#guessResult').textContent = 'Server error.';
            }
        } catch(e) {
            $('#guessResult').textContent = 'Network error.';
        }
    }

    async function setRound() {
        const round = Number($('#roundInput').value || 0);
        const active = Number($('#activeValue').value || 0);
        if (!round) { $('#roundResult').textContent = 'Pick a round.'; return; }
        $('#roundResult').textContent = 'Updating…';
        try {
            const resp = await fetch(API('round', {round, active}));
            const data = await resp.json();
            if (data.ok) { $('#roundResult').textContent = 'Active round updated.'; fetchStatus(); }
            else { $('#roundResult').textContent = 'Failed.'; }
        } catch(e) { $('#roundResult').textContent = 'Network error.'; }
    }

    // Wire up
    $('#submitGuess').addEventListener('click', submitGuess);
    $('#setRound').addEventListener('click', setRound);
    ensureQuestionButtons();
    ensureRoundButtons();

    // Startup
    if (!TEAM) {
        alert('Missing team code in URL.');
    }
    fetchStatus();
    setInterval(fetchStatus, 5000);
})();
