const db = require('../db/db');
const jwt = require('jsonwebtoken');
const express = require('express');
const router = express.Router();
const tableSocketManager = require('../server-sockets/tablesockets');
const gameSocketManager = require('../server-sockets/gamesockets');
const { 
    ServerToPlayerMessage,
    ServerToTableMessage,
    PackageType
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

// POST /tables - Create new table with socket notification
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { name, max_players = 9, small_blind = 10, big_blind = 20, dealer_seat = 1 } = req.body;
        const creatorPlayerId = req.user.playerId;
        
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
            INSERT INTO tables (name, max_players, small_blind, big_blind, dealer_seat)
            VALUES (?, ?, ?, ?, ?)
        `, [name.trim(), max_players, small_blind, big_blind, dealer_seat]);
        
        const newTableId = result.insertId;
        
        // Notify all connected players about new table via broadcast
        tableSocketManager.broadcast(`New table "${name.trim()}" has been created`);
        
        res.status(201).json({
            message: 'Table created successfully',
            table_id: newTableId
        });
        
    } catch (error) {
        console.error('Error creating table:', error);
        res.status(500).json({ message: 'Failed to create table' });
    }
});

// PUT /tables/:tableId - Update table settings with socket notifications
router.put('/:tableId', authenticateToken, async (req, res) => {
    try {
        const { tableId } = req.params;
        const { name, max_players, small_blind, big_blind, dealer_seat } = req.body;
        
        // Check if table exists
        const [tableResult] = await db.execute(
            'SELECT * FROM tables WHERE table_id = ?', 
            [tableId]
        );
        
        if (tableResult.length === 0) {
            return res.status(404).json({ message: 'Table not found' });
        }
        
        const oldTable = tableResult[0];
        let updateFields = [];
        let values = [];
        let changeMessages = [];
        
        if (name && name !== oldTable.name) {
            updateFields.push('name = ?');
            values.push(name.trim());
            changeMessages.push(`Table name changed to "${name.trim()}"`);
        }
        if (max_players && max_players !== oldTable.max_players) {
            if (max_players < 2 || max_players > 10) {
                return res.status(400).json({ message: 'Max players must be between 2 and 10' });
            }
            updateFields.push('max_players = ?');
            values.push(max_players);
            changeMessages.push(`Max players changed to ${max_players}`);
        }
        if (small_blind && small_blind !== oldTable.small_blind) {
            updateFields.push('small_blind = ?');
            values.push(small_blind);
            changeMessages.push(`Small blind changed to ${small_blind}`);
        }
        if (big_blind && big_blind !== oldTable.big_blind) {
            updateFields.push('big_blind = ?');
            values.push(big_blind);
            changeMessages.push(`Big blind changed to ${big_blind}`);
        }
        if (dealer_seat && dealer_seat !== oldTable.dealer_seat) {
            const maxPlayers = max_players || oldTable.max_players;
            if (dealer_seat < 1 || dealer_seat > maxPlayers) {
                return res.status(400).json({ message: 'Dealer seat must be between 1 and max_players' });
            }
            updateFields.push('dealer_seat = ?');
            values.push(dealer_seat);
            changeMessages.push(`Dealer seat moved to ${dealer_seat}`);
        }

        
        if (updateFields.length === 0) {
            return res.status(400).json({ message: 'No fields to update' });
        }
        
        values.push(tableId);
        
        await db.execute(`
            UPDATE tables SET ${updateFields.join(', ')} 
            WHERE table_id = ?
        `, values);
        
        // Notify players at table of changes
        if (changeMessages.length > 0) {
            const message = `Table updated: ${changeMessages.join(', ')}`;
            tableSocketManager.sendToTable(tableId, message);
        }
        
        res.json({ message: 'Table updated successfully' });
        
    } catch (error) {
        console.error('Error updating table:', error);
        res.status(500).json({ message: 'Failed to update table' });
    }
});

// ─────────────────────────────────────────
// TABLE SEATING ENDPOINTS
// ─────────────────────────────────────────

// POST /tables/:tableId/join - Join a table with comprehensive socket integration
router.post('/:tableId/join', authenticateToken, async (req, res) => {
    try {
        const { tableId } = req.params;
        const playerId = req.user.playerId;
        const playerName = req.user.username || `Player ${playerId}`;
        
        // Start transaction
        await db.query('START TRANSACTION');
        
        try {
            // Check if table exists and get info
            const [tableResult] = await db.execute(
            'SELECT * FROM tables WHERE table_id = ?', 
            [tableId]
            );
            
            if (tableResult.length === 0) {
                await db.query('ROLLBACK');
                return res.status(404).json({ message: 'Table not found or closed' });
            }
            
            const table = tableResult[0];
            
            // Check if player is already at a table
            const [playerResult] = await db.execute(
                'SELECT table_id, chip_balance, username FROM players WHERE player_id = ?', 
                [playerId]
            );
            
            if (playerResult.length === 0) {
                await db.query('ROLLBACK');
                return res.status(404).json({ message: 'Player not found' });
            }
            
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
            

            
            await db.query('COMMIT');
            
            // Socket integration: Join table room and notify other players
            tableSocketManager.joinTable(playerId, tableId);
            
            // Notify table of new player (excluding the joining player)
            tableSocketManager.sendToTable(tableId, `${playerName} has joined the table at seat ${nextSeat}`);
            
            // Send welcome message to joining player
            tableSocketManager.sendToPlayer(playerId, `Welcome to table "${table.name}"! You are seated at position ${nextSeat}`);
            
            // Check if enough players to potentially start a game
            if (playerCount[0].count + 1 >= 2) {
                tableSocketManager.sendToTable(tableId, `Table now has ${playerCount[0].count + 1} players - ready to start games!`);
            }
            
            res.json({
                message: 'Successfully joined table',
                seat_number: nextSeat,
                chip_balance: playerResult[0].chip_balance,
                table_name: table.name
            });
            
        } catch (error) {
            await db.query('ROLLBACK');
            throw error;
        }
        
    } catch (error) {
        console.error('Error joining table:', error);
        
        // Send error to player via socket if possible
        const playerId = req.user?.playerId;
        if (playerId) {
            const playerSocket = tableSocketManager.getSocket(playerId);
            if (playerSocket) {
                tableSocketManager.sendToPlayer(playerId, 'Failed to join table - please try again');
            }
        }
        
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

// Helper function to leave a table with socket notifications
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
        const playerName = player.username || `Player ${playerId}`;
        const seatNumber = player.seat_number;
        
        // Check if player is in an active game
        if (player.game_id !== null) {
            const [activeGame] = await db.execute(
                'SELECT game_id FROM gamestate WHERE game_id = ? AND stage NOT IN ("game_over", "waiting")', 
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
        
        // Check remaining players count for notifications
        const [remainingPlayers] = await db.execute(`
            SELECT COUNT(*) as count 
            FROM players 
            WHERE table_id = ? AND status IN ('active', 'sitting_out')
        `, [tableId]);
        
        await db.query('COMMIT');
        
        // Socket notifications: Leave table room and notify remaining players
        tableSocketManager.leaveTable(playerId, tableId);
        
        // Notify remaining players at table 
        if (remainingPlayers[0].count > 0) {
            tableSocketManager.sendToTable(tableId, `${playerName} has left seat ${seatNumber}`);
        }
        
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

// POST /tables/:tableId/sit-out - Sit out from table with notifications
router.post('/:tableId/sit-out', authenticateToken, async (req, res) => {
    try {
        const { tableId } = req.params;
        const playerId = req.user.playerId;
        const playerName = req.user.username || `Player ${playerId}`;

        const [result] = await db.execute(
            'UPDATE players SET status = "sitting_out" WHERE table_id = ? AND player_id = ? AND status = "active"',
            [tableId, playerId]
        );
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Player not actively seated at table' });
        }
        
        // Notify table of player sitting out
        tableSocketManager.sendToTable(tableId, `${playerName} is now sitting out`);
        
        res.json({ message: 'Successfully sitting out' });
    } catch (error) {
        console.error('Error sitting out:', error);
        res.status(500).json({ message: 'Failed to sit out' });
    }
});

// POST /tables/:tableId/sit-in - Sit back in at table with notifications
router.post('/:tableId/sit-in', authenticateToken, async (req, res) => {
    try {
        const { tableId } = req.params;
        const playerId = req.user.playerId;
        const playerName = req.user.username || `Player ${playerId}`;
        
        const [result] = await db.execute(
            'UPDATE players SET status = "active" WHERE table_id = ? AND player_id = ? AND status = "sitting_out"', 
            [tableId, playerId]
        );
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Player not sitting out at table' });
        }
        
        // Notify table of player sitting back in
        tableSocketManager.sendToTable(tableId, `${playerName} is back in the game!`);
        
        res.json({ message: 'Successfully sitting back in' });
    } catch (error) {
        console.error('Error sitting back in:', error);
        res.status(500).json({ message: 'Failed to sit back in' });
    }
});

// PUT /tables/:tableId/chip-stack - Update chip balance with notifications
router.put('/:tableId/chip-stack', authenticateToken, async (req, res) => {
    try {
        const { tableId } = req.params;
        const { additional_chips } = req.body;
        const playerId = req.user.playerId;
        const playerName = req.user.username || `Player ${playerId}`;
        
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
        
        const oldBalance = playerResult[0].chip_balance;
        
        // Update chip balance
        await db.execute(
            'UPDATE players SET chip_balance = chip_balance + ? WHERE player_id = ?', 
            [additional_chips, playerId]
        );
        
        const newBalance = oldBalance + additional_chips;
        
        // Notify table of chip stack update
        tableSocketManager.sendToTable(tableId, `${playerName} added ${additional_chips} chips (now has ${newBalance} chips)`);
        
        res.json({
            message: 'Chip balance updated successfully',
            chips_added: additional_chips,
            new_balance: newBalance
        });
        
    } catch (error) {
        console.error('Error updating chip balance:', error);
        res.status(500).json({ message: 'Failed to update chip balance' });
    }
});

// POST /tables/:tableId/message - Send message to table (table chat)
router.post('/:tableId/message', authenticateToken, async (req, res) => {
    try {
        const { tableId } = req.params;
        const { message } = req.body;
        const playerId = req.user.playerId;
        const playerName = req.user.username || `Player ${playerId}`;
        
        if (!message || typeof message !== 'string' || message.trim().length === 0) {
            return res.status(400).json({ message: 'Valid message is required' });
        }
        
        // Check if player is at this table
        const [playerResult] = await db.execute(
            'SELECT seat_number FROM players WHERE table_id = ? AND player_id = ? AND status IN ("active", "sitting_out")', 
            [tableId, playerId]
        );
        
        if (playerResult.length === 0) {
            return res.status(403).json({ message: 'Must be seated at table to send messages' });
        }
        
        const seatNumber = playerResult[0].seat_number;
        
        // Send message to all players at table using socket manager
        tableSocketManager.sendPlayerToTable(playerId, `${playerName} (Seat ${seatNumber}): ${message.trim()}`);
        
        res.json({ message: 'Message sent successfully' });
        
    } catch (error) {
        console.error('Error sending table message:', error);
        res.status(500).json({ message: 'Failed to send message' });
    }
});

module.exports = router;
