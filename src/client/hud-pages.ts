// Side-panel pages (the dark lower area). Spec: docs/ui/side-panel.md section 5.
// All positions are page coordinates (origin = panel (4, 335)).

import type { Hud, HudHost } from './hud.ts';
import { lookOf, type Tint, type LookFlags } from './ui-tint.ts';
import { CONVERT_NOW, type World, type Entity } from '../engine/world.ts';
import type { Town } from '../engine/economy.ts';
import type { ObjectRule } from '../formats/odb.ts';
import { LJ, HG, HV, HuntChild } from '../engine/logistics.ts';
import { marketPage, tradeRoutePage, diplomacyPage, marketPagesAllowed } from './hud-pages-trade.ts';
import type { BitmapFont, FontName } from './ui-assets.ts';
import { NJ } from '../engine/naval.ts';
import { TradeJob } from '../engine/trade.ts';
import { CJ } from '../engine/combat.ts';
import { MJ } from '../engine/motion.ts';
import { isShip, isTransport, isTrader, hasHome, canPatrol, passengerTypes } from './addon-ui.ts';

export interface PageCtx {
  hud: Hud;
  host: HudHost;
  world: World;
  sel: Entity[];
  x0: number; y0: number; h: number;
}

const KIND_UNIT = 0, KIND_BUILDING = 1;
const GOODS_GROUP = 6;
const WHITE = '#ffffff', YELLOW = '#ffff96', RED = '#ff0000', GREEN = '#00ff00';

/**
 * The look of a button (side-panel.md 3.1): hover first (never for a disabled button or a
 * picture), then dim (0x08 or 0x20: half brightness), then 0x10 "off".
 */
export function buttonTint(b: LookFlags, hover: boolean): Tint { return lookOf(b, hover); }

// ---------------------------------------------------------------- choosing the page (5.1)

export function pageFor(hud: Hud, host: HudHost, sel: Entity[]): number {
  const w = host.world!;
  const town = w.economy.town(host.currentTown);
  let p = hud.currentPage(sel);
  if (!sel.length) {
    if (!town) return -1;
    if (p === 8) { const hall = w.get(town.hall); return hall?.complete ? 8 : -1; }
    return [1, 5, 6, 7, 14].includes(p) ? p : 8;
  }
  if (sel.length > 1) return p === 8 ? 8 : 0;
  const e = sel[0];
  if (p === 8) return 8;
  if (p === 9 || p === 10) return marketPagesAllowed(w, host.player, e) ? p : 0;
  if (p === 11 && !isTrader(w, e)) p = 0;
  // page 6 of a unit: only a transport ship has one (its passengers, addon.md 5.6)
  if (p === 6 && e.kind === KIND_UNIT && !isTransport(w, e)) p = 0;
  if (p === 12 && !(e.kind === KIND_BUILDING && (e.oid & 0xffff) === 42)) p = 0;
  if (p !== 0 && (e.owner !== host.player || (p !== 6 && e.kind === KIND_BUILDING && !e.complete))) p = 0;
  return p;
}

// ---------------------------------------------------------------- advisor line 12 (1.1.5)

/** mentor line 12 "Dem Gebäude fehlt ein Betreiber!" */
export const MENTOR_NO_OPERATOR = 12;

/** what the finished-building info page (display class 1) knows about its building */
export interface OperatorCheck {
  id: number;
  /** the building's race is the local player's */
  own: boolean;
  /** record upkeep (+0xD4) */
  upkeep: number;
  /** the building is active (display +0x1FD; state 2) */
  active: boolean;
}

/**
 * The info page's trigger of mentor#12 (side-panel.md 1.1.5). Call `build` every time the panel
 * builds its page: `cls1` = the page is the finished-building info page, `b` its building. A
 * class-1 page "object" lives while class 1 stays shown; it starts with its "not yet said" flag
 * set, which a change of the shown building sets again. An own inactive building with upkeep
 * clears it and returns true: say line 12 (unqueued, client only, no interval).
 */
export class MissingOperatorLine {
  /** the class-1 page is the page built last */
  private open = false;
  /** the class-1 page's "not yet said" flag (page +0x30) */
  private armed = false;
  /** the building the class-1 page was last built for; outlives the page (process-wide) */
  private last = -1;

  build(cls1: boolean, b: OperatorCheck | null): boolean {
    if (!cls1 || !b) { this.open = false; return false; }
    if (!this.open) { this.open = true; this.armed = true; }   // a new page object
    if (b.id !== this.last) { this.last = b.id; this.armed = true; }
    if (!b.own || b.upkeep === 0 || b.active || !this.armed) return false;
    this.armed = false;
    return true;
  }
}

/** the page about to be drawn is the finished-building info page (class 1); its building */
export function infoBuilding(page: number, sel: Entity[]): Entity | null {
  const e = sel.length === 1 ? sel[0] : undefined;
  return page === 0 && e && e.kind === KIND_BUILDING && e.complete ? e : null;
}

export function drawPage(pc: PageCtx, page: number): void {
  switch (page) {
    case 0: return infoPage(pc);
    case 1: return financePage(pc);
    case 2: return researchPage(pc);
    case 3: return historyPage(pc);
    case 4: return trainingPage(pc);
    case 5: return stockPage(pc);
    case 6: return inhabitantsPage(pc);
    case 7: return needsPage(pc);
    case 8: return buildPage(pc);
    case 13: return productionPage(pc);
    case 14: return buildingsPage(pc);
    case 9: return marketPage(pc, true);
    case 10: return marketPage(pc, false);
    case 11: return tradeRoutePage(pc);
    case 12: return diplomacyPage(pc);
    default: return;
  }
}

// ---------------------------------------------------------------- drawing helpers

function f(pc: PageCtx, n: FontName): BitmapFont { return pc.hud.font(n); }

/** text in a rect: align 0 left / 1 centre / 2 right; valign 3 top / 4 centre / 5 bottom */
function text(pc: PageCtx, s: string, x: number, y: number, opts: { font?: FontName; color?: string; w?: number; h?: number; align?: number; valign?: number; shadow?: boolean } = {}): void {
  const font = f(pc, opts.font ?? 'dv7pts2');
  const tw = font.measure(s);
  let tx = x, ty = y;
  if (opts.w !== undefined) tx = opts.align === 1 ? x + (opts.w - tw) / 2 : opts.align === 2 ? x + opts.w - tw : x;
  if (opts.h !== undefined) ty = opts.valign === 4 ? y + (opts.h - font.height) / 2 : opts.valign === 5 ? y + opts.h - font.height : y;
  font.draw(pc.hud.g, s, pc.x0 + tx, pc.y0 + ty, opts.color ?? WHITE, opts.shadow === false ? undefined : '#000000');
}

function wrapped(pc: PageCtx, s: string, x: number, y: number, w: number, h: number, color = WHITE, font: FontName = 'dv7pts2'): void {
  const fo = f(pc, font);
  let yy = y;
  for (const line of fo.wrap(s, w)) {
    if (yy + fo.height > y + h) break;
    fo.draw(pc.hud.g, line, pc.x0 + x, pc.y0 + yy, color, '#000000');
    yy += fo.height + 1;
  }
}

