/* Registration system for Pub Quiz matchmaking */
(function () {
    'use strict';

    // Constants
    const POLL_MS = 10000; // Poll every 10 seconds
    const API_BASE = 'register.php';
    
    // Phase constants
    const PHASES = {
        INTEREST: 1,      // Register interest
        PREFERENCE: 2,     // Choose random vs organized
        FORMATION: 3,      // Team formation
        ASSIGNED: 4        // Teams are formed
    };

    // State
    let currentStatus = 0;
    let currentPerson = null;
    let searchTimeout = null;
    let pollInterval = null;

    // DOM elements
    const $ = (id) => document.getElementById(id);
    const $$ = (selector) => document.querySelectorAll(selector);

    // Utility functions
    function showPhase(phase) {
        $$('.phase').forEach(el => el.classList.add('hidden'));
        $(`phase${phase}`).classList.remove('hidden');
    }

    function showLoading(text = 'Loading...') {
        $('loadingText').textContent = text;
        showPhase('loading');
    }

    function showError(message) {
        $('errorMessage').textContent = message;
        showPhase('error');
    }

    function updateStatusIndicator(status) {
        const indicator = $('status');
        if (!indicator) return;

        indicator.textContent = `Status: ${status}`;
        indicator.className = 'status-indicator';
        
        if (status === PHASES.ASSIGNED) {
            indicator.classList.add('active');
        } else if (status > 0) {
            indicator.classList.add('waiting');
        }
    }

    // API functions
    async function apiCall(cmd, params = {}, method = 'GET') {
        const url = new URL(API_BASE, window.location.href);
        url.searchParams.set('cmd', cmd);
        
        Object.entries(params).forEach(([key, value]) => {
            url.searchParams.set(key, value);
        });

        const options = {
            method,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            }
        };

        if (method === 'POST') {
            const formData = new URLSearchParams();
            Object.entries(params).forEach(([key, value]) => {
                formData.append(key, value);
            });
            options.body = formData;
        }

        try {
            const response = await fetch(url.toString(), options);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            return await response.json();
        } catch (error) {
            console.error('API call failed:', error);
            throw error;
        }
    }

    async function getTeamStatus() {
        return await apiCall('team_status');
    }

    async function registerInterest(peopleId) {
        return await apiCall('register_interest', {}, 'POST');
    }

    async function setPreference(peopleId, preference) {
        return await apiCall('set_preference', { 
            preference: preference 
        }, 'POST');
    }

    async function joinTeam(peopleId, targetPersonId) {
        return await apiCall('join_team', { 
            target_person_id: targetPersonId 
        }, 'POST');
    }

    async function createTeam(peopleId) {
        return await apiCall('create_team', {}, 'POST');
    }

    async function leaveTeam(peopleId) {
        return await apiCall('leave_team', {}, 'POST');
    }

    async function getTeamMembers(peopleId) {
        return await apiCall('get_team_members');
    }

    async function getTeamMembersList(peopleId) {
        return await apiCall('get_team_members_list');
    }

    async function getTeamSymbol(teamId) {
        return await apiCall('get_team_symbol', { team_id: teamId });
    }

    async function findPerson(peopleId, search) {
        return await apiCall('find_person', { 
            search: search 
        });
    }

    // Phase handlers
    function handlePhase1() {
        showPhase(1);
        
        $('registerInterest').onclick = async () => {
            if (!currentPerson) {
                showError('No people ID available. Please refresh the page.');
                return;
            }

            try {
                showLoading('Registering interest...');
                const result = await registerInterest(currentPerson);
                
                if (result.ok) {
                    await updateStatus();
                } else {
                    showError(result.error || 'Failed to register interest');
                }
            } catch (error) {
                showError('Network error. Please try again.');
            }
        };
    }

    function handlePhase2() {
        showPhase(2);
        
        $('preferRandom').onclick = async () => {
            await setPreferenceAndUpdate('R');
        };
        
        $('preferOrganize').onclick = async () => {
            await setPreferenceAndUpdate('O');
        };
    }

    async function setPreferenceAndUpdate(preference) {
        if (!currentPerson) {
            showError('No people ID available. Please refresh the page.');
            return;
        }

        try {
            showLoading('Setting preference...');
            const result = await setPreference(currentPerson, preference);
            
            if (result.ok) {
                await updateStatus();
            } else {
                showError(result.error || 'Failed to set preference');
            }
        } catch (error) {
            showError('Network error. Please try again.');
        }
    }

    function handlePhase3() {
        showPhase(3);
        setupTeamFormation();
    }

    function setupTeamFormation() {
        // Search functionality
        const searchInput = $('personSearch');
        const searchResults = $('searchResults');
        
        searchInput.oninput = () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(async () => {
                const query = searchInput.value.trim();
                if (query.length < 2) {
                    searchResults.innerHTML = '';
                    return;
                }

                try {
                    const result = await findPerson(currentPerson, query);
                    if (result.ok) {
                        displaySearchResults(result.people);
                    }
                } catch (error) {
                    console.error('Search failed:', error);
                }
            }, 300);
        };

        // Team actions
        $('createTeam').onclick = async () => {
            if (!currentPerson) {
                showError('No people ID available. Please refresh the page.');
                return;
            }

            try {
                showLoading('Creating team...');
                const result = await createTeam(currentPerson);
                
                if (result.ok) {
                    await updateStatus();
                } else {
                    showError(result.error || 'Failed to create team');
                }
            } catch (error) {
                showError('Network error. Please try again.');
            }
        };

        $('leaveTeam').onclick = async () => {
            if (!currentPerson) {
                showError('No people ID available. Please refresh the page.');
                return;
            }

            try {
                showLoading('Leaving team...');
                const result = await leaveTeam(currentPerson);
                
                if (result.ok) {
                    await updateStatus();
                } else {
                    showError(result.error || 'Failed to leave team');
                }
            } catch (error) {
                showError('Network error. Please try again.');
            }
        };

        // Load current team status
        loadCurrentTeam();
    }

    function displaySearchResults(people) {
        const searchResults = $('searchResults');
        searchResults.innerHTML = '';

        if (!people || people.length === 0) {
            searchResults.innerHTML = '<div class="search-result">No people found</div>';
            return;
        }

        people.forEach(person => {
            const result = document.createElement('div');
            result.className = 'search-result';
            result.innerHTML = `
                <div class="name">${person.name || 'Unknown'}</div>
                <div class="login">${person.login || ''}</div>
                <div class="team">${person.team_id ? 'In team' : 'Available'}</div>
            `;
            
            result.onclick = async () => {
                if (person.team_id) {
                    await joinTeamByPerson(person.people_id);
                } else {
                    showError('This person is not in a team yet');
                }
            };
            
            searchResults.appendChild(result);
        });
    }

    async function joinTeamByPerson(targetPersonId) {
        if (!currentPerson) {
            showError('No people ID available. Please refresh the page.');
            return;
        }

        try {
            showLoading('Joining team...');
            const result = await joinTeam(currentPerson, targetPersonId);
            
            if (result.ok) {
                await updateStatus();
            } else {
                showError(result.error || 'Failed to join team');
            }
        } catch (error) {
            showError('Network error. Please try again.');
        }
    }

    async function loadCurrentTeam() {
        if (!currentPerson) return;

        try {
            const result = await getTeamMembers(currentPerson);
            if (result.ok && result.person) {
                const person = result.person;
                const currentTeam = $('currentTeam');
                const teamMembers = $('teamMembers');
                const teamActions = $('teamActions');

                if (person.team_id) {
                    // Person is in a team
                    currentTeam.classList.remove('hidden');
                    teamActions.classList.add('hidden');
                    
                    // Load team symbol for current team display
                    try {
                        const symbolResult = await getTeamSymbol(person.team_id);
                        let symbolDisplay = '?';
                        if (symbolResult.ok && symbolResult.svg) {
                            symbolDisplay = `<img src="data:image/svg+xml;base64,${symbolResult.svg}" alt="Team Symbol" style="width: 100%; height: 100%; object-fit: contain;" />`;
                        }
                        
                        teamMembers.innerHTML = `
                            <div class="team-info">
                                <div class="team-symbol">${symbolDisplay}</div>
                                <div class="team-details">
                                    <h3>${person.team_name || 'Team'}</h3>
                                    <p>You are a member of this team</p>
                                </div>
                            </div>
                        `;
                    } catch (error) {
                        console.error('Failed to load team symbol:', error);
                        teamMembers.innerHTML = `
                            <div class="team-info">
                                <div class="team-symbol">?</div>
                                <div class="team-details">
                                    <h3>${person.team_name || 'Team'}</h3>
                                    <p>You are a member of this team</p>
                                </div>
                            </div>
                        `;
                    }
                } else {
                    // Person is not in a team
                    currentTeam.classList.add('hidden');
                    teamActions.classList.remove('hidden');
                }
            }
        } catch (error) {
            console.error('Failed to load team status:', error);
        }
    }

    function handlePhase4() {
        showPhase(4);
        loadTeamInfo();
    }

    async function loadTeamInfo() {
        if (!currentPerson) return;

        try {
            const result = await getTeamMembers(currentPerson);
            if (result.ok && result.person) {
                const person = result.person;
                const teamName = $('teamName');
                const teamMembersList = $('teamMembersList');
                const teamSymbol = $('teamSymbol');

                if (person.team_id) {
                    teamName.textContent = person.team_name || 'Your Team';
                    
                    // Get team symbol
                    try {
                        const symbolResult = await getTeamSymbol(person.team_id);
                        if (symbolResult.ok && symbolResult.svg) {
                            teamSymbol.innerHTML = `<img src="data:image/svg+xml;base64,${symbolResult.svg}" alt="Team Symbol" style="width: 100%; height: 100%; object-fit: contain;" />`;
                        } else {
                            teamSymbol.textContent = '?';
                        }
                    } catch (error) {
                        console.error('Failed to load team symbol:', error);
                        teamSymbol.textContent = '?';
                    }
                    
                    // Load team members
                    try {
                        const membersResult = await getTeamMembersList(currentPerson);
                        if (membersResult.ok && membersResult.members) {
                            const members = membersResult.members;
                            const membersHtml = members.map(member => 
                                `<li>${member.name || 'Unknown'}</li>`
                            ).join('');
                            
                            teamMembersList.innerHTML = `
                                <ul class="team-members">
                                    ${membersHtml}
                                </ul>
                            `;
                        } else {
                            teamMembersList.innerHTML = `
                                <ul class="team-members">
                                    <li>${person.name || 'You'}</li>
                                </ul>
                            `;
                        }
                    } catch (error) {
                        console.error('Failed to load team members:', error);
                        teamMembersList.innerHTML = `
                            <ul class="team-members">
                                <li>${person.name || 'You'}</li>
                            </ul>
                        `;
                    }
                }
            }
        } catch (error) {
            console.error('Failed to load team info:', error);
        }
    }


    // Main status update function
    async function updateStatus() {
        try {
            const result = await getTeamStatus();
            if (!result.ok) {
                showError('Failed to get status');
                return;
            }

            currentStatus = result.status;
            updateStatusIndicator(currentStatus);

            // Handle different phases
            switch (currentStatus) {
                case PHASES.INTEREST:
                    handlePhase1();
                    break;
                case PHASES.PREFERENCE:
                    handlePhase2();
                    break;
                case PHASES.FORMATION:
                    handlePhase3();
                    break;
                case PHASES.ASSIGNED:
                    handlePhase4();
                    break;
                default:
                    showError('Unknown status');
            }
        } catch (error) {
            showError('Failed to connect to server');
        }
    }

    // Event handlers
    function setupEventHandlers() {
        // Retry button
        $('retryButton').onclick = () => {
            updateStatus();
        };

        // Join game button
        $('joinGame').onclick = () => {
            if (currentPerson) {
                // Redirect to quiz with team ID
                const teamId = currentPerson.team_id;
                if (teamId) {
                    window.location.href = `quiz.php?team=${teamId}`;
                } else {
                    showError('No team assigned yet');
                }
            } else {
                showError('No people ID available');
            }
        };
    }

    // Polling
    function startPolling() {
        if (pollInterval) {
            clearInterval(pollInterval);
        }
        
        pollInterval = setInterval(async () => {
            try {
                const result = await getTeamStatus();
                if (result.ok && result.status !== currentStatus) {
                    currentStatus = result.status;
                    updateStatus();
                }
            } catch (error) {
                console.error('Polling error:', error);
            }
        }, POLL_MS);
    }

    function stopPolling() {
        if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
        }
    }

    // Initialize
    function init() {
        // Get people ID from URL or localStorage
        const urlParams = new URLSearchParams(window.location.search);
        const peopleId = urlParams.get('people_id') || localStorage.getItem('quiz_people_id');
        
        if (!peopleId) {
            showError('No people ID provided. Please access this page through the proper link.');
            return;
        }

        currentPerson = peopleId;
        localStorage.setItem('quiz_people_id', peopleId);

        setupEventHandlers();
        updateStatus();
        startPolling();
    }

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
        stopPolling();
    });

    // Start the application
    document.addEventListener('DOMContentLoaded', init);
})();
