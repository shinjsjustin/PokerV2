// Example integration showing how to properly initialize and use 
// the communication components in your poker server

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

// Import communication managers
const gameSocketManager = require('./server-sockets/gamesockets');
const tableSocketManager = require('./server-sockets/tablesockets');
const { PackageType } = require('./datapacks/schema');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Initialize socket managers
gameSocketManager.init(io);
tableSocketManager.init(io);

// Socket connection handler
io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);
    
    // Get player ID from authentication/session
    const playerId = getPlayerIdFromSocket(socket); // Your auth logic here
    
    if (!playerId) {
        socket.disconnect();
        return;
    }
    
    // Setup table management listeners
    tableSocketManager.setupListeners(socket, playerId);
    
    // Setup game state request handler
    gameSocketManager.setupListener(socket, (data, socket) => {
        // Handle game state requests
        handleGameStateRequest(data, socket, playerId);
    });
    
    // Example: Player joins a table
    socket.on('join_game_table', (tableId) => {
        // Validate table exists and player can join
        if (validateTableAccess(playerId, tableId)) {
            tableSocketManager.joinTable(playerId, tableId);
            
            // Send current game state if game is active
            const gameState = getGameStateForTable(tableId);
            if (gameState) {
                gameSocketManager.sendGameStateToPlayer(socket, gameState);
            }
        } else {
            gameSocketManager.sendError(socket, 'Cannot join this table');
        }
    });
    
    socket.on('disconnect', () => {
        console.log('Player disconnected:', playerId);
        // Cleanup handled automatically by tableSocketManager
    });
});

// Example game logic integration
function startPlayerTurn(gameId, playerId, seat) {
    const socket = tableSocketManager.getSocket(playerId);
    if (!socket) return;
    
    const gameState = getGameState(gameId);
    const currentBet = gameState.current_bet;
    const playerBet = gameState.bets.find(b => b.seat === seat)?.bet_amount || 0;
    const toCall = currentBet - playerBet;
    
    if (toCall > 0) {
        // Player needs to call
        gameSocketManager.requestCall(socket, {
            game_id: gameId,
            player_id: playerId,
            seat: seat,
            min_raise: currentBet * 2,
            to_call: toCall
        });
    } else {
        // Player can check
        gameSocketManager.requestCheck(socket, {
            game_id: gameId,
            player_id: playerId, 
            seat: seat,
            min_raise: gameState.big_blind
        });
    }
}

function processPlayerAction(gameId, playerId, action, amount = 0) {
    try {
        const gameState = getGameState(gameId);
        const player = gameState.aggrounds.find(p => p.player_id === playerId);
        
        if (!player) {
            const socket = tableSocketManager.getSocket(playerId);
            if (socket) {
                gameSocketManager.sendError(socket, 'Player not found in game');
            }
            return;
        }
        
        // Process action in your game engine
        const result = processGameAction(gameId, player.seat, action, amount);
        
        if (result.success) {
            // Broadcast action to table
            gameSocketManager.sendLastAction(gameState.table_id, {
                game_id: gameId,
                seat: player.seat,
                bet_amount: amount,
                allin: result.allin,
                folded: result.folded
            });
            
            // Send updated game state
            const updatedGameState = getGameState(gameId);
            gameSocketManager.sendGameState(gameState.table_id, updatedGameState);
            
            // Send success response to player
            const socket = tableSocketManager.getSocket(playerId);
            if (socket) {
                gameSocketManager.sendActionResponse(socket, true, null, gameId, playerId);
            }
        } else {
            // Send error to player
            const socket = tableSocketManager.getSocket(playerId);
            if (socket) {
                gameSocketManager.sendActionResponse(socket, false, result.error, gameId, playerId);
            }
        }
        
    } catch (error) {
        console.error('Error processing player action:', error);
        const socket = tableSocketManager.getSocket(playerId);
        if (socket) {
            gameSocketManager.sendError(socket, 'Server error processing action');
        }
    }
}

function handleGameStateRequest(data, socket, playerId) {
    try {
        if (!data.game_id) {
            gameSocketManager.sendError(socket, 'Game ID required');
            return;
        }
        
        const gameState = getGameState(data.game_id);
        if (!gameState) {
            gameSocketManager.sendError(socket, 'Game not found');
            return;
        }
        
        // Verify player is in this game
        const playerInGame = gameState.aggrounds.some(p => p.player_id === playerId);
        if (!playerInGame) {
            gameSocketManager.sendError(socket, 'You are not in this game');
            return;
        }
        
        // Send game state to requesting player
        gameSocketManager.sendGameStateToPlayer(socket, gameState);
        
    } catch (error) {
        console.error('Error handling game state request:', error);
        gameSocketManager.sendError(socket, 'Error retrieving game state');
    }
}

// Helper functions (implement based on your database/game engine)
function getPlayerIdFromSocket(socket) {
    // Extract player ID from session, JWT, etc.
    return socket.handshake.auth?.playerId || socket.handshake.query?.playerId;
}

function validateTableAccess(playerId, tableId) {
    // Check if player can access this table
    return true; // Implement your validation logic
}

function getGameStateForTable(tableId) {
    // Get current game state for table
    return null; // Implement with your database
}

function getGameState(gameId) {
    // Get game state by game ID  
    return null; // Implement with your database
}

function processGameAction(gameId, seat, action, amount) {
    // Process the action with your game engine
    return { success: true, allin: false, folded: false };
}

server.listen(3000, () => {
    console.log('Poker server listening on port 3000');
    console.log('Communication system initialized with schema validation');
});

module.exports = { app, server, io };