// Side-panel pages for trade and diplomacy. Spec: docs/ui/side-panel.md 5.5 (classes 11/12
// market selling/buying, 13 trade route, 14 diplomacy), 3.4 (function bar) and
// docs/game/ai-diplomacy-trade.md 3.6, 4.2, 4.4.
// All positions are page coordinates (origin = panel (4, 335)), like hud-pages.ts.

import type { PageCtx } from './hud-pages.ts';
import type { World, Entity, Command } from '../engine/world.ts';
import type { Town } from '../engine/economy.ts';
import type { BitmapFont, FontName } from './ui-assets.ts';
import { MF, type Trade, type TradeCommand, type MarketField } from '../engine/trade.ts';
import { Rel, type Diplomacy, type DiplomacyCommand } from '../engine/diplomacy.ts';
import { isMarketLike, terminalOf } from './addon-ui.ts';

const GOODS_GROUP = 6;
const GOODS = 9;
const WHITE = '#ffffff', SELECTED = '#ffff00', RED = '#ff0000';
const RACE_TAB = ['AMAZONEN', 'PIMONS', 'SAJIKI'];
const STATE_ICON = ['', 'KRIEG', 'WAFFENSTILLSTAND', 'FRIEDE'];

// ---------------------------------------------------------------- access to the modules

/** the world's trade and diplomacy modules (World.trade / World.diplomacy once integrated) */
const tradeOf = (w: World) => (w as unknown as { trade?: Trade }).trade;
const diplomacyOf = (w: World) => (w as unknown as { diplomacy?: Diplomacy }).diplomacy;

/** commands of these pages; part of the world's Command union once integrated */
function send(pc: PageCtx, cmd: TradeCommand | DiplomacyCommand): void { pc.host.command(cmd as unknown as Command); }

/**
 * Function bar and page rule (3.4, 5.1): the market pages of a finished market are open for the
 * own race and for a race at peace (relation 3) with the viewer. Add-on: every market-like
 * building (record flag 0x20: market and harbour, addon.md 3.3) shows them.
 */
export function marketPagesAllowed(w: World, player: number, m: Entity): boolean {
  if (!isMarketLike(w, m) || !m.complete) return false;
  if (m.owner === player) return true;
  const eco = w.economy;
  return (eco.players[player]?.relations[m.owner] ?? eco.players[m.owner]?.relations[player] ?? 0) === Rel.Peace;
}

// ---------------------------------------------------------------- drawing helpers (as in hud-pages.ts)

function f(pc: PageCtx, n: FontName): BitmapFont { return pc.hud.font(n); }

function text(pc: PageCtx, s: string, x: number, y: number, o: { font?: FontName; color?: string; w?: number; h?: number; align?: number; valign?: number } = {}): void {
  const font = f(pc, o.font ?? 'dv7pts2');
  const tw = font.measure(s);
  let tx = x, ty = y;
  if (o.w !== undefined) tx = o.align === 1 ? x + (o.w - tw) / 2 : o.align === 2 ? x + o.w - tw : x;
  if (o.h !== undefined) ty = o.valign === 4 ? y + (o.h - font.height) / 2 : o.valign === 5 ? y + o.h - font.height : y;
  font.draw(pc.hud.g, s, pc.x0 + tx, pc.y0 + ty, o.color ?? WHITE, '#000000');
}

function wrapped(pc: PageCtx, s: string, x: number, y: number, w: number, h: number, color = WHITE): void {
  const fo = f(pc, 'dv7pts2');
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
                b: { id: string; tip: string; disabled?: boolean; off?: boolean; onClick?: () => void; w?: number; h?: number }): void {
  const c = typeof sprite === 'string' ? pc.hud.ui!.get(sprite) : sprite;
  pc.hud.imageButton(c, pc.x0 + x, pc.y0 + y, { ...b, w: b.w ?? c?.width ?? 30, h: b.h ?? c?.height ?? 30 });
}

function frame(pc: PageCtx, x: number, y: number, w: number, h: number): void {
  pc.hud.g.strokeStyle = '#ffe9a0'; pc.hud.g.lineWidth = 1;
  pc.hud.g.strokeRect(pc.x0 + x + 0.5, pc.y0 + y + 0.5, w - 1, h - 1);
}

const goodName = (pc: PageCtx, g: number, race: number) =>
  g === 0 ? pc.hud.str(220 + race) : pc.world.rules.get(((GOODS_GROUP << 16) | g) >>> 0)?.name ?? '';
