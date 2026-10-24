const CABINS = [
  { id: 'design',  name: 'Design Cabin', x: 40,  y: 40, color: 0xbfdbfe },
  { id: 'dev',     name: 'Dev Cabin',    x: 290, y: 40, color: 0xbbf7d0 },
  { id: 'meeting', name: 'Meeting Room', x: 540, y: 40, color: 0xfde68a },
];
const CABIN_W = 220;
const CABIN_H = 180;
const WALL = 10;
const DOOR = 60;
const SPEED = 200;

// Testing: localhost:3000/?cam=off&mic=off&idle=10   (idle=10 -> 10 second mein idle)
const params = new URLSearchParams(location.search);
const WANT_CAM = params.get('cam') !== 'off';
const WANT_MIC = params.get('mic') !== 'off';
const IDLE_SECONDS = Number(params.get('idle')) || 300;

const token = sessionStorage.getItem('vo_token');
const myName = sessionStorage.getItem('vo_name');
const LOGGED_IN = Boolean(token && myName);
if (!LOGGED_IN) location.replace('/login.html');

const $ = (id) => document.getElementById(id);

let socket = null;
let activeCabin = null;
let roster = [];
let meetingState = { active: false };
let meetingLabel = null;
let noticeTimer = null;
let myPresence = { state: 'offline', idle: false, reason: '' };

const config = {
  type: Phaser.AUTO,
  width: 800,
  height: 600,
  backgroundColor: '#e2e8f0',
  parent: 'game',
  physics: { default: 'arcade', arcade: { debug: false } },
  scene: { create, update },
};

if (LOGGED_IN) new Phaser.Game(config);

// Soft lock: clocked in ho to logout nahi chalega (force = token kharab hone par)
function logout(force) {
  if (!force && myPresence.state !== 'offline') {
    showNotice('You are clocked in. Please clock out before logging out.');
    return;
  }
  sessionStorage.clear();
  location.replace('/login.html');
}

// Soft lock: tab band karte waqt browser warning dega
window.addEventListener('beforeunload', (e) => {
  if (myPresence.state !== 'offline') {
    e.preventDefault();
    e.returnValue = '';
  }
});

// Idle detection: mouse/keyboard activity dekhte hain
let lastActivity = Date.now();
let reportedIdle = false;
['mousemove', 'mousedown', 'keydown', 'touchstart'].forEach((ev) =>
  window.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true })
);
setInterval(() => {
  if (!socket) return;
  const idleNow = myPresence.state === 'working' && Date.now() - lastActivity > IDLE_SECONDS * 1000;
  if (idleNow !== reportedIdle) {
    reportedIdle = idleNow;
    socket.emit('setIdle', idleNow);
  }
}, 1000);

