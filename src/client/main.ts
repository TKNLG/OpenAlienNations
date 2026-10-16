// Game client: loads a mission, runs the deterministic simulation, renders terrain + objects.
// Input: left click / drag = select, right click = move order, middle drag / arrows / screen
// edge = scroll, wheel = zoom. Object pictures, selection and picking: docs/rendering/objects.md.

import { GameData, CAMPAIGNS, CAMPAIGNS_AO, FREEPLAY_AO, type Campaign } from './data.ts';
/** every campaign a save or the dev bar may name (base, add-on) */
const ALL_CAMPAIGNS = [...CAMPAIGNS, ...CAMPAIGNS_AO];
import { Camera } from './camera.ts';
import { TerrainRenderer } from './terrain-renderer.ts';
import { SpriteAtlas, SpriteBatch, Compositor, type SpriteDraw } from './sprites.ts';
import { generateTerrain, computeLight, relight, CLASS_TILESET, type Terrain } from '../world/terrain.ts';
import { type PopulateResult } from '../world/populate.ts';
import { buildGeneratedWorld, isGeneratedWorld } from '../world/free-play.ts';
import { addonTerrainFromStored, aoPickTables } from '../world/addon-terrain.ts';
import { animalTypeCount } from '../formats/addon.ts';
import type { DvmFile } from '../formats/mission.ts';
import { World, SUB, TICK_MS, Kind, type Entity } from '../engine/world.ts';
import type { Mission } from '../formats/mission.ts';
import { Lockstep } from '../net/lockstep.ts';
import { NetClient } from './net.ts';
import type { GameSetup, RoomInfo, ServerMsg } from '../net/protocol.ts';
import type { WorldSnapshot } from '../engine/world.ts';
import { saves, requestPersistence, newSaveId, type SaveGame } from './saves.ts';
import { Music } from './audio.ts';
import { fetchBytes } from './data.ts';
import { Minimap } from './minimap.ts';
import { Vision } from './vision.ts';
import { showBriefing } from './briefing.ts';
import { Looks, type Pick } from './looks.ts';
import { Displays, isFish, offsetPixels, type DisplayRng } from './display.ts';
import { compositeHit, frontToBack, categoryOf, chooseSelection, combineSelection, targetUnderCursor, CLICK_PX, CLICK_GROW, DOUBLE_MS,
  commandableUnits, doubleClickUnit, sameTypeNear, type Hit, type HitLayer, type Selection } from './picking.ts';
import { loadSettings } from './frontend/settings.ts';
import { Hud, type HudHost } from './hud.ts';
import { parseOd, type ObjectDesc } from '../formats/od.ts';
import type { ObjectRule } from '../formats/odb.ts';
import { parseTdb } from '../formats/tdb.ts';
import { RACE_UI_DIR } from './ui-assets.ts';
import { Overlay } from './overlay.ts';
import { Sfx } from './sfx.ts';
import { Effects } from './effects.ts';
import { BorderStones, hoverTown } from './border-stones.ts';
import { drawOrder, DrawKind, type DrawItem } from './draw-order.ts';
import { garrisonList, garrisonFeet } from './garrison.ts';
import { orderIntent, INTENT_CURSOR, isShip } from './addon-ui.ts';
import { Slot, cursorCss, selectionHasFighters, worldCursor, loadCursors, EXE_CANDIDATES } from './cursors.ts';
import type { Command as WorldCommand } from '../engine/world.ts';
import { UiImages, loadFonts, type BitmapFont, type FontName } from './ui-assets.ts';
import { startFrontEnd, openGameMenu, FREEPLAY_CAMPAIGN, applyFreePlay } from './frontend/index.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (msg: string) => { $('status').textContent = msg; };
const RACE_NAMES = ['Amazonen', 'Pimmons', 'Sajiki'];


class Game implements HudHost {
  private gl: WebGL2RenderingContext;
  private terrainR: TerrainRenderer;
  private atlas: SpriteAtlas;
  private batch: SpriteBatch;
  /** multi-layer building pictures composed 1:1 before scaling (objects.md 2.1) */
  private comp: Compositor;
  private cam = new Camera(128);
  private terrain: Terrain | null = null;
  world: World | null = null;
  player = 0;
  private lockstep: Lockstep | null = null;
  private looks: Looks;
  /** display state per object: layer players, idle timers (display only, objects.md 2-5) */
  private displays = new Displays();
  /** this frame's drawn objects, back to front, with their layers (objects.md 8: pick candidates) */
  private drawn: { e: Entity; picks: Pick[]; X0: number; Y0: number; depth: number }[] = [];
  /** last click mouse-up (double click, objects.md 8) */
  private lastClick = { t: -1e9, x: 0, y: 0 };
  /** enhanced option: selection rings (cached from the settings) */
  private rings = { at: -1e9, on: false };
  private loadingLooks = false;
  /** enhanced option: smooth constant-speed movement instead of the original's step drawing (cached from the settings) */
  private smooth = { at: -1e9, on: false };
  /** fog of war of the local player (docs/game/fog-of-war.md); display only */
  vision: Vision | null = null;
  /** per-vertex light of the current terrain (updated where the ground changes) */
  private light: Uint8Array | null = null;
  private fogVersion = -1;
  private cheatKeys = '';
  private selected = new Set<number>();
  private keys = new Set<string>();
  private acc = 0;
  private lastT = performance.now();
  private frames = 0;
  private fpsT = performance.now();
  private mouse = { x: -1, y: -1, inside: false };
  private box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private canvas: HTMLCanvasElement;
  readonly data: GameData;
  private minimap: Minimap;
  private hud: Hud;
  private fonts: Map<FontName, BitmapFont> | null = null;
  private uiByRace = new Map<number, Promise<UiImages>>();
  /** building type being placed, -1 = none */
  placing = -1;
  currentTown = -1;
  layers = [true, true, false, false];
  private overlay!: Overlay;
  private sfx = new Sfx();
  private fx!: Effects;
  /** territory border stones (border-stones.ts) and what they read from the view */
  private stones = new BorderStones();
  private stoneHost = { height: (x: number, y: number) => this.heightAt(x, y), visible: (x: number, y: number) => !this.vision || this.vision.cellVisible(x, y) };
  /** patrol waypoint mode: the soldier and the points so far */
  private patrol: { id: number; points: [number, number][] } | null = null;
  /** founder choosing a town-hall site (units-and-jobs.md 11.1) */
  private founding: number | null = null;
  /** world-view cursor (docs/ui/cursors.md 3, 4): the slot the rule chose last ("wanted") */
  private cursorWanted: Slot = Slot.Arrow;
  /** CSS cursor last given to the view */
  private cursorShown = '';
  /** enhanced option: target-based cursor hints (settings cursorHints, cached) */
  private hints = { at: -1e9, on: false };
  /** entity count of the last frame: a removed object re-runs the cursor rule (4.1) */
  private cursorEntities = 0;
  private ownTowns = 0;
  private strings = new Map<number, string>();
  private mentor = new Map<number, string>();
  private uiOdByRace = new Map<number, Promise<Map<number, ObjectDesc>>>();

