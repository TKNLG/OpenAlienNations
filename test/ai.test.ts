// Computer players on real missions (needs AN_DATA = the game's Data folder).
// Spec: docs/game/ai-diplomacy-trade.md sections 1, 2, 3.5, 4.6; integration-ai.md.
//
// Pimmons.mdb mission 4 has a human Pimmon town and two computer towns: Amazons (random
// profile) with a developed town, and Sajiki (profile 3) with only a town hall and nothing
// researched. Until the World creates and dispatches the AI itself, the test attaches an `Ai`
// and routes its job kinds to it (like trade.test.ts does for trade and diplomacy).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { loadMission, setupOf, DATA } from './helpers/mission.ts';
import { Kind, World } from '../src/engine/world.ts';
import { parseIdb } from '../src/formats/idb.ts';
import { parseMdb, type Mission } from '../src/formats/mission.ts';
import { parseOs } from '../src/formats/os.ts';
import { parseOdb } from '../src/formats/odb.ts';
import { generateTerrain, CLASS_TILESET } from '../src/world/terrain.ts';
import { generateWorld } from '../src/world/populate.ts';
import { Ai, isAiJob, aiConfig, ring, PROFILES, type AiSnapshot } from '../src/engine/ai.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const AMAZONS = 0, PIMMONS = 1, SAJIKI = 2;

const prerequisites = () => ['AMAZONS', 'PIMONS', 'SAJIKI'].map(d => parseIdb(readFileSync(`${DATA}/${d}/DV.idb`)).map(i => i.prerequisites));

/** the world's own AI once integrated, otherwise a new one with a job-dispatch shim */
function attach(w: World, m: Mission | null, start = true): Ai {
  const host = w as unknown as { ai?: Ai };
  if (host.ai) return host.ai;
  const ai = new Ai(w);
  const eco = w.economy, run = eco.runJob.bind(eco);
  eco.runJob = job => (isAiJob(job.kind) ? ai.runJob(job) : run(job));
  if (start && m) ai.start(aiConfig(m.races, prerequisites()));
  return ai;
}

/** world hash plus the AI state (the integrated World.hash() includes ai.digest itself) */
function fullHash(w: World, ai: Ai): string {
  const host = w as unknown as { ai?: Ai };
  const out: number[] = [w.hash()];
  if (!host.ai) ai.digest(v => out.push(v));
  return out.join(',');
}

interface TownStats { pop: number; buildings: number; specialists: number; researched: number }
function stats(w: World, race: number): TownStats {
  const p = w.economy.players[race]!;
  let buildings = 0, specialists = 0;
  for (const e of w.entities) {
    if (e.owner !== race) continue;
    if (e.kind === Kind.Building && e.complete) buildings++;
    if (e.kind === Kind.Unit && (e.oid & 0xffff) !== 9 && (e.oid & 0xffff) !== 12) specialists++;
  }
  const pop = p.towns.reduce((s, id) => s + (w.economy.towns[id].alive ? w.economy.towns[id].population : 0), 0);
  return { pop, buildings, specialists, researched: p.progress.filter((v, i) => v >= p.costs[i]).length };
}

test('ring walk order (1.5 step 5)', {}, () => {
  assert.deepEqual(ring(0, 0, 0), [[0, 0]]);
  // starts at (+k, -k), then +y, -x, -y, +x
  assert.deepEqual(ring(0, 0, 1), [[1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1]]);
  assert.equal(new Set(ring(5, 5, 3).map(p => p.join())).size, 24);
  assert.equal(PROFILES.length, 6);
});

test('setup: profiles, think and town jobs, diplomacy flags (1.1, 1.2, 3.5)', { skip }, () => {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 4);
  const ai = attach(w, m);
  assert.equal(ai.players[PIMMONS], null, 'the human has no AI');
  assert.equal(ai.players[SAJIKI]!.profile, 3, 'race block +0x08 = 4: profile 3');
  assert.ok(ai.players[AMAZONS]!.profile >= 0 && ai.players[AMAZONS]!.profile <= 2, 'random profile 0..2');
  for (const t of w.economy.towns) {
    const s = ai.town(t.id);
    if (t.race === PIMMONS) { assert.equal(s, null); continue; }
    assert.ok(s && s.planner && s.economy && s.military, 'three town jobs');
  }
  // strength (2.1): 500 + weapon maxima; nobody is armed yet except map soldiers/hunters
  assert.ok(ai.strength(SAJIKI) >= 500);
  for (let i = 0; i < 160; i++) w.step();
  // after the first think the computer's acceptance flags follow its desired state
  const dip = w.diplomacy;
  for (const me of [AMAZONS, SAJIKI]) {
    for (const other of [0, 1, 2]) {
      if (other === me) continue;
      const peace = dip.acceptPeace[me][other], cease = dip.acceptCeasefire[me][other];
      assert.ok(peace <= cease, 'accepting peace implies accepting a ceasefire');
    }
  }
  // AI towns: motivation 0 (1.9)
  for (const t of w.economy.towns) if (t.race !== PIMMONS) assert.equal(t.motivationPct, 0);
});

