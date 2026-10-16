// Training page (side-panel.md class 7, 3.1 button look bits) and the depletion frame of nature
// objects (units-and-jobs.md 7.4). Pure functions first; the last test needs AN_DATA.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { trainingView, buttonTint } from '../src/client/hud-pages.ts';
import { lossFrame } from '../src/client/looks.ts';
import { loadMission, DATA } from './helpers/mission.ts';
import { Kind, type Entity } from '../src/engine/world.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const NO_GOODS = [0, 0, 0, 0, 0, 0, 0, 0, 0];

test('training page: slot i is normal when i < units inside, otherwise only dark (still clickable)', {}, () => {
  const v = trainingView([11, 12, 13], 1, false, 0, 50, NO_GOODS, NO_GOODS);
  assert.deepEqual(v.slots, [{ type: 11, dark: false }, { type: 12, dark: true }, { type: 13, dark: true }]);
  // compared by position only: 2 inside, 4 queued
  assert.deepEqual(trainingView([9, 11, 11, 12], 2, false, 0, 50, NO_GOODS, NO_GOODS).slots.map(s => s.dark), [false, false, true, true]);
  // the dark look is drawn like "disabled" (half brightness) but is not "disabled": the click still works
  assert.equal(buttonTint({ dark: true }, false), 'dim');
  assert.equal(buttonTint({ dark: true }, true), 'hover', 'hover is tested first');
  assert.equal(buttonTint({ disabled: true }, true), 'dim', 'a disabled button never gets the hover bit');
  assert.equal(buttonTint({ off: true }, false), 'off');
  assert.equal(buttonTint({ off: true }, true), 'hover', 'an "off" button is clickable, so it shows hover');
  assert.equal(buttonTint({ dark: true, off: true }, false), 'dim', '0x20 before 0x10');
  assert.equal(buttonTint({}, false), 'normal');
});

test('training page: slot 0 status texts T139 / T138 / T252 / T137 by state', {}, () => {
  const cost = [0, 2, 1, 0, 0, 0, 0, 0, 0];   // 2 wood, 1 stone
  // empty queue: T139
  assert.equal(trainingView([], 0, false, 0, 50, cost, NO_GOODS).status, 'empty');
  // queued, nobody inside: T138, slot 0 dark, even when the training had started (pupil sent out)
  let v = trainingView([11], 0, false, 0, 50, cost, NO_GOODS);
  assert.equal(v.status, 'pupil'); assert.equal(v.slots[0].dark, true);
  assert.equal(trainingView([11], 0, true, 20, 50, cost, NO_GOODS).status, 'pupil');
  // someone inside, not started, goods needed: T252 with one icon per unit of every good, dark when not in stock
  v = trainingView([11], 1, false, 0, 50, cost, [0, 1, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(v.status, 'material');
  assert.deepEqual(v.icons, [{ good: 1, dark: false }, { good: 1, dark: true }, { good: 2, dark: true }]);
  // all goods present but not yet started (until the job's next run): still T252, all icons normal
  v = trainingView([11], 1, false, 0, 50, cost, [0, 5, 5, 0, 0, 0, 0, 0, 0]);
  assert.equal(v.status, 'material');
  assert.ok(v.icons.every(i => !i.dark));
  // not started and no goods needed: T137 with 0 %
  v = trainingView([9], 1, false, 0, 50, NO_GOODS, NO_GOODS);
  assert.equal(v.status, 'training'); assert.equal(v.percent, 0);
  // started: progress x 100 / target, at least 1
  assert.equal(trainingView([11], 1, true, 0, 50, cost, NO_GOODS).percent, 1);
  assert.equal(trainingView([11], 1, true, 5, 500, cost, NO_GOODS).percent, 1);
  assert.equal(trainingView([11], 1, true, 10, 50, cost, NO_GOODS).percent, 20);
  assert.equal(trainingView([31], 1, true, 15, 100, cost, NO_GOODS).percent, 15);
});

test('depletion frame: (full - remaining) x F / full, F = frames - 1 for bushes (7.4)', {}, () => {
  // a bush (stays when empty) of 5 food with 5 frames: 0, 0, 1, 2, 3, 4 at 5..0 left
  assert.deepEqual([5, 4, 3, 2, 1, 0].map(a => lossFrame(5, a, 5, true)), [0, 0, 1, 2, 3, 4]);
  // with F = frames the frames would be 0, 1, 2, 3, 4 (clamped) at 5..1 left
  assert.deepEqual([5, 4, 3, 2, 1].map(a => lossFrame(5, a, 5, false)), [0, 1, 2, 3, 4]);
  // an empty bush always shows exactly its last frame
  assert.equal(lossFrame(5, 0, 6, true), 5);
  assert.equal(lossFrame(5, 0, 3, true), 2);
});

test('training: a queued slot stays dark until the porter has entered the school', { skip }, () => {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 0, DATA, false);
  const me = m.humanRace, t = w.economy.towns.find(x => x.race === me)!;
  // a finished school next to the town hall
  const r = w.rules.get((me << 16) | 55)!;
  let spot: [number, number] | null = null;
  for (let rad = 3; rad < 15 && !spot; rad++)
    for (let dy = -rad; dy <= rad && !spot; dy++)
      for (let dx = -rad; dx <= rad && !spot; dx++)
        if (Math.max(Math.abs(dx), Math.abs(dy)) === rad && w.logistics.canPlace(t, r, t.x + dx, t.y + dy)) spot = [t.x + dx, t.y + dy];
  if (!spot) throw new Error('no free place for the school');
  w.schedule({ type: 'build', player: me, town: t.id, building: 55, x: spot[0], y: spot[1] });
  let found: Entity | undefined;
  for (let i = 0; i < 3000 && !found?.complete; i++) { w.step(); found = w.entities.find(e => (e.oid & 0xffff) === 55 && e.owner === me); }
  if (!found?.complete) throw new Error('school not completed');
  const school: Entity = found;
  w.economy.players[me]!.money += 100;
  w.schedule({ type: 'train', player: me, building: school.id, unit: 11 });
  w.step();
  assert.equal(school.queue.length, 1);
  const view = () => trainingView(school.queue, w.logistics.occupants(school).length, !!school.trainStarted, school.trainProgress,
    w.rules.get((me << 16) | 11)!.hp, w.rules.get((me << 16) | 11)!.cost, school.local);
  assert.equal(view().slots[0].dark, true, 'dark while no porter is inside');
  assert.equal(view().status, 'pupil');
  let walking = false, entered = -1;
  for (let i = 0; i < 2000 && entered < 0; i++) {
    w.step();
    const p = w.entities.find(e => e.kind === Kind.Unit && e.town === t.id && e.entering === school.id);
    if (p && p.inside < 0) { walking = true; assert.equal(view().slots[0].dark, true, 'still dark while the porter walks there'); }
    if (w.logistics.occupants(school).length) entered = w.tick;
  }
  assert.ok(entered > 0, 'the porter entered');
  assert.ok(walking, 'the porter was seen at the door');
  assert.equal(view().slots[0].dark, false, 'normal from the moment the porter is inside');
  assert.ok(view().status !== 'pupil');
});
