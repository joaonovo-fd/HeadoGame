#!/usr/bin/env node
/*
  HEAD GAME — relay server.

  A tiny WebSocket relay so players can connect by ADDRESS rather than by
  copy-pasting WebRTC offer codes at each other. One player runs this, every
  browser connects to it, and it forwards messages between the members of a room —
  two for a 1v1, up to sixteen for a tournament. That is all it does: it reads
  only the routing fields and never inspects or stores game traffic.

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

  IT ALSO SERVES THE GAME. Open http://localhost:8787/ rather than the .html
  file: a page opened from disk has a unique file:// origin, and some security
  software (a corporate proxy such as Netskope — measured, not guessed) will not
  let such a page reach a local server at all, so the game cannot connect to its
  own relay. Served from here, the page and the socket share one origin and
  there is nothing left to intercept. A guest needs no copy of the file, and the
  address field fills itself in.

  In the game, ONLINE offers:
    Q  quick connect — join whatever is open on the relay
    B  browse — see every open game, with its host, mode and how full it is
    A  host a match           T  host a tournament (up to 16)
    S  join with an address and a code, if someone gave you both

  A host ADVERTISES its room (name, mode, player count) so the browser has
  something to show. Rooms drop out of the listing once they fill or start, so
  nobody is offered a game they cannot join. `private: true` keeps a room out of
  the listing while its code still works.

  OVER THE INTERNET: the address only reaches players on your own network. For
  anyone else, use the helper, which starts this relay and a tunnel together:

    tools/play-online.sh

  It tunnels over SSH to localhost.run, which works where the two obvious choices
  do not. Both failures were measured, not guessed:

    cloudflared's free QUICK tunnel (trycloudflare.com) generates its own
    Sec-WebSocket-Key toward the origin, then validates the origin's
    Sec-WebSocket-Accept against the CLIENT's key. They can never agree, so every
    upgrade fails with a 500 whatever this server replies. A NAMED cloudflare
    tunnel is fine.

    ngrok pins its own CA bundle, so on a network that inspects TLS — a corporate
    proxy such as Netskope or Zscaler — its agent cannot authenticate at all and
    never establishes the tunnel.

  The game accepts a full URL as the address and upgrades https:// to wss://
  automatically.
*/

"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/* The project root, so the relay can serve the game from the same origin. */
const ROOT = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PORT = Number(argOf("--port", process.env.PORT || 8787));
const HOST = argOf("--host", "0.0.0.0");

/*
  WebSocket GUID from RFC 6455 §1.3, used to prove we speak the protocol.

  EXACTLY these characters, ending -C5AB0DC85B11. It was written here as
  -5AB0DC85B11F — the C transposed to the far end — which made every
  Sec-WebSocket-Accept wrong, and no browser could ever connect: Chrome reported
  "Incorrect 'Sec-WebSocket-Accept' header value" and closed with 1006 before the
  relay saw a single frame. The whole end-to-end suite passed throughout, because
  its hand-written client skipped the response headers instead of checking them,
  and a second implementation of the same typo would have agreed with the first
  anyway. It is now pinned to the published test vector in tools/test-relay.js.
*/
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/*
  Rooms, keyed by a short code. The FIRST socket to arrive is the host; the rest
  are guests. A tournament seats up to 16 players, so a room holds the host plus
  15 — beyond that a join is refused rather than silently ignored, so a mistyped
  code or a full lobby fails loudly instead of looking connected.

  Each socket is given an id within its room, and messages carry `from` so the
  host can tell its players apart. A 1v1 match is just the two-socket case of the
  same thing, which is why nothing about it needed a separate path.
*/
const rooms = new Map();
const ROOM_MAX = 16;

/**
 * Sanitise a room name supplied by a host.
 *
 * It is displayed on other people's screens, so it is length-capped and stripped
 * of control characters — a relay must not become a way to write arbitrary bytes
 * into someone else's lobby list.
 */
function cleanRoomName(name) {
  const s = String(name == null ? "" : name)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 20);
  return s || "a game";
}

/** The modes this relay will advertise. Anything else is treated as a match. */
const ROOM_MODES = new Set(["match", "tournament"]);
function cleanRoomMode(mode) {
  const m = String(mode == null ? "" : mode).toLowerCase();
  return ROOM_MODES.has(m) ? m : "match";
}

/** The joinable rooms, as the lobby browser needs them. */
function lobbyList() {
  const out = [];
  for (const [code, room] of rooms) {
    if (room.private || room.started) continue;
    const max = room.max || ROOM_MAX;
    if (room.sockets.length >= max) continue;      // nothing to join
    out.push({
      code,
      name: room.name || "a game",
      mode: room.mode || "match",
      players: room.sockets.length,
      max,
      age: Math.round((Date.now() - room.created) / 1000),
    });
  }
  // Newest first: a room someone just opened is the one they are waiting in.
  out.sort((a, b) => a.age - b.age);
  return out;
}

/**
 * Push a fresh listing to everyone watching the lobby.
 *
 * Pushed on change rather than polled: a poll either lags behind a room opening
 * or hammers the relay, and the change points are all right here.
 */
