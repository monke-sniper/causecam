import { randomBytes } from 'node:crypto';

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const SESSION_ID_RE = /^ses_[0-9a-f]{8}$/;

export function newTraceId(): string {
  let id: string;
  do id = randomBytes(16).toString('hex');
  while (/^0+$/.test(id));
  return id;
}

export function newSpanId(): string {
  let id: string;
  do id = randomBytes(8).toString('hex');
  while (/^0+$/.test(id));
  return id;
}

export function newSessionId(): string {
  return `ses_${randomBytes(4).toString('hex')}`;
}

export const isTraceId = (s: string): boolean => TRACE_ID_RE.test(s);
export const isSpanId = (s: string): boolean => SPAN_ID_RE.test(s);
export const isSessionId = (s: string): boolean => SESSION_ID_RE.test(s);

/** A trace reference supplied by a user or agent: a full 32-hex id or a unique prefix of at least 8 hex chars. */
export const TRACE_REF_RE = /^[0-9a-f]{8,32}$/;

export function traceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}
