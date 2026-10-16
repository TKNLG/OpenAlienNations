// Diplomacy: relation table, embassies, diplomats and offers.
// Spec: docs/game/ai-diplomacy-trade.md section 3 (section numbers below), docs/game/combat.md 11,
// docs/formats/mdb.md "Relations".
//
// The relation of a race pair lives in both players' `relations` arrays (economy.ts), always kept
// symmetric here. This module adds the per-player acceptance flags and the diplomat's errand job
// (kind 0x38, "operator errand"). Computer players' flags and offers belong to the AI (3.5) and
// use the same API (`offer`, `setAccept`).

import type { Job } from './scheduler.ts';
import type { World, Entity } from './world.ts';
import type { RaceSetupLite } from './economy.ts';
import { cellOf, enterDoor, exitBuilding, leaveQueues, nearEntity, nearestTo, setIdle, stopWalking, walkToEntity } from './visit.ts';

/** relation states (3.1); hostile in AI and patrol code: 0 and 1 */
export const Rel = { None: 0, War: 1, Ceasefire: 2, Peace: 3 } as const;
export const DiplomacyJob = { Errand: 0x38 } as const;
export const isDiplomacyJob = (kind: number) => kind === DiplomacyJob.Errand;

export const EMBASSY = 42;
export const DIPLOMAT = 13;
const RACES = 3;
const KIND_UNIT = 0, KIND_BUILDING = 1;

/** advisor lines (Mentor.tdb), each + the other race (3.3, 3.4) */
const M = {
  PeaceRefused: 44, PeaceAccepted: 47, CeasefireRefused: 50, CeasefireAccepted: 53, WarDeclared: 56,
  GotPeace: 59, GotCeasefire: 62, GotWar: 65, Embassy: 68,
} as const;

/** errand job data slots */
const ER = { Phase: 0, Target: 1, State: 2, Home: 3, Dest: 4, Size: 5 } as const;
/** errand phases: to the foreign embassy, inside it, back home */
const PH = { Start: 0, ToDest: 1, Inside: 2, Home: 3, ToHome: 4 } as const;

export type DiplomacyCommand =
  /** send the embassy's diplomat with an offer of state 1 war / 2 ceasefire / 3 peace to a race (3.4) */
  | { type: 'diplomacy'; player: number; action: 'offer'; embassy: number; race: number; state: number }
  /** the check boxes: accept ceasefire / peace offers from a race (3.5) */
  | { type: 'diplomacy'; player: number; action: 'accept'; race: number; kind: 'peace' | 'ceasefire'; value: boolean }
  /** "Diplomat zurückbeordern" (3.4 step 6) */
  | { type: 'diplomacy'; player: number; action: 'recall'; embassy: number };

export interface DiplomacySnapshot {
  /** [race][from race]: 1 = accept peace offers from that race */
  acceptPeace: number[][];
  /** [race][from race]: 1 = accept ceasefire offers from that race */
  acceptCeasefire: number[][];
}

/** what the panel shows about a diplomat's errand (3.6 status line) */
export interface Errand { diplomat: number; target: number; state: number; decided: boolean }

const flags = () => Array.from({ length: RACES }, () => new Array<number>(RACES).fill(1));

export class Diplomacy {
  private w: World;
  /** both start at 1 for everybody (3.5, `0045cdf0`) */
  acceptPeace: number[][] = flags();
  acceptCeasefire: number[][] = flags();

  constructor(w: World) { this.w = w; }

  // ---------------------------------------------------------------- relations (3.1, 3.2)

  /** state of a race pair; -1 for the same race (no entry), 0 when neither player exists */
  relation(a: number, b: number): number {
    if (a === b) return -1;
    const pa = this.w.economy.players[a], pb = this.w.economy.players[b];
    return pa?.relations[b] ?? pb?.relations[a] ?? 0;
  }

  /** hostile in AI, patrol and outpost code: no contact or war (3.1, combat.md 2.2) */
  hostile(a: number, b: number): boolean { const r = this.relation(a, b); return r === Rel.None || r === Rel.War; }

  /**
   * Set the state of a race pair (both directions). Trade and the market pages read the state
   * live, so leaving peace ends trading by itself (4.4, combat.md 11). Returns the old state.
   */
  setRelation(a: number, b: number, state: number): number {
    const old = this.relation(a, b);
    if (a === b || a < 0 || b < 0 || a >= RACES || b >= RACES) return old;
    const pa = this.w.economy.players[a], pb = this.w.economy.players[b];
    if (pa) pa.relations[b] = state;
    if (pb) pb.relations[a] = state;
    if (old !== state) this.w.onRelation?.(a, b, state);
    return old;
  }

