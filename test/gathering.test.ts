// Gatherers moving on to the next object (units-and-jobs.md 7.1, 7.1.1) and the research cost
// shown on the finance page (economy.md 4.4.1, side-panel.md 5.4). Needs AN_DATA.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { Kind, SUB, type World, type Entity } from '../src/engine/world.ts';
import { HV } from '../src/engine/logistics.ts';
import { ROUND } from '../src/engine/economy.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const STONEMASON = 27, STONE = 29, STONE_CLASS = 13;
const cell = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];

/** a free 15x15 square near the town hall with no stone within 14 rings of its centre */
function clearing(w: World, tx: number, ty: number): [number, number] {
  const stones = w.entities.filter(e => e.kind === Kind.Nature && w.rules.get(e.oid)?.cls === STONE_CLASS).map(cell);
  for (let r = 8; r < 40; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = tx + dx, y = ty + dy;
        if (stones.some(([sx, sy]) => Math.max(Math.abs(sx - x), Math.abs(sy - y)) <= 14)) continue;
        let ok = true;
        for (let j = -7; j <= 7 && ok; j++) for (let i = -7; i <= 7 && ok; i++) if (w.occupied(x + i, y + j)) ok = false;
        if (ok) return [x, y];
      }
  throw new Error('no clearing');
}

function stone(w: World, x: number, y: number, amount: number): Entity {
  const e = w.spawn({ cls: 2, group: 6, type: STONE, owner: 0, x, y, z: 0 });
  e.amount = amount;
  return e;
}

/** the harvest target of a unit (0 when it has no harvest job) */
function target(w: World, u: Entity): number {
  const j = u.job ? w.sched.get(u.job) : undefined;
  return j && j.kind === 0x16 ? j.data[HV.Target] : 0;
}

test('gatherer: a used-up stone is followed by the first stone of the spiral round it; nothing within 9 rings ends the job', { skip }, () => {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 0, DATA, false);
  const me = m.humanRace, t = w.economy.towns.find(x => x.race === me)!;
  const [x, y] = clearing(w, t.x, t.y);
  const a = stone(w, x, y, 1);
  // ring 2: (x+2, y-2) is the ring's first cell; (x, y+2) comes later in the ring although it is
  // nearer by distance (spiral order, not distance, 7.1.1)
  const b = stone(w, x + 2, y - 2, 1);
  const c = stone(w, x, y + 2, 1);
  const far = stone(w, x + 10, y, 5);   // ring 10: out of reach of the search
  const u = w.spawnUnit(me, STONEMASON, x - 3, y + 1, t.id);
  w.economy.joinTown(u, t);
  const stock0 = t.stock[2];
  w.schedule({ type: 'order', player: me, ids: [u.id], target: a.id });
  const seen: number[] = [];
  let idleAt = -1;
  for (let i = 0; i < 8000; i++) {
    w.step();
    const tg = target(w, u);
    if (tg > 0 && seen[seen.length - 1] !== tg) seen.push(tg);
    if (i > 5 && !u.job) { idleAt = w.tick; break; }
  }
  assert.deepEqual(seen, [a.id, b.id, c.id], 'A, then the first stone of the spiral round A (B), then C');
  assert.equal(t.stock[2], stock0 + 3, 'all three stones delivered');
  for (const s of [a, b, c]) assert.equal(w.get(s.id), undefined, 'used-up stones removed');
  assert.ok(idleAt > 0, 'with nothing within 9 rings the harvest ends (no retry)');
  assert.equal(far.amount, 5, 'the stone 10 rings away is not touched');
});

test('several gatherers on one stone: none stands idle while a stone in reach still has unreserved amount', { skip }, () => {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 0, DATA, false);
  const me = m.humanRace, t = w.economy.towns.find(x => x.race === me)!;
  const [x, y] = clearing(w, t.x, t.y);
  // the first stone has only three free neighbour cells: most of the masons must wait their turn
  const first = stone(w, x, y, 4);
  const others = [[1, 0], [0, 1], [-1, 0], [1, 1], [-1, -1], [3, -2], [-3, 3]].map(([dx, dy]) => stone(w, x + dx, y + dy, 2));
  const all = [first, ...others];
  const total = all.reduce((s, e) => s + e.amount, 0);
  const masons: Entity[] = [];
  for (let k = 0; k < 7; k++) { const u = w.spawnUnit(me, STONEMASON, x - 5 + k, y - 5, t.id); w.economy.joinTown(u, t); masons.push(u); }
  t.stock[2] = 0;   // room for every stone (the store is capped)
  const stock0 = t.stock[2];
  w.schedule({ type: 'order', player: me, ids: masons.map(u => u.id), target: first.id });
  const idle = new Map<number, number>();
  const unreserved = () => all.reduce((s, e) => s + (w.get(e.id) ? Math.max(0, e.amount - e.reserved) : 0), 0);
  for (let i = 0; i < 20000 && idle.size < masons.length; i++) {
    w.step();
    if (i < 5) continue;
    for (const u of masons) if (!u.job && !idle.has(u.id)) idle.set(u.id, unreserved());
  }
  assert.equal(idle.size, masons.length, 'every mason ends once the cluster is used up');
  for (const [id, left] of idle) assert.equal(left, 0, `mason ${id} went idle with ${left} unreserved stone left in reach`);
  assert.equal(t.stock[2], stock0 + total, 'every unit of every stone delivered');
  for (const s of all) assert.equal(w.get(s.id), undefined);
});

