// Minimal WebSocket server (RFC 6455) on top of node:http, no dependencies.
// Supports text frames, ping/pong, close, fragmented messages, frames up to 16 MB.

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 16 * 1024 * 1024;

export class WsConnection {
  private socket: Socket;
  private buf: Uint8Array = new Uint8Array(0);
  private fragments: Uint8Array[] = [];
  private closed = false;
  onMessage: (text: string) => void = () => {};
  onClose: () => void = () => {};

  constructor(socket: Socket) {
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on('data', (d: Uint8Array) => this.receive(d));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }

  send(text: string): void {
    if (this.closed) return;
    this.sendFrame(0x1, new TextEncoder().encode(text));
  }

  close(code = 1000): void {
    if (this.closed) return;
    const p = new Uint8Array(2);
    p[0] = code >> 8; p[1] = code & 0xff;
    this.sendFrame(0x8, p);
    this.socket.end();
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }

  private sendFrame(op: number, payload: Uint8Array): void {
    const n = payload.length;
    const head = n < 126 ? 2 : n < 65536 ? 4 : 10;
    const f = new Uint8Array(head + n);
    f[0] = 0x80 | op;
    if (n < 126) f[1] = n;
    else if (n < 65536) { f[1] = 126; f[2] = n >> 8; f[3] = n & 0xff; }
    else { f[1] = 127; new DataView(f.buffer).setUint32(6, n); }
    f.set(payload, head);
    this.socket.write(f);
  }

  private receive(d: Uint8Array): void {
    const merged = new Uint8Array(this.buf.length + d.length);
    merged.set(this.buf); merged.set(d, this.buf.length);
    this.buf = merged;
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = (this.buf[2] << 8) | this.buf[3]; off = 4; }
      else if (len === 127) {
        if (this.buf.length < 10) return;
        len = new DataView(this.buf.buffer, this.buf.byteOffset).getUint32(6); off = 10;
      }
      if (len > MAX_MESSAGE) { this.close(1009); return; }
      const maskOff = off; if (masked) off += 4;
      if (this.buf.length < off + len) return;
      const payload = this.buf.slice(off, off + len);
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= this.buf[maskOff + (i & 3)];
      this.buf = this.buf.slice(off + len);

      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { this.sendFrame(0xa, payload); continue; }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        this.fragments.push(payload);
        if (fin) {
          const total = this.fragments.reduce((a, f) => a + f.length, 0);
          const all = new Uint8Array(total);
          let o = 0;
          for (const f of this.fragments) { all.set(f, o); o += f.length; }
          this.fragments = [];
          this.onMessage(new TextDecoder().decode(all));
        }
      }
    }
  }
}

/** Complete the WebSocket handshake for an HTTP upgrade request. */
export function acceptUpgrade(req: IncomingMessage, socket: Socket): WsConnection | null {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(new TextEncoder().encode(key + GUID)).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
               `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return new WsConnection(socket);
}