  constructor(canvas: HTMLCanvasElement, data: GameData) {
    this.canvas = canvas;
    this.data = data;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) throw new Error('WebGL2 wird von diesem Browser nicht unterstützt.');
    this.gl = gl;
    this.terrainR = new TerrainRenderer(gl, data.terrainSets);
    this.atlas = new SpriteAtlas(gl);
    this.batch = new SpriteBatch(gl, this.atlas);
    this.comp = new Compositor(gl, this.batch);
    this.looks = new Looks(data, this.atlas);
    this.addMarkerSprites();
    this.minimap = new Minimap($('minimap'));
    this.hud = new Hud($('hud') as HTMLCanvasElement, $('minimap') as HTMLCanvasElement);
    this.hud.host = this;
    this.hud.onLayout = () => this.resize();
    // the generic UI click on left button down, every panel button (side-panel.md 3.1: Sfx_042)
    this.hud.onClickSound = () => this.sfx.play(42, 0, 0);
    this.hud.onAdvisor = line => this.overlay.advise(line);   // line 12 from the info page (side-panel.md 1.1.5)
    this.overlay = new Overlay($('overlay') as HTMLCanvasElement, this.hud);
    this.minimap.host = this;
    this.fx = new Effects(data);
    this.fx.onSound = (snd, x, y) => this.soundAtCell(snd, x, y);
    this.fx.height = (x, y) => this.heightAt(x, y);
    this.fx.visible = (x, y) => this.pointOnScreen(x, y);
    const ui = $('uiscale') as HTMLSelectElement;
    ui.value = String(Hud.userScale);
    if (ui.selectedIndex < 0) ui.value = '0';
    ui.onchange = () => { Hud.userScale = Number(ui.value); this.hud.layout(); };
    this.minimap.onJump = (x, y) => this.centerOn(x, y);
    // a minimap right-click move plays the same move sample as one in the world view (side-panel.md 6.2)
    this.minimap.onMove = (x, y) => {
      const ids = this.commandable();
      if (!ids.length) return;
      this.command({ type: 'move', player: this.player, ids, x, y });
      this.sfx.play(57, 0, 0);
    };
    this.bindInput();
    requestAnimationFrame(t => this.frame(t));
  }

  /** interface art of the player's race + fonts for the side panel */
  private async loadUi(race: number): Promise<void> {
    let p = this.uiByRace.get(race);
    if (!p) { p = UiImages.load(race); this.uiByRace.set(race, p); }
    let od = this.uiOdByRace.get(race);
    if (!od) { od = fetchBytes(`Data/${RACE_UI_DIR[race] ?? 'PIMONS'}/interface.OD`).then(parseOd); this.uiOdByRace.set(race, od); }
    if (!this.strings.size) {
      const [dv, mentor] = await Promise.all([fetchBytes('Data/DV.tdb'), fetchBytes('Data/Mentor.tdb')]);
      this.strings = parseTdb(dv); this.mentor = parseTdb(mentor);
      // Gold Edition: Addon.tdb (ids 325..330) is merged in every mode (docs/formats/addon.md 5)
      try { for (const [k, v] of parseTdb(await fetchBytes('Data/Addon.tdb'))) if (!this.strings.has(k)) this.strings.set(k, v); } catch { /* base install */ }
    }
    const [ui, uiOd, fonts] = await Promise.all([p, od, this.fonts ? Promise.resolve(this.fonts) : loadFonts()]);
    this.fonts = fonts;
    this.hud.setAssets(ui, uiOd, fonts, this.strings);
    this.overlay.setAssets(fonts, this.mentor);
  }


  /** selection rings: our own generated graphics, not game art (a wide one for ships) */
  private addMarkerSprites(): void {
    const ring = (name: string, w: number, h: number, width: number) => {
      const px = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const nx = (x + 0.5 - w / 2) / (w / 2), ny = (y + 0.5 - h / 2) / (h / 2);
          const r = Math.sqrt(nx * nx + ny * ny);
          const a = Math.max(0, 1 - Math.abs(r - 0.85) / width);
          const i = (y * w + x) * 4;
          px[i] = 255; px[i + 1] = 235; px[i + 2] = 120; px[i + 3] = Math.round(a * 230);
        }
      this.atlas.add(name, w, h, px);
    };
    ring('#ring', 40, 22, 0.12);
    ring('#ringShip', 130, 66, 0.05);
  }

  current: { campaign: string; index: number } | null = null;
  mission: Mission | null = null;
  /** front end (docs/ui/front-end.md): simulation stopped while the single-player menu is open */
  paused = false;
  /** front end: a menu covers the screen, skip rendering */
  hidden = false;
  private netOff: (() => void) | null = null;

  /** load mission `index` (position in play order); player = race to control, default the mission's human race */
  /** `humans`: races played by people (multiplayer); default = the mission's own setting */
  /** `override`: an already modified record (free play, docs/ui/front-end.md 6.2) instead of record `index` */
  async loadMission(c: Campaign, index: number, player?: number, snapshot?: WorldSnapshot, humans?: number[], override?: Mission): Promise<void> {
    this.lockstep = null;
    status('Lade Mission …');
    const m = override ?? (await this.data.missions(c))[index];
    this.player = player ?? (m.humanRace >= 0 ? m.humanRace : 0);
    this.mission = m;
    // add-on missions use the merged object, weapon and research tables (docs/formats/addon.md)
    await this.data.useAddon(!!m.addon);
    await this.loadUi(this.player);
    const pick = CLASS_TILESET.map(n => this.data.terrainSets.get(n)!.pick);
    // maps without a map file (free play, multiplayer random maps): generate and populate the
    // world (docs/formats/world-populate.md); the seed may be re-rolled, the save keeps the final one
    let populated: PopulateResult | null = null;
    let terrain: Terrain;
    let file: DvmFile | null = null;
    const hallOf = (race = this.player) => { const r = this.data.rules.get(((race << 16) | 40) >>> 0); return r ? { sizeX: r.sizeX, sizeY: r.sizeY, radius: r.radius || 25 } : undefined; };
    if (m.addon && m.seed === -2) {
      // add-on campaign map: the terrain is stored in the map file (addon.md 8.2)
      file = await this.data.mapFile(m);
      if (!file?.terrain) throw new Error(`${m.mapFile}: keine Geländedaten`);
      terrain = addonTerrainFromStored(file.terrain);
    } else if (isGeneratedWorld(m)) {
      // free play / random maps, islands in add-on mode (addon.md 9, 10). A save is rebuilt through
      // the same re-roll chain (world/free-play.ts): its record may hold the start seed (saves
      // before October 2026) or the final one; both end on the same terrain. The populated objects
      // of a save are dropped (the snapshot has the entities)
      const g = buildGeneratedWorld(m, {
        player: this.player, humans, hallOf: race => hallOf(race), pick,
        aoPick: m.addon ? aoPickTables(n => this.data.terrainSets.get(n)!.pick) : undefined,
        animalTypes: m.addon ? animalTypeCount(this.data.rules) : undefined,
      });
      terrain = g.terrain;
      populated = g.result;
      if (g.seed !== m.seed) this.mission = { ...m, seed: g.seed };
    } else {
      terrain = generateTerrain(m.seed, m.sizeBits, pick);
    }

    const objs = populated ? populated.objects : file ? file.objects : await this.data.map(m);
    const races = m.races.map(r => (humans ? { ...r, computer: r.present && !humans.includes(r.race) } : r));
    const extras = populated ? { lists: populated.lists, camera: [0, 0] as [number, number], orders: [] } : file ? file.extras : await this.data.mapExtras(m);
    const world = snapshot ? World.restore(terrain, snapshot, this.data.rules, this.data.weapons)
      : new World(terrain, objs, this.data.rules, { races, costs: this.data.researchCosts,
          prerequisites: this.data.inventions.map(l => l.map(i => i.prerequisites)), goals: m.goals, weapons: this.data.weapons, orders: extras?.orders ?? [], lists: extras?.lists });
    // the world may have changed the ground (foundations of map buildings, saved edits): draw it now
    this.terrain = terrain;
    this.cam = new Camera(terrain.size);
    this.resize();
    this.light = computeLight(terrain);
    this.terrainR.setTerrain(terrain, this.light);
    this.minimap.setTerrain(terrain, this.data.terrainSets);
    world.groundEvents.length = 0;
    this.current = { campaign: c.id, index };

    // sprites of every object type on the map (types appearing later are loaded on demand)
    this.looks.clear();
    status('Lade Grafiken …');
    await this.looks.ensure([...world.entities.map(e => e.oid), ...Effects.oids()]);
    this.fx.clear();

    this.world = world;
    // fog of war belongs to this world: created together with it (an older world may still be
    // drawn while this one loads)
    this.vision = new Vision(terrain.size, terrain.sizeBits);
    this.fogVersion = -1;
    if (snapshot) {
      const fog = (snapshot as WorldSnapshot & { fog?: { explored: string; seen: number[] } }).fog;
      this.vision.loadExplored(fog?.explored, fog?.seen);
    }
    this.selected.clear();
    this.displays.clear();
    this.comp.clear();
    this.drawn = [];
    this.placing = -1;
    this.currentTown = world.economy.towns.find(t => t.race === this.player && t.alive)?.id ?? -1;
    this.ownTowns = world.economy.towns.filter(t => t.race === this.player && t.alive).length;
    this.founding = null;
    this.patrol = null;
    this.cursorWanted = Slot.Arrow;   // a new game starts with the arrow (cursors.md 3)
    this.cursorEntities = world.entities.length;
    this.applyCursor();
    const hq = world.entities.find(e => e.kind === Kind.Building && e.owner === this.player)
            ?? world.entities.find(e => e.kind === Kind.Unit && e.owner === this.player)
            ?? world.entities.find(e => e.kind !== Kind.Nature);
    if (hq) { this.cam.x = hq.x / SUB; this.cam.y = hq.y / SUB; }
    else { this.cam.x = this.cam.y = terrain.size / 2; }
    const units = world.entities.filter(e => e.kind === Kind.Unit && e.owner === this.player).length;
    status(`${m.title} — du spielst die ${RACE_NAMES[this.player]} · ${terrain.size}×${terrain.size} · ${units} eigene Einheiten`);
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.canvas.clientWidth * dpr);
    this.canvas.height = Math.round(this.canvas.clientHeight * dpr);
    this.cam.viewW = this.canvas.width;
    this.cam.viewH = this.canvas.height;
  }

  // ---------------------------------------------------------------- input

  private bindInput(): void {
    const dpr = () => window.devicePixelRatio || 1;
    window.addEventListener('resize', () => this.resize());
    this.canvas.addEventListener('contextmenu', e => e.preventDefault());
    let pan: { x: number; y: number } | null = null;
    this.canvas.addEventListener('pointerdown', e => {
      this.canvas.setPointerCapture(e.pointerId);
      const x = e.clientX * dpr(), y = e.clientY * dpr();
      if (e.button === 1) pan = { x: e.clientX, y: e.clientY };
      else if (e.button === 0 && this.patrol) {
        this.patrol.points.push(this.cellAt(x, y));
        if (!e.ctrlKey || this.patrol.points.length >= 7) {
          this.command({ type: 'patrol', player: this.player, id: this.patrol.id, points: this.patrol.points });
          this.patrol = null;
          this.recomputeCursor();
        }
      }
      else if (e.button === 2 && this.patrol) {
        if (this.patrol.points.length) this.command({ type: 'patrol', player: this.player, id: this.patrol.id, points: this.patrol.points });
        this.patrol = null;
        this.recomputeCursor();
      }
      else if (e.button === 0 && this.founding !== null) {
        const [cx, cy] = this.cellAt(x, y);
        if (this.canFoundHere(cx, cy)) { this.command({ type: 'found', player: this.player, unit: this.founding, x: cx, y: cy }); this.founding = null; this.recomputeCursor(); }
      }
      else if (e.button === 2 && this.founding !== null) { this.founding = null; this.recomputeCursor(); }
      else if (e.button === 0 && this.placing >= 0) { if (this.placeAt(x, y) && !e.shiftKey) { this.placing = -1; this.recomputeCursor(); } }
      else if (e.button === 0) this.box = { x0: x, y0: y, x1: x, y1: y };
      else if (e.button === 2 && this.placing >= 0) { this.placing = -1; this.recomputeCursor(); }
      else if (e.button === 2) this.orderMove(x, y);
    });
    this.canvas.addEventListener('pointermove', e => {
      this.mouse = { x: e.clientX * dpr(), y: e.clientY * dpr(), inside: true };
      if (pan) {
        this.cam.pan(-(e.clientX - pan.x) * dpr(), -(e.clientY - pan.y) * dpr());
        pan = { x: e.clientX, y: e.clientY };
      }
      if (this.box) { this.box.x1 = e.clientX * dpr(); this.box.y1 = e.clientY * dpr(); }
    });
    this.canvas.addEventListener('pointerup', e => {
      if (e.button === 1) pan = null;
      if (e.button === 0 && this.box) { this.finishSelection(e.shiftKey, e.ctrlKey, performance.now()); this.box = null; this.recomputeCursor(); }
    });
    // the mouse enters the world view: the cursor rule runs (cursors.md 4.1); leaving it shows the
    // panel's arrow (the side panel and minimap have their own CSS cursors, 5.2)
    this.canvas.addEventListener('pointerenter', () => this.recomputeCursor());
    this.canvas.addEventListener('pointerleave', () => { this.mouse.inside = false; });
    this.canvas.addEventListener('wheel', e => {
      e.preventDefault();
      this.cam.zoom = Math.min(3, Math.max(0.25, this.cam.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    }, { passive: false });
    window.addEventListener('pointerdown', () => {
      this.sfx.unlock();
      // load every record sound and the UI samples up front, so first uses are not silent
      this.sfx.preload([42, 43, 53, 57, 58, 68, 69, ...[...this.data.rules.values()].map(r => r.sound ?? 0)]);
    }, { once: true });
    window.addEventListener('keydown', e => {
      // cheat words (fog-of-war.md 8): MAGICEYE toggles the fog of this display, single player only
      if (e.key.length === 1) {
        this.cheatKeys = (this.cheatKeys + e.key.toUpperCase()).slice(-10);
        if (this.cheatKeys.endsWith('MAGICEYE') && !this.lockstep && this.vision) {
          this.vision.off = !this.vision.off; this.fogVersion = -1; this.cheatKeys = '';
        }
      }
      this.keys.add(e.key); if (e.key === 'Escape' && (this.placing >= 0 || this.founding !== null)) { this.placing = -1; this.founding = null; this.recomputeCursor(); e.preventDefault(); } });
    window.addEventListener('keyup', e => this.keys.delete(e.key));
  }

  /** screen pixel -> map cell, accounting for terrain height (a few refinement steps) */
  private cellAt(sx: number, sy: number): [number, number] {
    const t = this.terrain!, mask = t.size - 1;
    let h = 128;
    let cx = 0, cy = 0;
    for (let k = 0; k < 4; k++) {
      const [wx, wy] = this.cam.unproject(sx, sy + (h - 128) * this.cam.zoom);
      cx = Math.floor(wx); cy = Math.floor(wy);
      h = t.height[((cy & mask) << t.sizeBits) | (cx & mask)];
    }
    return [((cx % t.size) + t.size) % t.size, ((cy % t.size) + t.size) % t.size];
  }

  /**
   * ids of selected entities this player may command: only the "own units" category, so never a
   * criminal selected for inspection (objects.md 8.1, combat.md 12.6)
   */
  private commandable(): number[] {
    const w = this.world;
    if (!w) return [];
    const sel = [...this.selected].map(id => w.get(id)).filter((e): e is Entity => !!e && e.kind === Kind.Unit && e.alive);
    return commandableUnits(sel, this.player).map(e => e.id);
  }

  private orderMove(sx: number, sy: number): void {
    const ids = this.commandable();
    if (!ids.length) return;
    // right-click on an object: work on it (harvest, build, deliver, enter); else walk there
    const hit = this.targetAt(sx, sy);   // objects.md 8.1: anywhere on a drawn sprite
    if (hit) {
      this.command({ type: 'order', player: this.player, ids, target: hit.id });
      this.sfx.play(58, 0, 0);   // order on a target (objects.md 7.2)
      return;
    }
    const [x, y] = this.cellAt(sx, sy);
    this.command({ type: 'move', player: this.player, ids, x, y });
    this.sfx.play(57, 0, 0);     // move order
  }

  /** the current selection with its category (objects.md 8) */
  private currentSelection(): Selection {
    const w = this.world;
    const ids = [...this.selected].filter(id => w?.get(id));
    const first = ids.length ? w!.get(ids[0])! : null;
    const cat = first ? categoryOf(first, this.data.rules.get(first.oid)?.cls ?? -1, this.player) : -1;
    return { cat, ids };
  }

  /** objects of this frame's drawn list with a hit pixel in the screen rectangle, frontmost first */
  private hitsIn(x0: number, y0: number, x1: number, y1: number): Hit[] {
    const z = this.cam.zoom;
    return frontToBack(this.drawn, d => {
      const e = d.e;
      if (e.kind === Kind.Unit && !e.alive) return null;
      const cat = categoryOf(e, this.data.rules.get(e.oid)?.cls ?? -1, this.player);
      if (cat === -1) return null;   // Gold fish are never selectable
      const layers: HitLayer[] = d.picks.map(p => ({ mask: this.looks.mask(p), w: p.entry.width, h: p.entry.height, ox: p.entry.left - p.anchorX, oy: p.entry.top - p.anchorY }));
      return compositeHit(layers, d.X0, d.Y0, z, x0, y0, x1, y1) ? { id: e.id, cat } : null;
    });
  }

  /**
   * double click (objects.md 8): own non-criminal units of the type of the frontmost unit hit
   * (any owner) within 5 cells of it, drawn, up to 12 (nearest first); nothing for a criminal
   */
  private sameTypeAround(id: number): Selection {
    const w = this.world!, u = w.get(id);
    if (!u) return { cat: -1, ids: [] };
    const n = this.cam.mapSize * SUB;
    const wrap = (d: number) => (d > n / 2 ? d - n : d < -n / 2 ? d + n : d);
    const near = this.drawn
      .map(d => d.e)
      .filter(e => e.kind === Kind.Unit && e.alive)
      .map(e => ({ e, d: Math.hypot(wrap(e.x - u.x), wrap(e.y - u.y)) / SUB }));
    return sameTypeNear(u, near, this.player);
  }

  /** mouse-up of the left button: click or box selection (objects.md 8), sfx_043 when not empty */
  private finishSelection(shift: boolean, ctrl: boolean, now: number): void {
    const b = this.box!, w = this.world;
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    let x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1);
    let y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
    const click = x1 - x0 <= CLICK_PX * dpr && y1 - y0 <= CLICK_PX * dpr;
    if (click) { const g = CLICK_GROW * dpr; x0 -= g; y0 -= g; x1 += g; y1 += g; }
    const hits = this.hitsIn(x0, y0, x1, y1);
    let next = chooseSelection(hits, click);
    let dbl = false;
    if (click) {
      const lc = this.lastClick;
      dbl = now - lc.t <= DOUBLE_MS && Math.abs(b.x1 - lc.x) <= 4 * dpr && Math.abs(b.y1 - lc.y) <= 4 * dpr;
      this.lastClick = dbl ? { t: -1e9, x: 0, y: 0 } : { t: now, x: b.x1, y: b.y1 };
      // the frontmost unit of any owner decides; a criminal (or no own unit of its type) gives an
      // empty selection (objects.md 8 "Double click"). No unit hit: ours keeps the click result.
      const anchor = dbl ? doubleClickUnit(hits) : null;
      if (anchor) next = this.sameTypeAround(anchor.id); else dbl = false;
    }
    // a double click only adds with Shift/Ctrl, it never removes (00440e40)
    const sel = dbl ? combineSelection(this.currentSelection(), next, shift || ctrl, false)
      : combineSelection(this.currentSelection(), next, shift, ctrl);
    this.selected = new Set(sel.ids);
    if (sel.ids.length) this.sfx.play(43, 0, 0);
  }

  /**
   * Right-click target and cursor intent (objects.md 8.1): the same pixel test as a click
   * (composite picture of every drawn object, alpha > 192, rectangle grown by 2 px), so a building
   * is hit anywhere on its sprite, not only on its door; the frontmost hit of the first category in
   * the order foreign unit, own unit, nature, foreign building, own building, tree. Selected units
   * are no candidates (ours, so a unit standing at the door does not hide its building).
   */
  private targetAt(px: number, py: number): Entity | null {
    const w = this.world;
    if (!w) return null;
    const z = this.cam.zoom, g = CLICK_GROW * (window.devicePixelRatio || 1);
    const id = targetUnderCursor(this.drawn,
      d => ({ id: d.e.id, kind: d.e.kind, owner: d.e.owner, alive: d.e.alive, cls: this.data.rules.get(d.e.oid)?.cls ?? -1 }),
      d => {
        const layers: HitLayer[] = d.picks.map(p => ({ mask: this.looks.mask(p), w: p.entry.width, h: p.entry.height, ox: p.entry.left - p.anchorX, oy: p.entry.top - p.anchorY }));
        return compositeHit(layers, d.X0, d.Y0, z, px - g, py - g, px + g, py + g);
      }, this.player, this.selected);
    return id < 0 ? null : w.get(id) ?? null;
  }

  /** the town new buildings go to: the current town of the town list (side-panel.md 3.5) */
  private activeTown() {
    const w = this.world;
    if (!w) return undefined;
    const t = w.economy.town(this.currentTown);
    if (t && t.alive && t.race === this.player) return t;
    const first = w.economy.towns.find(x => x.race === this.player && x.alive);
    if (first) this.currentTown = first.id;
    return first;
  }

  // ---------------------------------------------------------------- HudHost

  get selection(): Entity[] {
    const w = this.world;
    if (!w) return [];
    return [...this.selected].map(id => w.get(id)).filter((e): e is Entity => !!e && !(e.kind === Kind.Unit && e.inside >= 0));
  }
  get zoomValue(): number { return Math.round(80 - 64 * this.cam.zoom); }
  set zoomValue(v: number) { this.cam.zoom = Math.max(0.25, Math.min(3, (80 - v) / 64)); }
  startPlacing(type: number): void {
    this.placing = this.placing === type ? -1 : type;
    if (this.placing >= 0) void this.looks.ensureGhost(((this.player << 16) | type) >>> 0);
    this.recomputeCursor();   // placing: hidden over the world view (cursors.md 5.4); ended: the rule
  }
  select(ids: number[]): void { this.selected = new Set(ids); }
  centerOn(x: number, y: number): void {
    const n = this.cam.mapSize;
    this.cam.x = ((x % n) + n) % n + 0.5; this.cam.y = ((y % n) + n) % n + 0.5;
  }
  openMenu(): void { this.onMenu(); }
  /** set by the front end: opens the in-game options menu */
  onMenu: () => void = () => {};
  get playerTowns() { return this.world?.economy.towns.filter(t => t.race === this.player && t.alive) ?? []; }

  /** fog-of-war.md 6: placement needs the footprint grown by one cell to be in sight */
  private inSight(r: { sizeX: number; sizeY: number }, x: number, y: number): boolean {
    const v = this.vision;
    if (!v) return true;
    const fx = Math.max(1, r.sizeX), fy = Math.max(1, r.sizeY);
    for (let dy = -1; dy <= fy; dy++) for (let dx = -1; dx <= fx; dx++) if (!v.cellVisible(x - fx + 1 + dx, y - fy + 1 + dy)) return false;
    return true;
  }

  /** place the building being placed at a screen point; true if the command was sent */
  private placeAt(sx: number, sy: number): boolean {
    const w = this.world, t = this.activeTown();
    if (!w || !t || this.placing < 0) return false;
    const [x, y] = this.cellAt(sx, sy);
    const r = w.rules.get(((this.player << 16) | this.placing) >>> 0);
    if (!r || !w.logistics.canPlace(t, r, x, y) || !this.inSight(r, x, y)) return false;
    this.command({ type: 'build', player: this.player, town: t.id, building: this.placing, x, y });
    return true;
  }

  // ---------------------------------------------------------------- loop

  private frame(t: number): void {
    requestAnimationFrame(tt => this.frame(tt));
    if (!this.paused && !this.hidden) this.scroll();
    const w = this.world;
    if (w && !this.paused) {
      this.acc += Math.min(250, t - this.lastT);
      while (this.acc >= TICK_MS) {
        if (this.lockstep) {
          if (!this.lockstep.step()) { this.acc = Math.min(this.acc, TICK_MS); break; } // waiting for others
          if (this.lockstep.desync) status(`Achtung: Spielstände weichen ab (Tick ${this.lockstep.desync.tick})`);
        } else {
          w.step();
        }
        this.acc -= TICK_MS;
      }
    }
    this.lastT = t;
    if (this.hidden) return;
    // ground changed by foundations and worn paths (units-and-jobs.md 6.6, 4.5)
    if (w && w.groundEvents.length && this.terrain && this.light) {
      for (const [x0, y0, x1, y1] of w.groundEvents.splice(0)) {
        relight(this.terrain, this.light, x0 - 1, y0 - 1, x1 + 1, y1 + 1);
        this.terrainR.updateRegion(x0 - 1, y0 - 1, x1 + 1, y1 + 1);
        this.minimap.refresh(x0, y0, x1, y1);
      }
    }
    if (w) this.pruneSelection(w);
    if (w) {
      // an object left the world: the cursor rule runs again (cursors.md 4.1)
      if (w.entities.length < this.cursorEntities) this.recomputeCursor();
      this.cursorEntities = w.entities.length;
      if (this.frames % 3 === 1) this.updateHints(w, t);
    }
    // placement mode: hovering another own town's territory makes it the current town (economy.md 11.7)
    if (w && this.mouse.inside && (this.placing >= 0 || this.founding !== null)) this.currentTown = hoverTown(w, ...this.cellAt(this.mouse.x, this.mouse.y), this.player, this.currentTown);
    if (w && this.vision) {
      this.vision.update(w, this.player);
      if (this.vision.version !== this.fogVersion) {
        this.fogVersion = this.vision.version;
        this.terrainR.setFog(this.vision.size, this.vision.off ? null : this.vision.shade);
      }
    }

    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.05, 0.05, 0.08, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.terrain && w) {
      this.terrainR.draw(this.cam, t);
      // territory border stones: ground decals after the terrain, before every object (rendering/territory.md 3)
      this.stones.refresh(w.territory);
      this.batch.draw(this.stones.sprites(this.cam, this.stoneHost, this.data.objects, this.atlas.rects), this.cam.zoom, this.cam.viewW, this.cam.viewH);
      this.batch.draw(this.sprites(this.paused ? 0 : this.acc / TICK_MS, t), this.cam.zoom, this.cam.viewW, this.cam.viewH);
    }
    this.drawBox();
    if (w && this.frames % 4 === 2) this.minimap.draw(w, this.cam, this.vision);
    if (w) this.hud.tickMoney(w, this.player);   // money counter: one step per world frame (side-panel.md 3.6)
    if (this.frames % 4 === 0) this.hud.draw();
    if (w) {
      // a newly founded town becomes the current town (11.2)
      const own = w.economy.towns.filter(x => x.race === this.player && x.alive);
      if (own.length > this.ownTowns) this.currentTown = own[own.length - 1].id;
      this.ownTowns = own.length;
      this.overlay.draw(w, this.player, this.placing >= 0 || this.founding !== null, this.patrol ? 'Linksklick: Wegpunkt (Strg: weitere) · Rechtsklick: fertig' : '');
    }
    this.frames++;
    if (t - this.fpsT > 1000) {
      $('fps').textContent = `${Math.round((this.frames * 1000) / (t - this.fpsT))} fps`;
      this.frames = 0; this.fpsT = t;
    }
  }

  /** units that went into a building or boarded a ship, and dead objects, leave the selection */
  private pruneSelection(w: World): void {
    for (const id of this.selected) {
      const e = w.get(id);
      if (!e || (e.kind === Kind.Unit && (e.inside >= 0 || !e.alive))) this.selected.delete(id);
    }
  }

  /**
   * The world-view cursor rule (docs/ui/cursors.md 4): patrol mode, else the sword when the first
   * selected object is own and a hunter, saboteur or soldier (Gold: warship) is selected, else the
   * arrow. Runs only on the events of 4.1, and applies the result at once.
   */
  private recomputeCursor(): void {
    const w = this.world;
    this.cursorWanted = worldCursor(!!this.patrol, !!w && selectionHasFighters(this.selection, this.player, w.addon));
    this.applyCursor();
  }

  /** give the view its CSS cursor: hidden while placing or founding (5.4), else the wanted slot or a hint */
  private applyCursor(hint: string | null = null): void {
    const cur = this.placing >= 0 || this.founding !== null ? 'none' : hint ?? cursorCss(this.cursorWanted);
    if (cur !== this.cursorShown) { this.cursorShown = cur; this.canvas.style.cursor = cur; }
  }

  /**
   * Enhanced option (settings cursorHints, off by default): what a right-click on the object
   * under the mouse would do (attack, board, harvest, order) overrides the rule's cursor; a plain
   * move keeps it. The original has no such cursors (cursors.md 7.1).
   */
  private updateHints(w: World, now: number): void {
    if (now - this.hints.at > 1000) {
      const on = loadSettings().cursorHints;
      if (this.hints.on && !on) this.applyCursor();
      this.hints = { at: now, on };
    }
    if (!this.hints.on) return;
    let hint: string | null = null;
    if (this.mouse.inside && this.placing < 0 && this.founding === null && !this.patrol && !this.box) {
      const units = this.commandable().map(id => w.get(id)!).filter(Boolean);
      if (units.length) hint = INTENT_CURSOR[orderIntent(w, this.player, units, this.targetAt(this.mouse.x, this.mouse.y))];
    }
    this.applyCursor(hint);
  }

  private scroll(): void {
    const step = 14 * (window.devicePixelRatio || 1);
    const k = this.keys, m = this.mouse, edge = 4;
    let dx = 0, dy = 0;
    if (k.has('ArrowLeft') || k.has('a')) dx -= step;
    if (k.has('ArrowRight') || k.has('d')) dx += step;
    if (k.has('ArrowUp') || k.has('w')) dy -= step;
    if (k.has('ArrowDown') || k.has('s')) dy += step;
    if (m.inside && document.fullscreenElement) {
      if (m.x < edge) dx -= step; if (m.x > this.cam.viewW - edge) dx += step;
      if (m.y < edge) dy -= step; if (m.y > this.cam.viewH - edge) dy += step;
    }
    if (dx || dy) this.cam.pan(dx, dy);
  }

  /** play a sound at a cell (volume and pan from its place on screen) */
  private soundAtCell(snd: number, x: number, y: number): void {
    const t = this.terrain;
    if (!t) return;
    if (this.vision && !this.vision.cellVisible(Math.floor(x), Math.floor(y))) return;
    const [sx, sy] = this.toScreen({ id: -1, x: x * SUB + SUB / 2, y: y * SUB + SUB / 2 } as Entity);
    const cam = this.cam;
    this.sfx.play(snd, (sx - cam.viewW / 2) / (cam.viewW / 2), (sy - cam.viewH / 2) / (cam.viewH / 2));
  }

  /** terrain height of a cell (wrapped) */
  private heightAt(x: number, y: number): number {
    const t = this.terrain;
    if (!t) return 128;
    const m = t.size - 1;
    return t.height[((Math.floor(y) & m) << t.sizeBits) | (Math.floor(x) & m)];
  }

  /** a ground point (cells) is visible under fog and inside the view (projectiles.md 2.2, 5) */
  private pointOnScreen(x: number, y: number): boolean {
    if (!this.terrain) return false;
    if (this.vision && !this.vision.cellVisible(Math.floor(x), Math.floor(y))) return false;
    const cam = this.cam;
    const [px, py] = Camera.project(cam.nearest(x, cam.x) - cam.x, cam.nearest(y, cam.y) - cam.y, this.heightAt(x, y));
    const hw = cam.viewW / 2 / cam.zoom + 32, hh = cam.viewH / 2 / cam.zoom + 64;
    return Math.abs(px) <= hw && Math.abs(py) <= hh;
  }

  /** start choosing patrol waypoints for a soldier (side-panel.md 5.2: click = one point, Ctrl adds more) */
  startPatrol(id: number): void {
    this.patrol = { id, points: [] }; this.placing = -1; this.founding = null;
    // the PATROL button sets the patrol cursor directly (cursors.md 4.1); it shows over the world view
    this.cursorWanted = Slot.Patrol;
    this.applyCursor();
  }

  startFounding(id: number): void {
    this.founding = id; this.placing = -1; this.patrol = null;
    void this.looks.ensureGhost(((this.player << 16) | 40) >>> 0);
    this.recomputeCursor();   // hidden over the world view (5.4)
  }

  /** 11.1 click test: free area, flat enough, outside every town area, in sight */
  private canFoundHere(x: number, y: number): boolean {
    const w = this.world;
    const r = w?.rules.get(((this.player << 16) | 40) >>> 0);
    return !!w && !!r && w.logistics.canFound(this.player, x, y, true) && this.inSight(r, x, y);
  }

  /**
   * How often a unit's work action (2) plays (unit-motion.md 3). The simulation only says "work";
   * the original's action message also carries a repeat count. Single cycles: the founder's work
   * animation at the new town hall (found job 0x0E, units-and-jobs.md 11.3: loop parameter 0) and
   * heal strikes (heal job 0x29, priests: the strike plays WO once, projectiles.md 1), and the
   * news seller at each house (news round 0x1A, repeat count 0, units-and-jobs.md 8.6).
   * Everything else that works (gathering, building, planting) loops until the action changes.
   */
  private workCycles(w: World, e: Entity): number {
    if (e.kind !== Kind.Unit || e.action !== 2) return Infinity;
    if ((e.oid & 0xffff) === 22) return 1;                       // priest: healing strikes
    const job = e.job ? w.sched.get(e.job) : undefined;
    return job && (job.kind === 0x0e || job.kind === 0x29 || job.kind === 0x1a) ? 1 : Infinity;
  }

  /**
   * The display's idle timer fired for a unit on screen (objects.md 5.2, unit-motion.md 4): send
   * the fidget command through the normal command path, with the display RNG. Sent for own units,
   * and by the host (or single player) for computer-owned and unowned units, so that every unit
   * fidgets once per timer in multiplayer (unit-motion.md 4.4 deviation).
   */
  private fidget(e: Entity, rng: DisplayRng): void {
    const w = this.world;
    if (!w || this.paused || !e.alive || e.inside >= 0) return;
    const type = e.oid & 0xffff;
    if (type >= 64 && type <= 67) return;                       // Gold: no fidgets for ships 64..67
    if (e.job !== 0 || e.path) return;                          // the simulation would ignore it
    const p = e.owner >= 0 ? w.economy.players[e.owner] : undefined;
    const host = !this.lockstep || this.lockstep.slot === 0;
    if (e.owner !== this.player && !(host && (!p || p.computer))) return;
    let dir = -1, play = false;
    if (rng() % 2 === 0) {
      if (this.looks.hasSlot(e.oid, 27)) { dir = 3; play = true; }          // ID3
      else if (this.looks.hasSlot(e.oid, 29)) { dir = 5; play = true; }     // ID5
    }
    if (dir < 0) dir = rng() % 8;
    this.command({ type: 'fidget', player: this.player, unit: e.id, dir, play });
  }

  /**
   * The building being placed, under the cursor (objects.md 6): the finished slot with all
   * layers at frame 0, not animated, green when the spot is allowed, red if not; normal alpha.
   */
  private ghost(out: SpriteDraw[]): void {
    const w = this.world, t = this.activeTown();
    const founding = this.founding !== null;
    if (!w || (!t && !founding) || (this.placing < 0 && !founding) || !this.mouse.inside) return;
    const oid = ((this.player << 16) | (founding ? 40 : this.placing)) >>> 0;
    const r = w.rules.get(oid);
    const [x, y] = this.cellAt(this.mouse.x, this.mouse.y);
    const ok = founding ? this.canFoundHere(x, y) : !!r && !!t && w.logistics.canPlace(t, r, x, y) && this.inSight(r, x, y);
    const g = this.looks.ghost(oid, ok);
    if (!g) { void this.looks.ensureGhost(oid); return; }
    const cam = this.cam, tr = this.terrain!;
    const h = tr.height[((y & (tr.size - 1)) << tr.sizeBits) | (x & (tr.size - 1))];
    const [gx, gy] = [cam.nearest(x + 0.5, cam.x), cam.nearest(y + 0.5, cam.y)];
    const [sx0, sy0] = Camera.project(gx - cam.x, gy - cam.y, h);
    out.push(...this.picture(ok ? -2 : -3, g.picks, sx0, sy0, 1e9, g.keys));
  }

  /**
   * Screen position (device px) of an entity's ground point. A unit in a step is drawn at its
   * destination minus the remaining offset of its display (unit-motion.md 2.3), whole pixels in
   * the original's mode, with the height between the two cells' heights.
   */
  private toScreen(e: Entity): [number, number] {
    const cam = this.cam;
    const x = e.x / SUB, y = e.y / SUB;
    let h = this.heightAt(x, y), ox = 0, oy = 0;
    const u = e.id >= 0 ? this.displays.peek(e.id)?.unit : undefined;
    if (u && (u.ox || u.oy)) {
      const h0 = this.heightAt(e.stepFromX / SUB, e.stepFromY / SUB);
      h = h0 + (h - h0) * u.hk;
      [ox, oy] = offsetPixels(u.ox, u.oy, !this.smooth.on);
    }
    const gx = cam.nearest(x, cam.x), gy = cam.nearest(y, cam.y);
    const [sx, sy] = Camera.project(gx - cam.x, gy - cam.y, h);
    return [(sx - ox) * cam.zoom + cam.viewW / 2, (sy - oy) * cam.zoom + cam.viewH / 2];
  }

  private sprites(alpha: number, wall: number): SpriteDraw[] {
    const w = this.world!, t = this.terrain!, cam = this.cam;
    const out: SpriteDraw[] = [];
    const halfW = cam.viewW / 2 / cam.zoom + 300, halfH = cam.viewH / 2 / cam.zoom + 400;
    const mask = t.size - 1;
    const now = w.tick + alpha;
    const vis = this.vision;
    const drawn: typeof this.drawn = [];
    const rings = this.ringsOn(wall);
    const rng = this.displays.rng;
    const smooth = this.smoothOn(wall);
    let missing = false;
    // draw order (objects.md 12): every object's sprites are collected with its anchor cell and get
    // their depth from the rank of drawOrder() at the end
    const items: DrawItem[] = [];
    const groups: SpriteDraw[][] = [];
    const anchor = (cx: number, cy: number): [number, number] =>
      [Math.floor(cam.nearest((cx & mask) + 0.5, cam.x)), Math.floor(cam.nearest((cy & mask) + 0.5, cam.y))];
    /** a unit left the drawn list: its idle timer restarts (objects.md 5.1) */
    const offScreen = (e: Entity) => {
      if (e.kind !== Kind.Unit) return;
      const d = this.displays.peek(e.id);
      if (d?.drawn) { d.timer.reset(rng); d.drawn = false; }
    };
    for (const e of w.entities) {
      if (e.kind === Kind.Unit && e.inside >= 0) { offScreen(e); continue; }
      const rule = this.data.rules.get(e.oid);
      const fog = vis ? vis.drawState(e, rule) : 2;
      // buildings and fish keep display state (doors, layers, idle timer) also while not drawn
      const stateful = e.kind === Kind.Building || isFish(e.oid);
      if (fog === 0 && !stateful) { offScreen(e); continue; }
      if (this.looks.missing(e)) { missing = true; continue; }
      const disp = this.displays.get(e.id);
      // units and animals: step drawing, facing and action animation (unit-motion.md 1-3)
      if (Looks.moves(e, rule)) this.looks.motion(e, rule, disp, { t: now, wall, tickMs: TICK_MS, smooth, workCycles: this.workCycles(w, e) });
      const [sx0, sy0] = this.toScreen(e);
      const sx = (sx0 - cam.viewW / 2) / cam.zoom, sy = (sy0 - cam.viewH / 2) / cam.zoom;
      const onScreen = fog !== 0 && Math.abs(sx) <= halfW && Math.abs(sy) <= halfH;
      if (!onScreen && !stateful) { offScreen(e); continue; }
      const view = this.looks.view(e, rule, now, wall, disp, onScreen, rng);
      if (!onScreen || !view.picks.length) continue;
      const dim: [number, number, number, number] | undefined = fog === 1 ? [0.5, 0.5, 0.5, 1] : undefined;
      if (e.kind === Kind.Unit) {
        // the display's idle timer: fidgets of standing units (objects.md 5.1, 5.2)
        disp.drawn = true;
        if (disp.timer.update(wall, disp.unit?.busy ?? false, rng)) this.fidget(e, rng);
      }
      // a unit's record sound plays at its action event (unit-motion.md 3: frame >= sound frame);
      // a building's when one of its random layers starts (objects.md 4.3)
      if (view.sound && rule) {
        const k = e.kind === Kind.Building ? 0.5 : 1;
        this.sfx.play(rule.sound, ((sx0 - cam.viewW / 2) / (cam.viewW / 2)) * k, ((sy0 - cam.viewH / 2) / (cam.viewH / 2)) * k);
      }
      // anchor cell: a unit's cell (the step's destination while walking), a building's front corner
      const [ax, ay] = anchor(Math.floor(e.x / SUB), Math.floor(e.y / SUB));
      const g: SpriteDraw[] = [];
      const sel = this.selected.has(e.id);
      if (sel && rings) {
        const big = e.kind === Kind.Unit && isShip(w, e);
        const ring = this.atlas.rects.get(big ? '#ringShip' : '#ring')!;
        g.push({ page: ring.page, r: ring.r, x: sx - (big ? 65 : 20), y: sy - (big ? 33 : 11), depth: -0.5 });
      }
      const pic = this.picture(e.id, view.picks, sx, sy, 0);
      for (const d of pic) g.push({ ...d, tint: dim, boost: sel });
      // an outpost's garrison, right after the building's own sprites, in slot order (objects.md 13.2)
      if (e.kind === Kind.Building && rule?.cls === 6 && e.complete) {
        if (this.garrison(e, rule, sx, sy, sx0, sy0, now, wall, smooth, dim, g)) missing = true;
      }
      items.push({ kind: e.kind === Kind.Building ? DrawKind.Building : e.kind === Kind.Unit ? DrawKind.Unit : DrawKind.Nature,
        x: ax, y: ay, sx: rule?.sizeX || 2, sy: rule?.sizeY || 2 });
      groups.push(g);
      drawn.push({ e, picks: view.picks, X0: sx0, Y0: sy0, depth: 0 });
    }
    if (this.frames % 120 === 0) this.displays.prune(id => !!w.get(id));
    this.ghost(out);
    this.comp.sweep();
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);   // composing used its own
    this.fx.drain(w, now, wall);
    for (const d of this.fx.update(now, wall, t.size)) {
      const ar = this.atlas.rects.get(`${d.entry.name}#${d.frame}`);
      if (!ar) continue;
      if (vis && !vis.cellVisible(Math.floor(d.x), Math.floor(d.y))) continue;
      const gx = cam.nearest(d.x, cam.x), gy = cam.nearest(d.y, cam.y);
      const h = d.h ?? t.height[((Math.floor(d.y) & mask) << t.sizeBits) | (Math.floor(d.x) & mask)];
      const [px, py] = Camera.project(gx - cam.x, gy - cam.y, h);
      // effects: at their cell in base order, after the object anchored there, never deferred (12.4)
      const [ax, ay] = anchor(Math.floor(d.x), Math.floor(d.y));
      items.push({ kind: DrawKind.Effect, x: ax, y: ay });
      groups.push([{ page: ar.page, r: ar.r, x: px + d.ox - d.anchorX + d.entry.left, y: py + d.oy - d.anchorY + d.entry.top, depth: 0 }]);
    }
    const order = drawOrder(items);
    const rankOf = new Int32Array(items.length);
    order.forEach((i, r) => { rankOf[i] = r; });
    for (let i = 0; i < groups.length; i++) for (const d of groups[i]) out.push({ ...d, depth: rankOf[i] + d.depth });
    for (let i = 0; i < drawn.length; i++) drawn[i].depth = rankOf[i];
    this.drawn = drawn.sort((a, b) => a.depth - b.depth);
    if (missing && !this.loadingLooks) {
      this.loadingLooks = true;
      void this.looks.ensure(w.entities.map(e => e.oid)).finally(() => { this.loadingLooks = false; });
    }
    return out;
  }

  /**
   * Garrison units of an outpost (objects.md 13.2): each one's feet on the building canvas pixel
   * (points[k].x, points[k].y + 22), slot k = its place in the garrison list, with its own facing
   * and action (standing pose, the strike row once per shot). Not in the drawn list, so they are
   * never clicked or boxed (13.3), and they have no idle timer (no fidgets). True if a unit's
   * pictures are still missing.
   */
  private garrison(b: Entity, rule: ObjectRule, sx: number, sy: number, sx0: number, sy0: number,
    now: number, wall: number, smooth: boolean, dim: [number, number, number, number] | undefined, g: SpriteDraw[]): boolean {
    const w = this.world!, cam = this.cam;
    const desc = this.data.objects.get(b.oid);
    if (!desc) return false;
    let missing = false;
    garrisonList(w, b).forEach((u, k) => {
      if (this.looks.missing(u)) { missing = true; return; }
      const ur = this.data.rules.get(u.oid);
      const ud = this.displays.get(u.id);
      this.looks.motion(u, ur, ud, { t: now, wall, tickMs: TICK_MS, smooth, workCycles: this.workCycles(w, u) });
      const v = this.looks.view(u, ur, now, wall, ud, true, this.displays.rng);
      if (!v.picks.length) return;
      if (v.sound && ur) this.sfx.play(ur.sound, (sx0 - cam.viewW / 2) / (cam.viewW / 2), (sy0 - cam.viewH / 2) / (cam.viewH / 2));
      const [fx, fy] = garrisonFeet(rule.points, k, desc.anchorX, desc.anchorY);
      for (const d of this.picture(u.id, v.picks, sx + fx, sy + fy, 0.1 + 0.01 * Math.min(k, 50))) g.push({ ...d, tint: dim });
    });
    return missing;
  }

  /**
   * Sprites of one object at (x, y) (zoom-1 view coordinates). Several layers are composed 1:1
   * into one picture first, so the scaled result has no seams along the layer rectangles.
   * `keys`: atlas keys per pick (default name#frame).
   */
  private picture(key: number, picks: Pick[], x: number, y: number, depth: number, keys?: string[]): SpriteDraw[] {
    const parts: SpriteDraw[] = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    picks.forEach((pk, k) => {
      const a = this.atlas.rects.get(keys?.[k] ?? `${pk.entry.name}#${pk.frame}`);
      if (!a) return;
      const px = pk.entry.left - pk.anchorX, py = pk.entry.top - pk.anchorY;
      parts.push({ page: a.page, r: a.r, x: px, y: py, depth: k });
      x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px + a.r.w); y1 = Math.max(y1, py + a.r.h);
    });
    if (parts.length <= 1) return parts.map(d => ({ ...d, x: x + d.x, y: y + d.y, depth }));
    const sig = parts.map(d => `${d.page}:${d.r.u0},${d.r.v0}`).join('|');
    const c = this.comp.compose(key, sig, parts.map(d => ({ ...d, x: d.x - x0, y: d.y - y0 })), x1 - x0, y1 - y0);
    return [{ page: c.page, r: c.r, x: x + x0, y: y + y0, depth }];
  }

  /** enhanced option: smooth movement (settings smoothMovement); off = the original's step drawing */
  private smoothOn(now: number): boolean {
    if (now - this.smooth.at > 1000) this.smooth = { at: now, on: loadSettings().smoothMovement };
    return this.smooth.on;
  }

  /** selection rings: off in the original (it tints, objects.md 7.1); option for the enhanced mode */
  private ringsOn(now: number): boolean {
    if (now - this.rings.at > 1000) this.rings = { at: now, on: loadSettings().selectionRings };
    return this.rings.on;
  }

  private drawBox(): void {
    const b = this.box, el = $('selbox');
    const dpr = window.devicePixelRatio || 1;
    if (!b || (Math.abs(b.x1 - b.x0) <= CLICK_PX * dpr && Math.abs(b.y1 - b.y0) <= CLICK_PX * dpr)) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.style.left = `${Math.min(b.x0, b.x1) / dpr}px`; el.style.top = `${Math.min(b.y0, b.y1) / dpr}px`;
    el.style.width = `${Math.abs(b.x1 - b.x0) / dpr}px`; el.style.height = `${Math.abs(b.y1 - b.y0) / dpr}px`;
  }

  /** capture the running single-player game as a savegame */
  makeSave(name: string): SaveGame | null {
    if (!this.world || !this.current) return null;
    return {
      id: newSaveId(), name, savedAt: Date.now(), mission: this.current,
      player: this.player,
      snapshot: { ...this.world.snapshot(), fog: this.vision ? { explored: this.vision.saveExplored(), seen: [...this.vision.seen] } : undefined } as WorldSnapshot,
      missionData: (this.current.campaign === FREEPLAY_CAMPAIGN.id || this.current.campaign === FREEPLAY_AO.id) ? this.mission ?? undefined : undefined,
    };
  }

  async loadSave(save: SaveGame): Promise<void> {
    const c = ALL_CAMPAIGNS.find(x => x.id === save.mission.campaign) ?? [FREEPLAY_CAMPAIGN, FREEPLAY_AO].find(x => x.id === save.mission.campaign);
    if (!c) throw new Error('Unbekannte Kampagne im Spielstand');
    await this.loadMission(c, save.mission.index, save.player, save.snapshot, undefined, save.missionData);
    status(`Spielstand „${save.name}“ geladen`);
  }

  get multiplayer(): boolean { return this.lockstep !== null; }
  get playerRace(): number { return this.player; }
  /** the human player's mission outcome: 0 playing, 1 won, -1 lost (docs/ui/front-end.md 3.12) */
  get outcome(): number { return this.world?.economy.players[this.player]?.outcome ?? 0; }
  /** the player owns a unit or building (free-play worlds start empty until the populator exists) */
  get ownsAnything(): boolean { return !!this.world?.entities.some(e => e.owner === this.player && e.kind !== Kind.Nature); }

  /** stop the running game (front end: end game, before loading another one) */
  endGame(): void {
    this.netOff?.(); this.netOff = null;
    this.lockstep = null;
    this.world = null;
    this.terrain = null;
    this.selected.clear();
    this.placing = -1;
    this.box = null;
    this.patrol = null;
    this.founding = null;
    this.cursorWanted = Slot.Arrow;   // reset to the arrow when a game ends (cursors.md 3)
    this.applyCursor();
  }

  command(cmd: WorldCommand): void {
    if (this.lockstep) this.lockstep.issue(cmd);
    else this.world?.schedule(cmd);
  }

  /** start a lockstep game: same map for everyone, this client controls `you` */
  /** `slotRaces`: race per slot chosen in the lobby (free-play setup, mode 'random') */
  async startMultiplayer(setup: GameSetup, players: number, you: number, net: NetClient, slotRaces?: number[]): Promise<void> {
    const c = ALL_CAMPAIGNS.find(x => x.id === setup.campaign) ?? CAMPAIGNS[0];
    const early: ServerMsg[] = [];
    this.netOff?.();
    const off = net.on(m => { if (this.lockstep) this.lockstep.receive(m); else early.push(m); });
    this.netOff = off;
    let races: number[];
    if (setup.mode === 'random') {
      // free play from the host's world parameters (docs/ui/front-end.md 3.13, 6.2); every client
      // builds the same record: no mission goals in multiplayer, the last survivor wins
      races = [...(slotRaces ?? [])];
      for (const r of [0, 1, 2]) if (!races.includes(r)) races.push(r);
      const base = (await this.data.missions(FREEPLAY_CAMPAIGN))[0];
      const fp = applyFreePlay(base, { size: 1, resources: setup.resources ?? 2, development: setup.development ?? 2, stock: setup.stock ?? 2, players }, setup.seed ?? 1);
      const m = { ...fp, sizeBits: setup.sizeBits ?? fp.sizeBits, goals: [] };
      await this.loadMission(FREEPLAY_CAMPAIGN, races[you], races[you], undefined, races.slice(0, players), m);
    } else {
      // slot 0 plays the mission's human race, further slots the other present races
      const m = (await this.data.missions(c))[setup.mission ?? 0];
      races = [m.humanRace, ...m.races.filter(r => r.present && r.race !== m.humanRace).map(r => r.race)]
        .filter(r => r >= 0);
      for (const r of [0, 1, 2]) if (!races.includes(r)) races.push(r);
      await this.loadMission(c, setup.mission ?? 0, races[you], undefined, races.slice(0, players));
    }
    this.lockstep = new Lockstep(this.world!, you, players, msg => net.send(msg), races);
    for (const m of early) this.lockstep.receive(m);
    status(`Mehrspieler: ${players} Spieler, du bist Spieler ${you + 1} (${RACE_NAMES[this.player]})`);
  }

  /** start a lockstep game from a finished free-play record: the front end's lobby
   *  (frontend/multiplayer.ts) builds `m` from the start message, identical on every client;
   *  `slotRaces` = race of each human slot, the record's other present races are computer players */
  async startLockstep(c: Campaign, m: Mission, slotRaces: number[], you: number, net: { on: NetClient['on']; send: NetClient['send'] }): Promise<void> {
    const early: ServerMsg[] = [];
    this.netOff?.();
    this.netOff = net.on(msg => { if (this.lockstep) this.lockstep.receive(msg); else early.push(msg); });
    await this.loadMission(c, 0, slotRaces[you], undefined, slotRaces, m);
    this.lockstep = new Lockstep(this.world!, you, slotRaces.length, msg => net.send(msg), slotRaces);
    for (const msg of early) this.lockstep.receive(msg);
    status(`Mehrspieler: ${slotRaces.length} Spieler, du bist Spieler ${you + 1} (${RACE_NAMES[this.player]})`);
  }

  /** test hook: select all own units and order them to a cell */
  debugOrderAll(x: number, y: number): number {
    const w = this.world!;
    const ids = w.entities.filter(e => e.kind === Kind.Unit && e.owner === this.player).map(e => e.id);
    ids.forEach(id => this.selected.add(id));
    this.command({ type: 'move', player: this.player, ids, x, y });
    return ids.length;
  }
}


