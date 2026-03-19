const { 
    PackageType,
    ServerToPlayerMessage, 
    ServerToTableMessage, 
    PlayerToPlayerMessage,
    createFromJSON
} = require('../datapacks/schema');

/**
 * TableSocketManager - Socket.IO wrapper for table-related communications
 */
class TableSocketManager {
    constructor() {
        this.tables = new Map(); // table_id -> Set of socket ids
        this.playerSockets = new Map(); // player_id -> socket id
        this.socketPlayers = new Map(); // socket id -> player_id
        this.playerTables = new Map(); // player_id -> table_id
    }

    init(io) {
        this.io = io;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Connection Management
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Register a player's socket connection
     */
    registerPlayer(socket, playerId) {
        const pid = Number(playerId);
        this.playerSockets.set(pid, socket.id);
        this.socketPlayers.set(socket.id, pid);
        console.log(`[SOCKET:table] Registered player ${pid} → socket ${socket.id}`);
        socket.on('disconnect', () => this.handleDisconnect(socket));
    }

    /**
     * Handle player disconnect - clean up all references
     */
    handleDisconnect(socket) {
        const playerId = this.socketPlayers.get(socket.id);
        if (!playerId) return;

        const tableId = this.playerTables.get(playerId);
        console.log(`[SOCKET:table] Player ${playerId} disconnected (table=${tableId || 'none'})`);
        if (tableId) {
            this.leaveTable(playerId, tableId);
        }

        this.playerSockets.delete(playerId);
        this.socketPlayers.delete(socket.id);
    }

    /**
     * Get socket by player ID
     */
    getSocket(playerId) {
        const pid = Number(playerId);
        const socketId = this.playerSockets.get(pid);
        return socketId ? this.io.sockets.sockets.get(socketId) : null;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Table Management
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Add player to a table room
     */
    joinTable(playerId, tableId) {
        const pid = Number(playerId);
        const socket = this.getSocket(pid);
        if (!socket) {
            console.error(`Cannot join table ${tableId}: No socket found for player ${pid}`);
            return false;
        }

        // Leave current table if in one
        const currentTable = this.playerTables.get(pid);
        if (currentTable) {
            console.log(`Player ${pid} leaving table ${currentTable} to join ${tableId}`);
            this.leaveTable(pid, currentTable);
        }

        // Join new table
        socket.join(`table:${tableId}`);
        this.playerTables.set(pid, tableId);

        if (!this.tables.has(tableId)) {
            this.tables.set(tableId, new Set());
        }
        this.tables.get(tableId).add(pid);

        console.log(`[SOCKET:table] Player ${pid} joined table ${tableId} (${this.tables.get(tableId).size} players in room)`);

        // Notify table of new player
        this.sendToTable(tableId, `Player ${pid} has joined the table`);
        
        return true;
    }

    /**
     * Remove player from a table room
     */
    leaveTable(playerId, tableId) {
        const pid = Number(playerId);
        const socket = this.getSocket(pid);
        if (!socket) return false;

        socket.leave(`table:${tableId}`);
        this.playerTables.delete(pid);

        const tableMembers = this.tables.get(tableId);
        if (tableMembers) {
            tableMembers.delete(pid);
            if (tableMembers.size === 0) {
                this.tables.delete(tableId);
            }
        }

        console.log(`[SOCKET:table] Player ${pid} left table ${tableId}`);
        // Notify table of player leaving
        this.sendToTable(tableId, `Player ${pid} has left the table`);

        return true;
    }

    /**
     * Get all players at a table
     */
    getTablePlayers(tableId) {
        return Array.from(this.tables.get(tableId) || []);
    }

    /**
     * Get player's current table
     */
    getPlayerTable(playerId) {
        return this.playerTables.get(playerId);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Messaging - Server to Client
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Send a message to a specific player
     */
    sendToPlayer(playerId, message) {
        const socket = this.getSocket(playerId);
        if (!socket) return false;

        const packet = new ServerToPlayerMessage({
            player_id: playerId,
            message: message
        });

        socket.emit(PackageType.SERVER_TO_PLAYER_MESSAGE, packet);
        return true;
    }

    /**
     * Send a message to all players at a table
     */
    sendToTable(tableId, message) {
        const packet = new ServerToTableMessage({
            table_id: tableId,
            message: message
        });

        this.io.to(`table:${tableId}`).emit(PackageType.SERVER_TO_TABLE_MESSAGE, packet);
        return true;
    }

    /**
     * Broadcast a message to all connected players
     */
    broadcast(message) {
        const packet = new ServerToTableMessage({
            table_id: 'global',
            message: message
        });

        this.io.emit(PackageType.SERVER_TO_TABLE_MESSAGE, packet);
        return true;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Messaging - Player to Player
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Relay a message from one player to another
     */
    sendPlayerToPlayer(fromPlayerId, toPlayerId, message) {
        const toSocket = this.getSocket(toPlayerId);
        if (!toSocket) return false;

        const packet = new PlayerToPlayerMessage({
            from_player_id: fromPlayerId,
            to_player_id: toPlayerId,
            message: message
        });

        toSocket.emit(PackageType.PLAYER_TO_PLAYER_MESSAGE, packet);
        return true;
    }

    /**
     * Relay a message from one player to entire table (chat)
     */
    sendPlayerToTable(fromPlayerId, message) {
        const tableId = this.playerTables.get(fromPlayerId);
        if (!tableId) return false;

        const tablePlayers = this.getTablePlayers(tableId);
        
        tablePlayers.forEach(playerId => {
            if (playerId !== fromPlayerId) {
                this.sendPlayerToPlayer(fromPlayerId, playerId, message);
            }
        });

        return true;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Raw Emit - For custom packets
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Emit a raw packet to a specific player
     */
    emitToPlayer(playerId, eventType, data) {
        const socket = this.getSocket(playerId);
        if (!socket) return false;

        socket.emit(eventType, data);
        return true;
    }

    /**
     * Emit a raw packet to all players at a table
     */
    emitToTable(tableId, eventType, data) {
        this.io.to(`table:${tableId}`).emit(eventType, data);
        return true;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Setup Listeners
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Setup default socket listeners for a connected socket
     */
    setupListeners(socket, playerId) {
        this.registerPlayer(socket, playerId);

        // Handle join table requests
        socket.on('join_table', (tableId) => {
            this.joinTable(playerId, tableId);
        });

        // Handle leave table requests
        socket.on('leave_table', () => {
            const tableId = this.playerTables.get(playerId);
            if (tableId) {
                this.leaveTable(playerId, tableId);
            }
        });

        // Handle player-to-player messages (with schema validation)
        socket.on(PackageType.PLAYER_TO_PLAYER_MESSAGE, (data) => {
            try {
                // Validate using schema
                const packet = createFromJSON(data);
                if (packet.from_player_id === playerId) {
                    this.sendPlayerToPlayer(playerId, packet.to_player_id, packet.message);
                }
            } catch (error) {
                console.error('Invalid player-to-player message:', error);
            }
        });

        // Handle player-to-table messages (chat) with validation
        socket.on('player_table_chat', (data) => {
            if (data && typeof data.message === 'string') {
                this.sendPlayerToTable(playerId, data.message);
            } else {
                console.error('Invalid player table chat message:', data);
            }
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Schema Validation Helpers
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Validate and emit a packet using schema
     */
    emitValidatedPacket(socket, packet) {
        try {
            if (packet && packet.type) {
                socket.emit(packet.type, packet);
                return true;
            } else {
                console.error('Invalid packet structure:', packet);
                return false;
            }
        } catch (error) {
            console.error('Error emitting packet:', error);
            return false;
        }
    }

    /**
     * Broadcast validated packet to table
     */
    broadcastValidatedPacket(tableId, packet) {
        try {
            if (packet && packet.type) {
                this.io.to(`table:${tableId}`).emit(packet.type, packet);
                return true;
            } else {
                console.error('Invalid packet structure:', packet);
                return false;
            }
        } catch (error) {
            console.error('Error broadcasting packet:', error);
            return false;
        }
    }
}

// Export singleton instance
module.exports = new TableSocketManager();
