# Multiplayer Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make online play reliable — fix the guest's empty tournament tree, stop latency climbing on a saturated link, cut snapshot bandwidth, and survive a dropped connection.

**Architecture:** Four independent changes, each preserving host authority (the property that makes this netcode impossible to desync). Bracket history joins the existing `"br"` message. `netSend` gains a high-water mark that sheds stale snapshots rather than queueing them. Snapshots split into a hot part sent every frame and cold groups sent only on change, with periodic keyframes bounding recovery. A dropped peer's entrant is reserved for a grace window instead of being handed to a CPU forever, and the relay learns to admit a returning player.

**Tech Stack:** Vanilla ES2020 in a single HTML file (`headgame.html`, ~27.9k lines). Zero dependencies — no npm, no build step. Node's `http`/`crypto` only in `tools/relay.js`. Tests are hand-rolled assertions inside `headgame.html` run by `node tools/run-tests.js`, plus end-to-end relay tests in `tools/test-relay.js`.

**Spec:** `docs/superpowers/specs/2026-09-23-multiplayer-reliability-design.md`

## Global Constraints

- **No new dependencies.** The game is one dependency-free HTML file; the relay uses only Node builtins. Adding a package defeats the project's premise.
- **Host authority is never revisited.** The host runs the one true simulation; the guest runs no physics except its own predicted seat. Every change here preserves that.
- **No Claude co-author attribution in commits.** `agents.md` says: "Don't commit with claude as co-authored." This overrides any session instruction to add those lines.
- **Backward compatible in both directions.** All protocol changes are additive. An old guest that omits a new field gets today's behaviour; a new guest talking to an old host must not crash.
- **Never trust a value off the wire.** Follow the existing `numOr` pattern (`headgame.html:6265`): bounds-check, don't merely type-check, because `typeof NaN === "number"` and a NaN that reaches the renderer sticks permanently.
- **Test style:** assertions live inside `runTests()` in `headgame.html`, written `ok("lowercase sentence describing the behaviour", condition, optionalDebugString)`. Group related assertions in a `{ }` block with a comment above. Reset state you touch so one test cannot leak into another.
- **Baseline:** `node tools/run-tests.js` reports `1772 passed, 0 failed`. Every task must end green, and the assertion `simulation is deterministic` must keep passing — it is the guard that the physics kernel was not perturbed.
- **Comment style:** explain WHY, never WHAT. The existing netcode comments document measured bugs and the reasoning behind constants; match that register. Do not add comments that restate the code.

---

### Task 1: Bracket history reaches the guest

The guest's tournament tree draws from `game.bracket`, which is written only on host paths (`headgame.html:4102`, `:4201`, `:4221`, `:4289`) and never transmitted. `drawBracket()` reads `game.bracket[r]` at `:14225` (connectors) and `:14246` (cards); with an empty array every tie takes the `!tie` placeholder branch at `:14258`, so the guest sees a correctly-sized but entirely blank skeleton.

`drawBracket()` needs no change. It already renders history correctly — it has never been given any.

**Files:**
- Modify: `headgame.html:6885-6905` (`netSendBracket` — add `bk` to the message)
- Modify: `headgame.html:6659-6688` (the `"br"` handler — adopt `bk`)
- Test: `headgame.html`, inside `runTests()`, immediately after the existing bracket round-trip block that ends at `:17981` with `ok("the guest can tell which tie is online", ...)`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the `"br"` message gains field `bk` — an array of rounds, each round an array of ties, each tie the 4-tuple `[a, b, winner, score]` where `a`/`b` are entrant ids (`b` is `null` for a bye), `winner` is an entrant id or `null`, and `score` is a two-element number array or `null`. Task 4 re-sends a bracket on reconnect and relies on this shape.

- [ ] **Step 1: Write the failing test**

Insert this block in `runTests()` directly after the existing bracket round-trip block (the one whose last assertion is `ok("the guest can tell which tie is online", ...)` at `headgame.html:17981`).

```js
    // The bracket HISTORY round-trips, so the guest can draw the tree. Without
    // `bk` every tie fell into drawBracket's placeholder branch and the guest
    // saw an empty skeleton for the whole tournament.
    {
      net.active = true; net.role = "host";
      game.mode = MODE.TOURNAMENT;
      game.entrantCount = 4;
      game.rosterNames = ["AY", "BEE", "CEE", "DEE"];
      game.rosterCpu = [false, false, false, false];
      startTournament();

      // Decide the first tie, so there is real history to carry.
      game.seats = [game.roundPairs[0][0], game.roundPairs[0][1]];
      game.score = [3, 1];
      resolveTie(0, false);
      const winId = game.seats[0];

      const sent = [];
      const realChan = net.chan;
      net.chan = { readyState: "open", send: (d) => sent.push(JSON.parse(d)) };
      netSendBracket();
      net.chan = realChan;
      const msg = sent.find((m) => m.t === "br");
      ok("the bracket message carries the history", !!msg && Array.isArray(msg.bk));

      // Adopt it as a guest with nothing of its own.
      net.role = "guest";
      game.bracket = [];
      game.entrants = [];
      netHandle(msg);
      ok("the guest rebuilds the bracket rounds", game.bracket.length >= 1,
         `${game.bracket.length}`);
      ok("the guest sees the decided winner",
         !!game.bracket[0] && game.bracket[0][0].winner === winId,
         `${game.bracket[0] && game.bracket[0][0].winner} want ${winId}`);
      ok("the guest sees the tie score",
         !!game.bracket[0] && Array.isArray(game.bracket[0][0].score) &&
         game.bracket[0][0].score.join(",") === "3,1",
         JSON.stringify(game.bracket[0] && game.bracket[0][0].score));
      ok("a bye keeps its null second slot",
         game.bracket[0].every((t) => t.b === null || typeof t.b === "number"));
      ok("drawing the guest's bracket does not throw",
         (() => { game.scene = SCENE.BRACKET; try { drawBracket(); return true; }
                  catch (e) { return false; } })());

      // Rubbish off the wire must not reach the renderer.
      game.bracket = [];
      netHandle({ ...msg, bk: [[[99999, "nonsense", {}, "bad"]], null, 7] });
      ok("a malformed bracket is rejected rather than adopted",
         Array.isArray(game.bracket));
      ok("and drawing afterwards still does not throw",
         (() => { try { drawBracket(); return true; } catch (e) { return false; } })());
      netReset();
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tools/run-tests.js 2>&1 | grep -E "^FAIL|passed,"`

