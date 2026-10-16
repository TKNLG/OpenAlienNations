// Advisor (mentor) lines: the nation's interval filter, the client's voice player and the triggers.
// Spec: docs/ui/side-panel.md 1.1 (economy.md 5.7, 5.8; combat.md 5, 10.3). The world tests need
// AN_DATA.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { Kind, TICK_MS, type World, type Entity } from '../src/engine/world.ts';
import { Good, ADVISOR_REPEAT_MS } from '../src/engine/economy.ts';
import { AdvisorVoice, AdvisorQueue, QUEUE_REPEAT_MS } from '../src/client/advisor-voice.ts';
import { MissingOperatorLine, infoBuilding, MENTOR_NO_OPERATOR, type OperatorCheck } from '../src/client/hud-pages.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const PIMMONS = 1;
const REPEAT_TICKS = ADVISOR_REPEAT_MS / TICK_MS;

// ---------------------------------------------------------------- voice player (1.1.2)

/** a fake sound device: each voice plays for `len` frames (0 = fails to load) */
function rig(len = 60, speech = true) {
  let frame = 0;
  const heard: number[] = [], shown: number[] = [];
  const v = new AdvisorVoice<{ id: number; end: number }>({
    speechOn: () => speech,
    start: id => { heard.push(id); return len > 0 ? { id, end: frame + len } : null; },
    playing: s => frame < s.end,
    text: id => shown.push(id),
  });
  const frames = (n: number) => { for (let i = 0; i < n; i++) { v.frame(); frame++; } };
  return { v, heard, shown, frames, setSpeech: (on: boolean) => { speech = on; } };
}

test('voice: a burst in one frame is heard as its first line only, the rest leave no text', {}, () => {
  const { v, heard, shown, frames } = rig();
  // training finished and a happiness line and a shortage in the same tick
  v.speak(42, true); v.speak(13, true); v.speak(2, true);
  frames(200);
  assert.deepEqual(heard, [42]);
  assert.deepEqual(shown, [42]);
  assert.equal(v.queued, 0, 'the pending list is used up, one line per frame');
});

test('voice: a queued line waits until the frame step at most', {}, () => {
  // the voice (3 frames) has ended but is not yet released when the line arrives: the step of
  // that frame releases it and plays the queued line
  const a = rig(3);
  a.v.speak(1, true);
  a.frames(3);
  a.v.speak(10, true);
  assert.deepEqual(a.heard, [1], 'queued');
  a.frames(1);
  assert.deepEqual(a.heard, [1, 10]);
  // the voice ends one frame later: the queued line was already dropped
  const b = rig(3);
  b.v.speak(1, true);
  b.frames(2);
  b.v.speak(10, true);
  b.frames(5);
  assert.deepEqual(b.heard, [1]);
  assert.deepEqual(b.shown, [1], 'a dropped line shows no text');
  // a line that arrives after the voice was released plays at once
  b.v.speak(13, true);
  assert.deepEqual(b.heard, [1, 13]);
});

test('voice: an unqueued line is dropped while a voice plays; a voice that fails to load blocks nothing', {}, () => {
  const a = rig();
  a.v.speak(1, true); a.v.speak(79, false);
  a.frames(100);
  assert.deepEqual(a.shown, [1]);
  const b = rig(0);
  b.v.speak(1, true); b.v.speak(79, false); b.v.speak(13, true);
  assert.deepEqual(b.shown, [1, 79, 13], 'no voice: every line shows its text');
});

test('voice: with speech off every line is text only and the pending list is emptied', {}, () => {
  const r = rig();
  r.v.speak(1, true); r.v.speak(13, true);
  assert.equal(r.v.queued, 1);
  r.setSpeech(false);
  r.v.speak(42, true); r.v.speak(79, false);
  assert.equal(r.v.queued, 0);
  r.frames(100);
  assert.deepEqual(r.heard, [1]);
  assert.deepEqual(r.shown, [1, 42, 79]);
});

// ---------------------------------------------------------------- enhanced: queue player

/** the fake sound device for AdvisorQueue: frames of 16 ms, end events like onended */
function queueRig(len = 60, withEndEvent = true) {
  let frame = 0;
  const heard: number[] = [], shown: number[] = [];
  const ends: { s: { id: number; end: number }; done: () => void }[] = [];
  const v = new AdvisorQueue<{ id: number; end: number }>({
    speechOn: () => true,
    start: id => { heard.push(id); return len > 0 ? { id, end: frame + len } : null; },
    playing: s => frame < s.end,
    text: id => shown.push(id),
    now: () => frame * 16,
    onEnd: withEndEvent ? (s, done) => { ends.push({ s, done }); } : undefined,
  });
  const frames = (n: number) => {
    for (let i = 0; i < n; i++) {
      frame++;
      for (const e of ends.splice(0)) { if (frame >= e.s.end) e.done(); else ends.push(e); }   // onended
      v.frame();
    }
  };
  return { v, heard, shown, frames };
}

