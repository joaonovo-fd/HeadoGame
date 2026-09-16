# 3D Arena Mode — Design

Date: 2026-09-16
Status: approved for implementation

## Summary

Add `ARENA3D`, a third-person 3D deathmatch mode, to Head Game. The player
moves with WASD, aims with the mouse, and shoots an opponent — either a CPU bot
or a second human in split-screen. First to N frags wins.

The mode renders with a hand-rolled software 3D projector on the existing 2D
canvas. It introduces no dependencies and no second canvas.

## Why a separate scene

The existing simulation is 2D throughout. `stepBall`, `ballVsPlayer`,
`GROUND_Y`, `confineToHalf` and `MODE_CFG` all assume an x/y plane and a ball.
A deathmatch has no ball, and threading a `z` axis through that kernel would put
1134 passing tests at risk for no gain.

`SCENE.ARENA3D` is therefore a sibling of `SCENE.PLAY`, not a variant of it. It
owns its own step function, its own render function and its own state. It calls
nothing in the 2D physics kernel, and the 2D kernel never learns it exists.

## Architecture

Three units, each with one responsibility:

| Unit | Responsibility | Depends on |
|---|---|---|
| `v3` / `project` | vector math, camera transform, perspective divide | nothing (pure) |
| `arena3d` sim | movement, gravity, box collision, shooting, frags | `v3`, `game.arena` |
| `arena3d` render | painter-sorted quad rasteriser | `project`, `ctx` |

The math unit is pure — no globals, no canvas — so it is unit-testable exactly
like the existing physics kernel. That is what makes correctness checkable
rather than assumed.

### State

All 3D state hangs off one object, null unless the mode is live:

```js
game.arena = {
  fighters: [ {x,y,z, vx,vy,vz, yaw,pitch, hp, ammo, reload,
               dashCD, respawn, onGround, seat, team, look}, ... ],
  cam:      [ {yaw, pitch, dist}, {yaw, pitch, dist} ],   // per seat
  shots:    [ {x,y,z, vx,vy,vz, life, owner} ],
  frags:    [0, 0],
  cover:    [ {x,y,z, w,h,d, col} ],                      // static boxes
  hitFx:    [ {x,y,z, life} ],
  split:    false,                                        // two viewports
};
```

`game.arena = null` when the mode is not running, so no other scene can read
stale 3D state.

### Coordinate system

Right-handed, y up. The arena floor is y = 0, spanning
`x ∈ [-ARENA_HW, ARENA_HW]`, `z ∈ [-ARENA_HD, ARENA_HD]`, enclosed by four
walls. Gravity is -y.

### Projection

```js
function project(p, cam, view) {
  const d = worldToCam(p, cam);          // translate + yaw + pitch
  if (d.z < NEAR) return null;           // at or behind the camera: no point
  const s = view.focal / d.z;
  return { x: view.cx + d.x * s, y: view.cy - d.y * s, s, z: d.z };
}
```

`project` returning `null` for anything at or behind the near plane is the
contract that keeps geometry from smearing across the screen when the camera
clips a wall. Quads with any vertex behind the near plane are dropped rather
than clipped — cheap, and invisible in practice because cover boxes are small
relative to the near distance.

