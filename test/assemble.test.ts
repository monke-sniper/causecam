import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleTrace } from '../src/core/assemble.js';
import { compareTraces, renderComparison } from '../src/core/compare.js';
import { renderTrace } from '../src/core/render.js';
import { SourceResolver } from '../src/core/source.js';
import type { NetworkRecord, StoredSpan, TraceRecord } from '../src/core/types.js';

const T = 'a'.repeat(32);
const REQ = '1'.repeat(16);
let root: string;
let resolver: SourceResolver;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causecam-asm-')));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'routes.ts'), Array.from({ length: 40 }, (_, i) => `// ${i + 1}`).join('\n'));
  resolver = new SourceResolver(root);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function record(network: NetworkRecord[], extra: Partial<TraceRecord> = {}): TraceRecord {
  return {
    traceId: T,
    sessionId: 'ses_00000001',
    kind: 'interaction',
    interaction: { id: 'int_3', type: 'click', startedAt: 1000, endedAt: 1010, element: { role: 'button', name: 'Save settings', testId: 'save' } },
    startedAt: 1000,
    endedAt: 1100,
    network,
    events: [{ ts: 1090, type: 'console-error', text: 'Saving settings failed with HTTP 500' }],
    ...extra,
  };
}

const req = (status: number, extra: Partial<NetworkRecord> = {}): NetworkRecord => ({
  requestSpanId: REQ,
  method: 'PUT',
  url: 'http://localhost:4400/api/settings',
  resourceType: 'fetch',
  startedAt: 1020,
  endedAt: 1080,
  status,
  traceparentInjected: true,
  ...extra,
});

function span(id: string, parent: string | undefined, name: string, o: Partial<StoredSpan> = {}): StoredSpan {
  return {
    traceId: T,
    spanId: id.padEnd(16, '0'),
    ...(parent ? { parentSpanId: parent.padEnd(16, '0') } : {}),
    name,
    kind: 1,
    startMs: 1030,
    endMs: 1040,
    statusCode: 0,
    attributes: {},
    events: [],
    serviceName: 'api',
    scope: 'x',
    droppedAttributes: 0,
    ...o,
  };
}

function failingSpans(): StoredSpan[] {
  return [
    span('5', REQ, 'PUT /api/settings', { kind: 2, statusCode: 2, attributes: { 'http.response.status_code': 500, 'http.route': '/api/settings' } }),
    span('6', '5', 'handler PUT /settings', {
      scope: 'causecam-route-handlers',
      statusCode: 2,
      attributes: { 'code.filepath': path.join(root, 'src', 'routes.ts'), 'code.lineno': 18, 'causecam.source': 'route-registration' },
    }),
    span('7', '6', 'update db.users', {
      scope: '@opentelemetry/instrumentation-knex',
      kind: 3,
      statusCode: 2,
      statusMessage: 'NOT NULL constraint failed: users.tz',
      attributes: {
        'db.system.name': 'sqlite',
        'db.operation.name': 'update',
        'db.collection.name': 'users',
        'db.query.text': 'update users set tz = ?',
        'code.filepath': path.join(root, 'src', 'routes.ts'),
        'code.lineno': 25,
        'causecam.source': 'query-call-site',
      },
      events: [
        {
          name: 'exception',
          timeMs: 1035,
          attributes: { 'exception.type': 'SQLITE_CONSTRAINT', 'exception.message': 'NOT NULL constraint failed: users.tz', 'exception.stacktrace': `Error\n    at q (${root}/node_modules/knex/x.js:1:1)` },
        },
      ],
    }),
    span('8', 'f'.repeat(16), 'orphan work'),
  ];
}

