require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!process.env.MONGODB_URI || !JWT_SECRET) {
  console.error('Missing MONGODB_URI or JWT_SECRET in .env');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

// ---------- Database ----------
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 20 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['admin', 'employee'], default: 'employee' },
  },
  { timestamps: true }
);
const User = mongoose.model('User', userSchema);

function makeToken(user) {
  return jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '8h' });
}

function authResponse(user) {
  return { token: makeToken(user), user: { name: user.name, email: user.email, role: user.role } };
}

// ---------- Register / Login ----------
app.post('/api/register', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 20);
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (await User.findOne({ email })) {
      return res.status(409).json({ error: 'This email is already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const isFirst = (await User.countDocuments()) === 0; // pehla user admin banta hai
    const user = await User.create({ name, email, passwordHash, role: isFirst ? 'admin' : 'employee' });
    res.json(authResponse(user));
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'This email is already registered' });
    console.error('Register error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = await User.findOne({ email });
    // Same message dono case mein, taaki koi ye na jaan sake ki email register hai ya nahi
    const ok = user && (await bcrypt.compare(password, user.passwordHash));
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
    res.json(authResponse(user));
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// ---------- Office ----------
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

// Gate ka guard: socket tabhi judega jab valid token ho
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next(new Error('no token'));
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(payload.sub);
    if (!user) return next(new Error('user not found'));
    socket.user = { id: user.id, name: user.name, role: user.role };
    next();
  } catch (err) {
    next(new Error('invalid token'));
  }
});

io.on('connection', (socket) => {
  console.log('Connected:', socket.user.name, socket.id);

  players[socket.id] = {
    id: socket.id,
    name: socket.user.name, // naam ab database se aata hai, client se nahi
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
        { identity: socket.id, name: socket.user.name, ttl: '10m' }
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
    console.log('Left:', socket.user.name, socket.id);
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

// Pehle database jude, phir server chalu
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('MongoDB connected');
    server.listen(3000, () => console.log('Running on http://localhost:3000'));
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });