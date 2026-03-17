const db = require('../db/db');
const jwt = require('jsonwebtoken');
const express = require('express');
const router = express.Router();
const gameSocketManager = require('../server-sockets/gamesockets');
const tableSocketManager = require('../server-sockets/tablesockets');
const {
    createFromJSON,
    GameState,
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

const { updateGameStateWithNewBet, getNextRequest, determineWinner } = require('../engine/gamelogic');

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
                SELECT game_id, table_id, pot, community_cards, stage, dealer_seat, hot_seat, aggrounds, current_bet, bets, deck, max_players
                FROM gamestate
                WHERE game_id = ?
            `;
            values = [game_id];
        } else {
            // Get the most recent active game for the table
            query = `
                SELECT game_id, table_id, pot, community_cards, stage, dealer_seat, hot_seat, aggrounds, current_bet, bets, deck, max_players
                FROM gamestate
                WHERE table_id = ? AND stage != 'game_over'
                ORDER BY created_at DESC
                LIMIT 1
            `;
            values = [table_id];
        }

        const [result] = await db.execute(query, values);

        if (result.length === 0) {
            return res.status(404).json({ message: 'Game not found' });
        }

        const gameData = result[0];
        // Parse JSON fields if they exist
        if (gameData.community_cards && typeof gameData.community_cards === 'string') {
            gameData.community_cards = JSON.parse(gameData.community_cards);
        }
        if (gameData.aggrounds && typeof gameData.aggrounds === 'string') {
            gameData.aggrounds = JSON.parse(gameData.aggrounds);
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

// POST /games - Create a new game with default values
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { table_id, dealer_seat } = req.body;

        if (!table_id) {
            return res.status(400).json({ message: 'table_id is required' });
        }
        // Fetch table to get max_players
        const [tableRows] = await db.execute(`SELECT max_players FROM tables WHERE table_id = ?`, [table_id]);
        if (tableRows.length === 0) {
            return res.status(404).json({ message: 'Table not found' });
        }
        const max_players = tableRows[0].max_players;

        const query = `
            INSERT INTO gamestate (table_id, pot, stage, dealer_seat, max_players)
            VALUES (?, 0, 'waiting', ?, ?)
        `;

        const [result] = await db.execute(query, [table_id, dealer_seat || 0, max_players]);

        res.status(201).json({
            message: 'Game created successfully',
            game_id: result.insertId
        });
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
            // First clear game info from players in this game
            await db.execute(
                'UPDATE players SET game_id = NULL, hole_cards = NULL, is_folded = NULL, is_all_in = NULL, current_bet = NULL WHERE game_id = ?',
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
                    'UPDATE players SET game_id = NULL, hole_cards = NULL, is_folded = NULL, is_all_in = NULL, current_bet = NULL WHERE game_id = ?',
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
    try {
        const { game_id, seat, current_bet, player_bet, allin } = req.body;
        const playerId = req.user.playerId;

        // Validate required fields
        if (!game_id || seat === undefined || current_bet === undefined || player_bet === undefined) {
            return res.status(400).json({ message: 'Missing required action parameters' });
        }

        const newAction = new PlayerAction({ game_id, seat, current_bet, player_bet, allin });
        console.log('Processing player action:', newAction);

        // Fetch current game state 
        const [gameRows] = await db.execute(`
            SELECT g.game_id, g.table_id, g.dealer_seat, g.hot_seat, g.stage, g.max_players,
                   g.aggrounds, g.pot, g.current_bet, g.bets, g.community_cards, g.deck
            FROM gamestate g
            WHERE g.game_id = ?
        `, [game_id]);

        if (gameRows.length === 0) {
            return res.status(404).json({ message: 'Game not found' });
        }

        const gameRow = gameRows[0];

        // Parse JSON fields for game state
        const oldGameStateData = {
            ...gameRow,
            aggrounds: typeof gameRow.aggrounds === 'string' ? JSON.parse(gameRow.aggrounds) : gameRow.aggrounds,
            bets: typeof gameRow.bets === 'string' ? JSON.parse(gameRow.bets) : gameRow.bets,
            community_cards: typeof gameRow.community_cards === 'string' ? JSON.parse(gameRow.community_cards) : gameRow.community_cards,
            deck: typeof gameRow.deck === 'string' ? JSON.parse(gameRow.deck) : gameRow.deck
        };

        const oldGameState = new GameState(oldGameStateData);

        // Process the action with game engine
        const { gameState, proceedResult, lastAction } = updateGameStateWithNewBet(oldGameState, newAction);

        // Start database transaction
        await db.query('START TRANSACTION');

        try {
            // Update game state in database
            const updateQuery = `
                UPDATE gamestate 
                SET pot = ?, current_bet = ?, aggrounds = ?, stage = ?, hot_seat = ?, 
                    bets = ?, community_cards = ?, deck = ?, max_players = ?
                WHERE game_id = ?
            `;

            await db.execute(updateQuery, [
                gameState.pot,
                gameState.current_bet,
                JSON.stringify(gameState.aggrounds),
                gameState.stage,
                gameState.hot_seat,
                JSON.stringify(gameState.bets),
                JSON.stringify(gameState.community_cards),
                JSON.stringify(gameState.deck),
                gameState.max_players,
                game_id
            ]);

            // Commit database changes
            await db.query('COMMIT');

            // Broadcast action to table via sockets
            if (lastAction) {
                gameSocketManager.sendLastAction(gameState.table_id, {
                    game_id: game_id,
                    seat: seat,
                    bet_amount: lastAction.bet_amount || 0,
                    allin: lastAction.allin || false,
                    folded: lastAction.folded || false
                });
            }

            // Send success response to acting player
            const playerSocket = tableSocketManager.getSocket(playerId);
            if (playerSocket) {
                gameSocketManager.sendActionResponse(playerSocket, true, null, game_id, playerId);
            }

            res.json({
                success: true,
                message: 'Action processed successfully',
                gameState: gameState
            });

            // -- Game Progression --
            if (proceedResult === 1) {
                gameSocketManager.sendStageProgression(gameState.table_id, {
                    game_id: game_id,
                    stage: gameState.stage,
                    community_cards: gameState.community_cards
                });
            }
            if (proceedResult === 0 || proceedResult === 1) {
                const nextRequest = getNextRequest(gameState);
                if (nextRequest.type === PackageType.SERVER_REQUEST_CALL) {
                    gameSocketManager.requestCall(tableSocketManager.getSocket(playerId), {
                        game_id: game_id,
                        player_id: playerId,
                        seat: nextRequest.seat,
                        min_raise: nextRequest.min_raise,
                        to_call: nextRequest.to_call
                    });
                } else if (nextRequest.type === PackageType.SERVER_REQUEST_CHECK) {
                    gameSocketManager.requestCheck(tableSocketManager.getSocket(playerId), {
                        game_id: game_id,
                        player_id: playerId,
                        seat: nextRequest.seat,
                        min_raise: nextRequest.min_raise
                    });
                } else {
                    console.error('Invalid next request type:', nextRequest.type);
                }
            }
            if (proceedResult === -1) {
                const seatsInGame = gameState.bets.filter(b => !b.folded).map(b => b.seat);
                // fetch hole cards from remaining players in game for showdown
                const [playerRows] = await db.execute(`
                        SELECT player_id, hole_cards 
                        FROM players 
                        WHERE game_id = ? AND seat IN (${seatsInGame.join(',')})
                    `, [game_id]);
                const playerCards = playerRows.map(row => ({
                    player_id: row.player_id,
                    hole_cards: JSON.parse(row.hole_cards)
                }));
                const winners = determineWinner(playerCards, gameState.community_cards);
                gameSocketManager.sendGameEnd(gameState.table_id, {
                    game_id: game_id,
                    winners: winners,
                    pot: gameState.pot
                });

                // TODO: reset game state for new game after some delay, or wait for client to trigger new game creation
            }
        } catch (dbError) {
            await db.query('ROLLBACK');
            throw dbError;
        }

    } catch (error) {
        console.error('Error processing player action:', error);

        // Send error to player via socket
        const playerId = req.user?.playerId;
        if (playerId) {
            const playerSocket = tableSocketManager.getSocket(playerId);
            if (playerSocket) {
                gameSocketManager.sendError(playerSocket, 'Failed to process action', req.body.game_id, playerId);
            }
        }

        res.status(500).json({ message: 'Failed to process player action' });
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