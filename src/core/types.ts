/**
 * CAUSECAM trace model.
 *
 * Raw records (what was captured) are stored separately from the assembled view (how records relate).
 * Every relationship in the assembled view carries a basis and a certainty so the agent can tell
 * observed facts from inferences.
 */

export const ACTION_TYPES = ['navigate', 'click', 'fill', 'select', 'press'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** How to find an element. Exactly one strategy is used, in the priority order of the fields below. */
export interface TargetSpec {
  testId?: string;
  role?: string;
  name?: string;
  label?: string;
  text?: string;
  css?: string;
}

/** Metadata about the element an action was performed on. All strings are untrusted page content. */
export interface ElementMeta {
  tag?: string;
  role?: string;
  name?: string;
  testId?: string;
}

export interface InteractionRecord {
  id: string;
  type: ActionType;
  target?: TargetSpec;
  element?: ElementMeta;
  /** Navigation target (redacted). */
  url?: string;
  key?: string;
  /** For fill/select: we record only the length of the value, never the value itself. */
  valueLength?: number;
  startedAt: number;
  endedAt: number;
  /** Set when the action itself failed (element not found, timeout, ...). */
  error?: string;
}

export type BlockReason = 'external-origin' | 'mutation-not-permitted';

export interface NetworkRecord {
  /** Span id CAUSECAM generated for this request and sent as the parent in `traceparent`. */
  requestSpanId: string;
  method: string;
  /** Redacted URL (sensitive query values removed). */
  url: string;
  resourceType: string;
  startedAt: number;
  endedAt?: number;
  status?: number;
  failure?: string;
  blocked?: BlockReason;
  redirectedFrom?: string;
  traceparentInjected: boolean;
}

export type BrowserEventType = 'console-error' | 'console-warning' | 'page-error' | 'navigation' | 'dialog';

export interface BrowserEvent {
  ts: number;
  type: BrowserEventType;
  /** Untrusted page content, sanitized and truncated. */
  text: string;
  stack?: string;
}

export type TraceKind = 'interaction' | 'background';

export interface TraceRecord {
  traceId: string;
  sessionId: string;
  kind: TraceKind;
  interaction?: InteractionRecord;
  pageUrlBefore?: string;
  pageUrlAfter?: string;
  startedAt: number;
  endedAt: number;
  network: NetworkRecord[];
  events: BrowserEvent[];
}

export type AttrValue = string | number | boolean | string[] | number[] | boolean[];

export interface SpanEvent {
  name: string;
  timeMs: number;
  attributes: Record<string, AttrValue>;
}

/** A backend span received over OTLP, after redaction. Times are epoch milliseconds. */
export interface StoredSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** OTLP SpanKind: 0 unspecified, 1 internal, 2 server, 3 client, 4 producer, 5 consumer. */
  kind: number;
  startMs: number;
  endMs: number;
  /** OTLP status code: 0 unset, 1 ok, 2 error. */
  statusCode: number;
  statusMessage?: string;
  attributes: Record<string, AttrValue>;
  events: SpanEvent[];
  serviceName: string;
  scope: string;
  droppedAttributes: number;
}

export interface SessionRecord {
  sessionId: string;
  origin: string;
  allowedOrigins: string[];
  allowMutations: boolean;
  startedAt: number;
  endedAt?: number;
}

// ---------------------------------------------------------------------------
// Assembled view
// ---------------------------------------------------------------------------

export type Certainty = 'observed' | 'inferred' | 'unknown';
export type LinkBasis =
  /** Backend span's parent id equals the span id CAUSECAM injected into the request's traceparent header. */
  | 'traceparent'
  /** Parent/child relationship reported by the backend's own instrumentation. */
  | 'span-parent'
  /** Request started while CAUSECAM was performing the action and no other action was active. */
  | 'action-window'
  /** Span belongs to the trace id but its parent was never received. */
  | 'trace-id-only';

export interface Link {
  basis: LinkBasis;
  certainty: Certainty;
  detail?: string;
}

export type SourceOrigin = 'instrumentation' | 'route-registration' | 'query-call-site' | 'stack-trace';
export type SourceClass = 'app' | 'dependency' | 'node-internal' | 'generated' | 'outside-repo' | 'browser-url' | 'unknown';

export interface SourceRef {
  /** Repo-relative path for app files; a short descriptive form for everything else. Never fabricated. */
  path: string;
  line?: number;
  column?: number;
  function?: string;
  origin: SourceOrigin;
  classification: SourceClass;
  /** True when the file exists under the repo root and the line is within the file. */
  verified: boolean;
}

export interface ExceptionInfo {
  type?: string;
  /** Untrusted application text. */
  message: string;
  firstAppFrame?: SourceRef;
  frames: SourceRef[];
}

export type SpanLayer = 'http-server' | 'http-client' | 'express' | 'handler' | 'db' | 'internal';

export interface SpanNode {
  spanId: string;
  name: string;
  layer: SpanLayer;
  service: string;
  offsetMs: number;
  durationMs: number;
  status: 'ok' | 'error' | 'unset';
  statusMessage?: string;
  /** Selected, already-redacted attributes useful for debugging (route, status, SQL, ...). */
  details: Record<string, AttrValue>;
  source?: SourceRef;
  exceptions: ExceptionInfo[];
  link: Link;
  children: SpanNode[];
}

export interface RequestNode {
  requestSpanId: string;
  method: string;
  url: string;
  path: string;
  resourceType: string;
  offsetMs: number;
  durationMs?: number;
  status?: number;
  failure?: string;
  blocked?: BlockReason;
  redirectedFrom?: string;
  link: Link;
  spans: SpanNode[];
}

export interface ErrorItem {
  layer: 'browser' | 'network' | 'backend' | 'database' | 'action';
  summary: string;
  /** Untrusted application text, if any. */
  message?: string;
  spanId?: string;
  source?: SourceRef;
  certainty: Certainty;
}

export interface Coverage {
  browser: string;
  backend: string;
  database: string;
  gaps: string[];
}

export type TraceStatus = 'error' | 'ok' | 'blocked' | 'no-activity';

export interface TraceView {
  traceId: string;
  sessionId: string;
  kind: TraceKind;
  status: TraceStatus;
  startedAt: number;
  durationMs: number;
  trigger?: InteractionRecord;
  pageUrlBefore?: string;
  pageUrlAfter?: string;
  requests: RequestNode[];
  /** Spans in this trace that could not be attached to a captured request. */
  unattachedSpans: SpanNode[];
  events: BrowserEvent[];
  errors: ErrorItem[];
  coverage: Coverage;
}