Expected: FAIL on `the bracket message carries the history` (and the assertions after it), because `netSendBracket` does not yet emit `bk`.

- [ ] **Step 3: Send the history from the host**

In `netSendBracket` (`headgame.html:6885`), add `bk` to the object passed to `netSend`. Put it after `ec: game.entrantCount,`:

```js
    /*
      THE BRACKET HISTORY, so the guest can draw the tree rather than an empty
      skeleton. `roundPairs` alone only describes the round in progress; every
      completed tie's winner and score lives here, and without it drawBracket
      took its "unreached tie" placeholder branch for every card on the guest's
      screen. Flattened to plain arrays because the wire carries JSON, not the
      record shape the renderer reads.
    */
    bk: (game.bracket || []).map((round) =>
      (round || []).map((tie) => [
        tie.a, tie.b ?? null, tie.winner ?? null,
        Array.isArray(tie.score) ? [tie.score[0], tie.score[1]] : null,
      ])),
```

- [ ] **Step 4: Adopt the history on the guest**

In the `"br"` handler (`headgame.html:6659`), add this immediately after the line `game.roundPairs = msg.rp;`:

```js
    /*
      The recorded history. Validated rather than trusted: drawBracket indexes
      entrants by these ids, so a bogus one would reach the renderer. An absent
      or malformed `bk` leaves the bracket as an empty array, which draws the
      placeholder tree — the old behaviour, so an older host still interoperates.
    */
    const okId = (v) => typeof v === "number" && Number.isInteger(v) &&
                        v >= 0 && v < TOURN_MAX;
    game.bracket = Array.isArray(msg.bk)
      ? msg.bk.map((round) => Array.isArray(round)
          ? round.filter((t) => Array.isArray(t) && okId(t[0])).map((t) => ({
              a: t[0],
              b: okId(t[1]) ? t[1] : null,
              winner: okId(t[2]) ? t[2] : null,
              score: Array.isArray(t[3]) &&
                     typeof t[3][0] === "number" && Number.isFinite(t[3][0]) &&
                     typeof t[3][1] === "number" && Number.isFinite(t[3][1])
                ? [t[3][0], t[3][1]] : null,
            }))
          : [])
      : [];
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node tools/run-tests.js 2>&1 | tail -3`

Expected: `1780 passed, 0 failed` (the 8 new assertions on top of 1772). No FAIL lines.

- [ ] **Step 6: Commit**

```bash
cd /Users/joao.novo/Code/Games/HeadGame
git add headgame.html
git commit -m "fix: the guest's tournament tree was always empty

game.bracket is the history drawBracket() draws from, and it was written
only on host paths and never sent. Every tie therefore took the
placeholder branch on a guest, so the tree showed no names, no scores and
no winner connectors for the whole tournament. The bracket message now
carries it, bounds-checked on arrival because those ids index entrants."
```

---

### Task 2: Backpressure and adaptive snapshot rate

`netSend` (`headgame.html:6093`) calls `send()` unconditionally, and neither file references `bufferedAmount` (verified: 0 occurrences in both). When the link carries fewer than 60 snapshots a second the surplus accumulates in the socket's send queue, so every new snapshot waits behind everything already queued. Nothing sheds load, so the delay only grows — this is the "gets worse the longer you play" failure.

A stale snapshot has no value once a newer one exists, so the fix is to **drop** rather than queue. `netInterpolate` already tolerates gaps by design: at `:6573` it holds its nearest frame rather than extrapolating.

**Files:**
- Modify: `headgame.html:5258-5268` (`relayChannelShim` — expose `bufferedAmount`)
- Modify: `headgame.html:5100-5160` area (add constants beside the other `NET_*` tunables)
- Modify: `headgame.html:6093-6100` (`netSend` — accept a droppable flag)
- Modify: `headgame.html:6869-6874` (the host branch of `netPump` — adaptive rate)
- Modify: `headgame.html:5786+` (`netReset` — initialise the new fields)
- Test: `headgame.html`, inside `runTests()`, after the Task 1 block

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `NET_SEND_HIGH_WATER` (bytes, number) — queue depth above which a snapshot is shed.
  - `NET_RATE_STEPS` (array of Hz) — `[60, 40, 30]`, the ladder the send rate walks.
  - `netBuffered()` → number: the largest `bufferedAmount` across open channels, `0` when unknown.
  - `netSend(obj, droppable)` → boolean: `true` if it was sent, `false` if shed. `droppable` defaults to `false`, so every existing call site keeps today's reliable behaviour unchanged.
  - `net.rateIdx` (index into `NET_RATE_STEPS`), `net.snapDropped` (count), `net.snapSent` (count).
  - Task 3 calls `netSend(snapshot, !isKeyframe)` so keyframes are never shed.

- [ ] **Step 1: Write the failing test**

Insert in `runTests()` after the Task 1 block.

```js
    // BACKPRESSURE. A saturated link must shed stale snapshots rather than
    // queue them: queueing is what made latency climb without ever recovering.
    {
      netReset();
      net.active = true; net.role = "host"; net.state = "live";
      let buffered = 0;
      const sentNow = [];
      net.chan = {
        readyState: "open",
        get bufferedAmount() { return buffered; },
        send: (d) => sentNow.push(JSON.parse(d)),
      };

      ok("an idle link reports no backlog", netBuffered() === 0);

      // Under the mark everything goes out.
      buffered = 0;
      sentNow.length = 0;
      ok("a snapshot is sent when the link is clear",
         netSend({ t: "s" }, true) === true && sentNow.length === 1);

      // Over the mark a droppable message is shed.
      buffered = NET_SEND_HIGH_WATER + 1;
      sentNow.length = 0;
      ok("a snapshot is dropped when the link is saturated",
         netSend({ t: "s" }, true) === false && sentNow.length === 0);

      // But a reliable one is not.
      sentNow.length = 0;
      ok("a reliable message is never dropped",
         netSend({ t: "cfg" }) === true && sentNow.length === 1);
      sentNow.length = 0;
      ok("and neither is a bracket",
         netSend({ t: "br" }, false) === true && sentNow.length === 1);

      // The rate steps DOWN while the link stays hot.
      net.rateIdx = 0;
      buffered = NET_SEND_HIGH_WATER + 1;
      for (let i = 0; i < 400; i++) { net.sendAcc = 1; netPump(); }
      ok("a saturated link steps the send rate down", net.rateIdx > 0,
         `rateIdx ${net.rateIdx}`);
      ok("the rate never falls off the ladder",
         net.rateIdx < NET_RATE_STEPS.length);
      ok("the slowest step is still a playable rate",
         NET_RATE_STEPS[NET_RATE_STEPS.length - 1] >= 30);

      // And recovers when it drains.
      buffered = 0;
      for (let i = 0; i < 2000; i++) { net.sendAcc = 1; netPump(); }
      ok("a drained link recovers the send rate", net.rateIdx === 0,
         `rateIdx ${net.rateIdx}`);

      // A channel that cannot report a backlog must not be treated as saturated.
      net.chan = { readyState: "open", send: () => {} };
      ok("an unknown backlog is treated as clear", netBuffered() === 0);
      ok("and its snapshots still go out", netSend({ t: "s" }, true) === true);
      netReset();
    }

    // The relay shim must forward bufferedAmount, or backpressure is blind on
    // the transport most players actually use.
    {
      const fake = { readyState: 1, bufferedAmount: 4242, send: () => {}, close: () => {} };
      const shim = relayChannelShim(fake);
      ok("the relay shim reports the socket's backlog", shim.bufferedAmount === 4242);
      fake.bufferedAmount = 0;
      ok("and tracks it as it drains", shim.bufferedAmount === 0);
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tools/run-tests.js 2>&1 | grep -E "^FAIL|passed,"`

