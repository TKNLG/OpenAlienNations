// Advisor lines of diplomacy, from the offer to the client's voice player (needs AN_DATA).
// Spec: docs/ui/side-panel.md 1.1.3 "Diplomacy lines in detail", 1.1.2 (voice player),
// docs/game/ai-diplomacy-trade.md 3.3, 3.4.
//
// Pimmons.mdb mission 4: a human Pimmon town and a computer Amazon town, both with an active
// embassy, at ceasefire. The computer player runs (its think rewrites its acceptance flags every
// 150 ticks), so the test forces the Amazons' flags before every tick.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { Kind, type World, type WorldEvent } from '../src/engine/world.ts';
import { Rel, EMBASSY } from '../src/engine/diplomacy.ts';
import { AdvisorVoice } from '../src/client/advisor-voice.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const AMAZONS = 0, PIMMONS = 1;

function setup() {
  const { world: w } = loadMission('Pimmons.mdb', 4, DATA, true);
  const embassy = (race: number) => w.entities.find(e => e.kind === Kind.Building && e.owner === race && (e.oid & 0xffff) === EMBASSY)!;
  return { w, dip: w.diplomacy, pe: embassy(PIMMONS), ae: embassy(AMAZONS) };
}

/** run the human's offer through the command path until his diplomat is home again; all lines said meanwhile */
function offer(w: World, embassy: number, state: number, flags: { peace: boolean; ceasefire: boolean }): WorldEvent[] {
  const heard: WorldEvent[] = [];
  w.events.length = 0;
  w.schedule({ type: 'diplomacy', player: PIMMONS, action: 'offer', embassy, race: AMAZONS, state } as never);
  const diplomat = w.get(w.get(embassy)!.operatorId)!;
  let left = false;
  for (let i = 0; i < 8000; i++) {
    w.diplomacy.setAccept(AMAZONS, PIMMONS, 'peace', flags.peace);
    w.diplomacy.setAccept(AMAZONS, PIMMONS, 'ceasefire', flags.ceasefire);
    w.step();
    heard.push(...w.events.splice(0));
    if (diplomat.inside !== embassy) left = true;
    if (left && diplomat.inside === embassy && diplomat.job === 0) return heard;
  }
  throw new Error('the diplomat did not come home');
}

const diplomacyLines = (evs: WorldEvent[]) => evs.filter(e => e.mentor >= 44 && e.mentor <= 67);

test('refused peace: the sender hears mentor#44 + target once, queued; the computer target nothing', { skip }, () => {
  const { w, dip, pe } = setup();
  assert.equal(dip.relation(PIMMONS, AMAZONS), Rel.Ceasefire);
  const lines = diplomacyLines(offer(w, pe.id, Rel.Peace, { peace: false, ceasefire: true }));
  assert.deepEqual(lines.map(e => [e.race, e.mentor, e.queue]), [[PIMMONS, 44 + AMAZONS, true]]);
  assert.equal(dip.relation(PIMMONS, AMAZONS), Rel.Ceasefire, 'nothing changed');
});

test('refused ceasefire: the sender hears mentor#50 + target once', { skip }, () => {
  const { w, dip, pe } = setup();
  dip.setRelation(PIMMONS, AMAZONS, Rel.War);
  const lines = diplomacyLines(offer(w, pe.id, Rel.Ceasefire, { peace: false, ceasefire: false }));
  assert.deepEqual(lines.map(e => [e.race, e.mentor, e.queue]), [[PIMMONS, 50 + AMAZONS, true]]);
  assert.equal(dip.relation(PIMMONS, AMAZONS), Rel.War);
});

test('accepted peace and ceasefire, and war: the sender\'s line; a computer target hears nothing', { skip }, () => {
  const { w, dip, pe } = setup();
  let lines = diplomacyLines(offer(w, pe.id, Rel.Peace, { peace: true, ceasefire: true }));
  assert.deepEqual(lines.map(e => [e.race, e.mentor]), [[PIMMONS, 47 + AMAZONS]]);
  assert.equal(dip.relation(PIMMONS, AMAZONS), Rel.Peace);
  lines = diplomacyLines(offer(w, pe.id, Rel.War, { peace: true, ceasefire: true }));
  assert.deepEqual(lines.map(e => [e.race, e.mentor]), [[PIMMONS, 56 + AMAZONS]]);
  lines = diplomacyLines(offer(w, pe.id, Rel.Ceasefire, { peace: false, ceasefire: true }));
  assert.deepEqual(lines.map(e => [e.race, e.mentor]), [[PIMMONS, 53 + AMAZONS]]);
});

test('a human target hears 59/62/65 + sender for accepted offers and war, nothing for a refusal', { skip }, () => {
  const { w, dip } = setup();
  const decide = (state: number, accept: boolean) => {
    w.events.length = 0;
    dip.setAccept(PIMMONS, AMAZONS, 'peace', accept);
    dip.setAccept(PIMMONS, AMAZONS, 'ceasefire', accept);
    dip.setRelation(PIMMONS, AMAZONS, Rel.War);
    dip.decide(AMAZONS, PIMMONS, state);
    return w.events.map(e => [e.race, e.mentor]);
  };
  assert.deepEqual(decide(Rel.Peace, true), [[PIMMONS, 59 + AMAZONS]]);
  assert.deepEqual(decide(Rel.Ceasefire, true), [[PIMMONS, 62 + AMAZONS]]);
  assert.deepEqual(decide(Rel.War, false), [[PIMMONS, 65 + AMAZONS]]);
  assert.deepEqual(decide(Rel.Peace, false), [], 'refused: no receiver line (82..87 have no text)');
  assert.deepEqual(decide(Rel.Ceasefire, false), []);
});

test('contact: a new embassy is announced (68 + race) to the human, not to the computer', { skip }, () => {
  const { w, dip, pe, ae } = setup();
  w.tick = 10;
  w.events.length = 0;
  dip.embassyActivated(ae);
  assert.deepEqual(w.events.map(e => [e.race, e.mentor, e.queue]), [[PIMMONS, 68 + AMAZONS, true]]);
  w.events.length = 0;
  dip.embassyActivated(pe);
  assert.deepEqual(w.events, [], 'the Amazons are a computer player');
});

test('the refusal line reaches the voice player: spoken with its text', { skip }, () => {
  const { w, pe } = setup();
  const evs = offer(w, pe.id, Rel.Peace, { peace: false, ceasefire: true }).filter(e => e.race === PIMMONS);
  const texts: number[] = [], voices: number[] = [];
  const voice = new AdvisorVoice<number>({
    speechOn: () => true, start: id => { voices.push(id); return id; }, playing: () => false, text: id => texts.push(id),
  });
  // one frame per tick, as the client drains World.events every frame
  const byTick = new Map<number, WorldEvent[]>();
  for (const e of evs) byTick.set(e.tick, [...(byTick.get(e.tick) ?? []), e]);
  for (const list of byTick.values()) { for (const e of list) voice.speak(e.mentor, e.queue); voice.frame(); }
  assert.ok(texts.includes(44 + AMAZONS) && voices.includes(44 + AMAZONS));
});
