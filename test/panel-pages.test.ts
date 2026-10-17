// Side-panel page choice (docs/ui/side-panel.md 5.1): town page, selection page, type pages.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { PanelPages, defaultTypePage, type PageObj } from '../src/client/hud-pages.ts';
import { parseOdb } from '../src/formats/odb.ts';
import { DATA } from './helpers/mission.ts';

const SCHOOL: PageObj = { kind: 1, type: 55 };
const MINE: PageObj = { kind: 1, type: 50 };
const HOUSE: PageObj = { kind: 1, type: 37 };
const LAB: PageObj = { kind: 1, type: 46 };
const WORKER: PageObj = { kind: 0, type: 1 };
const MERCHANT: PageObj = { kind: 0, type: 28 };
const SHIP: PageObj = { kind: 0, type: 67 };
const FISHING_BOAT: PageObj = { kind: 0, type: 64 };

/** the shipped defaults (5.1 table) */
const DEFAULTS: Record<number, number> = { 39: 4, 43: 4, 55: 4, 56: 4, 63: 4, 44: 13, 50: 13, 61: 13, 46: 2, 48: 9, 62: 9 };
const pages = () => new PanelPages(t => DEFAULTS[t] ?? 0);

test('panel pages: a new game is in per-type mode (selection page 2): each object opens its type page', {}, () => {
  const p = pages();
  assert.equal(p.current([]), 8, 'nothing selected: the build menu');
  assert.equal(p.current([SCHOOL]), 4, 'the first click on a school opens training');
  assert.equal(p.current([MINE]), 13);
  assert.equal(p.current([LAB]), 2);
  assert.equal(p.current([HOUSE]), 0);
  assert.equal(p.current([WORKER]), 0);
  assert.equal(p.current([SHIP]), 0, 'a transport ship has no passengers default');
  assert.equal(p.current([SCHOOL, WORKER]), 0, 'a group: info');
});

test('panel pages: training on a school, deselect, then a unit / another type falls back to info', {}, () => {
  const p = pages();
  p.request(0, [SCHOOL]);                       // INFO on the school
  assert.equal(p.current([SCHOOL]), 0);
  p.request(4, [SCHOOL]);                       // its training page
  assert.equal(p.current([SCHOOL]), 4);
  p.selected([]);                               // click on empty terrain
  assert.equal(p.current([]), 8, 'deselected: the town page');
  p.selected([WORKER]);
  assert.equal(p.current([WORKER]), 0, 'a unit has no training page: its type page, info');
  assert.equal(p.current([HOUSE]), 0, 'a house: info');
  assert.equal(p.current([MINE]), 13, 'a mine: its own type page');
  assert.equal(p.current([{ kind: 1, type: 55 }]), 4, 'another school reopens training');
});

test('panel pages: INFO makes every selection open info, but keeps the type pages', {}, () => {
  const p = pages();
  p.request(13, [MINE]);
  p.request(0, [MINE]);
  assert.equal(p.current([SCHOOL]), 0);
  assert.equal(p.current([MINE]), 0);
  p.request(4, [SCHOOL]);                      // back to per-type mode
  assert.equal(p.current([MINE]), 13, 'the mine\'s type page was never cleared');
});

test('panel pages: inhabitants (6) is shared by all buildings; units use their type page', {}, () => {
  const p = pages();
  p.request(6, [HOUSE]);
  assert.equal(p.current([SCHOOL]), 6);
  assert.equal(p.current([MINE]), 6);
  assert.equal(p.current([WORKER]), 0);
  assert.equal(p.current([SHIP]), 6, 'Gold: a transport ship keeps page 6 (its passengers)');
  assert.equal(p.current([FISHING_BOAT]), 0);
  // 6 is never stored as a type page
  p.request(2, [LAB]);
  assert.equal(p.current([HOUSE]), 0);
});

test('panel pages: a unit type remembers its page (trade route)', {}, () => {
  const p = pages();
  p.request(11, [MERCHANT]);
  assert.equal(p.current([WORKER]), 0);
  assert.equal(p.current([MERCHANT]), 11);
  p.request(6, [SHIP]);
  assert.equal(p.current([SHIP]), 6);
  assert.equal(p.current([MERCHANT]), 11, 'selection page 6: units other than the ship show their type page');
});

test('panel pages: the build menu with a selection gives way to info when the selection changes', {}, () => {
  const p = pages();
  p.request(8, [SCHOOL]);
  assert.equal(p.current([SCHOOL]), 8);
  assert.equal(p.current([SCHOOL, WORKER]), 8, 'a group keeps the build menu');
  p.selected([]);
  assert.equal(p.current([]), 8);
  p.selected([MINE]);
  assert.equal(p.current([MINE]), 0, 'selection page 8 -> 0');
  assert.equal(p.current([SCHOOL]), 0);
  // the type pages are untouched
  p.request(4, [SCHOOL]);
  assert.equal(p.current([MINE]), 13);
  // a group: selection page := n, no type page
  p.request(1, [SCHOOL, MINE]);
  assert.equal(p.current([SCHOOL]), 4);
});

test('panel pages: the town page is separate from the selection pages', {}, () => {
  const p = pages();
  p.request(7, []);
  p.request(4, [SCHOOL]);
  assert.equal(p.current([]), 7);
  p.selected([]);
  assert.equal(p.current([]), 7);
});

test('panel pages: type page defaults from the record (product, class 5, flag 0x20, lab, market)', {}, () => {
  assert.equal(defaultTypePage(44, { product: 6, cls: 4, flags: 0 }), 13);
  assert.equal(defaultTypePage(55, { product: -1, cls: 5, flags: 0 }), 4);
  assert.equal(defaultTypePage(62, { product: -1, cls: 4, flags: 0x21 }), 9);
  assert.equal(defaultTypePage(48, { product: -1, cls: 4, flags: 1 }), 9, 'base market without flag 0x20');
  assert.equal(defaultTypePage(46, { product: -1, cls: 0, flags: 2 }), 2);
  assert.equal(defaultTypePage(40, { product: -1, cls: 4, flags: 1 }), 0);
  assert.equal(defaultTypePage(55, undefined), 0, 'no record of the own race');
  assert.equal(defaultTypePage(20, { product: 3, cls: 5, flags: 0 }), 0, 'types below 37 stay 0');
});

test('panel pages: shipped base data gives the documented defaults', { skip: !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set' }, () => {
  const rules = parseOdb(readFileSync(`${DATA}/dv.odb`));
  for (let race = 0; race < 3; race++) {
    for (let t = 37; t <= 61; t++) {
      const r = rules.get(((race << 16) | t) >>> 0);
      assert.equal(defaultTypePage(t, r), DEFAULTS[t] ?? 0, `race ${race} type ${t}`);
    }
  }
});