  /**
   * Campaign maps: the table is rebuilt from the mission race blocks after the map objects exist
   * (3.2, mdb.md "Relations"): for i = 0..2, j = 0..2, i != j, pair {i, j} = block[i].relation[j];
   * the later write wins. This also undoes contacts made by embassies created during map loading.
   */
  initRelations(races: RaceSetupLite[]): void {
    const table: number[][] = Array.from({ length: RACES }, () => new Array<number>(RACES).fill(0));
    for (let i = 0; i < RACES; i++) {
      const block = races.find(r => r.race === i);
      for (let j = 0; j < RACES; j++) {
        if (i === j) continue;
        const v = block?.relations[j] ?? 0;
        table[i][j] = v; table[j][i] = v;
      }
    }
    for (let i = 0; i < RACES; i++) for (let j = i + 1; j < RACES; j++) this.setRelation(i, j, table[i][j]);
  }

  /**
   * Combat hook (combat.md 11): the first impact of `attacker`'s race on `victim`'s race at
   * ceasefire or peace sets the pair to war. Called for every impact; cheap when nothing changes.
   */
  onHit(attacker: number, victim: number): void {
    const r = this.relation(attacker, victim);
    if (r === Rel.Ceasefire || r === Rel.Peace) this.setRelation(attacker, victim, Rel.War);
  }

  // ---------------------------------------------------------------- embassies (3.3)

  private isEmbassy(b: Entity): boolean { return b.kind === KIND_BUILDING && (b.oid & 0xffff) === EMBASSY; }

  /** active embassies of a race, in id order */
  embassies(race: number, except = -1): Entity[] {
    return this.w.entities.filter(b => this.isEmbassy(b) && b.owner === race && b.active && b.id !== except);
  }

  /**
   * Hook: an embassy became active (its diplomat moved in; also at map load). Every other
   * present player hears mentor#(68 + race); every other player still without contact (0) that
   * owns an active embassy is now at war with this race (first contact = war).
   * Messages are not sent at tick 0 (map loading).
   */
  embassyActivated(b: Entity): void {
    if (!this.isEmbassy(b)) return;
    const race = b.owner;
    for (let o = 0; o < RACES; o++) {
      if (o === race || !this.w.economy.players[o]) continue;
      if (this.w.tick > 0) this.notify(o, M.Embassy + race);
    }
    for (let o = 0; o < RACES; o++) {
      if (o === race || !this.w.economy.players[o]) continue;
      if (this.relation(race, o) === Rel.None && this.embassies(o).length) this.setRelation(race, o, Rel.War);
    }
  }

  /**
   * Hook: an embassy stopped operating (diplomat sent out with T312, or the building lost). When
   * the player has no other active embassy, every relation of that player that is not 0 goes
   * back to 0. A diplomat on an errand does not deactivate the embassy.
   */
  embassyDeactivated(b: Entity): void {
    if (!this.isEmbassy(b)) return;
    const race = b.owner;
    if (this.embassies(race, b.id).length) return;
    for (let o = 0; o < RACES; o++) if (o !== race && this.relation(race, o) > 0) this.setRelation(race, o, Rel.None);
  }

  // ---------------------------------------------------------------- acceptance (3.5)

  setAccept(race: number, from: number, kind: 'peace' | 'ceasefire', value: boolean): void {
    if (race < 0 || race >= RACES || from < 0 || from >= RACES || race === from) return;
    (kind === 'peace' ? this.acceptPeace : this.acceptCeasefire)[race][from] = value ? 1 : 0;
  }

  /** would `target` accept `state` from `sender` now (3.4 step 3) */
  accepts(target: number, sender: number, state: number): boolean {
    if (state === Rel.War) return true;
    if (state === Rel.Ceasefire) return this.acceptCeasefire[target][sender] === 1 || this.relation(sender, target) === Rel.Peace;
    if (state === Rel.Peace) return this.acceptPeace[target][sender] === 1;
    return false;
  }

  // ---------------------------------------------------------------- commands (3.6)

