// World object display: dv.OD layer records, layer player, doors / work / random layers, fish
// leap, pixel picking, selection categories, placement preview recolour.
// Spec: docs/rendering/objects.md. The data tests need AN_DATA (dv.OD of the base game).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parseOd, LayerFlag, type OdLayer } from '../src/formats/od.ts';
import {
  LayerPlayer, IdleTimer, ObjDisplay, layerRoles, updateBuilding, buildingFrames, updateFish, workRequested,
  ghostRecolour, isFish, DOOR_HOLD_MS, type BuildingState,
} from '../src/client/display.ts';
import {
  alphaMask, compositeHit, frontToBack, categoryOf, chooseSelection, combineSelection, Cat, type HitLayer, type Selection,
  targetCategoryOf, chooseTarget, TargetCat,
} from '../src/client/picking.ts';

const DATA = process.env.AN_DATA ?? '';
const HAS_DATA = !!DATA && existsSync(`${DATA}/dv.OD`);
const skip = !HAS_DATA && 'AN_DATA not set';

/** a fixed sequence as the display rng */
const seq = (...v: number[]) => { let i = 0; return () => v[i++ % v.length]; };

test('dv.OD: building layers come from the descriptor, with role flags (objects.md 1)', { skip }, () => {
  const od = parseOd(readFileSync(`${DATA}/dv.OD`));
  const names = (oid: number) => od.get(oid)!.layers[1]!.map(l => l.name);
  // Amazon small house: the door is named DO (no 0), laundry RA0 is a random layer
  const house = od.get(37)!.layers[1]!;
  assert.deepEqual(house.map(l => l.name), ['AZ\\BU\\WOHN\\MS0', 'AZ\\BU\\WOHN\\DO', 'AZ\\BU\\WOHN\\RA0']);
  assert.deepEqual(house.map(l => l.flags), [0, 18, 66]);
  assert.deepEqual(layerRoles(house), { door: 1, work: [], random: [2] });
  assert.equal(names(38)[1], 'AZ\\BU\\WOHNGROSS\\DO');
  // Sajiki school: almost empty MS0, the building is its work layer
  const school = od.get((2 << 16) | 55)!.layers[1]!;
  assert.deepEqual(school.map(l => l.name), ['SA\\BU\\VERPUPPUNGSSTAETTE\\MS0', 'SA\\BU\\VERPUPPUNGSSTAETTE\\PE0']);
  assert.deepEqual(layerRoles(school), { door: -1, work: [1], random: [] });
  // Amazon armoury: RA0 with flags 98 is a work layer (the work bit wins)
  assert.deepEqual(layerRoles(od.get(61)!.layers[1]!), { door: 1, work: [2], random: [] });
  // the value table of 1: counts over all races
  const count = new Map<number, number>();
  for (const d of od.values()) for (const ls of d.layers) for (const l of ls ?? []) if (l.flags) count.set(l.flags, (count.get(l.flags) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries(count), { 18: 67, 32: 33, 98: 1, 66: 11, 67: 7 });
  // main layer = the old slot name; units and nature have one layer per slot
  for (const d of od.values()) d.layers.forEach((ls, s) => {
    if (!ls) return assert.equal(d.slots[s], null);
    assert.equal(ls[0].name, d.slots[s]);
    assert.equal(ls[0].flags, 0);
    if (d.kind !== 1 || s !== 1) assert.equal(ls.length, 1, `${d.slots[s]}`);
  });
});

test('layer player: once holds, ping-pong once ends on 0, reverse, stop freezes (objects.md 2)', {}, () => {
  const p = new LayerPlayer();
  assert.equal(p.frame(0, 5), 0, 'new player: frame 0');
  p.start(1000, 0, 7, LayerFlag.Once | LayerFlag.Door);
  assert.equal(p.frame(1000, 5), 0);
  assert.equal(p.frame(1000 + 3 * 1000 / 7 + 1, 5), 3);
  assert.equal(p.frame(9000, 5), 4, 'once holds the last frame');
  assert.ok(p.ended(9000, 5));
  p.start(0, 0, 10, LayerFlag.Once | LayerFlag.PingPong);
  assert.deepEqual([0, 200, 400, 500, 700, 900, 5000].map(t => p.frame(t, 5)), [0, 2, 4, 4, 2, 0, 0]);
  p.start(0, 0, 10, LayerFlag.Once | LayerFlag.Reverse);
  assert.deepEqual([0, 100, 400, 2000].map(t => p.frame(t, 5)), [4, 3, 0, 0]);
  p.start(0, 0, 10, 0);   // loop
  assert.equal(p.frame(700, 5), 2);
  p.stop(700, 5);
  assert.equal(p.frame(99999, 5), 2, 'stop keeps the frame shown');
});

test('idle timer: 5000 + rand mod 25000, held while busy (objects.md 5.1)', {}, () => {
  const rng = seq(30000, 100, 7);
  const t = new IdleTimer(rng);
  assert.equal(t.interval, 5000 + 30000 % 25000);
  assert.equal(t.update(0, false, rng), false, 'starts on the first redraw');
  assert.equal(t.update(10000, false, rng), false);
  assert.equal(t.update(10001, false, rng), true);
  assert.equal(t.interval, 5100);
  assert.equal(t.start, -1);
  t.update(20000, false, rng);
  assert.equal(t.update(30000, true, rng), false, 'busy resets');
  assert.equal(t.start, -1);
});

const L = (name: string, flags: number, frames: number): OdLayer => ({ name, flags, frames, speed: 7, rect: [0, 0, 1, 1] });
const HOUSE = [L('MS0', 0, 1), L('DO', 18, 5), L('RA0', 66, 5)];
const SCHOOL = [L('MS0', 0, 1), L('DO0', 18, 5), L('PE0', 32, 8)];
const st = (o: Partial<BuildingState> = {}): BuildingState => ({ complete: true, active: true, working: false, doorTick: 0, ...o });

test('door: opens when a unit goes through, stays open, closes from the open frame (objects.md 4.1)', {}, () => {
  const rng = seq(0);
  const d = new ObjDisplay(rng), roles = layerRoles(HOUSE);
  updateBuilding(d, st({ doorTick: 5 }), HOUSE, roles, 10, true, 0, rng);
  assert.equal(buildingFrames(d, HOUSE, 0)[1], 0, 'closed: no event at first sight');
  updateBuilding(d, st({ doorTick: 9 }), HOUSE, roles, 10, true, 1000, rng);
  assert.equal(buildingFrames(d, HOUSE, 1500)[1], 3);
  assert.equal(buildingFrames(d, HOUSE, 1900)[1], 4, 'open');
  updateBuilding(d, st({ doorTick: 9 }), HOUSE, roles, 10, true, 1000 + DOOR_HOLD_MS - 1, rng);
  assert.equal(buildingFrames(d, HOUSE, 1000 + DOOR_HOLD_MS - 1)[1], 4, 'still open');
  updateBuilding(d, st({ doorTick: 9 }), HOUSE, roles, 10, true, 1000 + DOOR_HOLD_MS, rng);
  assert.equal(buildingFrames(d, HOUSE, 1000 + DOOR_HOLD_MS)[1], 4, 'closing starts fully open');
  assert.equal(buildingFrames(d, HOUSE, 5000)[1], 0, 'closed again');
});

test('work layers run only while working and freeze otherwise (objects.md 4.2)', {}, () => {
  const rng = seq(0);
  const d = new ObjDisplay(rng), roles = layerRoles(SCHOOL);
  updateBuilding(d, st(), SCHOOL, roles, 10, true, 0, rng);
  assert.equal(buildingFrames(d, SCHOOL, 5000)[2], 0, 'idle school: clock at frame 0');
  updateBuilding(d, st({ working: true }), SCHOOL, roles, 10, true, 1000, rng);
  assert.equal(buildingFrames(d, SCHOOL, 1000 + 3000 / 7 + 1)[2], 3);
  updateBuilding(d, st({ working: false }), SCHOOL, roles, 10, true, 1000 + 3000 / 7 + 1, rng);
  assert.equal(buildingFrames(d, SCHOOL, 60000)[2], 3, 'frozen where it was');
  // who works: training buildings while training, production while a run is going, services when active
  const b = { active: true, trainStarted: 0, order: null as { kind: string; started: number } | null };
  assert.equal(workRequested(b, { cls: 5, product: -1 }), false);
  assert.equal(workRequested({ ...b, trainStarted: 1 }, { cls: 5, product: -1 }), true);
  assert.equal(workRequested({ ...b, order: { kind: 'produce', started: 0 } }, { cls: 3, product: 4 }), false);
  assert.equal(workRequested({ ...b, order: { kind: 'produce', started: 1 } }, { cls: 3, product: 4 }), true);
  assert.equal(workRequested(b, { cls: 3, product: -1 }), true);
  assert.equal(workRequested({ ...b, active: false }, { cls: 3, product: -1 }), false);
});

test('random layer: on screen and active only, plays once, asks for the record sound (objects.md 4.3)', {}, () => {
  const rng = seq(0);   // interval 5000, layer choice 0
  const d = new ObjDisplay(rng), roles = layerRoles(HOUSE);
  assert.equal(updateBuilding(d, st(), HOUSE, roles, 10, true, 0, rng).sound, false);
  assert.equal(updateBuilding(d, st(), HOUSE, roles, 10, true, 5000, rng).sound, false);
  assert.equal(updateBuilding(d, st(), HOUSE, roles, 10, true, 5001, rng).sound, true);
  assert.equal(buildingFrames(d, HOUSE, 5001 + 2000 / 7 + 1)[2], 2);
  assert.equal(buildingFrames(d, HOUSE, 20000)[2], 4, 'flags 66: holds the last frame');
  // off screen: never fires, the timer starts again when it comes back
  const off = new ObjDisplay(rng);
  for (let t = 0; t < 60000; t += 500) assert.equal(updateBuilding(off, st(), HOUSE, roles, 10, false, t, rng).sound, false);
  // inactive: the timer fires but nothing plays
  const ina = new ObjDisplay(rng);
  for (let t = 0; t < 60000; t += 500) assert.equal(updateBuilding(ina, st({ active: false }), HOUSE, roles, 10, true, t, rng).sound, false);
  assert.equal(buildingFrames(ina, HOUSE, 60000)[2], 0);
});

test('a founded town hall replays BU0 at 5 fps when on screen; a normal completion switches at once (objects.md 3)', {}, () => {
  const rng = seq(0);
  const d = new ObjDisplay(rng), roles = layerRoles(HOUSE);
  updateBuilding(d, st({ complete: false, replayOnComplete: true }), HOUSE, roles, 10, true, 0, rng);
  updateBuilding(d, st({ complete: true, replayOnComplete: true }), HOUSE, roles, 10, true, 100, rng);
  assert.ok(d.replay);
  assert.equal(d.replay!.frame(100 + 1000, 10), 5);
  updateBuilding(d, st({ complete: true, replayOnComplete: true }), HOUSE, roles, 10, true, 2100, rng);
  assert.equal(d.replay, null, 'MS0 after 2 s');
  // completed while off screen: no replay
  const o = new ObjDisplay(rng);
  updateBuilding(o, st({ complete: false }), HOUSE, roles, 10, false, 0, rng);
  updateBuilding(o, st({ complete: true }), HOUSE, roles, 10, false, 100, rng);
  assert.equal(o.replay, null);
  // a builder's normal completion on screen: MS0 at once
  const n = new ObjDisplay(rng);
  updateBuilding(n, st({ complete: false }), HOUSE, roles, 10, true, 0, rng);
  updateBuilding(n, st({ complete: true }), HOUSE, roles, 10, true, 100, rng);
  assert.equal(n.replay, null);
});

test('fish rest on MS0 and leap once through ID0 at 5 fps (objects.md 5.3)', {}, () => {
  const rng = seq(0);
  const d = new ObjDisplay(rng);
  assert.equal(updateFish(d, 6, 5, true, 0, rng), -1);
  assert.equal(updateFish(d, 6, 5, true, 5000, rng), -1);
  assert.equal(updateFish(d, 6, 5, true, 5001, rng), 0, 'leap starts');
  assert.equal(updateFish(d, 6, 5, true, 5001 + 600, rng), 3);
  assert.equal(updateFish(d, 6, 5, true, 5001 + 1200, rng), -1, 'back on MS0 after 6 frames');
  assert.equal(updateFish(d, 6, 5, true, 5001 + 1300, rng), -1);
  assert.ok(isFish((6 << 16) | 41) && isFish((6 << 16) | 45) && !isFish((6 << 16) | 40) && !isFish(41));
});

test('pixel picking: alpha > 192, layers copied over MS0 holes, rectangle grown (objects.md 8)', {}, () => {
  // 4x4 MS0, opaque except a hole at (1..2, 1..2); a 2x2 layer over the hole, opaque at (0,0) only
  const ms = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) { const x = i % 4, y = i >> 2; ms[i * 4 + 3] = x >= 1 && x <= 2 && y >= 1 && y <= 2 ? 0 : 255; }
  ms[15 * 4 + 3] = 192;   // not above 192: no hit
  const pe = new Uint8Array(2 * 2 * 4); pe[3] = 200;
  const layers: HitLayer[] = [
    { mask: alphaMask(ms, 4, 4), w: 4, h: 4, ox: -2, oy: -4 },
    { mask: alphaMask(pe, 2, 2), w: 2, h: 2, ox: -1, oy: -3 },
  ];
  const hit = (x: number, y: number, g = 0, z = 1) => compositeHit(layers, 100, 100, z, x - g, y - g, x + g, y + g);
  assert.equal(hit(98, 96), true, 'MS0 corner');
  assert.equal(hit(99, 97), true, 'layer pixel over the hole');
  assert.equal(hit(100, 98), false, 'hole not covered by an opaque layer pixel');
  assert.equal(hit(101, 99), false, 'alpha 192 does not count');
  assert.equal(hit(100, 98, 1), true, 'grown rectangle reaches an opaque pixel');
  assert.equal(hit(110, 110, 2), false);
  assert.equal(hit(100 + 2 * 2, 100 + 2 * 1, 0, 2), false);
  assert.equal(hit(100 - 2 * 2, 100 - 2 * 4, 0, 2), true, 'zoom 2');
});

