// Display of unit motion: step drawing (jump rule, walk frames by distance, the stand at every
// cell), action animations and their sound event, facing fallback. Spec:
// docs/rendering/unit-motion.md 1.5, 2.2-2.6, 3; docs/architecture/simulation.md "Display
// contract for movement". Pure display code, no game data needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  StepDisplay, UnitDisplay, jumpSize, stepDuration, quantClock, actionFrame, offsetPixels,
  JUMP_MIN, MOVE_GATE_MS, WIN_CLOCK_MS, type MotionInput, type MotionRow, type MotionOptions,
} from '../src/client/display.ts';

test('jump size: max + min/2 in 1/64 cell (2.3.4)', {}, () => {
  assert.equal(jumpSize(4, 0), 4);
  assert.equal(jumpSize(-3, 3), 4);    // diagonal: 3 + 1
  assert.equal(jumpSize(2, 3), 4);
  assert.equal(jumpSize(3, 0), 3);
  assert.equal(jumpSize(0, -2), 2);
});

test('step duration reproduces the per-cell stand: D x 100 x 95 / 109.375 ms (2.5, 2.6)', {}, () => {
  assert.ok(Math.abs(stepDuration(6, 100) - 521.14) < 0.01);
  // drawn over 86.9 % of the D ticks, the unit stands for the rest
  const stand = 6 * 100 - stepDuration(6, 100);
  assert.ok(stand > 75 && stand < 80);
  assert.equal(quantClock(100), 93.75);
  assert.equal(quantClock(109.375), 109.375);
});

test('step drawing: no move until the target is more than 3/64 cell away, one frame per jump (2.3)', {}, () => {
  const s = new StepDisplay();
  s.begin(64, 0, 0, 640);           // 1/64 cell per 10 ms
  assert.equal(s.dx, 64);           // starts at the old cell
  assert.equal(s.update(20), false); // target 62: change 2, nothing moves
  assert.equal(s.dx, 64);
  assert.equal(s.update(30), false); // target 61: change 3, still nothing
  assert.equal(s.update(40), true);  // target 60: change 4, jump
  assert.equal(s.dx, 60);
  assert.equal(s.frame, 1);
  // the 10 ms gate: an update 10 ms after the last one does nothing
  assert.equal(s.update(40 + MOVE_GATE_MS), false);
  assert.equal(s.dx, 60);
  // frames follow the distance: a long gap gives one big jump and only one frame
  assert.equal(s.update(400), true);
  assert.equal(s.dx, 24);
  assert.equal(s.frame, 2);
  // the end: offset 0; the walk frame counter stays where it is
  s.update(1000);
  assert.equal(s.moving, false);
  assert.equal(s.frame, 3);
  assert.equal(s.update(2000), false);
  assert.equal(s.frame, 3);
});

test('step drawing: the final snap advances the frame only for a jump of more than 3 (2.3.5)', {}, () => {
  const s = new StepDisplay();
  s.begin(64, 0, 0, 640);
  // run the step with updates every 40 ms: each change is 4/64, one frame per update
  let t = 0;
  while (s.moving) { t += 40; s.update(t); }
  assert.equal(s.frame, 16);   // 16 jumps of 4/64 per straight cell
  assert.equal(t, 640);
  // a snap from 2/64 to 0 at the end does not count as a frame
  const r = new StepDisplay();
  r.begin(64, 0, 0, 640);
  r.update(620);               // target 2: jump of 62
  assert.equal(r.dx, 2);
  assert.equal(r.frame, 1);
  r.update(640);
  assert.equal(r.dx, 0);
  assert.equal(r.frame, 1);
});

test('step drawing: a diagonal jumps at 3/64 per axis; a 15.625 ms clock gives ~14 frames on a porter step (2.4)', {}, () => {
  const d = new StepDisplay();
  d.begin(64, 64, 0, 900);
  for (let t = 0; d.moving; t += 1) d.update(t);
  assert.ok(d.frame >= 19 && d.frame <= 21, `diagonal frames ${d.frame}`);
  // porter, D = 6, T = 570 ms (the original's 95 ms ticks), wall clock in 15.625 ms steps, 60 fps
  const p = new StepDisplay();
  p.begin(64, 0, 0, 570);
  for (let t = 0; p.moving; t += 1000 / 60) p.update(quantClock(t));
  assert.ok(p.frame >= 12 && p.frame <= 15, `porter frames ${p.frame}`);
  assert.equal(WIN_CLOCK_MS, 15.625);
  assert.equal(JUMP_MIN, 3);
});

