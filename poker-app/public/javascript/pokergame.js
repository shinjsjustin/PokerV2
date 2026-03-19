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
    myHoleCards: null, // Player's private hole cards from server
    currentStage: null, // Track current stage for highlight clearing
    playerActions: new Map(), // Track last action for each player

    // ── Simple Getters (no computation) ───────────────
    get myPlayer() {
      if (!this.game?.players || !this.myPlayerId) return null;
      const myId = Number(this.myPlayerId);
      return this.game.players.find(p => Number(p.player_id) === myId) || null;
    },

    get actionDisabled() {
      return this.actionInProgress || !this.isMyTurn;
    },

    get myHandLabel() {
      // Simple hand description - could be enhanced with pokersolver integration
      return null;
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
    // Send action to server via HTTP POST (server handles all logic)
    async act(type) {
      if (this.actionDisabled || !this.gameId) return;

      const myPlayer = this.myPlayer;
      if (!myPlayer) {
        console.error('Cannot act: player info not found');
        return;
      }

      this.actionInProgress = true;
      
      // Convert frontend action type to PlayerAction format
      // PlayerAction expects: game_id, seat, current_bet, player_bet, allin
      // player_bet: -1 = fold, 0 = check (when current_bet is 0), 
      //             = current_bet for call, > current_bet for raise
      let player_bet;
      let allin = false;
      const currentBet = this.game.current_bet || 0;
      const myCurrentBet = myPlayer.current_bet || 0;
      const toCall = Math.max(0, currentBet - myCurrentBet);
      
      switch (type) {
        case 'fold':
          player_bet = -1;
          break;
        case 'check':
          player_bet = 0;
          break;
        case 'call':
          // For call, player_bet should equal the current_bet (the amount to match)
          player_bet = currentBet;
          break;
        case 'raise':
          // raiseAmount is the total bet amount the player wants to have in
          player_bet = this.raiseAmount;
          break;
        case 'allin':
          // All-in: player_bet is their total chip stack + what they already have in
          player_bet = myPlayer.chip_balance + myCurrentBet;
          allin = true;
          break;
        default:
          console.error('Unknown action type:', type);
          this.actionInProgress = false;
          return;
      }

      const actionPayload = {
        game_id: this.gameId,
        seat: myPlayer.seat_number,
        current_bet: currentBet,
        player_bet: player_bet,
        allin: allin
      };

      console.log('Sending action to server:', actionPayload);

      try {
        const response = await authenticatedFetch('/api/games/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(actionPayload)
        });

        const result = await response.json();
        
        if (!response.ok) {
          console.error('Action failed:', result.message);
          this.addMessage({
            type: 'error',
            text: result.message || 'Action failed',
            timestamp: new Date()
          });
        } else {
          console.log('Action processed:', result);
          // Clear action options after successful action
          this.clearActionOptions();
        }
      } catch (error) {
        console.error('Failed to send action:', error);
        this.addMessage({
          type: 'error',
          text: 'Failed to send action',
          timestamp: new Date()
        });
      } finally {
        this.actionInProgress = false;
        this.showRaise = false;
      }
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
      // Fetch fresh game state from API
      this.loading = true;
      this.error = null;
      this.fetchGameState();
    },

    // ── API Fetch ──────────────────────────────────────
    async fetchGameState() {
      if (!this.gameId) {
        this.error = 'No game ID provided';
        this.loading = false;
        return;
      }

      try {
        const response = await authenticatedFetch(`/api/games/${this.gameId}/state`);
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.message || 'Failed to fetch game state');
        }

        const gameState = await response.json();
        this.updateGameState(gameState);
      } catch (error) {
        console.error('Failed to fetch game state:', error);
        this.error = error.message;
        this.loading = false;
      }
    },

    // ── Init ───────────────────────────────────────────
    async init() {
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

        if (!this.gameId) {
          throw new Error('No game ID provided');
        }

        // Expose this component instance globally for socket integration
        window.pokerGameInstance = this;
        
        // Late-register socket if it connected before we had player info
        if (typeof lateRegisterSocket === 'function' && this.myPlayerId) {
          lateRegisterSocket(this.myPlayerId, this.tableId);
        }
        
        // Fetch initial game state from API
        await this.fetchGameState();

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

    // ── Action Highlighting Methods ──────────────────
    preserveActionHighlights(newPlayers) {
      // Copy lastAction from existing players to new player data
      if (this.game && this.game.players) {
        newPlayers.forEach(newPlayer => {
          const existingPlayer = this.game.players.find(p => p.player_id === newPlayer.player_id);
          if (existingPlayer && existingPlayer.lastAction) {
            newPlayer.lastAction = existingPlayer.lastAction;
          }
        });
      }
    },

    clearActionHighlights() {
      if (this.game && this.game.players) {
        this.game.players.forEach(player => {
          player.lastAction = null;
        });
      }
      this.playerActions.clear();
    },

    highlightPlayerAction(playerId, actionType, seatNumber) {
      console.log('Highlighting action:', { playerId, actionType, seatNumber });
      
      // Store the action for this player
      this.playerActions.set(playerId, actionType);
      
      // Update the player in the game state with the visual highlight
      if (this.game && this.game.players) {
        const player = this.game.players.find(p => p.player_id === playerId);
        if (player) {
          player.lastAction = actionType;
          console.log('Applied action highlight to player:', player.username, actionType);
        }
      }
    },

    // ── Server Data Handlers ──────────────────────────
    // These methods receive computed data from server and update UI
    
    updateGameState(serverData) {
      console.log('Received game state from server:', serverData);
      
      // CRITICAL FIX: Preserve existing game state to prevent UI flicker
      // Only update if we have valid data to prevent PLAYERS/YOUR HAND from hiding
      if (serverData && typeof serverData === 'object') {
        // Check if stage has progressed - clear action highlights if so
        if (this.game && this.game.stage && serverData.stage !== this.game.stage) {
          console.log('Stage progressed from', this.game.stage, 'to', serverData.stage, '- clearing action highlights');
          this.clearActionHighlights();
        }
        
        // Preserve action highlights by merging them into the new player data
        if (this.game && this.game.players && serverData.players) {
          this.preserveActionHighlights(serverData.players);
        }
        
        // Server provides fully computed game state - just display it
        const previousGame = this.game;
        this.game = serverData;
        this.gameId = serverData.game_id;
        this.currentStage = serverData.stage;

        // FIX: Server broadcasts always send hole_cards: null for privacy.
        // Restore this player's hole cards from the locally-cached copy so
        // they don't disappear every time any player takes an action.
        if (this.myHoleCards && this.game.players && this.myPlayerId) {
          const myPlayer = this.game.players.find(
            p => Number(p.player_id) === Number(this.myPlayerId)
          );
          if (myPlayer && !myPlayer.hole_cards) {
            myPlayer.hole_cards = this.myHoleCards;
          }
        }
        
        // Never allow loading/error to show when we have valid game data
        this.loading = false;
        this.error = null;
        
        // Only reset action state for actual actions, not for general game state updates
        // This prevents action UI from being cleared during stage progression
        if (serverData.clearActions !== false) {
          this.actionInProgress = false;
        }
        
        // Handle pending action if this player needs to act (e.g., on page refresh)
        // Use Number() to ensure consistent type comparison
        const pendingPlayerId = serverData.pendingAction?.player_id;
        const myId = Number(this.myPlayerId);
        console.log('Checking pending action:', { pendingPlayerId, myId, hasPendingAction: !!serverData.pendingAction });
        
        if (serverData.pendingAction && Number(pendingPlayerId) === myId) {
          const pending = serverData.pendingAction;
          console.log('Restoring pending action on refresh:', pending);
          
          const isCheckRequest = pending.to_call === 0;
          if (isCheckRequest) {
            // Check scenario
            this.updateActionOptions({
              check: true,
              raise: true,
              allin: true,
              minRaise: pending.min_raise
            });
          } else {
            // Call scenario
            this.updateActionOptions({
              call: pending.to_call,
              raise: true,
              fold: true,
              allin: true,
              minRaise: pending.min_raise,
              toCall: pending.to_call
            });
          }
          
          // Get my player's chip balance for maxRaise
          const myPlayer = serverData.players?.find(p => Number(p.player_id) === myId);
          const myChips = myPlayer?.chip_balance || 0;
          
          // Find active player name from seat
          const activePlayer = serverData.players?.find(p => p.seat_number === pending.seat);
          const activePlayerName = activePlayer?.username || 'Unknown';
          
          this.updatePlayerState({
            isMyTurn: true,
            canRaise: true,
            toCall: pending.to_call,
            minRaise: pending.min_raise,
            maxRaise: myChips,
            activePlayerSeat: pending.seat,
            activePlayerName: activePlayerName
          });
        } else {
          console.log('No pending action for this player. pendingAction:', serverData.pendingAction);
        }
      } else {
        console.warn('Invalid game state data received:', serverData);
        // Only set error if we don't have existing valid game state
        if (!this.game) {
          this.error = 'Invalid game state received';
          this.loading = false;
        }
      }
    },

    /**
     * Receive hole cards dealt to this player (private)
     * @param {Array} holeCards - Array of card strings e.g. ["Ah", "Kd"]
     * @param {number} seatNumber - The seat number this player is at
     */
    receiveHoleCards(holeCards, seatNumber) {
      console.log('Received hole cards:', holeCards, 'at seat:', seatNumber);
      
      // Update the player's hole cards in the game state
      // FIX: Use Number() to ensure consistent type comparison (player_id may be
      //      a string from the server but myPlayerId may be a number or vice versa).
      if (this.game && this.game.players) {
        const myPlayer = this.game.players.find(
          p => Number(p.player_id) === Number(this.myPlayerId)
        );
        if (myPlayer) {
          myPlayer.hole_cards = holeCards;
        }
      }
      
      // Also store locally for quick access
      this.myHoleCards = holeCards;
      
      this.addMessage({
        type: 'info',
        text: 'Cards dealt!',
        timestamp: new Date()
      });
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
      // Options is an object, not an array - check if it has any truthy action properties
      this.isMyTurn = !!(options && (options.check || options.call || options.fold || options.raise || options.allin));
      
      if (this.isMyTurn && options.minRaise) {
        this.raiseAmount = options.minRaise;
        this.minRaise = options.minRaise;
      }
      if (options.toCall !== undefined) {
        this.toCall = options.toCall;
      }
    },

    clearActionOptions() {
      console.log('Clearing action options - preserving game state');
      this.actionOptions = null;
      this.isMyTurn = false;
      this.showRaise = false;
      this.actionInProgress = false;
      // DO NOT reset this.game or player data - this was causing UI elements to hide
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
      
      // Highlight the player's action if we have the necessary info
      if (action.player_id && action.action_type && action.seat_number) {
        this.highlightPlayerAction(action.player_id, action.action_type, action.seat_number);
      }
      
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
    
    // Server Communication (called by socket-client.js)
    receivePlayerAction(actionData) {
      console.log('Received player action:', actionData);
      
      // Add to action history with highlighting
      this.addAction({
        player_id: actionData.player_id,
        seat_number: actionData.seat,
        action_type: actionData.action_type,
        amount: actionData.amount,
        timestamp: new Date()
      });
      
      this.addMessage({
        type: 'action',
        text: `${actionData.player_name || 'Player'} ${actionData.action_type}${actionData.amount ? ' ' + actionData.amount : ''}`,
        timestamp: new Date()
      });
    },
    
    // ── Utility Methods ─────────────────────────────────────────
    // Helper to find player by seat (minimal logic)
    findPlayerBySeat(seatNumber) {
      if (!this.game?.players || !seatNumber) return null;
      const player = this.game.players.find(p => p.seat_number === seatNumber);
      return player?.player_id || null;
    }
  };
}
