// Diplomacy across water (Gold Edition island maps): the target embassy is chosen on the sending
// embassy's island only; when the target race's embassies are all on other islands, the offer is
// decided as soon as the diplomat is out of his door, and he goes straight back in.
// Spec: docs/game/addon.md 9.3; docs/game/ai-diplomacy-trade.md 3.3..3.5.
// Needs the Gold Edition data folder: AN_GOLD (AmazonsAO 4: human Amazons with an active embassy
// on one island, the computer Sajiki on another).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HAS_GOLD, GOLD, loadAddonMission } from './helpers/mission.ts';
import { SUB, type Entity, type World } from '../src/engine/world.ts';
import type { Town } from '../src/engine/economy.ts';
import { Rel, EMBASSY, DIPLOMAT } from '../src/engine/diplomacy.ts';

const skip = !HAS_GOLD && 'AN_GOLD data not found';
const AMAZONS = 0, SAJIKI = 2;
/** advisor lines (Mentor.tdb): sender side + target race, receiver side + sender race */
const PEACE_REFUSED = 44, PEACE_ACCEPTED = 47, GOT_PEACE = 59, GOT_CEASEFIRE = 62;

const cell = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
const until = (w: World, cond: () => boolean, max: number, what: string) => {
  for (let i = 0; i < max; i++) { if (cond()) return i; w.step(); }
  assert.ok(cond(), `timed out: ${what}`);
  return max;
};

/** a completed embassy of the town on free land of the town's island near its hall */
function placeEmbassy(w: World, t: Town): Entity {
  const r = w.rules.get(((t.race << 16) | EMBASSY) >>> 0)!;
  const sx = Math.max(1, r.sizeX), sy = Math.max(1, r.sizeY);
  const isl = w.islandAt(t.x, t.y);
  const free = (x: number, y: number) => {
    for (let dy = -2; dy <= sy + 1; dy++) for (let dx = -2; dx <= sx + 1; dx++) {
      const cx = x - sx + 1 + dx, cy = y - sy + 1 + dy;
      if (w.occupied(cx, cy) || w.islandAt(cx, cy) !== isl) return false;
    }
    return true;
  };
  for (let rad = 4; rad < 30; rad++)
    for (let dy = -rad; dy <= rad; dy++)
      for (let dx = -rad; dx <= rad; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad || !free(t.x + dx, t.y + dy)) continue;
        const b = w.spawn({ cls: 1, group: t.race, type: EMBASSY, owner: t.mapId, x: t.x + dx, y: t.y + dy, z: 0 });
        b.town = t.id; b.complete = true; b.hp = r.hp;
        return b;
      }
  throw new Error('no free place');
}

/** AmazonsAO 4 with a staffed Sajiki embassy added on the Sajiki island */
function world() {
  const { world: w } = loadAddonMission('AmazonsAO.mdb', 4, GOLD, false);
  const amEmb = w.entities.find(e => e.kind === 1 && e.owner === AMAZONS && (e.oid & 0xffff) === EMBASSY)!;
  assert.ok(amEmb.active, 'the Amazons start with an active embassy');
  const sajTown = w.economy.towns.find(t => t.race === SAJIKI && t.alive)!;
  for (let i = 0; i < 40; i++) w.step();
  const sjEmb = placeEmbassy(w, sajTown);
  const dip = w.spawnInside(SAJIKI, DIPLOMAT, sjEmb, sajTown.id);
  w.logistics.unitEntered(dip, sjEmb);
  assert.ok(sjEmb.active, 'the Sajiki embassy is active with its diplomat inside');
  assert.notEqual(w.islandAt(...cell(amEmb)), w.islandAt(...cell(sjEmb)), 'the embassies are on different islands');
  return { w, amEmb, sjEmb, amDip: w.get(amEmb.operatorId)!, sjDip: dip };
}

const heard = (w: World, race: number, mentor: number, since: number) =>
  w.events.some(e => e.race === race && e.mentor === mentor && e.tick >= since);

test('island diplomacy: contact across water gives war', { skip }, () => {
  const { w } = world();
  assert.equal(w.diplomacy.relation(AMAZONS, SAJIKI), Rel.War);
});

test('island diplomacy: a human peace offer across water is decided as the diplomat steps out; he goes back in', { skip }, () => {
  const { w, amEmb, amDip } = world();
  const isl = w.islandAt(...cell(amEmb));
  const t0 = w.tick;
  assert.equal(w.diplomacy.offer(amEmb, SAJIKI, Rel.Peace), true);
  assert.equal(w.diplomacy.errand(AMAZONS)?.decided, false, 'pending while he is still at the door');
  let out = false, maxDist = 0;
  const ticks = until(w, () => {
    if (amDip.inside < 0) {
      out = true;
      const [x, y] = cell(amDip), [hx, hy] = cell(amEmb);
      assert.equal(w.islandAt(x, y), isl, 'never leaves his island');
      maxDist = Math.max(maxDist, w.logistics.dist(x, y, hx, hy));
    }
    return out && amDip.inside === amEmb.id && !amDip.job;
  }, 600, 'diplomat back inside');
  assert.ok(out, 'he stepped out');
  assert.ok(maxDist <= 6, `only a short step outside (max distance ${maxDist})`);
  assert.ok(ticks < 300, `back in quickly (${ticks} ticks)`);
  assert.equal(w.diplomacy.relation(AMAZONS, SAJIKI), Rel.Peace, 'the computer accepted (flags default to accept)');
  assert.ok(heard(w, AMAZONS, PEACE_ACCEPTED + SAJIKI, t0), 'sender line: peace accepted by the Sajiki');
  assert.equal(amEmb.active, true, 'the embassy stays active');
  assert.equal(amEmb.operatorId, amDip.id);
  assert.ok(amEmb.opJob, 'its operator job restarts');
  assert.equal(w.diplomacy.errand(AMAZONS), null);
});

