const db = require('../db/db');
const jwt = require('jsonwebtoken');
const express = require('express');
const router = express.Router();
const gameSocketManager = require('../server-sockets/gamesockets');
const tableSocketManager = require('../server-sockets/tablesockets');
const pokerCards = require('../engine/hands');
const {
    createFromJSON,
    GameState,
    GameStateBet,
    ServerRequestCall,
    ServerRequestCheck,
    ServerToTableMessage,
    ServerToPlayerMessage,
    ServerUpdateLastAction,
    ServerUpdateStageProgression,
    ServerUpdateGameEnd,
    PlayerAction,
    PackageType
} = require('../datapacks/schema');

const { updateGameStateWithNewBet, getNextRequest, determineWinner, dealAllRemainingCommunityCards } = require('../engine/gamelogic');

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
        return res.status(401).json({ message: 'Access token required' });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ message: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
};

// Get game state - supports both game_id and table_id queries
router.get('/', authenticateToken, async (req, res) => {
    try {
        const { game_id, table_id } = req.query;

        if (!game_id && !table_id) {
            return res.status(400).json({ message: 'game_id or table_id is required' });
        }

        let query;
        let values;

        if (game_id) {
            query = `
                SELECT game_id, table_id, big_blind, pot, community_cards, stage, dealer_seat, hot_seat, aggrounds, current_bet, bets, deck, max_players
                FROM gamestate
                WHERE game_id = ?
            `;
            values = [game_id];
        } else {
            // Get the most recent active game for the table
            // stage is an integer: 0=pre-flop, 1=flop, 2=turn, 3=river, 4=game-over
            query = `
                SELECT game_id, table_id, big_blind, pot, community_cards, stage, dealer_seat, hot_seat, aggrounds, current_bet, bets, deck, max_players
                FROM gamestate
                WHERE table_id = ? AND stage < 4
                ORDER BY started_at DESC
                LIMIT 1
            `;
            values = [table_id];
        }

        const [result] = await db.execute(query, values);

        if (result.length === 0) {
            return res.status(404).json({ message: 'Game not found' });
        }

        const gameData = result[0];
        // Parse JSON fields if they exist (aggrounds is an integer, not JSON)
        if (gameData.community_cards && typeof gameData.community_cards === 'string') {
            gameData.community_cards = JSON.parse(gameData.community_cards);
        }
        if (gameData.bets && typeof gameData.bets === 'string') {
            gameData.bets = JSON.parse(gameData.bets);
        }
        if (gameData.deck && typeof gameData.deck === 'string') {
            gameData.deck = JSON.parse(gameData.deck);
        }

        res.json(gameData);
    } catch (error) {
        console.error('Error fetching game:', error);
        res.status(500).json({ message: 'Failed to fetch game' });
    }
});

// GET /games/tables/:tableId/active-game - Get active game for a table
router.get('/tables/:tableId/active-game', async (req, res) => {
    try {
        const { tableId } = req.params;

        // Get the most recent non-ended game for this table
        const [gameResult] = await db.execute(`
            SELECT game_id, table_id, big_blind, pot, community_cards, stage, 
                   dealer_seat, hot_seat, aggrounds, current_bet, bets, max_players
            FROM gamestate
            WHERE table_id = ? AND (stage IS NULL OR stage < 5)
            ORDER BY started_at DESC
            LIMIT 1
        `, [tableId]);

        if (gameResult.length === 0) {
            return res.status(404).json({ message: 'No active game found' });
        }

        const gameData = gameResult[0];
        
        // Parse JSON fields (aggrounds is an integer, not JSON)
        if (gameData.community_cards && typeof gameData.community_cards === 'string') {
            gameData.community_cards = JSON.parse(gameData.community_cards);
        }
        if (gameData.bets && typeof gameData.bets === 'string') {
            gameData.bets = JSON.parse(gameData.bets);
        }

        res.json(gameData);
    } catch (error) {
        console.error('Error fetching active game:', error);
        res.status(500).json({ message: 'Failed to fetch active game' });
    }
});