function broadcastLobby() {
  const rooms2 = lobbyList();
  for (const room of rooms.values()) {
    for (const s of room.sockets) {
      if (s.hgWatching) send(s, { t: "lobbies", rooms: rooms2 });
    }
  }
  for (const s of watchers) {
    if (!s.destroyed && s.hgWatching) send(s, { t: "lobbies", rooms: rooms2 });
  }
}

/*
  Sockets that have asked for the listing but are not in a room yet — a player
  browsing. Tracked separately because broadcastLobby walks rooms, and someone
  who has joined nothing appears in none of them.
*/
const watchers = new Set();

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
    send(s, { t: "peer-left", seat: sock.hgSeat,
              why: "the other player disconnected" });
  }
  if (room.sockets.length === 0) {
    rooms.delete(code);
    log(`room ${code} closed`);
  } else {
    log(`#${sock.hgId} left room ${code}`);
  }
  // A room opening up, or vanishing, changes what is joinable.
  broadcastLobby();
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

  /*
    THE RELAY ALSO SERVES THE GAME.

    Opening headgame.html from disk gives the page a file:// origin, which some
    security software — a corporate proxy such as Netskope, measured on the machine
    this was written on — will not let reach localhost at all: fetch fails and a
    WebSocket closes with 1006 before the relay ever sees a connection. Nothing in
    the relay can fix that, because nothing arrives.

    Serving the page from here instead gives it the SAME ORIGIN as the socket it
    wants to open, so there is no cross-origin request to intercept. It also means
    a tunnel publishes the game and its relay together: one URL to share, and the
    guest needs no copy of the file.
  */
  const rawPath = String(req.url || "/").split("?")[0];
  const file = rawPath === "/" || rawPath === "/index.html"
    ? "headgame.html"
    : rawPath.replace(/^\/+/, "");
  /*
    Only files inside the project, and only the handful of types the game uses.
    Path traversal is refused outright rather than normalised, so there is no
    clever encoding to get wrong.
  */
  if (file.includes("..") || path.isAbsolute(file)) {
    res.writeHead(403).end("no");
    return;
  }
  const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".css": "text/css",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
    ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",
    ".ico": "image/x-icon",
  };
  const ext = path.extname(file).toLowerCase();
  if (!TYPES[ext]) { res.writeHead(404).end("not found"); return; }
  const full = path.join(ROOT, file);
  if (!full.startsWith(ROOT)) { res.writeHead(403).end("no"); return; }
  fs.readFile(full, (err, body) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(`not found: ${file}`);
      log(`404 ${file}`);
      return;
    }
    // Logged so it is obvious whether a browser is reaching the relay at all —
    // the difference between "the page will not load" and "the socket will not
    // open" is the whole diagnosis when something is intercepting traffic.
    log(`served ${file} to ${req.socket.remoteAddress}`);
    res.writeHead(200, {
      "content-type": TYPES[ext],
      // The file changes constantly during development; never cache it.
      "cache-control": "no-store",
    });
    res.end(body);
  });
  return;
});

