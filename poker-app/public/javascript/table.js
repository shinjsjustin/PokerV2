function tableLobby() {
    return {
        loading: true,
        error: null,
        user: null,
        table: null,
        tableId: null,
        myPlayerId: null,
        actionInProgress: false,
        activeGame: null,
        messages: [],
        socketConnected: false,
        gameEnded: false,
        lastGameWinners: null,

        get isSeated() {
            if (!this.table?.players || !this.myPlayerId) return false;
            return this.table.players.some(p => p.player_id === this.myPlayerId);
        },

        get seats() {
            const seats = [];
            const maxSeats = this.table?.max_players || 9;

            for (let i = 1; i <= maxSeats; i++) {
                const player = this.table?.players?.find(p => p.seat_number === i);
                seats.push({
                    number: i,
                    player: player || null
                });
            }
            return seats;
        },

        get myPlayer() {
            if (!this.table?.players || !this.myPlayerId) return null;
            return this.table.players.find(p => p.player_id === this.myPlayerId);
        },

        async loadUserInfo() {
            try {
                const userData = getUserData();
                if (userData) {
                    this.user = userData;
                    this.myPlayerId = userData.player_id;
                }
            } catch (error) {
                console.error('Failed to load user info:', error);
            }
        },

        async fetchTableData() {
            if (!this.tableId) return;

            try {
                const response = await authenticatedFetch(`/api/tables/${this.tableId}`);
                if (!response.ok) {
                    throw new Error('Failed to fetch table data');
                }

                this.table = await response.json();

                // Check for active game
                try {
                    const gameResponse = await authenticatedFetch(`/api/games/tables/${this.tableId}/active-game`);
                    if (gameResponse.ok) {
                        this.activeGame = await gameResponse.json();
                    } else {
                        this.activeGame = null;
                    }
                } catch (gameError) {
                    this.activeGame = null;
                }

                this.error = null;
            } catch (error) {
                console.error('Error fetching table data:', error);
                this.error = error.message;
            }
        },

        async joinTable() {
            this.actionInProgress = true;
            try {
                const response = await authenticatedFetch(`/api/tables/${this.tableId}/join`, {
                    method: 'POST',
                    body: JSON.stringify({})
                });

                if (!response.ok) {
                    const error = await response.json();
                    throw new Error(error.message);
                }

                const result = await response.json();
                this.addMessage(`Joined table at seat ${result.seat_number}`, 'success');

                // Refresh table data
                await this.fetchTableData();

                // Update user balance
                await this.loadUserInfo();

            } catch (error) {
                console.error('Join table error:', error);
                this.addMessage(`Failed to join table: ${error.message}`, 'error');
            } finally {
                this.actionInProgress = false;
            }
        },

        async startGame() {
            this.actionInProgress = true;
            try {
                // Find a dealer seat (just use first seated player for now)
                const firstPlayer = this.table.players[0];
                const dealerSeat = firstPlayer?.seat_number || 1;

                const response = await authenticatedFetch('/api/games', {
                    method: 'POST',
                    body: JSON.stringify({
                        table_id: this.tableId,
                        dealer_seat: dealerSeat
                    })
                });

                if (!response.ok) {
                    const error = await response.json();
                    throw new Error(error.message);
                }

                const gameData = await response.json();

                // Navigate to game
                window.location.href = `game.html?tableId=${this.tableId}&gameId=${gameData.game_id}`;

            } catch (error) {
                console.error('Start game error:', error);
                this.addMessage(`Failed to start game: ${error.message}`, 'error');
            } finally {
                this.actionInProgress = false;
            }
        },

        async leaveTable() {
            if (!confirm('Are you sure you want to leave the table?')) {
                return;
            }

            this.actionInProgress = true;
            try {
                const response = await authenticatedFetch(`/api/tables/${this.tableId}/leave`, {
                    method: 'POST'
                });

                if (!response.ok) {
                    const error = await response.json();
                    throw new Error(error.message);
                }

                // Go back to home page
                window.location.href = 'home.html';

            } catch (error) {
                console.error('Leave table error:', error);
                this.addMessage(`Failed to leave table: ${error.message}`, 'error');
            } finally {
                this.actionInProgress = false;
            }
        },

        async joinActiveGame() {
            if (this.activeGame) {
                window.location.href = `game.html?tableId=${this.tableId}&gameId=${this.activeGame.game_id}`;
            }
        },

        // Socket event handlers
        setupSocketListeners() {
            if (typeof socket === 'undefined') {
                console.warn('Socket not available');
                return;
            }

            // Connection status
            socket.on('connect', () => {
                this.socketConnected = true;
                console.log('Socket connected for table lobby');
                
                // Join the table room
                if (this.tableId) {
                    socket.emit('join_table', this.tableId);
                }
            });

            socket.on('disconnect', () => {
                this.socketConnected = false;
                console.log('Socket disconnected');
            });

            // System messages to player
            socket.on('system_to_player_message', (packet) => {
                console.log('Player message:', packet.message);
                this.addMessage(packet.message, 'info');
                // Refresh table data when we get updates
                this.fetchTableData();
            });

            // System messages to table
            socket.on('system_to_table_message', (packet) => {
                console.log('Table message:', packet.message);
                this.addMessage(packet.message, 'table');
                // Refresh table data when we get updates
                this.fetchTableData();
            });

            // Table update events - refresh data
            socket.on('table_player_joined', () => {
                this.fetchTableData();
            });

            socket.on('table_player_left', () => {
                this.fetchTableData();
            });

            socket.on('table_updated', () => {
                this.fetchTableData();
            });

            // Game started notification
            socket.on('game_started', (data) => {
                if (data.table_id === this.tableId) {
                    this.activeGame = { game_id: data.game_id };
                    this.addMessage('A new game has started!', 'info');
                }
            });
        },

        addMessage(text, type = 'info') {
            this.messages.unshift({
                text,
                type,
                timestamp: new Date()
            });
            // Keep only last 10 messages
            if (this.messages.length > 10) {
                this.messages.pop();
            }
        },

        async init() {
            // Store instance globally for socket access
            window.tableLobbyInstance = this;

            try {
                // Check authentication
                if (!isAuthenticated()) {
                    window.location.href = 'login.html';
                    return;
                }

                // Load user info
                await this.loadUserInfo();

                // Get table ID from URL parameter
                const urlParams = new URLSearchParams(window.location.search);
                this.tableId = urlParams.get('tableId');
                
                // Check if returning from a finished game
                if (urlParams.get('gameEnded') === 'true') {
                    this.gameEnded = true;
                    this.addMessage('Previous game ended - Start a new game!', 'success');
                    // Clean up URL without reloading
                    window.history.replaceState({}, '', `table.html?tableId=${this.tableId}`);
                }

                if (!this.tableId) {
                    throw new Error('No table ID provided');
                }

                // Load table data
                await this.fetchTableData();

                // Setup socket listeners for real-time updates
                this.setupSocketListeners();

            } catch (error) {
                console.error('Initialization error:', error);
                this.error = error.message;
            } finally {
                this.loading = false;
            }
        },

        // Cleanup when leaving page
        destroy() {
            if (typeof socket !== 'undefined' && this.tableId) {
                socket.emit('leave_table', this.tableId);
            }
        }
    };
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (window.tableLobbyInstance) {
        window.tableLobbyInstance.destroy();
    }
});