async function main(): Promise<void> {
  const info = await (await fetch('/api/info')).json() as { gameData: boolean; version?: string; exes?: string[] };
  // the game's own mouse cursors, from its executable (docs/ui/cursors.md 7); CSS keywords until then
  void loadCursors(info.exes ?? EXE_CANDIDATES);
  if (!info.gameData) {
    $('bar').hidden = false;
    status('Keine Spieldaten gefunden. Bitte den Alien-Nations-Ordner (mit Data/ und Bin/) im Spiele-Verzeichnis des Servers ablegen.');
    return;
  }
  const params = new URLSearchParams(location.search);
  const win = window as unknown as { anReady: boolean; anGame: Game; anMenu: unknown };
  const data = new GameData();
  if (!params.has('c') && !params.has('dev')) {
    // normal start: the original's menus (docs/ui/front-end.md); game data loads meanwhile
    const music = new Music();
    fetchBytes('Data/CDAudio.ini').then(b => music.configure(new TextDecoder('latin1').decode(b))).catch(() => {});
    const game = data.load(status).then(() => {
      const g = new Game($('view'), data);
      g.hidden = true;
      g.onMenu = openGameMenu;
      win.anGame = g;
      return g;
    });
    win.anMenu = await startFrontEnd({ music, data, game, version: info.version ?? '' });
    return;
  }
  // developer / tool mode (?c=..&m=.. or ?dev): load a mission directly, dev bar with ?dev
  if (params.has('dev')) $('bar').hidden = false;
  await data.load(status);
  const game = new Game($('view'), data);
  game.onMenu = openGameMenu;

  const campSel = $<HTMLSelectElement>('campaign'), missSel = $<HTMLSelectElement>('mission');
  for (const c of ALL_CAMPAIGNS) campSel.add(new Option(c.label, c.id));
  const fillMissions = async () => {
    const c = ALL_CAMPAIGNS.find(x => x.id === campSel.value)!;
    missSel.innerHTML = '';
    (await data.missions(c)).forEach((m, i) => missSel.add(new Option(`${i + 1}. ${m.title}`, String(i))));
  };
  const load = () => game.loadMission(ALL_CAMPAIGNS.find(x => x.id === campSel.value)!, Number(missSel.value))
    .then(() => { if (game.mission && !new URLSearchParams(location.search).has('nobrief')) void showBriefing(game.mission, game.playerRace, data.rules); })
    .catch(err => { console.error(err); status(String(err)); });
  campSel.addEventListener('change', async () => { await fillMissions(); await load(); });
  missSel.addEventListener('change', load);

  setupLobby(game, campSel, missSel);
  setupSaves(game);
  const music = new Music();
  fetchBytes('Data/CDAudio.ini').then(b => music.configure(new TextDecoder('latin1').decode(b))).catch(() => {});
  const mb = $('musicbtn');
  mb.textContent = music.on ? '♪ an' : '♪ aus';
  mb.onclick = () => { mb.textContent = music.toggle() ? '♪ an' : '♪ aus'; };

  campSel.value = params.get('c') ?? 'pimmons';
  await fillMissions();
  missSel.value = params.get('m') ?? '0';
  await load();
  win.anGame = game;
  win.anReady = true;
  // Escape / the panel's disk icon open the options menu here too
  const running = ALL_CAMPAIGNS.find(x => x.id === campSel.value);
  if (running) void startFrontEnd({ music, data, game: Promise.resolve(game), version: info.version ?? '', running: { campaign: running, index: Number(missSel.value) } }).catch(err => console.error(err));
}

