const CABINS = [
  { name: 'Design Cabin', x: 40,  y: 40, color: 0xbfdbfe },
  { name: 'Dev Cabin',    x: 290, y: 40, color: 0xbbf7d0 },
  { name: 'Meeting Room', x: 540, y: 40, color: 0xfde68a },
];
const CABIN_W = 220;
const CABIN_H = 180;
const WALL = 10;
const DOOR = 60;
const SPEED = 200;

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
  this.walls = [];

  // 1. Cabins banao
  CABINS.forEach((cabin) => makeCabin(this, cabin));

  // 2. Avatar ki tasveer code se banao (koi image file nahi chahiye)
  const g = this.add.graphics();
  g.fillStyle(0x4f46e5, 1);
  g.fillCircle(16, 16, 16);
  g.generateTexture('avatar', 32, 32);
  g.destroy();

  // 3. Avatar ko hallway mein rakho
  this.player = this.physics.add.sprite(400, 420, 'avatar');
  this.player.setCollideWorldBounds(true);

  // 4. Har deewar ke saath takraane ka niyam
  this.walls.forEach((wall) => this.physics.add.collider(this.player, wall));

  // 5. Keyboard
  this.cursors = this.input.keyboard.createCursorKeys();
  this.keys = this.input.keyboard.addKeys('W,A,S,D');

  // 6. Text
  this.add.text(16, 540, 'Use arrow keys or WASD to move', { fontSize: '14px', color: '#475569' });
  this.statusText = this.add.text(16, 565, '', { fontSize: '18px', color: '#0f172a', fontStyle: 'bold' });
}

function update() {
  let dx = 0;
  let dy = 0;

  if (this.cursors.left.isDown || this.keys.A.isDown) dx = -1;
  else if (this.cursors.right.isDown || this.keys.D.isDown) dx = 1;

  if (this.cursors.up.isDown || this.keys.W.isDown) dy = -1;
  else if (this.cursors.down.isDown || this.keys.S.isDown) dy = 1;

  // Tirchi chalne par speed na badhe
  const v = new Phaser.Math.Vector2(dx, dy).normalize().scale(SPEED);
  this.player.setVelocity(v.x, v.y);

  // Avatar kis cabin ke andar hai?
  const p = this.player;
  const inside = CABINS.find(
    (c) =>
      p.x > c.x + WALL && p.x < c.x + CABIN_W - WALL &&
      p.y > c.y + WALL && p.y < c.y + CABIN_H - WALL
  );
  this.statusText.setText('You are in: ' + (inside ? inside.name : 'Hallway'));
}

function makeCabin(scene, cabin) {
  const { x, y } = cabin;
  const doorStart = (CABIN_W - DOOR) / 2;

  scene.add.rectangle(x + CABIN_W / 2, y + CABIN_H / 2, CABIN_W, CABIN_H, cabin.color);
  scene.add.text(x + 16, y + 18, cabin.name, { fontSize: '16px', color: '#0f172a', fontStyle: 'bold' });

  addWall(scene, x, y, CABIN_W, WALL);                       // upar
  addWall(scene, x, y, WALL, CABIN_H);                       // left
  addWall(scene, x + CABIN_W - WALL, y, WALL, CABIN_H);      // right
  addWall(scene, x, y + CABIN_H - WALL, doorStart, WALL);    // neeche (door se pehle)
  addWall(scene, x + doorStart + DOOR, y + CABIN_H - WALL,   // neeche (door ke baad)
          CABIN_W - doorStart - DOOR, WALL);
}

function addWall(scene, x, y, w, h) {
  const wall = scene.add.rectangle(x + w / 2, y + h / 2, w, h, 0x334155);
  scene.physics.add.existing(wall, true); // true = static (hilta nahi)
  scene.walls.push(wall);
}