Expected: FAIL with `netBuffered is not defined` surfacing as failures on the new assertions (`an idle link reports no backlog` onward).

- [ ] **Step 3: Expose `bufferedAmount` on the relay shim**

In `relayChannelShim` (`headgame.html:5258`), add a getter beside the existing `readyState` getter:

```js
    /*
      The socket's unsent backlog, so netSend can shed snapshots rather than
      queue them. Without forwarding it the shim always looked clear, which
      left backpressure blind on the relay — the transport most players use.
    */
    get bufferedAmount() { return ws.bufferedAmount || 0; },
```

- [ ] **Step 4: Add the tunables**

Add after `const NET_BEAT_HZ = 4;` (`headgame.html:5160`):

```js
/*
  SEND-QUEUE HIGH WATER MARK, in bytes.

  Above this the link is not keeping up, and a snapshot is DROPPED rather than
  queued. Queueing was the bug: nothing ever shed load, so the backlog grew
  monotonically and every snapshot waited behind everything already in it —
  latency climbed for as long as the match lasted and never came back down.

  Dropping is safe precisely because a snapshot is idempotent and superseded by
  the next one, and netInterpolate already holds its nearest frame rather than
  extrapolating when the buffer has a gap. 64KB is a few snapshots' worth: high
  enough that ordinary jitter does not trip it, low enough to bound the delay.
*/
const NET_SEND_HIGH_WATER = 64 * 1024;
/*
  The snapshot rates to walk between when the link cannot sustain the top one.
  Stepping down sheds bandwidth deliberately instead of letting the queue do it
  arbitrarily. NET_LERP_DELAY is measured in send INTERVALS, so the guest's
  render clock adapts to each step on its own with no change to interpolation.
  Nothing below 30Hz: past that the interpolation buffer's own delay becomes the
  dominant latency and stepping further would hurt more than it helps.
*/
const NET_RATE_STEPS = [60, 40, 30];
/*
  Consecutive drops before stepping down, and clear sends before stepping back
  up. Asymmetric on purpose: react quickly to a link that is failing, return
  slowly so a brief clear patch does not flap the rate back and forth.
*/
const NET_RATE_DOWN_AFTER = 8;
const NET_RATE_UP_AFTER = 240;
```

- [ ] **Step 5: Add `netBuffered` and the droppable path in `netSend`**

Replace `netSend` (`headgame.html:6093-6100`) with:

```js
/**
 * The largest unsent backlog across open channels, in bytes.
 *
 * The LARGEST, not the sum: with a hub the slowest peer is what decides whether
 * the host is keeping up, and summing would make eight healthy connections look
 * saturated. A channel that cannot report a backlog counts as 0 — treating
 * "unknown" as "full" would throttle a transport that was working fine.
 */
function netBuffered() {
  let worst = 0;
  for (const c of netChannels()) {
    const n = c.bufferedAmount;
    if (typeof n === "number" && Number.isFinite(n) && n > worst) worst = n;
  }
  return worst;
}

/**
 * Broadcast to every connected peer. Returns whether it was actually sent.
 *
 * `droppable` marks a message that may be SHED when the link is behind — only
 * snapshots, which are idempotent and superseded by the next one. Everything
 * else (hello, config, bracket, seat assignment, goodbye, and any intent byte
 * carrying an edge) is reliable and goes out regardless: dropping those loses
 * an action or a screen's worth of state rather than merely a frame.
 */
const netSend = (obj, droppable = false) => {
  const chans = netChannels();
  if (!chans.length) return false;
  if (droppable && netBuffered() > NET_SEND_HIGH_WATER) {
    net.snapDropped = (net.snapDropped || 0) + 1;
    return false;
  }
  const txt = JSON.stringify(obj);          // serialise once, not per peer
  for (const c of chans) {
    try { c.send(txt); } catch (e) { /* that peer dropped; the rest still get it */ }
  }
  if (droppable) net.snapSent = (net.snapSent || 0) + 1;
  return true;
};
```

- [ ] **Step 6: Make the host's send rate adaptive**

Replace the host branch at the end of `netPump` (`headgame.html:6869-6874`):

```js
  /*
    Host: broadcast a snapshot at the current rate rather than every substep.

    The rate walks NET_RATE_STEPS rather than being fixed. A link that cannot
    carry 60Hz will otherwise have the surplus taken out of it as queue depth,
    which is latency; stepping down spends the same shortfall as a lower update
    rate instead, which interpolation already hides.
  */
  net.sendAcc += DT;
  const hz = NET_RATE_STEPS[net.rateIdx] || NET_RATE_STEPS[0];
  if (net.sendAcc >= 1 / hz) {
    net.sendAcc = 0;
    const sent = netSend(netSnapshot(), true);
    if (sent) {
      net.rateDown = 0;
      net.rateUp = (net.rateUp || 0) + 1;
      if (net.rateUp >= NET_RATE_UP_AFTER && net.rateIdx > 0) {
        net.rateIdx--;
        net.rateUp = 0;
      }
    } else {
      net.rateUp = 0;
      net.rateDown = (net.rateDown || 0) + 1;
      if (net.rateDown >= NET_RATE_DOWN_AFTER &&
          net.rateIdx < NET_RATE_STEPS.length - 1) {
        net.rateIdx++;
        net.rateDown = 0;
      }
    }
  }
```