function create() {
  const scene = this;
  this.walls = [];

  CABINS.forEach((cabin) => makeCabin(this, cabin));

  makeAvatarTexture(this, 'avatar', 0x4f46e5);
  makeAvatarTexture(this, 'avatarOther', 0xf97316);

  this.player = this.physics.add.sprite(400, 420, 'avatar');
  this.player.setCollideWorldBounds(true);
  this.walls.forEach((wall) => this.physics.add.collider(this.player, wall));
  this.myLabel = makeLabel(this, myName);

  this.keys = this.input.keyboard.addKeys(
    { up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT', w: 'W', a: 'A', s: 'S', d: 'D' },
    false
  );

  this.add.text(16, 540, 'Use arrow keys or WASD to move', { fontSize: '14px', color: '#475569' });
  this.statusText = this.add.text(16, 565, '', { fontSize: '18px', color: '#0f172a', fontStyle: 'bold' });

  this.others = {};
  this.lastSent = { x: 0, y: 0 };
  this.candidateCabin = null;
  this.candidateSince = 0;

  socket = io({ auth: { token } });

  socket.on('connect_error', (err) => {
    console.warn('Socket error:', err.message);
    if (['no token', 'invalid token', 'user not found'].includes(err.message)) logout(true);
  });

  socket.on('me', (info) => {
    $('adminBox').hidden = info.role !== 'admin';
  });

  socket.on('currentPlayers', (players) => {
    Object.keys(players).forEach((id) => {
      if (id === socket.id) {
        scene.player.setPosition(players[id].x, players[id].y);
        myPresence = players[id].presence || myPresence;
        applyLabel(scene.myLabel, myName, myPresence);
        renderPresence();
      } else {
        addOther(scene, players[id]);
      }
    });
  });
  socket.on('newPlayer', (info) => addOther(scene, info));
  socket.on('playerMoved', (info) => {
    const o = scene.others[info.id];
    if (o) {
      o.img.setPosition(info.x, info.y);
      o.label.setPosition(info.x, info.y - 26);
    }
  });
  socket.on('playerLeft', (id) => {
    const o = scene.others[id];
    if (o) {
      o.img.destroy();
      o.label.destroy();
      delete scene.others[id];
    }
  });

  socket.on('presenceUpdate', ({ id, presence }) => {
    if (id === socket.id) {
      myPresence = presence;
      applyLabel(scene.myLabel, myName, presence);
      renderPresence();
    } else if (scene.others[id]) {
      applyLabel(scene.others[id].label, scene.others[id].name, presence);
    }
  });
  socket.on('presenceAlert', (a) => showNotice('Alert: ' + a.text, 10000));
  socket.on('breakOver', () => showNotice('Your break time is over. You are marked as working again.'));
  socket.on('replaced', () => {
    myPresence = { state: 'offline', idle: false, reason: '' };
    leaveCall();
    showNotice('You opened the office in another tab, so this tab has been disconnected.', 600000);
  });

  socket.on('roster', (list) => {
    roster = list;
    renderInviteList();
  });
  socket.on('meetingStatus', (s) => {
    meetingState = s;
    renderMeetingStatus();
  });
  socket.on('meetingInvite', (inv) => {
    showNotice(inv.hostName + ' invited you to "' + inv.title + '". Walk into the Meeting Room to join.');
    if (activeCabin === 'meeting') onCabinChange('meeting');
  });
  socket.on('meetingEnded', () => {
    showNotice('The meeting has ended.');
    if (activeCabin === 'meeting') leaveCall();
  });

  setupPanel();
}

function update() {
  const tag = document.activeElement && document.activeElement.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  let dx = 0;
  let dy = 0;
  if (!typing) {
    if (this.keys.left.isDown || this.keys.a.isDown) dx = -1;
    else if (this.keys.right.isDown || this.keys.d.isDown) dx = 1;
    if (this.keys.up.isDown || this.keys.w.isDown) dy = -1;
    else if (this.keys.down.isDown || this.keys.s.isDown) dy = 1;
  }

  const v = new Phaser.Math.Vector2(dx, dy).normalize().scale(SPEED);
  this.player.setVelocity(v.x, v.y);

  const p = this.player;
  this.myLabel.setPosition(p.x, p.y - 26);

  const inside = CABINS.find(
    (c) =>
      p.x > c.x + WALL && p.x < c.x + CABIN_W - WALL &&
      p.y > c.y + WALL && p.y < c.y + CABIN_H - WALL
  );
  this.statusText.setText('You are in: ' + (inside ? inside.name : 'Hallway'));

  const x = Math.round(p.x);
  const y = Math.round(p.y);
  if (socket && (x !== this.lastSent.x || y !== this.lastSent.y)) {
    socket.emit('playerMove', { x, y });
    this.lastSent = { x, y };
  }

  const insideId = inside ? inside.id : null;
  if (insideId !== this.candidateCabin) {
    this.candidateCabin = insideId;
    this.candidateSince = this.time.now;
  } else if (this.candidateCabin !== activeCabin && this.time.now - this.candidateSince > 500) {
    activeCabin = this.candidateCabin;
    onCabinChange(activeCabin);
  }
}

// ---------- Presence ----------
function statusSuffix(p) {
  if (!p || p.state === 'offline') return '';
  if (p.state === 'break') return ' (' + p.reason.toLowerCase() + ')';
  return p.idle ? ' (idle)' : ' \u25CF';
}

function statusColor(p) {
  if (!p || p.state === 'offline') return '#0f172a';
  if (p.state === 'break') return '#c2410c';
  return p.idle ? '#64748b' : '#15803d';
}

function applyLabel(label, name, p) {
  label.setText(name + statusSuffix(p));
  label.setColor(statusColor(p));
}

function renderPresence() {
  const s = myPresence.state;
  $('presenceState').textContent =
    s === 'offline' ? 'Status: not clocked in'
    : s === 'break' ? 'Status: on break (' + myPresence.reason + ')'
    : myPresence.idle ? 'Status: working (idle)'
    : 'Status: working';
  $('clockInBtn').hidden = s !== 'offline';
  $('clockOutBtn').hidden = s === 'offline';
  $('breakBtn').hidden = s !== 'working';
  $('backBtn').hidden = s !== 'break';
  if (s !== 'working') $('breakForm').hidden = true;
}

const LOG_TEXT = {
  clock_in: 'clocked in',
  clock_out: 'clocked out',
  break_start: 'started a break',
  break_end: 'ended a break',
  dropped: 'LEFT without clocking out',
  returned: 'reconnected',
};

function renderLog(rows) {
  const box = $('logList');
  box.innerHTML = '';
  if (!rows.length) {
    box.textContent = 'No activity today.';
    return;
  }
  rows.forEach((r) => {
    const time = new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const line = document.createElement('div');
    line.textContent = time + '  ' + r.name + ' ' + (LOG_TEXT[r.type] || r.type) + (r.note ? ' - ' + r.note : '');
    box.appendChild(line);
  });
}

// ---------- Panel ----------
function setupPanel() {
  $('me').textContent = 'Logged in as ' + myName;
  $('logoutBtn').onclick = () => logout(false);

  $('clockInBtn').onclick = () =>
    socket.emit('clockIn', (res) => { if (res && res.error) showNotice(res.error); });
  $('clockOutBtn').onclick = () => socket.emit('clockOut');
  $('breakBtn').onclick = () => { $('breakForm').hidden = !$('breakForm').hidden; };
  $('backBtn').onclick = () => socket.emit('endBreak');
  $('breakForm').onsubmit = (e) => {
    e.preventDefault();
    const data = { reason: $('breakReason').value, minutes: Number($('breakMinutes').value) };
    socket.emit('startBreak', data, (res) => {
      if (res && res.error) return showNotice(res.error);
      $('breakForm').hidden = true;
    });
  };

  $('logBtn').onclick = () =>
    socket.emit('getPresenceLog', (res) => {
      if (res && res.error) return showNotice(res.error);
      renderLog(res.rows);
    });

  $('newMeetingBtn').onclick = () => {
    $('meetingForm').hidden = !$('meetingForm').hidden;
    renderInviteList();
  };

  $('meetingForm').onsubmit = (e) => {
    e.preventDefault();
    const title = $('meetingTitle').value.trim();
    if (!title) return showNotice('Please enter a meeting title');
    const invited = [...$('inviteList').querySelectorAll('input:checked')].map((i) => i.value);

    socket.emit('createMeeting', { title, invited }, (res) => {
      if (res && res.error) return showNotice(res.error);
      showNotice('Meeting created. Invited people have been notified.');
      $('meetingForm').hidden = true;
      $('meetingTitle').value = '';
      if (activeCabin === 'meeting') onCabinChange('meeting');
    });
  };

  $('endMeetingBtn').onclick = () => socket.emit('endMeeting');
  renderPresence();
}

function renderInviteList() {
  const box = $('inviteList');
  const checked = new Set([...box.querySelectorAll('input:checked')].map((i) => i.value));
  box.innerHTML = '';

  const others = roster.filter((p) => p.id !== socket.id);
  if (others.length === 0) {
    box.textContent = 'No one else is online yet. Open a second window to test.';
    return;
  }
  others.forEach((p) => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = p.id;
    cb.checked = checked.has(p.id);
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + p.name));
    box.appendChild(label);
  });
}

