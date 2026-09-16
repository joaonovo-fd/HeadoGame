# 3D Arena Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ARENA3D`, a third-person 3D deathmatch mode with WASD + mouse controls, vs-CPU and split-screen, rendered by a hand-rolled software 3D projector on the existing 2D canvas.

**Architecture:** `SCENE.ARENA3D` is a sibling of `SCENE.PLAY`. Three units: a pure `v3`/`project` math layer, an `arena3d` simulation reading `game.arena`, and a painter-sorted quad renderer. Nothing threads into the 2D physics kernel.

**Tech Stack:** Vanilla JS, single file `headgame.html`, canvas 2D context. No dependencies.

**Spec:** `docs/superpowers/specs/2026-09-16-3d-arena-mode-design.md`

## Global Constraints

- Single file: all code goes in `headgame.html` inside the existing `<script>`.
- Zero new dependencies, zero external resources, no second canvas.
- Every task ends with `node tools/run-tests.js` green. Baseline: **1134 passed, 0 failed**.
- New tests join `runTests()` before the `// 23. Determinism` block (currently ~line 17811).
- New exports join the `PHYS` object (~line 9559) so tests can reach them.
- Arena constants: `ARENA_HW = 520`, `ARENA_HD = 520`, floor `y = 0`, `NEAR = 12`.
- Combat: `HP_MAX = 100`, `SHOT_DMG = 25`, `RESPAWN_T = 2`.
- Camera: `pitch` clamped to ±55° (`PITCH_MAX = 0.96` rad), `CAM_DIST = 165`, `CAM_LIFT = 62`.
- Comment style matches the file: explain *why*, not *what*.

---

### Task 1: Pure 3D math + projection

**Files:** Modify `headgame.html` — new section after the 2D math helpers (~line 1665); export via `PHYS`.

**Interfaces:**
- Produces: `v3(x,y,z)`, `v3add/v3sub/v3scale/v3dot/v3cross/v3len/v3norm`, `camBasis(cam)`, `worldToCam(p, cam, basis)`, `project(p, cam, view, basis)`, `makeView(x,y,w,h,fov)`.
- `project` returns `{x, y, s, z}` in screen space, or `null` when `z < NEAR`.

- [ ] **Step 1:** Write failing tests: point straight ahead lands at viewport centre; point behind camera returns null; double distance halves scale; yaw rotates as expected; 360° sweep produces no NaN.
- [ ] **Step 2:** `node tools/run-tests.js` — expect FAIL, `project is not defined`.
- [ ] **Step 3:** Implement `v3` helpers, `camBasis`, `worldToCam`, `project`, `makeView`. All pure, no globals.
- [ ] **Step 4:** `node tools/run-tests.js` — expect 1134 + new, 0 failed.
- [ ] **Step 5:** Commit `feat: add pure 3D projection math`.

---

### Task 2: Quad renderer with painter sort and back-face culling

**Files:** Modify `headgame.html` — render section after `drawParticles` (~line 7000).

**Interfaces:**
- Consumes: Task 1's `project`, `camBasis`.
- Produces: `faceBatch()` returning `{push(quad, col), flush(cam, view)}`; `quadDepth(q, cam, basis)`; `isBackFace(pts)`; `shadeFace(col, normal)`.

- [ ] **Step 1:** Write failing tests: batch sorts faces strictly far-to-near by mean camera depth; a clockwise-wound face is culled; `shadeFace` returns a darker colour for a normal facing away from the light.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement the batch: collect quads, project all corners, drop any quad with a null corner, cull by winding, sort by mean depth descending, fill with `shadeFace`.
- [ ] **Step 4:** Run — expect green.
- [ ] **Step 5:** Commit `feat: add painter-sorted quad renderer`.

---

### Task 3: Mode + scene registration honouring MODE_ORDER contracts

**Files:** Modify `headgame.html` — `SCENE` (2532), `MODE` (2561), `MODE_ORDER` (2569), `MODE_CFG` (2584), `ARENA` (2631), `MODE_LABEL` (2663), `MODE_HINT` (2670), `menuRows` (2881), `PAUSABLE` (5778), `musicTrackForScene` (1644).