test('computer towns grow: buildings, population, training, research; deterministic and cheap', { skip }, () => {
  const TICKS = 25000;
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 4);
  const ai = attach(w, m);
  const before = [AMAZONS, SAJIKI].map(r => stats(w, r));
  const towns0 = w.economy.towns.length;
  const t0 = performance.now();
  // peak values: since the assault attacks the important town hall (2.5), a raided town can fall
  // within the run (the Amazon AI, at war with the human from about tick 9,700, raids the Sajiki)
  const after = [AMAZONS, SAJIKI].map(r => stats(w, r));
  const peak = () => [AMAZONS, SAJIKI].forEach((r, k) => {
    const s = stats(w, r) as unknown as Record<string, number>, a = after[k] as unknown as Record<string, number>;
    for (const key of Object.keys(s)) a[key] = Math.max(a[key], s[key]);
  });
  for (let i = 0; i < TICKS; i++) { w.step(); if (i % 500 === 499) peak(); }
  const ms = (performance.now() - t0) / TICKS;
  // towns founded by a computer founder (1.12): finished town hall, its own AI jobs, people
  const founded = w.economy.towns.slice(towns0);
  // towns whose town hall is active now; one activated later may still wait for the think job
  const active = founded.filter(t => w.get(t.hall)?.active);
  for (let i = 0; i < 151; i++) w.step();   // the think job starts a new town's AI jobs within 150 ticks
  console.log(`  founded towns: ${founded.map(t => `race ${t.race} pop ${t.population}`).join(', ') || 'none'}`);
  for (const t of active) {
    const hall = w.get(t.hall);
    if (!hall?.active) continue;   // destroyed meanwhile
    assert.ok(hall.active && t.population > 0 && ai.town(t.id)?.planner, 'a founded town works like any computer town');
  }
  console.log(`Pimmons 4, ${TICKS} ticks: ${ms.toFixed(3)} ms/tick (whole simulation); profiles ${ai.players.map(p => p?.profile)}`);
  console.log('  before', JSON.stringify(before));
  console.log('  peak  ', JSON.stringify(after));
  for (let k = 0; k < 2; k++) {
    const race = ['Amazons', 'Sajiki'][k];
    assert.ok(after[k].buildings > before[k].buildings + 3, `${race} build`);
    assert.ok(after[k].pop > before[k].pop + 5, `${race} grow`);
    assert.ok(after[k].specialists > before[k].specialists + 2, `${race} train units`);
    assert.ok(after[k].researched > before[k].researched + 2, `${race} research`);
  }
  assert.ok(ms < 1.5, 'the AI keeps the simulation fast');
});

test('determinism: same run twice, and snapshot/restore mid-run', { skip }, () => {
  const run = (n: number) => {
    const { world: w, mission: m } = loadMission('Pimmons.mdb', 4);
    const ai = attach(w, m);
    for (let i = 0; i < n; i++) w.step();
    return { w, ai, m };
  };
  const a = run(6000), b = run(6000);
  assert.equal(fullHash(a.w, a.ai), fullHash(b.w, b.ai));
  // save at 6000, continue both to 9000
  const snap = JSON.parse(JSON.stringify(a.w.snapshot()));
  const aiSnap = JSON.parse(JSON.stringify(a.ai.snapshot())) as AiSnapshot;
  // the restored world needs its own terrain arrays (foundations and worn paths edit the ground)
  const t = a.w.terrain;
  const c = World.restore({ ...t, height: t.height.slice(), cls: t.cls.slice(), tile: t.tile.slice() }, snap, a.w.rules, a.w.weapons);
  const cai = attach(c, null, false);
  if (!(c as unknown as { ai?: Ai }).ai) cai.restore(aiSnap);
  assert.equal(fullHash(c, cai), fullHash(a.w, a.ai), 'restored state hashes the same');
  for (let i = 0; i < 3000; i++) { a.w.step(); c.step(); }
  assert.equal(fullHash(c, cai), fullHash(a.w, a.ai), 'continues identically');
  assert.ok(a.ai.towns.some(s => s && (s.build.length || s.train.length || s.A.some(v => v))), 'AI state is in use');
});

test('free play 512x512: two computer opponents build up', { skip }, () => {
  const m = parseMdb(readFileSync(`${DATA}/Infinite.mdb`))[1];
  const pick = CLASS_TILESET.map(name => parseOs(readFileSync(`${DATA}/${name}.os`)).pick);
  const gen = generateWorld(4321, 9, (s, b) => generateTerrain(s, b, pick), {
    resources: 1, players: m.races.filter(r => r.present).map(r => ({ race: r.race, computer: r.computer })), humanTownHall: true,
  });
  const rules = parseOdb(readFileSync(`${DATA}/dv.odb`));
  const w = new World(gen.terrain, gen.result.objects, rules, { ...setupOf(m), orders: [], lists: gen.result.lists });
  const ai = attach(w, m);
  // peaceful builders, so the test measures the economy (profiles 0/1 also attack the other AI, 2.4 notes)
  for (const p of ai.players) if (p) p.profile = 4;
  const before = [AMAZONS, SAJIKI].map(r => stats(w, r));
  const TICKS = 20000;
  const t0 = performance.now();
  // peak values: since the assault attacks the important town hall (2.5), a raided town can fall
  // within the run (the Amazon AI, at war with the human from about tick 9,700, raids the Sajiki)
  const after = [AMAZONS, SAJIKI].map(r => stats(w, r));
  const peak = () => [AMAZONS, SAJIKI].forEach((r, k) => {
    const s = stats(w, r) as unknown as Record<string, number>, a = after[k] as unknown as Record<string, number>;
    for (const key of Object.keys(s)) a[key] = Math.max(a[key], s[key]);
  });
  for (let i = 0; i < TICKS; i++) { w.step(); if (i % 500 === 499) peak(); }
  const ms = (performance.now() - t0) / TICKS;
  console.log(`free play 512x512, ${TICKS} ticks: ${ms.toFixed(3)} ms/tick; before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
  for (let k = 0; k < 2; k++) {
    assert.ok(after[k].buildings > before[k].buildings + 1, 'builds');
    assert.ok(after[k].researched > before[k].researched, 'researches');
  }
  assert.ok(after.some((s, k) => s.pop > before[k].pop + 10), 'a town grows');
  assert.ok(ms < 1.5);
});
