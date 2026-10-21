const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Register: kaun kahan khada hai
const players = {};

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // Naya player random jagah par aaye
  players[socket.id] = {
    id: socket.id,
    x: 100 + Math.floor(Math.random() * 600),
    y: 420,
  };

  socket.emit('currentPlayers', players);                    // naye ko poori list
  socket.broadcast.emit('newPlayer', players[socket.id]);    // baaki ko batao

  socket.on('playerMove', (pos) => {
    const p = players[socket.id];
    if (!p) return;
    // Client par bharosa mat karo: sirf numbers hi maano
    if (typeof pos.x !== 'number' || typeof pos.y !== 'number') return;
    p.x = pos.x;
    p.y = pos.y;
    socket.broadcast.emit('playerMoved', p);
  });

  // Phase 1 ka chat
  socket.on('chat', (msg) => {
    io.emit('chat', msg);
  });

  socket.on('disconnect', () => {
    console.log('Left:', socket.id);
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

server.listen(3000, () => console.log('Running on http://localhost:3000'));