test('enhanced queue: a burst is heard line after line, each when the previous voice ends', {}, () => {
  for (const withEndEvent of [true, false]) {
    const { v, heard, shown, frames } = queueRig(60, withEndEvent);
    v.speak(42, true); v.speak(13, true); v.speak(2, true);
    assert.deepEqual(heard, [42]);
    assert.equal(v.queued, 2);
    frames(59);
    assert.deepEqual(heard, [42], 'the next line waits for the end of the voice');
    frames(1);
    assert.deepEqual(heard, [42, 13]);
    frames(200);
    assert.deepEqual(heard, [42, 13, 2]);
    assert.deepEqual(shown, [42, 13, 2], 'every queued line shows its text when it plays');
    assert.equal(v.busy, false);
  }
});

test('enhanced queue: unqueued lines are dropped while a voice plays; 60 s guard except 1/10/13/79/80', {}, () => {
  const { v, heard, frames } = queueRig(60);
  v.speak(42, true); v.speak(79, false);
  frames(100);
  assert.deepEqual(heard, [42]);
  // 42 again within 60 s: dropped by the guard; 79 is exempt
  v.speak(42, true); v.speak(79, true);
  frames(100);
  assert.deepEqual(heard, [42, 79]);
  frames(QUEUE_REPEAT_MS / 16);
  v.speak(42, true);
  assert.deepEqual(heard, [42, 79, 42], 'said again after 60 s');
  // a voice that fails to load does not hold up the queue
  const b = queueRig(0);
  b.v.speak(1, true); b.v.speak(13, true);
  assert.deepEqual(b.shown, [1, 13]);
});

// ---------------------------------------------------------------- nation filter (1.1.1)

function town4() {
  const { world: w } = loadMission('Pimmons.mdb', 4, DATA, false);
  const t = w.economy.towns.find(x => x.race === PIMMONS)!;
  w.events.length = 0;
  return { w, t };
}
const said = (w: World, id: number, race = PIMMONS) => w.events.filter(e => e.race === race && e.mentor === id).length;

test('filter: an interval drops repeats; a call without one does not stamp; arming silences', { skip }, () => {
  const { w } = town4();
  w.notify(PIMMONS, 20, true, 0);
  w.notify(PIMMONS, 20, true, ADVISOR_REPEAT_MS);
  assert.equal(said(w, 20), 2, 'the interval-free call left the slot unstamped');
  w.notify(PIMMONS, 20, true, ADVISOR_REPEAT_MS);
  assert.equal(said(w, 20), 2, 'within 120 s: dropped');
  w.notify(PIMMONS, 22, true, ADVISOR_REPEAT_MS);
  assert.equal(said(w, 22), 1, 'each line has its own slot');
  w.notify(0, 20, true, ADVISOR_REPEAT_MS);
  assert.equal(said(w, 20, 0), 1, 'each nation has its own slots');
  w.tick += REPEAT_TICKS - 1;
  w.notify(PIMMONS, 20, true, ADVISOR_REPEAT_MS);
  assert.equal(said(w, 20), 2);
  w.tick += 1;
  w.notify(PIMMONS, 20, true, ADVISOR_REPEAT_MS);
  assert.equal(said(w, 20), 3, '120 s later: said');
  w.armAdvisor(PIMMONS, 42);
  w.notify(PIMMONS, 42, true, ADVISOR_REPEAT_MS);
  assert.equal(said(w, 42), 0, 'armed: silenced');
});

test('happiness lines: 2 D each, the group arms itself, mentor#28 is never said', { skip }, () => {
  const { w, t } = town4();
  const eco = w.economy;
  t.stock[Good.Food] = 1000;
  eco.updateHappiness(t);
  const h = t.happiness;
  assert.equal(t.foodPct, 100);
  w.events.length = 0;
  for (let i = 0; i < 5; i++) eco.updateHappiness(t);
  assert.equal(w.events.length, 0, 'unchanged happiness says nothing (mentor#28 unreachable)');
  t.happiness = h - 1;
  eco.updateHappiness(t);
  assert.deepEqual(w.events.map(e => e.mentor), [42], 'rose: mentor#42');
  t.happiness = h + 1;
  eco.updateHappiness(t);
  t.happiness = h - 1;
  eco.updateHappiness(t);
  assert.deepEqual(w.events.map(e => e.mentor), [42], 'mentor#43 armed by #42, #42 within its interval');
  w.tick += REPEAT_TICKS;
  t.happiness = h + 1;
  eco.updateHappiness(t);
  assert.deepEqual(w.events.map(e => e.mentor), [42, 43]);
  // food short: mentor#26/#27 once per 120 s, and it silences #42/#43
  w.events.length = 0;
  w.tick += REPEAT_TICKS;
  t.stock[Good.Food] = 1;
  for (let i = 0; i < 10; i++) eco.updateHappiness(t);
  const food = t.foodPct < 50 ? 27 : 26;
  assert.ok(t.foodPct < 100);
  assert.deepEqual(w.events.map(e => e.mentor), [food]);
  w.tick += REPEAT_TICKS - 1;
  t.stock[Good.Food] = 1000;
  t.happiness = 0;
  eco.updateHappiness(t);
  assert.deepEqual(w.events.map(e => e.mentor), [food], '#42 armed by the food line');
});

