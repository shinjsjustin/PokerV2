const {
    PlayerAction,
    GameState,
    GameStateBet,
    ServerUpdateLastAction,
} = require('../datapacks/schema.js');

const pokerCards = require('./hands.js');

/* Computation, not for execution.
 *
 * Main thing to consider is GameState and PlayerAction structures.  
 * GameState.max_players - (int) number of active players in hand (not folded or all-in)
 * GameState.aggrounds - (int) number of rounds needed to complete betting
 * GameState.bets - (array of GameStateBet)
 * GameState.community_cards - (array of cards: "2H", "TD", etc.)
 * GameState.hot_seat - (int) seat number of player whose turn it is
 * GameState.dealer_seat - (int) seat for dealer, used to reset hot seat after stage progression
 * GameState.stage - (int) 0 = pre-flop, 1 = flop, 2 = turn, 3 = river, 4 = game over
 * GameState.pot - (int) total chips in pot
 * GameState.current_bet - (int) current bet amount that players must call to stay in hand
 * GameState.deck - (array of cards) remaining deck, used for dealing community cards and hole cards
 * 
 * PlayerAction.player_bet - (int) amount player is betting, -1 if fold
 * PlayerAction.seat - (int) seat number of player taking action
 * PlayerAction.game_id - (int) game id for reference
 * PlayerAction.current_bet - (int) current bet amount that players must call to stay in hand
 * PlayerAction.allin - (boolean) whether player is going all-in with this action
*/


// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════
/**
 * @param {GameState} gameState - Current state of the game
 * @returns {{communityCards: string[], deck: string[]}} - Updated community cards and deck after dealing
 */
function updateCommunityCards(gameState) {
    const {communityCards, deck} = pokerCards.dealCommunityCards(gameState.deck, gameState.communityCards, gameState.stage)
    gameState.community_cards = communityCards;
    gameState.deck = deck;
    return {communityCards, deck};
}

/**
 * Push hot seat, aggrounds, stage assuming everything else is resolved
 * @param {GameState} gameState 
 * @returns {number} - Whether the game should continue (1 = continue, 0 = stage progression, -1 = game over)
 */
function proceed(gameState) {
    if (gameState.aggrounds > 0) {
        // Find next active seat that still needs to act
        let nextSeat = (gameState.hot_seat + 1) % gameState.max_players;
        while (
            gameState.bets[nextSeat].folded ||
            gameState.bets[nextSeat].allin ||
            gameState.bets[nextSeat].bet_amount === gameState.current_bet
        ) {
            nextSeat = (nextSeat + 1) % gameState.max_players;
            if (nextSeat === (gameState.hot_seat + 1) % gameState.max_players) {
                // Wrapped all the way around — no one left to act
                throw new Error('No active players left to act, but aggrounds > 0');
            }
        }
        gameState.hot_seat = nextSeat;
        return 1;
    } else if (gameState.stage < 4) {
        gameState.stage += 1;
        // Scan forward from dealer to find first active player
        let seat = (gameState.dealer_seat + 1) % gameState.max_players;
        while (gameState.bets[seat].folded || gameState.bets[seat].allin) {
            seat = (seat + 1) % gameState.max_players;
        }
        gameState.hot_seat = seat;
        return 0;
    } else {
        return -1;
    }
}

// ═══════════════════════════════════════════════════════════════════
// Use these 
// ═══════════════════════════════════════════════════════════════════
/**
 * possible update: hot_seat, stage, aggrounds, pot, current_bet, bets, community_cards, deck, max_players
 * @param {GameState} gameState - Current state of the game
 * @param {PlayerAction} newAction - Action taken by player
 * @returns {{gameState: GameState, proceedResult: number, lastAction: ServerUpdateLastAction}} - Updated game state and whether the game should continue (1 = continue, 0 = stage progression, -1 = game over)
*/
function updateGameStateWithNewBet(gameState, newAction) {
    if(gameState.hot_seat !== newAction.seat){
        throw new Error('Action taken by player out of turn');
    }
    const bet = new GameStateBet({
        seat: newAction.seat,
        bet_amount: newAction.player_bet,
        allin: newAction.allin,
        folded: newAction.player_bet === -1
    });
    gameState.bets[newAction.seat] = bet;
    
    // If player folded or went all-in, reduce max_players
    if (newAction.allin || newAction.folded){
        gameState.max_players -= 1;
    }

    // NO FOLD UPDATE POT & CURRENT BET
    if (newAction.player_bet !== -1){
        gameState.pot += newAction.player_bet;
        gameState.current_bet = newAction.player_bet;
    } 
    // RAISE, ALLIN - reset aggrounds 
    // CALL, CHECK, FOLD - decrement aggrounds
    if (newAction.player_bet > newAction.current_bet) {
        gameState.aggrounds = gameState.max_players - 1; // reset aggrounds if raise
    } else{
        gameState.aggrounds -= 1;
    }
    switch (proceed(gameState)){
        case 1:
            // continue regular betting round
            return {gameState, proceedResult: 1, lastAction: new ServerUpdateLastAction({
                game_id: gameState.game_id,
                seat: newAction.seat,
                bet_amount: newAction.player_bet,
                allin: newAction.allin,
                folded: newAction.player_bet === -1
            })};
        case 0:
            updateCommunityCards(gameState);
            return {gameState, proceedResult: 0, lastAction: new ServerUpdateLastAction({
                game_id: gameState.game_id,
                seat: newAction.seat,
                bet_amount: newAction.player_bet,
                allin: newAction.allin,
                folded: newAction.player_bet === -1
            })};
        case -1:
            // game over - determine winner, reset game state, etc. (not implemented here)
            return {gameState, proceedResult: -1, lastAction: new ServerUpdateLastAction({
                game_id: gameState.game_id,
                seat: newAction.seat,
                bet_amount: newAction.player_bet,
                allin: newAction.allin,
                folded: newAction.player_bet === -1
            })};
    }
}


/** Take a gamestate and determine who plays next and what request they should receive
 *  @param {GameState} gameState - Current state of the game
 * @returns {ServerRequestCall|ServerRequestCheck} - Request object for next player action
 */
function getNextRequest(gameState) {
    const hotSeatBet = gameState.bets[gameState.hot_seat];
    if (hotSeatBet.folded || hotSeatBet.allin || hotSeatBet.bet_amount === gameState.current_bet) {
        throw new Error('Hot seat player has already acted or is all-in');
    }
    const toCall = gameState.current_bet - hotSeatBet.bet_amount;
    let minRaise = gameState.current_bet * 2 - hotSeatBet.bet_amount;
    if (toCall === 0) {
        return new ServerRequestCheck({
            game_id: gameState.game_id,
            seat: gameState.hot_seat,
            current_bet: gameState.current_bet
        });
    }else {
        return new ServerRequestCall({
            game_id: gameState.game_id,
            seat: gameState.hot_seat,
            min_raise: minRaise,
            to_call: toCall
        });
    }
}

function determineWinner(players, communityCards) {
    return pokerCards.determineWinners(players, communityCards);
}

// Export the template function and any helper utilities you might need
module.exports = {
    updateGameStateWithNewBet,
    getNextRequest,
    determineWinner
};