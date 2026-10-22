require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Cabins ki jagah (client ke game.js jaisi hi)
const CABINS = [
  { id: 'design',  name: 'Design Cabin', x: 40 },
  { id: 'dev',     name: 'Dev Cabin',    x: 290 },
  { id: 'meeting', name: 'Meeting Room', x: 540 },
].map((c) => ({ ...c, y: 40 }));
const CABIN_W = 220;
const CABIN_H = 180;
const WALL = 10;

function cabinAt(p) {
  return CABINS.find(
    (c) =>
      p.x > c.x + WALL && p.x < c.x + CABIN_W - WALL &&
      p.y > c.y + WALL && p.y < c.y + CABIN_H - WALL
  );
}

if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
  console.warn('WARNING: LiveKit keys missing in .env, video calls will not work');
}

const players = {};

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  players[socket.id] = {
    id: socket.id,
    x: 100 + Math.floor(Math.random() * 600),
    y: 420,
  };

  socket.emit('currentPlayers', players);
  socket.broadcast.emit('newPlayer', players[socket.id]);

  socket.on('playerMove', (pos) => {
    const p = players[socket.id];
    if (!p) return;
    if (typeof pos.x !== 'number' || typeof pos.y !== 'number') return;
    p.x = pos.x;
    p.y = pos.y;
    socket.broadcast.emit('playerMoved', p);
  });

  // NEW: cabin ke andar ho to video call ka pass do
  socket.on('joinCabinCall', async (callback) => {
    if (typeof callback !== 'function') return;
    try {
      const p = players[socket.id];
      const cabin = p && cabinAt(p);
      if (!cabin) return callback({ error: 'Not inside a cabin' });
      if (!process.env.LIVEKIT_URL) return callback({ error: 'LiveKit keys missing' });

      const { AccessToken } = await import('livekit-server-sdk');
      const at = new AccessToken(
        process.env.LIVEKIT_API_KEY,
        process.env.LIVEKIT_API_SECRET,
        { identity: socket.id, ttl: '10m' }
      );
      at.addGrant({ roomJoin: true, room: cabin.id, canPublish: true, canSubscribe: true });
      const token = await at.toJwt();

      callback({ token, url: process.env.LIVEKIT_URL, room: cabin.id });
    } catch (err) {
      console.error('Token error:', err);
      callback({ error: 'Could not create token' });
    }
  });

  socket.on('chat', (msg) => io.emit('chat', msg));

  socket.on('disconnect', () => {
    console.log('Left:', socket.id);
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

server.listen(3000, () => console.log('Running on http://localhost:3000'));