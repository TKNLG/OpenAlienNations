// Builds the single-executable release (Node SEA) for the platform it runs on:
//
//   node tools/sea/build-sea.mjs [--name AlienNations]   -> build/sea/AlienNations[.exe]
//
// 1. node build.mjs (dist/)
// 2. bundle dist/server/main.js into one CommonJS file with esbuild (SEA needs a single script)
// 3. sea-config.json with the client (dist/public) and the HD pack (hd/) as embedded assets
// 4. node --experimental-sea-config -> blob, copied into a copy of this very node binary with postject
//
// esbuild and postject are CI-only build tools fetched with npx, never runtime dependencies.
// Override them with the environment variables ESBUILD / POSTJECT (a command line each).
// The executable contains our code, the client and the HD pack only, never game data.

import { readdirSync, statSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const name = args.includes('--name') ? args[args.indexOf('--name') + 1] : 'AlienNations';
const out = join(root, 'build', 'sea');
const win = process.platform === 'win32';
const ESBUILD = process.env.ESBUILD || 'npx --yes esbuild@0.28.2';
const POSTJECT = process.env.POSTJECT || 'npx --yes postject@1.0.0-alpha.6';
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const q = s => `"${s}"`;
const sh = cmd => { console.log(`> ${cmd}`); execSync(cmd, { stdio: 'inherit', cwd: root }); };
const walk = dir => readdirSync(dir).flatMap(n => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. dist/
execFileSync(process.execPath, ['build.mjs'], { stdio: 'inherit', cwd: root });

// 2. one CommonJS script. import.meta.url is only read outside the executable (main.ts).
const bundle = join(out, 'server.cjs');
sh(`${ESBUILD} ${q(join(root, 'dist', 'server', 'main.js'))} --bundle --platform=node --format=cjs --target=node22`
   + ` --define:import.meta.url=undefined --log-level=warning --outfile=${q(bundle)}`);

// 3. assets: keys are what src/server/embedded.ts looks up
const assets = { 'package.json': join(root, 'dist', 'package.json') };
for (const f of walk(join(root, 'dist', 'public'))) assets[`public/${relative(join(root, 'dist', 'public'), f).replaceAll('\\', '/')}`] = f;
const hd = join(root, 'hd');
if (existsSync(join(hd, 'manifest.json'))) {
  for (const f of walk(hd)) assets[`hd/${relative(hd, f).replaceAll('\\', '/')}`] = f;
} else {
  console.warn('! hd/manifest.json missing: building without the HD UI pack');
}
const blob = join(out, 'sea-prep.blob');
const config = join(out, 'sea-config.json');
writeFileSync(config, JSON.stringify({
  main: bundle, output: blob, assets,
  disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false,
}, null, 2));
console.log(`${Object.keys(assets).length} embedded files`);
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit', cwd: root });

// 4. inject into a copy of this node binary
const exe = join(out, name + (win ? '.exe' : ''));
copyFileSync(process.execPath, exe);
chmodSync(exe, 0o755);
if (win) {
  // node.exe is signed; the injection breaks that signature, so remove it (best effort, needs the Windows SDK)
  const kits = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  const signtool = existsSync(kits)
    ? readdirSync(kits).filter(v => existsSync(join(kits, v, 'x64', 'signtool.exe'))).sort().map(v => join(kits, v, 'x64', 'signtool.exe')).pop()
    : undefined;
  if (signtool) { try { execFileSync(signtool, ['remove', '/s', exe], { stdio: 'inherit' }); } catch { console.warn('! signtool remove failed'); } }
  else console.warn('! signtool not found, leaving the (now invalid) node.exe signature in place');
}
sh(`${POSTJECT} ${q(exe)} NODE_SEA_BLOB ${q(blob)} --sentinel-fuse ${FUSE}`
   + (process.platform === 'darwin' ? ' --macho-segment-name NODE_SEA' : ''));

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
console.log(`built ${relative(root, exe)} (an-rebuild ${version}, node ${process.version}, ${(statSync(exe).size / 1048576).toFixed(1)} MB)`);
