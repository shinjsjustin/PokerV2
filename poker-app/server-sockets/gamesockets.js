const { 
    PackageType,
    ServerRequestCheck,
    ServerRequestCall,
    ServerUpdateLastAction,
    ServerUpdateStageProgression,
    ServerUpdateGameEnd,
    ServerGameEndedReturnToTable,
    GameState,
    GameStateBet,
    ErrorMessage,
    ActionResponse,
    RequestGameState
} = require('../datapacks/schema');

/**
 * GameSocketManager - Socket.IO wrapper for game-related server-to-client communications
 */
class GameSocketManager {
    constructor() {
        this.io = null;
    }

    init(io) {
        this.io = io;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Server Requests - Prompt player for action
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Request player to check, raise, or go all-in (no bet to call)
     */
    requestCheck(socket, { game_id, player_id, seat, min_raise }) {
        const packet = new ServerRequestCheck({ game_id, player_id, seat, min_raise });
        console.log(`[SOCKET:game] REQUEST_CHECK → player ${player_id} seat ${seat} (min_raise=${min_raise})`);
        socket.emit(PackageType.SERVER_REQUEST_CHECK, packet);
    }

    /**
     * Request player to call, raise, fold, or go all-in
     */
    requestCall(socket, { game_id, player_id, seat, min_raise, to_call }) {
        const packet = new ServerRequestCall({ game_id, player_id, seat, min_raise, to_call });
        console.log(`[SOCKET:game] REQUEST_CALL → player ${player_id} seat ${seat} (to_call=${to_call} min_raise=${min_raise})`);
        socket.emit(PackageType.SERVER_REQUEST_CALL, packet);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Game State Updates - Broadcast to table
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Send full game state to all players at table
     */
    sendGameState(tableId, gameStateData) {
        const packet = { type: PackageType.GAMESTATE, ...gameStateData };
        console.log(`[SOCKET:game] GAMESTATE → table ${tableId} | game=${packet.game_id} stage=${packet.stage} pot=${packet.pot} activePlayer=${packet.activePlayerId} players=${packet.players?.length || 0}`);
        this.io.to(`table:${tableId}`).emit(PackageType.GAMESTATE, packet);
    }

    /**
     * Send full game state to a specific player
     */
    sendGameStateToPlayer(socket, gameStateData) {
        const packet = { type: PackageType.GAMESTATE, ...gameStateData };
        console.log(`[SOCKET:game] GAMESTATE → player socket ${socket.id} | game=${packet.game_id}`);
        socket.emit(PackageType.GAMESTATE, packet);
    }

    /**
     * Broadcast last player action to table
     */
    sendLastAction(tableId, { game_id, seat, bet_amount, allin, folded }) {
        const packet = new ServerUpdateLastAction({ game_id, seat, bet_amount, allin, folded });
        console.log(`[SOCKET:game] LAST_ACTION → table ${tableId} | seat=${seat} bet=${bet_amount} allin=${allin} folded=${folded}`);
        this.io.to(`table:${tableId}`).emit(PackageType.SERVER_UPDATE_LAST_ACTION, packet);
    }

    /**
     * Broadcast stage progression (flop, turn, river) to table
     */
    sendStageProgression(tableId, { game_id, stage, community_cards }) {
        const packet = new ServerUpdateStageProgression({ game_id, stage, community_cards });
        console.log(`[SOCKET:game] STAGE_PROGRESSION → table ${tableId} | game=${game_id} stage=${stage} cards=${community_cards?.length || 0}`);
        this.io.to(`table:${tableId}`).emit(PackageType.SERVER_UPDATE_STAGE_PROGRESSION, packet);
    }

    /**
     * Broadcast game end with winner info to table
     */
    sendGameEnd(tableId, { game_id, winner_seat, winning_hand, pot }) {
        const packet = new ServerUpdateGameEnd({ game_id, winner_seat, winning_hand, pot });
        console.log(`[SOCKET:game] GAME_END → table ${tableId} | winner_seat=${winner_seat} hand='${winning_hand}' pot=${pot}`);
        this.io.to(`table:${tableId}`).emit(PackageType.SERVER_UPDATE_GAME_END, packet);
    }

    /**
     * Notify players game ended and redirect to table page for new game
     */
    sendGameEndedReturnToTable(tableId, { winners, pot, message }) {
        const packet = new ServerGameEndedReturnToTable({ table_id: tableId, winners, pot, message });
        console.log(`[SOCKET:game] GAME_ENDED_RETURN → table ${tableId} | pot=${pot} winners=${winners?.length || 0}`);
        this.io.to(`table:${tableId}`).emit(PackageType.SERVER_GAME_ENDED_RETURN_TO_TABLE, packet);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Bet Updates
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Send bet state for a specific seat to table
     */
    sendBetUpdate(tableId, { seat, bet_amount, allin, folded }) {
        const packet = new GameStateBet({ seat, bet_amount, allin, folded });
        this.io.to(`table:${tableId}`).emit(PackageType.GAMESTATE_BET, packet);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Card Dealing
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Deal hole cards to a specific player (private - only they see their cards)
     * @param {Socket} socket - Player's socket
     * @param {Object} data - { game_id, player_id, hole_cards, seat_number }
     */
    dealHoleCardsToPlayer(socket, { game_id, player_id, hole_cards, seat_number }) {
        socket.emit(PackageType.DEAL_HOLE_CARDS, {
            type: PackageType.DEAL_HOLE_CARDS,
            game_id,
            player_id,
            hole_cards,
            seat_number,
            timestamp: new Date()
        });
    }

    /**
     * Deal hole cards to all players at a table (each player gets only their cards)
     * @param {Object} tableSocketManager - Reference to table socket manager for getting player sockets
     * @param {number} game_id - Game ID
     * @param {Array} players - Array of { player_id, seat_number, hole_cards }
     */
    dealHoleCardsToAllPlayers(tableSocketManager, game_id, players) {
        for (const player of players) {
            const socket = tableSocketManager.getSocket(player.player_id);
            if (socket) {
                this.dealHoleCardsToPlayer(socket, {
                    game_id,
                    player_id: player.player_id,
                    hole_cards: player.hole_cards,
                    seat_number: player.seat_number
                });
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Raw Emit - For custom game events
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Emit raw event to table
     */
    emitToTable(tableId, eventType, data) {
        this.io.to(`table:${tableId}`).emit(eventType, data);
    }

    /**
     * Emit raw event to specific socket
     */
    emitToSocket(socket, eventType, data) {
        socket.emit(eventType, data);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Error Handling & Communication
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Send error message to specific player
     */
    sendError(socket, message, game_id = null, player_id = null) {
        const packet = new ErrorMessage({ message, game_id, player_id });
        socket.emit(PackageType.ERROR_MESSAGE, packet);
    }

    /**
     * Send action response to specific player
     */
    sendActionResponse(socket, success, error = null, game_id = null, player_id = null) {
        const packet = new ActionResponse({ success, error, game_id, player_id });
        socket.emit(PackageType.ACTION_RESPONSE, packet);
    }

    /**
     * Handle incoming game state requests
     */
    setupListener(socket, onGameStateRequest) {
        console.log(`[SOCKET:game] Listening for REQUEST_GAME_STATE on socket ${socket.id}`);
        socket.on(PackageType.REQUEST_GAME_STATE, (data) => {
            console.log(`[SOCKET:game] REQUEST_GAME_STATE received:`, data);
            if (onGameStateRequest && typeof onGameStateRequest === 'function') {
                onGameStateRequest(data, socket);
            }
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Listeners ..?
    // ═══════════════════════════════════════════════════════════════════


}

// Export singleton instance
module.exports = new GameSocketManager();