- [ ] **Step 7: Initialise the new fields in `netReset`**

In `netReset` (`headgame.html:5786`), add beside the other accumulator resets (near `net.snapT = 0;`):

```js
  net.rateIdx = 0;
  net.rateDown = 0;
  net.rateUp = 0;
  net.snapDropped = 0;
  net.snapSent = 0;
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node tools/run-tests.js 2>&1 | tail -3`

Expected: `1792 passed, 0 failed` (12 new assertions on top of 1780). No FAIL lines.

- [ ] **Step 9: Commit**

```bash
cd /Users/joao.novo/Code/Games/HeadGame
git add headgame.html
git commit -m "fix: latency climbed forever on a link that could not keep up

netSend queued unconditionally, so a link carrying fewer than 60
snapshots a second accumulated the surplus in the socket buffer. Nothing
shed load, so every snapshot waited behind the whole backlog and the
delay only ever grew. Snapshots are now dropped above a high water mark —
safe, because a snapshot is superseded by the next one and interpolation
already holds its nearest frame across a gap — and the send rate steps
60/40/30 while the link stays hot. Reliable messages are never shed."
```

---

### Task 3: Delta snapshots with keyframes

`netSnapshot` (`headgame.html:6181`) serialises everything every frame. The arrays dominate: each wall is ten numbers (`:6237`), and walls, mines, helpers, power-ups and world geometry change rarely while costing their full size 60 times a second.

The existing comment at `:6216` is load-bearing and must keep holding: a guest that joins late or misses a packet has to be corrected promptly rather than playing a whole match in the wrong arena. Keyframes are how that survives delta encoding.

**Files:**
- Modify: `headgame.html:5160+` (add the keyframe constant beside the other tunables)
- Modify: `headgame.html:6181-6243` (`netSnapshot` — split hot from cold)
- Modify: `headgame.html:6255+` (`netApplySnapshot` — reuse cached cold groups)
- Modify: `headgame.html:6869+` (the host branch of `netPump` — mark keyframes undroppable)
- Modify: `headgame.html:5786+` (`netReset` — initialise the cold cache)
- Test: `headgame.html`, inside `runTests()`, after the Task 2 block

**Interfaces:**
- Consumes: `netSend(obj, droppable)` from Task 2.
- Produces:
  - `netColdGroups()` → object mapping group name to its current value. Groups: `wl` (walls), `mn` (mines), `hp` (helpers), `pu` (power-ups), `wd` (world: `mp`, `gv`, `gt`, `gl`, `gr`).
  - Snapshot field `k: 1` marks a keyframe (every group present).
  - `net.coldCache` — the guest's last known value per group.
  - `netSnapshot(force)` → snapshot object; `force` truthy produces a keyframe.

- [ ] **Step 1: Write the failing test**

Insert in `runTests()` after the Task 2 block.

```js
    // DELTA SNAPSHOTS. The cold arrays cost their full size 60 times a second
    // while barely ever changing, so they are sent on change plus a keyframe.
    {
      netReset();
      net.active = true; net.role = "host";
      game.walls = [];
      game.mines = [];
      game.helpers = [];
      game.powerups = [];

      const key = netSnapshot(true);
      ok("a keyframe is marked as one", key.k === 1);
      ok("a keyframe carries every cold group",
         "wl" in key && "mn" in key && "hp" in key && "pu" in key && "wd" in key);

      // Nothing changed, so a delta omits them.
      const d1 = netSnapshot(false);
      ok("a delta omits unchanged cold groups",
         !("wl" in d1) && !("mn" in d1) && !("wd" in d1),
         JSON.stringify(Object.keys(d1)));
      ok("but a delta always carries the hot state",
         Array.isArray(d1.b) && Array.isArray(d1.p) && typeof d1.tm === "number");

      // A changed group reappears.
      game.walls = [{ x: 10, y: 20, w: 30, h: 40, owner: 0, platform: false,
                      life: 5, hp: 2, born: 0, grounded: true }];
      const d2 = netSnapshot(false);
      ok("a changed cold group is sent again", Array.isArray(d2.wl) && d2.wl.length === 1,
         JSON.stringify(d2.wl));

      // A guest fed deltas must end up identical to one fed keyframes.
      net.role = "guest";
      net.coldCache = {};
      netApplySnapshot(netSnapshot(true));
      const wallsAfterKey = JSON.stringify(game.walls.map((w) => [w.x, w.y, w.w, w.h]));
      game.walls = [];
      netApplySnapshot(d1);                    // a delta with no wall data
      ok("a guest reuses the cached cold group",
         JSON.stringify(game.walls.map((w) => [w.x, w.y, w.w, w.h])) === wallsAfterKey ||
         game.walls.length === 0,
         "cached walls must not be lost to a delta");

      // A KEYFRAME repairs a guest that missed a cold update — the whole reason
      // delta encoding is safe here.
      net.role = "host";
      game.walls = [{ x: 99, y: 88, w: 20, h: 20, owner: 1, platform: true,
                      life: 3, hp: 1, born: 0, grounded: false }];
      const repair = netSnapshot(true);
      net.role = "guest";
      game.walls = [];
      netApplySnapshot(repair);
      ok("a keyframe repairs a stale guest",
         game.walls.length === 1 && Math.round(game.walls[0].x) === 99,
         JSON.stringify(game.walls.map((w) => w.x)));

      // World geometry survives a delta that omits it.
      net.role = "host";
      game.mapId = mapById(game.mapId) ? game.mapId : game.mapId;
      const keyWorld = netSnapshot(true);
      net.role = "guest";
      netApplySnapshot(keyWorld);
      const gravAfter = gravity;
      netApplySnapshot(netSnapshot(false));
      ok("gravity is not lost when a delta omits the world group",
         gravity === gravAfter, `${gravity} vs ${gravAfter}`);

      // Rubbish in a cold group must not stick.
      netApplySnapshot({ ...keyWorld, wd: { gv: NaN, gt: "x" } });
      ok("a NaN in the world group is refused",
         Number.isFinite(gravity), `${gravity}`);
      netReset();
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tools/run-tests.js 2>&1 | grep -E "^FAIL|passed,"`

Expected: FAIL on `a keyframe is marked as one` and the rest — `netSnapshot` takes no argument and never sets `k`.

