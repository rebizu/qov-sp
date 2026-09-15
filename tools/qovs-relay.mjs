// QOV-S WebSocket-binding relay (qov-streaming-spec.md sections 1.2/7):
// pairs two browser peers per room and forwards everything 1:1 — binary
// media packets and text control lines alike. The relay is carrier, not
// participant: it never inspects QOV-S traffic.
//
// Run: npm run relay   (ws://localhost:8882)
import { WebSocketServer } from 'ws';

const port = parseInt(process.env.QOVS_RELAY_PORT || '8882', 10);
const rooms = new Map(); // room name -> Set<WebSocket>

const wss = new WebSocketServer({ port });
wss.on('connection', (ws) => {
  let room = null;
  ws.on('message', (data, isBinary) => {
    if (room === null) {
      const text = data.toString('utf8').trim();
      const m = /^JOIN\s+(\S+)$/.exec(text);
      if (!m) { ws.close(4000, 'expected JOIN <room>'); return; }
      room = m[1];
      if (!rooms.has(room)) rooms.set(room, new Set());
      const peers = rooms.get(room);
      if (peers.size >= 2) { ws.close(4001, 'room full'); return; }
      const alone = peers.size === 0;
      peers.add(ws);
      console.log(`peer joined "${room}" (${peers.size}/2)`);
      if (alone) {
        ws.send('WAIT');
      } else {
        ws.send('READY');
        for (const peer of peers) {
          if (peer !== ws) peer.send('PEER_JOINED');
        }
      }
      return;
    }
    for (const peer of rooms.get(room)) {
      if (peer !== ws && peer.readyState === 1) peer.send(data, { binary: isBinary });
    }
  });
  ws.on('close', () => {
    if (room !== null && rooms.has(room)) {
      const peers = rooms.get(room);
      peers.delete(ws);
      console.log(`peer left "${room}" (${peers.size}/2)`);
      if (peers.size === 0) rooms.delete(room);
    }
  });
});
console.log(`QOV-S relay listening on ws://0.0.0.0:${port}`);
