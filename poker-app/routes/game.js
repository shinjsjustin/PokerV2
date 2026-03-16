const db = require('../db/db');
const jwt = require('jsonwebtoken');
const express = require('express');
const router = express.Router();
const gameSocketManager = require('../server-sockets/gamesockets');
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
 } = require('../datapacks/schema');

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
                SELECT game_id, table_id, pot, community_cards, stage, dealer_seat, active_seat
                FROM games
                WHERE game_id = ?
            `;
            values = [game_id];
        } else {
            // Get the most recent active game for the table
            query = `
                SELECT game_id, table_id, pot, community_cards, stage, dealer_seat, active_seat
                FROM games
                WHERE table_id = ? AND stage != 'game_over'
                ORDER BY started_at DESC
                LIMIT 1
            `;
            values = [table_id];
        }

        const [result] = await db.execute(query, values);

        if (result.length === 0) {
            return res.status(404).json({ message: 'Game not found' });
        }

        res.json(result[0]);
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

        const query = `
            INSERT INTO gamestate (table_id, pot, stage, dealer_seat)
            VALUES (?, 0, 'waiting', ?)
        `;

        const [result] = await db.execute(query, [table_id, dealer_seat || 0]);

        res.status(201).json({
            message: 'Game created successfully',
            game_id: result.insertId
        });
    } catch (error) {
        console.error('Error creating game:', error);
        res.status(500).json({ message: 'Failed to create game' });
    }
});

function checkLastAction(oldGameState, newGameState){
    const oldSeat = oldGameState.hot_seat;
    if (oldSeat !== (newGameState.hot_seat + 1) % newGameState.max_players) {
        throw new Error('Hot seat did not advance correctly');
    }
    if (newGameState.bets[oldSeat] === -1){
        return new ServerUpdateLastAction({
            game_id: newGameState.game_id,
            seat: oldSeat,
            bet_amount: -1,
            allin: false,
            folded: true
        });
    }

    const diff = newGameState.bets[oldSeat] - oldGameState.bets[oldSeat];
    return new ServerUpdateLastAction({
            game_id: newGameState.game_id,
            seat: oldSeat,
            bet_amount: diff,
            allin: false,
            folded: false
        });
}

// PUT /games - Update game by game_id or table_id
// Can update: pot, community_cards, stage, active_seat, dealer_seat
router.put('/', authenticateToken, async (req, res) => {
    try {
        const { game_id, table_id, dealer_seat, hot_seat, stage, aggrounds, pot, current_bet, bets, community_cards } = req.body;

        if (!game_id && !table_id) {
            return res.status(400).json({ message: 'game_id or table_id is required' });
        }
        const newGameState = new GameState({
            game_id,
            table_id,
            dealer_seat,
            hot_seat,
            stage,
            aggrounds,
            pot,
            current_bet,
            bets,
            community_cards
        });
        // Fetch current game state for last action comparison
        const [gameRows] = await db.execute(`
                SELECT g.game_id, g.table_id, g.dealer_seat, g.hot_seat, g.stage, 
                       g.aggrounds, g.pot, g.current_bet, g.bets, g.community_cards
                FROM gamestate g
                WHERE g.game_id = ?
            `, [game_id]);
        const og = gameRows[0];
        const oldGameState = createFromJSON(og);
        // Check last action and broadcast to table
        const lastActionPacket = checkLastAction(oldGameState, newGameState);
        gameSocketManager.sendLastAction(table_id, lastActionPacket);


        // UPDATE
        // Build dynamic update query based on provided fields
        const updates = [];
        const values = [];

        if (pot !== undefined) {
            updates.push('pot = ?');
            values.push(pot);
        }
        if (community_cards !== undefined) {
            updates.push('community_cards = ?');
            values.push(JSON.stringify(community_cards));
        }
        if (stage !== undefined) {
            updates.push('stage = ?');
            values.push(stage);
        }
        if (active_seat !== undefined) {
            updates.push('hot_seat = ?');
            values.push(active_seat);
        }
        if (dealer_seat !== undefined) {
            updates.push('dealer_seat = ?');
            values.push(dealer_seat);
        }

        if (updates.length === 0) {
            return res.status(400).json({ message: 'No fields to update' });
        }

        let query;

        if (game_id) {
            query = `UPDATE gamestate SET ${updates.join(', ')} WHERE game_id = ?`;
            values.push(game_id);
        } else {
            // Update the most recent active game for the table
            query = `UPDATE gamestate SET ${updates.join(', ')} WHERE table_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`;
            values.push(table_id);
        }

        const [result] = await db.execute(query, values);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Game not found' });
        }

        //Logic for next operation
        

        res.json({ message: 'Game updated successfully' });
    } catch (error) {
        console.error('Error updating game:', error);
        res.status(500).json({ message: 'Failed to update game' });
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

//TODO: Add endpoints for player actions (bet, call, fold, check) that also broadcast to table via sockets
router.post('/action', authenticateToken, async (req, res) => {
    try {
        const { game_id, player_id, action, amount } = req.body;

        
    } catch (error) {
        console.error('Error processing player action:', error);
        res.status(500).json({ message: 'Failed to process player action' });
    }
});
module.exports = router;