test('gatherer: a work cell reachable only diagonally between blocked cells is reached (corners are cut, 4.1)', { skip }, () => {
  // the play-test save: a stone in a patch of bushes and crops; its go-to cell (north) and its first
  // free spiral cell (east) have all four orthogonal neighbours blocked. Without corner cutting no
  // plan reached them, and the mason walked on the spot at the town hall's door for ever
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 0, DATA, false);
  const me = m.humanRace, t = w.economy.towns.find(x => x.race === me)!;
  const [x, y] = clearing(w, t.x, t.y);
  const bushType = [...w.rules].find(([oid, r]) => oid >>> 16 === 6 && r.cls === 9)![0] & 0xffff;
  for (const [dx, dy] of [[-1, -2], [0, -2], [1, -2], [2, -2], [3, -2], [-1, -1], [1, -1], [-1, 0], [2, 0], [1, 1]])
    w.spawn({ cls: 2, group: 6, type: bushType, owner: 0, x: x + dx, y: y + dy, z: 0 });
  const s = stone(w, x, y, 3);
  const m1 = w.size - 1, blocked = (cx: number, cy: number) => w.blocked[(((cy & m1) << w.bits) | (cx & m1))] !== 0;
  for (const [cx, cy] of [[x, y - 1], [x + 1, y]]) {
    assert.ok(!blocked(cx, cy), 'the work cell itself is free');
    assert.ok(blocked(cx, cy - 1) && blocked(cx - 1, cy) && blocked(cx, cy + 1) && blocked(cx + 1, cy), 'all four orthogonal neighbours blocked');
  }
  assert.deepEqual(w.goalCell(x, y), [x & m1, (y - 1) & m1], 'the go-to cell is the enclosed north neighbour');
  const u = w.spawnUnit(me, STONEMASON, x - 6, y + 2, t.id);
  w.economy.joinTown(u, t);
  t.stock[2] = 0;
  w.schedule({ type: 'order', player: me, ids: [u.id], target: s.id });
  let workedAt = -1;
  for (let i = 0; i < 3000 && workedAt < 0; i++) {
    w.step();
    if (s.amount < 3) workedAt = w.tick;
  }
  assert.ok(workedAt > 0, `the mason works the stone (he stands at ${cell(u)}, stone at ${x},${y})`);
  const [ux, uy] = cell(u);
  assert.ok(Math.abs(ux - x) <= 1 && Math.abs(uy - y) <= 1, 'from a cell next to it');
});

test('finance page: research spending counts only while a project runs; the charge ends with the research', { skip }, () => {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 0, DATA, false);
  const me = m.humanRace, eco = w.economy, t = eco.towns.find(x => x.race === me)!, p = eco.players[me]!;
  t.motivationPct = 0; t.researchPct = 50;
  const inv = p.costs.findIndex((c, i) => c > 0 && !eco.researched(p, i));
  assert.ok(inv >= 0);

  // before: the slider amount is shown in parentheses, the value and the balance leave it out
  let f = eco.financeView(t);
  assert.ok(f.research > 0);
  assert.equal(f.researchSpent, false);
  // during
  eco.selectResearch(t, inv);
  f = eco.financeView(t);
  assert.equal(f.researchSpent, true);
  // stopped (finishing clears the project the same way)
  eco.selectResearch(t, -1);
  f = eco.financeView(t);
  assert.equal(f.researchSpent, false, 'no project: research is not a cost any more');

  // money: steps already done this round are charged once at the next settlement, then nothing
  p.money = 100000;
  t.researchAcc = 2.5;
  let m0 = p.money;
  for (let i = 0; i <= ROUND && t.researchAcc !== 0; i++) { m0 = p.money; w.step(); }
  assert.equal(t.researchAcc, 0, 'the settlement clears the accumulator');
  assert.equal(p.money - m0, t.income - 10 - t.overheads, 'the accumulated steps (4 x 2.5) are charged');
  m0 = p.money;
  for (let i = 0; i < ROUND; i++) w.step();   // exactly one more settlement
  assert.equal(p.money - m0, t.income - t.overheads, 'no project: no research charge');
});
