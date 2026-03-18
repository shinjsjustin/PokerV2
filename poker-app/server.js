const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const session = require('express-session');
const dotenv = require('dotenv');
const { router: authRoutes } = require('./routes/userauth');
const tablesRoutes = require('./routes/tables');
const gameRoutes = require('./routes/game');
const tableSocketManager = require('./server-sockets/tablesockets');
const gameSocketManager = require('./server-sockets/gamesockets');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// Initialize socket managers
tableSocketManager.init(io);
gameSocketManager.init(io);

// Middleware
app.use(cors({
  origin: process.env.CLIENT_URL || "http://localhost:3000",
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-session-secret-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

io.on('connection', (socket) => {
  console.log('a user connected:', socket.id);
  
  // Player registers after authenticating on client side
  socket.on('register_player', (playerId) => {
    tableSocketManager.setupListeners(socket, playerId);
    
    // Setup game socket listener for game state requests
    gameSocketManager.setupListener(socket, async (data, requestSocket) => {
      console.log('Game state requested:', data);
      
      if (data && data.game_id) {
        try {
          // Fetch current game state from database
          const [gameRows] = await require('./db/db').execute(`
            SELECT g.*, t.name as table_name, t.small_blind
            FROM gamestate g
            JOIN tables t ON g.table_id = t.table_id
            WHERE g.game_id = ?
          `, [data.game_id]);
          
          if (gameRows.length > 0) {
            const game = gameRows[0];
            const bets = typeof game.bets === 'string' ? JSON.parse(game.bets) : (game.bets || []);
            const communityCards = typeof game.community_cards === 'string' ? JSON.parse(game.community_cards) : (game.community_cards || []);
            
            // Get players for this game
            const [playerRows] = await require('./db/db').execute(`
              SELECT player_id, username, seat_number, chip_balance, current_bet
              FROM players
              WHERE game_id = ?
              ORDER BY seat_number
            `, [data.game_id]);
            
            const gameStateData = {
              game_id: game.game_id,
              table_id: game.table_id,
              tableName: game.table_name,
              smallBlind: game.small_blind,
              bigBlind: game.big_blind,
              pot: game.pot,
              current_bet: game.current_bet,
              stage: game.stage,
              dealerSeat: game.dealer_seat,
              activePlayerId: playerRows.find(p => p.seat_number === game.hot_seat)?.player_id || null,
              community_cards: communityCards,
              players: playerRows.map(p => {
                const bet = bets.find(b => b.seat === p.seat_number) || {};
                return {
                  player_id: p.player_id,
                  username: p.username,
                  seat_number: p.seat_number,
                  chip_balance: p.chip_balance,
                  current_bet: bet.bet_amount || 0,
                  is_folded: bet.folded || false,
                  is_all_in: bet.allin || false,
                  hole_cards: null // Don't expose hole cards in broadcast
                };
              })
            };
            
            // Send game state to requesting player
            gameSocketManager.sendGameStateToPlayer(requestSocket, gameStateData);
            console.log(`Sent game state for game ${data.game_id} to player ${data.player_id || 'unknown'}`);
          }
        } catch (error) {
          console.error('Error handling game state request:', error);
          gameSocketManager.sendError(requestSocket, 'Failed to fetch game state', data.game_id, data.player_id);
        }
      }
    });
    
    console.log(`Player ${playerId} registered with socket ${socket.id}`);
  });
  
  socket.on('disconnect', () => console.log('user disconnected:', socket.id));
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/tables', tablesRoutes);
app.use('/api/games', gameRoutes);

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Something went wrong!' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Poker app running on http://localhost:${PORT}`);
  console.log('Environment:', process.env.NODE_ENV || 'development');
});