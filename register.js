// Registration interface for pub quiz matchmaking
// Handles status-based UI and API communication

class QuizRegistration {
    constructor() {
        this.peopleId = this.getPeopleIdFromUrl();
        this.currentStatus = null;
        this.personData = null;
        
        this.init();
    }

    init() {
        if (!this.peopleId) {
            this.showError('Invalid people ID. Please check your registration link.');
            return;
        }

        this.bindEvents();
        this.loadStatus();
    }

    getPeopleIdFromUrl() {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get('people_id');
    }

    bindEvents() {
        document.getElementById('register-btn')?.addEventListener('click', () => {
            this.registerInterest();
        });

        document.getElementById('retry-btn')?.addEventListener('click', () => {
            this.loadStatus();
        });

        // Fullscreen symbol events
        document.getElementById('symbol-fullscreen')?.addEventListener('click', () => {
            this.hideFullscreenSymbol();
        });

        // Allow clicking on the image to exit fullscreen
        document.getElementById('fullscreen-symbol')?.addEventListener('click', (e) => {
            // Don't stop propagation - let the click bubble up to close fullscreen
            //this.hideFullscreenSymbol();
        });

        // Keyboard support for fullscreen symbol
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.hideFullscreenSymbol();
            }
        });

        // Handle fullscreen change events
        document.addEventListener('fullscreenchange', () => this.handleFullscreenChange());
        document.addEventListener('webkitfullscreenchange', () => this.handleFullscreenChange());
        document.addEventListener('mozfullscreenchange', () => this.handleFullscreenChange());
        document.addEventListener('MSFullscreenChange', () => this.handleFullscreenChange());
    }

    async loadStatus() {
        this.showLoading();
        
        try {
            const response = await this.apiCall('person_status');
            this.personData = response.person;
            this.currentStatus = response.status[0]?.status || 0;
            
            this.updateUI();
        } catch (error) {
            console.error('Failed to load status:', error);
            this.showError('Failed to load registration status. Please try again.');
        }
    }

    async registerInterest() {
        this.showLoading();
        
        try {
            const response = await this.apiCall('interest');
            if (response.ok) {
                // Refresh status after successful registration
                await this.loadStatus();
            } else {
                throw new Error('Registration failed');
            }
        } catch (error) {
            console.error('Failed to register interest:', error);
            this.showError('Failed to register interest. Please try again.');
        }
    }

    async loadTeamInfo() {
        try {
            const response = await this.apiCall('get_team');
            return response;
        } catch (error) {
            console.error('Failed to load team info:', error);
            throw error;
        }
    }

    updateUI() {
        this.hideAllPanels();
        this.updateGreeting();

        switch (this.currentStatus) {
            case 0:
                this.showStatus0();
                break;
            case 1:
                this.showStatus1();
                break;
            case 4:
                this.showStatus4();
                break;
            default:
                this.showError(`Unknown status: ${this.currentStatus}`);
        }
    }

    updateGreeting() {
        const greetingElement = document.getElementById('greeting');
        const personNameElement = document.getElementById('person-name');
        
        if (this.personData && this.personData.name) {
            personNameElement.textContent = this.personData.name;
            greetingElement.classList.remove('hidden');
        } else {
            greetingElement.classList.add('hidden');
        }
    }

    showStatus0() {
        document.getElementById('status-0').classList.remove('hidden');
    }

    showStatus1() {
        // Check if person already registered
        if (this.personData?.preference === 'R') {
            this.showMessage('You have already registered for the quiz. Teams will be formed soon!');
        } else {
            document.getElementById('status-1').classList.remove('hidden');
        }
    }

    async showStatus4() {
        try {
            const teamInfo = await this.loadTeamInfo();
            this.displayTeamInfo(teamInfo);
            document.getElementById('status-4').classList.remove('hidden');
        } catch (error) {
            this.showError('Failed to load team information. Please try again.');
        }
    }

    displayTeamInfo(teamInfo) {
        const { team, teammates, symbol } = teamInfo;
        
        // Update team name
        document.getElementById('team-name').textContent = team.name;
        
        // Update team symbol - handle both text and base64 SVG
        const teamSymbolElement = document.getElementById('team-symbol');
        if (symbol && symbol.startsWith('data:image/svg+xml;base64,')) {
            // Check for separate symbol property with base64 SVG
            teamSymbolElement.innerHTML = `<img src="${symbol}" alt="Team Symbol" style="max-width: 100%; height: auto;" />`;
            teamSymbolElement.style.cursor = 'pointer';
            teamSymbolElement.addEventListener('click', () => this.showFullscreenSymbol(symbol));
        } else {
            // It's a text symbol (from team.symbol)
            teamSymbolElement.textContent = team.symbol || '?';
            teamSymbolElement.style.cursor = 'default';
        }
        
        // Update team members
        const membersList = document.getElementById('team-members');
        if (teammates && teammates.length > 0) {
            membersList.innerHTML = `
                <h3>Team Members</h3>
                <ul>
                    ${teammates.map(member => `<li>${member.name || member.login || 'Unknown'}</li>`).join('')}
                </ul>
            `;
        } else {
            membersList.innerHTML = '<p>No team members found.</p>';
        }
        
        // Update quiz link
        const quizLink = document.getElementById('quiz-link');
        quizLink.href = `quiz.php?team=${team.team_id}`;
        quizLink.textContent = 'Join Quiz';
    }

    showMessage(message) {
        this.hideAllPanels();
        
        // Create a temporary message panel
        const messagePanel = document.createElement('div');
        messagePanel.className = 'status-panel';
        messagePanel.innerHTML = `
            <div class="message">
                <h2>Information</h2>
                <p>${message}</p>
            </div>
        `;
        
        document.querySelector('main').appendChild(messagePanel);
        
        // Auto-hide after 5 seconds
        setTimeout(() => {
            messagePanel.remove();
            this.loadStatus();
        }, 5000);
    }

    showLoading() {
        this.hideAllPanels();
        document.getElementById('loading').classList.remove('hidden');
    }

    showError(message) {
        this.hideAllPanels();
        document.getElementById('error-message').textContent = message;
        document.getElementById('error').classList.remove('hidden');
    }

    hideAllPanels() {
        const panels = document.querySelectorAll('.status-panel');
        panels.forEach(panel => panel.classList.add('hidden'));
    }

    async showFullscreenSymbol(symbolData) {
        const fullscreenElement = document.getElementById('symbol-fullscreen');
        const symbolImage = document.getElementById('fullscreen-symbol');
        
        symbolImage.src = symbolData;
        fullscreenElement.classList.remove('hidden');
        
        // Wait for image to load, then check if rotation is needed
        symbolImage.onload = () => {
            this.adjustSymbolOrientation(symbolImage);
        };
        
        // Try to enter true fullscreen mode
        try {
            if (fullscreenElement.requestFullscreen) {
                await fullscreenElement.requestFullscreen();
            } else if (fullscreenElement.webkitRequestFullscreen) {
                await fullscreenElement.webkitRequestFullscreen();
            } else if (fullscreenElement.mozRequestFullScreen) {
                await fullscreenElement.mozRequestFullScreen();
            } else if (fullscreenElement.msRequestFullscreen) {
                await fullscreenElement.msRequestFullscreen();
            }
        } catch (error) {
            console.log('Fullscreen not supported or blocked:', error);
            // Fallback to overlay mode if fullscreen fails
        }
    }

    adjustSymbolOrientation(img) {
        const isPortrait = window.innerHeight > window.innerWidth;
        const imgAspectRatio = img.naturalWidth / img.naturalHeight;
        const screenAspectRatio = window.innerWidth / window.innerHeight;
        
        // If screen is portrait and image is landscape (or vice versa), rotate
        const shouldRotate = (isPortrait && imgAspectRatio > 1) || (!isPortrait && imgAspectRatio < 1);
        
        if (shouldRotate) {
            img.style.transform = 'rotate(90deg)';
            img.style.width = '100vh';
            img.style.height = '100vw';
        } else {
            img.style.transform = 'rotate(0deg)';
            img.style.width = '100vw';
            img.style.height = '100vh';
        }
    }

    hideFullscreenSymbol() {
        const fullscreenElement = document.getElementById('symbol-fullscreen');
        
        // Exit fullscreen if we're in it
        if (document.fullscreenElement || document.webkitFullscreenElement || 
            document.mozFullScreenElement || document.msFullscreenElement) {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            } else if (document.mozCancelFullScreen) {
                document.mozCancelFullScreen();
            } else if (document.msExitFullscreen) {
                document.msExitFullscreen();
            }
        }
        
        fullscreenElement.classList.add('hidden');
    }

    handleFullscreenChange() {
        const fullscreenElement = document.getElementById('symbol-fullscreen');
        const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement || 
                               document.mozFullScreenElement || document.msFullscreenElement);
        
        if (!isFullscreen && !fullscreenElement.classList.contains('hidden')) {
            // User exited fullscreen using browser controls
            fullscreenElement.classList.add('hidden');
        }
    }

    async apiCall(command) {
        const url = new URL('quiz.php', window.location.origin);
        url.searchParams.set('cmd', command);
        url.searchParams.set('people_id', this.peopleId);

        const response = await fetch(url.toString(), {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        return await response.json();
    }
}

// Initialize the registration interface when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new QuizRegistration();
});

// Handle page visibility changes to refresh status
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && window.quizRegistration) {
        window.quizRegistration.loadStatus();
    }
});

// Make the registration instance globally accessible for debugging
window.addEventListener('load', () => {
    if (window.quizRegistration) {
        window.quizRegistration = window.quizRegistration;
    }
});