  apply(cmd: DiplomacyCommand): void {
    const me = cmd.player;
    if (cmd.action === 'accept') { this.setAccept(me, Math.trunc(cmd.race), cmd.kind === 'peace' ? 'peace' : 'ceasefire', !!cmd.value); return; }
    const b = this.w.get(cmd.embassy);
    if (!b || !this.isEmbassy(b) || b.owner !== me) return;
    if (cmd.action === 'offer') this.offer(b, Math.trunc(cmd.race), Math.trunc(cmd.state));
    else if (cmd.action === 'recall') this.recall(b);
  }

  /**
   * The embassy's diplomat while he still serves it: inside, on an errand, or standing outside
   * after an errand that found no target embassy (3.4 step 2). Not when he is inside another
   * building (sent out with T312 the embassy has no operator any more).
   */
  diplomatOf(b: Entity): Entity | null {
    const d = this.w.get(b.operatorId);
    if (!d || d.kind !== KIND_UNIT || (d.oid & 0xffff) !== DIPLOMAT || d.owner !== b.owner) return null;
    return d.inside === b.id || d.inside < 0 || this.errandJob(d) ? d : null;
  }

  private errandJob(u: Entity): Job | undefined {
    const j = this.w.logistics.mainJob(u);   // also while it waits behind a leave job
    return j && j.kind === DiplomacyJob.Errand ? j : undefined;
  }

  /**
   * Send the diplomat of an active embassy with an offer (3.4 steps 1-2). A diplomat already on
   * an errand is recalled first: the new errand replaces the old one. Returns false when nothing
   * was sent.
   */
  offer(b: Entity, target: number, state: number): boolean {
    const race = b.owner;
    if (!b.complete || !b.active || target < 0 || target >= RACES || target === race) return false;
    if (state !== Rel.War && state !== Rel.Ceasefire && state !== Rel.Peace) return false;
    if (!this.w.economy.players[target]) return false;
    const d = this.diplomatOf(b);
    if (!d) return false;
    if (d.inside >= 0 && d.inside !== b.id) this.w.logistics.leave(d);   // recalled from inside a foreign embassy
    const data = new Array<number>(ER.Size).fill(0);
    data[ER.Phase] = PH.Start; data[ER.Target] = target; data[ER.State] = state; data[ER.Home] = b.id; data[ER.Dest] = -1;
    this.w.logistics.assign(d, DiplomacyJob.Errand, 1, data);
    return true;
  }

  /** "Diplomat zurückbeordern": the errand stops and he walks home (3.4 step 6) */
  recall(b: Entity): void {
    const d = this.diplomatOf(b);
    if (!d || d.inside === b.id) return;
    const j = this.errandJob(d);
    if (!j) {
      // standing outside without an errand: walk home and move back in
      const data = new Array<number>(ER.Size).fill(0);
      data[ER.Phase] = PH.Home; data[ER.Target] = -1; data[ER.Home] = b.id; data[ER.Dest] = -1;
      this.w.logistics.assign(d, DiplomacyJob.Errand, 1, data);
      return;
    }
    const ph = j.data[ER.Phase];
    if (ph === PH.Start || ph === PH.ToDest) {
      leaveQueues(this.w, d);
      stopWalking(this.w, d);
      j.data[ER.Phase] = PH.Home;
    }
  }

  /** the pending errand of a race's diplomats (first in id order), for the panel's status line */
  errand(race: number): Errand | null {
    for (const u of this.w.entities) {
      if (u.kind !== KIND_UNIT || u.owner !== race || (u.oid & 0xffff) !== DIPLOMAT) continue;
      const j = this.errandJob(u);
      if (!j) continue;
      const ph = j.data[ER.Phase];
      return { diplomat: u.id, target: j.data[ER.Target], state: j.data[ER.State], decided: ph >= PH.Inside };
    }
    return null;
  }

  // ---------------------------------------------------------------- the errand job (0x38)

