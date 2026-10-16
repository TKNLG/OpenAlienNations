// OpenAlienNations server: serves the browser client and the operator's own game files.
// Fully offline, no dependencies. Usage:
//
//   node dist/server.mjs --game "/path/to/Alien Nations" [--music <folder>] [--hd <folder>] [--port 8080] [--host 0.0.0.0]
//
// --music: where the soundtrack is when the game folder has none (the Gold Edition played its
// music from the CD). Any folder with Track02..Track11 files (.ogg, .mp3, .flac or .wav), e.g. the
// GOG install's Bin/music or a rip of the CD's audio tracks.
//
// The game folder is the GOG install (containing Data/ and Bin/). It is served read-only and
// never modified. Lookups are case-insensitive, because the original file names mix case and
// NAS file systems usually do not ignore case.
//
// Packaged builds (single executable, tools/sea/build-sea.mjs) carry the client and the HD pack
// inside the executable and run as a launcher (launcher.ts): without --game they use the saved
// game folder or ask for it, and they open the browser. `--setup` gives the launcher behaviour
// to plain `node dist/server.mjs` runs too. Texts in German or English (i18n.ts, --lang de|en).

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Socket } from 'node:net';
import { acceptUpgrade } from './ws.ts';
import { Lobby } from './lobby.ts';
import { embeddedAssets, type Embedded } from './embedded.ts';
import { resolveGameFolder, lanAddresses, openBrowser, hasGui, waitForEnter, configPath } from './launcher.ts';
import { tr, configureLang, langArg, badLangValue, intlLocale, windowsUiCulture } from './i18n.ts';

interface Options {
  game: string; music: string; hd: string; port: number; host: string;
  /** given on the command line or in the environment (not a default) */
  gameGiven: boolean; portGiven: boolean; hostGiven: boolean;
  setup: boolean; browser: 'auto' | 'yes' | 'no';
}

function parseArgs(argv: string[]): Options {
  const env = process.env;
  const opt: Options = {
    game: env.AN_GAME ?? './game',
    music: env.AN_MUSIC ?? '',
    hd: env.AN_HD ?? '',
    port: Number(env.AN_PORT ?? 8080),
    host: env.AN_HOST ?? '0.0.0.0',
    gameGiven: env.AN_GAME !== undefined, portGiven: env.AN_PORT !== undefined, hostGiven: env.AN_HOST !== undefined,
    setup: false, browser: 'auto',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--game') { opt.game = v; opt.gameGiven = true; i++; }
    else if (a === '--music') { opt.music = v; i++; }
    else if (a === '--hd') { opt.hd = v; i++; }
    else if (a === '--port') { opt.port = Number(v); opt.portGiven = true; i++; }
    else if (a === '--host') { opt.host = v; opt.hostGiven = true; i++; }
    else if (a === '--setup' || a === '--reset') opt.setup = true;
    else if (a === '--no-browser') opt.browser = 'no';
    else if (a === '--open') opt.browser = 'yes';
    else if (a === '--lang') i++; // read before (i18n.ts langArg)
    else if (a.startsWith('--lang=')) { /* likewise */ }
    else if (a === '--version' || a === '-v') { console.log(VERSION); process.exit(0); }
    else if (a === '--help' || a === '-h' || a === '/?') { console.log(tr().usage(configPath())); process.exit(0); }
    else console.warn(tr().unknownOption(a));
  }
  if (!Number.isInteger(opt.port) || opt.port < 0 || opt.port > 65535) { console.warn(tr().badPort); opt.port = 8080; }
  return opt;
}

/** lower-case relative path ("data/dv.gd") -> absolute path */
function indexGameFolder(root: string): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, r);
      else map.set(r.toLowerCase(), abs);
    }
  };
  if (existsSync(root)) walk(root, '');
  return map;
}

/** the game's executables in Bin/ (their resources hold the mouse cursors, docs/ui/cursors.md 7):
 *  the known names first (GOG AN.exe, Gold dvge.exe), then any other .exe there */
function executables(game: Map<string, string>): string[] {
  const known = ['bin/an.exe', 'bin/dvge.exe'];
  const all = [...game.keys()].filter(k => /^bin\/[^/]+\.exe$/.test(k));
  return [...known.filter(k => game.has(k)), ...all.filter(k => !known.includes(k)).sort()];
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.webp': 'image/webp',
};

