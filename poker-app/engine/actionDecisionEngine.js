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

/* Main thing to consider is GameState and PlayerAction structures.  
 * GameState
*/

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