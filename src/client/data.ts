// Loads game data from the server's /game/ endpoint. Large archives are read with HTTP range
// requests so only the needed parts are downloaded.

import { parseGdIndex, gdIndexSize, decodeGdFrames, type GdIndex, type GdEntry } from '../formats/gd.ts';
import { parseOs, type TerrainSet } from '../formats/os.ts';
import { parseOd, type ObjectDesc } from '../formats/od.ts';
import { parseMdb, parseDvm, parseDvmExtras, type Mission, type MapObject, type MapExtras } from '../formats/mission.ts';
import { parseOdb, type ObjectRule } from '../formats/odb.ts';
import { parseIdb, type Invention } from '../formats/idb.ts';
import { parseWdb, type Weapon } from '../formats/wdb.ts';
import { loadRulesAsync, type Rules } from '../formats/addon.ts';
import { parseDvmFile, dvmLayout, type DvmFile } from '../formats/mission.ts';

export async function fetchBytes(path: string, start?: number, end?: number): Promise<Uint8Array> {
  const headers: Record<string, string> = {};
  if (start !== undefined) headers.Range = `bytes=${start}-${end ?? ''}`;
  const r = await fetch(`/game/${path}`, { headers });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function fileSize(path: string): Promise<number> {
  const r = await fetch(`/game/${path}`, { headers: { Range: 'bytes=0-0' } });
  const cr = r.headers.get('Content-Range');
  await r.arrayBuffer();
  if (!cr) throw new Error(`${path}: server did not answer with a range`);
  return Number(cr.split('/')[1]);
}

export interface Campaign { id: string; label: string; mdb: string; mapPrefix: string; }

export const CAMPAIGNS: Campaign[] = [
  { id: 'pimmons', label: 'Pimmons', mdb: 'Pimmons.mdb', mapPrefix: 'Pimmon' },
  { id: 'amazons', label: 'Amazonen', mdb: 'Amazons.mdb', mapPrefix: 'Amazon' },
  { id: 'sajiki', label: 'Sajiki', mdb: 'Sajikis.mdb', mapPrefix: 'Sajiki' },
  { id: 'tutorials', label: 'Tutorials', mdb: 'Tutorials.mdb', mapPrefix: 'Tutorial' },
];

/** the mission pack's island campaigns (Gold Edition; docs/formats/addon.md) */
export const CAMPAIGNS_AO: Campaign[] = [
  { id: 'amazons-ao', label: 'Amazonen (Addon)', mdb: 'AmazonsAO.mdb', mapPrefix: 'Amazon' },
  { id: 'pimmons-ao', label: 'Pimmons (Addon)', mdb: 'PimmonsAO.mdb', mapPrefix: 'Pimmon' },
  { id: 'sajiki-ao', label: 'Sajiki (Addon)', mdb: 'SajikisAO.mdb', mapPrefix: 'Sajiki' },
];
export const FREEPLAY_AO: Campaign = { id: 'infinite-ao', label: 'Endlosspiel (Addon)', mdb: 'InfiniteAO.mdb', mapPrefix: '' };

/** Lazily loaded sprite archive (dv.gd) */
export class SpriteArchive {
  readonly path: string;
  readonly index: GdIndex;
  /** second archive searched for names this one lacks (Addon.gd next to dv.gd) */
  fallback: SpriteArchive | null = null;

  private constructor(path: string, index: GdIndex) { this.path = path; this.index = index; }

  static async open(path: string): Promise<SpriteArchive> {
    const size = await fileSize(path);
    const head = await fetchBytes(path, 0, 23);
    const index = parseGdIndex(await fetchBytes(path, 0, gdIndexSize(head) - 1), size);
    return new SpriteArchive(path, index);
  }

  entry(name: string): GdEntry | undefined { return this.index.byName.get(name) ?? this.fallback?.entry(name); }

  private owns(e: GdEntry): boolean { return this.index.byName.get(e.name) === e; }

  /** Fetch and decode frames 0..lastFrame of one sprite. */
  async frames(e: GdEntry, lastFrame = e.frames - 1): Promise<Uint8Array[]> {
    if (!this.owns(e) && this.fallback) return this.fallback.frames(e, lastFrame);
    const block = await fetchBytes(this.path, e.dataOffset, e.dataOffset + e.dataLength - 1);
    return decodeGdFrames(e, block, lastFrame);
  }

  /**
   * Fetch many sprites with few requests: blocks lying close together in the file are merged
   * into one range request.
   */
  async framesMany(items: { e: GdEntry; lastFrame: number }[]): Promise<Map<GdEntry, Uint8Array[]>> {
    const foreign = this.fallback ? items.filter(i => !this.owns(i.e)) : [];
    if (foreign.length) {
      const mine = await this.framesMany(items.filter(i => this.owns(i.e)));
      for (const [k, v] of await this.fallback!.framesMany(foreign)) mine.set(k, v);
      return mine;
    }
    const sorted = [...new Set(items.map(i => i.e))].sort((a, b) => a.dataOffset - b.dataOffset);
    const want = new Map(items.map(i => [i.e, i.lastFrame]));
    const out = new Map<GdEntry, Uint8Array[]>();
    const GAP = 256 * 1024;
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j + 1 < sorted.length &&
             sorted[j + 1].dataOffset - (sorted[j].dataOffset + sorted[j].dataLength) < GAP) j++;
      const start = sorted[i].dataOffset, end = sorted[j].dataOffset + sorted[j].dataLength;
      const buf = await fetchBytes(this.path, start, end - 1);
      for (let k = i; k <= j; k++) {
        const e = sorted[k];
        const block = buf.subarray(e.dataOffset - start, e.dataOffset - start + e.dataLength);
        out.set(e, decodeGdFrames(e, block, want.get(e) ?? 0));
      }
      i = j + 1;
    }
    return out;
  }
}

