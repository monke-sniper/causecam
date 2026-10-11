import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { log } from './config.js';
import { parseOtlpJson } from './core/otlp.js';
import type { TraceStore } from './core/store.js';

const MAX_BODY = 5 * 1024 * 1024;
const SIGNATURE = 'causecam-collector';

export interface Collector {
  port: number;
  url: string;
  /** False when another CAUSECAM collector already owned the port and is being reused. */
  owned: boolean;
  close(): Promise<void>;
}

/**
 * Local OTLP/HTTP JSON receiver. Binds to 127.0.0.1 only, rejects browser-originated requests
 * (any Origin header) and non-loopback Host headers to defend against CSRF / DNS rebinding.
 */
export function createCollectorServer(store: TraceStore, port: number): http.Server {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  return http.createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const host = req.headers.host ?? '';
    // Port 0 means "pick one"; the real port is only known after listen.
    const realPort = (req.socket.localPort ?? port).toString();
    const hostOk = allowedHosts.has(host) || [`127.0.0.1:${realPort}`, `localhost:${realPort}`, `[::1]:${realPort}`].includes(host);
    if (!hostOk || req.headers.origin !== undefined) return send(403, { error: 'forbidden' });

    if (req.method === 'GET' && req.url === '/health') {
      return send(200, { service: SIGNATURE, store: store.file, pid: process.pid });
    }
    if (req.method !== 'POST' || req.url?.split('?')[0] !== '/v1/traces') return send(404, { error: 'not found' });
    const ctype = (req.headers['content-type'] ?? '').split(';')[0]!.trim();
    if (ctype !== 'application/json') return send(415, { error: 'CAUSECAM accepts OTLP/HTTP JSON only (set protocol http/json)' });

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY && !aborted) {
        aborted = true;
        send(413, { error: 'payload too large' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(400, { error: 'invalid JSON' });
      }
      try {
        const { spans, rejected } = parseOtlpJson(body);
        if (spans.length) store.insertSpans(spans);
        send(200, rejected ? { partialSuccess: { rejectedSpans: rejected, errorMessage: 'some spans were invalid' } } : {});
      } catch (e) {
        log('collector failed to store spans:', (e as Error).message);
        send(500, { error: 'store failure' });
      }
    });
  });
}

/** Start a collector on the given port, or reuse an existing CAUSECAM collector already listening there. */
export async function ensureCollector(store: TraceStore, port: number): Promise<Collector> {
  const server = createCollectorServer(store, port);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    const info = await probe(port);
    if (!info) throw new Error(`Port ${port} is in use by something that is not a CAUSECAM collector. Set CAUSECAM_COLLECTOR_PORT to another port.`);
    if (info.store !== store.file) log(`warning: reusing collector on port ${port}, which writes to ${info.store} (this process uses ${store.file})`);
    return { port, url: `http://127.0.0.1:${port}/v1/traces`, owned: false, close: async () => undefined };
  }
  const actual = (server.address() as AddressInfo).port;
  return {
    port: actual,
    url: `http://127.0.0.1:${actual}/v1/traces`,
    owned: true,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function probe(port: number): Promise<{ store: string; pid: number } | undefined> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    const j = (await r.json()) as { service?: string; store?: string; pid?: number };
    return j.service === SIGNATURE ? { store: String(j.store), pid: Number(j.pid) } : undefined;
  } catch {
    return undefined;
  }
}
