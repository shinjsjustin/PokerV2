const { 
    PackageType,
    ServerRequestCheck,
    ServerRequestCall,
    ServerUpdateLastAction,
    ServerUpdateStageProgression,
    ServerUpdateGameEnd,
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
        socket.emit(PackageType.SERVER_REQUEST_CHECK, packet);
    }

    /**
     * Request player to call, raise, fold, or go all-in
     */
    requestCall(socket, { game_id, player_id, seat, min_raise, to_call }) {
        const packet = new ServerRequestCall({ game_id, player_id, seat, min_raise, to_call });
        socket.emit(PackageType.SERVER_REQUEST_CALL, packet);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Game State Updates - Broadcast to table
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Send full game state to all players at table
     */
    sendGameState(tableId, gameStateData) {
        const packet = new GameState(gameStateData);
        this.io.to(`table:${tableId}`).emit(PackageType.GAMESTATE, packet);
    }

    /**
     * Send full game state to a specific player
     */
    sendGameStateToPlayer(socket, gameStateData) {
        const packet = new GameState(gameStateData);
        socket.emit(PackageType.GAMESTATE, packet);
    }

    /**
     * Broadcast last player action to table
     */
    sendLastAction(tableId, { game_id, seat, bet_amount, allin, folded }) {
        const packet = new ServerUpdateLastAction({ game_id, seat, bet_amount, allin, folded });
        this.io.to(`table:${tableId}`).emit(PackageType.SERVER_UPDATE_LAST_ACTION, packet);
    }

    /**
     * Broadcast stage progression (flop, turn, river) to table
     */
    sendStageProgression(tableId, { game_id, stage, community_cards }) {
        const packet = new ServerUpdateStageProgression({ game_id, stage, community_cards });
        this.io.to(`table:${tableId}`).emit(PackageType.SERVER_UPDATE_STAGE_PROGRESSION, packet);
    }

    /**
     * Broadcast game end with winner info to table
     */
    sendGameEnd(tableId, { game_id, winner_seat, winning_hand, pot }) {
        const packet = new ServerUpdateGameEnd({ game_id, winner_seat, winning_hand, pot });
        this.io.to(`table:${tableId}`).emit(PackageType.SERVER_UPDATE_GAME_END, packet);
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
        socket.on(PackageType.REQUEST_GAME_STATE, (data) => {
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
