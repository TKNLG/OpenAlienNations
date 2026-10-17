// Which goods the market can trade, and the trade route page's lists (needs AN_DATA).
// Spec: docs/game/ai-diplomacy-trade.md 4.2 (good 0 is never traded), 4.6 (computer markets
// write goods 1..8), docs/ui/side-panel.md 5.5 (market pages list goods 1..8; trade route page:
// per-race town lists and race tabs, no good buttons).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { Trade, MF, GOODS } from '../src/engine/trade.ts';
import { Rel } from '../src/engine/diplomacy.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const AMAZONS = 0, PIMMONS = 1;

function mission4() {
  const { world: w } = loadMission('Pimmons.mdb', 4, DATA, false);
  const town = (race: number) => w.economy.towns.find(t => t.race === race)!;
  return { w, trade: w.trade, pim: town(PIMMONS), ama: town(AMAZONS) };
}

test('good 0 (raw material / crop) cannot be enabled by a command; goods 1..8 can', { skip }, () => {
  const { w, pim } = mission4();
  for (const field of ['sell', 'buy'] as const) {
    w.schedule({ type: 'market', player: PIMMONS, town: pim.id, good: 0, field, value: 1 } as never);
  }
  w.schedule({ type: 'market', player: PIMMONS, town: pim.id, good: 4, field: 'sell', value: 1 } as never);
  w.schedule({ type: 'market', player: PIMMONS, town: pim.id, good: 9, field: 'sell', value: 1 } as never);
  w.step(); w.step();
  assert.equal(w.trade.get(pim.id, 0, MF.Sell), 0, 'raw material: sale stays off');
  assert.equal(w.trade.get(pim.id, 0, MF.Buy), 0, 'raw material: purchase stays off');
  assert.equal(w.trade.get(pim.id, 4, MF.Sell), 1, 'food can be enabled');
});

test('computer market settings never touch good 0', { skip }, () => {
  const { w, ama } = mission4();
  for (let i = 0; i < 3; i++) {
    w.trade.computerSettings(ama);
    ama.stock[0] = 200;   // plenty of crop: still never offered
  }
  assert.equal(w.trade.get(ama.id, 0, MF.Sell), 0);
  assert.equal(w.trade.get(ama.id, 0, MF.Buy), 0);
  let any = false;
  for (let g = 1; g < GOODS; g++) any ||= w.trade.get(ama.id, g, MF.Sell) !== 0 || w.trade.get(ama.id, g, MF.Buy) !== 0;
  assert.ok(any, 'goods 1..8 are set');
});

test('a save holding good-0 flags (older panel) has them cleared on load', { skip }, () => {
  const { w, pim } = mission4();
  w.trade.set(pim.id, 0, MF.Sell, 1);
  w.trade.set(pim.id, 0, MF.Buy, 1);
  w.trade.set(pim.id, 4, MF.Sell, 1);
  const copy = new Trade(w);
  copy.restore(JSON.parse(JSON.stringify(w.trade.snapshot())));
  assert.equal(copy.get(pim.id, 0, MF.Sell), 0);
  assert.equal(copy.get(pim.id, 0, MF.Buy), 0);
  assert.equal(copy.get(pim.id, 4, MF.Sell), 1, 'other goods are kept');
});

test('trade route page lists: own towns (own town included), foreign races only at peace', { skip }, () => {
  const { w, pim, ama } = mission4();
  const lists = w.trade.partnerLists(PIMMONS);
  assert.deepEqual(lists[PIMMONS].map(t => t.id), [pim.id], 'the own market town is listed (no exclusion)');
  assert.equal(lists[AMAZONS].length, 0, 'ceasefire: no Amazon towns');
  w.diplomacy.setRelation(PIMMONS, AMAZONS, Rel.Peace);
  const atPeace = w.trade.partnerLists(PIMMONS);
  assert.deepEqual(atPeace[AMAZONS].map(t => t.id), [ama.id]);
  assert.equal(atPeace[2].length, 0);
});