// GET /games/:gameId/state - Get full game state with players (for UI)
router.get('/:gameId/state', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.params;
        const requestingPlayerId = req.user.playerId;

        // Get game data
        const [gameRows] = await db.execute(`
            SELECT g.*, t.name as table_name, t.small_blind
            FROM gamestate g
            JOIN tables t ON g.table_id = t.table_id
            WHERE g.game_id = ?
        `, [gameId]);

        if (gameRows.length === 0) {
            return res.status(404).json({ message: 'Game not found' });
        }

        const game = gameRows[0];

        // Parse JSON fields (aggrounds is an integer, not JSON)
        const bets = typeof game.bets === 'string' ? JSON.parse(game.bets) : (game.bets || []);
        const communityCards = typeof game.community_cards === 'string' ? JSON.parse(game.community_cards) : (game.community_cards || []);

        // Get players in this game
        const [playerRows] = await db.execute(`
            SELECT player_id, username, seat_number, hole_cards, current_bet, chip_balance
            FROM players
            WHERE game_id = ?
            ORDER BY seat_number
        `, [gameId]);

        // Calculate blind positions
        const activeSeatNumbers = playerRows.map(p => p.seat_number).sort((a, b) => a - b);
        const dealerIdx = activeSeatNumbers.indexOf(game.dealer_seat) !== -1 
            ? activeSeatNumbers.indexOf(game.dealer_seat) 
            : 0;
        const sbIdx = (dealerIdx + 1) % activeSeatNumbers.length;
        const bbIdx = (dealerIdx + 2) % activeSeatNumbers.length;
        const sbSeat = activeSeatNumbers[sbIdx];
        const bbSeat = activeSeatNumbers[bbIdx];

        // Find active player
        const hotSeatPlayer = playerRows.find(p => p.seat_number === game.hot_seat);

        // Build game state for UI
        const gameState = {
            game_id: game.game_id,
            table_id: game.table_id,
            tableName: game.table_name,
            smallBlind: game.small_blind,
            bigBlind: game.big_blind,
            pot: game.pot,
            current_bet: game.current_bet,
            stage: game.stage,
            dealerSeat: game.dealer_seat,
            sbSeat: sbSeat,
            bbSeat: bbSeat,
            activePlayerId: hotSeatPlayer?.player_id || null,
            community_cards: communityCards,
            players: playerRows.map(p => {
                const bet = bets.find(b => b.seat === p.seat_number) || {};
                const holeCards = typeof p.hole_cards === 'string' ? JSON.parse(p.hole_cards) : p.hole_cards;
                
                return {
                    player_id: p.player_id,
                    username: p.username,
                    seat_number: p.seat_number,
                    chip_balance: p.chip_balance,
                    current_bet: bet.bet_amount || p.current_bet || 0,
                    is_folded: bet.folded || false,
                    is_all_in: bet.allin || false,
                    // Only show hole cards to the requesting player (or at showdown)
                    hole_cards: (p.player_id === requestingPlayerId || game.stage >= 4) ? holeCards : null
                };
            })
        };
        // Calculate pending action for the requesting player if they are the active player
        let pendingAction = null;
        console.log('Checking pending action:', { 
            hotSeatPlayerId: hotSeatPlayer?.player_id, 
            hotSeat: game.hot_seat,
            requestingPlayerId, 
            gameStage: game.stage,
            isHotSeatPlayer: Number(hotSeatPlayer?.player_id) === Number(requestingPlayerId),
            betsCount: bets.length,
            bets: JSON.stringify(bets)
        });
        
        if (hotSeatPlayer && Number(hotSeatPlayer.player_id) === Number(requestingPlayerId) && game.stage < 4) {
            try {
                // Build a GameState object to use getNextRequest
                const gameStateForRequest = new GameState({
                    game_id: game.game_id,
                    table_id: game.table_id,
                    big_blind: game.big_blind,
                    dealer_seat: game.dealer_seat,
                    max_players: game.max_players,
                    hot_seat: game.hot_seat,
                    stage: game.stage,
                    aggrounds: game.aggrounds,
                    pot: game.pot,
                    current_bet: game.current_bet,
                    bets: bets,
                    community_cards: communityCards,
                    deck: []
                });
                
                const request = getNextRequest(gameStateForRequest);
                pendingAction = {
                    type: request.type,
                    seat: request.seat,
                    min_raise: request.min_raise,
                    to_call: request.to_call || 0,
                    player_id: Number(requestingPlayerId)
                };
                console.log('Generated pending action:', pendingAction);
            } catch (e) {
                // Player may have already acted or is folded/all-in, no pending action
                console.log('No pending action for player:', e.message);
            }
        }

        gameState.pendingAction = pendingAction;        res.json(gameState);

    } catch (error) {
        console.error('Error fetching game state:', error);
        res.status(500).json({ message: 'Failed to fetch game state' });
    }
});