/** soundtrack files by track number: "Track02.ogg", "02 - xyz.mp3", "track2.flac" -> 2 */
function indexMusic(root: string): Map<number, string> {
  const map = new Map<number, string>();
  if (!root || !existsSync(root)) return map;
  for (const [rel, abs] of indexGameFolder(root)) {
    const m = /(?:^|\/)(?:track\s*)?(\d{1,2})[^/]*\.(ogg|mp3|flac|wav)$/.exec(rel);
    if (m && !map.has(Number(m[1]))) map.set(Number(m[1]), abs);
  }
  return map;
}

/** a static file: on disk, or bytes embedded in the single executable */
type Asset = { file: string } | { data: Uint8Array };

function sendFile(req: IncomingMessage, res: ServerResponse, asset: Asset, mime: string, cache: string): void {
  let size: number, etag: string;
  if ('file' in asset) {
    const st = statSync(asset.file);
    size = st.size;
    etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  } else {
    size = asset.data.length;
    etag = `"${size.toString(16)}-${VERSION}"`; // embedded files only change with the executable
  }
  const body = (start: number, end: number) => {
    if ('file' in asset) createReadStream(asset.file, { start, end }).pipe(res);
    else res.end(asset.data.subarray(start, end + 1));
  };
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', cache);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mime);
  if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range) {
    let start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
    let end = range[1] === '' || range[2] === '' ? size - 1 : Number(range[2]);
    start = Math.max(0, start); end = Math.min(size - 1, end);
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return;
    }
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') { res.end(); return; }
    body(start, end);
    return;
  }
  res.writeHead(200, { 'Content-Length': size });
  if (req.method === 'HEAD') { res.end(); return; }
  if (size === 0) { res.end(); return; }
  body(0, size - 1);
}

/** a file below a folder on disk, or null */
function diskAsset(root: string, rel: string): Asset | null {
  const file = join(root, rel);
  return existsSync(file) && statSync(file).isFile() ? { file } : null;
}

/** a file from the executable ("public/...", "hd/..."), or null */
function embeddedAsset(embedded: Embedded, key: string): Asset | null {
  const data = embedded.get(key);
  return data ? { data } : null;
}

const embedded = embeddedAssets();
const here = embedded ? dirname(process.execPath) : dirname(fileURLToPath(import.meta.url));

/** version from package.json (build.mjs copies it to dist/package.json) */
const VERSION: string = (() => {
  try {
    const text = embedded ? new TextDecoder().decode(embedded.get('package.json') ?? new Uint8Array(0))
                          : readFileSync(join(here, '..', 'package.json'), 'utf8');
    return (JSON.parse(text) as { version?: string }).version ?? 'dev';
  } catch { return 'dev'; }
})();