export class GameData {
  terrainSets = new Map<string, TerrainSet>();
  objects = new Map<number, ObjectDesc>();
  rules = new Map<number, ObjectRule>();
  sprites!: SpriteArchive;
  /** research trees per race (0 Amazons, 1 Pimmons, 2 Sajiki) */
  inventions: Invention[][] = [[], [], []];
  get researchCosts(): number[][] { return this.inventions.map(l => l.map(i => i.cost)); }
  weapons: Weapon[] = [];

  async load(onProgress: (msg: string) => void): Promise<void> {
    onProgress('Lade Gelände …');
    const names = ['wiese', 'gelbgras', 'schnee', 'rock', 'waldboden', 'gruenwald', 'weg',
                   'wasser1', 'wasser2', 'wasser3', 'wasser4',
                   'transition1', 'transition2', 'transition3', 'transition4'];
    await Promise.all(names.map(async n => {
      this.terrainSets.set(n, parseOs(await fetchBytes(`Data/${n}.os`)));
    }));
    onProgress('Lade Objekte …');
    this.objects = parseOd(await fetchBytes('Data/dv.OD'));
    this.rules = parseOdb(await fetchBytes('Data/dv.odb'));
    this.weapons = parseWdb(await fetchBytes('Data/dv.wdb'));
    this.inventions = await Promise.all(['AMAZONS', 'PIMONS', 'SAJIKI'].map(async d => parseIdb(await fetchBytes(`Data/${d}/DV.idb`))));
    onProgress('Lade Grafik-Index …');
    this.sprites = await SpriteArchive.open('Data/dv.gd');
  }

  /** missions of a campaign in play order (record field +0x00, not file order) */
  async missions(c: Campaign): Promise<Mission[]> {
    return parseMdb(await fetchBytes(`Data/${c.mdb}`)).sort((a, b) => a.order - b.order);
  }

  /** the map's trailing block: AI regions, start camera, initial jobs */
  async mapExtras(m: Mission): Promise<MapExtras | null> {
    if (!m.mapFile) return null;
    return parseDvmExtras(await fetchBytes(`Data/${m.mapFile.replace(/\\/g, '/')}`));
  }

  /** the Gold install's add-on files are present (Addon.odb) */
  async hasAddon(): Promise<boolean> {
    if (this.addonProbe === null) {
      try { const r = await fetch('/game/Data/Addon.odb', { method: 'HEAD' }); this.addonProbe = r.ok; } catch { this.addonProbe = false; }
    }
    return this.addonProbe;
  }
  private addonProbe: boolean | null = null;
  private base: { rules: Map<number, ObjectRule>; objects: Map<number, ObjectDesc>; weapons: Weapon[]; inventions: Invention[][] } | null = null;
  addon: Rules | null = null;
  private addonSprites: SpriteArchive | null = null;
  /** add-on strings (DV.tdb ids 325..330 from Addon.tdb) */
  addonStrings = new Map<number, string>();

  /**
   * Switch the object, weapon and research tables between the base game and the add-on
   * (docs/formats/addon.md: add-on missions load Addon.odb/od/wdb merged into the base tables and
   * AO.idb instead of DV.idb; base missions keep the base tables).
   */
  async useAddon(on: boolean): Promise<void> {
    this.base ??= { rules: this.rules, objects: this.objects, weapons: this.weapons, inventions: this.inventions };
    if (!on) {
      this.rules = this.base.rules; this.objects = this.base.objects; this.weapons = this.base.weapons; this.inventions = this.base.inventions;
      this.sprites.fallback = null;
      return;
    }
    if (!this.addon) {
      const read = async (p: string) => { try { return await fetchBytes(`Data/${p}`); } catch { return null; } };
      this.addon = await loadRulesAsync(read, true);
      this.addonSprites = await SpriteArchive.open('Data/Addon.gd');
      for (const [k, v] of this.addon.strings) if (k >= 325 && k <= 330) this.addonStrings.set(k, v);
    }
    this.rules = this.addon.rules;
    this.objects = this.addon.objects ?? this.base.objects;
    this.weapons = this.addon.weapons;
    this.inventions = this.addon.inventions;
    this.sprites.fallback = this.addonSprites;
  }

  /** a map file with its stored terrain (add-on maps, seed -2) */
  async mapFile(m: Mission): Promise<DvmFile | null> {
    if (!m.mapFile) return null;
    return parseDvmFile(await fetchBytes(`Data/${m.mapFile.replace(/\\/g, '/')}`), dvmLayout(m));
  }

  async map(m: Mission): Promise<MapObject[]> {
    if (!m.mapFile) return [];
    return parseDvm(await fetchBytes(`Data/${m.mapFile.replace(/\\/g, '/')}`));
  }
}
