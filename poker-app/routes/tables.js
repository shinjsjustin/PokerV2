const db = require('../db/db');
const jwt = require('jsonwebtoken');
const express = require('express');
const router = express.Router();
const tableSocketManager = require('../server-sockets/tablesockets');

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

// ─────────────────────────────────────────
// TABLE MANAGEMENT ENDPOINTS
// ─────────────────────────────────────────

// GET /tables - Get all tables with player counts
router.get('/', async (req, res) => {
    try {
        const query = `
            SELECT t.*, 
                   COUNT(p.player_id) as current_players
            FROM tables t
            LEFT JOIN players p ON t.table_id = p.table_id 
                AND p.status IN ('active', 'sitting_out')
            GROUP BY t.table_id
            ORDER BY t.created_at DESC
        `;
        
        const [tables] = await db.execute(query);
        res.json(tables);
    } catch (error) {
        console.error('Error fetching tables:', error);
        res.status(500).json({ message: 'Failed to fetch tables' });
    }
});

// GET /tables/current - Get player's current table
router.get('/current', authenticateToken, async (req, res) => {
    try {
        const playerId = req.user.playerId;
        
        const [result] = await db.execute(`
            SELECT t.table_id, t.name, p.seat_number, p.chip_balance, p.status
            FROM players p
            JOIN tables t ON p.table_id = t.table_id
            WHERE p.player_id = ? AND p.status IN ('active', 'sitting_out')
            LIMIT 1
        `, [playerId]);
        
        if (result.length === 0) {
            return res.status(404).json({ message: 'Player not seated at any table' });
        }
        
        res.json(result[0]);
    } catch (error) {
        console.error('Error fetching current table:', error);
        res.status(500).json({ message: 'Failed to fetch current table' });
    }
});

// GET /tables/:tableId - Get specific table with players
router.get('/:tableId', async (req, res) => {
    try {
        const { tableId } = req.params;
        
        // Get table info
        const [tableResult] = await db.execute(
            'SELECT * FROM tables WHERE table_id = ?', 
            [tableId]
        );
        
        if (tableResult.length === 0) {
            return res.status(404).json({ message: 'Table not found' });
        }
        
        // Get players at table
        const [playersResult] = await db.execute(`
            SELECT p.player_id, p.username, p.chip_balance, p.seat_number, p.status, p.joined_at
            FROM players p
            WHERE p.table_id = ? AND p.status IN ('active', 'sitting_out')
            ORDER BY p.seat_number
        `, [tableId]);
        
        const table = {
            ...tableResult[0],
            players: playersResult,
            current_players: playersResult.length
        };
        
        res.json(table);
    } catch (error) {
        console.error('Error fetching table:', error);
        res.status(500).json({ message: 'Failed to fetch table' });
    }
});

// POST /tables - Create new table
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { name, max_players = 9, small_blind = 10, big_blind = 20, dealer_seat = 1 } = req.body;
        
        // Validate input
        if (!name || name.trim().length === 0) {
            return res.status(400).json({ message: 'Table name is required' });
        }
        
        if (max_players < 2 || max_players > 10) {
            return res.status(400).json({ message: 'Max players must be between 2 and 10' });
        }
        
        if (small_blind <= 0 || big_blind <= small_blind) {
            return res.status(400).json({ message: 'Invalid blind structure' });
        }
        
        if (dealer_seat < 1 || dealer_seat > max_players) {
            return res.status(400).json({ message: 'Dealer seat must be between 1 and max_players' });
        }
        
        // Check if table name already exists
        const [existingTable] = await db.execute(
            'SELECT table_id FROM tables WHERE name = ?', 
            [name.trim()]
        );
        
        if (existingTable.length > 0) {
            return res.status(409).json({ message: 'Table name already exists' });
        }
        
        const [result] = await db.execute(`
            INSERT INTO tables (name, max_players, small_blind, big_blind, dealer_seat, status)
            VALUES (?, ?, ?, ?, ?, 'waiting')
        `, [name.trim(), max_players, small_blind, big_blind, dealer_seat]);
        
        res.status(201).json({
            message: 'Table created successfully',
            table_id: result.insertId
        });
    } catch (error) {
        console.error('Error creating table:', error);
        res.status(500).json({ message: 'Failed to create table' });
    }
});