function setupSaves(game: Game): void {
  const panel = $('saves'), list = $('savelist');
  const fmt = (t: number) => new Date(t).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
  const refresh = async () => {
    list.innerHTML = '';
    const all = await saves.list();
    if (!all.length) list.innerHTML = '<div class="dim">Noch keine Spielstände.</div>';
    for (const info of all) {
      const row = document.createElement('div'); row.className = 'row';
      const label = document.createElement('span'); label.className = 'grow';
      label.textContent = `${info.name} · ${fmt(info.savedAt)}`;
      const load = document.createElement('button'); load.textContent = 'Laden';
      load.onclick = async () => { const s = await saves.get(info.id); if (s) { panel.hidden = true; await game.loadSave(s); } };
      const exp = document.createElement('button'); exp.textContent = 'Exportieren'; exp.title = 'Als Datei herunterladen';
      exp.onclick = async () => { const s = await saves.get(info.id); if (s) await saves.exportFile(s); };
      const del = document.createElement('button'); del.textContent = '✕'; del.title = 'Löschen';
      del.onclick = async () => { await saves.remove(info.id); await refresh(); };
      row.append(label, load, exp, del);
      list.append(row);
    }
  };
  $('savebtn').onclick = async () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) await refresh();
  };
  $('dosave').onclick = async () => {
    if (game.multiplayer) { status('Speichern im Mehrspielermodus kommt später.'); return; }
    const name = ($<HTMLInputElement>('savename').value.trim()) || `Spielstand ${new Date().toLocaleString('de-DE')}`;
    try {
      const s = game.makeSave(name);
      if (!s) return;
      await requestPersistence();
      await saves.put(s);
      status(`Gespeichert: ${name}`);
      await refresh();
    } catch (err) {
      console.error('Speichern fehlgeschlagen', err);
      status(`Speichern fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  $<HTMLInputElement>('importfile').onchange = async ev => {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try { await saves.importFile(f); await refresh(); status('Spielstand importiert'); }
    catch (err) { status(String(err instanceof Error ? err.message : err)); }
    (ev.target as HTMLInputElement).value = '';
  };
}

function setupLobby(game: Game, campSel: HTMLSelectElement, missSel: HTMLSelectElement): void {
  const net = new NetClient();
  const panel = $('lobby'), list = $('rooms'), roomBox = $('room'), nameIn = $<HTMLInputElement>('pname');
  try { nameIn.value = localStorage.getItem('an.name') ?? ''; } catch { /* storage unavailable */ }
  let inRoom: RoomInfo | null = null, you = -1;
  const render = (rooms: RoomInfo[] | null) => {
    if (inRoom) {
      roomBox.innerHTML = '';
      const h = document.createElement('div');
      h.textContent = `Raum „${inRoom.name}“ – ${inRoom.players.length}/${inRoom.maxPlayers} Spieler`;
      roomBox.append(h);
      for (const p of inRoom.players) {
        const d = document.createElement('div');
        d.textContent = `${p.slot + 1}. ${p.name}${p.slot === you ? ' (du)' : ''}`;
        roomBox.append(d);
      }
      const start = document.createElement('button');
      start.textContent = 'Spiel starten';
      start.disabled = you !== 0;
      start.onclick = () => net.send({ t: 'start' });
      const leave = document.createElement('button');
      leave.textContent = 'Verlassen';
      leave.onclick = () => net.send({ t: 'leave' });
      roomBox.append(start, leave);
    } else roomBox.innerHTML = '';
    if (rooms) {
      list.innerHTML = rooms.length ? '' : '<div class="dim">Keine offenen Spiele.</div>';
      for (const r of rooms) {
        const b = document.createElement('button');
        b.textContent = `${r.name} (${r.players.length}/${r.maxPlayers}) – ${r.host}`;
        b.onclick = () => net.send({ t: 'join', room: r.id });
        list.append(b);
      }
    }
  };
  net.on(m => {
    if (m.t === 'rooms') render(m.rooms);
    else if (m.t === 'room') { inRoom = m.room; you = m.you; render(null); }
    else if (m.t === 'left') { inRoom = null; render(null); net.send({ t: 'list' }); }
    else if (m.t === 'error') status(m.message);
    else if (m.t === 'start') {
      panel.hidden = true;
      game.startMultiplayer(m.setup, m.players, m.you, net).catch(err => status(String(err)));
    }
  });
  const connect = async () => {
    const name = nameIn.value.trim() || 'Spieler';
    try { localStorage.setItem('an.name', name); } catch { /* storage unavailable */ }
    await net.connect(name);
  };
  $('mp').onclick = async () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { await connect(); net.send({ t: 'list' }); }
  };
  $('refresh').onclick = () => net.send({ t: 'list' });
  $('create').onclick = async () => {
    await connect();
    net.send({
      t: 'create', name: `${nameIn.value.trim() || 'Spieler'}s Spiel`, maxPlayers: 4,
      setup: { mode: 'mission', campaign: campSel.value, mission: Number(missSel.value) },
    });
  };
}

main().catch(err => { console.error(err); status(`Fehler: ${err instanceof Error ? err.message : err}`); });
