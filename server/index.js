require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const routes = require('./routes');
const wa = require('./whatsapp');
const queue = require('./queue');
const db = require('./db');
const { adminConfigError } = require('./middleware');

const app = express();
const server = http.createServer(app);

const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:3000')
  .split(',').map(o => o.trim());

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
  },
});

app.use(cors({ origin: allowedOrigins }));
app.use(express.json());
app.get('/healthz', (req, res) => res.json({ ok: true }));   // for the container health check
app.use('/api', routes);

// Production: serve the built React client from this server (one port for page, API and sockets)
const clientBuild = path.join(__dirname, '..', 'client', 'build');
if (fs.existsSync(path.join(clientBuild, 'index.html'))) {
  app.use(express.static(clientBuild));
  // Client-side routes (/admin, /admin/dashboard): everything that isn't an API/socket path
  app.get(/^\/(?!api\/|socket\.io\/).*/, (req, res) => res.sendFile(path.join(clientBuild, 'index.html')));
}

// Socket.io
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // The client sends its session token, not a sessionId; rooms are keyed by the sessionId it maps to
  socket.on('join_session', (token) => {
    const sessionId = db.getSessionIdByToken(token);
    if (!sessionId) return socket.emit('session_invalid');
    for (const room of socket.rooms) if (room !== socket.id) socket.leave(room);
    socket.join(sessionId);
    console.log(`Socket joined session: ${sessionId}`);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Inject io into modules
wa.setIO(io);
queue.setIO(io);
// When a session connects, jobs that were waiting for it can go
wa.setOnReady(() => queue.processNext());

const PORT = process.env.PORT || 5000;
server.listen(PORT, async () => {
  console.log(`\n🚀 WA Auto Messenger Server running on port ${PORT}`);
  console.log(`📡 Client URL: ${process.env.CLIENT_URL || 'http://localhost:3000'}`);
  const adminError = adminConfigError();
  if (adminError) console.error(`⛔ Admin panel disabled: ${adminError}`);
  else if (process.env.ADMIN_JWT_SECRET.length < 32) console.warn('⚠️ ADMIN_JWT_SECRET is short; use 32+ random characters');
  queue.restoreQueue();
  queue.startScheduler();

  console.log(`\nInitializing existing sessions...\n`);
  await wa.initExistingSessions();
});
