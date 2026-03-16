function pokerGame() {
  return {
    // ── Constants ──────────────────────────────────────
    stages: ['pre_flop', 'flop', 'turn', 'river', 'showdown'],

    // ── UI Display State ───────────────────────────────
    // All data is computed and provided by server
    loading: true,
    error: null,
    user: null,
    game: null,
    tableId: null,
    gameId: null,
    myPlayerId: null,
    
    // Action UI state (server controls availability)
    showRaise: false,
    raiseAmount: 0,
    minRaise: 0,
    maxRaise: 0,
    toCall: 0,
    actionInProgress: false,
    timerPct: 100,
    
    // Server-provided state
    actionOptions: null, // Available actions from server
    isMyTurn: false, // Server determines this
    canRaise: false, // Server determines this
    activePlayerName: '',
    messages: [],
    lastActions: [],

    // ── Simple Getters (no computation) ───────────────
    get myPlayer() {
      if (!this.game?.players || !this.myPlayerId) return null;
      return this.game.players.find(p => p.player_id === this.myPlayerId) || null;
    },

    get actionDisabled() {
      return this.actionInProgress || !this.isMyTurn;
    },
    
    get communityDisplay() {
      const cards = this.game?.community_cards || [];
      // Show 5 card slots total, face-down for unrevealed cards
      const displayCards = [];
      for (let i = 0; i < 5; i++) {
        if (i < cards.length && cards[i]) {
          displayCards.push({ faceDown: false, ...this.parseCard(cards[i]) });
        } else {
          displayCards.push({ faceDown: true });
        }
      }
      return displayCards;
    },

    // ── Helpers ────────────────────────────────────────
    initials(name) {
      return name ? name.slice(0, 2).toUpperCase() : '??';
    },

    // Parse a single card code like "Ah", "Kd", "10c", "Ts"
    parseCard(code) {
      if (!code) return { faceDown: true };
      const suits = { h: '♥', d: '♦', c: '♣', s: '♠' };
      const redSuits = new Set(['h', 'd']);
      const suitChar = code[code.length - 1].toLowerCase();
      const rank = code.slice(0, -1).toUpperCase().replace('T', '10');
      return {
        raw: code,
        rank,
        suit: suits[suitChar] || suitChar,
        color: redSuits.has(suitChar) ? 'red' : 'black',
        faceDown: false,
      };
    },

    // Parse an array of card codes (from hole_cards JSON column)
    parseCards(cards) {
      if (!cards || !cards.length) return [];
      return cards.map(c => this.parseCard(c));
    },

    toggleRaise() {
      this.showRaise = !this.showRaise;
      if (this.showRaise) {
        this.raiseAmount = this.minRaise;
      }
    },

    // ── Server Communication ──────────────────────────
    // Send action to server via socket (server handles all logic)
    act(type) {
      if (this.actionDisabled || !this.gameId || !window.socket) return;

      this.actionInProgress = true;
      
      const action = {
        type: type,
        amount: type === 'raise' ? this.raiseAmount : this.toCall,
        game_id: this.gameId,
        player_id: this.myPlayerId
      };

      console.log('Sending action to server:', action);
      window.socket.emit('player_action', action);
      
      // Hide raise panel after action
      this.showRaise = false;
    },

    loadUserInfo() {
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

    reloadGame() {
      // Simply request fresh data from server
      if (window.socket && this.tableId) {
        this.loading = true;
        this.error = null;
        window.socket.emit('request_game_state', { tableId: this.tableId });
      }
    },

    // ── Init ───────────────────────────────────────────
    init() {
      try {
        // Check authentication
        if (!isAuthenticated()) {
          window.location.href = 'login.html';
          return;
        }

        // Load user info
        this.loadUserInfo();

        // Get table and game IDs from URL parameters
        const urlParams = new URLSearchParams(window.location.search);
        this.tableId = urlParams.get('tableId');
        this.gameId = urlParams.get('gameId');

        if (!this.tableId) {
          throw new Error('No table ID provided');
        }

        // Expose this component instance globally for socket integration
        window.pokerGameInstance = this;
        
        // Server will send initial game state via socket after connection
        this.loading = false;

      } catch (error) {
        console.error('Initialization error:', error);
        this.error = error.message;
        this.loading = false;
      }
    },

    // Cleanup when component is destroyed  
    destroy() {
      // No polling to stop in thin client
      console.log('Poker game component destroyed');
    },

    // ── Server Data Handlers ──────────────────────────
    // These methods receive computed data from server and update UI
    
    updateGameState(serverData) {
      console.log('Received game state from server:', serverData);
      
      // Server provides fully computed game state - just display it
      this.game = serverData;
      this.gameId = serverData.game_id;
      this.loading = false;
      this.error = null;
      
      // Reset action state when game state updates
      this.actionInProgress = false;
    },

    updatePlayerState(playerData) {
      console.log('Received player state from server:', playerData);
      
      // Server tells us our current state
      this.isMyTurn = playerData.isMyTurn;
      this.canRaise = playerData.canRaise;
      this.toCall = playerData.toCall;
      this.minRaise = playerData.minRaise;
      this.maxRaise = playerData.maxRaise;
      this.activePlayerName = playerData.activePlayerName;
      
      // Update raise slider if needed
      if (this.showRaise && this.raiseAmount < this.minRaise) {
        this.raiseAmount = this.minRaise;
      }
    },

    updateActionOptions(options) {
      console.log('Received action options from server:', options);
      this.actionOptions = options;
      this.isMyTurn = options && options.length > 0;
      
      if (this.isMyTurn && options.minRaise) {
        this.raiseAmount = options.minRaise;
      }
    },

    clearActionOptions() {
      this.actionOptions = null;
      this.isMyTurn = false;
      this.showRaise = false;
      this.actionInProgress = false;
    },

    setError(errorMessage) {
      this.error = errorMessage;
      this.loading = false;
      this.actionInProgress = false;
    },

    clearError() {
      this.error = null;
    },

    addMessage(message) {
      this.messages.unshift({
        id: Date.now() + Math.random(),
        ...message
      });
      
      // Keep only last 50 messages
      if (this.messages.length > 50) {
        this.messages = this.messages.slice(0, 50);
      }
    },

    addAction(action) {
      this.lastActions.unshift({
        id: Date.now() + Math.random(),
        ...action
      });
      
      // Keep only last 10 actions
      if (this.lastActions.length > 10) {
        this.lastActions = this.lastActions.slice(0, 10);
      }
    },

    showGameEnd(endData) {
      console.log('Game ended:', endData);
      this.addMessage({
        type: 'system',
        message: `Game ended! Seat ${endData.winnerSeat} wins with ${endData.winningHand} (${endData.pot} chips)`,
        scope: 'table',
        timestamp: new Date()
      });
      
      // Clear action state
      this.clearActionOptions();
      
      if (this.game) {
        this.game.stage = 'showdown';
      }
    },

    // Timer updates from server
    updateTimer(timerData) {
      this.timerPct = timerData.percentage;
      if (timerData.timeLeft <= 0) {
        this.clearActionOptions();
      }
    },
    
    // ── Utility Methods ───────────────────────────────
    // Helper to find player by seat (minimal logic)
    findPlayerBySeat(seatNumber) {
      if (!this.game?.players || !seatNumber) return null;
      const player = this.game.players.find(p => p.seat_number === seatNumber);
      return player?.player_id || null;
    }
  };
}