test('selection categories, priority, caps, modifiers; fish never (objects.md 8)', {}, () => {
  const P = 0;
  assert.equal(categoryOf({ kind: 0, owner: 0, oid: 9 }, -1, P), Cat.OwnUnit);
  assert.equal(categoryOf({ kind: 0, owner: 0, oid: 12 }, -1, P), Cat.OtherUnit, 'own criminal');
  assert.equal(categoryOf({ kind: 0, owner: 1, oid: (1 << 16) | 9 }, -1, P), Cat.OtherUnit);
  assert.equal(categoryOf({ kind: 1, owner: 0, oid: 40 }, 3, P), Cat.OwnBuilding);
  assert.equal(categoryOf({ kind: 1, owner: 2, oid: (2 << 16) | 40 }, 3, P), Cat.ForeignBuilding);
  assert.equal(categoryOf({ kind: 2, owner: -1, oid: (6 << 16) | 10 }, 8, P), Cat.Tree);
  assert.equal(categoryOf({ kind: 2, owner: -1, oid: (6 << 16) | 30 }, 13, P), Cat.Nature);
  assert.equal(categoryOf({ kind: 2, owner: -1, oid: (6 << 16) | 43 }, 15, P), -1, 'fish');
  // the drawn list (back to front) is tested from the frontmost object backwards
  const drawnList = [{ id: 1, cat: Cat.OwnUnit }, { id: 2, cat: Cat.Tree }, { id: 3, cat: Cat.OwnUnit }, { id: 4, cat: Cat.OwnUnit }];
  const fb = frontToBack(drawnList, o => (o.id === 4 ? null : o));
  assert.deepEqual(fb.map(h => h.id), [3, 2, 1]);
  assert.deepEqual(chooseSelection(fb, true), { cat: Cat.OwnUnit, ids: [3] }, 'click: the frontmost own unit');
  // a box over units and a building selects the units, the 12 frontmost
  const hits = [{ id: 100, cat: Cat.OwnBuilding }, ...Array.from({ length: 15 }, (_, i) => ({ id: i + 1, cat: Cat.OwnUnit }))];
  assert.deepEqual(chooseSelection(hits, false), { cat: Cat.OwnUnit, ids: Array.from({ length: 12 }, (_, i) => i + 1) });
  // a click takes the first (frontmost) hit per category
  assert.deepEqual(chooseSelection(hits, true), { cat: Cat.OwnUnit, ids: [1] });
  assert.deepEqual(chooseSelection([{ id: 5, cat: Cat.Tree }, { id: 6, cat: Cat.Nature }], true), { cat: Cat.Nature, ids: [6] });
  assert.deepEqual(chooseSelection([], true), { cat: -1, ids: [] });
  // Shift adds within the category, Ctrl on a selected object removes it, other categories replace
  const cur: Selection = { cat: Cat.OwnUnit, ids: [1, 2] };
  assert.deepEqual(combineSelection(cur, { cat: Cat.OwnUnit, ids: [3] }, true, false), { cat: Cat.OwnUnit, ids: [1, 2, 3] });
  assert.deepEqual(combineSelection(cur, { cat: Cat.OwnUnit, ids: [2] }, false, true), { cat: Cat.OwnUnit, ids: [1] });
  assert.deepEqual(combineSelection(cur, { cat: Cat.OwnBuilding, ids: [9] }, true, false), { cat: Cat.OwnBuilding, ids: [9] });
  assert.deepEqual(combineSelection(cur, { cat: -1, ids: [] }, false, false), { cat: -1, ids: [] });
  assert.deepEqual(combineSelection(cur, { cat: -1, ids: [] }, true, false), cur);
});

