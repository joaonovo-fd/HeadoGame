#!/usr/bin/env node
/*
  HEAD GAME — relay server.

  A tiny WebSocket relay so two players can connect by ADDRESS rather than by
  copy-pasting WebRTC offer codes at each other. One player runs this, both
  browsers connect to it, and it forwards messages between the two members of a
  room. That is all it does: it never inspects or stores game traffic.

  WHY A SERVER AT ALL: a browser page cannot accept an incoming connection, so
  "just give me your address" is impossible between two pages on its own. One
  side has to be reachable. This is the smallest thing that makes it work.

  ZERO DEPENDENCIES. The WebSocket handshake and framing are implemented here
  against RFC 6455 rather than pulling in `ws`, because the rest of this project
  is a single dependency-free HTML file and a relay you have to npm-install would
  undercut the point.

    node tools/relay.js                 # port 8787, all interfaces
    node tools/relay.js --port 9000
    node tools/relay.js --host 127.0.0.1

  Then in the game: ONLINE -> HOST BY ADDRESS. It shows the address to share.
  The other player picks JOIN BY ADDRESS and types it in.

  OVER THE INTERNET: the address only reaches players on your own network. For
  anyone else, put a tunnel in front of it — for example:

    cloudflared tunnel --url http://localhost:8787
    ssh -R 80:localhost:8787 serveo.net

  and share the https URL the tunnel prints. The game accepts a full URL as the
  address, and upgrades https:// to wss:// automatically.
*/

"use strict";

const http = require("http");
const crypto = require("crypto");

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PORT = Number(argOf("--port", process.env.PORT || 8787));
const HOST = argOf("--host", "0.0.0.0");

/** WebSocket GUID from RFC 6455, used to prove we speak the protocol. */
const WS_GUID = "258EAFA5-E914-47DA-95CA-5AB0DC85B11F";

/*
  Rooms, keyed by a short code. Each holds at most two sockets: the first to
  arrive is the host, the second is the guest. A third is refused rather than
  silently ignored, so a mistyped code fails loudly instead of looking connected.
*/
const rooms = new Map();

/** A short, unambiguous room code. No 0/O or 1/I, since these get read aloud. */
function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 4 },
      () => alphabet[crypto.randomInt(alphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}

/* ---- WebSocket framing --------------------------------------------------- */

/** Encode one text frame. Handles the three payload-length forms. */
function encodeFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    // 64-bit length; the high word is always zero for anything we send.
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x81;                    // FIN + text opcode
  return Buffer.concat([header, payload]);
}

/** A close frame with a status code, so a browser reports a clean close. */
function encodeClose(code = 1000, reason = "") {
  const r = Buffer.from(reason, "utf8");
  const payload = Buffer.alloc(2 + r.length);
  payload.writeUInt16BE(code, 0);
  r.copy(payload, 2);
  return Buffer.concat([Buffer.from([0x88, payload.length]), payload]);
}

const PONG = Buffer.from([0x8a, 0x00]);

/**
 * Pull complete frames out of a socket's buffer.
 *
 * Returns the number of bytes consumed, so the caller keeps any partial frame
 * for the next chunk — TCP does not preserve message boundaries, and assuming it
 * does is the classic way to write a WebSocket server that works locally and
 * fails over a real network.
 */
function readFrames(buf, onText, onClose, onPing) {
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off], b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;

    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      const hi = buf.readUInt32BE(p);
      const lo = buf.readUInt32BE(p + 4);
      // A frame over 4GB is not something this relay needs to support.
      if (hi !== 0) { onClose(1009, "frame too large"); return buf.length; }
      len = lo;
      p += 8;
    }

    let mask = null;
    if (masked) {
      if (buf.length - p < 4) break;
      mask = buf.slice(p, p + 4);
      p += 4;
    }
    if (buf.length - p < len) break;          // frame not fully arrived

    const payload = Buffer.from(buf.slice(p, p + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    off = p + len;

    if (opcode === 0x1) onText(payload.toString("utf8"));
    else if (opcode === 0x8) { onClose(1000, ""); return off; }
    else if (opcode === 0x9) onPing();
    // Continuation, binary and pong frames are not used by the game.
  }
  return off;
}

/* ---- the relay ----------------------------------------------------------- */

let nextId = 1;

function send(sock, obj) {
  if (sock.destroyed) return;
  try { sock.write(encodeFrame(JSON.stringify(obj))); } catch (e) { /* gone */ }
}

function dropSocket(sock) {
  const code = sock.hgRoom;
  if (!code || !rooms.has(code)) return;
  /*
    Notify the survivors BEFORE forgetting the room, and mark this socket as
    handled so a socket firing both 'error' and 'close' does not send the notice
    twice. Notifying after the filter told nobody: the loop skipped the departing
    socket and the room was already empty.
  */
  if (sock.hgDropped) return;
  sock.hgDropped = true;
  const room = rooms.get(code);
  room.sockets = room.sockets.filter((s) => s !== sock);
  for (const s of room.sockets) {
    send(s, { t: "peer-left", why: "the other player disconnected" });
  }
  if (room.sockets.length === 0) {
    rooms.delete(code);
    log(`room ${code} closed`);
  } else {
    log(`#${sock.hgId} left room ${code}`);
  }
}

