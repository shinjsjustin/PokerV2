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
 * Push hot seat, aggrounds, stage assuming everything else is resolved.
 * Returns:
 *   1  = continue current betting round (advance hot_seat to next player)
 *   0  = stage progression (flop/turn/river dealt, new betting round begins)
 *  -1  = game over (river betting finished or only one player left)
 *
 * FIX: replaced the flawed bet_amount !== current_bet loop with a simple
 *      "advance to next active seat" approach.  aggrounds is the authoritative
 *      counter for when a round ends — we no longer use bet comparisons to
 *      determine who acts next.
 *
 * FIX: bets are reset to bet_amount = 0 at every stage progression so that
 *      per-round calculations (toCall, additionalToPot) stay correct.
 */
function proceed(gameState) {
    const TAG = '[LOGIC:proceed]';

    // Non-folded = still alive in the hand (active OR all-in)
    const nonFoldedBets = gameState.bets.filter(b => !b.folded);
    // Active = can still make decisions (not folded, not all-in)
    const activeBets    = nonFoldedBets.filter(b => !b.allin);
    const activeSeats   = activeBets.map(b => b.seat).sort((a, b) => a - b);

    console.log(`${TAG} aggrounds=${gameState.aggrounds} stage=${gameState.stage} hot_seat=${gameState.hot_seat} nonFolded=${nonFoldedBets.length} active=${activeBets.length} seats=[${activeSeats.join(',')}]`);

    // FIX: if only one (or zero) non-folded players remain, the hand is over —
    //      the last player wins without needing further action or stage progression.
    if (nonFoldedBets.length <= 1) {
        console.log(`${TAG} Only ${nonFoldedBets.length} non-folded player(s) — game over (last player wins)`);
        return -1;
    }

    if (activeBets.length === 0) {
        // Everyone remaining has gone all-in — no more betting possible, go to showdown
        console.log(`${TAG} All remaining players are all-in — skipping to showdown`);
        return -1;
    }

    if (gameState.aggrounds > 0) {
        // Still players left to act — advance hot_seat to the next active seat
        const currentIdx = activeSeats.indexOf(gameState.hot_seat);
        const nextIdx = currentIdx === -1
            ? 0
            : (currentIdx + 1) % activeSeats.length;
        const prevSeat = gameState.hot_seat;
        gameState.hot_seat = activeSeats[nextIdx];
        console.log(`${TAG} Round continuing — hot_seat ${prevSeat} → ${gameState.hot_seat}`);
        return 1;
    }

    // aggrounds === 0 — the current betting round is complete
    if (gameState.stage < 3) {
        const prevStage = gameState.stage;
        gameState.stage += 1;
        gameState.current_bet = 0;

        // FIX: Reset every active player's bet_amount to 0 so that toCall and
        //      additionalToPot are computed correctly within the new round.
        //      Folded / all-in players retain their cumulative amounts for
        //      side-pot tracking purposes.
        gameState.bets = gameState.bets.map(b =>
            (b.folded || b.allin)
                ? b
                : new GameStateBet({ seat: b.seat, bet_amount: 0, folded: false, allin: false })
        );

        gameState.aggrounds = activeBets.length;

        // First active player after the dealer acts first in the new round
        const dealerSeat = gameState.dealer_seat;
        const nextSeat = activeSeats.find(s => s > dealerSeat) || activeSeats[0];
        gameState.hot_seat = nextSeat;

        console.log(`${TAG} STAGE PROGRESSION stage=${prevStage}→${gameState.stage} current_bet reset to 0 aggrounds=${gameState.aggrounds} hot_seat=${gameState.hot_seat} (dealer=${dealerSeat})`);
        return 0;
    } else {
        console.log(`${TAG} GAME OVER — stage=${gameState.stage} (river betting complete)`);
        return -1;
    }
}

// ═══════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════

/**
 * Apply a player action and advance game state.
 *
 * Updates: hot_seat, stage, aggrounds, pot, current_bet, bets,
 *          community_cards, deck, max_players
 *
 * @param {GameState}    gameState - Current state of the game
 * @param {PlayerAction} newAction - Action taken by the player
 * @returns {{ gameState, proceedResult, lastAction }}
 *   proceedResult:  1 = continue,  0 = stage progressed,  -1 = game over
 */
