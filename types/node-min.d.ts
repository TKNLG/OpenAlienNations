// Minimal Node.js declarations for type-checking without @types/node (npm is not reachable
// from the build environment). Only what this project uses.

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exit(code?: number): never;
  platform: string;
  title: string;
  execPath: string;
  stdin: { isTTY?: boolean };
  stdout: { isTTY?: boolean; write(s: string): boolean };
  /** Node >= 22.3 / 20.16 */
  getBuiltinModule?: (id: string) => unknown;
};

declare module 'node:http' {
  export interface IncomingMessage { url?: string; method?: string; headers: Record<string, string | undefined>; }
  export interface ServerResponse {
    headersSent: boolean;
    setHeader(name: string, value: string | number): void;
    writeHead(status: number, headers?: Record<string, string | number>): void;
    end(data?: string | Uint8Array): void;
  }
  export interface Server {
    listen(port: number, host: string, cb?: () => void): void;
    on(ev: 'upgrade', cb: (req: IncomingMessage, socket: import('node:net').Socket) => void): void;
    once(ev: 'error', cb: (err: Error & { code?: string }) => void): void;
    off(ev: 'error', cb: (err: Error & { code?: string }) => void): void;
    close(cb?: () => void): void;
    address(): { port: number } | null;
  }
  export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server;
}

declare module 'node:fs' {
  export function readFileSync(path: string | URL): Uint8Array;
  export function readFileSync(path: string | URL, enc: 'utf8'): string;
  export function readdirSync(path: string): string[];
  export function writeFileSync(path: string, data: string): void;
  export function mkdirSync(path: string, opt?: { recursive?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, opt?: { recursive?: boolean; force?: boolean }): void;
  export function existsSync(path: string): boolean;
  export function statSync(path: string): { size: number; mtimeMs: number; isDirectory(): boolean; isFile(): boolean };
  export function createReadStream(path: string, opt?: { start?: number; end?: number }): { pipe(dest: unknown): void };
}

declare module 'node:path' {
  export function join(...p: string[]): string;
  export function resolve(...p: string[]): string;
  export function extname(p: string): string;
  export function dirname(p: string): string;
  export function basename(p: string): string;
}

declare module 'node:os' {
  export function homedir(): string;
  export function tmpdir(): string;
  export function networkInterfaces(): Record<string, { address: string; family: string | number; internal: boolean }[] | undefined>;
}

declare module 'node:child_process' {
  export interface SpawnSyncResult { status: number | null; stdout: string; stderr: string; error?: Error }
  export function spawnSync(cmd: string, args: string[], opt: {
    encoding: 'utf8'; windowsHide?: boolean; maxBuffer?: number; stdio?: unknown; timeout?: number; env?: Record<string, string | undefined>;
  }): SpawnSyncResult;
  export function spawn(cmd: string, args: string[], opt?: {
    detached?: boolean; stdio?: 'ignore'; windowsHide?: boolean; windowsVerbatimArguments?: boolean;
  }): { on(ev: 'error', cb: (err: Error) => void): void; unref(): void };
}

declare module 'node:readline' {
  export interface Interface extends AsyncIterable<string> { close(): void }
  export function createInterface(opt: { input: unknown; output?: unknown; terminal?: boolean }): Interface;
}

declare module 'node:url' { export function fileURLToPath(u: string | URL): string; }
declare module 'node:crypto' {
  export function createHash(alg: string): { update(d: Uint8Array): { digest(enc: 'hex' | 'base64'): string } };
}
declare module 'node:test' {
  export function test(name: string, opt: { skip?: boolean | string }, fn: () => void | Promise<void>): void;
}
declare module 'node:assert/strict' {
  const assert: { equal(a: unknown, b: unknown, msg?: string): void; deepEqual(a: unknown, b: unknown, msg?: string): void; ok(v: unknown, msg?: string): void };
  export default assert;
}

declare module 'node:net' {
  export interface Socket {
    setNoDelay(v: boolean): void;
    on(ev: 'data', cb: (d: Uint8Array) => void): void;
    on(ev: 'close' | 'error', cb: () => void): void;
    write(d: Uint8Array | string): void;
    end(d?: string): void;
  }
}