// POST /games - Create a new game with full initialization
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { table_id } = req.body;

        if (!table_id) {
            return res.status(400).json({ message: 'table_id is required' });
        }

        // Fetch table info
        const [tableRows] = await db.execute(
            `SELECT table_id, name, dealer_seat, max_players, big_blind, small_blind FROM tables WHERE table_id = ?`, 
            [table_id]
        );
        if (tableRows.length === 0) {
            return res.status(404).json({ message: 'Table not found' });
        }
        const table = tableRows[0];

        // Fetch players at this table
        const [playerRows] = await db.execute(`
            SELECT player_id, username, chip_balance, seat_number 
            FROM players 
            WHERE table_id = ? AND status = 'active'
            ORDER BY seat_number
        `, [table_id]);

        if (playerRows.length < 2) {
            return res.status(400).json({ message: 'Need at least 2 players to start a game' });
        }

        // Start transaction
        await db.query('START TRANSACTION');

        try {
            // Deal cards to all players
            const dealResult = pokerCards.dealHoldemGame(playerRows);
            
            // Calculate blind positions using actual player seats
            const playerCount = playerRows.length;
            const seatNumbers = playerRows.map(p => p.seat_number).sort((a, b) => a - b);
            
            // Find dealer position in the seat list (or default to first seat)
            let dealerIdx = seatNumbers.indexOf(table.dealer_seat);
            if (dealerIdx === -1) {
                // Dealer seat not occupied, find the next occupied seat after dealer_seat
                dealerIdx = seatNumbers.findIndex(s => s > table.dealer_seat);
                if (dealerIdx === -1) dealerIdx = 0; // wrap around
            }
            
            // For heads-up (2 players): dealer is SB and acts first preflop
            // For 3+ players: SB is left of dealer, BB is left of SB, UTG acts first
            let sbIdx, bbIdx, hotSeatIdx;
            if (playerCount === 2) {
                sbIdx = dealerIdx;  // Dealer is SB in heads-up
                bbIdx = (dealerIdx + 1) % playerCount;
                hotSeatIdx = dealerIdx;  // SB (dealer) acts first preflop in heads-up
            } else {
                sbIdx = (dealerIdx + 1) % playerCount;
                bbIdx = (dealerIdx + 2) % playerCount;
                hotSeatIdx = (dealerIdx + 3) % playerCount;  // UTG
            }
            
            const sbSeat = seatNumbers[sbIdx];
            const bbSeat = seatNumbers[bbIdx];
            const hotSeat = seatNumbers[hotSeatIdx];

            // Initialize bets array with blinds using GameStateBet instances
            const bets = playerRows.map(p => new GameStateBet({
                seat: p.seat_number,
                bet_amount: p.seat_number === sbSeat ? table.small_blind : 
                           (p.seat_number === bbSeat ? table.big_blind : 0),
                folded: false,
                allin: false
            }));

            // Initialize aggrounds - based on actual number of players in game
            const aggrounds = playerRows.length;

            // Initial pot is SB + BB
            const initialPot = table.small_blind + table.big_blind;

            // Create game record
            const [gameResult] = await db.execute(`
                INSERT INTO gamestate 
                (table_id, pot, dealer_seat, max_players, big_blind, stage, hot_seat, 
                 current_bet, bets, aggrounds, community_cards, deck)
                VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
            `, [
                table_id,
                initialPot,
                table.dealer_seat,
                playerRows.length,
                table.big_blind,
                hotSeat,
                table.big_blind,
                JSON.stringify(bets),
                aggrounds,
                JSON.stringify([]),
                JSON.stringify(dealResult.deck)
            ]);

            const gameId = gameResult.insertId;

            // Update players with game_id and hole cards, deduct blinds
            for (const player of playerRows) {
                const holeCards = dealResult.playerCards[player.player_id];
                console.log(`Storing hole cards for player ${player.player_id}:`, holeCards, 'type:', typeof holeCards, 'isArray:', Array.isArray(holeCards));
                
                const blindAmount = player.seat_number === sbSeat ? table.small_blind : 
                                   (player.seat_number === bbSeat ? table.big_blind : 0);
                
                const holeCardsJson = JSON.stringify(holeCards);
                console.log(`JSON stringified hole cards for player ${player.player_id}:`, holeCardsJson);
                
                await db.execute(`
                    UPDATE players 
                    SET game_id = ?, hole_cards = ?, current_bet = ?,
                        chip_balance = chip_balance - ?
                    WHERE player_id = ?
                `, [gameId, holeCardsJson, blindAmount, blindAmount, player.player_id]);
            }

            await db.query('COMMIT');

            // Emit game_started event to notify all players at the table
            tableSocketManager.emitToTable(table_id, 'game_started', {
                table_id: table_id,
                game_id: gameId,
                message: 'A new game has started!'
            });

            // Deal hole cards to each player (private - each player only sees their own cards)
            const playersWithCards = playerRows.map(p => ({
                player_id: p.player_id,
                seat_number: p.seat_number,
                hole_cards: dealResult.playerCards[p.player_id]
            }));
            gameSocketManager.dealHoleCardsToAllPlayers(tableSocketManager, gameId, playersWithCards);

            // Send initial game state to all players at the table
            // Note: hole_cards are sent separately via dealHoleCardsToAllPlayers for privacy
            const gameStateData = {
                game_id: gameId,
                table_id: table_id,
                tableName: table.name,
                smallBlind: table.small_blind,
                bigBlind: table.big_blind,
                pot: initialPot,
                current_bet: table.big_blind,
                stage: 0,
                dealerSeat: table.dealer_seat,
                sbSeat: sbSeat,
                bbSeat: bbSeat,
                activePlayerId: playerRows.find(p => p.seat_number === hotSeat)?.player_id,
                community_cards: [],
                players: playerRows.map(p => {
                    const bet = bets.find(b => b.seat === p.seat_number);
                    const blindAmount = p.seat_number === sbSeat ? table.small_blind : 
                                       (p.seat_number === bbSeat ? table.big_blind : 0);
                    return {
                        player_id: p.player_id,
                        username: p.username,
                        seat_number: p.seat_number,
                        chips_start: p.chip_balance,
                        chips_end: p.chip_balance - blindAmount,
                        current_bet: bet?.bet_amount || 0,
                        is_folded: false,
                        is_all_in: false,
                        // Don't include hole_cards here - they're sent privately
                        hole_cards: null
                    };
                })
            };

            gameSocketManager.sendGameState(table_id, gameStateData);

            // Send initial action request to the hot seat player
            const hotSeatPlayer = playerRows.find(p => p.seat_number === hotSeat);
            if (hotSeatPlayer) {
                const hotSeatBet = bets.find(b => b.seat === hotSeat);
                const hotSeatCurrentBet = hotSeatBet?.bet_amount || 0;
                const toCall = table.big_blind - hotSeatCurrentBet;
                const minRaise = table.big_blind * 2; // Min raise is 2x BB preflop
                
                const hotSeatSocket = tableSocketManager.getSocket(hotSeatPlayer.player_id);
                if (hotSeatSocket) {
                    if (toCall > 0) {
                        // Player needs to call (e.g., SB in heads-up or UTG)
                        gameSocketManager.requestCall(hotSeatSocket, {
                            game_id: gameId,
                            player_id: hotSeatPlayer.player_id,
                            seat: hotSeat,
                            min_raise: minRaise,
                            to_call: toCall
                        });
                    } else {
                        // Player can check (e.g., BB when no raises)
                        gameSocketManager.requestCheck(hotSeatSocket, {
                            game_id: gameId,
                            player_id: hotSeatPlayer.player_id,
                            seat: hotSeat,
                            min_raise: minRaise
                        });
                    }
                }
            }

            res.status(201).json({
                message: 'Game created successfully',
                game_id: gameId,
                table_id: table_id
            });

        } catch (dbError) {
            await db.query('ROLLBACK');
            throw dbError;
        }

    } catch (error) {
        console.error('Error creating game:', error);
        res.status(500).json({ message: 'Failed to create game' });
    }
});