test('island diplomacy: the decision falls the moment he is outside, before he walks back', { skip }, () => {
  const { w, amEmb, amDip } = world();
  w.diplomacy.offer(amEmb, SAJIKI, Rel.Peace);
  until(w, () => amDip.inside < 0, 200, 'out of his door');
  const [x0, y0] = cell(amDip);
  // the errand waits behind the leave job (blocked 5 ticks), then decides on its first run
  until(w, () => w.diplomacy.relation(AMAZONS, SAJIKI) === Rel.Peace, 10, 'decided');
  const [x1, y1] = cell(amDip);
  assert.ok(w.logistics.dist(x0, y0, x1, y1) <= 1, 'still at his door');
  assert.equal(w.diplomacy.errand(AMAZONS)?.decided, true);
});

test('island diplomacy: computer offers across water reach the human; refusals follow his check boxes', { skip }, () => {
  const { w, amEmb, sjEmb, sjDip } = world();
  // peace first (human offer), then the Sajiki offer a ceasefire: a downgrade from peace is always accepted
  w.diplomacy.offer(amEmb, SAJIKI, Rel.Peace);
  until(w, () => w.diplomacy.relation(AMAZONS, SAJIKI) === Rel.Peace, 300, 'peace');
  let t0 = w.tick;
  assert.equal(w.diplomacy.offer(sjEmb, AMAZONS, Rel.Ceasefire), true);
  until(w, () => sjDip.inside === sjEmb.id && !sjDip.job && w.tick > t0 + 5, 600, 'Sajiki diplomat back inside');
  assert.equal(w.diplomacy.relation(AMAZONS, SAJIKI), Rel.Ceasefire);
  assert.ok(heard(w, AMAZONS, GOT_CEASEFIRE + SAJIKI, t0), 'receiver line for the human');
  assert.equal(sjEmb.active, true);
  // the human unticks "accept peace from the Sajiki": their peace offer is refused, silently for him
  w.schedule({ type: 'diplomacy', player: AMAZONS, action: 'accept', race: SAJIKI, kind: 'peace', value: false });
  w.step();
  t0 = w.tick;
  w.diplomacy.offer(sjEmb, AMAZONS, Rel.Peace);
  until(w, () => sjDip.inside === sjEmb.id && !sjDip.job && w.tick > t0 + 5, 600, 'back inside');
  assert.equal(w.diplomacy.relation(AMAZONS, SAJIKI), Rel.Ceasefire, 'refused: unchanged');
  assert.ok(!heard(w, AMAZONS, GOT_PEACE + SAJIKI, t0), 'no receiver line');
  // and the human's own peace offer to the Sajiki follows the Sajiki flags
  w.diplomacy.setAccept(SAJIKI, AMAZONS, 'peace', false);
  t0 = w.tick;
  w.diplomacy.offer(amEmb, SAJIKI, Rel.Peace);
  until(w, () => w.events.some(e => e.tick >= t0 && e.race === AMAZONS && e.mentor === PEACE_REFUSED + SAJIKI), 300, 'refusal line');
  assert.equal(w.diplomacy.relation(AMAZONS, SAJIKI), Rel.Ceasefire);
});

test('island diplomacy: a target embassy on the same island is walked to and entered (base rule)', { skip }, () => {
  // PimmonsAO 0: the human Pimmons and the computer Sajiki share island 5
  const { world: w } = loadAddonMission('PimmonsAO.mdb', 0, GOLD, false);
  for (let i = 0; i < 40; i++) w.step();
  const staffed = (race: number) => {
    const t = w.economy.towns.find(x => x.race === race && x.alive)!;
    const b = placeEmbassy(w, t);
    const d = w.spawnInside(race, DIPLOMAT, b, t.id);
    w.logistics.unitEntered(d, b);
    return { b, d };
  };
  const pm = staffed(1), sj = staffed(SAJIKI);
  // fighting on this map turns peace back into war at the next impact (combat.md 11): watch the changes
  const changes: [number, number][] = [];
  w.onRelation = (_a, _b, st) => changes.push([w.tick, st]);
  assert.equal(w.islandAt(...cell(pm.b)), w.islandAt(...cell(sj.b)));
  assert.equal(w.diplomacy.relation(1, SAJIKI), Rel.War, 'contact');
  w.diplomacy.offer(pm.b, SAJIKI, Rel.Peace);
  let far = 0;
  until(w, () => {
    far = Math.max(far, w.logistics.dist(...cell(pm.d), ...cell(pm.b)));
    return pm.d.inside === sj.b.id;
  }, 6000, 'inside the Sajiki embassy');
  assert.ok(far > 10, 'he walked over');
  assert.deepEqual(changes, [], 'not decided before he is inside');
  until(w, () => changes.length > 0, 20, 'decided inside');
  assert.equal(changes[0][1], Rel.Peace);
  assert.equal(pm.d.inside, sj.b.id);
  until(w, () => pm.d.inside === pm.b.id && !pm.d.job, 6000, 'back home');
  assert.equal(pm.b.active, true);
});
