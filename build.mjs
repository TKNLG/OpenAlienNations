// Zero-dependency build: strips TypeScript types with Node's built-in stripper and rewrites
// relative ".ts" imports to ".js". Output in dist/ runs on plain Node >= 18 and in any modern
// browser as native ES modules. No bundler, no network access.
//
//   node build.mjs           -> dist/server/**, dist/public/** (client + shared code)

import { stripTypeScriptTypes } from 'node:module';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

process.removeAllListeners('warning'); // silence the "experimental" notice

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, 'src');
const dist = join(root, 'dist');

function walk(dir) {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function compile(file, outFile) {
  let js = stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' });
  js = js.replace(/(from\s+['"])(\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1$2.js$3')
         .replace(/(import\(\s*['"])(\.{1,2}\/[^'"]+)\.ts(['"]\s*\))/g, '$1$2.js$3');
  writeIfChanged(outFile, js);
}

function writeIfChanged(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  try { if (readFileSync(file, 'utf8') === content) return; } catch { /* new file */ }
  writeFileSync(file, content);
}

let n = 0;
for (const f of walk(src)) {
  const rel = relative(src, f);
  const top = rel.split(/[\\/]/)[0];
  if (extname(f) === '.ts') {
    const js = rel.replace(/\.ts$/, '.js');
    // server code goes to dist/server, everything else (client + shared) to dist/public
    if (top === 'server') compile(f, join(dist, js));
    else compile(f, join(dist, 'public', js));
    // shared code is also needed by the server
    if (top === 'formats' || top === 'world' || top === 'net') compile(f, join(dist, js));
    n++;
  } else {
    const target = top === 'client' ? join(dist, 'public', rel) : join(dist, rel);
    writeIfChanged(target, readFileSync(f, 'utf8'));
  }
}
writeIfChanged(join(dist, 'server.mjs'), "import './server/main.js';\n");
// the version is read by the server (/api/info, --version, console banner)
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
writeIfChanged(join(dist, 'package.json'), JSON.stringify({ type: 'module', version }) + '\n');
console.log(`built ${n} modules into ${relative(root, dist)}/`);
