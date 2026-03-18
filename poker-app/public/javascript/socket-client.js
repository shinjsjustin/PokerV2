// Import schema types for data package validation
// Note: For browser environments, you may need to include schema.js as a script tag
// and access types globally if not using a module bundler
try {
    // For Node.js/bundler environments
    if (typeof require !== 'undefined') {
        const { PackageType, createFromJSON } = require('../../datapacks/schema');
        window.PackageType = PackageType;
        window.createFromJSON = createFromJSON;
    }
} catch (e) {
    // For browser environments, assume schema is loaded globally
    console.log('Using global schema definitions');
}

const socket = io();

// ═══════════════════════════════════════════════════════════════════
// CONNECTION LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

let currentTableId = null;
let currentPlayerId = null;
let currentGameId = null;
let gameState = null;
let currentPlayerSeat = null;

socket.on('connect', () => {
    console.log('Connected to server:', socket.id);
    
    // Get table and player info from Alpine.js component
    if (window.pokerGameInstance) {
        currentTableId = window.pokerGameInstance.tableId;
        currentPlayerId = window.pokerGameInstance.myPlayerId;
        currentGameId = window.pokerGameInstance.gameId;
        
        // Find current player's seat from game state
        if (window.pokerGameInstance.myPlayer) {
            currentPlayerSeat = window.pokerGameInstance.myPlayer.seat_number;
        }
    }
    
    // Fallback: get from table lobby instance
    if (!currentPlayerId && window.tableLobbyInstance) {
        currentPlayerId = window.tableLobbyInstance.myPlayerId;
        currentTableId = window.tableLobbyInstance.tableId;
    }
    
    // Fallback: get player ID directly from localStorage (auth.js getUserData)
    if (!currentPlayerId && typeof getUserData === 'function') {
        const userData = getUserData();
        if (userData?.player_id) {
            currentPlayerId = userData.player_id;
        }
    }
    
    // Fallback: get from page data attributes if component not ready
    if (!currentTableId) {
        currentTableId = document.body.dataset.tableId;
    }
    if (!currentPlayerId) {
        currentPlayerId = document.body.dataset.playerId;
    }
    
    // Register player with server socket manager (required before joining tables)
    if (currentPlayerId) {
        socket.emit('register_player', currentPlayerId);
        console.log('Registered player:', currentPlayerId);
    }
    
    if (currentTableId) {
        joinTable(currentTableId);
    }
});

socket.on('disconnect', (reason) => {
    console.log('Disconnected:', reason);
    showConnectionStatus('Disconnected - Reconnecting...', 'warning');
});

socket.on('connect_error', (err) => {
    console.error('Connection failed:', err.message);
    showConnectionStatus('Connection failed', 'error');
});

// ═══════════════════════════════════════════════════════════════════
// LATE REGISTRATION - For when Alpine component initializes after socket connects
// ═══════════════════════════════════════════════════════════════════

/**
 * Register player with socket after Alpine component is ready
 * Call this from Alpine component init() if socket is already connected
 */
function lateRegisterSocket(playerId, tableId) {
    if (socket.connected && playerId && !currentPlayerId) {
        currentPlayerId = playerId;
        socket.emit('register_player', playerId);
        console.log('Late-registered player:', playerId);
    }
    
    if (socket.connected && tableId && !currentTableId) {
        joinTable(tableId);
    }
}

// Expose for use by Alpine components
window.lateRegisterSocket = lateRegisterSocket;

// ═══════════════════════════════════════════════════════════════════
// TABLE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

function joinTable(tableId) {
    socket.emit('join_table', tableId);
    currentTableId = tableId;
    console.log(`Joining table: ${tableId}`);
}

function leaveTable() {
    if (currentTableId) {
        socket.emit('leave_table');
        console.log(`Left table: ${currentTableId}`);
        currentTableId = null;
    }
}

// ═══════════════════════════════════════════════════════════════════
// MESSAGE LISTENERS - Server to Client
// ═══════════════════════════════════════════════════════════════════

// System messages to specific player
socket.on('system_to_player_message', (packet) => {
    console.log('System message:', packet.message);
    displaySystemMessage(packet.message, 'player');
});

// System messages to entire table
socket.on('system_to_table_message', (packet) => {
    console.log('Table message:', packet.message);
    displaySystemMessage(packet.message, 'table');
});

// Player-to-player messages
socket.on('player_to_player_message', (packet) => {
    console.log(`Message from Player ${packet.from_player_id}:`, packet.message);
    displayPlayerMessage(packet.from_player_id, packet.message);
});