const goodIcon = (pc: PageCtx, g: number) => pc.hud.uiIcon(((GOODS_GROUP << 16) | g) >>> 0);
function bubble(pc: PageCtx, g: number): HTMLCanvasElement | undefined {
  const name = pc.hud.uiOd.get(((GOODS_GROUP << 16) | g) >>> 0)?.slots.find(s => s);
  return name ? pc.hud.ui!.get(name.replace(/^RS\\/, 'BUBBLE\\')) : undefined;
}
/** goods in their list order (record +0x124), as on the stock page */
function goodsInSlotOrder(pc: PageCtx): number[] {
  const slot = (g: number) => pc.world.rules.get(((GOODS_GROUP << 16) | g) >>> 0)?.slot ?? g;
  return Array.from({ length: GOODS }, (_, g) => g).sort((a, b) => slot(a) - slot(b) || a - b);
}
const townName = (pc: PageCtx, t: Town) => pc.hud.str(142 + t.race * 10 + (t.nameIndex % 10));
const raceName = (pc: PageCtx, race: number) => pc.hud.str(116 + race);

/** a SLIDERHANDEL bar (113x28) with a RING handle for a value in 0..max */
function valueSlider(pc: PageCtx, id: string, x: number, y: number, value: number, max: number, set: ((v: number) => void) | null): void {
  const bar = pc.hud.ui!.get('SLIDERHANDEL'), ring = pc.hud.ui!.get('RING');
  img(pc, bar, x, y);
  const travel = 91 - 21;
  const pct = max > 0 ? Math.max(0, Math.min(100, (value * 100) / max)) : 0;
  img(pc, ring ? pc.hud.tint(ring, set && pc.hud.isHover(id) ? 'hover' : 'normal') : undefined, x + 10 + (travel * pct) / 100, y + 4);
  text(pc, String(value), x + 118, y, { h: 28, valign: 4 });
  if (!set) return;
  pc.hud.addButton({ x: pc.x0 + x, y: pc.y0 + y, w: 113, h: 28, id, tip: '',
    onDrag: px => {
      const p = Math.max(0, Math.min(100, ((px - pc.x0 - x - 20) * 100) / travel));
      set(Math.round((p * max) / 100));
    } });
}

/** LISTBOX sprite (191x72) at page y with up to 3 rows; `selected` row in yellow */
function listBox(pc: PageCtx, key: string, y: number, rows: { id: number; text: string }[], selected: number, pick: ((id: number) => void) | null): void {
  img(pc, pc.hud.ui!.get('LISTBOX'), -3, y);
  const fo = f(pc, 'dv7pts2'), visible = 3, scrollKey = key + ':scroll';
  const sc = Math.max(0, Math.min(pc.hud.pageState[scrollKey] ?? 0, rows.length - visible));
  for (let i = 0; i < visible && sc + i < rows.length; i++) {
    const r = rows[sc + i];
    const ry = y + 14 + i * fo.height, id = `${key}:${r.id}`;
    let s = r.text;
    while (fo.measure(s) > 146 && s.length > 3) s = s.slice(0, -2) + '.';
    fo.draw(pc.hud.g, s, pc.x0 + 5, pc.y0 + ry, r.id === selected ? SELECTED : pick && pc.hud.isHover(id) ? RED : WHITE, '#000000');
    if (pick) pc.hud.addButton({ x: pc.x0 + 5, y: pc.y0 + ry, w: 146, h: fo.height, id, tip: r.text, onClick: () => pick(r.id) });
  }
  if (sc > 0) button(pc, 'SIDE_PFEILOBEN', 160, y + 10, { id: `${key}:up`, tip: '', onClick: () => { pc.hud.pageState[scrollKey] = sc - 1; } });
  if (sc + visible < rows.length) button(pc, 'SIDE_PFEILUNTEN', 160, y + 52, { id: `${key}:down`, tip: '', onClick: () => { pc.hud.pageState[scrollKey] = sc + 1; } });
}

// ---------------------------------------------------------------- market selling / buying (classes 11 / 12)

/**
 * Logical page 9 (selling) / 10 (buying) for the selected market (5.5). Own markets can be
 * changed; foreign ones (race at peace) are shown read-only, without the start/stop buttons.
 */
