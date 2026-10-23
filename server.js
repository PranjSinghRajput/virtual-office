require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const CABINS = [
  { id: 'design',  x: 40,  y: 40 },
  { id: 'dev',     x: 290, y: 40 },
  { id: 'meeting', x: 540, y: 40 },
];
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
let meeting = null; // { title, hostId, invited: Set of socket ids }

function cleanName(n) {
  const s = typeof n === 'string' ? n.trim().slice(0, 20) : '';
  return s || 'Guest';
}

function roster() {
  return Object.values(players).map((p) => ({ id: p.id, name: p.name }));
}

function meetingStatus() {
  if (!meeting) return { active: false };
  const host = players[meeting.hostId];
  return {
    active: true,
    title: meeting.title,
    hostId: meeting.hostId,
    hostName: host ? host.name : 'Unknown',
  };
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  players[socket.id] = {
    id: socket.id,
    name: cleanName(socket.handshake.auth && socket.handshake.auth.name),
    x: 100 + Math.floor(Math.random() * 600),
    y: 420,
  };

  socket.emit('currentPlayers', players);
  socket.broadcast.emit('newPlayer', players[socket.id]);
  io.emit('roster', roster());
  socket.emit('meetingStatus', meetingStatus());

  socket.on('playerMove', (pos) => {
    const p = players[socket.id];
    if (!p || !pos) return;
    if (typeof pos.x !== 'number' || typeof pos.y !== 'number') return;
    p.x = pos.x;
    p.y = pos.y;
    socket.broadcast.emit('playerMoved', p);
  });

  // Host guest list ke saath meeting banata hai
  socket.on('createMeeting', (data, callback) => {
    if (typeof callback !== 'function') return;
    const title = data && typeof data.title === 'string' ? data.title.trim().slice(0, 40) : '';
    if (!title) return callback({ error: 'Please enter a meeting title' });
    if (meeting && meeting.hostId !== socket.id) {
      return callback({ error: 'The Meeting Room is already booked' });
    }

    const invited = new Set([socket.id]);
    const ids = data && Array.isArray(data.invited) ? data.invited : [];
    ids.forEach((id) => {
      if (typeof id === 'string' && players[id]) invited.add(id);
    });

    meeting = { title, hostId: socket.id, invited };
    const hostName = players[socket.id].name;
    invited.forEach((id) => {
      if (id !== socket.id) io.to(id).emit('meetingInvite', { title, hostName });
    });
    io.emit('meetingStatus', meetingStatus());
    callback({ ok: true });
  });

  socket.on('endMeeting', () => {
    if (meeting && meeting.hostId === socket.id) {
      meeting = null;
      io.emit('meetingStatus', meetingStatus());
      io.emit('meetingEnded');
    }
  });

  // Cabin ke andar ho to video call ka pass do (meeting room mein guest list check)
  socket.on('joinCabinCall', async (callback) => {
    if (typeof callback !== 'function') return;
    try {
      const p = players[socket.id];
      const cabin = p && cabinAt(p);
      if (!cabin) return callback({ error: 'Not inside a cabin' });

      if (cabin.id === 'meeting') {
        if (!meeting) return callback({ error: 'No meeting is running in the Meeting Room right now' });
        if (!meeting.invited.has(socket.id)) {
          return callback({ error: 'This meeting is invite-only. Ask the host to invite you.' });
        }
      }

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
    io.emit('roster', roster());
    if (meeting && meeting.hostId === socket.id) {
      meeting = null;
      io.emit('meetingStatus', meetingStatus());
      io.emit('meetingEnded');
    }
  });
});

server.listen(3000, () => console.log('Running on http://localhost:3000'));