test('right-click target: whole sprite, frontmost per category, unit > nature > building > tree (objects.md 8.1)', {}, () => {
  const P = 0;
  assert.equal(targetCategoryOf({ kind: 0, owner: 1 }, -1, P), TargetCat.ForeignUnit);
  assert.equal(targetCategoryOf({ kind: 0, owner: 0 }, -1, P), TargetCat.OwnUnit);
  assert.equal(targetCategoryOf({ kind: 1, owner: 0 }, 3, P), TargetCat.OwnBuilding);
  assert.equal(targetCategoryOf({ kind: 1, owner: 2 }, 3, P), TargetCat.ForeignBuilding);
  assert.equal(targetCategoryOf({ kind: 2, owner: -1 }, 8, P), TargetCat.Tree);
  assert.equal(targetCategoryOf({ kind: 2, owner: -1 }, 15, P), TargetCat.Nature, 'fish are targets (fishing boats)');
  // a building: a 6x6 wall picture with a 2x2 door layer at its bottom; a click on the roof hits it
  const wall = new Uint8Array(6 * 6 * 4).fill(255), door = new Uint8Array(2 * 2 * 4).fill(255);
  const building: HitLayer[] = [
    { mask: alphaMask(wall, 6, 6), w: 6, h: 6, ox: -3, oy: -6 },
    { mask: alphaMask(door, 2, 2), w: 2, h: 2, ox: -1, oy: -2 },
  ];
  const at = (x: number, y: number) => compositeHit(building, 100, 100, 1, x - 2, y - 2, x + 2, y + 2);
  assert.equal(at(100, 99), true, 'door');
  assert.equal(at(98, 95), true, 'wall/roof, far from the door');
  assert.equal(at(100, 90), false, 'above the sprite');
  // priority: drawn list back to front, tested front to back
  const drawn = [
    { id: 1, cat: TargetCat.Tree }, { id: 2, cat: TargetCat.OwnBuilding }, { id: 3, cat: TargetCat.OwnBuilding },
  ];
  assert.equal(chooseTarget(frontToBack(drawn, o => o)), 3, 'frontmost building, not the tree');
  assert.equal(chooseTarget(frontToBack([...drawn, { id: 4, cat: TargetCat.Nature }], o => o)), 4, 'nature before buildings');
  assert.equal(chooseTarget(frontToBack([{ id: 5, cat: TargetCat.ForeignUnit }, ...drawn, { id: 6, cat: TargetCat.OwnUnit }], o => o)), 5,
    'a foreign unit behind wins over an own unit in front');
  assert.equal(chooseTarget([]), -1, 'nothing hit: a move');
});

test('placement preview recolour: top 5 bits of green into green or red, alpha kept (objects.md 6.2)', {}, () => {
  const px = new Uint8Array([200, 107, 50, 255, 10, 200, 10, 128, 255, 255, 255, 0]);
  const ok = ghostRecolour(px, true), no = ghostRecolour(px, false);
  assert.deepEqual([...ok.subarray(0, 4)], [0, 104, 0, 255]);
  assert.deepEqual([...no.subarray(0, 4)], [104, 0, 0, 255]);
  // half alpha: premultiplied green 100 -> 96, back to straight 96 * 255 / 128
  assert.deepEqual([...ok.subarray(4, 8)], [0, 191, 0, 128]);
  assert.deepEqual([...no.subarray(8, 12)], [0, 0, 0, 0]);
});
