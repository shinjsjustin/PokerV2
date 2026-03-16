function homeApp() {
    return {
        user: {},
        loading: true,
        recentGames: [],
        currentTable: null,
        addingBalance: false,

        async init() {
            // Check if user is logged in
            if (!getAuthToken()) {
                window.location.href = '../index.html';
                return;
            }

            // Load user data from localStorage first
            const userData = getUserData();
            if (userData) {
                this.user = userData;
            }

            // Fetch fresh profile data
            await this.loadUserProfile();
            await this.loadRecentGames();
            await this.checkCurrentTable();
        },

        async loadUserProfile() {
            try {
                const response = await fetch('/api/auth/profile', {
                    headers: {
                        'Authorization': `Bearer ${getAuthToken()}`
                    }
                });

                if (response.ok) {
                    const data = await response.json();
                    this.user = data.player;
                    // Update localStorage with fresh data
                    localStorage.setItem('userData', JSON.stringify(data.player));
                } else if (response.status === 401) {
                    // Token expired, redirect to login
                    this.handleLogout();
                }
            } catch (error) {
                console.error('Failed to load profile:', error);
            }
        },

        async loadRecentGames() {
            // Simulate loading recent games (you'll implement this later)
            this.loading = true;

            // Simulate API delay
            setTimeout(() => {
                // Mock data for now - replace with real API call later
                this.recentGames = [
                    { id: 1, result: 'Won $250', date: new Date(Date.now() - 86400000) },
                    { id: 2, result: 'Lost $100', date: new Date(Date.now() - 172800000) },
                    { id: 3, result: 'Won $450', date: new Date(Date.now() - 259200000) }
                ];
                this.loading = false;
            }, 1000);
        },

        formatNumber(num) {
            return num ? num.toLocaleString() : '0';
        },

        formatDate(date) {
            if (!date) return 'N/A';
            return new Date(date).toLocaleDateString();
        },

        async handleLogout() {
            try {
                // Call logout endpoint
                await fetch('/api/auth/logout', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${getAuthToken()}`
                    }
                });
            } catch (error) {
                console.error('Logout error:', error);
            }

            // Clear local storage and redirect
            localStorage.removeItem('authToken');
            localStorage.removeItem('userData');
            window.location.href = '../index.html';
        },

        // Check if player is currently seated at any table
        async checkCurrentTable() {
            try {
                const response = await authenticatedFetch('/api/tables/current');
                if (response.ok) {
                    const tableData = await response.json();
                    this.currentTable = tableData.table_id;
                }
            } catch (error) {
                console.error('Error checking current table:', error);
            }
        },

        // Game action handlers
        async createTable() {
            try {
                // First, leave any current table
                if (this.currentTable) {
                    await this.leaveCurrentTable();
                }

                const tableName = prompt('Enter table name:') || `${this.user.username}'s Table`;
                const maxPlayers = parseInt(prompt('Max players (2-9):') || '6');
                const smallBlind = parseInt(prompt('Small blind:') || '10');
                const bigBlind = parseInt(prompt('Big blind:') || '20');

                if (maxPlayers < 2 || maxPlayers > 9) {
                    throw new Error('Max players must be between 2 and 9');
                }
                if (smallBlind <= 0 || bigBlind <= smallBlind) {
                    throw new Error('Invalid blind structure');
                }

                const createResponse = await authenticatedFetch('/api/tables', {
                    method: 'POST',
                    body: JSON.stringify({
                        name: tableName,
                        max_players: maxPlayers,
                        small_blind: smallBlind,
                        big_blind: bigBlind
                    })
                });

                if (!createResponse.ok) {
                    const error = await createResponse.json();
                    throw new Error(error.message);
                }

                const newTable = await createResponse.json();

                // Join the new table
                const joinResponse = await authenticatedFetch(`/api/tables/${newTable.table_id}/join`, {
                    method: 'POST',
                    body: JSON.stringify({ chip_stack: 1000 })
                });

                if (!joinResponse.ok) {
                    const error = await joinResponse.json();
                    throw new Error(error.message);
                }

                this.currentTable = newTable.table_id;
                this.joinTableGame(newTable.table_id);

            } catch (error) {
                console.error('Create table error:', error);
                alert(`Failed to create table: ${error.message}`);
            }
        },

        async joinTableGame(tableId) {
            try {
                // Check for active game
                const gameResponse = await authenticatedFetch(`/api/games/tables/${tableId}/active-game`);

                if (gameResponse.ok) {
                    const game = await gameResponse.json();
                    window.location.href = `game.html?tableId=${tableId}&gameId=${game.game_id}`;
                } else {
                    // No active game, show table lobby or start game
                    window.location.href = `table.html?tableId=${tableId}`;
                }
            } catch (error) {
                console.error('Join game error:', error);
                // Fallback to table view
                window.location.href = `table.html?tableId=${tableId}`;
            }
        },

        async joinTable() {
            try {
                // First, leave any current table
                if (this.currentTable) {
                    await this.leaveCurrentTable();
                }

                // Show available tables
                const response = await authenticatedFetch('/api/tables');
                if (!response.ok) throw new Error('Failed to fetch tables');

                const tables = await response.json();
                const availableTables = tables.filter(t =>
                    t.status !== 'closed' && t.current_players < t.max_players
                );

                if (availableTables.length === 0) {
                    alert('No available tables found. Would you like to create one?');
                    return;
                }

                // Simple table selection (you might want a better UI later)
                let tableList = 'Available Tables:\n\n';
                availableTables.forEach((table, index) => {
                    tableList += `${index + 1}. ${table.name} (${table.current_players}/${table.max_players} players) - Blinds: $${table.small_blind}/$${table.big_blind}\n`;
                });

                const selection = prompt(tableList + '\nEnter table number to join:');
                const tableIndex = parseInt(selection) - 1;

                if (tableIndex >= 0 && tableIndex < availableTables.length) {
                    const selectedTable = availableTables[tableIndex];

                    // Join selected table
                    const joinResponse = await authenticatedFetch(`/api/tables/${selectedTable.table_id}/join`, {
                        method: 'POST',
                        body: JSON.stringify({ chip_stack: 1000 })
                    });

                    if (!joinResponse.ok) {
                        const error = await joinResponse.json();
                        throw new Error(error.message);
                    }

                    this.currentTable = selectedTable.table_id;
                    this.joinTableGame(selectedTable.table_id);
                }

            } catch (error) {
                console.error('Join table error:', error);
                alert(`Error joining table: ${error.message}`);
            }
        },

        async returnToTable() {
            if (!this.currentTable) {
                alert('No table to return to.');
                return;
            }

            try {
                // Check if table still exists and player is still seated
                const response = await authenticatedFetch(`/api/tables/${this.currentTable}`);
                if (!response.ok) {
                    this.currentTable = null;
                    throw new Error('Table no longer exists');
                }

                this.joinTableGame(this.currentTable);
            } catch (error) {
                console.error('Return to table error:', error);
                alert(`Error returning to table: ${error.message}`);
                this.currentTable = null;
            }
        },

        async leaveCurrentTable() {
            if (!this.currentTable) return;

            try {
                const response = await authenticatedFetch(`/api/tables/${this.currentTable}/leave`, {
                    method: 'DELETE'
                });

                if (response.ok) {
                    this.currentTable = null;
                } else {
                    console.error('Failed to leave table properly');
                }
            } catch (error) {
                console.error('Error leaving current table:', error);
            }
        },

        viewStats() {
            alert('Statistics feature coming soon!');
        },

        async addBalance() {
            try {
                const amount = prompt('How much would you like to add to your balance?\nEnter amount (max $10,000):');

                if (!amount || amount.trim() === '') {
                    return; // User cancelled or entered empty value
                }

                const numericAmount = parseInt(amount);

                if (isNaN(numericAmount) || numericAmount <= 0) {
                    alert('Please enter a valid positive number.');
                    return;
                }

                if (numericAmount > 10000) {
                    alert('Maximum add amount is $10,000.');
                    return;
                }

                this.addingBalance = true;

                const response = await authenticatedFetch('/api/auth/add-balance', {
                    method: 'POST',
                    body: JSON.stringify({ amount: numericAmount })
                });

                if (!response.ok) {
                    const error = await response.json();
                    throw new Error(error.message);
                }

                const result = await response.json();

                // Update user balance
                this.user.chip_balance = result.chip_balance;

                // Update localStorage
                const userData = getUserData();
                if (userData) {
                    userData.chip_balance = result.chip_balance;
                    localStorage.setItem('userData', JSON.stringify(userData));
                }

                alert(`Successfully added $${result.amount_added}!\nNew balance: $${this.formatNumber(result.chip_balance)}`);

            } catch (error) {
                console.error('Add balance error:', error);
                alert(`Failed to add balance: ${error.message}`);
            } finally {
                this.addingBalance = false;
            }
        }
    }
}