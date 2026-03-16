const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const session = require('express-session');
const dotenv = require('dotenv');
const { router: authRoutes } = require('./routes/userauth');
const tableSocketManager = require('./server-sockets/tablesockets');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// Initialize socket manager
tableSocketManager.init(io);

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
    console.log(`Player ${playerId} registered with socket ${socket.id}`);
  });
  
  socket.on('disconnect', () => console.log('user disconnected:', socket.id));
});

// Routes
app.use('/api/auth', authRoutes);

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