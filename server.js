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

// Connection toot jaye to itne second tak wapas aane ka mauka (refresh / wifi drop ke liye)
const GRACE_MS = (Number(process.env.DROP_GRACE_SECONDS) || 60) * 1000;
const BREAK_REASONS = ['Lunch', 'Short break', 'Meeting elsewhere', 'Personal'];

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

// Attendance register: kaun kab andar aaya, break par gaya, bina bataye gaya
const presenceLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  userName: { type: String, required: true },
  type: {
    type: String,
    enum: ['clock_in', 'clock_out', 'break_start', 'break_end', 'dropped', 'returned'],
    required: true,
  },
  note: { type: String, default: '' },
  at: { type: Date, default: Date.now, index: true },
});
const PresenceLog = mongoose.model('PresenceLog', presenceLogSchema);

function logPresence(user, type, note) {
  PresenceLog.create({ userId: user.id, userName: user.name, type, note: note || '' }).catch((err) =>
    console.error('Presence log error:', err.message)
  );
}

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
    const isFirst = (await User.countDocuments()) === 0;
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

const players = {};   // socket.id -> { id, name, x, y, presence }
const userSocket = {}; // userId -> socket.id (ek user, ek active tab)
const presence = {};   // userId -> presence state (socket badalne par bhi bacha rehta hai)
let meeting = null;

function getPresence(userId) {
  if (!presence[userId]) {
    presence[userId] = {
      state: 'offline', // offline | working | break
      idle: false,
      reason: '',
      breakTimer: null,
      dropTimer: null,
      x: null,
      y: null,
    };
  }
  return presence[userId];
}

function publicPresence(userId) {
  const p = presence[userId];
  return p ? { state: p.state, idle: p.idle, reason: p.reason } : { state: 'offline', idle: false, reason: '' };
}

function broadcastPresence(userId) {
  const sid = userSocket[userId];
  if (!sid || !players[sid]) return;
  players[sid].presence = publicPresence(userId);
  io.emit('presenceUpdate', { id: sid, presence: players[sid].presence });
}

function alertAdmins(text) {
  io.to('admins').emit('presenceAlert', { text, at: Date.now() });
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
  const user = socket.user;
  console.log('Connected:', user.name, socket.id);

  // Ek user = ek tab. Purana tab hata do.
  const oldId = userSocket[user.id];
  const oldSocket = oldId && io.sockets.sockets.get(oldId);
  if (oldSocket) {
    oldSocket.replaced = true;
    oldSocket.emit('replaced');
    oldSocket.disconnect(true);
  }
  userSocket[user.id] = socket.id;

  const pr = getPresence(user.id);
  if (pr.dropTimer) {
    // Grace time ke andar wapas aa gaya, to alert nahi jayega
    clearTimeout(pr.dropTimer);
    pr.dropTimer = null;
    logPresence(user, 'returned', 'Reconnected within grace time');
  }

  players[socket.id] = {
    id: socket.id,
    name: user.name,
    x: pr.x != null ? pr.x : 100 + Math.floor(Math.random() * 600),
    y: pr.y != null ? pr.y : 420,
    presence: publicPresence(user.id),
  };

  if (user.role === 'admin') socket.join('admins');
  socket.emit('me', { role: user.role });
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
    pr.x = pos.x;
    pr.y = pos.y;
    socket.broadcast.emit('playerMoved', p);
  });

  // ---------- Presence ----------
  socket.on('clockIn', (cb) => {
    if (typeof cb !== 'function') return;
    if (pr.state !== 'offline') return cb({ error: 'You are already clocked in' });
    pr.state = 'working';
    pr.idle = false;
    pr.reason = '';
    logPresence(user, 'clock_in', '');
    broadcastPresence(user.id);
    cb({ ok: true });
  });

  socket.on('clockOut', () => {
    if (pr.state === 'offline') return;
    clearTimeout(pr.breakTimer);
    pr.breakTimer = null;
    pr.state = 'offline';
    pr.idle = false;
    pr.reason = '';
    logPresence(user, 'clock_out', '');
    broadcastPresence(user.id);
  });

  socket.on('startBreak', (data, cb) => {
    if (typeof cb !== 'function') return;
    if (pr.state !== 'working') return cb({ error: 'Clock in first' });
    const reason = data && BREAK_REASONS.includes(data.reason) ? data.reason : null;
    const minutes = data ? Math.round(Number(data.minutes)) : NaN;
    if (!reason) return cb({ error: 'Pick a break reason' });
    if (!(minutes >= 1 && minutes <= 120)) return cb({ error: 'A break must be 1 to 120 minutes' });

    pr.state = 'break';
    pr.reason = reason;
    pr.idle = false;
    clearTimeout(pr.breakTimer);
    pr.breakTimer = setTimeout(() => {
      pr.breakTimer = null;
      if (pr.state !== 'break') return;
      pr.state = 'working';
      pr.reason = '';
      logPresence(user, 'break_end', 'Break time ended automatically');
      broadcastPresence(user.id);
      const sid = userSocket[user.id];
      if (sid) io.to(sid).emit('breakOver');
    }, minutes * 60000);

    logPresence(user, 'break_start', reason + ' (' + minutes + ' min)');
    broadcastPresence(user.id);
    cb({ ok: true });
  });

  socket.on('endBreak', () => {
    if (pr.state !== 'break') return;
    clearTimeout(pr.breakTimer);
    pr.breakTimer = null;
    const was = pr.reason;
    pr.state = 'working';
    pr.reason = '';
    logPresence(user, 'break_end', 'Back from ' + was);
    broadcastPresence(user.id);
  });

  socket.on('setIdle', (flag) => {
    if (typeof flag !== 'boolean') return;
    if (pr.state !== 'working' || pr.idle === flag) return;
    pr.idle = flag;
    broadcastPresence(user.id);
  });

  socket.on('getPresenceLog', async (cb) => {
    if (typeof cb !== 'function') return;
    if (user.role !== 'admin') return cb({ error: 'Admins only' });
    try {
      const since = new Date();
      since.setHours(0, 0, 0, 0);
      const rows = await PresenceLog.find({ at: { $gte: since } }).sort({ at: -1 }).limit(50).lean();
      cb({ rows: rows.map((r) => ({ name: r.userName, type: r.type, note: r.note, at: r.at })) });
    } catch (err) {
      console.error('Log fetch error:', err);
      cb({ error: 'Could not load the log' });
    }
  });

  // ---------- Meetings ----------
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
        { identity: socket.id, name: user.name, ttl: '10m' }
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
    console.log('Left:', user.name, socket.id);
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
    io.emit('roster', roster());
    if (meeting && meeting.hostId === socket.id) {
      meeting = null;
      io.emit('meetingStatus', meetingStatus());
      io.emit('meetingEnded');
    }
    if (userSocket[user.id] === socket.id) delete userSocket[user.id];

    // Doosre tab ne jagah li hai, to ye "gayab hona" nahi hai
    if (socket.replaced) return;

    // Clocked in tha aur bina clock out kiye gaya: grace time ke baad alert
    if (pr.state !== 'offline') {
      pr.dropTimer = setTimeout(() => {
        pr.dropTimer = null;
        clearTimeout(pr.breakTimer);
        pr.breakTimer = null;
        const was = pr.state === 'break' ? 'on a break' : 'clocked in';
        pr.state = 'offline';
        pr.idle = false;
        pr.reason = '';
        logPresence(user, 'dropped', 'Left while ' + was + ' without clocking out');
        alertAdmins(user.name + ' left the office without clocking out');
      }, GRACE_MS);
    }
  });
});

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