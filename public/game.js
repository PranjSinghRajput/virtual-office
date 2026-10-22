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

// NEW: testing ke liye: localhost:3000/?cam=off&mic=off
const params = new URLSearchParams(location.search);
const WANT_CAM = params.get('cam') !== 'off';
const WANT_MIC = params.get('mic') !== 'off';

const config = {
  type: Phaser.AUTO,
  width: 800,
  height: 600,
  backgroundColor: '#e2e8f0',
  parent: 'game',
  physics: { default: 'arcade', arcade: { debug: false } },
  scene: { create, update },
};

new Phaser.Game(config);

function create() {
  const scene = this;
  this.walls = [];

  CABINS.forEach((cabin) => makeCabin(this, cabin));

  makeAvatarTexture(this, 'avatar', 0x4f46e5);
  makeAvatarTexture(this, 'avatarOther', 0xf97316);

  this.player = this.physics.add.sprite(400, 420, 'avatar');
  this.player.setCollideWorldBounds(true);
  this.walls.forEach((wall) => this.physics.add.collider(this.player, wall));

  this.cursors = this.input.keyboard.createCursorKeys();
  this.keys = this.input.keyboard.addKeys('W,A,S,D');

  this.add.text(16, 540, 'Use arrow keys or WASD to move', { fontSize: '14px', color: '#475569' });
  this.statusText = this.add.text(16, 565, '', { fontSize: '18px', color: '#0f172a', fontStyle: 'bold' });

  this.socket = io();
  this.others = {};
  this.lastSent = { x: 0, y: 0 };

  this.socket.on('currentPlayers', (players) => {
    Object.keys(players).forEach((id) => {
      if (id === scene.socket.id) {
        scene.player.setPosition(players[id].x, players[id].y);
      } else {
        addOther(scene, players[id]);
      }
    });
  });
  this.socket.on('newPlayer', (info) => addOther(scene, info));
  this.socket.on('playerMoved', (info) => {
    const other = scene.others[info.id];
    if (other) other.setPosition(info.x, info.y);
  });
  this.socket.on('playerLeft', (id) => {
    if (scene.others[id]) {
      scene.others[id].destroy();
      delete scene.others[id];
    }
  });

  // NEW: cabin badalne par call ka hisaab
  this.candidateCabin = null;
  this.activeCabin = null;
  this.candidateSince = 0;
}

function update() {
  let dx = 0;
  let dy = 0;

  if (this.cursors.left.isDown || this.keys.A.isDown) dx = -1;
  else if (this.cursors.right.isDown || this.keys.D.isDown) dx = 1;

  if (this.cursors.up.isDown || this.keys.W.isDown) dy = -1;
  else if (this.cursors.down.isDown || this.keys.S.isDown) dy = 1;

  const v = new Phaser.Math.Vector2(dx, dy).normalize().scale(SPEED);
  this.player.setVelocity(v.x, v.y);

  const p = this.player;
  const inside = CABINS.find(
    (c) =>
      p.x > c.x + WALL && p.x < c.x + CABIN_W - WALL &&
      p.y > c.y + WALL && p.y < c.y + CABIN_H - WALL
  );
  this.statusText.setText('You are in: ' + (inside ? inside.name : 'Hallway'));

  const x = Math.round(p.x);
  const y = Math.round(p.y);
  if (x !== this.lastSent.x || y !== this.lastSent.y) {
    this.socket.emit('playerMove', { x, y });
    this.lastSent = { x, y };
  }

  // NEW: 0.5 second tak ek hi jagah rukne par hi call badlo
  const insideId = inside ? inside.id : null;
  if (insideId !== this.candidateCabin) {
    this.candidateCabin = insideId;
    this.candidateSince = this.time.now;
  } else if (
    this.candidateCabin !== this.activeCabin &&
    this.time.now - this.candidateSince > 500
  ) {
    this.activeCabin = this.candidateCabin;
    onCabinChange(this.socket, this.activeCabin);
  }
}

// ---------- NEW: Video call (LiveKit) ----------
let callRoom = null;
let callSeq = 0;

function onCabinChange(socket, cabinId) {
  leaveCall().then(() => {
    if (cabinId) joinCall(socket);
  });
}

async function leaveCall() {
  callSeq++;
  if (callRoom) {
    const r = callRoom;
    callRoom = null;
    try { await r.disconnect(); } catch (e) { /* ignore */ }
  }
  document.getElementById('call').innerHTML = '';
}

async function joinCall(socket) {
  const mySeq = ++callSeq;
  const { Room, RoomEvent, Track } = LivekitClient;

  // Server se pass maango
  const res = await new Promise((resolve) => socket.emit('joinCabinCall', resolve));
  if (mySeq !== callSeq) return;            // player tab tak aage nikal gaya
  if (!res || res.error) {
    console.log('Call not started:', res && res.error);
    return;
  }

  const room = new Room();
  callRoom = room;

  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === Track.Kind.Video || track.kind === Track.Kind.Audio) {
      document.getElementById('call').appendChild(track.attach());
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
      if (pub && pub.track) document.getElementById('call').appendChild(pub.track.attach());
    } catch (e) { console.warn('Camera failed:', e); }
  }
}
// ------------------------------------------------

function addOther(scene, info) {
  if (scene.others[info.id]) return;
  scene.others[info.id] = scene.add.image(info.x, info.y, 'avatarOther');
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
  scene.add.text(x + 16, y + 18, cabin.name, { fontSize: '16px', color: '#0f172a', fontStyle: 'bold' });

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