- [ ] **Step 3: Add the keyframe-interval constant**

Add after the Task 2 constants:

```js
/*
  How often the host sends a FULL snapshot regardless of what changed.

  Delta encoding is only safe with a floor like this. A guest that joins late,
  or misses the one packet that carried a cold group, would otherwise play the
  rest of the match in the wrong arena — the exact failure the old
  every-frame-everything snapshot existed to prevent. One second bounds the
  worst case to something nobody notices, at a cost of one full snapshot a
  second. A keyframe is also sent on any scene change, where the whole world
  changes at once and waiting up to a second would be visible.
*/
const NET_KEYFRAME_SEC = 1;
```

- [ ] **Step 4: Split the snapshot into hot and cold**

In `netSnapshot` (`headgame.html:6181`), extract the cold groups into their own function and make the snapshot take a `force` flag. Keep every existing rounding helper and field exactly as it is — only the grouping changes.

Add immediately before `netSnapshot`:

```js
/**
 * The parts of the world that change RARELY, grouped so each can be sent only
 * when it actually changes.
 *
 * Walls, mines, helpers and power-ups are arrays that are usually empty or
 * static, and the world group is geometry that changes on a map change, a chaos
 * re-roll or a power-up. Sending all of it 60 times a second cost the most
 * bandwidth in the snapshot while carrying the least new information.
 */
function netColdGroups() {
  const round = (v) => Math.round(v * 10) / 10;
  const rate = (v) => Math.round(v * 10000) / 10000;
  return {
    wl: game.walls.map((w) => [
      Math.round(w.x), Math.round(w.y), Math.round(w.w), Math.round(w.h),
      w.owner, w.platform ? 1 : 0, round(w.life), w.hp,
      round(w.born), w.grounded ? 1 : 0,
    ]),
    mn: game.mines.map((m) => [Math.round(m.x), Math.round(m.y), round(m.arm)]),
    hp: game.helpers.map((h) => [Math.round(h.x), Math.round(h.y), h.kind, h.owner]),
    pu: game.powerups.map((p) => [Math.round(p.x), Math.round(p.y), p.type]),
    wd: {
      mp: game.mapId,
      gv: Math.round(gravity),
      gt: rate(goalTravel),
      gl: rate(goalSpeedL),
      gr: rate(goalSpeedR),
    },
  };
}
```

Then restructure `netSnapshot` itself, in three edits:

1. Change the signature to `function netSnapshot(force = false) {`.
2. Change `return {` (`headgame.html:6191`) to `const snap = {` — the object is now built, added to, then returned.
3. **Remove** the `pu`, `mn`, `hp`, `wl`, `mp`, `gv`, `gt`, `gl` and `gr` fields from that object; they come from `netColdGroups()` now. Keep every other field and both rounding helpers exactly as they are.

Then replace the object's closing `};` (`headgame.html:6242`) with the merge:

```js
  };

  /*
    Merge in whichever cold groups have changed since the last send, or all of
    them on a keyframe. Compared by their serialised form: these are small and
    change rarely, so a string compare per group per frame is far cheaper than
    the bandwidth it saves, and it cannot disagree with what actually went out.
  */
  const cold = netColdGroups();
  net.coldSent = net.coldSent || {};
  const keyframe = !!force;
  if (keyframe) snap.k = 1;
  for (const g of Object.keys(cold)) {
    const txt = JSON.stringify(cold[g]);
    if (keyframe || net.coldSent[g] !== txt) {
      snap[g] = cold[g];
      net.coldSent[g] = txt;
    }
  }
  return snap;
}
```

This requires naming the returned object. Change `return {` to `const snap = {` at the top of the existing return, so the merge above can add to it.

- [ ] **Step 5: Reuse cached cold groups on the guest**

In `netApplySnapshot` (`headgame.html:6255`), replace the block that reads `s.mp`/`s.gv`/`s.gt`/`s.gl`/`s.gr` with a version that reads from the world group and falls back to the cache. Add near the top of the function, after the `numOr` definition:

```js
  /*
    COLD GROUPS. A delta omits any group that has not changed, so the last known
    value is kept and reused. Without this cache a delta would read as "the
    walls are gone" and the guest would lose every platform on the first frame
    that did not re-send them.

    A keyframe carries every group, so a guest that joined late or missed an
    update is repaired within NET_KEYFRAME_SEC rather than for the whole match.
  */
  net.coldCache = net.coldCache || {};
  for (const g of ["wl", "mn", "hp", "pu", "wd"]) {
    if (s[g] !== undefined) net.coldCache[g] = s[g];
  }
  const cold = net.coldCache;
  const wd = (cold.wd && typeof cold.wd === "object") ? cold.wd : {};
```

Then change the geometry adoption to read from `wd` instead of `s`:

```js
  if (typeof wd.mp === "string" && mapById(wd.mp)) game.mapId = wd.mp;
  gravity    = numOr(wd.gv, gravity, 1, 20000);
  goalTravel = numOr(wd.gt, goalTravel, 0, GROUND_Y);
  goalSpeedL = numOr(wd.gl, goalSpeedL, -8, 8);
  goalSpeedR = numOr(wd.gr, goalSpeedR, -8, 8);
```

Find every other place in `netApplySnapshot` (and any helper it calls) that reads `s.wl`, `s.mn`, `s.hp` or `s.pu` and point it at `cold.wl`, `cold.mn`, `cold.hp`, `cold.pu` instead, each guarded with `Array.isArray(...)` before use. Locate them with:

```bash
cd /Users/joao.novo/Code/Games/HeadGame
sed -n '6255,6395p' headgame.html | grep -n "s\.\(wl\|mn\|hp\|pu\|mp\|gv\|gt\|gl\|gr\)\b"
```

- [ ] **Step 6: Send keyframes on a timer and on scene change, undroppable**

In the host branch of `netPump` (the code from Task 2 Step 6), replace the snapshot construction so a keyframe is forced on the timer or a scene change, and is never shed:

```js
  net.sendAcc += DT;
  const hz = NET_RATE_STEPS[net.rateIdx] || NET_RATE_STEPS[0];
  if (net.sendAcc >= 1 / hz) {
    net.sendAcc = 0;
    /*
      A keyframe on a timer, and on any scene change — where the whole world
      turns over at once and waiting up to a second would be visible. Keyframes
      are NEVER droppable: a saturated link that shed them would leave a guest
      permanently stale, which is the one failure delta encoding must not add.
    */
    net.keyAcc = (net.keyAcc || 0) + 1 / hz;
    const sceneChanged = net.keyScene !== game.scene;
    const keyframe = sceneChanged || net.keyAcc >= NET_KEYFRAME_SEC;
    if (keyframe) { net.keyAcc = 0; net.keyScene = game.scene; }
    const sent = netSend(netSnapshot(keyframe), !keyframe);
    if (sent) {
```

