/* Unified player client (Questions + inline Answer) with cleaned UI strings */
(function () {
  /**
   * Constants and lightweight enums
   */
  const POLL_MS = 60000;
  const CMDS = /** @type {const} */ ({ STATUS: 'status', GUESS: 'guess', RENAME: 'rename', ROUND: 'round', DEFINE: 'define', RESET: 'reset', PEOPLE: 'people', MAKE_TEAMS: 'make_teams', GET_PEOPLE: 'get_people', SET_STATUS: 'set_status', MOVE_PERSON: 'move_person' });
  const REASONS = /** @type {const} */ ({ COOLDOWN: 'cooldown_active', NO_LETTER: 'no_letter', NO_ACTIVE: 'no_active', NOT_ACCEPTED: 'not_accepted' });
  const SELECTORS = /** @type {const} */ ({
    tabsButtons: '#tabs button',
    tab: '.tab',
    adminTab: '#adminTab',
    teamsTab: '#teamsTab',
    helpTabBtn: '#tabs button[data-tab="help"]',
    helpSection: '#help',
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
    teamsResult: '#teamsResult',
    defineFile: '#defineFile',
    defineBtn: '#defineBtn',
    peopleFile: '#peopleFile',
    peopleBtn: '#peopleBtn',
    makeTeamsBtn: '#makeTeamsBtn',
    status0Btn: '#status0Btn',
    status1Btn: '#status1Btn',
    status4Btn: '#status4Btn',
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

  // Markdown converter
  function convertMarkdown(markdown) {
    // First, handle lists properly by processing line by line
    // Normalize line endings and split - handles \r\n (Windows), \n (Unix), \r (Mac)
    let lines = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    let result = [];
    let currentList = null;
    let listType = null;
    
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      
      // Check for unordered list item
      if (line.match(/^\- (.*)$/g)) {
        let content = line.replace(/^\- (.*)$/g, '$1');
        if (currentList === null || listType !== 'ul') {
          // Close previous list if exists
          if (currentList !== null) {
            result.push(`</${listType}>`);
          }
          // Start new unordered list
          currentList = [];
          listType = 'ul';
        }
        currentList.push(`<li>${content}</li>`);
      }
      // Check for ordered list item
      else if (line.match(/^\d+\. (.*)$/g)) {
        let content = line.replace(/^\d+\. (.*)$/g, '$1');
        if (currentList === null || listType !== 'ol') {
          // Close previous list if exists
          if (currentList !== null) {
            result.push(`</${listType}>`);
          }
          // Start new ordered list
          currentList = [];
          listType = 'ol';
        }
        currentList.push(`<li>${content}</li>`);
      }
      // Non-list line
      else {
        // Close current list if exists
        if (currentList !== null) {
          result.push(`<${listType}>${currentList.join('')}</${listType}>`);
          currentList = null;
          listType = null;
        }
        result.push(line);
      }
    }
    
    // Close any remaining list
    if (currentList !== null) {
      result.push(`<${listType}>${currentList.join('')}</${listType}>`);
    }
    
    // Join lines and apply other markdown formatting
    let processed = result.join('\n');
    
    return processed
      // Headers
      .replace(/^### (.*$)/gim, '<h3>$1</h3>')
      .replace(/^## (.*$)/gim, '<h2>$1</h2>')
      .replace(/^# (.*$)/gim, '<h1>$1</h1>')
      // Bold and italic
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      // Code
      .replace(/`(.*?)`/g, '<code>$1</code>')
      // Links
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
      // Paragraphs
      .split('\n\n')
      .map(para => {
        if (!para.trim()) return '';
        // Don't wrap HTML tags (headers, lists, etc.) in paragraph tags
        if (para.match(/^<(h[1-6]|ul|ol|li|p|div|code|pre)/)) {
          return para.trim();
        }
        return `<p>${para.replace(/\n/g, '<br>')}</p>`;
      })
      .join('');
  }

  // Load help content
  async function loadHelpContent() {
    const container = document.getElementById('helpContent');
    if (!container) return;

    try {
      const response = await fetch('help.md');
      if (!response.ok) throw new Error('Help file not found');
      const markdown = await response.text();
      container.innerHTML = convertMarkdown(markdown);
    } catch (e) {
      container.innerHTML = '<p><em>Help content unavailable. Please check your connection.</em></p>';
    }
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
      
      // Load help content when help tab is clicked
      if (id === 'help') {
        loadHelpContent();
      }
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
  // Team management
  let selectedTargetTeam = null;

  function updateTeamSelection() {
    // Update visual indication of selected team
    document.querySelectorAll('.team-selector').forEach(link => {
      const isSelected = link.dataset.teamId === selectedTargetTeam;
      link.classList.toggle('team-selected', isSelected);
    });
    
    // Update select team buttons
    document.querySelectorAll('.select-team-btn').forEach(btn => {
      const isSelected = btn.dataset.teamId === selectedTargetTeam;
      btn.classList.toggle('selected', isSelected);
      btn.innerHTML = isSelected ? '☑' : '☐';
    });
  }

  function addSelectTeamButton(teamRow, teamId) {
    // Remove existing button if any
    removeSelectTeamButton(teamRow);
    
    const selectBtn = document.createElement('button');
    selectBtn.className = 'select-team-btn';
    selectBtn.dataset.teamId = teamId || null;
    selectBtn.innerHTML = '☐'; // Empty square
    
    selectBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent team row click
      selectedTargetTeam = teamId || null;
      updateTeamSelection();
    });
    
    // Add button to the right side of team info
    const teamInfo = teamRow.querySelector('.team-info');
    const teamRight = teamInfo.querySelector('.team-right');
    teamRight.appendChild(selectBtn);
  }

  function removeSelectTeamButton(teamRow) {
    const existingBtn = teamRow.querySelector('.select-team-btn');
    if (existingBtn) {
      existingBtn.remove();
    }
  }

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

  function renderAdminTeams(statusData, peopleData) {
    const mount = document.querySelector(SELECTORS.adminTeams);
    if (!mount) return;
    mount.replaceChildren();
    let rows = Array.isArray(statusData.all_teams) ? [...statusData.all_teams] : [];
    
    // Remove admin team from the list
    rows = rows.filter(team => team.team_id !== TEAM);
    
    if (!rows.length) { mount.textContent = 'No teams.'; return; }
    
    // Add virtual "No team" entry 
    rows.push({
      team_id: null,
      name: 'No Team',
      age_last_seen: null,
      is_virtual: true
    });
    
    const container = document.createElement('div');
    container.className = 'teams-container';
    
    rows
      .slice()
      .sort((a,b)=>String(a.team_id).localeCompare(String(b.team_id)))
      .forEach(t => {
        // Create team row
        const teamRow = document.createElement('div');
        teamRow.className = 'team-row';
        
        // Team info
        const teamInfo = document.createElement('div');
        teamInfo.className = 'team-info';
        
        const teamLeft = document.createElement('div');
        
        const teamId = document.createElement('a');
        teamId.href = `quiz.php?team=${encodeURIComponent(String(t.team_id || TEAM).toUpperCase())}`;
        teamId.target = '_blank';
        teamId.rel = 'noopener noreferrer';
        teamId.textContent = String(t.team_id || 'No Team').toUpperCase();
        teamId.className = 'team-selector' + (t.is_virtual ? ' virtual-team' : '');
        teamId.dataset.teamId = t.team_id || null;
        
        teamLeft.appendChild(teamId);
        
        const teamName = document.createElement('span');
        teamName.textContent = String(t.name || '');
        teamName.className = 'team-name';
        teamLeft.appendChild(teamName);
        
        const teamRight = document.createElement('div');
        teamRight.className = 'team-right';
        if (t.is_virtual) {
          teamRight.textContent = 'Unassigned people';
        } else {
          const age = Number(t.age_last_seen);
          if (isFinite(age)) {
            const minutes = Math.floor(age / 60);
            const seconds = Math.floor(age % 60);
            teamRight.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
          } else {
            teamRight.textContent = '--:--';
          }
        }
        
        teamInfo.appendChild(teamLeft);
        teamInfo.appendChild(teamRight);
        teamRow.appendChild(teamInfo);
        
        // Add select team button to every team row
        addSelectTeamButton(teamRow, t.team_id);
        
        // Create expandable members section
        const membersSection = document.createElement('div');
        membersSection.className = 'team-members';
        membersSection.style.display = 'none';
        
        // Get team members
        let teamPeople = [];
        if (peopleData && peopleData.people && Array.isArray(peopleData.people)) {
          teamPeople = peopleData.people.filter(p => p.team_id === t.team_id);
        }
        
        if (teamPeople.length > 0) {
          const membersTitle = document.createElement('h4');
          membersTitle.textContent = `Team Members (${teamPeople.length})`;
          membersTitle.className = 'members-title' + (t.is_virtual ? ' virtual-title' : '');
          membersSection.appendChild(membersTitle);
          
          const membersTable = document.createElement('table');
          membersTable.className = 'members-table';
          
          const thead = document.createElement('thead');
          const headerRow = document.createElement('tr');
          ['Select', 'Name'].forEach(header => {
            const th = document.createElement('th');
            th.textContent = header;
            th.className = 'table-header';
            headerRow.appendChild(th);
          });
          thead.appendChild(headerRow);
          membersTable.appendChild(thead);
          
          const tbody = document.createElement('tbody');
          teamPeople.forEach(person => {
            const tr = document.createElement('tr');
            tr.className = 'member-row';
            tr.style.cursor = 'pointer';
            
            const selectCell = document.createElement('td');
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = `person-${t.team_id || 'null'}`;
            radio.value = person.people_id;
            radio.className = 'person-radio';
            selectCell.appendChild(radio);
            selectCell.className = 'select-cell';
            
            const nameCell = document.createElement('td');
            nameCell.textContent = person.name || 'Unknown';
            nameCell.className = 'name-cell';
            
            // Make entire row clickable to select radio button
            tr.addEventListener('click', (e) => {
              e.stopPropagation(); // Prevent team row click
              radio.checked = true;
            });
            
            tr.appendChild(selectCell);
            tr.appendChild(nameCell);
            tbody.appendChild(tr);
          });
          membersTable.appendChild(tbody);
          membersSection.appendChild(membersTable);
          
          // Add move button
          const moveButton = document.createElement('button');
          moveButton.textContent = 'Move Person';
          moveButton.className = 'move-person-btn';
          moveButton.addEventListener('click', async () => {
            const selectedRadio = membersTable.querySelector('input[name="person-' + (t.team_id || 'null') + '"]:checked');
            if (!selectedRadio) {
              alert('Please select a person to move');
              return;
            }
            
            if (!selectedTargetTeam) {
              alert('Please Ctrl+click on a team to select it as the target');
              return;
            }
            
            const confirmMessage = `Move ${selectedRadio.value} to team ${selectedTargetTeam}?`;
            if (!confirm(confirmMessage)) return;
            
            try {
              const response = await fetch(API(CMDS.MOVE_PERSON, { 
                person: selectedRadio.value, 
                new_team: selectedTargetTeam 
              }));
              const result = await response.json();
              
              if (result.ok) {
                alert('Person moved successfully');
                fetchStatus();
              } else {
                alert('Failed to move person');
              }
            } catch (error) {
              alert('Error: ' + error.message);
            }
          });
          membersSection.appendChild(moveButton);
        } else {
          const noMembers = document.createElement('p');
          noMembers.textContent = t.is_virtual ? 'All people are assigned to teams' : 'No members assigned to this team';
          noMembers.className = 'no-members';
          membersSection.appendChild(noMembers);
        }
        
        // Toggle functionality - only when clicking team name or team info area
        teamInfo.addEventListener('click', (e) => {
          // Don't toggle if clicking on the team link, radio buttons, move button, or select team button
          if (e.target.tagName === 'A' || e.target.type === 'radio' || e.target.className === 'move-person-btn' || e.target.className === 'select-team-btn') return;
          
          const isExpanded = membersSection.style.display !== 'none';
          membersSection.style.display = isExpanded ? 'none' : 'block';
          teamRow.classList.toggle('team-expanded', !isExpanded);
        });
        
        teamRow.appendChild(membersSection);
        container.appendChild(teamRow);
      });
    
    mount.appendChild(container);
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

    // Get the last round number for display
    const roundList = Array.from(rounds).sort((a, b) => a - b);
    //const lastRound = roundList.length > 0 ? roundList[roundList.length - 1] : null;
    const lastRound = Math.max(...data.all_rounds.filter(r => r.active === 2).map(r => r.round));
    const teamList = Object.values(totals).sort((a, b) => b.total - a.total);

    let html = '<table><thead><tr><th>Rank</th><th>Team</th>';
    if (lastRound !== null) {
      html += `<th>R${lastRound}</th>`;
    }
    html += '<th>Total</th></tr></thead><tbody>';
    teamList.forEach((t, index) => {
      const isCurrentTeam = t.team_id === (data.team?.name || '');
      const rowClass = isCurrentTeam ? ' class="current-team"' : '';
      const rank = index + 1;
      html += `<tr${rowClass}><td>${rank}</td><td>${t.team_id}</td>`;
      if (lastRound !== null) {
        html += `<td>${t.per[lastRound] ?? ''}</td>`;
      }
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

  function renderLastCompletedRound(data) {
    const container = document.getElementById('lastCompletedRound');
    if (!container) return;

    // Get the last completed round (active == 2)
    const completedRounds = (data.all_rounds || []).filter(r => Number(r.active) === 2);
    if (!completedRounds.length) {
      container.textContent = 'No completed rounds yet.';
      return;
    }

    const lastRound = completedRounds.sort((a, b) => Number(b.round) - Number(a.round))[0];
    
    // Get round scores for this round from overall_totals
    const roundScores = (data.overall_totals || [])
      .filter(r => Number(r.round) === Number(lastRound.round))
      .map(r => ({
        team: String(r.team_id || ''),
        round_score: Number(r.round_score || 0)
      }))
      .sort((a, b) => b.round_score - a.round_score);

    if (!roundScores.length) {
      container.textContent = 'No scores available for this round.';
      return;
    }

    let html = `<h3>Round ${lastRound.round} Results</h3>`;
    html += '<table><thead><tr><th>Team</th><th>Round Score</th></tr></thead><tbody>';
    
    roundScores.forEach((team) => {
      const isCurrentTeam = team.team === (data.team?.name || '');
      const rowClass = isCurrentTeam ? ' class="current-team"' : '';
      html += `<tr${rowClass}><td>${team.team}</td><td><b>${team.round_score}</b></td></tr>`;
    });
    
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  function renderTeamResponses(data) {
    const container = document.getElementById('teamResponses');
    if (!container) return;

    // Only show team responses when no round is active and team_answers is available
    const hasActiveRound = data.current_round && Number(data.current_round.active) === 1;
    if (hasActiveRound || !data.team_answers || !Array.isArray(data.team_answers)) {
      container.innerHTML = '';
      return;
    }

    const teamAnswers = data.team_answers;
    if (!teamAnswers.length) {
      container.innerHTML = '<p>No responses available.</p>';
      return;
    }

    // Sort by letter for consistent display
    const sortedAnswers = teamAnswers.slice().sort((a, b) => (a.letter || '').localeCompare(b.letter || ''));

    let html = '<h4>Your Responses</h4>';
    html += '<table><thead><tr><th>Question</th><th>Your Answer</th><th>Points</th></tr></thead><tbody>';
    
    sortedAnswers.forEach((answer) => {
      const letter = answer.letter || '';
      const answered = (answer.answered || '').toString();
      const points = Number(answer.points);
      const value = 4; //Number(answer.value);
      
      // Format points display
      let pointsDisplay = points.toString();
      let pointsClass = 'points';
      
      if (points >= 0) {
        pointsClass += ' positive';
        const actualScore = points * 100; // Convert to actual score
        if (points === value) {
          pointsDisplay = `+${actualScore} (full)`;
        } else if (points === value / 2) {
          pointsDisplay = `+${actualScore} (hint 1)`;
        } else if (points === value / 4) {
          pointsDisplay = `+${actualScore} (hint 2)`;
        } else {
          pointsDisplay = `+${actualScore}`;
        }
      } else if (points === -1) {
        // -1 means wrong answer, but doesn't subtract from total
        pointsDisplay = '0';
        pointsClass += ' negative';
      } else {
        pointsClass += ' negative';
        pointsDisplay = points.toString();
      }
      
      html += `<tr>
        <td><strong>${letter}</strong></td>
        <td>${answered}</td>
        <td class="${pointsClass}">${pointsDisplay}</td>
      </tr>`;
    });
    
    html += '</tbody></table>';
    container.innerHTML = html;
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
    const unlockBtn = document.getElementById('unlockRound');
    [startBtn, finishBtn, closeBtn, unlockBtn].forEach(b => b && b.classList.remove('suggest'));

    const rounds = Array.isArray(data.all_rounds) ? data.all_rounds.slice() : [];
    const active = rounds.find(r => Number(r.active) === 1);
    
    if (active) {
      setSelectedRound(Number(active.round));
      // Check if round is locked (master_lock == 1)
      if (active.master_lock == 1) {
        // Round is started but locked, suggest unlocking
        if (unlockBtn) unlockBtn.classList.add('suggest');
      } else {
        // Round is started and unlocked, suggest finishing
        if (finishBtn) finishBtn.classList.add('suggest');
      }
      return;
    }
    
    // Otherwise, suggest starting the first not-started round (active==0)
    const pending = rounds.filter(r => Number(r.active) === 0).sort((a,b)=>Number(a.round)-Number(b.round));
    if (pending.length) {
      setSelectedRound(Number(pending[0].round));
      if (startBtn) startBtn.classList.add('suggest');
    }
  }

  async function fetchPeople() {
    if (!isAdmin) return null;
    try {
      const resp = await fetch(API(CMDS.GET_PEOPLE));
      const data = await resp.json();
      return data;
    } catch (e) {
      console.error('Failed to fetch people data:', e);
      return null;
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
      document.querySelector(SELECTORS.teamsTab).classList.toggle('hidden', !isAdmin);
      
      // Hide legacy Guess tab/section now that answering is inline
      const guessBtn = document.querySelector(SELECTORS.guessTabBtn);
      const guessSection = document.querySelector(SELECTORS.guessSection);
      if (guessBtn) guessBtn.classList.add('hidden');
      if (guessSection) guessSection.classList.add('hidden');

      // Hide Help tab for admin teams
      const helpBtn = document.querySelector(SELECTORS.helpTabBtn);
      const helpSection = document.querySelector(SELECTORS.helpSection);
      if (helpBtn) helpBtn.classList.toggle('hidden', isAdmin);
      if (helpSection) helpSection.classList.toggle('hidden', isAdmin);

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
      
      // For admin teams, fetch people data separately
      let peopleData = null;
      if (isAdmin) {
        peopleData = await fetchPeople();
      }
      
      // Update server time skew for countdown accuracy
      updateServerSkew(data);
      // Batch DOM updates in a frame to reduce layout thrash
      requestAnimationFrame(() => {
        renderCurrentRound(data);
        renderQuestions(data);
        renderScoreboard(data);
        renderLastCompletedRound(data);
        renderTeamResponses(data);
        renderHistory(data);
        renderRoundsOverview(data);
        renderAdminRoundButtons(data);
        updateCountdown(data);
        if (isAdmin) {
          renderRoundProgressFilter(data);
          renderRoundProgress(data);
          renderRoundProgressSummary(data);
          renderAdminTeams(data, peopleData);
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
    if (selectedRound === null) { $('#roundResult').textContent = 'Pick a round.'; return; }
    const round = Number(selectedRound);
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

  async function makeRandomTeams() {
    const resEl = document.querySelector(SELECTORS.teamsResult);
    const conf = (prompt('Type MAKE TEAMS to confirm creating random teams from people data:') || '').trim().toUpperCase();
    if (conf !== 'MAKE TEAMS') { resEl.textContent = 'Make teams cancelled.'; return; }
    resEl.textContent = 'Creating teams...';
    const btn = document.querySelector(SELECTORS.makeTeamsBtn);
    if (btn) btn.disabled = true;
    try {
      const resp = await fetch(API(CMDS.MAKE_TEAMS), { method: 'GET' });
      const data = await resp.json();
      if (data.ok) {
        const removed = data.removed || 0;
        const teams = data.teams || 0;
        const created = data.created || 0;
        resEl.textContent = `Teams created: ${created} people assigned, ${teams} teams created, ${removed} empty teams removed.`;
      } else {
        resEl.textContent = 'Make teams failed.';
      }
      fetchStatus();
    } catch (e) {
      resEl.textContent = 'Network error.';
    } finally { if (btn) btn.disabled = false; }
  }

  async function setStatus(status) {
    const resEl = document.querySelector(SELECTORS.teamsResult);
    resEl.textContent = `Setting status to ${status}...`;
    try {
      const resp = await fetch(API(CMDS.SET_STATUS, { status }));
      const data = await resp.json();
      if (data.ok) {
        resEl.textContent = `Status set to ${status}.`;
      } else {
        resEl.textContent = 'Failed to set status.';
      }
      fetchStatus();
    } catch (e) {
      resEl.textContent = 'Network error.';
    }
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

  function bindPeople() {
    const input = $('#peopleFile');
    const resEl = $('#roundResult');
    if (!input) return;
    input.onchange = async () => {
      if (!input.files || !input.files[0]) return;
      const file = input.files[0];
      try {
        const text = await file.text();
        JSON.parse(text); // sanity check
        resEl.textContent = 'Uploading...';
        const resp = await fetch(API(CMDS.PEOPLE), { method: 'POST', body: text, headers: { 'Content-Type': 'application/json' } });
        const data = await resp.json();
        resEl.textContent = data.ok ? 'People completed.' : 'People failed.';
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
  $('#unlockRound') && $('#unlockRound').addEventListener('click', () => setActive(3));
  $('#resetBtn') && $('#resetBtn').addEventListener('click', resetAll);
  $('#makeTeamsBtn') && $('#makeTeamsBtn').addEventListener('click', makeRandomTeams);
  $('#status0Btn') && $('#status0Btn').addEventListener('click', () => setStatus(0));
  $('#status1Btn') && $('#status1Btn').addEventListener('click', () => setStatus(1));
  $('#status4Btn') && $('#status4Btn').addEventListener('click', () => setStatus(4));
  $('#defineBtn') && $('#defineBtn').addEventListener('click', () => { const f = $('#defineFile'); if (f) { f.click(); } });
  $('#peopleBtn') && $('#peopleBtn').addEventListener('click', () => { const f = $('#peopleFile'); if (f) { f.click(); } });
  bindDefine();
  bindPeople();
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
