import { firstAppFrame, type SourceResolver } from './source.js';
import type {
  AttrValue,
  Coverage,
  ErrorItem,
  ExceptionInfo,
  Link,
  RequestNode,
  SourceOrigin,
  SpanLayer,
  SpanNode,
  StoredSpan,
  TraceRecord,
  TraceStatus,
  TraceView,
} from './types.js';

const STATIC_TYPES = new Set(['script', 'stylesheet', 'image', 'font', 'media', 'manifest', 'texttrack']);

export function isStaticResource(r: { resourceType: string }): boolean {
  return STATIC_TYPES.has(r.resourceType);
}

function str(v: AttrValue | undefined): string | undefined {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
}

function num(v: AttrValue | undefined): number | undefined {
  return typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;
}

export function classifySpan(s: StoredSpan): SpanLayer {
  const a = s.attributes;
  if (s.scope.includes('knex') || a['db.system'] !== undefined || a['db.system.name'] !== undefined) return 'db';
  if (s.scope === 'causecam-route-handlers') return 'handler';
  if (s.kind === 2) return 'http-server';
  if (s.kind === 3) return 'http-client';
  if (s.scope.includes('express') || a['express.type'] !== undefined) return 'express';
  return 'internal';
}

const DETAIL_KEYS: Record<SpanLayer, string[]> = {
  'http-server': ['http.request.method', 'http.method', 'http.route', 'url.path', 'http.target', 'http.response.status_code', 'http.status_code'],
  'http-client': ['http.request.method', 'http.method', 'url.full', 'http.url', 'server.address', 'http.response.status_code', 'http.status_code'],
  express: ['express.type', 'express.name', 'http.route'],
  handler: ['causecam.handler.route'],
  db: ['db.system.name', 'db.system', 'db.operation.name', 'db.operation', 'db.collection.name', 'db.sql.table', 'db.namespace', 'db.query.text', 'db.statement'],
  internal: [],
};

function originOf(s: StoredSpan): SourceOrigin {
  const src = s.attributes['causecam.source'];
  if (src === 'route-registration') return 'route-registration';
  if (src === 'query-call-site') return 'query-call-site';
  return 'instrumentation';
}

/**
 * Join captured browser evidence and backend spans into a TraceView.
 *
 * Relationship rules (the only ways two records become linked):
 *  - backend root span -> request: the span's parent id equals the span id CAUSECAM injected into
 *    that request's `traceparent` header (observed);
 *  - span -> span: parent ids reported by backend instrumentation (observed);
 *  - request -> interaction: the request started while CAUSECAM was performing that action and no
 *    other CAUSECAM action was running (inferred; navigation document requests are observed).
 * Anything else is reported as unattached rather than guessed.
 */