test('action frames: floor((n - 1) x elapsed / T), T = n x 10 / fps ticks, repeat count (3)', {}, () => {
  // police ST: 10 frames at 7 fps -> T = 14.29 ticks, frame 5 at 7.94 ticks
  assert.equal(actionFrame(7.9, 10, 7, 1).frame, 4);
  assert.equal(actionFrame(8.0, 10, 7, 1).frame, 5);
  assert.equal(actionFrame(14.2, 10, 7, 1).done, false);
  assert.equal(actionFrame(14.3, 10, 7, 1).done, true);
  // repeat: 11 cycles for the animal idle
  const T = 12 * 10 / 7;
  assert.deepEqual(actionFrame(T * 3 + 0.01, 12, 7, 11), { frame: 0, cycle: 3, done: false });
  assert.equal(actionFrame(T * 11, 12, 7, 11).done, true);
  // looping work never ends
  assert.equal(actionFrame(1e6, 12, 7, Infinity).done, false);
});

test('offset pixels: projected remaining offset, whole pixels in vanilla mode (2.3)', {}, () => {
  assert.deepEqual(offsetPixels(64, 0, true), [-32, 22]);
  assert.deepEqual(offsetPixels(5, 0, true), [-2, 1]);
  assert.deepEqual(offsetPixels(5, 0, false), [-2.5, 1.71875]);
});

// ---------------------------------------------------------------- UnitDisplay

const unit = (o: Partial<MotionInput> = {}): MotionInput => ({
  x: 10 * 256 + 128, y: 10 * 256 + 128, stepFromX: 10 * 256 + 128, stepFromY: 10 * 256 + 128, stepStart: -1000, stepTicks: 0,
  dir: 3, action: 3, actionTick: 0, idleTick: -1, idleLoops: 0, carryAmount: 0, ...o,
});
/** rows: walk 12 frames in every direction, strike 10, work 8, idle only ID3 (12 frames) */
const rows = (a: number, dir: number): MotionRow | null =>
  a === 0 ? { frames: 12, fps: 7 } : a === 1 ? { frames: 10, fps: 7 } : a === 2 ? { frames: 8, fps: 7 }
  : a === 3 && dir === 3 ? { frames: 12, fps: 7 } : null;
const opts = (t: number, wall: number, o: Partial<MotionOptions> = {}): MotionOptions =>
  ({ t, wall, tickMs: 100, smooth: false, soundFrame: 5, soundAction: 1, ...o });

test('UnitDisplay: a step starts at the old cell, runs down in jumps, and the walk frame is kept after it (2.2-2.4)', {}, () => {
  const d = new UnitDisplay();
  const u = unit({ action: 0, actionTick: 100 });
  d.update(u, rows, opts(100, 10000));
  // a step east (+x) starts at tick 101, D = 6
  const s = { ...u, x: u.x + 256, stepFromX: u.x, stepStart: 101, stepTicks: 6 };
  d.update(s, rows, opts(101, 10100));
  assert.equal(d.ox, 64);
  assert.ok(d.busy);
  let wall = 10100, frames = new Set<number>();
  for (; wall < 10100 + 600; wall += 1000 / 60) { d.update(s, rows, opts(101 + (wall - 10100) / 100, wall)); frames.add(d.frame); }
  assert.equal(d.ox, 0);                     // arrived before the next step (the stand at the cell)
  assert.ok(frames.size >= 10, `walk frames ${frames.size}`);
  const last = d.frame;
  assert.ok(last !== 0);
  // the walk ends: the simulation shows idle; the last walk frame stays
  d.update({ ...s, action: 3, actionTick: 107 }, rows, opts(108, wall + 100));
  assert.equal(d.action, 0);
  assert.equal(d.frame, last);
  assert.equal(d.busy, false);
});

test('UnitDisplay: the arrival is drawn before the step time is over (stand per cell, 2.5)', {}, () => {
  const d = new UnitDisplay();
  const u = unit({ action: 0 });
  d.update(u, rows, opts(0, 0));
  const s = { ...u, x: u.x + 256, stepFromX: u.x, stepStart: 1, stepTicks: 6 };
  // the step is seen 30 ms after its tick: its start is set back by the phase
  d.update(s, rows, opts(1.3, 130));
  let wall = 130;
  while (d.ox !== 0) { wall += 1; d.update(s, rows, opts(1 + (wall - 100) / 100, wall)); }
  const done = wall - 100;
  assert.ok(done > 500 && done < 545, `drawn in ${done} ms of the step's 600`);
});