**Interfaces:** Produces `SCENE.ARENA3D = "arena3d"`, `MODE.ARENA3D = "arena3d"`.

Contracts asserted by existing loops — all must be satisfied in this one task or those tests fail:
- `MODE_CFG[MODE.ARENA3D]` well formed (`ballR`, `ballMass`, `grav`, `drag`, `rest`, `knockback`, `net: 0`, `confine: false`, `goals: false`).
- `ARENA[MODE.ARENA3D]` complete: two-stop `sky`, `ground`, `stripe`, `line`, `surface`, `crowd` null or two colours.
- `MODE_LABEL` = `"3D ARENA"`, `MODE_HINT` = `"third-person deathmatch — WASD + mouse"`.
- `menuRows()` hides `map`, `chaos`, `online`; panel groups stay contiguous.

- [ ] **Step 1:** Write failing tests asserting each contract above for the new mode.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Add the enum entries, config, theme, labels, `menuRows` filters, `PAUSABLE` entry, music mapping.
- [ ] **Step 4:** Run — expect green, including the pre-existing `MODE_ORDER` loops.
- [ ] **Step 5:** Commit `feat: register 3D arena mode`.

---

### Task 4: Arena state, spawns, and match lifecycle

**Files:** Modify `headgame.html` — new sim section before `step()` (~line 6110); `startMatch` (3252).

**Interfaces:**
- Produces: `startArena3D()`, `makeFighter(seat, team)`, `arenaSpawns()`, `respawnFighter(f)`, `arenaCover()`, `isArena3D()`.
- `game.arena` shape exactly as the spec's State section.

- [ ] **Step 1:** Write failing tests: `startArena3D` fills two fighters at 100 HP and zero frags; `game.arena` is null in every non-3D scene; respawn picks the spawn furthest from the opponent; entering and leaving twice leaves no residue.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement state construction, four spawn points, cover box layout, and the `startMatch` branch that calls `startArena3D()` instead of `kickoff()`.
- [ ] **Step 4:** Run — expect green.
- [ ] **Step 5:** Commit `feat: add 3D arena state and spawns`.

---

### Task 5: Movement, gravity, and collision

**Files:** Modify `headgame.html` — sim section.

**Interfaces:**
- Produces: `stepFighter(f, a, cam, dt)`, `arenaBounds(f)`, `fighterVsCover(f)`, `moveBasis(cam)`.

- [ ] **Step 1:** Write failing tests: gravity settles a fighter exactly on the floor, never through it; a fighter cannot leave bounds in any of four directions; a fighter cannot enter a cover box from any face; WASD is camera-relative (same key, rotated camera, different world direction); pitch stays clamped under sustained input.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement camera-relative acceleration, gravity, jump, dash with cooldown, axis-separated box rejection, wall clamping.
- [ ] **Step 4:** Run — expect green.
- [ ] **Step 5:** Commit `feat: add 3D fighter movement and collision`.

---

### Task 6: Shooting, damage, frags, and match end

**Files:** Modify `headgame.html` — sim section; reuse `finishMatch` (3355), `recordResult`.

**Interfaces:**
- Produces: `fireShot(f)`, `stepShots(dt)`, `shotVsFighter(s, f)`, `applyDamage(f, dmg, bySeat)`, `arenaFrag(shooter, victim)`, `aimRay(f)`.

- [ ] **Step 1:** Write failing tests: a shot along the aim ray hits a fighter in its path; misses beyond radius; friendly fire never registers; four hits kill and three do not; a kill credits the shooter only; reaching the frag target calls `finishMatch`; time expiry awards the leader; `recordResult` runs exactly once.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement projectile stepping, sphere hit test, damage, death, respawn timer, frag counting, and the win/time-expiry paths through the existing `finishMatch`.
- [ ] **Step 4:** Run — expect green.
- [ ] **Step 5:** Commit `feat: add 3D arena combat and scoring`.

---

