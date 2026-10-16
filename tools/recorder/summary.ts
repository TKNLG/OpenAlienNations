// Summary of an anrec recording (tools/recorder/README.md): seeds, ticks, rand() calls per call
// site inside and outside ticks, recorder overhead. Usage:
//   node --experimental-strip-types --no-warnings tools/recorder/summary.ts <file.bin> [--sites N]
import { readFileSync } from 'node:fs';

const K_HEADER = 0, K_SRAND = 1, K_RAND = 2, K_TICK_START = 3, K_TICK_END = 4, K_SRAND_RAW = 5;
const IN_TICK = 0x100;

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) { console.error('usage: summary.ts <file.bin> [--sites N]'); process.exit(1); }
const sitesArg = args.indexOf('--sites');
const topN = sitesArg >= 0 ? Number(args[sitesArg + 1]) : 25;

const buf = readFileSync(file);
const n = Math.floor(buf.length / 16);
const hex = (v: number) => (v >>> 0).toString(16).padStart(8, '0');

let qpf = 0;
const srands: string[] = [];
const inTick = new Map<number, number>();
const outTick = new Map<number, number>();
let ticks = 0, firstTick = -1, lastTick = -1, firstMs = 0, lastMs = 0, hookUs = 0;
let randIn = 0, randOut = 0, maxPerTick = 0;
const perTick: number[] = [];

for (let i = 0; i < n; i++) {
  const o = i * 16;
  const kind = buf.readUInt32LE(o), tick = buf.readUInt32LE(o + 4);
  const a = buf.readUInt32LE(o + 8), b = buf.readUInt32LE(o + 12);
  switch (kind & 0xff) {
    case K_HEADER: if (i === 1) qpf = a; break;
    case K_SRAND: srands.push(`tick ${tick}: srand(${b}) from ${hex(a)}`); break;
    case K_SRAND_RAW: srands.push(`tick ${tick}: (game asked for ${b}, forced) from ${hex(a)}`); break;
    case K_RAND: {
      const m = kind & IN_TICK ? inTick : outTick;
      m.set(a, (m.get(a) ?? 0) + 1);
      if (kind & IN_TICK) randIn++; else randOut++;
      break;
    }
    case K_TICK_START:
      if (firstTick < 0) { firstTick = tick; firstMs = b; }
      lastMs = b;
      break;
    case K_TICK_END:
      ticks++; lastTick = tick; hookUs = b;
      perTick.push(a); if (a > maxPerTick) maxPerTick = a;
      break;
  }
}

const top = (m: Map<number, number>) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, topN)
  .map(([addr, c]) => `  ${hex(addr)}  ${c}`).join('\n');
const secs = (lastMs - firstMs) / 1000;

console.log(`file ${file}: ${n} records, ${buf.length % 16 ? 'TRAILING BYTES, ' : ''}qpf ${qpf}`);
console.log(`srand:\n${srands.map(s => '  ' + s).join('\n') || '  none'}`);
console.log(`ticks: ${ticks} (counter ${firstTick}..${lastTick}) over ${secs.toFixed(1)} s = ${(ticks / Math.max(secs, 1e-9)).toFixed(2)} ticks/s`);
console.log(`rand: ${randIn} inside ticks (max ${maxPerTick} in one tick, ${perTick.filter(c => c > 0).length} ticks with draws), ${randOut} outside ticks`);
console.log(`recorder time in hooks: ${(hookUs / 1000).toFixed(1)} ms total`);
console.log(`call sites inside ticks (${inTick.size}):\n${top(inTick)}`);
console.log(`call sites outside ticks (${outTick.size}):\n${top(outTick)}`);
