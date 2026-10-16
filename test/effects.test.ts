// Display effects: the death sound plays with the death effect's first frame (combat.md 6
// "When the death sound plays", docs/rendering/projectiles.md 5).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Effects } from '../src/client/effects.ts';
import type { GameData } from '../src/client/data.ts';
import type { World } from '../src/engine/world.ts';

const G7 = 7 << 16;
const rule = (type: number, sound: number, soundAction = 0) => [((G7 | type) >>> 0), { type, sound, soundAction, soundFrame: 1, impact: -1 }] as const;

test('death effect: race sound at creation, nothing at the end; nothing off screen', {}, () => {
  const rules = new Map<number, unknown>([rule(11, 51), rule(12, 50), rule(13, 49), rule(19, 54)]);
  const data = { rules, objects: new Map(), sprites: { entry: () => undefined } } as unknown as GameData;
  const fx = new Effects(data);
  const heard: number[] = [];
  fx.onSound = s => heard.push(s);
  const effects = [
    { kind: 'die', tick: 10, x: 5, y: 5, race: 1, type: 3 },    // a Pimmon soldier
    { kind: 'die', tick: 10, x: 6, y: 5, race: 2, type: 16 },   // a bomb carrier
  ];
  fx.drain({ effects } as unknown as World, 10, 0);
  assert.deepEqual(heard, [50, 54], 'played at once, with the poof');
  for (let t = 10; t < 40; t++) fx.update(t, t * 100, 64);
  assert.deepEqual(heard, [50, 54], 'no second sound when the effect ends');
  fx.visible = () => false;
  fx.drain({ effects: [{ kind: 'die', tick: 50, x: 1, y: 1, race: 0, type: 1 }] } as unknown as World, 50, 0);
  assert.deepEqual(heard, [50, 54], 'not drawn: silent');
});