### Task 7: Input — pointer lock, aim actions, gamepad sticks

**Files:** Modify `headgame.html` — `ACTIONS` (2023), `SCHEME_DEFAULTS` (2015), `intent` (2168), `gatherIntent` (2199), `pollPads` (2119), `drawControls` (~8600), `openPause` (5785), `quitToMenu` (5816).

**Interfaces:**
- Produces: `mouse` accumulator, `requestArenaLock()`, `releaseArenaLock()`, `aimDelta(seat)`; `intent` gains `aimX`, `aimY`, `jump`, `dashEdge`.

- [ ] **Step 1:** Write failing tests: pointer lock releases on pause, quit, match end and scene change; 13 CONTROLS rows and the status line all land within the 600px canvas; `aim*` and `dash` appear in `ACTIONS`; a blank binding renders as `—`.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Add the five actions, compact CONTROLS geometry (`top = 116`, `gap = 28`), pointer-lock listeners scoped to the 3D scene, frame-consumed mouse accumulator, gamepad right-stick aim, and release calls on all four exit paths.
- [ ] **Step 4:** Run — expect green.
- [ ] **Step 5:** Commit `feat: add mouse-look and aim bindings`.

---

### Task 8: Renderer — arena, fighters, HUD, split-screen

**Files:** Modify `headgame.html` — render section; `draw()` (9500).

**Interfaces:**
- Produces: `drawArena3D()`, `drawArenaWorld(cam, view)`, `drawFighterBillboard(f, cam, view)`, `drawArenaHUD(seat, view)`, `arenaViews()`.

- [ ] **Step 1:** Write failing tests: `arenaViews()` returns one full view when not split and two stacked halves when split; `drawArena3D` paints without throwing in both modes; the HUD reports HP and frags for the right seat.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement sky/floor/walls/cover geometry, fighter billboards reusing `drawFace`/`drawHat`, crosshair, HP bar, frag counters, and the `draw()` branch. Split-screen calls `drawArenaWorld` twice with clipped views.
- [ ] **Step 4:** Run — expect green.
- [ ] **Step 5:** Commit `feat: add 3D arena renderer and HUD`.

---

### Task 9: CPU bot

**Files:** Modify `headgame.html` — sim section; reuse `CPU_LEVELS` (3877).

**Interfaces:** Produces `updateArenaCPU(f, dt)`.

- [ ] **Step 1:** Write failing tests: the bot closes distance when far and strafes when near; it only fires within an aim tolerance; harder levels react faster than easier ones; the bot never fires while dead.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement bot aim smoothing, approach/strafe logic, and firing gated by `CPU_LEVELS` reaction and error.
- [ ] **Step 4:** Run — expect green.
- [ ] **Step 5:** Commit `feat: add 3D arena bot`.

---

### Task 10: Wire the scene, determinism, and final verification

**Files:** Modify `headgame.html` — `step()` (6114).

- [ ] **Step 1:** Write failing tests: the 3D step is deterministic given identical input; a full simulated match runs to a winner without throwing.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Add `case SCENE.ARENA3D` calling `stepArena3D(dt)`, which drives CPU intent, fighters, shots, respawns, the clock and win checks.
- [ ] **Step 4:** Run full suite — expect all green. Verify the 2D modes still play by loading the file in a browser.
- [ ] **Step 5:** Commit `feat: wire 3D arena scene into the loop`.

---

## Self-Review

**Spec coverage:** projection → T1; painter sort → T2; mode contracts → T3; state/spawns/lifecycle → T4; movement/collision → T5; combat/frags → T6; controls/pointer-lock → T7; renderer/split-screen/HUD → T8; bot → T9; scene wiring/determinism → T10. Out-of-scope items (netcode, textures, power-ups, depth buffer) have no tasks, as intended.

**Type consistency:** `project` returns `{x,y,s,z}|null` in T1 and is consumed as such in T2 and T8. `game.arena` fields are written in T4 and read under the same names in T5–T10. `intent` gains `aimX/aimY/jump/dashEdge` in T7, consumed in T5/T6.
