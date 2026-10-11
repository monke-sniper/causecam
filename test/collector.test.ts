import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureCollector, type Collector } from '../src/collector.js';
import { decodeId, parseOtlpJson } from '../src/core/otlp.js';
import { TraceStore } from '../src/core/store.js';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN = '00f067aa0ba902b7';

const payload = (overrides: Record<string, unknown> = {}) => ({
  resourceSpans: [
    {
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api' } }] },
      scopeSpans: [
        {
          scope: { name: '@opentelemetry/instrumentation-knex' },
          spans: [
            {
              traceId: TRACE,
              spanId: SPAN,
              parentSpanId: 'aaaaaaaaaaaaaaaa',
              name: 'insert /Users/x/app/data/db.sqlite.users',
              kind: 3,
              startTimeUnixNano: '1700000000000000000',
              endTimeUnixNano: '1700000000005000000',
              attributes: [
                { key: 'db.system.name', value: { stringValue: 'sqlite' } },
                { key: 'db.query.text', value: { stringValue: "insert into users values ('alice@example.com', 42)" } },
                { key: 'db.query.parameter.0', value: { stringValue: 'alice@example.com' } },
                { key: 'code.lineno', value: { intValue: '12' } },
              ],
              events: [{ name: 'exception', timeUnixNano: '1700000000004000000', attributes: [{ key: 'exception.message', value: { stringValue: 'boom' } }] }],
              status: { code: 2, message: 'boom' },
              ...overrides,
            },
          ],
        },
      ],
    },
  ],
});

describe('parseOtlpJson', () => {
  it('parses spans and applies redaction at ingest', () => {
    const { spans, rejected } = parseOtlpJson(payload());
    expect(rejected).toBe(0);
    expect(spans).toHaveLength(1);
    const s = spans[0]!;
    expect(s).toMatchObject({ traceId: TRACE, spanId: SPAN, parentSpanId: 'aaaaaaaaaaaaaaaa', kind: 3, statusCode: 2, serviceName: 'api' });
    expect(s.name).toBe('insert db.sqlite.users');
    expect(s.endMs - s.startMs).toBe(5);
    expect(s.attributes['db.query.text']).toBe('insert into users values (?, ?)');
    expect(s.attributes['code.lineno']).toBe(12);
    expect(s.attributes['db.query.parameter.0']).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain('alice');
    expect(s.events[0]).toMatchObject({ name: 'exception', attributes: { 'exception.message': 'boom' } });
  });
  it('accepts base64 ids and rejects malformed spans', () => {
    expect(decodeId(Buffer.from(TRACE, 'hex').toString('base64'), 16)).toBe(TRACE);
    expect(parseOtlpJson(payload({ traceId: 'nope' }))).toMatchObject({ spans: [], rejected: 1 });
    expect(parseOtlpJson(payload({ startTimeUnixNano: 'x' })).rejected).toBe(1);
    expect(parseOtlpJson('garbage')).toMatchObject({ spans: [], rejected: 1 });
  });
});

describe('collector HTTP endpoint', () => {
  let dir: string;
  let store: TraceStore;
  let col: Collector;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'causecam-col-'));
    store = new TraceStore(dir);
    col = await ensureCollector(store, 0);
  });
  afterAll(async () => {
    await col.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const post = (body: string, headers: Record<string, string> = {}) =>
    fetch(col.url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

  it('stores spans posted as OTLP JSON', async () => {
    const r = await post(JSON.stringify(payload()));
    expect(r.status).toBe(200);
    expect(store.getSpans(TRACE)).toHaveLength(1);
  });
  it('rejects browser-originated requests, non-JSON and bad bodies', async () => {
    expect((await post(JSON.stringify(payload()), { origin: 'http://evil.example' })).status).toBe(403);
    expect((await fetch(col.url, { method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: 'x' })).status).toBe(415);
    expect((await post('{not json')).status).toBe(400);
    expect((await fetch(col.url.replace('/v1/traces', '/other'))).status).toBe(404);
  });
  it('rejects requests whose Host header is not loopback (DNS rebinding)', async () => {
    const status = await new Promise<number>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: col.port, path: '/health', headers: { host: `attacker.example:${col.port}` } }, (res) => resolve(res.statusCode ?? 0));
      req.end();
    });
    expect(status).toBe(403);
  });
  it('identifies itself on /health so a second process can reuse it', async () => {
    const second = await ensureCollector(store, col.port);
    expect(second.owned).toBe(false);
  });
});
