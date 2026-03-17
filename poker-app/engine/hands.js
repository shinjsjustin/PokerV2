const Hand = require('pokersolver').Hand;

// ─────────────────────────────────────────
// POKER GAME LOGIC — Using pokersolver
// ─────────────────────────────────────────

class PokerCards {
    constructor() {
        // Standard 52-card deck
        this.suits = ['h', 'd', 'c', 's']; // hearts, diamonds, clubs, spades
        this.ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
    }

    // ─────────────────────────────────────────
    // DECK MANAGEMENT
    // ─────────────────────────────────────────

    /**
     * Create a fresh shuffled deck
     * @returns {string[]} Array of card strings in pokersolver format (e.g., "Ah", "Kd", "Qs")
     */
    createShuffledDeck() {
        const deck = [];
        
        // Create all 52 cards
        for (const suit of this.suits) {
            for (const rank of this.ranks) {
                deck.push(rank + suit);
            }
        }

        // Fisher-Yates shuffle
        for (let i = deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [deck[i], deck[j]] = [deck[j], deck[i]];
        }

        return deck;
    }

    /**
     * Deal cards from deck
     * @param {string[]} deck - The deck to deal from 
     * @param {number} numCards - Number of cards to deal
     * @returns {Object} { cards: string[], remainingDeck: string[] }
     */
    dealCards(deck, numCards) {
        if (deck.length < numCards) {
            throw new Error('Not enough cards in deck');
        }

        const cards = deck.slice(0, numCards);
        const remainingDeck = deck.slice(numCards);

        return { cards, remainingDeck };
    }

    // ─────────────────────────────────────────
    // GAME INITIALIZATION
    // ─────────────────────────────────────────

    /**
     * Deal initial cards for Texas Hold'em
     * @param {Array} players - Array of player objects with player_id
     * @returns {Object} Game state with hole cards and deck
     */
    dealHoldemGame(players) {
        if (players.length < 2 || players.length > 9) {
            throw new Error('Invalid number of players for Hold\'em (2-9)');
        }

        const deck = this.createShuffledDeck();
        let remainingDeck = [...deck];
        const playerCards = {};

        // Deal 2 cards to each player
        for (const player of players) {
            const { cards, remainingDeck: newDeck } = this.dealCards(remainingDeck, 2);
            playerCards[player.player_id] = cards;
            remainingDeck = newDeck;
        }

        return {
            playerCards,
            deck: remainingDeck,
            communityCards: []
        };
    }

    /**
     * Deal community cards for a stage
     * @param {string[]} deck - Current deck
     * @param {string[]} communityCards - Current community cards
     * @param {int} stage - 'flop', 'turn', or 'river'
     * @returns {Object} { communityCards: string[], deck: string[] }
     */
    dealCommunityCards(deck, communityCards, stage) {
        let numCards = 0;
        
        switch (stage) {
            case 1:
                if (communityCards.length !== 0) {
                    throw new Error('Flop already dealt');
                }
                numCards = 3;
                break;
            case 2:
                if (communityCards.length !== 3) {
                    throw new Error('Must deal flop before turn');
                }
                numCards = 1;
                break;
            case 3:
                if (communityCards.length !== 4) {
                    throw new Error('Must deal turn before river');
                }
                numCards = 1;
                break;
            default:
                throw new Error('Invalid stage for community cards');
        }

        // Burn one card, then deal
        const burnCard = deck[0];
        const deckAfterBurn = deck.slice(1);
        
        const { cards, remainingDeck } = this.dealCards(deckAfterBurn, numCards);
        
        return {
            communityCards: [...communityCards, ...cards],
            deck: remainingDeck
        };
    }

    // ─────────────────────────────────────────
    // HAND EVALUATION & WINNERS
    // ─────────────────────────────────────────

    /**
     * Evaluate a player's best hand using pokersolver
     * @param {string[]} holeCards - Player's 2 hole cards
     * @param {string[]} communityCards - Community cards on board
     * @returns {Object} Hand evaluation result from pokersolver
     */
    evaluateHand(holeCards, communityCards) {
        if (!holeCards || holeCards.length !== 2) {
            throw new Error('Player must have exactly 2 hole cards');
        }

        if (!communityCards || communityCards.length < 3) {
            throw new Error('Must have at least 3 community cards to evaluate');
        }

        // Combine hole cards and community cards
        const allCards = [...holeCards, ...communityCards];
        
        // Use pokersolver to find best hand
        const hand = Hand.solve(allCards);
        
        return {
            hand: hand,
            rank: hand.rank,
            name: hand.name,
            description: hand.descr,
            cards: hand.cards.map(card => card.toString()),
            qualifiesHigh: hand.qualifiesHigh,
            qualifiesLow: hand.qualifiesLow
        };
    }