// DELETE /games - Delete a game by game_id or table_id
router.delete('/', authenticateToken, async (req, res) => {
    try {
        const { game_id, table_id } = req.body;

        if (!game_id && !table_id) {
            return res.status(400).json({ message: 'game_id or table_id is required' });
        }

        let query;
        let values;

        if (game_id) {
            // Clear game-specific data from players (is_folded/is_all_in live in
            // the bets JSON on gamestate, not as columns on players)
            await db.execute(
                'UPDATE players SET game_id = NULL, hole_cards = NULL, current_bet = NULL WHERE game_id = ?',
                [game_id]
            );
            // Then delete the game
            query = 'DELETE FROM gamestate WHERE game_id = ?';
            values = [game_id];
        } else {
            // Get all game_ids for this table to clear player game info
            const [games] = await db.execute('SELECT game_id FROM gamestate WHERE table_id = ?', [table_id]);
            for (const game of games) {
                await db.execute(
                    'UPDATE players SET game_id = NULL, hole_cards = NULL, current_bet = NULL WHERE game_id = ?',
                    [game.game_id]
                );
            }
            // Then delete all gamestate for this table
            query = 'DELETE FROM gamestate WHERE table_id = ?';
            values = [table_id];
        }

        const [result] = await db.execute(query, values);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Game not found' });
        }

        res.json({
            message: 'Game(s) deleted successfully',
            deleted_count: result.affectedRows
        });
    } catch (error) {
        console.error('Error deleting game:', error);
        res.status(500).json({ message: 'Failed to delete game' });
    }
});

