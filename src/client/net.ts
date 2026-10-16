// WebSocket connection to the an-rebuild server (lobby + lockstep relay).

import type { ClientMsg, ServerMsg } from '../net/protocol.ts';

export class NetClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<(m: ServerMsg) => void>();
  id = '';

  connect(name: string): Promise<void> {
    if (this.ws && this.ws.readyState <= 1) return Promise.resolve();
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => { this.send({ t: 'hello', name }); resolve(); };
      ws.onerror = () => reject(new Error('Keine Verbindung zum Server'));
      ws.onclose = () => { this.ws = null; };
      ws.onmessage = ev => {
        const m = JSON.parse(String(ev.data)) as ServerMsg;
        if (m.t === 'welcome') this.id = m.id;
        for (const l of this.listeners) l(m);
      };
    });
  }

  send(m: ClientMsg): void { this.ws?.send(JSON.stringify(m)); }
  on(l: (m: ServerMsg) => void): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
}