function sep(pc: PageCtx, y: number): void {
  const img = pc.hud.ui!.get('LEISTE');
  if (img) pc.hud.g.drawImage(img, pc.x0 - 3, pc.y0 + y);
}

function header(pc: PageCtx, sprite: string, title: string): void {
  const img = pc.hud.ui!.get(sprite);
  if (img) pc.hud.g.drawImage(img, pc.x0 + 2, pc.y0);
  text(pc, title, 35, 10, { font: 'dv10pt' });
  sep(pc, 30);
}

function img(pc: PageCtx, c: HTMLCanvasElement | undefined, x: number, y: number, w?: number, h?: number): void {
  if (c) pc.hud.g.drawImage(c, pc.x0 + x, pc.y0 + y, w ?? c.width, h ?? c.height);
}

function button(pc: PageCtx, sprite: string | HTMLCanvasElement | undefined, x: number, y: number,
                b: { id: string; tip: string; disabled?: boolean; dark?: boolean; off?: boolean; picture?: boolean; onClick?: () => void; onRight?: () => void; w?: number; h?: number }): void {
  const c = typeof sprite === 'string' ? pc.hud.ui!.get(sprite) : sprite;
  pc.hud.imageButton(c, pc.x0 + x, pc.y0 + y, { ...b, w: b.w ?? c?.width ?? 45, h: b.h ?? c?.height ?? 45 });
}

/** a picture widget (3.1): its tooltip, the dim / off look, but no hover look and no click */
function picture(pc: PageCtx, c: HTMLCanvasElement | undefined, x: number, y: number,
                 b: { id: string; tip: string; dark?: boolean; off?: boolean; w?: number; h?: number }): void {
  button(pc, c, x, y, { ...b, picture: true });
}

const goodName = (pc: PageCtx, g: number, race: number) =>
  g === 0 ? pc.hud.str(220 + race) : pc.world.rules.get(((GOODS_GROUP << 16) | g) >>> 0)?.name ?? '';
const goodIcon = (pc: PageCtx, g: number) => pc.hud.uiIcon(((GOODS_GROUP << 16) | g) >>> 0);
function bubble(pc: PageCtx, g: number): HTMLCanvasElement | undefined {
  const d = pc.hud.uiOd.get(((GOODS_GROUP << 16) | g) >>> 0);
  const name = d?.slots.find(s => s);
  return name ? pc.hud.ui!.get(name.replace(/^RS\\/, 'BUBBLE\\')) : undefined;
}

function hpColor(cur: number, max: number): string {
  return cur > max * 0.9 ? '#00dc00' : cur <= max * 0.3 ? RED : '#dcdc00';
}

/** grid of items with scroll arrows at the bottom of the page (5.3) */
function grid<T>(pc: PageCtx, items: T[], x0: number, y0: number, cols: number, rowH: number, draw: (it: T, x: number, y: number) => void): void {
  const rows = Math.max(1, Math.floor((pc.h - y0 - 16) / rowH));
  const total = Math.ceil(items.length / cols);
  const maxScroll = Math.max(0, total - rows);
  if (pc.hud.scroll > maxScroll) pc.hud.scroll = maxScroll;
  const first = pc.hud.scroll * cols;
  for (let i = 0; i < rows * cols && first + i < items.length; i++) {
    draw(items[first + i], x0 + (i % cols) * Math.floor(172 / cols), y0 + Math.floor(i / cols) * rowH);
  }
  const bottom = pc.h;
  if (pc.hud.scroll > 0) button(pc, 'PFEILRECHTS', 101, bottom - 14, { id: 'grid:up', tip: '', onClick: () => { pc.hud.scroll--; } });
  if (pc.hud.scroll < maxScroll) button(pc, 'PFEILLINKS', 20, bottom - 13, { id: 'grid:down', tip: '', onClick: () => { pc.hud.scroll++; } });
}

/** horizontal 0..100 slider in a SLIDERHANDEL bar; calls set(value) while dragging */
function slider(pc: PageCtx, id: string, x: number, y: number, value: number, set: (v: number) => void, readOnly = false): void {
  const bar = pc.hud.ui!.get('SLIDERHANDEL'), ring = pc.hud.ui!.get('RING');
  img(pc, bar, x, y);
  const travel = 91 - 21;
  const hx = x + 10 + (travel * Math.max(0, Math.min(100, value))) / 100;
  img(pc, ring ? pc.hud.tint(ring, pc.hud.isHover(id) ? 'hover' : 'normal') : undefined, hx, y + 4);
  if (readOnly) return;
  pc.hud.addButton({ x: pc.x0 + x, y: pc.y0 + y, w: 113, h: 28, id, tip: '',
    onDrag: px => { set(Math.max(0, Math.min(100, Math.round(((px - pc.x0 - x - 10 - 10) * 100) / travel)))); } });
}

function townOf(pc: PageCtx): Town | undefined {
  const e = pc.sel[0];
  if (e) return pc.world.economy.town(e.town);
  return pc.world.economy.town(pc.host.currentTown);
}

function ruleOf(pc: PageCtx, e: Entity) { return pc.world.rules.get(e.oid); }

// ---------------------------------------------------------------- info pages (5.2)

function infoPage(pc: PageCtx): void {
  const sel = pc.sel;
  if (sel.length > 1) return groupPage(pc);
  const e = sel[0];
  if (!e) return;
  if (e.kind === KIND_UNIT) return unitInfo(pc, e);
  if (e.kind === KIND_BUILDING) return e.complete ? buildingInfo(pc, e) : siteInfo(pc, e);
  return natureInfo(pc, e);
}

function nameTownHp(pc: PageCtx, e: Entity): void {
  const r = ruleOf(pc, e);
  text(pc, r?.name ?? '', 0, 93, { w: 192, h: 27, align: 1, valign: 4 });
  if (e.town >= 0) text(pc, pc.hud.describeTown(e.town), 0, 108, { w: 192, h: 27, align: 1, valign: 4 });
  if (r?.hp) {
    const hp = `${e.hp}/${r.hp}`, wide = f(pc, 'dv7pts2').measure(hp) > 65;
    text(pc, hp, wide ? 100 : 118, 50, { w: wide ? 84 : 65, h: 45, valign: 5, align: wide ? 2 : 0, color: hpColor(e.hp, r.hp) });
  }
}