const log = (...m) => console.log(`[relay ${new Date().toISOString().slice(11, 19)}]`, ...m);

const server = http.createServer((req, res) => {
  /*
    A plain GET is answered with a one-line status page. It doubles as a health
    check for a tunnel, which usually probes with HTTP before upgrading.
  */
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(`Head Game relay is running.\n\n${rooms.size} room(s) open.\n\n` +
          `Point the game's ONLINE screen at this address.\n`);
});

server.on("upgrade", (req, sock) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) { sock.destroy(); return; }

  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  sock.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);

  sock.setNoDelay(true);                 // latency matters more than packing
  sock.hgId = nextId++;
  let buf = Buffer.alloc(0);

  const onText = (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch (e) { return; }

    /*
      Two control messages, then everything else is forwarded verbatim. The relay
      deliberately does not understand the game protocol: that way the game can
      change without the relay needing to.
    */
    if (msg.t === "host") {
      const code = makeCode();
      rooms.set(code, { sockets: [sock], created: Date.now() });
      sock.hgRoom = code;
      send(sock, { t: "hosting", code });
      log(`room ${code} opened by #${sock.hgId}`);
      return;
    }
    if (msg.t === "join") {
      const code = String(msg.code || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) { send(sock, { t: "no-room", code }); return; }
      if (room.sockets.length >= 2) { send(sock, { t: "room-full", code }); return; }
      room.sockets.push(sock);
      sock.hgRoom = code;
      send(sock, { t: "joined", code });
      // Tell the host someone arrived, which is its cue to start the handshake.
      for (const s of room.sockets) if (s !== sock) send(s, { t: "peer-joined" });
      log(`#${sock.hgId} joined room ${code}`);
      return;
    }

    // Forward to the other member of the room.
    const room = rooms.get(sock.hgRoom);
    if (!room) return;
    for (const s of room.sockets) {
      if (s === sock || s.destroyed) continue;
      try { s.write(encodeFrame(text)); } catch (e) { /* gone */ }
    }
  };

  const onClose = (code, reason) => {
    dropSocket(sock);
    try { sock.write(encodeClose(code, reason)); } catch (e) { /* gone */ }
    sock.destroy();
  };

  sock.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // A single message is tiny; anything enormous is not this protocol.
    if (buf.length > 4 << 20) { onClose(1009, "message too large"); return; }
    const used = readFrames(buf, onText, onClose, () => {
      try { sock.write(PONG); } catch (e) { /* gone */ }
    });
    buf = used >= buf.length ? Buffer.alloc(0) : buf.slice(used);
  });

  /*
    All THREE events, because an upgraded socket does not reliably emit them all:
    a peer calling destroy() produces 'end' with no 'close' on the server side, so
    listening only for 'close' meant the surviving player was never told their
    opponent had gone — the match simply froze until the 6-second game-level
    timeout. dropSocket is idempotent, so hearing several is harmless.
  */
  sock.on("end", () => dropSocket(sock));
  sock.on("error", () => dropSocket(sock));
  sock.on("close", () => dropSocket(sock));
  sock.on("timeout", () => dropSocket(sock));
});

/* Reap rooms nobody ever joined, so a long-running relay does not leak them. */
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.sockets.length === 1 && now - room.created > 30 * 60 * 1000) {
      for (const s of room.sockets) send(s, { t: "expired" });
      rooms.delete(code);
      log(`room ${code} expired`);
    }
  }
}, 60 * 1000).unref();

/**
 * Start listening and print the addresses to share.
 *
 * Guarded by the require-vs-run check below so importing this file for its
 * framing helpers — which the test suite does — does not start a server on a
 * port the user did not ask for.
 */
function start() {
  server.listen(PORT, HOST, () => {
  const nets = require("os").networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === "IPv4" && !ni.internal) addrs.push(ni.address);
    }
  }
  console.log("");
  console.log("  Head Game relay");
  console.log("  ───────────────");
  console.log(`  listening on ${HOST}:${PORT}`);
  console.log("");
  console.log("  Give the other player one of these addresses:");
  for (const a of addrs) console.log(`    ${a}:${PORT}`);
  if (!addrs.length) console.log(`    localhost:${PORT}  (this machine only)`);
  console.log("");
  console.log("  For players outside your network, run a tunnel and share its URL:");
  console.log(`    cloudflared tunnel --url http://localhost:${PORT}`);
  console.log("");
  });
}

// Only listen when run directly, never when imported.
if (require.main === module) start();

module.exports = { readFrames, encodeFrame, encodeClose, makeCode, rooms, start, server };