server.on("upgrade", (req, sock) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) { sock.destroy(); return; }

  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  /*
    A PROXY THAT REWRITES THE HANDSHAKE cannot be made to work from here.
    Cloudflare's free quick tunnels (trycloudflare.com) generate their own
    Sec-WebSocket-Key toward the origin but then validate the origin's
    Sec-WebSocket-Accept against the CLIENT's key, so the two can never agree and
    every upgrade fails with a 500 no matter what this server replies.

    Detected and logged rather than worked around, because there is no correct
    reply available: whatever hash we send is checked against a key we were never
    told. The operator needs to know to use a different tunnel, and a silent 500
    from Cloudflare tells them nothing.
  */
  if (/^cloudflare/i.test(req.headers["cf-worker"] || "") ||
      /trycloudflare\.com/i.test(req.headers.host || "")) {
    log("WARNING: this request came through a Cloudflare quick tunnel, which " +
        "rewrites the WebSocket handshake key. The upgrade will fail no matter " +
        "what we reply. Use a NAMED cloudflare tunnel, or a different tunnel.");
  }
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
      sock.hgSeat = 0;                     // the host is always seat 0
      /*
        Room METADATA, so the lobby browser has something to show. Supplied by the
        host and sanitised here rather than trusted: it is displayed on other
        people's screens, so a name is length-capped and stripped of control
        characters, and the mode must be one this relay knows about.
      */
      rooms.set(code, {
        sockets: [sock],
        created: Date.now(),
        nextSeat: 1,
        name: cleanRoomName(msg.name),
        mode: cleanRoomMode(msg.mode),
        max: msg.mode === "tournament" ? ROOM_MAX : 2,
        started: false,
        private: !!msg.private,            // hidden from the listing
      });
      sock.hgRoom = code;
      send(sock, { t: "hosting", code });
      log(`room ${code} opened by #${sock.hgId} (${msg.mode || "match"})`);
      broadcastLobby();
      return;
    }
    /*
      LIST. Everything currently joinable, so a player can pick a game instead of
      being told a code. A socket that asks stays subscribed, and is pushed a fresh
      list whenever a room opens, fills, starts or closes — polling for this would
      either lag or hammer the relay.
    */
    if (msg.t === "list") {
      sock.hgWatching = true;
      watchers.add(sock);
      send(sock, { t: "lobbies", rooms: lobbyList() });
      return;
    }
    if (msg.t === "unlist") {
      sock.hgWatching = false;
      watchers.delete(sock);
      return;
    }
    /*
      QUICK. Join the fullest room that still has space, so players collect into
      one game rather than scattering across several half-empty ones. Falls back to
      telling the caller there is nothing to join, which is its cue to host.
    */
    if (msg.t === "quick") {
      /*
        A mode is a PREFERENCE, not a filter. cleanRoomMode always returns
        something, so filtering by it unconditionally meant a bare "quick" was
        silently treated as "match only" and reported no lobbies while a
        tournament sat open. Preferred rooms are tried first, then anything.
      */
      const want = msg.mode === undefined ? null : cleanRoomMode(msg.mode);
      const all = lobbyList();
      if (!all.length) { send(sock, { t: "no-lobbies" }); return; }
      const preferred = want ? all.filter((r) => r.mode === want) : [];
      const pick = (preferred.length ? preferred : all)
        // Fullest first, so players collect into one game rather than scattering
        // across several half-empty ones.
        .sort((a, b) => b.players - a.players)[0];
      msg = { t: "join", code: pick.code };
      // Falls through to the join handler below.
    }
    /*
      STARTED / RENAMED. A host tells the relay when its game begins or its
      details change, so the listing stops offering a match already in progress.
    */
    if (msg.t === "room-state") {
      const room = rooms.get(sock.hgRoom);
      if (room && room.sockets[0] === sock) {
        if (msg.started !== undefined) room.started = !!msg.started;
        if (msg.name !== undefined) room.name = cleanRoomName(msg.name);
        if (msg.mode !== undefined) {
          room.mode = cleanRoomMode(msg.mode);
          room.max = room.mode === "tournament" ? ROOM_MAX : 2;
        }
        broadcastLobby();
      }
      return;
    }
    if (msg.t === "join") {
      const code = String(msg.code || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) { send(sock, { t: "no-room", code }); return; }
      if (room.sockets.length >= (room.max || ROOM_MAX)) {
        send(sock, { t: "room-full", code });
        return;
      }
      if (room.started) { send(sock, { t: "room-started", code }); return; }
      sock.hgSeat = room.nextSeat++;
      room.sockets.push(sock);
      sock.hgRoom = code;
      send(sock, { t: "joined", code, seat: sock.hgSeat,
                   name: room.name, mode: room.mode });
      broadcastLobby();
      /*
        Tell the host who arrived. `seat` is what lets a tournament host keep its
        players apart — with a single opponent it is ignored, so the 1v1 flow is
        unchanged.
      */
      for (const s of room.sockets) {
        if (s !== sock) send(s, { t: "peer-joined", seat: sock.hgSeat });
      }
      log(`#${sock.hgId} joined room ${code} as seat ${sock.hgSeat}`);
      return;
    }

    const room = rooms.get(sock.hgRoom);
    if (!room) return;

    /*
      ROUTING. A message with `to` goes to that seat alone; everything else is
      broadcast to the rest of the room. Stamped with `from` so the host can
      attribute what it receives — a tournament needs to know which of fifteen
      players sent a given packet, and a 1v1 match simply ignores the field.

      The relay still does not parse game traffic: it reads `to` and adds `from`,
      and passes the rest through untouched.
    */
    const stamped = JSON.stringify(Object.assign({}, msg, { from: sock.hgSeat }));
    for (const s of room.sockets) {
      if (s === sock || s.destroyed) continue;
      if (msg.to !== undefined && s.hgSeat !== msg.to) continue;
      try { s.write(encodeFrame(stamped)); } catch (e) { /* gone */ }
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
  const gone = () => { watchers.delete(sock); dropSocket(sock); };
  sock.on("end", gone);
  sock.on("error", gone);
  sock.on("close", gone);
  sock.on("timeout", gone);
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
  console.log("  For players outside your network, run a tunnel and share its URL.");
  console.log("");
  console.log("  Easiest — relay AND tunnel in one command:");
  console.log(`    tools/play-online.sh ${PORT}`);
  console.log("");
  console.log("  Or by hand:");
  console.log(`    ssh -R 80:localhost:${PORT} nokey@localhost.run`);
  console.log("");
  console.log("  AVOID: cloudflared's free QUICK tunnel (trycloudflare.com) rewrites");
  console.log("  the WebSocket handshake key, so every connection fails. And ngrok");
  console.log("  cannot authenticate through a TLS-inspecting corporate proxy.");
  console.log("");
  console.log(`  Change the port with:  node tools/relay.js --port <n>`);
  console.log("");
  });
}

// Only listen when run directly, never when imported.
if (require.main === module) start();

module.exports = { readFrames, encodeFrame, encodeClose, makeCode, rooms, start,
                   server, cleanRoomName, cleanRoomMode, lobbyList, ROOM_MAX,
                   // Exported so the tests can check it against the spec itself.
                   WS_GUID };
