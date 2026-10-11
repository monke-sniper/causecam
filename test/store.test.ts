import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newTraceId } from '../src/core/ids.js';
import { TraceStore } from '../src/core/store.js';
import type { StoredSpan, TraceRecord } from '../src/core/types.js';

let dir: string;
let store: TraceStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'causecam-store-'));
  store = new TraceStore(dir);
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const trace = (id: string, kind: 'interaction' | 'background' = 'interaction', startedAt = Date.now()): TraceRecord => ({
  traceId: id,
  sessionId: 'ses_00000001',
  kind,
  startedAt,
  endedAt: startedAt + 10,
  network: [{ requestSpanId: 'aaaaaaaaaaaaaaaa', method: 'GET', url: 'http://localhost/x', resourceType: 'fetch', startedAt, status: 200, traceparentInjected: true }],
  events: [],
  ...(kind === 'interaction' ? { interaction: { id: 'int_1', type: 'click' as const, startedAt, endedAt: startedAt + 1 } } : {}),
});

const span = (traceId: string, spanId: string, parent?: string): StoredSpan => ({
  traceId,
  spanId,
  ...(parent ? { parentSpanId: parent } : {}),
  name: 'GET /x',
  kind: 2,
  startMs: 1,
  endMs: 2,
  statusCode: 0,
  attributes: { 'http.route': '/x' },
  events: [],
  serviceName: 'svc',
  scope: 's',
  droppedAttributes: 0,
});

describe('TraceStore', () => {
  it('round-trips sessions, traces and spans', () => {
    store.createSession({ sessionId: 'ses_00000001', origin: 'http://localhost:1', allowedOrigins: ['http://localhost:1'], allowMutations: false, startedAt: 1 });
    const id = newTraceId();
    store.saveTrace(trace(id));
    store.insertSpans([span(id, '1111111111111111', 'aaaaaaaaaaaaaaaa')]);
    expect(store.getSession('ses_00000001')).toMatchObject({ allowMutations: false, allowedOrigins: ['http://localhost:1'] });
    expect(store.getTrace(id)).toEqual(trace(id, 'interaction', store.getTrace(id)!.startedAt));
    expect(store.getSpans(id)).toEqual([span(id, '1111111111111111', 'aaaaaaaaaaaaaaaa')]);
    expect(store.serverSpanParents(id)).toEqual(new Set(['aaaaaaaaaaaaaaaa']));
  });

  it('lists newest first, filters background traces and session, and caps limits', () => {
    const a = newTraceId();
    const b = newTraceId();
    const c = newTraceId();
    store.saveTrace(trace(a, 'interaction', 1000));
    store.saveTrace(trace(b, 'interaction', 2000));
    store.saveTrace(trace(c, 'background', 3000));
    expect(store.listTraces().map((t) => t.traceId)).toEqual([b, a]);
    expect(store.listTraces({ includeBackground: true }).map((t) => t.traceId)).toEqual([c, b, a]);
    expect(store.listTraces({ limit: 1 })).toHaveLength(1);
    expect(store.listTraces({ sessionId: 'ses_ffffffff' })).toHaveLength(0);
  });

  it('resolves unique prefixes and rejects invalid, unknown or ambiguous refs', () => {
    store.saveTrace(trace('abcdef01' + '0'.repeat(24)));
    store.saveTrace(trace('abcdef02' + '0'.repeat(24)));
    expect(store.resolveTraceRef('abcdef01')).toBe('abcdef01' + '0'.repeat(24));
    expect(() => store.resolveTraceRef('abcdef0')).toThrow(/Invalid trace id/);
    expect(() => store.resolveTraceRef("abcdef01' OR 1=1 --")).toThrow(/Invalid trace id/);
    expect(() => store.resolveTraceRef('abcdef')).toThrow(/Invalid/);
    expect(() => store.resolveTraceRef('abcdef0a')).toThrow(/No trace found/);
    store.saveTrace(trace('abcdef0a1' + '0'.repeat(23)));
    store.saveTrace(trace('abcdef0a2' + '0'.repeat(23)));
    expect(() => store.resolveTraceRef('abcdef0a')).toThrow(/ambiguous/);
  });

  it('deletes single traces (with spans) and purges everything', () => {
    const id = newTraceId();
    store.saveTrace(trace(id));
    store.insertSpans([span(id, '1111111111111111')]);
    expect(store.deleteTrace(id)).toBe(true);
    expect(store.getTrace(id)).toBeUndefined();
    expect(store.getSpans(id)).toEqual([]);
    expect(() => store.deleteTrace('../etc')).toThrow();
    store.saveTrace(trace(newTraceId()));
    store.createSession({ sessionId: 'ses_00000002', origin: 'o', allowedOrigins: [], allowMutations: true, startedAt: 1 });
    store.purge();
    expect(store.stats()).toEqual({ sessions: 0, traces: 0, spans: 0 });
  });

  it('creates the database file with owner-only permissions', () => {
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
  });
});