function unitInfo(pc: PageCtx, u: Entity): void {
  header(pc, 'INFO', pc.hud.str(2));
  const race = u.oid >>> 16, type = u.oid & 0xffff;
  img(pc, pc.hud.portrait(race, type), 73, 50);
  nameTownHp(pc, u);
  // ships never gain rank (addon.md 4.1): no experience badge
  if (u.rank > 0 && !isShip(pc.world, u)) img(pc, pc.hud.ui!.get(`ERFAHRUNG${4 - u.rank}`), 118, 75);
  if (u.owner !== pc.host.player || type === 12) return;
  sep(pc, 130);
  const noTown = !pc.world.economy.towns.some(t => t.race === pc.host.player && t.alive);
  const off = noTown || u.inside >= 0;
  const send = (action: 'home' | 'drop') => pc.host.command(action === 'home'
    ? { type: 'unit', player: pc.host.player, ids: pc.sel.map(s => s.id), action, town: pc.host.currentTown }
    : { type: 'unit', player: pc.host.player, ids: pc.sel.map(s => s.id), action });
  // ships have no home: no MOVEHOME, their buttons start in the first slot
  let x = 10;
  if (hasHome(pc.world, u)) {
    button(pc, 'MOVEHOME', 10, 135, { id: 'u:home', tip: pc.hud.str(3), disabled: off, onClick: () => send('home') });
    x = 40;
  }
  if (isTransport(pc.world, u)) {
    // AUSSTEIGEN (tooltip T330 "Ausladen"): send every passenger out; disabled while empty (addon.md 5.6)
    button(pc, 'AUSSTEIGEN', x, 135, { id: 'u:unload', tip: pc.hud.str(330), disabled: u.passengers.length === 0 || pc.sel.length !== 1,
      onClick: () => pc.host.command({ type: 'unload', player: pc.host.player, ship: u.id }), w: 30, h: 30 });
    x += 30;
  }
  if (canPatrol(pc.world, u)) {
    button(pc, 'PATROL', x, 135, { id: 'u:patrol', tip: pc.hud.str(5), disabled: off || pc.sel.length !== 1, onClick: () => pc.host.startPatrol(u.id) });
    x += 30;
  }
  if (type === 10) {
    // 11.1: disabled inside a building, and at the limit of 10 towns (tooltip T172)
    const towns = pc.world.economy.towns.filter(t => t.race === pc.host.player && t.alive).length;
    button(pc, 'GRUENDEN', 40, 135, { id: 'u:found', tip: pc.hud.str(towns >= 10 ? 172 : 6), disabled: u.inside >= 0 || towns >= 10 || pc.sel.length !== 1,
      onClick: () => pc.host.startFounding(u.id) });
    x = 70;
  }
  if (u.carryAmount > 0) button(pc, 'WEGWERFEN', x, 135, { id: 'u:drop', tip: pc.hud.str(140), onClick: () => send('drop') });
  sep(pc, 163);
  wrapped(pc, jobText(pc, u), 10, 172, 175, 30);
  // a transport ship's passengers: count / capacity next to the portrait
  if (isTransport(pc.world, u)) text(pc, `${pc.hud.str(329)}: ${u.passengers.length}/${Math.max(0, ruleOf(pc, u)?.garrison ?? 0)}`, 10, 237);
  if (u.carryAmount > 0) {
    text(pc, pc.hud.str(7), 35, 200, { w: 85, h: 30, valign: 4 });
    const ic = goodIcon(pc, u.carryGood);
    picture(pc, ic, 100, 200, { id: 'u:carry', tip: goodName(pc, u.carryGood, race), w: 30, h: 30 });
    text(pc, String(u.carryAmount), 130, 200, { w: 30, h: 30, valign: 5 });
  }
}

/** the unit's current activity in words (T262..T281): the top-level job's text (unit-motion.md 6) */
function jobText(pc: PageCtx, u: Entity): string {
  const w = pc.world, hud = pc.hud, race = u.oid >>> 16;
  const name = (id: number) => { const e = w.get(id); return e ? (w.rules.get(e.oid)?.name ?? '') : ''; };
  // inside a building or a ship: T280 with the building's / the ship type's name (addon.md 4.1)
  if (u.inside >= 0) return hud.str(280, name(u.inside));
  const j = u.job ? w.sched.get(u.job) : undefined;
  if (!j) return u.path ? hud.str(308) : hud.str(278);
  const d = j.data;
  if (isShip(w, u)) {
    // fishing boats (addon.md 6.2): T327 on the way, T328 fishing, then carrying the catch to the harbour
    const phase = w.naval.fishingPhase(u);
    if (phase === 0) return hud.str(327);
    if (phase === 1) return hud.str(328);
    if (phase === 2) { const h = w.naval.harbourOf(u); return hud.str(272, goodName(pc, u.carryGood >= 0 ? u.carryGood : 4, race), h ? name(h.id) : ''); }
  }
  const townName = (id: number) => pc.hud.describeTown(id);
  switch (j.kind) {
    case NJ.Board: return hud.str(269, name(d[0]));
    case TradeJob.Route: return d[1] >= 0 && d[2] >= 0 ? hud.str(305, townName(d[1]), townName(d[2])) : hud.str(308);
    case LJ.Transport: return u.carryAmount > 0 ? hud.str(272, goodName(pc, u.carryGood, race), name(d[1])) : hud.str(269, name(d[2] >= 0 ? d[2] : d[1]));
    // harvesting; phase 7 is a hunter's chase (attack child): T268 "Jagt %s"
    case LJ.Harvest: return d[HV.Phase] === 7 ? hud.str(268, name(d[HV.Target])) : hud.str(263, goodName(pc, w.get(d[HV.Target])?.yieldGood ?? 4, race));
    // the hunting ground (units-and-jobs.md 7.3.6): waiting T267, walking back T279, else the harvest child's text
    case LJ.Hunt: {
      if (d[HG.Child] === HuntChild.None) return hud.str(267);
      if (d[HG.Child] === HuntChild.Walk) return hud.str(279);
      const h = HG.Harvest, target = d[h + HV.Target];
      return d[h + HV.Phase] === 7 ? hud.str(268, name(target)) : hud.str(263, goodName(pc, w.get(target)?.yieldGood ?? 4, race));
    }
    case LJ.Builder: { const b = w.get(d[1]); return b?.complete ? hud.str(310, name(d[1])) : hud.str(264, name(d[1])); }
    case LJ.Plant: return hud.str(275, w.rules.get(((GOODS_GROUP << 16) | d[4]) >>> 0)?.name ?? '');
    case LJ.Answer: return hud.str(269, name(d[1]));
    case LJ.Found: return hud.str(266);
    // the news round, walking home included (units-and-jobs.md 8.6)
    case LJ.News: return hud.str(270);
    // the arrest job reads "Jagt Kriminellen" throughout: choosing, chasing, beating, walking back
    case CJ.Arrest: return hud.str(271);
    case CJ.Attack: return hud.str(262, name(d[0]));
    case CJ.Flee: return hud.str(274, name(d[0]));
    case CJ.Guard: return hud.str(276);
    case CJ.Heal: return hud.str(277, d[1] ? name(d[2]) : '');
    case MJ.TurnIdle: return hud.str(278);
    // step aside, criminal, escort, garrison fire: an empty line
    case MJ.StepAside: case CJ.Criminal: case CJ.Escort: case CJ.GarrisonFire: return '';
    default: return hud.str(308);
  }
}