    /**
     * Determine winners and split pots
     * @param {Array} players - Array of player objects with hole_cards and other info
     * @param {string[]} communityCards - Community cards 
     * @returns {Array} Array of winner information with pot shares
     */
    determineWinners(players, communityCards) {
        if (!communityCards || communityCards.length < 5) {
            throw new Error('Cannot determine winners without all 5 community cards');
        }

        // Filter out folded players
        const activePlayers = players.filter(player => !player.is_folded);
        
        if (activePlayers.length === 0) {
            throw new Error('No active players to evaluate');
        }

        if (activePlayers.length === 1) {
            // Single player wins by default
            return [{
                player_id: activePlayers[0].player_id,
                username: activePlayers[0].username,
                hand: null,
                share: 1.0,
                winType: 'uncontested'
            }];
        }

        // Evaluate all active player hands
        const playerHands = activePlayers.map(player => {
            let holeCards = player.hole_cards;
            
            // Parse JSON if it's a string
            if (typeof holeCards === 'string') {
                try {
                    holeCards = JSON.parse(holeCards);
                } catch (e) {
                    console.error('Failed to parse hole cards for player', player.player_id);
                    holeCards = [];
                }
            }

            const evaluation = this.evaluateHand(holeCards, communityCards);
            
            return {
                player_id: player.player_id,
                username: player.username,
                hand: evaluation.hand,
                evaluation: evaluation,
                eligible_for_pot: true
            };
        });

        // Use pokersolver to determine winners
        const hands = playerHands.map(p => p.hand);
        const winners = Hand.winners(hands);
        
        // Find which players have winning hands
        const winningPlayers = playerHands.filter(player => 
            winners.some(winningHand => winningHand === player.hand)
        );

        // Calculate pot share for each winner
        const share = 1.0 / winningPlayers.length;
        
        return winningPlayers.map(player => ({
            player_id: player.player_id,
            username: player.username,
            hand: player.evaluation,
            share: share,
            winType: winningPlayers.length > 1 ? 'split' : 'winner'
        }));
    }

    /**
     * Distribute pot among winners
     * @param {number} totalPot - Total pot amount
     * @param {Array} winners - Winner information from determineWinners()
     * @returns {Array} Array of { player_id, amount } for each winner
     */
    distributePot(totalPot, winners) {
        const distributions = [];
        let remainingPot = totalPot;

        for (let i = 0; i < winners.length; i++) {
            const winner = winners[i];
            let amount;
            
            if (i === winners.length - 1) {
                // Last winner gets any remaining chips (handles rounding)
                amount = remainingPot;
            } else {
                amount = Math.floor(totalPot * winner.share);
                remainingPot -= amount;
            }

            distributions.push({
                player_id: winner.player_id,
                username: winner.username,
                amount: amount,
                hand: winner.hand,
                winType: winner.winType
            });
        }

        return distributions;
    }

    // ─────────────────────────────────────────
    // SIDE POT CALCULATIONS (for all-in scenarios)
    // ─────────────────────────────────────────

    /**
     * Calculate side pots when players are all-in with different amounts
     * @param {Array} players - Array of player objects with current_bet amounts
     * @param {number} totalPot - Current total pot
     * @returns {Array} Array of side pot objects
     */
    calculateSidePots(players, totalPot) {
        const activePlayers = players.filter(p => !p.is_folded);
        
        if (activePlayers.length <= 1) {
            return [{ amount: totalPot, eligiblePlayers: activePlayers }];
        }

        // Sort players by their total contribution (current_bet)
        const sortedPlayers = [...activePlayers].sort((a, b) => a.current_bet - b.current_bet);
        
        const sidePots = [];
        let previousBet = 0;

        for (let i = 0; i < sortedPlayers.length; i++) {
            const currentBet = sortedPlayers[i].current_bet;
            const betDifference = currentBet - previousBet;
            
            if (betDifference > 0) {
                const eligiblePlayers = sortedPlayers.slice(i);
                const potSize = betDifference * eligiblePlayers.length;
                
                sidePots.push({
                    amount: potSize,
                    eligiblePlayers: eligiblePlayers,
                    level: i + 1
                });
            }
            
            previousBet = currentBet;
        }

        return sidePots;
    }

    // ─────────────────────────────────────────
    // UTILITY FUNCTIONS
    // ─────────────────────────────────────────

    /**
     * Convert card from pokersolver format to display format
     * @param {string} card - Card in pokersolver format (e.g., "Ah")
     * @returns {Object} { rank, suit, display }
     */
    formatCard(card) {
        if (!card || card.length !== 2) {
            return { rank: '?', suit: '?', display: '??' };
        }

        const rank = card[0];
        const suit = card[1];
        
        const suitSymbols = {
            'h': '♥',
            'd': '♦',
            'c': '♣',
            's': '♠'
        };

        const rankNames = {
            'T': '10',
            'J': 'Jack',
            'Q': 'Queen', 
            'K': 'King',
            'A': 'Ace'
        };

        return {
            rank: rank,
            suit: suit,
            display: (rankNames[rank] || rank) + suitSymbols[suit],
            symbol: rank + suitSymbols[suit]
        };
    }

    /**
     * Validate card format
     * @param {string} card - Card to validate
     * @returns {boolean} True if valid pokersolver card format
     */
    isValidCard(card) {
        if (!card || typeof card !== 'string' || card.length !== 2) {
            return false;
        }

        const rank = card[0];
        const suit = card[1];

        return this.ranks.includes(rank) && this.suits.includes(suit);
    }

    /**
     * Get hand strength description for display
     * @param {Object} handEvaluation - Result from evaluateHand()
     * @returns {string} Human readable hand strength
     */
    getHandStrengthDescription(handEvaluation) {
        if (!handEvaluation || !handEvaluation.hand) {
            return 'Unknown hand';
        }

        const hand = handEvaluation.hand;
        return `${hand.name} (${hand.descr})`;
    }
}

// Export singleton instance
module.exports = new PokerCards();