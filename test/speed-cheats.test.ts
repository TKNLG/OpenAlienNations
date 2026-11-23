// Game speed (docs/game/economy.md 1.2) and the cheat words (docs/game/fog-of-war.md 8) as world
// commands: speeds 100 / 50 / 25, only the host's in a network game, not part of the state hash;
// cheats only in single player, for the human player, goods into the current town. Needs AN_DATA.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { World } from '../src/engine/world.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const WOOD = 1, FOOD = 4, CROP = 0;
const W = { CASHCOW: 0, RAIN: 1, LUMBERJACK: 2, IAMHUNGRY: 5, LOLLY: 9, WINNER: 11 } as const;

function game() {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 0, DATA, true);
  const me = m.humanRace, t = w.economy.towns.find(x => x.race === me && x.alive)!;
  return { w, me, t };
}
const run = (w: World, cmd: Parameters<World['schedule']>[0]) => { w.schedule(cmd, w.tick + 1); w.step(); };

test('speed: 100 / 50 / 25 only; a network game takes only the host\'s command; the hash ignores it', { skip }, () => {
  const { w, me } = game();
  const { w: b } = game();
  assert.equal(w.speed, 100);
  run(w, { type: 'speed', player: me, setting: 50 });
  b.step();
  assert.equal(w.speed, 50);
  assert.equal(w.hash(), b.hash(), 'the speed is not simulation state');
  run(w, { type: 'speed', player: me, setting: 33 });
  assert.equal(w.speed, 50, 'not one of the three settings');
  run(w, { type: 'speed', player: me, setting: 25 });
  assert.equal(w.speed, 25);
  // network: the host is another race
  w.netHost = (me + 1) % 3;
  run(w, { type: 'speed', player: me, setting: 100 });
  assert.equal(w.speed, 25, 'a guest cannot change the speed');
  run(w, { type: 'speed', player: w.netHost, setting: 100 });
  assert.equal(w.speed, 100, 'the host can');
  // not saved: a loaded game starts at normal speed
  run(w, { type: 'speed', player: w.netHost, setting: 50 });
  assert.equal(World.restore(w.terrain, w.snapshot(), w.rules, w.weapons).speed, 100);
});

test('cheats: CASHCOW + 5000, goods + 50 into the current town (capped, food counted), WINNER wins', { skip }, () => {
  const { w, me, t } = game();
  const p = w.economy.players[me]!;
  const money = p.money;
  run(w, { type: 'cheat', player: me, word: W.CASHCOW, town: t.id });
  assert.equal(p.money, money + 5000);
  t.stock[WOOD] = 0;
  run(w, { type: 'cheat', player: me, word: W.LUMBERJACK, town: t.id });
  assert.equal(t.stock[WOOD], Math.min(50, t.capacity));
  t.stock[WOOD] = t.capacity - 3;
  run(w, { type: 'cheat', player: me, word: W.LUMBERJACK, town: t.id });
  assert.equal(t.stock[WOOD], t.capacity, 'capped at the capacity');
  t.stock[FOOD] = 0;
  const fed = t.foodNow;
  run(w, { type: 'cheat', player: me, word: W.IAMHUNGRY, town: t.id });
  assert.equal(t.stock[FOOD], Math.min(50, t.capacity));
  assert.equal(t.foodNow - fed, 50, 'counted as food produced this round');
  const lolly = t.stock[8];
  run(w, { type: 'cheat', player: me, word: W.LOLLY, town: t.id });
  assert.equal(t.stock[8], Math.min(lolly + 50, t.capacity));
  assert.equal(p.outcome, 0);
  run(w, { type: 'cheat', player: me, word: W.WINNER, town: t.id });
  assert.equal(p.outcome, 1, 'won');
});

test('cheats: RAIN goes through the crop conversion like a delivery', { skip }, () => {
  const { w, me, t } = game();
  t.stock[CROP] = 0; t.stock[FOOD] = 0;
  w.economy.setCropRing(t, 50);   // every second crop unit is converted
  run(w, { type: 'cheat', player: me, word: W.RAIN, town: t.id });
  assert.ok(t.stock[FOOD] > 0, 'part of the crop became food');
  assert.ok(t.stock[CROP] < 50, 'the rest went to the crop stock');
});

test('cheats: nothing in a network game, for a computer player or into a foreign town', { skip }, () => {
  const { w, me, t } = game();
  const p = w.economy.players[me]!;
  const money = p.money;
  const ai = w.economy.players.find(x => x && x.computer);
  if (ai) {
    const am = ai.money;
    run(w, { type: 'cheat', player: ai.race, word: W.CASHCOW, town: -1 });
    assert.equal(ai.money, am, 'not for a computer player');
    const foreign = w.economy.towns.find(x => x.race === ai.race && x.alive);
    if (foreign) {
      const wood = t.stock[WOOD];
      run(w, { type: 'cheat', player: me, word: W.LUMBERJACK, town: foreign.id });
      assert.equal(t.stock[WOOD], wood);
    }
  }
  w.netHost = me;
  run(w, { type: 'cheat', player: me, word: W.CASHCOW, town: t.id });
  assert.equal(p.money, money, 'no cheats in a network game, not even for the host');
});