function buildingInfo(pc: PageCtx, b: Entity): void {
  header(pc, 'INFO', pc.hud.str(2));
  const race = b.oid >>> 16, type = b.oid & 0xffff, r = ruleOf(pc, b);
  img(pc, pc.hud.portrait(race, type), 68, 50);
  nameTownHp(pc, b);
  if (b.owner !== pc.host.player || !r) return;
  sep(pc, 130);
  const act = (action: 'demolish' | 'repair' | 'deactivate') => pc.host.command({ type: 'building', player: pc.host.player, id: b.id, action });
  button(pc, 'ABREISSEN', 10, 135, { id: 'b:demolish', tip: pc.hud.str(8), onClick: () => act('demolish') });
  button(pc, 'REPAIR', 40, 135, { id: 'b:repair', tip: pc.hud.str(4), disabled: b.hp >= r.hp, onClick: () => act('repair') });
  if (r.operator >= 0) {
    // "present" (`00455e90`): a stored operator, also while he is out on the building's own duty
    // (units-and-jobs.md 8.5); without one, any occupant (residents for houses) counts
    const present = b.operatorId >= 0 || (r.residents > 0 ? b.occupancy : pc.world.logistics.occupants(b).length) > 0;
    button(pc, 'DEAKTIVIEREN', 70, 135, { id: 'b:deact', tip: pc.hud.str(type === 42 ? 312 : 311), disabled: !present || type === 40, onClick: () => act('deactivate') });
    text(pc, pc.hud.str(present ? 174 : 9), 130, 172, { w: 50, h: 13, align: 1 });
    const op = pc.hud.portrait(race, r.operator);
    button(pc, op, 130, 190, { id: 'b:op', tip: pc.world.rules.get(((race << 16) | r.operator) >>> 0)?.name ?? '', w: 45, h: 45, disabled: !present });
  }
  if (type === 40) button(pc, 'RENAME', 100, 135, { id: 'b:rename', tip: pc.hud.str(180), disabled: true });
  const cap = type === 37 || type === 38 ? r.residents : type === 52 || type === 53 ? r.garrison : 0;
  if (cap > 0) {
    const occ = type === 37 || type === 38 ? b.occupancy : pc.world.logistics.occupants(b).length;   // a unit sent out leaves the list at once (4.11)
    text(pc, pc.hud.str(129), 130, 172, { w: 50, h: 13, align: 1 });
    img(pc, pc.hud.portrait(race, type === 37 || type === 38 ? 9 : 29), 130, 190);
    text(pc, `${occ}/${cap}`, 100, 190, { w: 28, h: 45, valign: 4, align: 2 });
  }
  sep(pc, 163);
  if (r.money > 0) {
    text(pc, pc.hud.str(133), 5, 172);
    const k = pc.hud.ui!.get('KOSTEN');
    picture(pc, k, 5, 197, { id: 'b:upkeep', tip: '', dark: !b.active });
    text(pc, String(r.money), 45, 190, { w: 105, h: 45, valign: 4 });
  }
}

function siteInfo(pc: PageCtx, b: Entity): void {
  header(pc, 'INFO', pc.hud.str(2));
  const race = b.oid >>> 16, type = b.oid & 0xffff, r = ruleOf(pc, b);
  img(pc, pc.hud.portrait(race, type), 48, 50);
  const v = siteView(b);
  text(pc, `${v.percent}%`, 100, 50, { font: 'dv18pt', w: 50, h: 45, align: 1, valign: 4 });
  text(pc, b.paused ? pc.hud.str(248) : pc.hud.str(56, r?.name ?? ''), 0, 93, { w: 192, h: 27, align: 1, valign: 4 });
  if (r) text(pc, `${b.hp}/${r.hp}`, 0, 108, { font: 'dv10pt', w: 192, h: 27, align: 1, valign: 4, color: hpColor(b.hp, r.hp) });
  if (b.owner !== pc.host.player || !r) return;
  sep(pc, 130);
  const act = (action: 'demolish' | 'pause' | 'resume') => pc.host.command({ type: 'building', player: pc.host.player, id: b.id, action });
  button(pc, 'ABREISSEN', 10, 135, { id: 's:demolish', tip: pc.hud.str(8), onClick: () => act('demolish') });
  if (b.paused) button(pc, 'BAUWEITER', 40, 135, { id: 's:resume', tip: pc.hud.str(192), onClick: () => act('resume') });
  else button(pc, 'BAUSTOP', 40, 135, { id: 's:pause', tip: pc.hud.str(191), onClick: () => act('pause') });
  sep(pc, 164);
  text(pc, pc.hud.str(57), 0, 175, { font: 'dv10pt', w: 192, align: 1 });
  // one entry per good still to consume, at most three: icon, then local stock / still to consume
  v.materials.forEach((m, i) => {
    picture(pc, goodIcon(pc, m.good), 2 + 60 * i, 195, { id: `s:g${m.good}`, tip: goodName(pc, m.good, race), w: 30, h: 30 });
    text(pc, `${m.local}/${m.left}`, 32 + 60 * i, 195, { w: 30, h: 30, align: 0, valign: 5 });
  });
}

export interface SiteView {
  /** construction progress (vtable[6], units-and-jobs.md 6.3); 0 before the first construction call */
  percent: number;
  /** the order's still-to-consume list in list order, at most three (6.9) */
  materials: { good: number; local: number; left: number }[];
}

/**
 * The construction-site page's data (message `00456af0`, units-and-jobs.md 6.9, side-panel.md 5.2
 * class 15): per good still listed in the order, the site's local stock and the amount still to
 * consume. Goods on the way are not counted; a consumed good has no entry.
 */
export function siteView(b: Entity): SiteView {
  const o = b.order && b.order.kind === 'build' ? b.order : null;
  if (!o) return { percent: b.complete ? 100 : 0, materials: [] };
  const percent = o.started && o.N ? Math.max(0, Math.min(100, Math.trunc(((o.N - (o.counter - o.E)) * 100) / o.N))) : 0;
  return { percent, materials: o.list.slice(0, 3).map(([good, left]) => ({ good, local: b.local[good], left })) };
}

/** the nature info picture (side-panel.md class 17): trees and palms a panel icon, animals (and
 *  fish) their own panel icon, stones STEIN1, everything else its own world sprite, 1:1 */
function natureIcon(pc: PageCtx, n: Entity, r: ObjectRule | undefined): HTMLCanvasElement | undefined {
  const t = n.oid & 0xffff, c = r?.cls ?? -1;
  const ui = (name: string | null | undefined) => (name ? pc.hud.uiSprite(name) : undefined);
  if (t >= 9 && t <= 12) return ui('RS\\MI\\BAUM\\MS0');
  if (t >= 46 && t <= 49) return ui('RS\\MI\\PALME1\\MS0');
  if (c === 7 || c === 15) return pc.hud.uiIcon(n.oid);
  const name = c === 13 ? 'RS\\VE\\STEIN1\\MS0' : pc.host.data.objects.get(n.oid)?.slots.find(s => s);
  return name ? (ui(name) ?? pc.hud.worldSprite(name)) : undefined;
}