export function assembleTrace(traceId: string, record: TraceRecord | undefined, spans: StoredSpan[], resolver: SourceResolver): TraceView {
  const t0 = record?.startedAt ?? (spans.length ? Math.min(...spans.map((s) => s.startMs)) : Date.now());
  const nodes = new Map<string, SpanNode>();
  const raw = new Map<string, StoredSpan>();

  for (const s of spans) {
    raw.set(s.spanId, s);
    nodes.set(s.spanId, toNode(s, t0, resolver));
  }

  const roots: SpanNode[] = [];
  for (const s of spans) {
    const node = nodes.get(s.spanId)!;
    const parent = s.parentSpanId ? nodes.get(s.parentSpanId) : undefined;
    if (parent) {
      node.link = { basis: 'span-parent', certainty: 'observed' };
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  for (const n of nodes.values()) n.children.sort((a, b) => a.offsetMs - b.offsetMs);

  const requests: RequestNode[] = (record?.network ?? []).map((n) => {
    let path = n.url;
    try {
      const u = new URL(n.url);
      path = `${u.pathname}${u.search}`;
    } catch {
      /* keep */
    }
    const node: RequestNode = {
      requestSpanId: n.requestSpanId,
      method: n.method,
      url: n.url,
      path,
      resourceType: n.resourceType,
      offsetMs: round(n.startedAt - t0),
      link: requestLink(record!, n.resourceType, n.startedAt),
      spans: [],
    };
    if (n.endedAt !== undefined) node.durationMs = round(n.endedAt - n.startedAt);
    if (n.status !== undefined) node.status = n.status;
    if (n.failure) node.failure = n.failure;
    if (n.blocked) node.blocked = n.blocked;
    if (n.redirectedFrom) node.redirectedFrom = n.redirectedFrom;
    return node;
  });
  const bySpanId = new Map(requests.map((r) => [r.requestSpanId, r]));

  const unattachedSpans: SpanNode[] = [];
  for (const root of roots) {
    const parentId = raw.get(root.spanId)!.parentSpanId;
    const req = parentId ? bySpanId.get(parentId) : undefined;
    if (req) {
      root.link = { basis: 'traceparent', certainty: 'observed', detail: `server span parent ${parentId} = request's injected traceparent span id` };
      req.spans.push(root);
    } else {
      root.link = {
        basis: 'trace-id-only',
        certainty: 'observed',
        detail: parentId ? `same trace id; parent span ${parentId} was not received` : 'same trace id; root span with no parent',
      };
      unattachedSpans.push(root);
    }
  }

  const events = record?.events ?? [];
  const errors = collectErrors(record, requests, [...nodes.values()], raw);
  const status = deriveStatus(record, requests, nodes, errors);
  const coverage = deriveCoverage(record, requests, spans, unattachedSpans);
  const endCandidates = [record?.endedAt ?? 0, ...spans.map((s) => s.endMs)];

  const view: TraceView = {
    traceId,
    sessionId: record?.sessionId ?? '-',
    kind: record?.kind ?? 'background',
    status,
    startedAt: t0,
    durationMs: round(Math.max(...endCandidates) - t0),
    requests,
    unattachedSpans,
    events,
    errors,
    coverage,
  };
  if (record?.interaction) view.trigger = record.interaction;
  if (record?.pageUrlBefore) view.pageUrlBefore = record.pageUrlBefore;
  if (record?.pageUrlAfter) view.pageUrlAfter = record.pageUrlAfter;
  return view;
}

function requestLink(record: TraceRecord, resourceType: string, startedAt: number): Link {
  const ia = record.interaction;
  if (record.kind !== 'interaction' || !ia) {
    return { basis: 'action-window', certainty: 'unknown', detail: 'request was not started during a CAUSECAM action' };
  }
  if (ia.type === 'navigate' && resourceType === 'document') {
    return { basis: 'action-window', certainty: 'observed', detail: 'document request issued by the navigate action' };
  }
  return {
    basis: 'action-window',
    certainty: 'inferred',
    detail: `started ${round(startedAt - ia.startedAt)}ms after the ${ia.type} began, while no other CAUSECAM action was running`,
  };
}

function toNode(s: StoredSpan, t0: number, resolver: SourceResolver): SpanNode {
  const layer = classifySpan(s);
  const details: Record<string, AttrValue> = {};
  for (const k of DETAIL_KEYS[layer]) if (s.attributes[k] !== undefined) details[k] = s.attributes[k]!;

  const exceptions: ExceptionInfo[] = s.events
    .filter((e) => e.name === 'exception')
    .map((e) => {
      const stack = str(e.attributes['exception.stacktrace']);
      const frames = stack ? resolver.resolveStack(stack) : [];
      const info: ExceptionInfo = { message: str(e.attributes['exception.message']) ?? '(no message)', frames };
      const type = str(e.attributes['exception.type']);
      if (type) info.type = type;
      const app = firstAppFrame(frames);
      if (app) info.firstAppFrame = app;
      return info;
    });

  const node: SpanNode = {
    spanId: s.spanId,
    name: s.name,
    layer,
    service: s.serviceName,
    offsetMs: round(s.startMs - t0),
    durationMs: round(s.endMs - s.startMs),
    status: s.statusCode === 2 ? 'error' : s.statusCode === 1 ? 'ok' : 'unset',
    details,
    exceptions,
    link: { basis: 'span-parent', certainty: 'observed' },
    children: [],
  };
  if (s.statusMessage) node.statusMessage = s.statusMessage;
  const file = str(s.attributes['code.filepath']) ?? str(s.attributes['code.file.path']);
  if (file) {
    node.source = resolver.resolve(file, {
      line: num(s.attributes['code.lineno'] ?? s.attributes['code.line.number']),
      column: num(s.attributes['code.column'] ?? s.attributes['code.column.number']),
      fn: str(s.attributes['code.function'] ?? s.attributes['code.function.name']),
      origin: originOf(s),
    });
  }
  return node;
}

function hasErrorDescendant(n: SpanNode): boolean {
  return n.children.some((c) => c.status === 'error' || hasErrorDescendant(c));
}

function collectErrors(record: TraceRecord | undefined, requests: RequestNode[], nodes: SpanNode[], raw: Map<string, StoredSpan>): ErrorItem[] {
  const errors: ErrorItem[] = [];
  if (record?.interaction?.error) {
    errors.push({ layer: 'action', summary: `${record.interaction.type} action failed`, message: record.interaction.error, certainty: 'observed' });
  }

  // Deepest failing spans first: error spans none of whose descendants failed.
  const parentOf = (n: SpanNode) => {
    const pid = raw.get(n.spanId)?.parentSpanId;
    return pid ? nodes.find((x) => x.spanId === pid) : undefined;
  };
  const deepest = nodes.filter((n) => n.status === 'error' && !hasErrorDescendant(n)).sort((a, b) => a.offsetMs - b.offsetMs);
  for (const n of deepest) {
    const chain: string[] = [];
    for (let p = parentOf(n); p; p = parentOf(p)) if (p.status === 'error') chain.push(spanLabel(p));
    const exc = n.exceptions[0];
    const item: ErrorItem = {
      layer: n.layer === 'db' ? 'database' : 'backend',
      summary: `${spanLabel(n)} failed${exc?.type ? ` (${exc.type})` : ''}${chain.length ? `; error also recorded on: ${chain.join(' <- ')}` : ''}`,
      spanId: n.spanId,
      certainty: 'observed',
    };
    const message = n.statusMessage ?? exc?.message;
    if (message) item.message = message;
    const source = n.source ?? exc?.firstAppFrame;
    if (source) item.source = source;
    errors.push(item);
  }

  for (const r of requests) {
    if (r.blocked) errors.push({ layer: 'network', summary: `${r.method} ${r.path} blocked by CAUSECAM (${r.blocked})`, certainty: 'observed' });
    else if (r.failure) errors.push({ layer: 'network', summary: `${r.method} ${r.path} failed`, message: r.failure, certainty: 'observed' });
    else if (r.status !== undefined && r.status >= 400) errors.push({ layer: 'network', summary: `${r.method} ${r.path} -> HTTP ${r.status}`, certainty: 'observed' });
  }
  for (const e of record?.events ?? []) {
    if (e.type === 'page-error' || e.type === 'console-error') errors.push({ layer: 'browser', summary: e.type, message: e.text, certainty: 'observed' });
  }
  return errors;
}

export function spanLabel(n: SpanNode): string {
  if (n.layer === 'db') {
    const op = str(n.details['db.operation.name'] ?? n.details['db.operation']);
    const table = str(n.details['db.collection.name'] ?? n.details['db.sql.table']);
    if (op || table) return `db ${[op, table].filter(Boolean).join(' ')}`;
  }
  if (n.layer === 'http-server') return `server ${n.name}`;
  return n.name;
}

function deriveStatus(record: TraceRecord | undefined, requests: RequestNode[], nodes: Map<string, SpanNode>, errors: ErrorItem[]): TraceStatus {
  const failed =
    !!record?.interaction?.error ||
    requests.some((r) => !r.blocked && (r.failure || (r.status !== undefined && r.status >= 500))) ||
    [...nodes.values()].some((n) => n.status === 'error') ||
    errors.some((e) => e.summary === 'page-error');
  if (failed) return 'error';
  if (requests.some((r) => r.blocked)) return 'blocked';
  if (requests.length === 0 && nodes.size === 0) return 'no-activity';
  return 'ok';
}

function deriveCoverage(record: TraceRecord | undefined, requests: RequestNode[], spans: StoredSpan[], unattached: SpanNode[]): Coverage {
  const services = [...new Set(spans.map((s) => s.serviceName))];
  const dbSpans = spans.filter((s) => classifySpan(s) === 'db');
  const dbSystems = [...new Set(dbSpans.map((s) => str(s.attributes['db.system.name'] ?? s.attributes['db.system'])).filter(Boolean))];
  const gaps: string[] = [
    'Request/response bodies, headers, cookies and input values are not captured (privacy default).',
    'Only HTTP, Express middleware/route handlers and Knex queries are traced; other function calls inside handlers are not.',
  ];

  const dynamicRequests = requests.filter((r) => !isStaticResource(r) && !r.blocked && !r.failure);
  const withoutSpans = dynamicRequests.filter((r) => r.spans.length === 0);
  if (withoutSpans.length) {
    const list = withoutSpans.slice(0, 5).map((r) => `${r.method} ${r.path}`).join(', ');
    gaps.push(`No backend span received for ${withoutSpans.length} request(s): ${list}${withoutSpans.length > 5 ? ', ...' : ''}.`);
  }
  if (unattached.length) gaps.push(`${unattached.length} backend span tree(s) share this trace id but could not be attached to a captured request.`);
  if (requests.some((r) => r.blocked)) gaps.push('Some requests were blocked by CAUSECAM, so their backend behaviour was not observed.');

  let backend: string;
  if (spans.length) backend = `observed: ${spans.length} spans from ${services.join(', ')}`;
  else if (dynamicRequests.length) {
    backend =
      'no spans received. The backend is not instrumented (start it with `causecam run -- <cmd>`), exports elsewhere, or spans were still in flight.';
  } else backend = 'no backend requests in this trace';

  const browser = record
    ? `observed: ${requests.length} request(s), ${record.events.length} console/page event(s)`
    : 'not captured (trace contains backend spans only)';
  const database = dbSpans.length
    ? `observed: ${dbSpans.length} query span(s)${dbSystems.length ? ` (${dbSystems.join(', ')})` : ''}`
    : spans.length
      ? 'no database spans (no queries ran, or the driver is not instrumented; supported: Knex)'
      : 'unknown (no backend spans)';
  return { browser, backend, database, gaps };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