Keep the rest of the rate-ladder body from Task 2 unchanged below this point.

- [ ] **Step 7: Initialise the caches in `netReset`**

Add to `netReset` beside the Task 2 fields:

```js
  net.coldSent = {};
  net.coldCache = {};
  net.keyAcc = 0;
  net.keyScene = null;
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node tools/run-tests.js 2>&1 | tail -3`

Expected: `1803 passed, 0 failed` (11 new assertions on top of 1792). No FAIL lines.

Also confirm the physics guard specifically:

Run: `node tools/run-tests.js 2>&1 | grep "deterministic"`

Expected: `PASS  simulation is deterministic`

- [ ] **Step 9: Commit**

```bash
cd /Users/joao.novo/Code/Games/HeadGame
git add headgame.html
git commit -m "perf: send rarely-changing world state only when it changes

Walls, mines, helpers, power-ups and world geometry were re-serialised 60
times a second while changing almost never — the walls alone are ten
numbers each. They now go out on change, plus a full keyframe every
second and on every scene change. The keyframe is what keeps this safe:
a guest that joins late or misses a cold update is repaired within a
second instead of playing the rest of the match in the wrong arena, and
keyframes are exempt from backpressure shedding for the same reason."
```

---

### Task 4: Reconnect with entrant reclaim

Today a dropped socket is terminal. `ws.onclose` (`headgame.html:5580`) and `chan.onclose` (`:5911`) set `net.state = "closed"`, and there is no retry anywhere in the file. Host-side, `netDropPeer` (`:6138`) hands the entrant to a CPU permanently after `NET_TIMEOUT`.

The relay blocks return twice over: `tools/relay.js:520` refuses any join to a room with `started === true`, and `:521` assigns `room.nextSeat++`, so a returning player is indistinguishable from a new one.

**Decided behaviour:** a CPU takes the seat immediately so the bracket never stalls; the human may reclaim their entrant inside a grace window; after it expires the CPU keeps it for good.

**Files:**
- Modify: `tools/relay.js:512-537` (the `join` handler — accept a resume token and a seat request)
- Modify: `tools/relay.js:288-311` (`dropSocket` — keep a started room alive briefly for a return)
- Modify: `headgame.html:5160+` (grace-window constant)
- Modify: `headgame.html:6138-6156` (`netDropPeer` — reserve rather than surrender)
- Modify: `headgame.html:5580-5583` (`ws.onclose` — retry instead of dying)
- Modify: `headgame.html:5786+` (`netReset` — initialise resume state)
- Test: `tools/test-relay.js` (relay side, after the started-room block ending at `:272`)
- Test: `headgame.html`, inside `runTests()`, after the Task 3 block

**Interfaces:**
- Consumes: `netSendBracket` with `bk` (Task 1), `netSnapshot(force)` (Task 3).
- Produces:
  - `NET_GRACE_SEC` — the single grace window, shared by host reservation and guest retry budget so the two cannot disagree about when hope runs out.
  - Relay `join` accepts `resume` (string token) and `seat` (number); replies `joined` with the granted seat.
  - `net.resumeToken` (string), `net.resumeTries` (number), `net.resumeAt` (seconds).
  - Host: `net.reserved` — map of resume token to `{ entrantId, seat, deadline }`.

- [ ] **Step 1: Write the failing relay test**

In `tools/test-relay.js`, insert after the block that ends with the `and refuses a late joiner` assertion (`:270-272`).

```js
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
      rguest.close();
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

      rhost.close(); plain.close(); back.close(); thief.close();
      await new Promise((r) => setTimeout(r, 150));
    }
```

- [ ] **Step 2: Run the relay test to verify it fails**

Run: `node tools/test-relay.js 2>&1 | tail -20`

Expected: FAIL on `a resume join is admitted to a started room` — `relay.js:520` refuses it.

- [ ] **Step 3: Accept resume joins in the relay**

In `tools/relay.js`, replace the `started` refusal and seat assignment inside the `join` handler (`:520-521`):

```js
      /*
        A STARTED room refuses a newcomer but admits a RETURNING player.

        Without this a dropped connection ended a match permanently: the game
        retried, the relay said "room-started", and there was nowhere to go
        back to. A resume join carries a token the host issued, so the room can
        tell "I was in this match" from "let me into your match".
      */
      const resume = typeof msg.resume === "string" && msg.resume.length
        ? msg.resume.slice(0, 64) : null;
      if (room.started && !resume) { send(sock, { t: "room-started", code }); return; }
      /*
        A returning player asks for the seat it had, so the host recognises it as
        the same machine rather than seating it as a newcomer. Granted only if
        that seat is genuinely vacant — otherwise it would evict whoever is
        sitting there, which a wrong or stale token would do by accident.
      */
      const want = Number(msg.seat);
      const vacant = Number.isInteger(want) && want >= 0 &&
                     !room.sockets.some((s) => s.hgSeat === want);
      sock.hgSeat = (resume && vacant) ? want : room.nextSeat++;
      if (resume) sock.hgResume = resume;
```

- [ ] **Step 4: Keep a started room alive through a brief gap**

In `dropSocket` (`tools/relay.js:288`), a started room whose last socket leaves is deleted immediately (`:303-305`), so there is nothing to return to. Hold it briefly instead:

```js
  if (room.sockets.length === 0) {
    /*
      A STARTED room is kept for a short while after its last socket leaves, so
      a player whose connection dropped has something to come back to. An open
      room is still deleted at once — nobody is mid-match in it, and lingering
      would advertise a game with no host.
    */
    if (room.started) {
      room.emptyAt = Date.now();
      log(`room ${code} empty, held for a return`);
    } else {
      rooms.delete(code);
      log(`room ${code} closed`);
    }
  } else {
```

A held room has to be reaped, or a relay left running leaks one room per dropped match. The existing reaper at `tools/relay.js:590` runs once a minute, which is too coarse for a 30-second hold — a room would linger up to 90s. Add the check there anyway as the backstop, and clear a stale hold lazily in the `join` handler so a returning player can never be admitted to a room whose window has already closed.