/** packaged runs: show an error and keep the window open long enough to read it */
async function fatal(message: string, launcher: boolean): Promise<never> {
  console.error(`\n${message}`);
  if (launcher) await waitForEnter();
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // language first: --lang de|en, AN_LANG, else the system language (detected on first use)
  configureLang({ arg: langArg(argv), env: process.env, platform: process.platform, intlLocale: intlLocale(), uiCulture: windowsUiCulture });
  const bad = badLangValue(langArg(argv), process.env);
  if (bad !== null) console.warn(tr().badLang(bad));
  const opt = parseArgs(argv);
  const launcher = embedded !== null || opt.setup;
  if (embedded) process.title = 'OpenAlienNations';
  if (launcher) console.log(`OpenAlienNations ${VERSION}\n`);

  if (launcher && !opt.gameGiven) {
    const chosen = await resolveGameFolder(opt.setup);
    if (!chosen) await fatal(tr().noFolder, launcher);
    else { opt.game = chosen.game; if (!opt.music && chosen.music) opt.music = chosen.music; }
  }

  const publicDir = resolve(here, '..', 'public');
  const gameRoot = resolve(opt.game);
  let game = indexGameFolder(gameRoot);
  const music = indexMusic(opt.music ? resolve(opt.music) : '');
  if (music.size) console.log(tr().soundtrack(resolve(opt.music), music.size));
  // HD UI pack (tools/hdpack): --hd, else built into the executable, else next to dist/
  const hdRoot = opt.hd || !embedded ? resolve(opt.hd || join(here, '..', '..', 'hd')) : '';
  const hdFile = (rel: string): Asset | null => hdRoot ? diskAsset(hdRoot, rel) : embeddedAsset(embedded!, `hd/${rel}`);
  const publicFile = (rel: string): Asset | null => embedded ? embeddedAsset(embedded, `public/${rel}`) : diskAsset(publicDir, rel);
  if (hdFile('manifest.json')) console.log(tr().hdPack(hdRoot || tr().builtIn));
  const hasData = () => game.has('data/dv.gd');

  if (!hasData()) {
    console.warn(tr().noData(gameRoot));
  } else {
    console.log(tr().gameData(gameRoot, game.size));
  }

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = decodeURIComponent(url.pathname);
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }

      if (path === '/api/info') {
        if (!hasData()) game = indexGameFolder(gameRoot);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ gameData: hasData(), version: VERSION, exes: executables(game) }));
        return;
      }

      if (path.startsWith('/hd/')) {
        const rel = path.slice(4);
        if (rel.includes('..')) { res.writeHead(400); res.end(); return; }
        const asset = hdFile(rel);
        if (!asset) { res.writeHead(404); res.end('not found'); return; }
        sendFile(req, res, asset, MIME[extname(rel).toLowerCase()] ?? 'application/octet-stream', rel === 'manifest.json' ? 'no-cache' : 'public, max-age=86400');
        return;
      }
      if (path.startsWith('/game/')) {
        const key = path.slice(6).toLowerCase();
        if (key.includes('..')) { res.writeHead(400); res.end(); return; }
        let file = game.get(key);
        // music: the game folder's own Bin/music first, then the --music folder (any extension)
        const track = /^bin\/music\/track(\d+)\.ogg$/.exec(key);
        if (!file && track) file = music.get(Number(track[1]));
        if (!file) { res.writeHead(404); res.end('not found'); return; }
        sendFile(req, res, { file }, MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
                 'public, max-age=86400');
        return;
      }

      // client files
      if (path === '/' || path === '/client') {
        res.writeHead(302, { Location: `/client/${url.search}` }); res.end(); return;
      }
      const rel = path.endsWith('/') ? `${path.slice(1)}index.html` : path.slice(1);
      if (rel.includes('..')) { res.writeHead(400); res.end(); return; }
      const asset = publicFile(rel);
      if (!asset) { res.writeHead(404); res.end('not found'); return; }
      sendFile(req, res, asset, MIME[extname(rel)] ?? 'application/octet-stream', 'no-cache');
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  const lobby = new Lobby();
  server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws') { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    const ws = acceptUpgrade(req, socket);
    if (ws) lobby.connect(ws);
  });

  // a busy default port moves on to the next one; an explicit --port / AN_PORT must be that port
  let port = opt.port;
  for (let attempt = 0; ; attempt++) {
    const err = await new Promise<(Error & { code?: string }) | null>(done => {
      const onError = (e: Error & { code?: string }) => done(e);
      server.once('error', onError);
      server.listen(port, opt.host, () => { server.off('error', onError); done(null); });
    });
    if (!err) break;
    if (err.code === 'EADDRINUSE' && !opt.portGiven && attempt < 20 && port > 0) {
      console.log(tr().portNext(port));
      port++;
      continue;
    }
    await fatal(err.code === 'EADDRINUSE' ? tr().portBusy(port) : tr().listenFailed(`${opt.host}:${port}`, err.message), launcher);
  }
  port = server.address()?.port ?? port;

  const local = `http://localhost:${port}/`;
  const anyHost = opt.host === '0.0.0.0' || opt.host === '::';
  const loopback = /^(127\.|localhost$|::1$)/.test(opt.host);
  const s = tr();
  const lines = [''];
  if (anyHost || loopback) lines.push(`  ${s.playHere}  ${local}`);
  else lines.push(`  ${s.listeningOn}  http://${opt.host.includes(':') ? `[${opt.host}]` : opt.host}:${port}/`);
  if (anyHost) {
    const lan = lanAddresses();
    if (lan.length) {
      lines.push('', `  ${s.friends}`);
      for (const a of lan) lines.push(`      http://${a}:${port}/`);
      lines.push(`  ${s.internet(port)}`);
    }
  } else if (loopback) {
    lines.push(`  ${s.onlyHere}`);
  }
  lines.push('', `  ${launcher ? s.keepOpen : s.ctrlC}`, '');
  console.log(s.listening(VERSION, `${opt.host}:${port}`));
  console.log(lines.join('\n'));

  // open the browser for packaged runs, unless told not to, the host was chosen (a server setup)
  // or there is no desktop (no DISPLAY / WAYLAND_DISPLAY on Linux, e.g. Docker or ssh)
  if (opt.browser === 'yes' || (opt.browser === 'auto' && launcher && !opt.hostGiven && hasGui())) {
    openBrowser(anyHost || loopback ? local : `http://${opt.host}:${port}/`);
  }
}

main().catch(async err => {
  console.error(err);
  if (embedded) await waitForEnter();
  process.exit(1);
});