// PUT /tables/:tableId - Update table settings
router.put('/:tableId', authenticateToken, async (req, res) => {
    try {
        const { tableId } = req.params;
        const { name, max_players, small_blind, big_blind, dealer_seat, status } = req.body;
        
        // Check if table exists
        const [tableResult] = await db.execute(
            'SELECT * FROM tables WHERE table_id = ?', 
            [tableId]
        );
        
        if (tableResult.length === 0) {
            return res.status(404).json({ message: 'Table not found' });
        }
        
        let updateFields = [];
        let values = [];
        
        if (name) {
            updateFields.push('name = ?');
            values.push(name.trim());
        }
        if (max_players) {
            if (max_players < 2 || max_players > 10) {
                return res.status(400).json({ message: 'Max players must be between 2 and 10' });
            }
            updateFields.push('max_players = ?');
            values.push(max_players);
        }
        if (small_blind) {
            updateFields.push('small_blind = ?');
            values.push(small_blind);
        }
        if (big_blind) {
            updateFields.push('big_blind = ?');
            values.push(big_blind);
        }
        if (dealer_seat) {
            if (dealer_seat < 1 || dealer_seat > (max_players || tableResult[0].max_players)) {
                return res.status(400).json({ message: 'Dealer seat must be between 1 and max_players' });
            }
            updateFields.push('dealer_seat = ?');
            values.push(dealer_seat);
        }
        if (status) {
            if (!['waiting', 'active', 'closed'].includes(status)) {
                return res.status(400).json({ message: 'Invalid status' });
            }
            updateFields.push('status = ?');
            values.push(status);
        }
        
        if (updateFields.length === 0) {
            return res.status(400).json({ message: 'No fields to update' });
        }
        
        values.push(tableId);
        
        await db.execute(`
            UPDATE tables SET ${updateFields.join(', ')} 
            WHERE table_id = ?
        `, values);
        
        res.json({ message: 'Table updated successfully' });
    } catch (error) {
        console.error('Error updating table:', error);
        res.status(500).json({ message: 'Failed to update table' });
    }
});

// ─────────────────────────────────────────
// TABLE SEATING ENDPOINTS
// ─────────────────────────────────────────

// POST /tables/:tableId/join - Join a table (automatic seat assignment)
router.post('/:tableId/join', authenticateToken, async (req, res) => {
    try {
        const { tableId } = req.params;
        const playerId = req.user.playerId;
        
        // Start transaction
        await db.query('START TRANSACTION');
        
        try {
            // Check if table exists and get info
            const [tableResult] = await db.execute(
                'SELECT * FROM tables WHERE table_id = ? AND status != "closed"', 
                [tableId]
            );
            
            if (tableResult.length === 0) {
                await db.query('ROLLBACK');
                return res.status(404).json({ message: 'Table not found or closed' });
            }
            
            const table = tableResult[0];
            
            // Check if player is already at a table
            const [playerResult] = await db.execute(
                'SELECT table_id, chip_balance FROM players WHERE player_id = ?', 
                [playerId]
            );
            
            if (playerResult[0].table_id !== null) {
                await db.query('ROLLBACK');
                return res.status(409).json({ message: 'Already seated at a table' });
            }
            
            // Get current player count
            const [playerCount] = await db.execute(`
                SELECT COUNT(*) as count 
                FROM players 
                WHERE table_id = ? AND status IN ('active', 'sitting_out')
            `, [tableId]);
            
            if (playerCount[0].count >= table.max_players) {
                await db.query('ROLLBACK');
                return res.status(409).json({ message: 'Table is full' });
            }
            
            // Find next available seat
            const [occupiedSeats] = await db.execute(`
                SELECT seat_number 
                FROM players 
                WHERE table_id = ? AND status IN ('active', 'sitting_out')
                ORDER BY seat_number
            `, [tableId]);
            
            let nextSeat = 1;
            const occupied = occupiedSeats.map(row => row.seat_number);
            
            while (occupied.includes(nextSeat) && nextSeat <= table.max_players) {
                nextSeat++;
            }
            
            if (nextSeat > table.max_players) {
                await db.query('ROLLBACK');
                return res.status(409).json({ message: 'No available seats' });
            }
            
            // Update player to join table
            await db.execute(`
                UPDATE players 
                SET table_id = ?, seat_number = ?, status = 'active', joined_at = NOW()
                WHERE player_id = ?
            `, [tableId, nextSeat, playerId]);
            
            // Update table status if this is the first player
            if (playerCount[0].count === 0) {
                await db.execute(
                    'UPDATE tables SET status = "waiting" WHERE table_id = ?', 
                    [tableId]
                );
            }
            
            await db.query('COMMIT');
            
            // Notify via socket
            tableSocketManager.joinTable(playerId, tableId);
            
            res.json({
                message: 'Successfully joined table',
                seat_number: nextSeat,
                chip_balance: playerResult[0].chip_balance
            });
            
        } catch (error) {
            await db.query('ROLLBACK');
            throw error;
        }
        
    } catch (error) {
        console.error('Error joining table:', error);
        res.status(500).json({ message: 'Failed to join table' });
    }
});

// POST /tables/:tableId/leave - Leave a table (supports both regular and beacon requests)
router.post('/:tableId/leave', async (req, res) => {
    try {
        const { tableId } = req.params;
        
        // Handle both regular requests and beacon requests
        let token;
        if (req.body && req.body.auth) {
            token = req.body.auth.replace('Bearer ', '');
        } else if (req.headers.authorization) {
            token = req.headers.authorization.split(' ')[1];
        }
        
        if (!token) {
            return res.status(401).json({ message: 'Access token required' });
        }
        
        let user;
        try {
            user = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            return res.status(403).json({ message: 'Invalid or expired token' });
        }
        
        await leaveTableHelper(tableId, user.playerId);
        
        // Notify via socket
        tableSocketManager.leaveTable(user.playerId, tableId);
        
        res.json({ message: 'Successfully left table' });
        
    } catch (error) {
        console.error('Error leaving table:', error);
        res.status(500).json({ message: error.message || 'Failed to leave table' });
    }
});

