# Virtual Office

A real-time virtual office where employees move through a 2D office, step into a colleague's cabin, and connect instantly over video.

> **Status:** In active development. Follow the commit history to see the progress.

## Why this project

Most remote tools rely on scheduled calls. Virtual Office recreates the spontaneity of a real workplace: walk up, say hello, get things done.

## Planned features

- [x] Real-time messaging between connected clients (Socket.io)
- [x] 2D office map with avatar movement (Phaser.js)
- [x] Live multi-user position sync
- [ ] Proximity-based video and audio when entering a cabin (WebRTC)
- [ ] Meeting rooms with invite-only access
- [ ] Presence tracking for remote employees
- [ ] Low-bandwidth mode and AI meeting summaries

## Tech stack

Node.js, Express, Socket.io, Phaser.js, WebRTC (LiveKit)

## Run locally

```bash
git clone https://github.com/PranjSinghRajput/virtual-office.git
cd virtual-office
npm install
node server.js
```

Open http://localhost:3000 in two browser tabs to see real-time messaging in action.

## Author

Pranjali Singh