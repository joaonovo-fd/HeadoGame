# Multiplayer reliability, bandwidth and bracket sync

Date: 2026-09-23
Status: proposed

## Problem

Four independent defects, found by reading the netcode (`headgame.html` §
"online play", from line 5068) and the relay.

### 1. The guest's tournament tree is empty

`game.bracket` is the recorded history the bracket screen draws from. It is
written in four places — `headgame.html:4102`, `:4201`, `:4221`, `:4289` — and
every one of them is on a host-only path. The `"br"` message built at
`headgame.html:6892` carries `en, rp, ti, rd, sc, st, ch, lr, ec`; it does not
carry the bracket. The guest handler at `:6659` never assigns it.

`drawBracket()` reads `game.bracket[r]` for connectors (`:14225`) and for cards
(`:14246`). On a guest that array stays empty for the whole tournament, so every
tie takes the `!tie` placeholder branch at `:14258`. The guest draws a
correctly-sized, entirely empty skeleton: no names, no scores, no winner
connectors, no completed rounds.

This is a data-plumbing omission, not a rendering fault. It is the reported
"tournament UI doesn't work well client-side".

### 2. Sends have no backpressure, so latency climbs and never recovers

`netSend` (`headgame.html:6093`) calls `send()` unconditionally. Neither
`headgame.html` nor `tools/relay.js` references `bufferedAmount` anywhere.

When the link sustains less than 60 snapshots a second, the excess accumulates
in the socket's send buffer. Queue depth grows monotonically; every snapshot
waits behind everything already queued. Because nothing sheds load, the delay
never comes back down — it degrades until the match is unplayable. This is the
"gets worse the longer you play" failure.

### 3. Snapshots are full state at 60Hz

`netSnapshot` (`headgame.html:6181`) serialises ball, both players, power-ups,
mines, helpers, bullets, walls and all world geometry every single frame. The
arrays dominate: each wall is ten numbers (`:6237`). Walls, mines and map
geometry change rarely, but cost their full size 60 times a second.

### 4. A blip ends the match permanently

`ws.onclose` (`:5580`) and `chan.onclose` (`:5911`) are terminal: they set
`net.state = "closed"`. There is no retry anywhere in the file. A two-second
drop ends a tournament tie for good.

Host-side, `netDropPeer` (`:6138`) hands the entrant to a CPU **permanently**
after `NET_TIMEOUT` (6s) and re-broadcasts the bracket.

The relay blocks return as well, in two separate ways:
- `relay.js:520` refuses any join to a room with `started === true`.
- `relay.js:521` assigns `room.nextSeat++`, a fresh seat, so a returning player
  is indistinguishable from a new one.

Reconnect therefore requires changes to both the game and the relay.

## Decisions taken

- **Drop behaviour**: a CPU takes the seat immediately so play never stalls. The
  human may reclaim their entrant within a grace window; after it expires the CPU
  keeps it for good. Chosen over pausing the tie (one bad link would halt an
  8-player bracket) and over forfeiting (a 2-second blip should not cost a match).
- **No new dependencies.** The project is one dependency-free HTML file plus a
  zero-dependency relay. That constraint holds.
- **Host authority is not revisited.** It is why this netcode cannot desync. All
  four fixes preserve it.

## Design

### 1. Bracket sync

Add `bk` to the `"br"` message: `game.bracket` mapped to plain arrays, one entry
per round, each tie `[a, b, winner, score]`. Assign it in the `"br"` handler,
validating the same way the existing `en` mapping does — ids bounded, `winner`
either a known entrant id or null, `score` a two-number array or absent.

`drawBracket()` needs no change. It already draws history correctly given the
data; it has simply never received any.

Adds roughly one number per tie per round to a message sent only on bracket
transitions, never per frame. Bandwidth cost is negligible.

### 2. Backpressure and adaptive snapshot rate

Give `netSend` a high-water mark. Before sending a snapshot, compare
`bufferedAmount` against a threshold (start at ~64KB, measured, not guessed).
Over the mark, **drop the snapshot rather than queueing it** — a stale snapshot
has no value once a newer one exists, and the interpolation buffer already
tolerates gaps by design (`netInterpolate`, `:6573`, holds its last frame rather
than extrapolating).

