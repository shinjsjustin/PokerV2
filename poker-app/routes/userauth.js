const db = require('../db/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const express = require('express');
const router = express.Router();

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

// Register new user
router.post('/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;

        // Validate input
        if (!username || !email || !password) {
            return res.status(400).json({ 
                message: 'Username, email, and password are required' 
            });
        }

        if (password.length < 6) {
            return res.status(400).json({ 
                message: 'Password must be at least 6 characters long' 
            });
        }

        // Check if player already exists
        const [existingPlayers] = await db.execute(
            'SELECT player_id FROM players WHERE username = ? OR email = ?',
            [username, email]
        );

        if (existingPlayers.length > 0) {
            return res.status(400).json({ 
                message: 'Username or email already exists' 
            });
        }

        // Hash password
        const saltRounds = 12;
        const password_hash = await bcrypt.hash(password, saltRounds);

        // Insert new player
        const [result] = await db.execute(
            'INSERT INTO players (username, email, password_hash) VALUES (?, ?, ?)',
            [username, email, password_hash]
        );

        // Generate JWT token
        const token = jwt.sign(
            { 
                playerId: result.insertId, 
                username: username,
                email: email 
            },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        // Set session
        req.session.playerId = result.insertId;
        req.session.username = username;

        res.status(201).json({
            message: 'Player registered successfully',
            token: token,
            player: {
                player_id: result.insertId,
                username: username,
                email: email
            }
        });

    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ 
            message: 'Internal server error during registration' 
        });
    }
});

// Login user
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        // Validate input
        if (!username || !password) {
            return res.status(400).json({ 
                message: 'Username and password are required' 
            });
        }

        // Find player (allow login with username or email)
        const [players] = await db.execute(
            'SELECT player_id, username, email, password_hash, chip_balance FROM players WHERE username = ? OR email = ?',
            [username, username]
        );

        if (players.length === 0) {
            return res.status(401).json({ 
                message: 'Invalid credentials' 
            });
        }

        const player = players[0];

        // Verify password
        const isValidPassword = await bcrypt.compare(password, player.password_hash);
        if (!isValidPassword) {
            return res.status(401).json({ 
                message: 'Invalid credentials' 
            });
        }

        // Generate JWT token
        const token = jwt.sign(
            { 
                playerId: player.player_id, 
                username: player.username,
                email: player.email 
            },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        // Set session
        req.session.playerId = player.player_id;
        req.session.username = player.username;

        res.json({
            message: 'Login successful',
            token: token,
            player: {
                player_id: player.player_id,
                username: player.username,
                email: player.email,
                chip_balance: player.chip_balance
            }
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ 
            message: 'Internal server error during login' 
        });
    }
});

// Logout user
router.post('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.status(500).json({ 
                message: 'Could not log out, please try again' 
            });
        }
        res.clearCookie('connect.sid'); // Clear the session cookie
        res.json({ message: 'Logout successful' });
    });
});

// Get current player profile (protected route)
router.get('/profile', authenticateToken, async (req, res) => {
    try {
        const [players] = await db.execute(
            'SELECT player_id, username, email, chip_balance, created_at FROM players WHERE player_id = ?',
            [req.user.playerId]
        );

        if (players.length === 0) {
            return res.status(404).json({ 
                message: 'Player not found' 
            });
        }

        res.json({
            player: players[0]
        });

    } catch (error) {
        console.error('Profile fetch error:', error);
        res.status(500).json({ 
            message: 'Internal server error' 
        });
    }
});

// Verify token endpoint
router.get('/verify', authenticateToken, (req, res) => {
    res.json({
        message: 'Token is valid',
        player: {
            playerId: req.user.playerId,
            username: req.user.username,
            email: req.user.email
        }
    });
});

// Add balance endpoint
router.post('/add-balance', authenticateToken, async (req, res) => {
    try {
        const { amount } = req.body;
        const playerId = req.user.playerId;

        // Validate amount
        if (!amount || amount <= 0 || !Number.isInteger(amount)) {
            return res.status(400).json({ 
                message: 'Amount must be a positive integer' 
            });
        }

        if (amount > 10000) {
            return res.status(400).json({ 
                message: 'Maximum add amount is $10,000' 
            });
        }

        // Update player's chip balance
        const [result] = await db.execute(
            'UPDATE players SET chip_balance = chip_balance + ? WHERE player_id = ?',
            [amount, playerId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ 
                message: 'Player not found' 
            });
        }

        // Get updated balance
        const [players] = await db.execute(
            'SELECT chip_balance FROM players WHERE player_id = ?',
            [playerId]
        );

        const newBalance = players[0].chip_balance;

        res.json({
            message: `Successfully added $${amount} to your balance`,
            chip_balance: newBalance,
            amount_added: amount
        });

    } catch (error) {
        console.error('Add balance error:', error);
        res.status(500).json({ 
            message: 'Internal server error while adding balance' 
        });
    }
});

module.exports = { router, authenticateToken };