function updateGameStateWithNewBet(gameState, newAction) {
    const TAG = '[LOGIC:updateBet]';

    if (gameState.hot_seat !== newAction.seat) {
        throw new Error(`Out-of-turn action: hot_seat=${gameState.hot_seat} but action from seat=${newAction.seat}`);
    }

    const previousBetObj    = getBetBySeat(gameState.bets, newAction.seat);
    const previousBetAmount = previousBetObj?.bet_amount || 0;

    // FIX: Capture BEFORE any mutation so isRaise detection is correct below.
    const originalCurrentBet = gameState.current_bet;

    console.log(`${TAG} seat=${newAction.seat} player_bet=${newAction.player_bet} allin=${newAction.allin} current_bet=${originalCurrentBet} previousBet=${previousBetAmount} pot_before=${gameState.pot}`);

    // ── Reduce active player count for folds and all-ins ──────────
    if (newAction.allin || newAction.player_bet === -1) {
        gameState.max_players -= 1;
        console.log(`${TAG} Player went all-in or folded — max_players now ${gameState.max_players}`);
    }

    // ── Update pot, current_bet, and bets array ───────────────────
    if (newAction.player_bet !== -1) {
        const additionalToPot = newAction.player_bet - previousBetAmount;
        if (additionalToPot > 0) {
            gameState.pot += additionalToPot;
            console.log(`${TAG} +${additionalToPot} chips to pot → pot=${gameState.pot}`);
        }

        if (newAction.player_bet > originalCurrentBet) {
            console.log(`${TAG} Raise/bet: current_bet ${originalCurrentBet} → ${newAction.player_bet}`);
            gameState.current_bet = newAction.player_bet;
        }

        setBetBySeat(gameState.bets, new GameStateBet({
            seat:       newAction.seat,
            bet_amount: newAction.player_bet,
            folded:     false,
            allin:      newAction.allin || false
        }));
    } else {
        // Fold — keep previous bet_amount in record, mark folded
        setBetBySeat(gameState.bets, new GameStateBet({
            seat:       newAction.seat,
            bet_amount: previousBetAmount,
            folded:     true,
            allin:      false
        }));
        console.log(`${TAG} seat=${newAction.seat} folded`);
    }

    // ── Update aggrounds ──────────────────────────────────────────
    // FIX: Compare against originalCurrentBet, not the (already-mutated) gameState.current_bet.
    //   Raise (non-allin): raiser stays active → aggrounds = max_players - 1
    //   Raise (all-in):    raiser exits active pool → aggrounds = max_players
    //   Call/check/fold:   decrement aggrounds
    const isRaise = newAction.player_bet > originalCurrentBet;

    if (isRaise && !newAction.allin) {
        gameState.aggrounds = gameState.max_players - 1;
        console.log(`${TAG} Raise detected — aggrounds reset to ${gameState.aggrounds}`);
    } else if (isRaise && newAction.allin) {
        gameState.aggrounds = gameState.max_players;
        console.log(`${TAG} All-in raise detected — aggrounds reset to ${gameState.aggrounds}`);
    } else {
        gameState.aggrounds -= 1;
        console.log(`${TAG} Call/check/fold — aggrounds decremented to ${gameState.aggrounds}`);
    }

    // ── Proceed ───────────────────────────────────────────────────
    const buildLastAction = () => new ServerUpdateLastAction({
        game_id:    gameState.game_id,
        seat:       newAction.seat,
        bet_amount: newAction.player_bet,
        allin:      newAction.allin,
        folded:     newAction.player_bet === -1
    });

    const proceedResult = proceed(gameState);
    console.log(`${TAG} proceed() returned ${proceedResult} (1=continue, 0=stage advanced, -1=game over)`);

    if (proceedResult === 0) {
        updateCommunityCards(gameState);
        console.log(`${TAG} Community cards after deal: [${gameState.community_cards.join(', ')}]`);
    }

    return { gameState, proceedResult, lastAction: buildLastAction() };
}


/**
 * Determine what action request to send to the current hot-seat player.
 * @param {GameState} gameState
 * @returns {ServerRequestCall|ServerRequestCheck}
 */
function getNextRequest(gameState) {
    const TAG = '[LOGIC:getNextRequest]';
    console.log(`${TAG} hot_seat=${gameState.hot_seat} current_bet=${gameState.current_bet} big_blind=${gameState.big_blind}`);

    const hotSeatBet = getBetBySeat(gameState.bets, gameState.hot_seat);
    if (!hotSeatBet) {
        throw new Error(`[LOGIC] Hot-seat player not in bets array. hot_seat=${gameState.hot_seat} bets=${JSON.stringify(gameState.bets)}`);
    }
    if (hotSeatBet.folded || hotSeatBet.allin) {
        throw new Error(`[LOGIC] Hot-seat player is folded or all-in — cannot request action. seat=${gameState.hot_seat}`);
    }

    // toCall: how many MORE chips needed to match the current bet this round
    const toCall = Math.max(0, gameState.current_bet - hotSeatBet.bet_amount);

    // minRaise: standard poker rules
    //   new round (current_bet = 0) → big blind is the minimum opening bet
    //   ongoing round              → current_bet + big_blind
    const minRaise = gameState.current_bet === 0
        ? gameState.big_blind
        : gameState.current_bet + gameState.big_blind;

    console.log(`${TAG} seat=${gameState.hot_seat} bet_amount=${hotSeatBet.bet_amount} toCall=${toCall} minRaise=${minRaise}`);

    if (toCall === 0) {
        console.log(`${TAG} → SERVER_REQUEST_CHECK`);
        return new ServerRequestCheck({
            game_id:   gameState.game_id,
            seat:      gameState.hot_seat,
            min_raise: minRaise
        });
    } else {
        console.log(`${TAG} → SERVER_REQUEST_CALL (to_call=${toCall})`);
        return new ServerRequestCall({
            game_id:   gameState.game_id,
            seat:      gameState.hot_seat,
            min_raise: minRaise,
            to_call:   toCall
        });
    }
}

function determineWinner(players, communityCards) {
    return pokerCards.determineWinners(players, communityCards);
}

/**
 * Fast-forward community card dealing for all-in showdowns.
 * Advances `gameState.stage` and deals cards until 5 community cards exist.
 * This is needed when all remaining players are all-in before the river.
 *
 * @param {GameState} gameState - mutated in place
 */
function dealAllRemainingCommunityCards(gameState) {
    while (gameState.community_cards.length < 5 && gameState.stage < 4) {
        gameState.stage += 1;
        updateCommunityCards(gameState);
    }
}

// Export the template function and any helper utilities you might need
module.exports = {
    updateGameStateWithNewBet,
    getNextRequest,
    determineWinner,
    dealAllRemainingCommunityCards
};