function natureInfo(pc: PageCtx, n: Entity): void {
  header(pc, 'INFO', pc.hud.str(2));
  const r = ruleOf(pc, n);
  img(pc, natureIcon(pc, n, r), 73, 50);
  text(pc, r?.name ?? '', 0, 93, { w: 192, h: 27, align: 1, valign: 4 });
  if (r && r.cls >= 10 && r.cls <= 12) text(pc, pc.hud.str(220 + r.cls - 10), 50, 130, { w: 70, h: 30, valign: 4 });
  if (n.yieldGood >= 0 && n.full > 0) {
    if (n.yieldGood > 0) img(pc, goodIcon(pc, n.yieldGood), 65, 130, 30, 30);   // crops (good 0) show the caption instead
    text(pc, `${n.amount}/${n.full}`, 95, 130, { font: 'dv10pt', w: 85, h: 30, valign: 4 });
  }
}

function groupPage(pc: PageCtx): void {
  header(pc, 'INFO', pc.hud.str(2));
  pc.sel.slice(0, 12).forEach((u, i) => {
    const x = (i % 3) * 60, y = 50 + Math.floor(i / 3) * 45;
    const r = ruleOf(pc, u);
    button(pc, pc.hud.portrait(u.oid >>> 16, u.oid & 0xffff), x, y, { id: `grp:${u.id}`, tip: r?.name ?? '', w: 45, h: 45, onClick: () => pc.host.select([u.id]) });
    if (r?.hp) text(pc, String(u.hp), x + 35, y, { w: 30, h: 45, align: 1, valign: 5, color: hpColor(u.hp, r.hp) });
  });
}

// ---------------------------------------------------------------- grid pages (5.3)

function buildPage(pc: PageCtx): void {
  header(pc, 'GEBAEUDEBAUEN', pc.hud.str(1));
  const t = pc.world.economy.town(pc.host.currentTown);
  if (!t) return;
  const race = t.race;
  [1, 2, 3].forEach((g, k) => {
    picture(pc, bubble(pc, g), 25 + 50 * k, 35, { id: `bs:${g}`, tip: goodName(pc, g, race), w: 15, h: 15 });
    text(pc, String(t.stock[g]), 40 + 50 * k, 35, { w: 25, h: 15, valign: 4 });
  });
  const items = [...pc.world.rules.values()]
    .filter(r => r.group === race && r.kind === KIND_BUILDING && pc.world.logistics.menuState(t, r.type) >= 0)
    .sort((a, b) => a.slot - b.slot || a.type - b.type);
  grid(pc, items, 10, 55, 2, 50, (r, x, y) => {
    const st = pc.world.logistics.menuState(t, r.type);
    const tip = st === 2 ? pc.hud.str(131) : st === 4 ? pc.hud.str(132) : r.type === 50 ? pc.hud.str(315) : r.name;
    const id = `build:${r.type}`;
    button(pc, pc.hud.portrait(race, r.type), x, y, { id, tip, w: 45, h: 45, disabled: st === 2 || st === 4, off: st === 3,
      onClick: () => pc.host.startPlacing(r.type) });
    if (pc.host.placing === r.type) { pc.hud.g.strokeStyle = '#ffe9a0'; pc.hud.g.strokeRect(pc.x0 + x + 0.5, pc.y0 + y + 0.5, 44, 44); }
    if (st === 2) return;
    let k = 0;
    for (let g = 0; g <= 4; g++) {
      if (!r.cost[g]) continue;
      picture(pc, bubble(pc, g), x + 50, y + 15 * k, { id: `bc:${r.type}:${g}`, tip: goodName(pc, g, race), w: 15, h: 15, off: t.stock[g] < r.cost[g] });
      text(pc, String(r.cost[g]), x + 70, y + 15 * k + 1);
      k++;
    }
  });
}

/** what the training page shows for the queue (side-panel.md class 7); a pure function of the page data */
export interface TrainingView {
  /** one entry per queued order: dark (the 0x20 look, still clickable) while no pupil is inside for it */
  slots: { type: number; dark: boolean }[];
  /** slot 0 status: T139 empty, T138 waiting for a pupil, T252 waiting for material, T137 training */
  status: 'empty' | 'pupil' | 'material' | 'training';
  /** T252: one bubble per unit of every required good, in goods order; dark when the stock does not cover it */
  icons: { good: number; dark: boolean }[];
  /** T137: progress x 100 / target, at least 1 once started; 0 before the start */
  percent: number;
}

/**
 * The training page's queue part from its page data (`00456130`): the queued types, the number of
 * units inside the building, whether the first order has started with its progress and target
 * (the new type's HP), the first type's goods and the building's stock.
 */
export function trainingView(queue: readonly number[], inside: number, started: boolean, progress: number, target: number,
  cost: readonly number[], stock: readonly number[]): TrainingView {
  const slots = queue.slice(0, 5).map((type, i) => ({ type, dark: i >= inside }));
  const percent = started ? Math.max(1, Math.trunc((progress * 100) / Math.max(1, target))) : 0;
  const v: TrainingView = { slots, status: 'empty', icons: [], percent };
  if (!queue.length) return v;
  if (inside <= 0) { v.status = 'pupil'; return v; }
  const needs = cost.some(n => n > 0);
  if (!started && needs) {
    v.status = 'material';
    cost.forEach((n, g) => { for (let k = 0; k < n; k++) v.icons.push({ good: g, dark: k >= (stock[g] ?? 0) }); });
    return v;
  }
  v.status = 'training';
  return v;
}

