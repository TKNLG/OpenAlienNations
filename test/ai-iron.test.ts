// The computer player's wood-to-iron conversion (docs/game/ai-diplomacy-trade.md 1.8 "Free
// goods"). A play-tester saw a computer town without an iron mine offer ~70 iron at its market;
// this conversion is the source (original behaviour, `0046e6b0`): every 150 ticks, with chance
// 9/10, +1 iron and -2 wood while the iron space is > 5, wood >= 2 and the woodcutter gang is not
// empty, so the iron stock climbs to capacity - 5 (70 at capacity 75) and stops there.
// Needs AN_DATA.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { Kind } from '../src/engine/world.ts';
import { runEconomy } from '../src/engine/ai-town.ts';
import { Grp, U } from '../src/engine/ai-defs.ts';
import type { Ai } from '../src/engine/ai.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const WOOD = 1, IRON = 3;

test('AI wood-to-iron conversion: +1 iron / -2 wood per phase-0 run, up to capacity - 5, only with a woodcutter gang (1.8)', { skip }, () => {
  const { world: w } = loadMission('Pimmons.mdb', 4);
  const ai = (w as unknown as { ai: Ai }).ai;
  for (let i = 0; i < 40; i++) w.step();
  const t = w.economy.towns.find(t => w.economy.players[t.race]!.computer && ai.town(t.id)?.economy)!;
  assert.ok(t, 'a computer town with its economy job');
  const job = w.sched.get(ai.town(t.id)!.economy)!;
  // one woodcutter of the town in the economy gang (group 51)
  let cutter = w.entities.find(e => e.kind === Kind.Unit && e.alive && e.town === t.id && (e.oid & 0xffff) === U.Woodcutter);
  if (!cutter) {
    cutter = w.entities.find(e => e.kind === Kind.Unit && e.alive && e.town === t.id && e.owner === t.race)!;
    cutter.oid = ((t.race << 16) | U.Woodcutter) >>> 0;
  }
  for (const e of w.entities) if (e.kind === Kind.Unit && e.town === t.id && (e.oid & 0xffff) === U.Woodcutter) e.group = Grp.None;
  cutter.group = Grp.Economy;

  const phase0 = () => { job.data[0] = 0; runEconomy(ai, job); };
  const cap = t.capacity;
  assert.ok(cap >= 20);
  t.stock[IRON] = cap - 9;
  t.stock[WOOD] = 30;
  let gains = 0;
  for (let i = 0; i < 40; i++) {
    const iron = t.stock[IRON], wood = t.stock[WOOD];
    phase0();
    if (t.stock[IRON] !== iron) {
      gains++;
      assert.equal(t.stock[IRON], iron + 1, 'one iron per run');
      assert.equal(t.stock[WOOD], wood - 2, 'paid with two wood');
    } else assert.equal(t.stock[WOOD], wood, 'no wood taken without a conversion');
  }
  assert.equal(gains, 4, 'stops when the iron space is no longer > 5');
  assert.equal(t.stock[IRON], cap - 5);

  // wood below 2: nothing
  t.stock[IRON] = 0; t.stock[WOOD] = 1;
  for (let i = 0; i < 20; i++) phase0();
  assert.equal(t.stock[IRON], 0);
  // empty woodcutter gang: nothing, even with wood in stock
  cutter.group = Grp.None;
  t.stock[WOOD] = 30;
  for (let i = 0; i < 20; i++) phase0();
  assert.equal(t.stock[IRON], 0);
  assert.equal(t.stock[WOOD], 30);
});