test('research command with no research money: mentor#16, unqueued', { skip }, () => {
  const { w, t } = town4();
  t.researchPct = 0;
  w.schedule({ type: 'research', player: PIMMONS, town: t.id, invention: 0 });
  w.step();
  const e = w.events.filter(x => x.mentor === 16);
  assert.equal(e.length, 1);
  assert.equal(e[0].queue, false);
});

// ---------------------------------------------------------------- building lines

function training() {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 7, DATA, false);
  const me = m.humanRace;
  const t = w.economy.towns.find(x => x.race === me)!;
  w.events.length = 0;
  return { w, me, t };
}
function stepUntilGone(w: World, b: Entity): void {
  for (let i = 0; i < 3000 && w.get(b.id); i++) w.step();
  assert.equal(w.get(b.id), undefined, 'removed');
}
const ownBuilding = (w: World, me: number, t: { id: number }) =>
  w.entities.find(e => e.kind === Kind.Building && e.owner === me && e.town === t.id && e.complete && (e.oid & 0xffff) !== 40)!;

test('demolish: mentor#80 once, at the end of the collapse, not on the command', { skip }, () => {
  const { w, me, t } = training();
  const b = ownBuilding(w, me, t);
  w.schedule({ type: 'building', player: me, id: b.id, action: 'demolish' });
  w.step();
  assert.equal(said(w, 80, me), 0, 'nothing on the command');
  stepUntilGone(w, b);
  assert.equal(said(w, 80, me), 1);
});

test('a building destroyed by the enemy says mentor#80 too (same die method); a lost town only #21', { skip }, () => {
  const { w, me, t } = training();
  const b = ownBuilding(w, me, t);
  b.hp = 0;
  w.combat.die(b);
  stepUntilGone(w, b);
  assert.equal(said(w, 80, me), 1);
  w.events.length = 0;
  const hall = w.get(t.hall)!;
  const others = w.entities.filter(e => e.kind === Kind.Building && e.town === t.id && e.id !== hall.id);
  assert.ok(others.length > 0);
  hall.hp = 0;
  w.combat.die(hall);
  stepUntilGone(w, hall);
  for (const o of others) stepUntilGone(w, o);
  assert.equal(said(w, 80, me), 1, 'the hall only: the town is dead when its buildings fall');
  assert.equal(said(w, 21, me), 1);
});

test('attack lines: mentor#20 at most once per 120 s while a building is hit', { skip }, () => {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 7, DATA, false);
  const me = m.humanRace;
  const enemy = m.races.find(r => r.present && r.race !== me)!.race;
  const t = w.economy.towns.find(x => x.race === enemy)!;
  const target = ownBuilding(w, enemy, t);
  const hp0 = target.hp;
  const men: Entity[] = [];
  const bx = Math.floor(target.x / 256), by = Math.floor(target.y / 256);
  for (let y = by - 4; y <= by + 2 && men.length < 4; y++) for (let x = bx - 4; x <= bx + 2 && men.length < 4; x++)
    if (w.motion.free(x, y)) men.push(w.spawnUnit(me, 30, x, y, w.economy.towns.find(x2 => x2.race === me)!.id));
  w.events.length = 0;
  w.schedule({ type: 'order', player: me, ids: men.map(u => u.id), target: target.id });
  for (let i = 0; i < REPEAT_TICKS - 10 && w.get(target.id)?.alive; i++) w.step();
  assert.ok((w.get(target.id)?.hp ?? 0) < hp0, 'hit');
  assert.equal(said(w, 20, enemy), 1);
});

// ---------------------------------------------------------------- line 12: the info page (1.1.5)

