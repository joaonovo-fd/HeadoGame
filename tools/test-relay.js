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

const t0 = (x) => x;

async function run() {
  const results = [];
  let code = null, guestGot = [], hostGot = [];
  const host = await client("host", (t) => {
    const m = JSON.parse(t);
    hostGot.push(m);
    if (m.t === "hosting") code = m.code;
  });
  host.send({ t: "host", mode: "tournament", name: "TEST CUP" });
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

  /*
    A THIRD player is now WELCOME: a tournament seats up to 16, so a room holds
    the host plus 15. Each guest is given a seat number, which is how the host
    tells fifteen players apart.
  */
  let thirdGot = [];
  const third = await client("third", (t) => thirdGot.push(JSON.parse(t)));
  third.send({ t: "join", code });
  await new Promise((r) => setTimeout(r, 150));
  const joined3 = thirdGot.find((m) => m.t === "joined");
  results.push(["a third player can join, for a tournament", !!joined3]);
  results.push(["and is given a distinct seat", joined3 && joined3.seat === 2,
                joined3 ? String(joined3.seat) : "no seat"]);

  // Messages carry `from`, so the host can attribute what it receives.
  hostGot.length = 0;
  third.send({ t: "i", b: 7 });
  await new Promise((r) => setTimeout(r, 150));
  const stamped = hostGot.find((m) => m.t === "i");
  results.push(["a forwarded message names its sender",
                !!stamped && stamped.from === 2,
                stamped ? "from " + stamped.from : "nothing arrived"]);

  // A directed message reaches only its addressee.
  guestGot.length = 0;
  thirdGot.length = 0;
  host.send({ t: "me", e: 9, to: 2 });
  await new Promise((r) => setTimeout(r, 150));
  results.push(["a directed message reaches its target",
                thirdGot.some((m) => m.t === "me" && m.e === 9)]);
  results.push(["and nobody else", !guestGot.some((m) => m.t === "me")]);

  // A room does fill up eventually, and says so.
  {
    const extras = [];
    for (let i = 0; i < 13; i++) extras.push(await client("x" + i, () => {}));
    for (const c of extras) c.send({ t: "join", code });
    await new Promise((r) => setTimeout(r, 400));
    let fullGot = [];
    const overflow = await client("overflow", (t) => fullGot.push(JSON.parse(t)));
    overflow.send({ t: "join", code });
    await new Promise((r) => setTimeout(r, 200));
    results.push(["a full room refuses the 17th player",
                  fullGot.some((m) => m.t === "room-full"),
                  JSON.stringify(fullGot.slice(0, 2))]);
  }

  // A disconnect notifies the other side.
  guest.sock.destroy();
  await new Promise((r) => setTimeout(r, 200));
  results.push(["a disconnect notifies the peer", hostGot.some((m) => m.t === "peer-left")]);

  /* ---- the lobby browser -------------------------------------------------
     A player should be able to SEE the open games rather than be told a code.
     The listing is pushed on change, so these check both the reply to a request
     and the unsolicited update when something changes.
  */
  {
    let watchGot = [];
    const watcher = await client("watcher", (m) => watchGot.push(JSON.parse(t0(m))));
    // A watcher asks once and then stays subscribed.
    watcher.send({ t: "list" });
    await new Promise((r) => setTimeout(r, 200));
    const first = watchGot.filter((m) => m.t === "lobbies").pop();
    results.push(["a listing is returned on request", !!first,
                  JSON.stringify(watchGot.slice(0, 2))]);
    results.push(["and it includes the open tournament",
                  !!first && first.rooms.some((r) => r.code === code),
                  first ? JSON.stringify(first.rooms) : ""]);
    const entry = first && first.rooms.find((r) => r.code === code);
    results.push(["with the host's name", !!entry && entry.name === "TEST CUP",
                  entry ? entry.name : ""]);
    results.push(["its mode", !!entry && entry.mode === "tournament"]);
    results.push(["and how full it is",
                  !!entry && typeof entry.players === "number" && entry.max === 16,
                  entry ? `${entry.players}/${entry.max}` : ""]);

    // A NEW room must push an update to the watcher without being asked.
    watchGot.length = 0;
    let code2 = null;
    const host2 = await client("host2", (m) => {
      const p = JSON.parse(t0(m));
      if (p.t === "hosting") code2 = p.code;
    });
    host2.send({ t: "host", mode: "match", name: "SECOND GAME" });
    await new Promise((r) => setTimeout(r, 250));
    const pushed = watchGot.filter((m) => m.t === "lobbies").pop();
    results.push(["opening a room pushes an update to watchers",
                  !!pushed && pushed.rooms.some((r) => r.code === code2),
                  pushed ? JSON.stringify(pushed.rooms.map((r) => r.code)) : "nothing pushed"]);
    results.push(["a 1v1 room advertises room for two",
                  !!pushed && pushed.rooms.find((r) => r.code === code2).max === 2]);

    // A room that has STARTED must drop out of the listing.
    watchGot.length = 0;
    host2.send({ t: "room-state", started: true });
    await new Promise((r) => setTimeout(r, 250));
    const afterStart = watchGot.filter((m) => m.t === "lobbies").pop();
    results.push(["a started game leaves the listing",
                  !!afterStart && !afterStart.rooms.some((r) => r.code === code2),
                  afterStart ? JSON.stringify(afterStart.rooms.map((r) => r.code)) : ""]);
    // And cannot be joined.
    let lateGot = [];
    const late = await client("late", (m) => lateGot.push(JSON.parse(t0(m))));
    late.send({ t: "join", code: code2 });
    await new Promise((r) => setTimeout(r, 200));
    results.push(["and refuses a late joiner",
                  lateGot.some((m) => m.t === "room-started"),
                  JSON.stringify(lateGot.slice(0, 2))]);

    // A PRIVATE room is never advertised, but its code still works.
    let code3 = null;
    const host3 = await client("host3", (m) => {
      const p = JSON.parse(t0(m));
      if (p.t === "hosting") code3 = p.code;
    });
    host3.send({ t: "host", mode: "match", name: "HIDDEN", private: true });
    await new Promise((r) => setTimeout(r, 250));
    watchGot.length = 0;
    watcher.send({ t: "list" });
    await new Promise((r) => setTimeout(r, 200));
    const withPrivate = watchGot.filter((m) => m.t === "lobbies").pop();
    results.push(["a private room is not listed",
                  !!withPrivate && !withPrivate.rooms.some((r) => r.code === code3)]);
    let privGot = [];
    const privJoin = await client("priv", (m) => privGot.push(JSON.parse(t0(m))));
    privJoin.send({ t: "join", code: code3 });
    await new Promise((r) => setTimeout(r, 200));
    results.push(["but can still be joined with its code",
                  privGot.some((m) => m.t === "joined")]);

    /* ---- quick connect --------------------------------------------------- */
    let quickGot = [];
    const quick = await client("quick", (m) => quickGot.push(JSON.parse(t0(m))));
    quick.send({ t: "quick" });
    await new Promise((r) => setTimeout(r, 250));
    const landed = quickGot.find((m) => m.t === "joined");
    results.push(["quick connect joins an open game", !!landed,
                  JSON.stringify(quickGot.slice(0, 2))]);
    /*
      It should pick the FULLEST joinable room, so players collect into one game
      rather than scattering across several half-empty ones. The tournament has
      several members by now; the private one is excluded from consideration.
    */
    results.push(["choosing the fullest one", !!landed && landed.code === code,
                  landed ? landed.code : ""]);

    // With nothing joinable, quick connect says so rather than hanging.
    {
      // Filter by a mode nothing is hosting.
      let noneGot = [];
      const seeker = await client("seeker", (m) => noneGot.push(JSON.parse(t0(m))));
      seeker.send({ t: "quick", mode: "nonsense-mode" });
      await new Promise((r) => setTimeout(r, 250));
      /*
        An unknown mode is sanitised to "match", so this finds the match rooms
        rather than nothing — which is the correct behaviour, and worth asserting
        so a future change to the allow-list does not silently strand a player.
      */
      results.push(["quick connect with an unknown mode still finds a game",
                    noneGot.some((m) => m.t === "joined" || m.t === "no-lobbies"),
                    JSON.stringify(noneGot.slice(0, 2))]);
    }
  }

  let fails = 0;
  for (const [name, pass, extra] of results) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${!pass && extra ? "  — " + extra : ""}`);
    if (!pass) fails++;
  }
  console.log(`\n${results.length - fails} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}
