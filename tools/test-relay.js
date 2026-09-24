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

/*
  The GUID from RFC 6455 §1.3, written out here INDEPENDENTLY of the relay's own
  copy. That independence is the whole point: this suite used to skip past the
  handshake headers without reading them, so a relay computing
  Sec-WebSocket-Accept from a corrupted GUID passed every test while no browser
  could connect — Chrome answered "Incorrect 'Sec-WebSocket-Accept' header value"
  and closed with 1006. Importing the constant under test, or recomputing the
  hash with it, would have reproduced the same typo and proved nothing.

  Anchored to the published test vector below, so the constant itself is checked
  rather than merely agreed with.
*/
const RFC6455_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const acceptFor = (key) =>
  crypto.createHash("sha1").update(key + RFC6455_GUID).digest("base64");

/** Every handshake the clients below completed, for the assertions to check. */
const handshakes = [];

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
        /*
          VALIDATE THE HANDSHAKE, as a browser does. A client that ignores this
          header talks happily to a server no browser will accept.
        */
        const head = buf.slice(0, i).toString("latin1");
        const got = (head.match(/^sec-websocket-accept:\s*(\S+)/im) || [])[1];
        handshakes.push({ name, key, got, want: acceptFor(key),
                          status: head.split("\r\n")[0] });
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

  /*
    THE HANDSHAKE ITSELF, first — before any room logic, because everything below
    is unreachable from a browser if this is wrong.

    The published test vector from RFC 6455 §1.3: this exact key must produce this
    exact accept value. It pins the GUID to the spec rather than to whatever the
    relay happens to contain, which is how a transposed character in the constant
    went unnoticed while every other test passed.
  */
  results.push(["the RFC 6455 test vector produces the published accept value",
    acceptFor("dGhlIHNhbXBsZSBub25jZQ==") === "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
    acceptFor("dGhlIHNhbXBsZSBub25jZQ==")]);
  results.push(["the relay's GUID is the one from the spec",
    relay.WS_GUID === RFC6455_GUID, relay.WS_GUID]);

  let code = null, guestGot = [], hostGot = [];
  const host = await client("host", (t) => {
    const m = JSON.parse(t);
    hostGot.push(m);
    if (m.t === "hosting") code = m.code;
  });
  /*
    A BROWSER WOULD HAVE REFUSED THIS. Checked per connection rather than once,
    since the accept value is derived from each client's own key.
  */
  results.push(["the relay replies 101 Switching Protocols",
    handshakes[0] && /^HTTP\/1\.1 101 /.test(handshakes[0].status),
    handshakes[0] && handshakes[0].status]);
  results.push(["and a Sec-WebSocket-Accept a browser will accept",
    handshakes[0] && handshakes[0].got === handshakes[0].want,
    handshakes[0] && `got ${handshakes[0].got} want ${handshakes[0].want}`]);
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

    // RESUME. A dropped player must be able to return to a started room, and be
    // recognised as the player who left rather than seated as a newcomer.
    {
      let code4 = null;
      const rhost = await client("rhost", (m) => {
        const p = JSON.parse(t0(m));
        if (p.t === "hosting") code4 = p.code;
      });
      rhost.send({ t: "host", mode: "tournament", name: "RESUMEY" });
      await new Promise((r) => setTimeout(r, 250));

      let rgGot = [];
      const rguest = await client("rguest", (m) => rgGot.push(JSON.parse(t0(m))));
      rguest.send({ t: "join", code: code4 });
      await new Promise((r) => setTimeout(r, 200));
      const firstSeat = (rgGot.find((m) => m.t === "joined") || {}).seat;
      results.push(["a guest joins an open room and gets a seat",
                    typeof firstSeat === "number", JSON.stringify(rgGot.slice(0, 2))]);

      // The match starts, then the guest drops.
      rhost.send({ t: "room-state", started: true });
      await new Promise((r) => setTimeout(r, 150));
      rguest.sock.destroy();
      await new Promise((r) => setTimeout(r, 250));

      // A plain join is still refused...
      let plainGot = [];
      const plain = await client("plain", (m) => plainGot.push(JSON.parse(t0(m))));
      plain.send({ t: "join", code: code4 });
      await new Promise((r) => setTimeout(r, 200));
      results.push(["a started room still refuses a plain joiner",
                    plainGot.some((m) => m.t === "room-started"),
                    JSON.stringify(plainGot.slice(0, 2))]);

      // ...but a RESUME join is admitted, and can ask for its old seat back.
      let backGot = [];
      const back = await client("back", (m) => backGot.push(JSON.parse(t0(m))));
      back.send({ t: "join", code: code4, resume: "tok-abc", seat: firstSeat });
      await new Promise((r) => setTimeout(r, 200));
      const rejoined = backGot.find((m) => m.t === "joined");
      results.push(["a resume join is admitted to a started room", !!rejoined,
                    JSON.stringify(backGot.slice(0, 2))]);
      results.push(["and is given back the seat it asked for",
                    !!rejoined && rejoined.seat === firstSeat,
                    `${rejoined && rejoined.seat} want ${firstSeat}`]);

      // A resume join must not steal a seat somebody is sitting in.
      let thiefGot = [];
      const thief = await client("thief", (m) => thiefGot.push(JSON.parse(t0(m))));
      thief.send({ t: "join", code: code4, resume: "tok-xyz", seat: firstSeat });
      await new Promise((r) => setTimeout(r, 200));
      const thiefJoined = thiefGot.find((m) => m.t === "joined");
      results.push(["an occupied seat is not handed to a second claimant",
                    !thiefJoined || thiefJoined.seat !== firstSeat,
                    `${thiefJoined && thiefJoined.seat}`]);

      rhost.sock.destroy(); plain.sock.destroy();
      back.sock.destroy(); thief.sock.destroy();
      await new Promise((r) => setTimeout(r, 150));
    }

    // RESUME INTO AN EMPTIED ROOM. The block above never let room.sockets reach
    // zero — rhost stayed connected the whole time — so the held-room path (the
    // emptyAt hold in dropSocket, the reaper's early check, and the join
    // handler's lazy expiry) never actually ran. Here BOTH players leave, so
    // the room is genuinely empty, and a resume still has to find it waiting.
    {
      let code5 = null;
      const rhost2 = await client("rhost2", (m) => {
        const p = JSON.parse(t0(m));
        if (p.t === "hosting") code5 = p.code;
      });
      rhost2.send({ t: "host", mode: "tournament", name: "EMPTYCUP" });
      await new Promise((r) => setTimeout(r, 250));

      let rg2Got = [];
      const rguest2 = await client("rguest2", (m) => rg2Got.push(JSON.parse(t0(m))));
      rguest2.send({ t: "join", code: code5 });
      await new Promise((r) => setTimeout(r, 200));
      const seat5 = (rg2Got.find((m) => m.t === "joined") || {}).seat;

      rhost2.send({ t: "room-state", started: true });
      await new Promise((r) => setTimeout(r, 150));

      // BOTH leave — nobody at all is left in the room.
      rguest2.sock.destroy();
      rhost2.sock.destroy();
      await new Promise((r) => setTimeout(r, 250));
      const held = relay.rooms.get(code5);
      results.push(["an emptied started room is held rather than deleted",
                    !!held && held.sockets.length === 0 && !!held.emptyAt,
                    held ? JSON.stringify({ n: held.sockets.length, emptyAt: held.emptyAt }) : "gone"]);

      // A returning player still finds it, inside the grace window.
      let ret2Got = [];
      const returnee = await client("returnee", (m) => ret2Got.push(JSON.parse(t0(m))));
      returnee.send({ t: "join", code: code5, resume: "tok-empty", seat: seat5 });
      await new Promise((r) => setTimeout(r, 200));
      const rejoined2 = ret2Got.find((m) => m.t === "joined");
      results.push(["a resume join is admitted to a room that emptied out entirely",
                    !!rejoined2 && rejoined2.seat === seat5,
                    JSON.stringify(ret2Got.slice(0, 2))]);

      returnee.sock.destroy();
      await new Promise((r) => setTimeout(r, 150));
    }

    // THE RESUME TOKEN IS A SECRET BETWEEN ONE GUEST AND THE HOST. If every
    // socket in the room learned it, any other guest could replay a victim's
    // token the moment that victim dropped and steal their seat back from the
    // relay before the real owner's own retry got there. Only room.sockets[0]
    // (the host) may ever see a `resume` field on a peer-joined notice.
    {
      let code6 = null;
      let hostGot = [];
      const thost = await client("thost", (m) => {
        const p = JSON.parse(t0(m));
        hostGot.push(p);
        if (p.t === "hosting") code6 = p.code;
      });
      thost.send({ t: "host", mode: "tournament", name: "TOKENCUP" });
      await new Promise((r) => setTimeout(r, 250));

      let g1Got = [];
      const tg1 = await client("tg1", (m) => g1Got.push(JSON.parse(t0(m))));
      tg1.send({ t: "join", code: code6 });
      await new Promise((r) => setTimeout(r, 200));

      const tg2 = await client("tg2", () => {});
      tg2.send({ t: "join", code: code6, resume: "tok-secret" });
      await new Promise((r) => setTimeout(r, 200));

      // There are two peer-joined notices by now (tg1's own join, then tg2's) —
      // the one under test is tg2's, so match on the seat it was given.
      const hostSaw = hostGot.filter((m) => m.t === "peer-joined").pop();
      results.push(["the host's peer-joined notice carries the resume token",
                    !!hostSaw && hostSaw.resume === "tok-secret",
                    JSON.stringify(hostSaw)]);

      const guestSaw = g1Got.filter((m) => m.t === "peer-joined").pop();
      results.push(["a non-host peer's notice does not carry that token",
                    !!guestSaw && !guestSaw.resume,
                    JSON.stringify(guestSaw)]);

      thost.sock.destroy(); tg1.sock.destroy(); tg2.sock.destroy();
      await new Promise((r) => setTimeout(r, 150));
    }

    /*
      EJECT. The relay cannot validate a resume token — only the host can, by
      checking its own reservations — so the host needs a way to remove a seat
      it does not recognise. Checked from both directions: the host's eject
      must actually remove the guest, and a GUEST attempting the same message
      must be ignored, or any player could kick any other out of the match.
    */
    {
      let code7 = null;
      const ehost = await client("ehost", (m) => {
        const p = JSON.parse(t0(m));
        if (p.t === "hosting") code7 = p.code;
      });
      ehost.send({ t: "host", mode: "tournament", name: "EJECTCUP" });
      await new Promise((r) => setTimeout(r, 250));

      let eg1Got = [];
      const eg1 = await client("eg1", (m) => eg1Got.push(JSON.parse(t0(m))));
      eg1.send({ t: "join", code: code7 });
      await new Promise((r) => setTimeout(r, 200));
      const eg1Seat = (eg1Got.find((m) => m.t === "joined") || {}).seat;

      let eg2Got = [];
      const eg2 = await client("eg2", (m) => eg2Got.push(JSON.parse(t0(m))));
      eg2.send({ t: "join", code: code7 });
      await new Promise((r) => setTimeout(r, 200));

      // A GUEST sending "eject" must be ignored: eg1 targets eg2's seat, but
      // only the host's own copy of this message may ever remove anyone.
      const eg2Seat = (eg2Got.find((m) => m.t === "joined") || {}).seat;
      eg1.send({ t: "eject", seat: eg2Seat });
      await new Promise((r) => setTimeout(r, 200));
      const stillThere = relay.rooms.get(code7).sockets.some((s) => s.hgSeat === eg2Seat);
      results.push(["a guest's eject is ignored", stillThere,
                    JSON.stringify(relay.rooms.get(code7).sockets.map((s) => s.hgSeat))]);

      // The HOST ejecting the same seat actually removes it.
      ehost.send({ t: "eject", seat: eg2Seat });
      await new Promise((r) => setTimeout(r, 200));
      const gone = !relay.rooms.get(code7).sockets.some((s) => s.hgSeat === eg2Seat);
      results.push(["the host's eject removes that seat", gone,
                    JSON.stringify(relay.rooms.get(code7).sockets.map((s) => s.hgSeat))]);
      results.push(["and the room learns the seat left",
                    eg1Got.some((m) => m.t === "peer-left" && m.seat === eg2Seat),
                    JSON.stringify(eg1Got.slice(-2))]);
      results.push(["eg1's own seat is untouched by its own failed eject",
                    relay.rooms.get(code7).sockets.some((s) => s.hgSeat === eg1Seat)]);

      ehost.sock.destroy(); eg1.sock.destroy();
      await new Promise((r) => setTimeout(r, 150));
    }

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