test('line 12: said once per opening of an own inactive building\'s info page', {}, () => {
  const p = new MissingOperatorLine();
  const lab: OperatorCheck = { id: 7, own: true, upkeep: 15, active: false };
  const bank: OperatorCheck = { id: 9, own: true, upkeep: 50, active: false };
  assert.equal(p.build(true, lab), true, 'the page opens: said');
  for (let i = 0; i < 5; i++) assert.equal(p.build(true, lab), false, 'refreshes of the same page: silent');
  assert.equal(p.build(true, bank), true, 'switched to another building on the same page');
  assert.equal(p.build(true, lab), true, 'and back: the building changed again');
  // another page (unit info, nothing, the building's production page) and back: a new page object
  assert.equal(p.build(false, null), false);
  assert.equal(p.build(true, lab), true, 'reopened: said again, even for the same building');
  // no interval: open, close, open ... says it every time
  for (let i = 0; i < 3; i++) { p.build(false, null); assert.equal(p.build(true, lab), true); }
});

test('line 12: not for active, foreign or upkeep-free buildings; said when the open page\'s building stops', {}, () => {
  const p = new MissingOperatorLine();
  const mine: OperatorCheck = { id: 3, own: true, upkeep: 20, active: true };
  assert.equal(p.build(true, mine), false, 'active: nothing');
  assert.equal(p.build(true, mine), false);
  // the operator is sent out while the page stays open: the next refresh says it (flag still set)
  assert.equal(p.build(true, { ...mine, active: false }), true);
  assert.equal(p.build(true, { ...mine, active: false }), false, 'once');
  // reactivated and deactivated again on the same open page: the flag was used up
  p.build(true, mine);
  assert.equal(p.build(true, { ...mine, active: false }), false);
  assert.equal(p.build(true, { id: 4, own: false, upkeep: 20, active: false }), false, 'foreign building');
  assert.equal(p.build(true, { id: 5, own: true, upkeep: 0, active: false }), false, 'no upkeep');
  // the flag a foreign building's page left set is used by the next own inactive one
  assert.equal(p.build(true, { id: 6, own: true, upkeep: 10, active: false }), true);
});

test('line 12: only the finished-building info page (page 0, one complete building) counts', {}, () => {
  const b = { kind: Kind.Building, complete: true } as Entity;
  const site = { kind: Kind.Building, complete: false } as Entity;
  const unit = { kind: Kind.Unit } as Entity;
  assert.equal(infoBuilding(0, [b]), b);
  assert.equal(infoBuilding(13, [b]), null, 'production page');
  assert.equal(infoBuilding(6, [b]), null, 'inhabitants page');
  assert.equal(infoBuilding(0, [site]), null, 'construction site page (class 15)');
  assert.equal(infoBuilding(0, [unit]), null);
  assert.equal(infoBuilding(0, [b, b]), null, 'group page');
  assert.equal(infoBuilding(-1, []), null);
});

test('line 12 goes to the voice player unqueued: dropped while a voice plays, text only with speech off', {}, () => {
  const { v, heard, shown, frames } = rig();
  v.speak(1, true);                       // "Ein Gebäude ist fertig." plays
  v.speak(MENTOR_NO_OPERATOR, false);     // the page switches to class 1 a moment later
  frames(200);
  assert.deepEqual(heard, [1]);
  assert.deepEqual(shown, [1], 'dropped with no text');
  v.speak(MENTOR_NO_OPERATOR, false);
  assert.deepEqual(heard, [1, 12], 'with no voice playing it is heard');
  const off = rig(60, false);
  off.v.speak(MENTOR_NO_OPERATOR, false);
  assert.deepEqual(off.heard, []);
  assert.deepEqual(off.shown, [12]);
});

test('line 12 in a mission: an own building with an operator, deactivated, then its page opened', { skip }, () => {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 7, DATA, false);
  const me = m.humanRace;
  const b = w.entities.find(e => e.kind === Kind.Building && e.owner === me && e.complete && e.active
    && (e.oid & 0xffff) !== 40 && (w.rules.get(e.oid)?.operator ?? -1) >= 0)!;
  assert.ok(b, 'an active own building with an operator');
  const check = (e: Entity): OperatorCheck => ({ id: e.id, own: e.owner === me, upkeep: w.rules.get(e.oid)!.money, active: e.active });
  const p = new MissingOperatorLine();
  assert.ok(w.rules.get(b.oid)!.money > 0);
  assert.equal(p.build(!!infoBuilding(0, [b]), check(b)), false, 'active: silent');
  p.build(false, null);                   // the player clicks elsewhere
  w.schedule({ type: 'building', player: me, id: b.id, action: 'deactivate' });
  for (let i = 0; i < 200 && b.active; i++) w.step();
  assert.equal(b.active, false, 'deactivated');
  assert.equal(p.build(!!infoBuilding(0, [b]), check(b)), true, 'its info page opens: line 12');
  assert.equal(w.events.some(e => e.mentor === MENTOR_NO_OPERATOR), false, 'never through the simulation');
});