  runJob(job: Job): number {
    if (job.kind !== DiplomacyJob.Errand) return 0;
    const u = this.w.get(job.owner), d = job.data;
    if (!u) return 0;
    for (;;) {
      switch (d[ER.Phase]) {
        case PH.Start: {
          // leave the own embassy (resumed outside), then head for the target race's nearest active embassy
          if (exitBuilding(this.w, u)) return 1;
          const [x, y] = cellOf(u);
          let list = this.embassies(d[ER.Target]);
          if (this.w.addon) {
            // add-on: only embassies on his own island (docs/game/addon.md 9.3); none there: home
            const isl = this.w.islandAt(x, y);
            const own = list.filter(e => this.w.islandAt(...cellOf(e)) === isl);
            if (list.length && !own.length) { d[ER.Phase] = PH.Home; continue; }
            list = own;
          }
          const dest = nearestTo(this.w, list, x, y);
          if (!dest) return this.finish(u);   // none: the errand ends, he stays outside (3.4 step 2)
          d[ER.Dest] = dest.id;
          if (!walkToEntity(this.w, u, dest)) { d[ER.Phase] = PH.Home; continue; }
          d[ER.Phase] = PH.ToDest;
          return 1;
        }
        case PH.ToDest: {
          if (u.path) return 1;
          const dest = this.w.get(d[ER.Dest]);
          // he cannot get in (embassy gone, path blocked): nothing changes, back home (3.4 step 5)
          if (!dest || !dest.active || !nearEntity(this.w, u, dest)) { leaveQueues(this.w, u); d[ER.Phase] = PH.Home; continue; }
          const e = enterDoor(this.w, u, dest);
          if (e) return e;
          this.decide(u.owner, d[ER.Target], d[ER.State]);
          d[ER.Phase] = PH.Inside;
          return 10;
        }
        case PH.Inside:
          d[ER.Phase] = PH.Home;
          if (exitBuilding(this.w, u)) return 1;
          continue;
        case PH.Home: {
          if (exitBuilding(this.w, u)) return 1;
          const home = this.w.get(d[ER.Home]);
          if (!home || !walkToEntity(this.w, u, home)) return this.finish(u);
          d[ER.Phase] = PH.ToHome;
          return 1;
        }
        case PH.ToHome: {
          if (u.path) return 1;
          const home = this.w.get(d[ER.Home]);
          if (!home || !nearEntity(this.w, u, home)) return this.finish(u);
          const e = enterDoor(this.w, u, home);
          if (e) return e;
          // back inside his embassy: the entry rules apply (`00460ed0`): as its stored operator the
          // operator job starts again; an embassy that lost him (a dropped errand, 8.5) is activated anew
          this.w.logistics.unitEntered(u, home);
          return this.finish(u);
        }
        default: return this.finish(u);
      }
    }
  }

  private finish(u: Entity): number {
    u.job = 0;
    if (u.inside < 0 && !u.path) setIdle(this.w, u);
    return 0;
  }

  /**
   * The offer is decided the moment the diplomat is inside (3.4 step 3), by the target's flags.
   * Refusals have no receiver line (indices 82..87 hold no text, 7 item 3).
   */
  decide(sender: number, target: number, state: number): boolean {
    const ok = this.accepts(target, sender, state);
    if (state === Rel.War) { this.notify(sender, M.WarDeclared + target); this.notify(target, M.GotWar + sender); }
    else if (state === Rel.Ceasefire) {
      if (ok) { this.notify(sender, M.CeasefireAccepted + target); this.notify(target, M.GotCeasefire + sender); }
      else this.notify(sender, M.CeasefireRefused + target);
    } else if (state === Rel.Peace) {
      if (ok) { this.notify(sender, M.PeaceAccepted + target); this.notify(target, M.GotPeace + sender); }
      else this.notify(sender, M.PeaceRefused + target);
    }
    if (ok) this.setRelation(sender, target, state);
    return ok;
  }

  /** computer players have no advisor (1.14) */
  private notify(race: number, mentor: number): void {
    const p = this.w.economy.players[race];
    if (p && !p.computer) this.w.notify(race, mentor);
  }

  // ---------------------------------------------------------------- state

  snapshot(): DiplomacySnapshot {
    return { acceptPeace: this.acceptPeace.map(r => [...r]), acceptCeasefire: this.acceptCeasefire.map(r => [...r]) };
  }

  restore(s: DiplomacySnapshot | undefined): void {
    this.acceptPeace = s ? s.acceptPeace.map(r => [...r]) : flags();
    this.acceptCeasefire = s ? s.acceptCeasefire.map(r => [...r]) : flags();
  }

  /** relations (not part of the economy digest) and acceptance flags */
  digest(mix: (v: number) => void): void {
    for (let a = 0; a < RACES; a++) for (let b = a + 1; b < RACES; b++) mix(this.relation(a, b));
    for (const t of [this.acceptPeace, this.acceptCeasefire]) for (const row of t) for (const v of row) mix(v);
  }
}
