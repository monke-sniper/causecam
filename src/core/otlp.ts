import { redactAttributes, sanitizeText, shortenPaths } from './redact.js';
import type { AttrValue, SpanEvent, StoredSpan } from './types.js';

/**
 * Minimal parser for OTLP/HTTP JSON trace exports (ExportTraceServiceRequest).
 * Only the fields CAUSECAM uses are read; everything is validated defensively because the
 * payload comes from another process.
 */

const MAX_SPANS = 10_000;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function decodeId(v: unknown, bytes: 8 | 16): string | undefined {
  if (typeof v !== 'string' || v === '') return undefined;
  const hexLen = bytes * 2;
  if (new RegExp(`^[0-9a-fA-F]{${hexLen}}$`).test(v)) return v.toLowerCase();
  // protobuf-JSON mapping encodes bytes as base64
  try {
    const buf = Buffer.from(v, 'base64');
    if (buf.length === bytes) return buf.toString('hex');
  } catch {
    /* fall through */
  }
  return undefined;
}

function nanosToMs(v: unknown): number | undefined {
  try {
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(BigInt(v) / 1000n) / 1000;
    if (typeof v === 'number' && Number.isFinite(v)) return v / 1e6;
  } catch {
    /* ignore */
  }
  return undefined;
}

function anyValue(v: unknown): AttrValue | undefined {
  if (!isObj(v)) return undefined;
  if (typeof v.stringValue === 'string') return v.stringValue;
  if (typeof v.boolValue === 'boolean') return v.boolValue;
  if (v.intValue !== undefined) {
    const n = Number(v.intValue);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof v.doubleValue === 'number') return v.doubleValue;
  if (isObj(v.arrayValue)) {
    const vals = arr(v.arrayValue.values)
      .map(anyValue)
      .filter((x): x is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof x));
    if (vals.every((x) => typeof x === 'string')) return vals as string[];
    if (vals.every((x) => typeof x === 'number')) return vals as number[];
    if (vals.every((x) => typeof x === 'boolean')) return vals as boolean[];
    return vals.map(String);
  }
  return undefined; // kvlist / bytes are not used by CAUSECAM
}

function attributes(list: unknown): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {};
  for (const kv of arr(list)) {
    if (!isObj(kv) || typeof kv.key !== 'string') continue;
    const val = anyValue(kv.value);
    if (val !== undefined) out[kv.key] = val;
  }
  return out;
}

export interface ParseResult {
  spans: StoredSpan[];
  rejected: number;
}

export function parseOtlpJson(body: unknown): ParseResult {
  const spans: StoredSpan[] = [];
  let rejected = 0;
  if (!isObj(body)) return { spans, rejected: 1 };
  for (const rs of arr(body.resourceSpans)) {
    if (!isObj(rs)) continue;
    const resAttrs = attributes(isObj(rs.resource) ? rs.resource.attributes : undefined);
    const serviceName = typeof resAttrs['service.name'] === 'string' ? sanitizeText(resAttrs['service.name'], 80) : 'unknown_service';
    for (const ss of arr(rs.scopeSpans ?? rs.instrumentationLibrarySpans)) {
      if (!isObj(ss)) continue;
      const scopeObj = isObj(ss.scope) ? ss.scope : isObj(ss.instrumentationLibrary) ? ss.instrumentationLibrary : {};
      const scope = typeof scopeObj.name === 'string' ? sanitizeText(scopeObj.name, 120) : '';
      for (const s of arr(ss.spans)) {
        if (spans.length >= MAX_SPANS) {
          rejected++;
          continue;
        }
        const span = parseSpan(s, serviceName, scope);
        if (span) spans.push(span);
        else rejected++;
      }
    }
  }
  return { spans, rejected };
}

function parseSpan(s: unknown, serviceName: string, scope: string): StoredSpan | undefined {
  if (!isObj(s)) return undefined;
  const traceId = decodeId(s.traceId, 16);
  const spanId = decodeId(s.spanId, 8);
  const startMs = nanosToMs(s.startTimeUnixNano);
  const endMs = nanosToMs(s.endTimeUnixNano);
  if (!traceId || !spanId || startMs === undefined || endMs === undefined) return undefined;
  const parentSpanId = decodeId(s.parentSpanId, 8);
  const { kept, dropped } = redactAttributes(attributes(s.attributes));
  const events: SpanEvent[] = arr(s.events)
    .filter(isObj)
    .slice(0, 50)
    .map((e) => ({
      name: typeof e.name === 'string' ? sanitizeText(e.name, 100) : 'event',
      timeMs: nanosToMs(e.timeUnixNano) ?? startMs,
      attributes: redactAttributes(attributes(e.attributes)).kept,
    }));
  const status = isObj(s.status) ? s.status : {};
  const statusCode = typeof status.code === 'number' ? status.code : status.code === 'STATUS_CODE_ERROR' ? 2 : status.code === 'STATUS_CODE_OK' ? 1 : 0;
  const span: StoredSpan = {
    traceId,
    spanId,
    name: typeof s.name === 'string' ? sanitizeText(scope.includes('knex') ? shortenPaths(s.name) : s.name, 200) : '(unnamed)',
    kind: typeof s.kind === 'number' ? s.kind : 0,
    startMs,
    endMs,
    statusCode,
    attributes: kept,
    events,
    serviceName,
    scope,
    droppedAttributes: dropped + (typeof s.droppedAttributesCount === 'number' ? s.droppedAttributesCount : 0),
  };
  if (parentSpanId) span.parentSpanId = parentSpanId;
  if (typeof status.message === 'string' && status.message) span.statusMessage = sanitizeText(status.message, 1000);
  return span;
}