// Process player action and broadcast to table via sockets
router.post('/action', authenticateToken, async (req, res) => {
    const TAG = '[GAME:action]';
    try {
        const { game_id, seat, current_bet, player_bet, allin } = req.body;
        const playerId = req.user.playerId;

        console.log(`${TAG} player=${playerId} game=${game_id} seat=${seat} player_bet=${player_bet} allin=${allin}`);

        if (!game_id || seat === undefined || current_bet === undefined || player_bet === undefined) {
            return res.status(400).json({ message: 'Missing required action parameters' });
        }

        const newAction = new PlayerAction({ game_id, seat, current_bet, player_bet, allin });

        // FIX: JOIN with tables to obtain table_name and small_blind so that
        //      socket broadcasts can include the same metadata as the HTTP endpoint.
        const [gameRows] = await db.execute(`
            SELECT g.game_id, g.table_id, g.big_blind, g.dealer_seat, g.hot_seat, g.stage, g.max_players,
                   g.aggrounds, g.pot, g.current_bet, g.bets, g.community_cards, g.deck,
                   t.name AS table_name, t.small_blind
            FROM gamestate g
            JOIN tables t ON g.table_id = t.table_id
            WHERE g.game_id = ?
        `, [game_id]);

        if (gameRows.length === 0) {
            return res.status(404).json({ message: 'Game not found' });
        }

        const gameRow = gameRows[0];
        console.log(`${TAG} DB state: stage=${gameRow.stage} hot_seat=${gameRow.hot_seat} pot=${gameRow.pot} current_bet=${gameRow.current_bet}`);

        const oldGameStateData = {
            ...gameRow,
            bets:            typeof gameRow.bets            === 'string' ? JSON.parse(gameRow.bets)            : gameRow.bets,
            community_cards: typeof gameRow.community_cards === 'string' ? JSON.parse(gameRow.community_cards) : gameRow.community_cards,
            deck:            typeof gameRow.deck            === 'string' ? JSON.parse(gameRow.deck)            : gameRow.deck
        };

        const previousPot = oldGameStateData.pot;
        const oldGameState = new GameState(oldGameStateData);

        // ── Engine ───────────────────────────────────────────────────
        const { gameState, proceedResult, lastAction } = updateGameStateWithNewBet(oldGameState, newAction);

        // FIX: chips this player put into the pot this action = delta in pot total
        const chipsDeducted = gameState.pot - previousPot;
        console.log(`${TAG} proceedResult=${proceedResult} chipsDeducted=${chipsDeducted} pot=${gameState.pot}`);

        // ── DB Transaction ───────────────────────────────────────────
        await db.query('START TRANSACTION');
        try {
            await db.execute(`
                UPDATE gamestate
                SET pot = ?, current_bet = ?, aggrounds = ?, stage = ?, hot_seat = ?,
                    bets = ?, community_cards = ?, deck = ?, max_players = ?
                WHERE game_id = ?
            `, [
                gameState.pot, gameState.current_bet, gameState.aggrounds, gameState.stage,
                gameState.hot_seat, JSON.stringify(gameState.bets), JSON.stringify(gameState.community_cards),
                JSON.stringify(gameState.deck), gameState.max_players, game_id
            ]);

            // FIX: Keep player chip_balance in sync with every bet/call/raise.
            //      Previously chips were only deducted for blinds at game start.
            if (chipsDeducted > 0) {
                await db.execute(
                    'UPDATE players SET chip_balance = chip_balance - ?, current_bet = ? WHERE player_id = ?',
                    [chipsDeducted, player_bet, playerId]
                );
                console.log(`${TAG} Deducted ${chipsDeducted} chips from player ${playerId}`);
            } else if (player_bet === -1) {
                await db.execute('UPDATE players SET current_bet = 0 WHERE player_id = ?', [playerId]);
            }

            await db.query('COMMIT');
            console.log(`${TAG} DB transaction committed`);
        } catch (dbError) {
            await db.query('ROLLBACK');
            throw dbError;
        }

        // ── Respond + notify ─────────────────────────────────────────
        if (lastAction) {
            gameSocketManager.sendLastAction(gameState.table_id, {
                game_id, seat,
                bet_amount: lastAction.bet_amount || 0,
                allin:      lastAction.allin  || false,
                folded:     lastAction.folded || false
            });
        }

        const playerSocket = tableSocketManager.getSocket(playerId);
        if (playerSocket) gameSocketManager.sendActionResponse(playerSocket, true, null, game_id, playerId);

        res.json({ success: true, message: 'Action processed successfully' });

        // ── Game Progression (after HTTP response) ───────────────────
        try {
            const fetchPlayersForBroadcast = async () => {
                const [rows] = await db.execute(
                    'SELECT player_id, username, seat_number, chip_balance, current_bet FROM players WHERE game_id = ? ORDER BY seat_number',
                    [game_id]
                );
                return rows;
            };

            const buildBroadcastState = (playersRows, activePlayerId) => {
                // Compute SB/BB seats relative to the dealer for badge display
                const nonFoldedSeats = playersRows
                    .filter(p => {
                        const bet = gameState.bets.find(b => b.seat === p.seat_number);
                        return !bet?.folded;
                    })
                    .map(p => p.seat_number)
                    .sort((a, b) => a - b);

                const dealerIdx = nonFoldedSeats.indexOf(gameState.dealer_seat);
                const relIdx    = dealerIdx !== -1 ? dealerIdx : 0;
                const sbSeat    = nonFoldedSeats[(relIdx + 1) % nonFoldedSeats.length];
                const bbSeat    = nonFoldedSeats[(relIdx + 2) % nonFoldedSeats.length];

                return {
                    game_id, table_id: gameState.table_id,
                    tableName:   gameRow.table_name,
                    smallBlind:  gameRow.small_blind,
                    bigBlind:    gameRow.big_blind,
                    sbSeat, bbSeat,
                    pot: gameState.pot, current_bet: gameState.current_bet,
                    stage: gameState.stage, dealerSeat: gameState.dealer_seat,
                    activePlayerId, community_cards: gameState.community_cards,
                    players: playersRows.map(p => {
                        const bet = gameState.bets.find(b => b.seat === p.seat_number) || {};
                        return {
                            player_id: p.player_id, username: p.username,
                            seat_number: p.seat_number, chip_balance: p.chip_balance,
                            current_bet: bet.bet_amount || 0,
                            is_folded:  bet.folded || false,
                            is_all_in:  bet.allin  || false,
                            hole_cards: null
                        };
                    })
                };
            };

            // FIX: proceedResult === 0 means stage advanced (flop/turn/river dealt).
            //      proceedResult === 1 means betting continues in the same stage.
            //      Previously sendStageProgression was called on === 1 (wrong).
            if (proceedResult === 0) {
                console.log(`${TAG} Stage advanced to ${gameState.stage} — broadcasting stage progression`);
                gameSocketManager.sendStageProgression(gameState.table_id, {
                    game_id, stage: gameState.stage, community_cards: gameState.community_cards
                });
            }

            if (proceedResult === 0 || proceedResult === 1) {
                const nextRequest = getNextRequest(gameState);
                const [nextPlayerRows] = await db.execute(
                    'SELECT player_id FROM players WHERE game_id = ? AND seat_number = ?',
                    [game_id, nextRequest.seat]
                );

                if (nextPlayerRows.length > 0) {
                    const nextPlayerId = nextPlayerRows[0].player_id;
                    const nextSocket  = tableSocketManager.getSocket(nextPlayerId);

                    if (nextSocket) {
                        if (nextRequest.type === PackageType.SERVER_REQUEST_CALL) {
                            gameSocketManager.requestCall(nextSocket, {
                                game_id, player_id: nextPlayerId, seat: nextRequest.seat,
                                min_raise: nextRequest.min_raise, to_call: nextRequest.to_call
                            });
                        } else {
                            gameSocketManager.requestCheck(nextSocket, {
                                game_id, player_id: nextPlayerId, seat: nextRequest.seat,
                                min_raise: nextRequest.min_raise
                            });
                        }
                        console.log(`${TAG} Sent ${nextRequest.type} to player ${nextPlayerId} at seat ${nextRequest.seat}`);
                    } else {
                        console.warn(`${TAG} Player ${nextPlayerId} (seat ${nextRequest.seat}) has no active socket`);
                    }

                    const playersForBroadcast = await fetchPlayersForBroadcast();
                    gameSocketManager.sendGameState(
                        gameState.table_id,
                        buildBroadcastState(playersForBroadcast, nextPlayerRows[0].player_id)
                    );
                } else {
                    console.error(`${TAG} No player found at next seat ${nextRequest.seat}`);
                }
            }

            if (proceedResult === -1) {
                console.log(`${TAG} GAME OVER — determining winner`);

                // FIX: If players went all-in before all community cards were dealt
                //      (e.g. everyone all-in on the preflop), deal the remaining
                //      community cards in memory before running the hand evaluator,
                //      which requires exactly 5 cards.
                if (gameState.community_cards.length < 5) {
                    console.log(`${TAG} All-in showdown: only ${gameState.community_cards.length} community cards — dealing remainder`);
                    dealAllRemainingCommunityCards(gameState);
                    // Persist the final board and updated stage to DB
                    await db.execute(
                        'UPDATE gamestate SET community_cards = ?, stage = ?, deck = ? WHERE game_id = ?',
                        [JSON.stringify(gameState.community_cards), gameState.stage, JSON.stringify(gameState.deck), game_id]
                    );
                    console.log(`${TAG} Board complete: [${gameState.community_cards.join(', ')}]`);
                    // Broadcast the final board to all players
                    gameSocketManager.sendStageProgression(gameState.table_id, {
                        game_id, stage: gameState.stage, community_cards: gameState.community_cards
                    });
                }

                const seatsInGame = gameState.bets.filter(b => !b.folded).map(b => b.seat);
                if (seatsInGame.length === 0) throw new Error('No non-folded players for showdown');

                // FIX: Use parameterised placeholders (no string interpolation of seat numbers)
                const placeholders = seatsInGame.map(() => '?').join(',');
                const [playerRows] = await db.execute(
                    `SELECT player_id, hole_cards FROM players WHERE game_id = ? AND seat_number IN (${placeholders})`,
                    [game_id, ...seatsInGame]
                );

                const playerCards = playerRows.map(row => {
                    let holeCards;
                    try {
                        holeCards = typeof row.hole_cards === 'string'
                            ? JSON.parse(row.hole_cards)
                            : (Array.isArray(row.hole_cards) ? row.hole_cards : []);
                    } catch {
                        console.error(`${TAG} Failed to parse hole_cards for player ${row.player_id}:`, row.hole_cards);
                        holeCards = [];
                    }
                    console.log(`${TAG} Showdown — player ${row.player_id}: [${holeCards.join(',')}]`);
                    return { player_id: row.player_id, hole_cards: holeCards };
                });

                const winners = determineWinner(playerCards, gameState.community_cards);
                console.log(`${TAG} Winners:`, winners.map(w => `player=${w.player_id} share=${w.share}`).join(' | '));

                const primaryWinner = winners[0];
                gameSocketManager.sendGameEnd(gameState.table_id, {
                    game_id,
                    winner_seat:  primaryWinner.seat || primaryWinner.player_id,
                    winning_hand: primaryWinner.winning_hand || primaryWinner.hand || 'High Card',
                    pot: gameState.pot
                });

                let remainingPot = gameState.pot;
                for (let i = 0; i < winners.length; i++) {
                    const amount = i === winners.length - 1
                        ? remainingPot
                        : Math.floor(gameState.pot * winners[i].share);
                    remainingPot -= amount;
                    await db.execute(
                        'UPDATE players SET chip_balance = chip_balance + ? WHERE player_id = ?',
                        [amount, winners[i].player_id]
                    );
                    console.log(`${TAG} Awarded ${amount} chips to player ${winners[i].player_id}`);
                }

                // FIX: Advance dealer seat using seated player list, not gameState.max_players
                //      (max_players is reduced by folds/all-ins during the hand and is wrong here)
                const [seatedPlayers] = await db.execute(
                    'SELECT seat_number FROM players WHERE table_id = ? AND status = "active" ORDER BY seat_number',
                    [gameState.table_id]
                );
                const seatNums = seatedPlayers.map(p => p.seat_number);
                const nextDealerSeat = seatNums.find(s => s > gameState.dealer_seat) || seatNums[0] || gameState.dealer_seat;
                await db.execute('UPDATE tables SET dealer_seat = ? WHERE table_id = ?', [nextDealerSeat, gameState.table_id]);
                console.log(`${TAG} Dealer seat: ${gameState.dealer_seat} → ${nextDealerSeat}`);

                gameSocketManager.sendGameEndedReturnToTable(gameState.table_id, {
                    winners, pot: gameState.pot, message: 'Game ended — ready for a new round'
                });
            }

        } catch (progressionError) {
            console.error(`${TAG} Game progression error (HTTP already sent):`, progressionError);
            const actingSocket = tableSocketManager.getSocket(playerId);
            if (actingSocket) gameSocketManager.sendError(actingSocket, 'Server error during game progression', game_id, playerId);
        }

    } catch (error) {
        console.error(`[GAME:action] Unhandled error:`, error);
        if (!res.headersSent) {
            const playerId = req.user?.playerId;
            if (playerId) {
                const sock = tableSocketManager.getSocket(playerId);
                if (sock) gameSocketManager.sendError(sock, 'Failed to process action', req.body.game_id, playerId);
            }
            res.status(500).json({ message: 'Failed to process player action' });
        }
    }
});

// Request specific player to take action (used by game engine)
router.post('/request-action', authenticateToken, async (req, res) => {
    try {
        const { game_id, player_id, seat, action_type, min_raise, to_call } = req.body;

        if (!game_id || !player_id || seat === undefined || !action_type) {
            return res.status(400).json({ message: 'Missing required parameters' });
        }

        const playerSocket = tableSocketManager.getSocket(player_id);
        if (!playerSocket) {
            return res.status(404).json({ message: 'Player not connected' });
        }

        if (action_type === 'check') {
            gameSocketManager.requestCheck(playerSocket, {
                game_id,
                player_id,
                seat,
                min_raise: min_raise || 0
            });
        } else if (action_type === 'call') {
            gameSocketManager.requestCall(playerSocket, {
                game_id,
                player_id,
                seat,
                min_raise: min_raise || 0,
                to_call: to_call || 0
            });
        } else {
            return res.status(400).json({ message: 'Invalid action type' });
        }

        res.json({ message: 'Action request sent successfully' });

    } catch (error) {
        console.error('Error requesting player action:', error);
        res.status(500).json({ message: 'Failed to request player action' });
    }
});
module.exports = router;