// ═══════════════════════════════════════════════════════════════════
// GAME ACTION REQUESTS - Server asking for player input
// ═══════════════════════════════════════════════════════════════════

// Server requests check/raise/allin (no bet to call)
socket.on('server_request_check', (packet) => {
    console.log('Action requested - Check scenario:', packet);
    
    // Validate packet structure
    if (!packet.game_id || !packet.player_id || packet.seat === undefined) {
        console.error('Invalid server_request_check packet:', packet);
        return;
    }
    
    currentGameId = packet.game_id;
    
    if (Number(packet.player_id) === Number(currentPlayerId) && window.pokerGameInstance) {
        window.pokerGameInstance.updateActionOptions({
            check: true,
            raise: true,
            allin: true,
            minRaise: packet.min_raise
        });
        window.pokerGameInstance.updatePlayerState({
            isMyTurn: true,
            canRaise: true,
            toCall: 0,
            minRaise: packet.min_raise,
            maxRaise: getPlayerChips(),
            activePlayerSeat: packet.seat
        });
    }
});

// Server requests call/raise/fold/allin
socket.on('server_request_call', (packet) => {
    console.log('Action requested - Call scenario:', packet);
    
    // Validate packet structure
    if (!packet.game_id || !packet.player_id || packet.seat === undefined) {
        console.error('Invalid server_request_call packet:', packet);
        return;
    }
    
    currentGameId = packet.game_id;
    
    if (Number(packet.player_id) === Number(currentPlayerId) && window.pokerGameInstance) {
        window.pokerGameInstance.updateActionOptions({
            call: packet.to_call,
            raise: true,
            fold: true,
            allin: true,
            minRaise: packet.min_raise,
            toCall: packet.to_call
        });
        window.pokerGameInstance.updatePlayerState({
            isMyTurn: true,
            canRaise: true,
            toCall: packet.to_call,
            minRaise: packet.min_raise,
            maxRaise: getPlayerChips(),
            activePlayerSeat: packet.seat
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
// GAME STATE UPDATES
// ═══════════════════════════════════════════════════════════════════

// Full game state update - call new updateGameState method
socket.on('gamestate', (packet) => {
    console.log('Game state update:', packet);
    gameState = packet;
    currentGameId = packet.game_id;
    
    if (window.pokerGameInstance) {
        window.pokerGameInstance.updateGameState(packet);
    }
});

// Deal hole cards to player (private - only this player sees their cards)
socket.on('deal_hole_cards', (packet) => {
    console.log('Received hole cards:', packet);
    
    if (Number(packet.player_id) === Number(currentPlayerId) && window.pokerGameInstance) {
        // Update the player's hole cards in the game state
        window.pokerGameInstance.receiveHoleCards(packet.hole_cards, packet.seat_number);
    }
});

// Individual bet update
socket.on('gamestate_bet', (packet) => {
    console.log('Bet update:', packet);
    if (window.pokerGameInstance) {
        // Thin client: Let server handle all state logic
        // Request fresh game state instead of managing updates client-side
        requestGameState();
    }
});

// Last action announcement
socket.on('server_update_last_action', (packet) => {
    console.log('Last action:', packet);
    if (window.pokerGameInstance) {
        let actionText = '';
        if (packet.folded) actionText = `Seat ${packet.seat} folded`;
        else if (packet.allin) actionText = `Seat ${packet.seat} went all-in (${packet.bet_amount})`;
        else if (packet.bet_amount > 0) actionText = `Seat ${packet.seat} bet ${packet.bet_amount}`;
        else actionText = `Seat ${packet.seat} checked`;
        
        window.pokerGameInstance.addAction({
            seat: packet.seat,
            action: actionText,
            timestamp: new Date()
        });
    }
});

// Stage progression (flop, turn, river)
socket.on('server_update_stage_progression', (packet) => {
    console.log('Stage progression:', packet);
    if (window.pokerGameInstance) {
        // Thin client: Server manages all logic, request fresh game state
        requestGameState();
    }
});

// Game end
socket.on('server_update_game_end', (packet) => {
    console.log('Game ended:', packet);
    if (window.pokerGameInstance) {
        window.pokerGameInstance.showGameEnd({
            winnerSeat: packet.winner_seat,
            winningHand: packet.winning_hand,
            pot: packet.pot
        });
    }
});

// Game ended - return to table for new round
socket.on('server_game_ended_return_to_table', (packet) => {
    console.log('Game ended, returning to table:', packet);
    
    // Show brief results before redirecting
    if (window.pokerGameInstance) {
        window.pokerGameInstance.showGameEnd({
            winners: packet.winners,
            pot: packet.pot,
            message: packet.message
        });
    }
    
    // Redirect to table page after short delay to show results
    setTimeout(() => {
        window.location.href = `table.html?tableId=${packet.table_id}&gameEnded=true`;
    }, 3000);
});

// Add error handling from server
socket.on('error_message', (packet) => {
    console.error('Server error:', packet);
    if (window.pokerGameInstance) {
        window.pokerGameInstance.setError(packet.message || 'Server error occurred');
    }
});

// Add action response from server
socket.on('action_response', (packet) => {
    console.log('Action response:', packet);
    if (window.pokerGameInstance) {
        if (packet.success) {
            window.pokerGameInstance.clearError();
            window.pokerGameInstance.clearActionOptions();
        } else {
            window.pokerGameInstance.setError(packet.error || 'Action failed');
            window.pokerGameInstance.actionInProgress = false;
        }
    }
});

// Expose socket globally so pokergame.js can use it
window.socket = socket;

// ═══════════════════════════════════════════════════════════════════
// THIN CLIENT COMMUNICATION HELPERS
// ═══════════════════════════════════════════════════════════════════

/**
 * Request current game state from server
 */
function requestGameState() {
    if (currentGameId) {
        const packet = {
            type: 'request_game_state',
            game_id: currentGameId,
            player_id: currentPlayerId,
            timestamp: new Date()
        };
        socket.emit('request_game_state', packet);
    }
}

/**
 * Send structured message using schema
 */
function sendMessage(type, data) {
    try {
        // Validate data using schema if available
        if (window.PackageType && window.PackageType[type]) {
            socket.emit(window.PackageType[type], data);
        } else {
            socket.emit(type, data);
        }
    } catch (error) {
        console.error('Error sending message:', error);
        if (window.pokerGameInstance) {
            window.pokerGameInstance.setError('Communication error - please try again');
        }
    }
}

// Expose helper functions globally
window.requestGameState = requestGameState;
window.sendMessage = sendMessage;

// ═══════════════════════════════════════════════════════════════════
// PLAYER ACTIONS - Handled via API calls (removed socket emissions)
// ═══════════════════════════════════════════════════════════════════

// Player actions are now handled through API calls in the Alpine.js component
// See pokergame.js for implementation

// ═══════════════════════════════════════════════════════════════════
// MESSAGING FUNCTIONS - Handled via API calls (removed)
// ═══════════════════════════════════════════════════════════════════

// Player messaging is now handled through API calls

// ═══════════════════════════════════════════════════════════════════
// UI HELPER FUNCTIONS - You'll need to implement these based on your UI
// ═══════════════════════════════════════════════════════════════════

function showConnectionStatus(message, type) {
    // Update thin client with connection status
    console.log(`Connection status [${type}]:`, message);
    if (window.pokerGameInstance) {
        if (type === 'error' || type === 'warning') {
            window.pokerGameInstance.setError(message);
        } else {
            window.pokerGameInstance.clearError();
        }
    }
}

function displaySystemMessage(message, scope) {
    // Display system message through thin client
    console.log(`System [${scope}]:`, message);
    if (window.pokerGameInstance) {
        window.pokerGameInstance.addMessage({
            type: 'system',
            message: message,
            scope: scope,
            timestamp: new Date()
        });
    }
}

function displayPlayerMessage(fromPlayerId, message) {
    // Display player message through thin client  
    console.log(`Player ${fromPlayerId}:`, message);
    if (window.pokerGameInstance) {
        window.pokerGameInstance.addMessage({
            type: 'player',
            fromPlayerId: fromPlayerId,
            message: message,
            timestamp: new Date()
        });
    }
}

// ═══════════════════════════════════════════════════════════════════
// THIN CLIENT DATA HELPERS
// ═══════════════════════════════════════════════════════════════════

// Simplified helper functions focusing on data retrieval only
function getCurrentPlayerSeat() {
    return window.pokerGameInstance?.myPlayer?.seat_number || currentPlayerSeat || 1;
}

function getCurrentBet() {
    return window.pokerGameInstance?.game?.current_bet || gameState?.current_bet || 0;
}

function getPlayerChips() {
    if (window.pokerGameInstance?.myPlayer) {
        const player = window.pokerGameInstance.myPlayer;
        return player.chips_end || player.chips_start || 0;
    }
    
    if (gameState?.aggrounds) {
        const player = gameState.aggrounds.find(p => p.seat === getCurrentPlayerSeat());
        return player?.chips || 0;
    }
    return 0;
}