function trainingPage(pc: PageCtx): void {
  const b = pc.sel[0];
  if (!b) return;
  const type = b.oid & 0xffff, race = b.oid >>> 16;
  header(pc, type === 55 ? 'EINHEITENBAUEN' : 'KAEMPFERBAUEN', pc.hud.str(0));
  const t = pc.world.economy.town(b.town);
  const frame = pc.hud.ui!.get('RAHMEN');
  const first = b.queue.length ? pc.world.rules.get(((race << 16) | b.queue[0]) >>> 0) : undefined;
  const stock = Array.from({ length: 9 }, (_, g) => pc.world.logistics.stockOf(b, g));
  const v = trainingView(b.queue, pc.world.logistics.occupants(b).length, !!b.trainStarted, b.trainProgress, first?.hp ?? 1,
    first?.cost ?? [], stock);
  const slots: [number, number][] = [[2, 45], [2, 90], [47, 90], [92, 90], [137, 90]];
  slots.forEach(([x, y], i) => {
    img(pc, frame, x, y);
    const q = v.slots[i];
    if (q) {
      // the portrait and its frame as one command button; a dark slot still cancels on a click (3.1)
      button(pc, pc.hud.portrait(race, q.type), x, y, { id: `tq:${i}`, tip: pc.world.rules.get(((race << 16) | q.type) >>> 0)?.name ?? '', w: 45, h: 45,
        dark: q.dark, onClick: () => pc.host.command({ type: 'untrain', player: pc.host.player, building: b.id, index: i }) });
    }
  });
  if (v.status === 'empty') text(pc, pc.hud.str(139), 50, 45);
  else if (v.status === 'pupil') text(pc, pc.hud.str(138), 50, 45);
  else if (v.status === 'material') {
    text(pc, pc.hud.str(252), 50, 45);
    v.icons.forEach((ic, k) => {
      const bi = bubble(pc, ic.good);
      picture(pc, bi, 50 + 12 * k, 60, { id: `tm:${k}`, tip: goodName(pc, ic.good, race), w: 15, h: 15, dark: ic.dark });
    });
  } else {
    text(pc, pc.hud.str(137), 50, 45);
    text(pc, first?.name ?? '', 50, 65);
    text(pc, `${v.percent}%`, 130, 45, { font: 'dv18pt', w: 62, h: 45, align: 1, valign: 4 });
  }
  sep(pc, 145);
  if (!t) return;
  const units = [...pc.world.rules.values()].filter(r => r.group === race && r.kind === KIND_UNIT && r.madeAt === type)
    .filter(r => !pc.world.economy.players[race]?.disabled.includes(r.type))
    .sort((a, c) => a.slot - c.slot || a.type - c.type);
  grid(pc, units, 10, 155, 2, 50, (r, x, y) => {
    const st = pc.world.logistics.trainState(t, b, r.type);
    const tip = st === 2 ? pc.hud.str(131) : st === 5 ? pc.hud.str(202) : r.name;
    button(pc, pc.hud.portrait(race, r.type), x, y, { id: `train:${r.type}`, tip, w: 45, h: 45, disabled: st === 2 || st === 5 || st < 0,
      off: st === 3 || st === 6, onClick: () => pc.host.command({ type: 'train', player: pc.host.player, building: b.id, unit: r.type }) });
    if (st === 2) return;
    const gold = pc.hud.ui!.get('GOLD');
    picture(pc, gold, x + 45, y, { id: `tc:${r.type}`, tip: pc.hud.str(141), w: 15, h: 13 });
    text(pc, String(r.money), x + 62, y);
    let k = 1;
    r.cost.forEach((n, g) => {
      if (!n) return;
      picture(pc, bubble(pc, g), x + 45, y + 15 * k, { id: `tg:${r.type}:${g}`, tip: goodName(pc, g, race), w: 15, h: 15, off: t.stock[g] < n });
      text(pc, String(n), x + 62, y + 15 * k + 1);
      k++;
    });
  });
}

/** select the next object of a type (cycling) and centre on it */
function cycle(pc: PageCtx, key: string, list: Entity[], selectIt: boolean): void {
  if (!list.length) return;
  const i = ((pc.hud.pageState[key] ?? -1) + 1) % list.length;
  pc.hud.pageState[key] = i;
  const e = list[i];
  pc.host.centerOn(Math.floor(e.x / 256), Math.floor(e.y / 256));
  if (selectIt) pc.host.select([e.id]);
}

/** a transport ship's passengers (BEWOHNER, T329 "An Bord"; addon.md 5.6): click = send that type out */
function passengersPage(pc: PageCtx, ship: Entity): void {
  header(pc, 'BEWOHNER', pc.hud.str(329));
  const w = pc.world, cap = Math.max(0, ruleOf(pc, ship)?.garrison ?? 0);
  text(pc, `${ship.passengers.length}/${cap}`, 150, 10, { font: 'dv10pt', w: 35, align: 2 });
  grid(pc, passengerTypes(w, ship), 10, 45, 3, 50, ({ oid, count }, x, y) => {
    const name = w.rules.get(oid)?.name ?? '';
    button(pc, pc.hud.portrait(oid >>> 16, oid & 0xffff), x, y, { id: `aboard:${oid}`, tip: pc.hud.str(249, name), w: 45, h: 45,
      onClick: () => pc.host.command({ type: 'unload', player: pc.host.player, ship: ship.id, unit: oid & 0xffff }) });
    text(pc, String(count), x + 40, y + 35);
  });
}

function inhabitantsPage(pc: PageCtx): void {
  if (pc.sel.length === 1 && isTransport(pc.world, pc.sel[0])) return passengersPage(pc, pc.sel[0]);
  const b = pc.sel.length === 1 && pc.sel[0].kind === KIND_BUILDING ? pc.sel[0] : null;
  header(pc, 'BEWOHNER', pc.hud.str(b ? 38 : 39));
  const w = pc.world;
  if (b) {
    // the building's occupant list, counted by unit type; a unit of another race counts under the
    // viewer's race's type (side-panel.md class 9, building mode). Left click = command 0x3A
    // "send out" that type (units-and-jobs.md 4.11); right / double click: nothing.
    const race = pc.host.player;
    const inside = w.logistics.occupants(b);
    const oidOf = (type: number) => ((race << 16) | type) >>> 0;
    const types = [...new Set(inside.map(u => u.oid & 0xffff))]
      .sort((a, c) => (w.rules.get(oidOf(a))?.slot ?? 0) - (w.rules.get(oidOf(c))?.slot ?? 0));
    grid(pc, types, 10, 45, 3, 50, (type, x, y) => {
      const oid = oidOf(type);
      const name = w.rules.get(oid)?.name ?? '';
      // T312 "Diplomatische Beziehungen abbrechen" for the diplomat (type 13), else T249 "%s aus Gebäude schicken"
      const tip = type === 13 ? pc.hud.str(312) : pc.hud.str(249, name);
      button(pc, pc.hud.portrait(race, type), x, y, { id: `in:${oid}`, tip, w: 45, h: 45,
        onClick: () => pc.host.command({ type: 'sendOut', player: pc.host.player, building: b.id, unit: type }) });
      text(pc, String(inside.filter(u => (u.oid & 0xffff) === type).length), x + 40, y + 35);
    });
    return;
  }
  const t = w.economy.town(pc.host.currentTown);
  if (!t) return;
  const units = w.entities.filter(u => u.kind === KIND_UNIT && u.town === t.id);
  const free = units.filter(u => (u.oid & 0xffff) === 9 && !u.job && u.inside < 0).length;
  text(pc, pc.hud.str(40), 8, 40); text(pc, String(t.population), 60, 40, { w: 25, align: 2 });
  text(pc, pc.hud.str(307), 95, 40); text(pc, String(free), 160, 40, { w: 20, align: 2 });
  const types = [...new Set(units.map(u => u.oid))].sort((a, c) => (w.rules.get(a)?.slot ?? 0) - (w.rules.get(c)?.slot ?? 0));
  grid(pc, types, 10, 60, 3, 50, (oid, x, y) => {
    const of = units.filter(u => u.oid === oid);
    const name = w.rules.get(oid)?.name ?? '';
    button(pc, pc.hud.portrait(oid >>> 16, oid & 0xffff), x, y, { id: `ty:${oid}`, tip: pc.hud.str(250, name), w: 45, h: 45,
      onClick: () => cycle(pc, `u${oid}`, of.filter(u => u.inside < 0), true), onRight: () => cycle(pc, `u${oid}`, of.filter(u => u.inside < 0), false) });
    text(pc, String(of.length), x + 40, y + 35);
  });
}