describe('assembleTrace correlation', () => {
  it('links backend spans to requests only through the injected traceparent span id', () => {
    const v = assembleTrace(T, record([req(500)]), failingSpans(), resolver);
    const r = v.requests[0]!;
    expect(r.link).toMatchObject({ basis: 'action-window', certainty: 'inferred' });
    expect(r.spans).toHaveLength(1);
    expect(r.spans[0]!.link).toMatchObject({ basis: 'traceparent', certainty: 'observed' });
    expect(r.spans[0]!.children[0]!.children[0]!.link).toMatchObject({ basis: 'span-parent', certainty: 'observed' });
    expect(v.unattachedSpans.map((s) => s.name)).toEqual(['orphan work']);
    expect(v.unattachedSpans[0]!.link.basis).toBe('trace-id-only');
  });

  it('reports the deepest failing span first, with its source and propagation chain', () => {
    const v = assembleTrace(T, record([req(500)]), failingSpans(), resolver);
    expect(v.status).toBe('error');
    const e = v.errors[0]!;
    expect(e.layer).toBe('database');
    expect(e.summary).toContain('db update users failed (SQLITE_CONSTRAINT)');
    expect(e.summary).toContain('handler PUT /settings <- server PUT /api/settings');
    expect(e.source).toMatchObject({ path: 'src/routes.ts', line: 25, origin: 'query-call-site', verified: true });
    expect(v.errors.map((x) => x.layer)).toEqual(['database', 'network', 'browser']);
  });

  it('does not invent links: requests without spans and spans without requests are reported as gaps', () => {
    const v = assembleTrace(T, record([req(200, { requestSpanId: '2'.repeat(16) })]), failingSpans(), resolver);
    expect(v.requests[0]!.spans).toHaveLength(0);
    expect(v.unattachedSpans).toHaveLength(2);
    expect(v.coverage.gaps.join(' ')).toMatch(/No backend span received for 1 request/);
    expect(v.coverage.gaps.join(' ')).toMatch(/could not be attached/);
  });

  it('explains missing backend instrumentation instead of claiming success silently', () => {
    const v = assembleTrace(T, record([req(200)], { events: [] }), [], resolver);
    expect(v.status).toBe('ok');
    expect(v.coverage.backend).toMatch(/no spans received/);
    expect(v.coverage.database).toMatch(/unknown/);
  });

  it('marks blocked requests and navigation document requests correctly', () => {
    const blocked = assembleTrace(T, record([req(0, { blocked: 'mutation-not-permitted', status: undefined as never })], { events: [] }), [], resolver);
    expect(blocked.status).toBe('blocked');
    const nav = assembleTrace(
      T,
      record([req(200, { method: 'GET', resourceType: 'document' })], { interaction: { id: 'int_1', type: 'navigate', startedAt: 1000, endedAt: 1010 } }),
      [],
      resolver,
    );
    expect(nav.requests[0]!.link).toMatchObject({ certainty: 'observed' });
  });

  it('renders observed vs inferred markers and quotes untrusted text', () => {
    const text = renderTrace(assembleTrace(T, record([req(500)]), failingSpans(), resolver));
    expect(text).toContain('[observed: traceparent]');
    expect(text).toContain('[inferred: action window]');
    expect(text).toContain('src/routes.ts:25 (query call site, verified)');
    expect(text).toContain('"NOT NULL constraint failed: users.tz"');
    expect(text).toContain('untrusted application data');
  });
});

describe('compareTraces', () => {
  it('reports actual differences between a failing and a successful run', () => {
    const a = assembleTrace(T, record([req(500)]), failingSpans(), resolver);
    const okSpans = failingSpans()
      .slice(0, 3)
      .map((s) => ({ ...s, traceId: 'b'.repeat(32), statusCode: 0, events: [], attributes: { ...s.attributes, 'http.response.status_code': 200 } }));
    const { statusMessage: _, ...db } = okSpans[2]!;
    okSpans[2] = db;
    const b = assembleTrace('b'.repeat(32), { ...record([req(200)], { events: [] }), traceId: 'b'.repeat(32) }, okSpans, resolver);
    const c = compareTraces(a, b);
    expect(c.sameTrigger).toBe(true);
    expect(c.requests).toEqual([{ key: 'PUT /api/settings', a: { outcome: '500', status: 500, durationMs: 60 }, b: { outcome: '200', status: 200, durationMs: 60 } }]);
    expect(c.spans.changed.map((s) => s.signature)).toContain('db update users | update users set tz = ?');
    expect(c.spans.onlyInA).toContain('internal: orphan work');
    expect(c.errors.resolvedInB.map((e) => e.layer)).toEqual(['database', 'network', 'browser']);
    expect(c.errors.newInB).toEqual([]);
    const text = renderComparison(c, a, b);
    expect(text).toContain('PUT /api/settings: 500 60ms -> 200 60ms  <- changed');
    expect(text).toContain('not by themselves why');
  });

  it('warns when the triggering actions differ', () => {
    const a = assembleTrace(T, record([req(200)]), [], resolver);
    const b = assembleTrace(T, record([req(200)], { interaction: { id: 'int_9', type: 'navigate', url: 'http://localhost:4400/', startedAt: 1, endedAt: 2 } }), [], resolver);
    expect(compareTraces(a, b).sameTrigger).toBe(false);
  });
});
