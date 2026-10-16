// Savegames in the browser: IndexedDB (large, async, binary-friendly) with export/import as
// gzip-compressed files so players can keep backups outside the browser.

import type { WorldSnapshot } from '../engine/world.ts';
import type { Mission } from '../formats/mission.ts';

export interface SaveGame {
  id: string;
  name: string;
  savedAt: number;
  /** what to rebuild the static world from */
  mission: { campaign: string; index: number };
  player: number;
  snapshot: WorldSnapshot;
  /** free play: the mission record with the world-parameter overrides and the seed used */
  missionData?: Mission;
}

export interface SaveInfo { id: string; name: string; savedAt: number; mission: { campaign: string; index: number }; }

const DB = 'an-rebuild', STORE = 'saves', FILE_MAGIC = 'an-rebuild-save';

/**
 * A fresh save id. `crypto.randomUUID` exists only in secure contexts (HTTPS or localhost); a
 * server reached over plain http://host:port (a NAS on the LAN) has none, so fall back to
 * `getRandomValues`, which every context has.
 */
export function newSaveId(): string {
  if (typeof crypto.randomUUID === 'function') { try { return crypto.randomUUID(); } catch { /* fall through */ } }
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(v => v.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** an error with the underlying cause's name and message (DOMException names such as
 *  QuotaExceededError or DataCloneError say more than the message alone) */
function storageError(what: string, cause: unknown): Error {
  const detail = cause instanceof DOMException ? `${cause.name}: ${cause.message}` : cause instanceof Error ? cause.message : String(cause ?? 'unbekannter Fehler');
  return new Error(`${what}: ${detail}`, { cause });
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB nicht verfügbar (privates Fenster oder blockierter Websitespeicher?)')); return; }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(storageError('IndexedDB nicht verfügbar', req.error));
    req.onblocked = () => reject(new Error('IndexedDB blockiert (Spiel in einem anderen Tab geöffnet?)'));
  });
}

/**
 * One request in its own transaction. Writes resolve only when the transaction has committed: a
 * full disk (QuotaExceededError) aborts the transaction after the request itself succeeded.
 */
function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(db => new Promise<T>((resolve, reject) => {
    let result: T;
    const fail = (err: unknown) => { db.close(); reject(storageError(mode === 'readwrite' ? 'Speichern fehlgeschlagen' : 'Lesen fehlgeschlagen', err)); };
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, mode);
      // put() throws synchronously for values structured clone cannot copy (DataCloneError)
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => { result = req.result; };
    } catch (err) { fail(err); return; }
    tx.oncomplete = () => { db.close(); resolve(result); };
    // a failed request aborts the transaction (its error event is not prevented)
    tx.onabort = () => fail(tx.error);
  }));
}

/** ask the browser not to evict our storage under disk pressure (best effort) */
export async function requestPersistence(): Promise<boolean> {
  try { return await navigator.storage?.persist?.() ?? false; } catch { return false; }
}

export const saves = {
  async list(): Promise<SaveInfo[]> {
    const all = await run<SaveGame[]>('readonly', s => s.getAll() as IDBRequest<SaveGame[]>);
    return all.map(({ id, name, savedAt, mission }) => ({ id, name, savedAt, mission }))
      .sort((a, b) => b.savedAt - a.savedAt);
  },
  async put(save: SaveGame): Promise<void> { await run('readwrite', s => s.put(save)); },
  async get(id: string): Promise<SaveGame | undefined> { return run<SaveGame | undefined>('readonly', s => s.get(id) as IDBRequest<SaveGame | undefined>); },
  async remove(id: string): Promise<void> { await run('readwrite', s => s.delete(id)); },

  /** download a save as a .ansave file (gzip-compressed JSON) */
  async exportFile(save: SaveGame): Promise<void> {
    const json = JSON.stringify({ magic: FILE_MAGIC, save });
    const gz = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
    const blob = await new Response(gz).blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${save.name.replace(/[^\p{L}\p{N} _-]+/gu, '_')}.ansave`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  },

  /** read a .ansave file and store it; returns the stored save */
  async importFile(file: File): Promise<SaveGame> {
    const text = await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).text();
    const data = JSON.parse(text) as { magic?: string; save?: SaveGame };
    if (data.magic !== FILE_MAGIC || !data.save) throw new Error('Keine gültige Spielstand-Datei');
    const save = { ...data.save, id: newSaveId() };
    await this.put(save);
    return save;
  },
};