function buildingsPage(pc: PageCtx): void {
  header(pc, 'GEBAEUDEINFO', pc.hud.str(41));
  const w = pc.world, t = w.economy.town(pc.host.currentTown);
  if (!t) return;
  const bs = w.entities.filter(e => e.kind === KIND_BUILDING && e.town === t.id);
  text(pc, pc.hud.str(42), 8, 40); text(pc, String(bs.filter(b => b.complete).length), 60, 40, { w: 25, align: 2 });
  text(pc, pc.hud.str(43), 95, 40); text(pc, String(bs.filter(b => !b.complete).length), 160, 40, { w: 20, align: 2 });
  const types = [...new Set(bs.map(b => b.oid))].sort((a, c) => (w.rules.get(a)?.slot ?? 0) - (w.rules.get(c)?.slot ?? 0));
  grid(pc, types, 10, 55, 3, 50, (oid, x, y) => {
    const of = bs.filter(b => b.oid === oid);
    button(pc, pc.hud.portrait(oid >>> 16, oid & 0xffff), x, y, { id: `bt:${oid}`, tip: w.rules.get(oid)?.name ?? '', w: 45, h: 45,
      onClick: () => cycle(pc, `b${oid}`, of, true), onRight: () => cycle(pc, `b${oid}`, of, false) });
    text(pc, String(of.length), x + 45, y + 35);
  });
}

// ---------------------------------------------------------------- town pages (5.4)

function financePage(pc: PageCtx): void {
  header(pc, 'STADTSTATISTIK', pc.hud.str(10));
  const t = townOf(pc);
  if (!t) return;
  // fresh figures; a spending row that is not being spent (research: no project running) shows
  // the slider amount in parentheses and 0, and stays out of the balance (side-panel.md 5.4)
  const f = pc.world.economy.financeView(t);
  const rows: [number, number, number, boolean][] = [
    [50, 12, f.income, true], [65, 13, f.motivation, f.motivationSpent], [80, 14, f.research, f.researchSpent], [95, 15, f.overheads, true],
  ];
  for (const [y, s, v, spent] of rows) {
    text(pc, pc.hud.str(s), 5, y);
    if (!spent && v !== 0) text(pc, `(${String(v).padStart(5)})`, 80, y, { w: 30, align: 2 });
    text(pc, String(spent ? v : 0), 100, y, { w: 50, align: 2 });
  }
  const bal = f.income - (f.motivationSpent ? f.motivation : 0) - (f.researchSpent ? f.research : 0) - f.overheads;
  text(pc, pc.hud.str(16), 5, 110);
  if (!f.motivationSpent || !f.researchSpent) {
    const full = f.income - f.motivation - f.research - f.overheads;
    text(pc, `(${`${full >= 0 ? '+' : '-'}${Math.abs(full)}`.padStart(5)})`, 70, 110, { w: 40, align: 2 });
  }
  text(pc, String(bal), 100, 110, { w: 50, align: 2, color: bal < 0 ? RED : GREEN });
  sep(pc, 130);
  img(pc, pc.hud.ui!.get('KOSTEN'), 2, 135);
  text(pc, pc.hud.str(128), 35, 135, { font: 'dv10pt', w: 157, h: 30, valign: 4 });
  const send = (m: number, r: number) => {
    if (m + r > 100) { if (m !== t.motivationPct) r = 100 - m; else m = 100 - r; }
    if (m !== t.motivationPct || r !== t.researchPct) pc.host.command({ type: 'sliders', player: pc.host.player, town: t.id, motivation: m, research: r });
  };
  text(pc, pc.hud.str(11), 5, 170, { w: 187, align: 1 });
  slider(pc, 'fin:mot', 20, 185, t.motivationPct, v => send(v, t.researchPct));
  text(pc, `${t.motivationPct}%`, 150, 190);
  text(pc, pc.hud.str(17), 5, 215, { w: 187, align: 1 });
  slider(pc, 'fin:res', 20, 230, t.researchPct, v => send(t.motivationPct, v));
  text(pc, `${t.researchPct}%`, 150, 235);
}

function needsPage(pc: PageCtx): void {
  header(pc, 'MOTIVATION', pc.hud.str(27));
  const t = townOf(pc);
  if (!t) return;
  const h = t.happiness;
  wrapped(pc, pc.hud.str(34 - Math.trunc(h / 20)), 5, 40, 185, 15, h >= 100 ? GREEN : RED);
  const block = (y: number, icon: HTMLCanvasElement | undefined, cap: string, value: string, expl: string, extra = 0) => {
    img(pc, icon, 5, y, 30, 30);
    text(pc, `${cap}: ${value}`, 40, y, { color: YELLOW });
    wrapped(pc, expl, 40, y + 14 + extra, 145, 28);
  };
  block(55, pc.hud.ui!.get('BEWOHNER'), pc.hud.str(206), `${t.crime}%`, pc.hud.str(h >= 80 ? 209 : h < 50 ? 211 : 210));
  block(97, pc.hud.ui!.get('GEBAEUDEINFO'), pc.hud.str(207), `${t.condition}%`, pc.hud.str(h >= 50 ? 212 : h < 30 ? 214 : 213));
  block(139, goodIcon(pc, 4), pc.hud.str(28), `${t.foodPct}%`, pc.hud.str(t.foodPct >= 100 ? 215 : t.foodPct >= 50 ? 216 : 217), 14);
  text(pc, `${pc.hud.str(193)} ${t.foodRate.toFixed(1)}`, 40, 153, { color: YELLOW });
  text(pc, pc.hud.str(35), 5, 200);
  if (!t.open.length) {
    img(pc, pc.hud.ui!.get('FESTABHALTEN'), 5, 216);
    text(pc, pc.hud.str(136), 45, 216, { w: 145, h: 30, valign: 4 });
    return;
  }
  t.open.forEach((need, i) => {
    const x = 5 + (i % 4) * 47, y = 216 + Math.floor(i / 4) * 47;
    if (need >= 1000) button(pc, goodIcon(pc, need - 1000), x, y, { id: `need:${need}`, tip: goodName(pc, need - 1000, t.race), w: 30, h: 30 });
    else button(pc, pc.hud.portrait(t.race, need), x, y, { id: `need:${need}`, tip: pc.world.rules.get(((t.race << 16) | need) >>> 0)?.name ?? '', w: 45, h: 45 });
  });
}

function stockPage(pc: PageCtx): void {
  header(pc, 'ROHSTOFFE', pc.hud.str(37));
  const t = townOf(pc);
  if (!t) return;
  text(pc, pc.hud.str(130, t.capacity), 5, 45);
  for (let g = 0; g < 9; g++) {
    const s = pc.world.rules.get(((GOODS_GROUP << 16) | g) >>> 0)?.slot ?? g;
    const x = 5 + 60 * Math.floor(s / 3), y = 65 + 30 * (s % 3);
    button(pc, goodIcon(pc, g), x, y, { id: `stock:${g}`, tip: goodName(pc, g, t.race), w: 30, h: 30 });
    text(pc, String(t.stock[g]), x + 35, y, { h: 30, valign: 5 });
  }
  sep(pc, 160);
  wrapped(pc, pc.hud.str(223 + t.race), 5, 168, 172, 30);
  text(pc, '1x', 5, 200, { h: 30, valign: 4 });
  img(pc, goodIcon(pc, 0), 35, 200, 30, 30);
  text(pc, '=2x', 65, 200, { h: 30, valign: 4 });
  img(pc, goodIcon(pc, 4), 95, 200, 30, 30);
  // the ring is the town's standing conversion share (economy.md 7): moving it sends the new value
  // at once (`0041b7a0`), and every later crop delivery is converted by it; UMWANDELN converts that
  // share of the stock now (command value 0xFF)
  const pct = t.cropPct ?? 0;
  slider(pc, 'conv', 5, 230, pct, v => { if (v !== t.cropPct) pc.host.command({ type: 'convert', player: pc.host.player, town: t.id, percent: v }); });
  text(pc, `${pct}%`, 118, 236);
  button(pc, 'UMWANDELN', 150, 225, { id: 'convert', tip: pc.hud.str(182 + t.race), disabled: t.stock[0] <= 0,
    onClick: () => pc.host.command({ type: 'convert', player: pc.host.player, town: t.id, percent: CONVERT_NOW }) });
}

