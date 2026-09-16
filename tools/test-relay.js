#!/usr/bin/env node
/*
  Relay end-to-end test.

  Starts the real relay and drives it with two hand-written WebSocket clients —
  hand-written because the project has no dependencies and `ws` would be the
  first. This exercises the actual wire: the RFC 6455 handshake, masked client
  frames, room routing and disconnect notification.

  The in-page suite (?test=1) covers the CLIENT half against a scriptable socket.
  This covers the SERVER half against a real one. Both matter: the stubbed tests
  passed while the server was failing to notice a peer had gone.

    node tools/test-relay.js
*/

/*
  End-to-end: start the real relay, connect two real WebSocket clients (written
  by hand, since there is no ws dependency), and check a message crosses.
*/
const http = require("http");
const crypto = require("crypto");
const net = require("net");

const PORT = 8899;
process.env.PORT = String(PORT);
const relay = require("./relay.js");
relay.server.listen(PORT, "127.0.0.1", run);

function client(name, onMsg) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString("base64");
    const sock = net.connect(PORT, "127.0.0.1", () => {
      sock.write(
        `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = Buffer.alloc(0), upgraded = false;
    sock.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      if (!upgraded) {
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return;
        upgraded = true;
        buf = buf.slice(i + 4);
        resolve({ send, sock });
      }
      // Server frames are unmasked.
      while (buf.length >= 2) {
        let len = buf[1] & 0x7f, p = 2;
        if (len === 126) { len = buf.readUInt16BE(2); p = 4; }
        else if (len === 127) { len = buf.readUInt32BE(6); p = 10; }
        if (buf.length < p + len) break;
        const text = buf.slice(p, p + len).toString("utf8");
        buf = buf.slice(p + len);
        if ((buf[0] & 0x0f) !== 0x8) onMsg(text);
      }
    });
    function send(obj) {
      const payload = Buffer.from(JSON.stringify(obj), "utf8");
      const mask = crypto.randomBytes(4);
      const m = Buffer.from(payload);
      for (let i = 0; i < m.length; i++) m[i] ^= mask[i & 3];
      let header;
      if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
      else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126;
             header.writeUInt16BE(payload.length, 2); }
      sock.write(Buffer.concat([header, mask, m]));
    }
  });
}

async function run() {
  const results = [];
  let code = null, guestGot = [], hostGot = [];
  const host = await client("host", (t) => {
    const m = JSON.parse(t);
    hostGot.push(m);
    if (m.t === "hosting") code = m.code;
  });
  host.send({ t: "host" });
  await new Promise((r) => setTimeout(r, 120));
  results.push(["host receives a room code", !!code && /^[A-Z2-9]{4}$/.test(code), code]);

  const guest = await client("guest", (t) => guestGot.push(JSON.parse(t)));
  guest.send({ t: "join", code });
  await new Promise((r) => setTimeout(r, 120));
  results.push(["guest is admitted", guestGot.some((m) => m.t === "joined")]);
  results.push(["host is told a peer joined", hostGot.some((m) => m.t === "peer-joined")]);

  // Game traffic must cross, verbatim and unmodified.
  host.send({ t: "hi", n: "HOSTNAME", v: "1.6" });
  await new Promise((r) => setTimeout(r, 120));
  const relayed = guestGot.find((m) => m.t === "hi");
  results.push(["game traffic reaches the guest", !!relayed && relayed.n === "HOSTNAME"]);
  guest.send({ t: "i", b: 42 });
  await new Promise((r) => setTimeout(r, 120));
  results.push(["and back to the host", hostGot.some((m) => m.t === "i" && m.b === 42)]);

  // A wrong code is refused.
  const stray = await client("stray", () => {});
  let strayGot = [];
  const stray2 = await client("stray2", (t) => strayGot.push(JSON.parse(t)));
  stray2.send({ t: "join", code: "ZZZZ" });
  await new Promise((r) => setTimeout(r, 120));
  results.push(["a wrong code is refused", strayGot.some((m) => m.t === "no-room")]);

  // A third player in a full room is refused, not silently ignored.
  let thirdGot = [];
  const third = await client("third", (t) => thirdGot.push(JSON.parse(t)));
  third.send({ t: "join", code });
  await new Promise((r) => setTimeout(r, 120));
  results.push(["a third player is refused", thirdGot.some((m) => m.t === "room-full")]);

  // A disconnect notifies the other side.
  guest.sock.destroy();
  await new Promise((r) => setTimeout(r, 200));
  results.push(["a disconnect notifies the peer", hostGot.some((m) => m.t === "peer-left")]);

  let fails = 0;
  for (const [name, pass, extra] of results) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${!pass && extra ? "  — " + extra : ""}`);
    if (!pass) fails++;
  }
  console.log(`\n${results.length - fails} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}