In the reaper body (`tools/relay.js:592`, inside the `for (const [code, room] of rooms)` loop), add before the existing 30-minute check:

```js
    /*
      A room held open for a returning player, whose window has closed. Reaped
      here so a long-running relay does not accumulate one dead room per
      dropped match.
    */
    if (room.sockets.length === 0 && room.emptyAt &&
        now - room.emptyAt > GRACE_MS) {
      rooms.delete(code);
      log(`room ${code} closed (nobody returned)`);
      continue;
    }
```

Add the constant near the top of `relay.js`, beside `ROOM_MAX`:

```js
/*
  How long a started room is held after its last socket leaves, so a player
  whose connection dropped has something to come back to. Must match
  NET_GRACE_SEC in the game: if the relay forgot the room first, a guest would
  still be retrying into nothing.
*/
const GRACE_MS = 30 * 1000;
```

And in the `join` handler, immediately after `const room = rooms.get(code);` (`:514`), refuse a room whose hold has expired rather than admitting a player to a dead match:

```js
      if (room && room.sockets.length === 0 && room.emptyAt &&
          Date.now() - room.emptyAt > GRACE_MS) {
        rooms.delete(code);
        send(sock, { t: "no-room", code });
        return;
      }
```

- [ ] **Step 5: Run the relay test to verify it passes**

Run: `node tools/test-relay.js 2>&1 | tail -10`

Expected: all relay assertions pass, including the five new ones.

- [ ] **Step 6: Write the failing game-side test**

Insert in `runTests()` after the Task 3 block.

```js
    // RECONNECT. A dropped player's entrant is RESERVED for a grace window: a
    // CPU covers the seat so the bracket never stalls, and the human takes it
    // back if they return in time.
    {
      netReset();
      net.active = true; net.role = "host"; net.localSeat = 0;
      game.mode = MODE.TOURNAMENT;
      game.entrantCount = 4;
      game.rosterNames = ["HOSTY", "AWAY", "CEE", "DEE"];
      game.rosterCpu = [false, false, false, false];
      startTournament();

      const peer = { id: 7, entrantId: 1, name: "AWAY", chan: null,
                     lastRecv: 0, resume: "tok-1" };
      net.peers = [peer];
      game.seats = [0, 1];
      game.cpu = [false, false];

      netDropPeer(peer);
      ok("a dropped player's seat is covered by a cpu", game.cpu[1] === true);
      ok("and the bracket carries on", game.scene !== SCENE.MENU);
      ok("the entrant is reserved rather than surrendered",
         !!net.reserved && !!net.reserved["tok-1"],
         JSON.stringify(Object.keys(net.reserved || {})));
      ok("the reservation remembers which entrant",
         net.reserved["tok-1"].entrantId === 1);

      // Returning inside the window reclaims it.
      const got = netResume("tok-1");
      ok("a return inside the window reclaims the entrant", got === 1, `${got}`);
      ok("and the cpu hands the seat back", game.cpu[1] === false);
      ok("the reservation is consumed", !net.reserved["tok-1"]);

      // Returning too late does not.
      net.peers = [peer];
      game.cpu = [false, false];
      netDropPeer(peer);
      net.reserved["tok-1"].deadline = -1;         // the window has passed
      ok("a return after the window is refused", netResume("tok-1") === null);
      ok("an unknown token is refused", netResume("nonsense") === null);
      ok("the cpu keeps the seat once the window closes", game.cpu[1] === true);
      netReset();
    }

    // The guest retries a lost connection instead of ending the match.
    {
      netReset();
      net.active = true; net.role = "guest"; net.state = "live";
      net.relayCode = "ABCD";
      net.resumeToken = "tok-g";
      ok("a guest starts with no retries spent", (net.resumeTries || 0) === 0);
      ok("the grace window is a usable length",
         NET_GRACE_SEC >= 5 && NET_GRACE_SEC <= 120, `${NET_GRACE_SEC}`);
      ok("the backoff grows rather than hammering",
         netResumeDelay(1) < netResumeDelay(3) &&
         netResumeDelay(3) < netResumeDelay(5),
         `${netResumeDelay(1)} ${netResumeDelay(3)} ${netResumeDelay(5)}`);
      ok("and is capped so it never waits absurdly long",
         netResumeDelay(99) <= NET_GRACE_SEC, `${netResumeDelay(99)}`);
      netReset();
    }
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `node tools/run-tests.js 2>&1 | grep -E "^FAIL|passed,"`

Expected: FAIL on `the entrant is reserved rather than surrendered` and on `netResume is not defined` surfacing through the later assertions.

- [ ] **Step 8: Add the grace window and backoff helper**

Add beside the other `NET_*` constants:

```js
/*
  How long a dropped player may take to come back.

  ONE constant, shared by the host's reservation deadline and the guest's retry
  budget: if the two disagreed, a guest would still be trying to rejoin a room
  that had already given its entrant away for good, or give up while its seat
  was still being held. Thirty seconds covers a phone changing network or a
  laptop waking, without leaving a CPU in a human's seat long enough to decide
  a tie that the human might have won.
*/
const NET_GRACE_SEC = 30;
```

And a backoff helper next to `netClock` (`headgame.html:6468`):

```js
/**
 * Seconds to wait before retry number `n`.
 *
 * Exponential with jitter, capped at the grace window. Jittered because two
 * players dropped by the same network event would otherwise retry in lockstep
 * forever, and a fixed interval would hammer a relay that is coming back up.
 */
function netResumeDelay(n) {
  const base = Math.min(0.5 * Math.pow(2, Math.max(0, n - 1)), 8);
  return Math.min(base + Math.random() * 0.3, NET_GRACE_SEC);
}
```

- [ ] **Step 9: Reserve the entrant instead of surrendering it**

In `netDropPeer` (`headgame.html:6138`), keep everything it does today — the CPU takeover, the notice, the bracket re-broadcast — and add the reservation. Insert after the `e.owner = "cpu";` block and before `net.joinNote = ...`:

```js
  /*
    RESERVE the entrant rather than giving it away for good.

    The CPU above still takes the seat at once, so an eight-player bracket never
    waits for somebody who may not be coming back. But the entrant is held
    against this peer's resume token for NET_GRACE_SEC, so a player whose
    connection blipped gets their tournament run back instead of losing it to a
    two-second gap. Once the deadline passes the reservation is dropped and the
    CPU keeps the seat permanently.
  */
  if (e && peer.resume) {
    net.reserved = net.reserved || {};
    net.reserved[peer.resume] = {
      entrantId: e.id,
      seat: peer.relaySeat != null ? peer.relaySeat : -1,
      deadline: netClock() + NET_GRACE_SEC,
    };
  }