Faces are collected per frame, sorted by mean camera-space depth descending, and
filled far-to-near (painter's algorithm). There is no depth buffer; the arena is
deliberately built from few, well-separated convex boxes so painter order is
correct. Back faces are culled by winding order, which halves the fill cost and
removes the most common sorting artefact.

`view` carries `cx, cy, focal` and the viewport rect, so the same draw code
serves full-screen and split-screen by being called twice with a different
`view` and camera. The camera is a parameter, never a global.

### Camera

Third-person orbit, behind and above the fighter:

```
cam.pos = fighter.eye − forward(yaw, pitch) * dist + up * CAM_LIFT
```

- `pitch` clamped to ±55° so the camera cannot flip over the top.
- `dist` shrinks when a cover box or wall lies between camera and fighter, so
  the player is never occluded by the geometry they are standing behind.
- Aim is the ray from the camera through the crosshair at viewport centre,
  which is what makes the crosshair honest: what it covers is what gets hit.

## Controls

| Action | P1 | P2 (pad) | P2 (keys) | Source |
|---|---|---|---|---|
| Move | WASD | left stick | Arrows | existing `left/right/up/down` |
| Aim | mouse | right stick | IJKL | new `aim*` actions |
| Fire | click or `kick` key (F) | face/R button | `kick` key (Enter) | existing `kick` |
| Jump | Space | A | R-Shift | existing `wall` key, reused |
| Dash | L-Shift | L trigger | R-Ctrl | new `dash` action |

Movement, fire and jump reuse bindings that already exist, so no key acquires a
second conflicting meaning: `kick` is already "KICK / FIRE" and keeps firing
here, and the `wall` key — meaningless without walls in this mode — becomes
jump. `up`/`down` steer forward and back rather than jumping, because a
third-person mode needs four-way ground movement and jump therefore needs its
own key. Only aim and dash are genuinely new, which keeps `ACTIONS` at 13 rows
and the CONTROLS screen honest about what each key does.

WASD is camera-relative: W is "away from the camera", the third-person
convention, not world-north.

Mouse aim uses Pointer Lock. `movementX/Y` accumulates in the listener and is
consumed once per frame, so sensitivity does not vary with frame rate.

### Pointer lock discipline

A stuck pointer lock is the worst bug this feature could ship — it would look
like the whole game froze. Therefore:

- The listener acts only while `scene === ARENA3D` and ignores every other scene.
- `document.exitPointerLock()` runs on pause, on match end, on quit-to-menu, and
  on any scene change away from `ARENA3D`.
- Release is asserted by test on every exit path, not just the happy one.

Lock is requested on a click inside the canvas, never automatically, because
browsers reject an unprompted request and a rejected request must not leave the
mode unplayable. The mode is fully playable with keys if lock is refused.

### New rebindable actions

Five actions join `ACTIONS`, so they appear on the existing CONTROLS screen:
`aimUp`, `aimDown`, `aimLeft`, `aimRight` and `dash`. Aim defaults are blank for
P1 (who has the mouse) and IJKL for P2; dash defaults to L-Shift / R-Ctrl.

A blank binding is already handled by the CONTROLS screen — it paints an empty
red keycap — so a blank P1 aim binding needs no new code, and a player who
prefers keys to the mouse can bind them.

`ACTIONS` growing from 6 to 11 rows means the CONTROLS list runs to 13 rows
including RESET and BACK. At the current `top = 128`, `gap = 38`, BACK's bottom
edge lands at y = 692 and the gamepad status line at y = 706 — well off a 600px
canvas. Verified compact geometry for 13 rows: `top = 116`, `gap = 28` puts the
last action row at 452, BACK's bottom edge at 540 and the status line at 544,
all on canvas.

This is a real change to an existing screen, required by the new actions. The
existing on-screen-layout test is extended to assert every row lands within the
canvas, so the geometry is checked rather than eyeballed.

## Match rules

- 100 HP; a hit does 25; four hits kill.
- Frags to win reuses the existing `goals` menu row (relabelled "FRAGS TO WIN"
  in this mode). The time limit reuses the existing `time` row and clock.
- Death respawns after 2s at whichever spawn point is furthest from the
  opponent, so a spawn camp is not rewarded.
- Time expiry: most frags wins, reusing `timeExpired` semantics. A draw in a
  single match reports a draw, exactly as the 2D modes do.
- `recordResult` records the outcome, so the existing leaderboard works
  unchanged.

## Integration points

The 2D scene machine is clean — `SCENE.PLAY` has only 7 non-test references —
so integration is additive:

1. `SCENE.ARENA3D` added to the `SCENE` enum.
2. `MODE.ARENA3D` added to `MODE` and appended to `MODE_ORDER`.
3. `step()` gains a `case SCENE.ARENA3D`, calling `stepArena3D(dt)`.
4. `draw()` gains an early-return branch calling `drawArena3D()`.
5. `PAUSABLE` gains `SCENE.ARENA3D`, so ESC pauses as everywhere else.
6. `musicTrackForScene()` returns `"play"` for it.
7. `startMatch()` branches once: 3D mode calls `startArena3D()` instead of
   `kickoff()`.
8. `menuRows()` hides `map`, `chaos` and `online` in this mode.

### Contracts the new mode MUST satisfy

Adding a mode to `MODE_ORDER` is not free. Existing test loops iterate it and
assert, for **every** mode:

- `MODE_CFG[mode]` exists and is well formed (`13221`, `11291`, `17085`).
- `ARENA[mode]` declares a complete theme: two-stop `sky`, `ground`, `line`,
  `surface`, and `crowd` either null or a two-colour pair (`13632`).
- `menuRows()` under that mode paints every visible row on screen (`13430`).
- Menu panel groups stay contiguous, so the cursor never leaves and re-enters a
  panel (`13535`).
- `MODE_LABEL` and `MODE_HINT` have entries (menu draws them).

So `ARENA3D` gets a `MODE_CFG` entry and an `ARENA` theme even though it uses
neither the 2D ball config nor the 2D pitch renderer. This is cheap and not
merely ceremonial: the theme's `sky` and `ground` colours are what the 3D
renderer paints its horizon and floor with, and `MODE_CFG` keeps the mode from
crashing any code path that reads `modeCfg()` defensively.

Discovering this after writing the feature would have looked like the 3D
renderer broke the existing game. It is called out here so it does not.

## Explicitly out of scope

- **Netcode.** Online play streams 2D snapshots; a 3D wire format is a separate
  project. `menuRows()` hides `online` in this mode rather than offering a link
  that would desync.
- **Textures and lighting.** Flat per-face shading with a fixed light direction.
- **Power-ups, roguelike, tournament.** The mode is a standalone match. It is
  not added to the tournament bracket or the run ladder.
- **Depth buffer.** Painter's algorithm with few convex boxes, as above.

## Testing

The headless harness at `tools/run-tests.js` runs the whole `?test=1` suite
under Node by stubbing canvas, storage, audio, RTC and gamepads. Baseline before
any change: **1134 passed, 0 failed**. Every step of the implementation must
leave that suite green — a regression in the 2D game is the real risk here, not
a flaw in the new mode.

Roughly 40 new assertions, added to `runTests()` alongside the existing ones:

**Projection (pure, exact):**
- a point straight ahead lands at viewport centre
- a point at or behind the near plane returns null
- a point twice as far appears half as large
- yaw and pitch rotate the projected point in the expected direction
- projection is stable under a full 360° yaw sweep (no NaN, no sign flip)

**Painter ordering:**
- faces sort strictly far-to-near by mean camera depth
- a back face is culled by winding

**Simulation:**
- gravity brings a fighter to rest exactly on the floor, not through it
- a fighter cannot leave the arena bounds in any of the four directions
- a fighter cannot enter a cover box from any face
- WASD is camera-relative: the same key with a rotated camera moves elsewhere
- pitch stays clamped to ±55° under sustained input

**Combat:**
- a shot along the aim ray hits a fighter in its path
- a shot misses when the target is offset beyond its radius
- friendly fire never registers
- four hits kill; three do not
- a kill increments the shooter's frags, never the victim's
- respawn takes the spawn furthest from the opponent
- reaching the frag target ends the match through `finishMatch`
- time expiry awards the match to the frag leader
- `recordResult` is called exactly once per match

**Integration and safety:**
- `ARENA3D` satisfies the `MODE_CFG`, `ARENA`, `MODE_LABEL`, `MODE_HINT`
  contracts the `MODE_ORDER` loops assert
- `menuRows()` hides map, chaos and online in this mode, and panels stay
  contiguous
- the CONTROLS screen paints all 13 rows and the status line within the canvas
- pointer lock is released on pause, quit, match end and scene change
- `game.arena` is null in every non-3D scene
- entering and leaving the mode twice leaves no state behind
- the 3D step is deterministic given identical input

## Risks

| Risk | Mitigation |
|---|---|
| Painter's algorithm mis-sorts | few, convex, well-separated boxes; back-face culling; sort asserted by test |
| Stuck pointer lock looks like a freeze | release on every exit path, each asserted |
| Software 3D too slow at 1000×600 | face budget in the low hundreds; measure during implementation and cut geometry if a frame exceeds budget |
| CONTROLS screen overflows | compact layout, asserted by the existing on-screen layout test |
| Regression in the 2D game | full suite green after every step |

## Scope

Roughly 1200–1600 new lines: projector, rasteriser, deathmatch sim, bot AI,
split-screen, mouse-look, HUD, and about 40 tests. This is the largest single
feature in the file, which is why it is being built in verified steps rather
than in one pass.