export function marketPage(pc: PageCtx, selling: boolean): void {
  header(pc, selling ? 'VERKAUF' : 'EINKAUF', pc.hud.str(selling ? 46 : 49));
  const m = pc.sel[0], tr = tradeOf(pc.world);
  const t = m && pc.world.economy.town(m.town);
  if (!m || !tr || !t) return;
  const own = m.owner === pc.host.player;
  const order = goodsInSlotOrder(pc);
  const good = pc.hud.pageState['mkt:good'] ?? order[0];
  const flagF = selling ? MF.Sell : MF.Buy, stockF = selling ? MF.MinStock : MF.MaxStock, priceF = selling ? MF.MinPrice : MF.MaxPrice;
  const flagName: MarketField = selling ? 'sell' : 'buy';
  const stockName: MarketField = selling ? 'minStock' : 'maxStock';
  const priceName: MarketField = selling ? 'minPrice' : 'maxPrice';
  const setField = (field: MarketField, current: number, value: number) => {
    if (value !== current) send(pc, { type: 'market', player: pc.host.player, town: t.id, good, field, value });
  };

  // selected good and enable / disable
  button(pc, goodIcon(pc, good), 5, 40, { id: 'mkt:sel', tip: goodName(pc, good, t.race), w: 30, h: 30 });
  text(pc, goodName(pc, good, t.race), 40, 40, { h: 30, valign: 4 });
  const on = tr.get(t.id, good, flagF) !== 0;
  if (own) {
    button(pc, 'HANDELSTART', 123, 40, { id: 'mkt:on', tip: pc.hud.str(selling ? 226 : 228), disabled: on, onClick: () => setField(flagName, 0, 1) });
    button(pc, 'HANDELSTOP', 153, 40, { id: 'mkt:off', tip: pc.hud.str(selling ? 227 : 229), disabled: !on, onClick: () => setField(flagName, 1, 0) });
  }

  // the two sliders: stock 0..capacity, price 0..2 x base
  const stock = tr.get(t.id, good, stockF), price = tr.get(t.id, good, priceF);
  text(pc, pc.hud.str(selling ? 44 : 47), 10, 72);
  valueSlider(pc, 'mkt:stock', 10, 85, stock, Math.max(t.capacity, stock), own ? v => setField(stockName, stock, v) : null);
  text(pc, pc.hud.str(selling ? 48 : 45), 10, 112);
  valueSlider(pc, 'mkt:price', 10, 125, price, 2 * tr.basePrice(good), own ? v => setField(priceName, price, v) : null);
  sep(pc, 152);

  // goods grid: click selects; goods not enabled for this side are drawn "off"
  order.forEach((g, i) => {
    const x = 5 + 45 * (i % 4), y = 160 + 45 * Math.floor(i / 4);
    button(pc, goodIcon(pc, g), x, y, { id: `mkt:g${g}`, tip: goodName(pc, g, t.race), w: 30, h: 30, off: tr.get(t.id, g, flagF) === 0,
      onClick: () => { pc.hud.pageState['mkt:good'] = g; } });
    if (g === good) frame(pc, x, y, 30, 30);
    text(pc, String(t.stock[g]), x + 30, y, { h: 30, valign: 5 });
  });
}

// ---------------------------------------------------------------- trade route (class 13)

/**
 * Logical page 11 for a selected own trader (5.5, 4.4): a merchant, or (add-on, flag 0x40) a
 * transport ship trading between harbours of any island (addon.md 5.7). Picking a row in "Von
 * Stadt" / "Zu Stadt" stores that end (both ends known: the route can be started); start / stop.
 */
export function tradeRoutePage(pc: PageCtx): void {
  header(pc, 'HANDEL', pc.hud.str(50));
  const u = pc.sel[0], tr = tradeOf(pc.world);
  if (!u || !tr) return;
  const me = pc.host.player, eco = pc.world.economy;
  const route = tr.routeOf(u);
  const from = route?.from ?? -1, to = route?.to ?? -1;
  const ready = from >= 0 && to >= 0;
  const cmd = (action: 'start' | 'stop') => send(pc, { type: 'route', player: me, unit: u.id, action });
  button(pc, 'HANDELSTART', 10, 35, { id: 'rt:start', tip: pc.hud.str(51), disabled: !ready || route?.paused === false, onClick: () => cmd('start') });
  button(pc, 'HANDELSTOP', 40, 35, { id: 'rt:stop', tip: pc.hud.str(52), disabled: !route || route.paused, onClick: () => cmd('stop') });

  // origin: own towns with an active market (merchants) or harbour (ships)
  text(pc, pc.hud.str(255), 110, 55);
  const terminal = terminalOf(u);
  const own = eco.towns.filter(t => t.alive && t.race === me && tr.hasActiveMarket(t, terminal));
  listBox(pc, 'rt:from', 401 - 335, own.map(t => ({ id: t.id, text: townName(pc, t) })), from,
    id => send(pc, { type: 'route', player: me, unit: u.id, action: 'set', from: id, to: -1 }));

  // the carried good (the original's good buttons have no effect in the simulation, 4.5)
  for (let g = 0; g < GOODS; g++) {
    const bi = bubble(pc, g);
    button(pc, bi ? pc.hud.tint(bi, u.carryAmount > 0 && u.carryGood === g ? 'normal' : 'off') : undefined, 5 + 20 * g, 140,
      { id: `rt:g${g}`, tip: goodName(pc, g, me), w: 15, h: 15 });
  }

  // destination: partners of the origin (own race or at peace), up to 10 per race; harbour towns
  // on any island for a ship, market towns on the merchant's island in add-on games
  text(pc, pc.hud.str(256), 110, 155);
  const base = eco.town(from) ?? eco.town(u.town);
  const partners = base ? tr.partnerLists(base, u).flat() : [];
  listBox(pc, 'rt:to', 501 - 335, partners.map(t => ({ id: t.id, text: t.race === me ? townName(pc, t) : `${townName(pc, t)} (${raceName(pc, t.race)})` })), to,
    id => send(pc, { type: 'route', player: me, unit: u.id, action: 'set', from: -1, to: id }));
}