function researchPage(pc: PageCtx): void {
  header(pc, 'FORSCHUNG', pc.hud.str(17));
  const b = pc.sel[0], t = townOf(pc);
  if (!t) return;
  const w = pc.world, p = w.economy.players[t.race];
  const inv = pc.host.data.inventions[t.race] ?? [];
  if (!p) return;
  text(pc, pc.hud.str(18), 0, 39, { font: 'dv10pt', w: 192, align: 1, color: RED });
  const available = inv.filter(i => !w.economy.researched(p, i.index) && i.prerequisites.every(q => w.economy.researched(p, q)));
  if (t.research >= 0) {
    const i = inv[t.research];
    text(pc, i?.name ?? '', 10, 57);
    text(pc, `${Math.trunc((p.progress[t.research] * 100) / Math.max(1, p.costs[t.research]))}%`, 154, 57);
  } else text(pc, pc.hud.str(available.length ? 22 : 21), 10, 57);
  sep(pc, 74);
  const chosen = pc.hud.pageState.inv ?? -1;
  button(pc, 'FORSCHUNGEIN', 10, 79, { id: 'r:start', tip: pc.hud.str(19), disabled: chosen < 0 || t.research >= 0,
    onClick: () => pc.host.command({ type: 'research', player: pc.host.player, town: t.id, invention: chosen }) });
  button(pc, 'FORSCHUNGSTOP', 40, 79, { id: 'r:stop', tip: pc.hud.str(20), disabled: t.research < 0,
    onClick: () => pc.host.command({ type: 'research', player: pc.host.player, town: t.id, invention: -1 }) });
  listBox(pc, 441 - pc.y0 + 0, available.map(i => ({ key: i.index, text: pc.hud.str(23, i.name, i.cost) })), 'inv');
  const d = inv[chosen];
  if (d) wrapped(pc, d.description, 5, 182, 177, 80);
  void b;
}

function historyPage(pc: PageCtx): void {
  header(pc, 'HISTORY', pc.hud.str(24));
  const t = townOf(pc);
  if (!t) return;
  const w = pc.world, p = w.economy.players[t.race];
  const inv = pc.host.data.inventions[t.race] ?? [];
  if (!p) return;
  const done = inv.filter(i => w.economy.researched(p, i.index));
  text(pc, pc.hud.str(25), 10, 44);
  text(pc, pc.hud.str(26, done.length), 100, 44);
  listBox(pc, 401 - pc.y0, done.map(i => ({ key: i.index, text: i.name })), 'hist');
  const d = inv[pc.hud.pageState.hist ?? -1];
  if (d) wrapped(pc, d.description, 5, 145, 177, 110);
}

/** LISTBOX sprite with selectable rows (research lists) at page y */
function listBox(pc: PageCtx, y: number, rows: { key: number; text: string }[], stateKey: string): void {
  const box = pc.hud.ui!.get('LISTBOX');
  img(pc, box, -3, y);
  const fo = f(pc, 'dv7pts2');
  const visible = 3;
  const scrollKey = stateKey + ':scroll';
  const sc = Math.max(0, Math.min(pc.hud.pageState[scrollKey] ?? 0, rows.length - visible));
  for (let i = 0; i < visible && sc + i < rows.length; i++) {
    const r = rows[sc + i];
    const ry = y + 14 + i * fo.height;
    const id = `${stateKey}:${r.key}`;
    const color = pc.hud.pageState[stateKey] === r.key ? '#ffff00' : pc.hud.isHover(id) ? RED : WHITE;
    let s = r.text;
    while (fo.measure(s) > 146 && s.length > 3) s = s.slice(0, -2) + '.';
    fo.draw(pc.hud.g, s, pc.x0 + 5, pc.y0 + ry, color, '#000000');
    pc.hud.addButton({ x: pc.x0 + 5, y: pc.y0 + ry, w: 146, h: fo.height, id, tip: r.text, onClick: () => { pc.hud.pageState[stateKey] = r.key; } });
  }
  if (sc > 0) button(pc, 'SIDE_PFEILOBEN', 160, y + 10, { id: `${stateKey}:up`, tip: '', onClick: () => { pc.hud.pageState[scrollKey] = sc - 1; } });
  if (sc + visible < rows.length) button(pc, 'SIDE_PFEILUNTEN', 160, y + 52, { id: `${stateKey}:down`, tip: '', onClick: () => { pc.hud.pageState[scrollKey] = sc + 1; } });
}

// ---------------------------------------------------------------- building pages (5.5)

function productionPage(pc: PageCtx): void {
  const b = pc.sel[0];
  if (!b) return;
  header(pc, 'PRODUKTION', pc.hud.str(58));
  const r = ruleOf(pc, b), race = b.oid >>> 16;
  if (!r || r.product < 0) return;
  const inputs = pc.world.rules.get(((GOODS_GROUP << 16) | r.product) >>> 0)?.cost ?? [];
  let x = 10;
  inputs.forEach((n, g) => {
    if (!n) return;
    text(pc, `${n}x`, x, 50, { h: 30, valign: 4 });
    button(pc, goodIcon(pc, g), x + 20, 50, { id: `pi:${g}`, tip: goodName(pc, g, race), w: 30, h: 30 });
    x += 60;
  });
  sep(pc, 85);
  img(pc, pc.hud.ui!.get('RAHMEN'), 10, 110);
  img(pc, goodIcon(pc, r.product), 17, 117, 30, 30);
  const o = b.order;
  const pct = o && o.counter > 0 ? (10 - o.counter) * 10 : 0;
  text(pc, `${pct}%`, 100, 110, { font: 'dv18pt', w: 70, h: 45, align: 1, valign: 4 });
  sep(pc, 170);
  text(pc, pc.hud.str(59), 0, 180, { font: 'dv10pt', w: 192, align: 1 });
  x = 10;
  const shown = [...inputs.map((n, g) => (n ? g : -1)).filter(g => g >= 0), r.product];
  for (const g of shown) {
    button(pc, goodIcon(pc, g), x, 205, { id: `ps:${g}`, tip: goodName(pc, g, race), w: 30, h: 30 });
    text(pc, String(b.local[g]), x + 32, 205, { h: 30, valign: 4 });
    x += 55;
  }
}

