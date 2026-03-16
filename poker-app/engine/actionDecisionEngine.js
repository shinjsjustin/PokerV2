const {
    PackageType,
    ServerToPlayerMessage,
    ServerToTableMessage,
    PlayerToPlayerMessage,
    ServerRequestCheck,
    ServerRequestCall,
    PlayerAction,
    GameState,
    GameStateBet,
    ServerUpdateLastAction,
    ServerUpdateStageProgression,
    ServerUpdateGameEnd,
    createFromJSON
} = require('../datapacks/schema.js');

/**
 * Game Action Decision Engine
 * 
 * This module provides functions to determine the next course of action
 * in the poker game flow based on current game state and player actions.
 * 
 * All functions return boolean values for easy route decision making.
 */

/**
 * Template function for game flow decisions
 * 
 * @param {Object} gameData - Current game state data
 * @param {Object} playerAction - Player action data (optional)
 * @param {Object} tableData - Table data (optional)
 * @returns {boolean} - True if action should proceed, false otherwise
 * 
 * Example usage in routes:
 * if (shouldProgressToNextStage(gameData, playerAction)) {
 *   // Progress to next stage logic
 * }
 */
function shouldProgressToNextStage() {
}

function proceed(gameState){
    let aggroround = gameState.aggrounds;
    if(aggroround === 0){
        
    }
}
// Params: gameState is GameState, newAction is PlayerAction
function updateGameState(gameState, newAction){
    const bet = newAction.player_bet;
    let action;
    if(bet < newAction.current_bet){
        throw new Error('Invalid action: bet is less than current bet');
    }
    if ( newAction.player_bet === -1){
        action = 'fold';
        // TODO: Handle all in logic
    } else {
        gameState.pot += bet;
        gameState.bets[newAction.player_id] = bet;
        gameState.current_bet = bet;

    }

    
}

// Export the template function and any helper utilities you might need
module.exports = {
    shouldProgressToNextStage,
    
    // You can add more decision functions following the same pattern:
    // shouldEndGame,
    // shouldRequestPlayerAction, 
    // shouldUpdatePot,
    // shouldDealCommunityCards,
    // etc.
};