// ---------------------------------------------------------------- diplomacy (class 14)

/** Logical page 12 for a selected own, finished embassy (5.5, 3.6). */
export function diplomacyPage(pc: PageCtx): void {
  header(pc, 'DIPLOMATIE', pc.hud.str(208));
  const b = pc.sel[0], dip = diplomacyOf(pc.world);
  if (!b || !dip) return;
  const me = pc.host.player;
  // race tabs: only races that have an (active) embassy
  const races = [0, 1, 2].filter(r => r !== me && dip.embassies(r).length > 0);
  if (!races.length) { wrapped(pc, pc.hud.str(309), 5, 40, 180, 30); return; }
  const stored = pc.hud.pageState['dip:race'];
  const race = stored !== undefined && races.includes(stored) ? stored : races[0];
  races.forEach((r, k) => {
    button(pc, RACE_TAB[r], 5 + 35 * k, 40, { id: `dip:tab${r}`, tip: pc.hud.str(236 + r), off: r !== race,
      onClick: () => { pc.hud.pageState['dip:race'] = r; } });
  });

  // current state
  sep(pc, 72);
  text(pc, pc.hud.str(239), 5, 80, { w: 45, h: 30, valign: 4 });
  const state = dip.relation(me, race);
  if (state >= Rel.War) button(pc, STATE_ICON[state], 150, 80, { id: 'dip:state', tip: pc.hud.str(239 + state) });

  // accepted offers
  sep(pc, 110);
  wrapped(pc, pc.hud.str(173), 5, 115, 185, 28);
  const box = (y: number, kind: 'ceasefire' | 'peace', caption: number, value: boolean) => {
    button(pc, value ? 'CHECKED' : 'UNCHECKED', 5, y, { id: `dip:acc:${kind}`, tip: pc.hud.str(caption),
      onClick: () => send(pc, { type: 'diplomacy', player: me, action: 'accept', race, kind, value: !value }) });
    text(pc, pc.hud.str(caption), 40, y, { h: 22, valign: 4 });
  };
  box(145, 'ceasefire', 241, dip.acceptCeasefire[me]?.[race] === 1);
  box(167, 'peace', 242, dip.acceptPeace[me]?.[race] === 1);

  // offers and the diplomat
  sep(pc, 190);
  wrapped(pc, pc.hud.str(175), 5, 196, 140, 60);
  const diplomat = dip.diplomatOf(b);
  const canSend = !!diplomat && b.active;
  ([[Rel.War, 176], [Rel.Ceasefire, 177], [Rel.Peace, 178]] as const).forEach(([s, tip], k) => {
    button(pc, STATE_ICON[s], 150, 198 + 32 * k, { id: `dip:offer${s}`, tip: pc.hud.str(tip), disabled: !canSend,
      onClick: () => send(pc, { type: 'diplomacy', player: me, action: 'offer', embassy: b.id, race, state: s }) });
  });
  const away = !!diplomat && diplomat.inside !== b.id;
  button(pc, pc.hud.portrait(me, 13), 5, 258, { id: 'dip:recall', tip: pc.hud.str(254), w: 45, h: 45, disabled: !away,
    onClick: () => send(pc, { type: 'diplomacy', player: me, action: 'recall', embassy: b.id }) });
  const errand = dip.errand(me);
  if (errand && !errand.decided && errand.state >= Rel.War && errand.state <= Rel.Peace) {
    wrapped(pc, pc.hud.str(229 + errand.state, raceName(pc, errand.target)), 55, 262, 90, 40);
  }
}
