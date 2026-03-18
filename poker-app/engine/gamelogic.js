const {
    PlayerAction,
    GameState,
    GameStateBet,
    ServerUpdateLastAction,
    ServerRequestCall,
    ServerRequestCheck,
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
 * Find a bet object by seat number
 * @param {Array} bets - Array of GameStateBet objects
 * @param {number} seat - Seat number to find
 * @returns {GameStateBet|undefined} - The bet object for that seat, or undefined
 */
function getBetBySeat(bets, seat) {
    const seatNum = Number(seat);
    return bets.find(b => Number(b.seat) === seatNum);
}

/**
 * Update or add a bet for a specific seat
 * @param {Array} bets - Array of GameStateBet objects
 * @param {GameStateBet} newBet - The new bet object to set
 */
function setBetBySeat(bets, newBet) {
    const seatNum = Number(newBet.seat);
    const index = bets.findIndex(b => Number(b.seat) === seatNum);
    if (index !== -1) {
        bets[index] = newBet;
    } else {
        bets.push(newBet);
    }
}

/**
 * @param {GameState} gameState - Current state of the game
 * @returns {{communityCards: string[], deck: string[]}} - Updated community cards and deck after dealing
 */
function updateCommunityCards(gameState) {
    const {communityCards, deck} = pokerCards.dealCommunityCards(gameState.deck, gameState.community_cards, gameState.stage)
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
    // Get all seats that are still active (not folded, not all-in)
    const activeBets = gameState.bets.filter(b => !b.folded && !b.allin);
    const activeSeats = activeBets.map(b => b.seat).sort((a, b) => a - b);
    
    if (gameState.aggrounds > 0) {
        // Find the current hot seat position in active seats
        const currentIdx = activeSeats.indexOf(gameState.hot_seat);
        if (currentIdx === -1) {
            // Hot seat player folded/all-in, find next active
            const nextSeat = activeSeats.find(s => s > gameState.hot_seat) || activeSeats[0];
            gameState.hot_seat = nextSeat;
            return 1;
        }
        
        // Find next active seat that still needs to act
        let searchIdx = (currentIdx + 1) % activeSeats.length;
        let startIdx = searchIdx;
        
        while (true) {
            const seat = activeSeats[searchIdx];
            const bet = getBetBySeat(gameState.bets, seat);
            
            if (bet.bet_amount !== gameState.current_bet) {
                // This player needs to act
                gameState.hot_seat = seat;
                return 1;
            }
            
            searchIdx = (searchIdx + 1) % activeSeats.length;
            if (searchIdx === startIdx) {
                // Wrapped all the way around — everyone has matched the bet
                // This shouldn't happen if aggrounds > 0, but handle gracefully
                break;
            }
        }
        
        // No one left to act, proceed to next stage
        gameState.aggrounds = 0;
    }
    
    if (gameState.stage < 3) {
        gameState.stage += 1;
        
        // CRITICAL FIX: Reset current_bet to 0 for new betting round
        console.log(`Stage progression: stage ${gameState.stage - 1} -> ${gameState.stage}, resetting current_bet from ${gameState.current_bet} to 0`);
        gameState.current_bet = 0;
        
        // Reset aggrounds to number of active players for new betting round
        gameState.aggrounds = activeSeats.length;
        console.log(`New betting round: aggrounds set to ${gameState.aggrounds} (${activeSeats.length} active players)`);
        
        // First active player after dealer acts first
        const dealerSeat = gameState.dealer_seat;
        const nextSeat = activeSeats.find(s => s > dealerSeat) || activeSeats[0];
        gameState.hot_seat = nextSeat;
        console.log(`Hot seat for new round: ${nextSeat} (dealer: ${dealerSeat})`);
        return 0;
    } else {
        console.log('Game ending: reached final stage', gameState.stage);
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
    
    // Get the player's PREVIOUS bet BEFORE updating
    const previousBetObj = getBetBySeat(gameState.bets, newAction.seat);
    const previousBetAmount = previousBetObj?.bet_amount || 0;
    
    // If player folded or went all-in, reduce max_players
    if (newAction.allin || newAction.player_bet === -1){
        gameState.max_players -= 1;
    }

    // NO FOLD UPDATE POT & CURRENT BET
    if (newAction.player_bet !== -1){
        // Calculate additional chips going to pot
        const additionalToPot = newAction.player_bet - previousBetAmount;
        
        if (additionalToPot > 0) {
            gameState.pot += additionalToPot;
        }
        
        // Update current_bet only if player is raising above it
        if (newAction.player_bet > gameState.current_bet) {
            gameState.current_bet = newAction.player_bet;
        }
        
        // Update the player's bet in the bets array
        setBetBySeat(gameState.bets, new GameStateBet({
            seat: newAction.seat,
            bet_amount: newAction.player_bet,
            folded: false,
            allin: newAction.allin || false
        }));
    } else {
        // Fold - mark player as folded (keep their previous bet amount)
        setBetBySeat(gameState.bets, new GameStateBet({
            seat: newAction.seat,
            bet_amount: previousBetAmount,
            folded: true,
            allin: false
        }));
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
    console.log('getNextRequest called:', {
        hot_seat: gameState.hot_seat,
        current_bet: gameState.current_bet,
        bets: JSON.stringify(gameState.bets)
    });
    
    const hotSeatBet = getBetBySeat(gameState.bets, gameState.hot_seat);
    console.log('Found hot seat bet:', hotSeatBet);
    
    if (!hotSeatBet) {
        throw new Error(`Hot seat player not found in bets. hot_seat=${gameState.hot_seat}, bets=${JSON.stringify(gameState.bets)}`);
    }
    // Only throw if player is folded or all-in
    // DO NOT throw if bet_amount === current_bet - this happens when BB acts without a raise and can still check/raise
    if (hotSeatBet.folded || hotSeatBet.allin) {
        throw new Error('Hot seat player is folded or all-in');
    }
    // Ensure to_call is never negative (player may have matched/exceeded current bet)
    const toCall = Math.max(0, gameState.current_bet - hotSeatBet.bet_amount);
    // FIXED: Min raise calculation for after stage progression
    // When current_bet = 0 (after stage progression), min raise is just the big blind
    // When current_bet > 0, min raise is current_bet + big_blind (standard poker rules)
    let minRaise;
    if (gameState.current_bet === 0) {
        // New betting round after stage progression - min raise is the big blind
        minRaise = gameState.big_blind;
    } else {
        // Ongoing betting round - min raise is current_bet + big_blind
        minRaise = gameState.current_bet + gameState.big_blind;
    }
    
    if (toCall === 0) {
        return new ServerRequestCheck({
            game_id: gameState.game_id,
            seat: gameState.hot_seat,
            min_raise: minRaise
        });
    } else {
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