Reliable messages must never be dropped: `hi`, `cfg`, `br`, `me`, `bye` and
edge-carrying intent bytes bypass the check. Only snapshots — idempotent,
superseded by the next one — are shed.

Track the drop rate and step the effective send rate down (60 → 40 → 30 Hz) while
the buffer stays hot, recovering upward when it drains. `NET_LERP_DELAY` is
measured in send intervals, so the render clock adapts on its own with no change
to the interpolation logic.

`bufferedAmount` exists on both `RTCDataChannel` and `WebSocket`, so this works
for both transports. `relayChannelShim` (`:5258`) must forward it — currently it
exposes only `readyState` and `send`.

### 3. Delta snapshots

Split the snapshot into a hot part, sent every frame (ball, players, clock,
score, scene, goal phase), and a cold part sent only on change (walls, mines,
helpers, power-ups, map id, gravity, goal tuning).

Each cold group carries a small version counter. The host increments it when the
group changes and includes the group only then. The guest keeps the last value
per group and reuses it when absent. A **full keyframe every ~1s and on every
scene change** bounds recovery: a guest joining late, or one that missed a cold
update, is correct within a second rather than for the rest of the match.

This preserves the property the existing comment at `:6216` insists on — a guest
that drops a packet is corrected promptly rather than playing a whole match in
the wrong arena — while paying the arrays' cost only when they actually change.

Keyframes must be exempt from the backpressure drop in #2, or a saturated link
could shed every keyframe and leave a guest permanently stale.

### 4. Reconnect with entrant reclaim

**Relay** (two changes, both narrow):
- Accept a join to a started room when it carries a resume token.
- Let a joiner request its previous seat number instead of `nextSeat++`, granted
  only if that seat is currently vacant.

**Host**: on peer loss, mark the entrant *reserved* rather than permanently CPU.
`netDropPeer` keeps its existing behaviour — CPU takes the seat, bracket
re-broadcast, notice shown — but records the entrant id against a resume token
and a grace deadline. On a resume join with a matching token inside the window,
hand the entrant back, clear the CPU flag, and send a full keyframe plus a
bracket. After the deadline, the reservation is dropped and the CPU keeps it.

**Guest**: `onclose` becomes non-terminal while a match is live. Retry with
exponential backoff and jitter (~0.5s, 1s, 2s, 4s, capped) until the grace
window is exhausted, showing reconnect state on screen. On success, adopt the
keyframe and resume. On exhaustion, fail exactly as today.

The grace window is one constant, shared by host reservation and guest retry
budget, so the two cannot disagree about when hope runs out.

## Risks

- **Delta snapshots are the highest-risk change**: a missed cold update shows as
  a wrong arena rather than a visible error. Keyframes are the mitigation and
  must be tested explicitly, including "guest joins mid-match" and "cold update
  dropped".
- **Reconnect touches connection lifecycle**, where a half-open socket can look
  alive. The existing `NET_TIMEOUT` machinery stays in place as the backstop.
- **Relay and game must stay compatible.** Both changes are additive: an old
  guest omits the resume token and gets today's behaviour; an old relay refuses
  the resume join and the guest exhausts its budget, which is also today's
  behaviour.

## Testing

The suite is 1772 assertions, in-file, run by `node tools/run-tests.js`, with
relay coverage in `tools/test-relay.js`. Baseline confirmed green before any
change. Each piece gets tests alongside it:

1. **Bracket**: host emits `bk`; guest reconstructs names, scores and winners;
   a malformed `bk` is rejected without throwing.
2. **Backpressure**: a stub channel reporting a high `bufferedAmount` causes
   snapshots to be dropped and reliable messages to still go out; keyframes are
   never dropped; the rate steps down while hot and recovers when drained.
3. **Delta**: unchanged cold groups are omitted; a guest reusing cached groups
   matches a guest given full snapshots; a keyframe repairs a guest that missed
   a cold update.
4. **Reconnect**: relay accepts a resume join to a started room and honours a
   vacant seat request; host reserves then returns an entrant inside the window
   and refuses outside it; guest backs off and gives up at the deadline.
5. **Determinism** (`simulation is deterministic`) must still pass — it is the
   guard that these changes have not perturbed the physics kernel.

Order of work: bracket first (smallest, independently verifiable), then
backpressure, then delta, then reconnect. Each is separately committable and
leaves the game working.

Per `agents.md`, commits carry no Claude co-author attribution.
