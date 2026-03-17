# Poker App Communication Guide

## Overview
This guide explains the clean communication setup between your thin client and server using structured data packages from `schema.js`.

## Architecture Principles

### Thin Client
- **Minimal Logic**: Client handles only UI updates and user input
- **Server-Driven**: All game computations happen on server
- **Structured Communication**: Uses schema.js classes for all data exchange

### Schema-Based Communication
- **Type Safety**: All messages use predefined schema classes
- **Validation**: Both encoding and decoding use schema structures
- **Consistency**: Field names and data structures are standardized

## File Structure

```
datapacks/
├── schema.js           # Data package definitions
server-sockets/
├── gamesockets.js      # Game-related server communications
├── tablesockets.js     # Table/player management communications
public/javascript/
├── socket-client.js    # Thin client socket handler
```

## Communication Patterns

### 1. Server Action Requests

**Server → Client**: Request player action
```javascript
// Server (using gamesockets.js)
gameSocketManager.requestCheck(socket, {
    game_id: 'game123',
    player_id: 'player456', 
    seat: 3,
    min_raise: 50
});
```

**Client Response**: Via API calls (not socket), keeping client thin

### 2. Game State Updates

**Server → Client**: Full game state
```javascript
// Server 
gameSocketManager.sendGameState('table123', {
    game_id: 'game123',
    table_id: 'table123',
    // ... full game state
});
```

**Client**: Updates UI through `window.pokerGameInstance`

### 3. Error Handling

**Server → Client**: Error messages
```javascript
// Server
gameSocketManager.sendError(socket, 'Invalid bet amount', 'game123', 'player456');
```

**Client**: Displays error through UI component

## Key Schema Classes

### Action Requests
- `ServerRequestCheck` - No bet to call (check/raise/allin)  
- `ServerRequestCall` - Bet exists (call/raise/fold/allin)

### Game Updates
- `GameState` - Complete game state
- `ServerUpdateLastAction` - Player action announcement
- `ServerUpdateStageProgression` - Flop/turn/river progression
- `ServerUpdateGameEnd` - Hand completion with winner

### Communication
- `ErrorMessage` - Error notifications
- `ActionResponse` - Action success/failure feedback
- `RequestGameState` - Client requests state refresh

## Usage Examples

### Server-Side Game Logic
```javascript
const gameSocket = require('./server-sockets/gamesockets');
const { GameState } = require('./datapacks/schema');

// Request action from player
gameSocket.requestCall(playerSocket, {
    game_id: currentGame.id,
    player_id: currentPlayer.id,
    seat: currentPlayer.seat,
    min_raise: 100,
    to_call: 50
});

// Send updated game state
const gameState = new GameState({
    game_id: currentGame.id,
    table_id: currentGame.table_id,
    // ... game data
});
gameSocket.sendGameStateToPlayer(playerSocket, gameState);
```

### Client-Side Response
```javascript
// Client automatically receives and processes via socket-client.js
// UI updates happen through window.pokerGameInstance

// To request game state refresh:
window.requestGameState();

// Schema validation happens automatically
```

## Error Handling

### Server Validation
```javascript
// Server validates before sending
if (!packet.game_id || !packet.player_id) {
    gameSocket.sendError(socket, 'Invalid game data');
    return;
}
```

### Client Validation  
```javascript
// Client validates received packets
socket.on('server_request_check', (packet) => {
    if (!packet.game_id || !packet.player_id || packet.seat === undefined) {
        console.error('Invalid server_request_check packet:', packet);
        return;
    }
    // Process valid packet...
});
```

## Benefits

1. **Type Safety**: Schema classes prevent field name mismatches
2. **Validation**: Automatic encoding/decoding with error handling
3. **Thin Client**: Server handles all game logic and state management
4. **Clean Separation**: Clear boundaries between client presentation and server logic
5. **Maintainable**: Centralized data structures in schema.js
6. **Extensible**: Easy to add new message types and fields

## Next Steps

1. Include `schema.js` in your HTML or bundle it for browser use
2. Initialize socket managers in your server startup code
3. Connect your game logic to use the socket managers
4. Update your UI components to work with the thin client approach

The communication layer is now clean, validated, and ready for your poker game implementation.