test('UnitDisplay: a strike plays once, then the standing pose at frame 0; sound at the sound frame (3)', {}, () => {
  const d = new UnitDisplay();
  const u = unit({ action: 0, actionTick: 0 });
  d.update(u, rows, opts(0, 0));
  const s = { ...u, action: 1, actionTick: 10 };
  const sounds: number[] = [];
  for (let t = 10; t < 40; t += 0.25) {
    d.update(s, rows, opts(t, t * 100));
    if (d.sound) sounds.push(t);
    if (t < 24) { assert.equal(d.action, 1, `strike at ${t}`); }
  }
  assert.deepEqual(sounds.length, 1);
  assert.ok(sounds[0] >= 17.9 && sounds[0] <= 18.25, `sound at ${sounds[0]}`);
  assert.equal(d.action, 0);   // back to the base action
  assert.equal(d.frame, 0);    // frame 0 after an action
  assert.equal(d.busy, false);
});

test('UnitDisplay: an action cut before the sound frame stays silent; a new strike restarts (3)', {}, () => {
  const d = new UnitDisplay();
  const u = unit({ action: 1, actionTick: 0 });
  let n = 0;
  for (let t = 0; t < 5; t += 0.5) { d.update(u, rows, opts(t, t * 100)); if (d.sound) n++; }
  // a step cuts the strike (the simulation sets the walk action)
  const s = { ...u, action: 0, actionTick: 5, x: u.x + 256, stepFromX: u.x, stepStart: 5, stepTicks: 6 };
  for (let t = 5; t < 12; t += 0.5) { d.update(s, rows, opts(t, t * 100)); if (d.sound) n++; }
  assert.equal(n, 0);
  // a second strike plays its own cycle with its sound
  const r = { ...s, action: 1, actionTick: 20 };
  for (let t = 20; t < 40; t += 0.5) { d.update(r, rows, opts(t, t * 100)); if (d.sound) n++; }
  assert.equal(n, 1);
});

test('UnitDisplay: work loops with one sound event per cycle (3)', {}, () => {
  const d = new UnitDisplay();
  const u = unit({ action: 2, actionTick: 0 });
  let n = 0;
  const T = 8 * 10 / 7;
  for (let t = 0; t < T * 5 - 0.1; t += 0.2) {
    d.update(u, rows, opts(t, t * 100, { soundAction: 2, soundFrame: 3 }));
    assert.equal(d.action, 2);
    if (d.sound) n++;
  }
  assert.equal(n, 5);
});

test('UnitDisplay: the idle row plays idleLoops + 1 cycles when idleTick === actionTick (3, 4)', {}, () => {
  const d = new UnitDisplay();
  const T = 12 * 10 / 7;
  // a fidget: one cycle
  const f = unit({ dir: 3, action: 3, actionTick: 50, idleTick: 50, idleLoops: 0 });
  d.update(f, rows, opts(50, 5000));
  assert.equal(d.action, 3);
  assert.ok(d.busy);
  d.update(f, rows, opts(50 + T - 0.2, 5000 + (T - 0.2) * 100));
  assert.equal(d.action, 3);
  d.update(f, rows, opts(50 + T + 0.1, 5000 + (T + 0.1) * 100));
  assert.equal(d.action, 0);
  // an animal: 11 cycles
  const a = new UnitDisplay();
  const g = unit({ dir: 3, action: 3, actionTick: 0, idleTick: 0, idleLoops: 10 });
  a.update(g, rows, opts(T * 10.5, 0));
  assert.equal(a.action, 3);
  a.update(g, rows, opts(T * 11 + 0.1, 0));
  assert.equal(a.action, 0);
  // idle without an idle animation: the standing pose
  const s = new UnitDisplay();
  s.update(unit({ action: 3, actionTick: 5, idleTick: -1 }), rows, opts(6, 600));
  assert.equal(s.action, 0);
});

test('UnitDisplay: an empty slot sets the display facing to 0 (1.5); a facing change shows each direction', {}, () => {
  const d = new UnitDisplay();
  // facing 5, idle animation only exists as ID3: falls back to ID0? no ID0 either -> standing
  const rows5 = (a: number, dir: number): MotionRow | null => (a === 3 ? (dir === 0 ? { frames: 6, fps: 7 } : null) : { frames: 12, fps: 7 });
  d.update(unit({ dir: 5, action: 3, actionTick: 0, idleTick: 0 }), rows5, opts(0, 0));
  assert.equal(d.action, 3);
  assert.equal(d.dir, 0);
  // the display facing stays 0 until the next facing change
  d.update(unit({ dir: 5, action: 3, actionTick: 0, idleTick: 0 }), rows5, opts(20, 2000));
  assert.equal(d.action, 0);
  assert.equal(d.dir, 0);
  for (const dir of [6, 7, 0]) {
    d.update(unit({ dir, action: 3, actionTick: 0 }), rows5, opts(21 + dir, 3000));
    assert.equal(d.dir, dir);
  }
});