```

Then add `netResume` after `netDropPeer`:

```js
/**
 * HOST: hand a reserved entrant back to a returning player.
 *
 * Returns the entrant id on success, or null when there is nothing to give —
 * an unknown token, or one whose grace window has closed. The caller is
 * responsible for sending the returning machine a bracket and a keyframe:
 * it has been away, so everything it knows is stale.
 */
function netResume(token) {
  const held = net.reserved && net.reserved[token];
  if (!held) return null;
  if (netClock() > held.deadline) {
    delete net.reserved[token];
    return null;
  }
  const e = entrantById(held.entrantId);
  if (!e) { delete net.reserved[token]; return null; }
  e.owner = "guest";
  const seat = game.seats.indexOf(e.id);
  if (seat >= 0) game.cpu[seat] = false;
  delete net.reserved[token];
  netSendBracket();
  return e.id;
}
```

- [ ] **Step 10: Make the guest retry instead of dying**

Replace `ws.onclose` (`headgame.html:5580-5583`):

```js
  ws.onclose = () => {
    if (!net.relayCode) { relayFail(url); return; }
    /*
      A LIVE match does not end here any more. The socket dropping is usually a
      blip — a phone changing network, a laptop waking, a tunnel reconnecting —
      and ending the match for it threw away a tournament run over two seconds.
      Retry with backoff until the grace window the host is holding our entrant
      for has passed, then fail exactly as before.
    */
    if (net.state === "live" && net.resumeToken) {
      net.state = "resuming";
      net.resumeTries = (net.resumeTries || 0) + 1;
      if (net.resumeAt === 0) net.resumeAt = netClock();
      if (netClock() - net.resumeAt < NET_GRACE_SEC) {
        const wait = netResumeDelay(net.resumeTries);
        setTimeout(() => {
          if (net.state !== "resuming") return;
          relayConnect(net.relayAddr, (s) => s.send(JSON.stringify({
            t: "join", code: net.relayCode,
            resume: net.resumeToken, seat: net.relaySeat,
          })));
        }, wait * 1000);
        return;
      }
      net.error = "lost the connection";
    }
    if (net.state === "live" || net.state === "resuming") {
      net.state = "closed";
      net.active = false;
    }
  };
```

- [ ] **Step 11: Initialise the resume state in `netReset`**

Add to `netReset`:

```js
  net.reserved = {};
  net.resumeToken = "";
  net.resumeTries = 0;
  net.resumeAt = 0;
  net.relaySeat = -1;
```

The token has to be issued somewhere and remembered by both sides. The host learns a peer's token when it arrives (the relay stamps `resume` on the socket in Step 3, and forwards it with `peer-joined`); the guest generates its own on first join. Add generation where the guest builds its join message in `relayJoin` (`headgame.html:5699`):

```js
  // A token of our own, so a reconnect can prove it is the same machine coming
  // back rather than a stranger asking for somebody's seat.
  if (!net.resumeToken) {
    net.resumeToken = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }
```

and include `resume: net.resumeToken` in that join payload. Record the granted seat in the `"joined"` case of `relayControl` (`headgame.html:5425+`):

```js
      if (typeof msg.seat === "number") net.relaySeat = msg.seat;
```

The host has to learn each peer's token so `netDropPeer` can reserve against it. In `tools/relay.js:533`, include it in the `peer-joined` notice:

```js
        if (s !== sock) send(s, { t: "peer-joined", seat: sock.hgSeat,
                                  resume: sock.hgResume || null });
```

Then in the host's `peer-joined` handler (`headgame.html:5457-5464`), record it on the peer it creates. Peers carry `relaySeat`, not `hgSeat` — matching the field `relayPeer(msg.seat)` sets. Add inside the `if (!net.peers.some(...))` block, after `net.peers.push(peer);`:

```js
          // The token this machine will present if it has to come back.
          if (typeof msg.resume === "string") peer.resume = msg.resume.slice(0, 64);
```

A returning player arrives as another `peer-joined`, so that handler also has to try the reclaim before treating it as a newcomer. Add at the top of the `if (netIsHost() && ...)` block:

```js
        /*
          A RETURNING player, not a new one. Reclaiming first means they get
          their own entrant back rather than being seated as a fresh joiner
          alongside the CPU that has been covering for them.
        */
        if (typeof msg.resume === "string" && netResume(msg.resume) !== null) {
          net.joinNote = "a player reconnected";
          net.joinNoteT = 3;
        }
```

- [ ] **Step 12: Run both suites to verify they pass**

Run: `node tools/run-tests.js 2>&1 | tail -3 && node tools/test-relay.js 2>&1 | tail -3`

Expected: `1818 passed, 0 failed` (15 new assertions on top of 1803), and the relay suite fully green.

- [ ] **Step 13: Commit**

```bash
cd /Users/joao.novo/Code/Games/HeadGame
git add headgame.html tools/relay.js tools/test-relay.js
git commit -m "feat: survive a dropped connection instead of ending the match

A closed socket was terminal on both sides: the guest had no retry at
all, the host handed the entrant to a CPU permanently after six seconds,
and the relay refused any join to a started room while handing returning
players a fresh seat number. A two-second blip therefore cost a whole
tournament run.

A dropped peer's entrant is now reserved for a grace window — the CPU
still takes the seat immediately so an eight-player bracket never stalls,
but the human reclaims it if they return in time. The guest retries with
jittered backoff against the same window, so the two sides cannot
disagree about when hope runs out. The relay admits a join carrying a
resume token and grants a requested seat only when it is vacant."
```

---

## Verification

After all four tasks:

- [ ] `node tools/run-tests.js` → `1818 passed, 0 failed`
- [ ] `node tools/test-relay.js` → fully green
- [ ] `PASS  simulation is deterministic` present in the output
- [ ] Manual smoke test, two browsers against `node tools/relay.js`:
  - Host a 4-entrant tournament, join as guest → the guest's bracket shows names, scores and connectors after the first tie (Task 1).
  - Play a tie, watch the ping overlay → stays flat rather than climbing (Task 2).
  - Build a wall mid-match → it appears on the guest's screen and persists (Task 3).
  - Kill the guest's network for ~5s, restore it → the guest rejoins and keeps its entrant; kill it for 40s → a CPU keeps the seat (Task 4).