function renderMeetingStatus() {
  const mine = meetingState.active && meetingState.hostId === socket.id;
  $('meetingStatus').textContent = meetingState.active
    ? 'Meeting Room: "' + meetingState.title + '" hosted by ' + meetingState.hostName + ' (invite-only)'
    : 'Meeting Room: free';
  $('endMeetingBtn').hidden = !mine;
  $('newMeetingBtn').hidden = meetingState.active && !mine;
  if (meetingLabel) meetingLabel.setText(meetingState.active ? 'Meeting Room [in session]' : 'Meeting Room');
}

function showNotice(text, ms) {
  const el = $('notice');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { el.hidden = true; }, ms || 5000);
}

// ---------- Video call (LiveKit) ----------
let callRoom = null;
let callSeq = 0;

function onCabinChange(cabinId) {
  leaveCall().then(() => {
    if (cabinId) joinCall();
  });
}

async function leaveCall() {
  callSeq++;
  if (callRoom) {
    const r = callRoom;
    callRoom = null;
    try { await r.disconnect(); } catch (e) { /* ignore */ }
  }
  $('call').innerHTML = '';
}

async function joinCall() {
  const mySeq = ++callSeq;
  const { Room, RoomEvent, Track } = LivekitClient;

  const res = await new Promise((resolve) => socket.emit('joinCabinCall', resolve));
  if (mySeq !== callSeq) return;
  if (!res || res.error) {
    console.log('Call not started:', res && res.error);
    if (res && res.error) showNotice(res.error);
    return;
  }

  const room = new Room();
  callRoom = room;

  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === Track.Kind.Video || track.kind === Track.Kind.Audio) {
      $('call').appendChild(track.attach());
    }
  });
  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    track.detach().forEach((el) => el.remove());
  });

  try {
    await room.connect(res.url, res.token);
  } catch (e) {
    console.error('Connect failed:', e);
    callRoom = null;
    return;
  }
  if (mySeq !== callSeq) { await room.disconnect(); return; }

  if (WANT_MIC) {
    try { await room.localParticipant.setMicrophoneEnabled(true); }
    catch (e) { console.warn('Microphone failed:', e); }
  }
  if (WANT_CAM) {
    try {
      const pub = await room.localParticipant.setCameraEnabled(true);
      if (pub && pub.track) $('call').appendChild(pub.track.attach());
    } catch (e) { console.warn('Camera failed:', e); }
  }
}

