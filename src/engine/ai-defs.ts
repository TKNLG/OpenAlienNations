// Constants shared by the computer-player modules (ai.ts, ai-town.ts). No imports, so the two
// modules can use them at load time. Spec: docs/game/ai-diplomacy-trade.md.

export const AiJob = {
  Explore: 0x28, Think: 0x30, Planner: 0x32, Economy: 0x33, Military: 0x34, Army: 0x35, Founding: 0x36,
} as const;
const AI_KINDS = new Set<number>(Object.values(AiJob));
export const isAiJob = (kind: number) => AI_KINDS.has(kind);

/** reservation groups (unit +0x48, section 0) */
export const Grp = { None: 0, Porters: 50, Economy: 51, Defence: 52, Army: 53, Founder: 54 } as const;

/** object types used by the AI (inside a race's group, odb.md) */
export const U = {
  Porter: 9, Founder: 10, Builder: 11, Criminal: 12, Diplomat: 13, Farmer: 14, Hunter: 17, Woodcutter: 19, Police: 21,
  Priest: 22, Scholar: 23, Scout: 24, Saboteur: 26, Stonemason: 27, Merchant: 28, Archer: 29, LastSoldier: 36,
} as const;
export const B = {
  House: 37, LargeHouse: 38, Barracks: 39, TownHall: 40, Warehouse: 41, Embassy: 42, CreatureYard: 43, Luxury: 44,
  Farm: 45, Lab: 46, Library: 47, Market: 48, Bank: 49, Mine: 50, SmallOutpost: 52, LargeOutpost: 53, Police: 54,
  School: 55, MageTower: 56, Watchtower: 60, Armoury: 61,
} as const;
export const TYPES = 62;
export const KIND_UNIT = 0, KIND_BUILDING = 1, KIND_NATURE = 2;

/** cells of the square ring of half-size k around (x, y), starting at (+k, -k): +y, then -x, -y, +x (1.5 step 5) */
export function ring(x: number, y: number, k: number): [number, number][] {
  if (k === 0) return [[x, y]];
  const out: [number, number][] = [];
  for (let dy = -k; dy < k; dy++) out.push([x + k, y + dy]);
  for (let dx = k; dx > -k; dx--) out.push([x + dx, y + k]);
  for (let dy = k; dy > -k; dy--) out.push([x - k, y + dy]);
  for (let dx = -k; dx < k; dx++) out.push([x + dx, y - k]);
  return out;
}