test('UnitDisplay: a facing change after the start cuts a running action (1.5)', {}, () => {
  const d = new UnitDisplay();
  const u = unit({ dir: 3, action: 2, actionTick: 0 });
  d.update(u, rows, opts(1, 100));
  assert.equal(d.action, 2);
  d.update({ ...u, dir: 4 }, rows, opts(5, 500));
  assert.equal(d.action, 0);
  assert.equal(d.frame, 0);
  // a new action after the turn plays
  d.update({ ...u, dir: 4, actionTick: 6 }, rows, opts(6.5, 650));
  assert.equal(d.action, 2);
});

test('UnitDisplay: carry row with goods, smooth mode glides with time-based frames', {}, () => {
  const rowsC = (a: number, dir: number): MotionRow | null => (a === 4 || a === 0 ? { frames: 12, fps: 7 } : rows(a, dir));
  const d = new UnitDisplay();
  const u = unit({ action: 4, carryAmount: 1 });
  d.update(u, rowsC, opts(0, 0));
  assert.equal(d.action, 4);
  const m = new UnitDisplay();
  const s = unit({ action: 0, actionTick: 0, x: 11 * 256 + 128, stepStart: 0, stepTicks: 8 });
  m.update(s, rows, opts(2, 200, { smooth: true }));
  assert.equal(m.ox, 48);       // 3/4 of the cell left, no jumps
  assert.equal(m.frame, 1);     // 2 ticks x 0.7 frames
  m.update(s, rows, opts(8, 800, { smooth: true }));
  assert.equal(m.ox, 0);
  assert.equal(m.frame, 0);     // standing: frame 0 in the enhanced mode
});

test('UnitDisplay: work with one cycle (founder, heal) plays once, then the standing pose', {}, () => {
  const d = new UnitDisplay();
  const u = unit({ action: 2, actionTick: 0 });
  const T = 8 * 10 / 7;
  d.update(u, rows, opts(T - 0.2, 0, { workCycles: 1 }));
  assert.equal(d.action, 2);
  d.update(u, rows, opts(T + 0.1, 0, { workCycles: 1 }));
  assert.equal(d.action, 0);
  assert.equal(d.frame, 0);
  d.update(u, rows, opts(3 * T, 0, { workCycles: 1 }));
  assert.equal(d.action, 0);
});

test('UnitDisplay: an action that starts mid-step clears the remaining offset at once; no jump when it ends (3)', {}, () => {
  for (const smooth of [false, true]) {
    const d = new UnitDisplay();
    const u = unit({ action: 0, actionTick: 0 });
    d.update(u, rows, opts(100, 10000, { smooth }));
    // a step east starts at tick 101 (D = 6); a strike begins at tick 102, while the step is drawn
    const s = { ...u, x: u.x + 256, stepFromX: u.x, stepStart: 101, stepTicks: 6 };
    d.update(s, rows, opts(101, 10100, { smooth }));
    d.update(s, rows, opts(101.5, 10150, { smooth }));
    assert.ok(d.ox > 0, 'the step is being drawn');
    const k = { ...s, action: 1, actionTick: 102 };
    d.update(k, rows, opts(102, 10200, { smooth }));
    assert.equal(d.action, 1);
    assert.equal(d.ox, 0, `drawn on the destination cell from the action start (smooth ${smooth})`);
    assert.equal(d.oy, 0);
    // the strike plays out; the base action comes back on the same cell, without a jump
    const drawn: number[] = [];
    for (let t = 102; t < 130; t += 0.25) { d.update(k, rows, opts(t, t * 100, { smooth })); drawn.push(d.ox); }
    assert.ok(drawn.every(x => x === 0), 'never drawn off the cell again');
    assert.equal(d.action, 0);
    // the next step starts from the firing cell as usual
    const n = { ...k, x: k.x + 256, stepFromX: k.x, stepStart: 130, stepTicks: 6 };
    d.update(n, rows, opts(130, 13000, { smooth }));
    assert.equal(d.ox, 64);
  }
});

test('UnitDisplay: the same action seen again does not clear a later step', {}, () => {
  const d = new UnitDisplay();
  const u = unit({ action: 2, actionTick: 50 });
  d.update(u, rows, opts(60, 6000));
  // a step after the work (the step ends the work action in the simulation: walk)
  const s = { ...u, action: 0, actionTick: 61, x: u.x + 256, stepFromX: u.x, stepStart: 61, stepTicks: 6 };
  d.update(s, rows, opts(61, 6100));
  assert.equal(d.ox, 64);
  d.update(s, rows, opts(62, 6200));
  assert.ok(d.ox > 0 && d.ox < 64);
});