// ---------- Helpers ----------
function addOther(scene, info) {
  if (scene.others[info.id]) return;
  const label = makeLabel(scene, info.name).setPosition(info.x, info.y - 26);
  applyLabel(label, info.name, info.presence);
  scene.others[info.id] = {
    img: scene.add.image(info.x, info.y, 'avatarOther'),
    label,
    name: info.name,
  };
}

function makeLabel(scene, text) {
  return scene.add
    .text(0, 0, text, { fontSize: '12px', color: '#0f172a', fontStyle: 'bold' })
    .setOrigin(0.5)
    .setDepth(10);
}

function makeAvatarTexture(scene, key, color) {
  const g = scene.add.graphics();
  g.fillStyle(color, 1);
  g.fillCircle(16, 16, 16);
  g.generateTexture(key, 32, 32);
  g.destroy();
}

function makeCabin(scene, cabin) {
  const { x, y } = cabin;
  const doorStart = (CABIN_W - DOOR) / 2;

  scene.add.rectangle(x + CABIN_W / 2, y + CABIN_H / 2, CABIN_W, CABIN_H, cabin.color);
  const title = scene.add.text(x + 16, y + 18, cabin.name, { fontSize: '16px', color: '#0f172a', fontStyle: 'bold' });
  if (cabin.id === 'meeting') meetingLabel = title;

  addWall(scene, x, y, CABIN_W, WALL);
  addWall(scene, x, y, WALL, CABIN_H);
  addWall(scene, x + CABIN_W - WALL, y, WALL, CABIN_H);
  addWall(scene, x, y + CABIN_H - WALL, doorStart, WALL);
  addWall(scene, x + doorStart + DOOR, y + CABIN_H - WALL, CABIN_W - doorStart - DOOR, WALL);
}

function addWall(scene, x, y, w, h) {
  const wall = scene.add.rectangle(x + w / 2, y + h / 2, w, h, 0x334155);
  scene.physics.add.existing(wall, true);
  scene.walls.push(wall);
}