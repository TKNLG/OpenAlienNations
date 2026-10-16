// Front-end entry: creates the menu layer and exports the hook the in-game side panel calls.
// Spec: docs/ui/front-end.md.

import type { GameData, Campaign } from '../data.ts';
import type { Music } from '../audio.ts';
import { MenuAssets } from './assets.ts';
import { FrontEnd } from './layer.ts';
import { FrontEndApp, type GameHost } from './app.ts';

export type { GameHost } from './app.ts';
export { FREEPLAY_CAMPAIGN, applyFreePlay, type FreePlayParams } from './freeplay.ts';

let app: FrontEndApp | null = null;

/** open the in-game options menu (3.11); does nothing outside a running game */
export function openGameMenu(): void { app?.openGameMenu(); }

export interface FrontEndOptions {
  music: Music;
  data: GameData;
  /** resolves once the game data is loaded and the Game exists */
  game: Promise<GameHost>;
  version: string;
  /** dev / tool mode (?c=): a mission is already running; no menus, no mission-end flow */
  running?: { campaign: Campaign; index: number };
}

/** load the menu art and fonts; then show the main menu (or attach to a running game) */
export async function startFrontEnd(o: FrontEndOptions): Promise<FrontEndApp> {
  const assets = await MenuAssets.load();
  const fe = new FrontEnd(assets);
  app = new FrontEndApp(fe, o.music, o.data, o.game, o.version);
  if (o.running) app.attachRunning(o.running.campaign, o.running.index);
  else app.mainMenu();
  return app;
}