// Helper function to leave a table
async function leaveTableHelper(tableId, playerId) {
    // Start transaction
    await db.query('START TRANSACTION');
    
    try {
        // Check if player is at this table
        const [playerResult] = await db.execute(
            'SELECT * FROM players WHERE table_id = ? AND player_id = ? AND status IN ("active", "sitting_out")', 
            [tableId, playerId]
        );
        
        if (playerResult.length === 0) {
            await db.query('ROLLBACK');
            throw new Error('Not seated at this table');
        }
        
        const player = playerResult[0];
        
        // Check if player is in an active game
        if (player.game_id !== null) {
            const [activeGame] = await db.execute(
                'SELECT game_id FROM games WHERE game_id = ? AND ended_at IS NULL', 
                [player.game_id]
            );
            
            if (activeGame.length > 0) {
                await db.query('ROLLBACK');
                throw new Error('Cannot leave table during active game');
            }
        }
        
        // Clear player's table info
        await db.execute(
            'UPDATE players SET table_id = NULL, seat_number = NULL, status = "offline" WHERE player_id = ?', 
            [playerId]
        );
        
        // Check if table is now empty and update status
        const [remainingPlayers] = await db.execute(`
            SELECT COUNT(*) as count 
            FROM players 
            WHERE table_id = ? AND status IN ('active', 'sitting_out')
        `, [tableId]);
        
        if (remainingPlayers[0].count === 0) {
            await db.execute(
                'UPDATE tables SET status = "waiting" WHERE table_id = ?', 
                [tableId]
            );
        }
        
        await db.query('COMMIT');
        
    } catch (error) {
        await db.query('ROLLBACK');
        throw error;
    }
}

// GET /tables/:tableId/players - Get all players at table
router.get('/:tableId/players', async (req, res) => {
    try {
        const { tableId } = req.params;
        
        const [players] = await db.execute(`
            SELECT 
                p.seat_number,
                p.chip_balance,
                p.status,
                p.joined_at,
                p.username,
                p.player_id
            FROM players p
            WHERE p.table_id = ? AND p.status IN ('active', 'sitting_out')
            ORDER BY p.seat_number
        `, [tableId]);
        
        res.json(players);
    } catch (error) {
        console.error('Error fetching table players:', error);
        res.status(500).json({ message: 'Failed to fetch table players' });
    }
});

// POST /tables/:tableId/sit-out - Sit out from table
router.post('/:tableId/sit-out', authenticateToken, async (req, res) => {
    try {
        const { tableId } = req.params;
        const playerId = req.user.playerId;

        const [result] = await db.execute(
            'UPDATE players SET status = "sitting_out" WHERE table_id = ? AND player_id = ? AND status = "active"',
            [tableId, playerId]
        );
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Player not actively seated at table' });
        }
        
        res.json({ message: 'Successfully sitting out' });
    } catch (error) {
        console.error('Error sitting out:', error);
        res.status(500).json({ message: 'Failed to sit out' });
    }
});

// POST /tables/:tableId/sit-in - Sit back in at table
router.post('/:tableId/sit-in', authenticateToken, async (req, res) => {
    try {
        const { tableId } = req.params;
        const playerId = req.user.playerId;
        
        const [result] = await db.execute(
            'UPDATE players SET status = "active" WHERE table_id = ? AND player_id = ? AND status = "sitting_out"', 
            [tableId, playerId]
        );
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Player not sitting out at table' });
        }
        
        res.json({ message: 'Successfully sitting back in' });
    } catch (error) {
        console.error('Error sitting back in:', error);
        res.status(500).json({ message: 'Failed to sit back in' });
    }
});

// PUT /tables/:tableId/chip-stack - Update chip balance (add more chips)
router.put('/:tableId/chip-stack', authenticateToken, async (req, res) => {
    try {
        const { tableId } = req.params;
        const { additional_chips } = req.body;
        const playerId = req.user.playerId;
        
        if (!additional_chips || additional_chips <= 0) {
            return res.status(400).json({ message: 'Invalid chip amount' });
        }
        
        // Check if player is at table
        const [playerResult] = await db.execute(
            'SELECT * FROM players WHERE table_id = ? AND player_id = ? AND status IN ("active", "sitting_out")', 
            [tableId, playerId]
        );
        
        if (playerResult.length === 0) {
            return res.status(404).json({ message: 'Not seated at this table' });
        }
        
        // Update chip balance
        await db.execute(
            'UPDATE players SET chip_balance = chip_balance + ? WHERE player_id = ?', 
            [additional_chips, playerId]
        );
        
        res.json({
            message: 'Chip balance updated successfully',
            chips_added: additional_chips
        });
        
    } catch (error) {
        console.error('Error updating chip balance:', error);
        res.status(500).json({ message: 'Failed to update chip balance' });
    }
});

module.exports = router;
