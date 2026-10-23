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

// Testing ke liye: localhost:3000/?name=Ravi&cam=off&mic=off
const params = new URLSearchParams(location.search);
const WANT_CAM = params.get('cam') !== 'off';
const WANT_MIC = params.get('mic') !== 'off';
const myName =
  (params.get('name') || prompt('Enter your name (shown above your avatar):') || 'Guest')
    .trim()
    .slice(0, 20) || 'Guest';

const $ = (id) => document.getElementById(id);

let socket = null;
let activeCabin = null;
let roster = [];
let meetingState = { active: false };
let meetingLabel = null;
let noticeTimer = null;

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
  this.myLabel = makeLabel(this, myName);

  // false = browser ke typing ko rokna nahi (title likhte waqt space/letters chalein)
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

  // Socket yahin banta hai taaki koi event miss na ho
  socket = io({ auth: { name: myName } });

  socket.on('currentPlayers', (players) => {
    Object.keys(players).forEach((id) => {
      if (id === socket.id) scene.player.setPosition(players[id].x, players[id].y);
      else addOther(scene, players[id]);
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
    if (activeCabin === 'meeting') onCabinChange('meeting'); // pehle se andar khade the to dobara try
  });
  socket.on('meetingEnded', () => {
    showNotice('The meeting has ended.');
    if (activeCabin === 'meeting') leaveCall();
  });

  setupPanel();
}

function update() {
  const tag = document.activeElement && document.activeElement.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA';

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

  // 0.5 second ek hi jagah rukne par hi call badlo
  const insideId = inside ? inside.id : null;
  if (insideId !== this.candidateCabin) {
    this.candidateCabin = insideId;
    this.candidateSince = this.time.now;
  } else if (this.candidateCabin !== activeCabin && this.time.now - this.candidateSince > 500) {
    activeCabin = this.candidateCabin;
    onCabinChange(activeCabin);
  }
}

// ---------- Meeting panel ----------
function setupPanel() {
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
      if (activeCabin === 'meeting') onCabinChange('meeting'); // host pehle se andar hai to join karao
    });
  };

  $('endMeetingBtn').onclick = () => socket.emit('endMeeting');
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
    label.appendChild(document.createTextNode(' ' + p.name)); // textNode: naam se HTML nahi chalega
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

function showNotice(text) {
  const el = $('notice');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { el.hidden = true; }, 5000);
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
  scene.others[info.id] = {
    img: scene.add.image(info.x, info.y, 'avatarOther'),
    label: makeLabel(scene, info.name).setPosition(info.x, info.y - 26),
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