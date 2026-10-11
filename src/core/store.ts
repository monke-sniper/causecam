import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TRACE_REF_RE, isTraceId } from './ids.js';
import type { SessionRecord, StoredSpan, TraceKind, TraceRecord } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  allowed_origins TEXT NOT NULL,
  allow_mutations INTEGER NOT NULL,
  started_at REAL NOT NULL,
  ended_at REAL
);
CREATE TABLE IF NOT EXISTS traces (
  trace_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  interaction TEXT,
  page_url_before TEXT,
  page_url_after TEXT,
  started_at REAL NOT NULL,
  ended_at REAL NOT NULL,
  network TEXT NOT NULL,
  events TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS traces_session ON traces(session_id, started_at);
CREATE TABLE IF NOT EXISTS spans (
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  name TEXT NOT NULL,
  kind INTEGER NOT NULL,
  start_ms REAL NOT NULL,
  end_ms REAL NOT NULL,
  status_code INTEGER NOT NULL,
  status_message TEXT,
  attributes TEXT NOT NULL,
  events TEXT NOT NULL,
  service_name TEXT NOT NULL,
  scope TEXT NOT NULL,
  dropped INTEGER NOT NULL,
  received_at REAL NOT NULL,
  PRIMARY KEY (trace_id, span_id)
);
`;

export interface TraceListEntry {
  traceId: string;
  sessionId: string;
  kind: TraceKind;
  startedAt: number;
  endedAt: number;
  record: TraceRecord;
}

type Row = Record<string, unknown>;

/** Local SQLite persistence shared by the CLI, the collector and the MCP server (WAL mode, multi-process safe). */
export class TraceStore {
  readonly db: DatabaseSync;
  readonly file: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = path.join(dataDir, 'causecam.db');
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* best effort */
    }
  }

  close(): void {
    this.db.close();
  }

  // -- sessions ------------------------------------------------------------

  createSession(s: SessionRecord): void {
    this.db
      .prepare('INSERT INTO sessions (session_id, origin, allowed_origins, allow_mutations, started_at, ended_at) VALUES (?, ?, ?, ?, ?, NULL)')
      .run(s.sessionId, s.origin, JSON.stringify(s.allowedOrigins), s.allowMutations ? 1 : 0, s.startedAt);
  }

  endSession(sessionId: string, endedAt: number): void {
    this.db.prepare('UPDATE sessions SET ended_at = ? WHERE session_id = ?').run(endedAt, sessionId);
  }

  getSession(sessionId: string): SessionRecord | undefined {
    const r = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as Row | undefined;
    return r ? rowToSession(r) : undefined;
  }

  listSessions(limit = 20): SessionRecord[] {
    return (this.db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?').all(limit) as Row[]).map(rowToSession);
  }

  // -- traces --------------------------------------------------------------

  saveTrace(t: TraceRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO traces (trace_id, session_id, kind, interaction, page_url_before, page_url_after, started_at, ended_at, network, events)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.traceId,
        t.sessionId,
        t.kind,
        t.interaction ? JSON.stringify(t.interaction) : null,
        t.pageUrlBefore ?? null,
        t.pageUrlAfter ?? null,
        t.startedAt,
        t.endedAt,
        JSON.stringify(t.network),
        JSON.stringify(t.events),
      );
  }

  getTrace(traceId: string): TraceRecord | undefined {
    if (!isTraceId(traceId)) return undefined;
    const r = this.db.prepare('SELECT * FROM traces WHERE trace_id = ?').get(traceId) as Row | undefined;
    return r ? rowToTrace(r) : undefined;
  }

  /**
   * Resolve a full trace id or a unique prefix (>= 8 hex chars) against captured traces and received spans.
   * Throws a descriptive error for invalid, unknown or ambiguous references.
   */
  resolveTraceRef(ref: string): string {
    const r = ref.trim().toLowerCase();
    if (!TRACE_REF_RE.test(r)) throw new Error('Invalid trace id: expected 8-32 lowercase hex characters.');
    const like = `${r}%`;
    const ids = new Set<string>();
    for (const row of this.db.prepare('SELECT trace_id FROM traces WHERE trace_id LIKE ? LIMIT 3').all(like) as Row[]) ids.add(String(row.trace_id));
    for (const row of this.db.prepare('SELECT DISTINCT trace_id FROM spans WHERE trace_id LIKE ? LIMIT 3').all(like) as Row[]) ids.add(String(row.trace_id));
    if (ids.size === 0) throw new Error(`No trace found for id ${r}.`);
    if (ids.size > 1) throw new Error(`Trace id prefix ${r} is ambiguous; use more characters.`);
    return [...ids][0]!;
  }

  listTraces(opts: { sessionId?: string; limit?: number; includeBackground?: boolean } = {}): TraceListEntry[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.sessionId) {
      where.push('session_id = ?');
      params.push(opts.sessionId);
    }
    if (!opts.includeBackground) where.push("kind = 'interaction'");
    const sql = `SELECT * FROM traces ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ?`;
    params.push(Math.max(1, Math.min(opts.limit ?? 20, 200)));
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => {
      const record = rowToTrace(r);
      return { traceId: record.traceId, sessionId: record.sessionId, kind: record.kind, startedAt: record.startedAt, endedAt: record.endedAt, record };
    });
  }

  deleteTrace(traceId: string): boolean {
    if (!isTraceId(traceId)) throw new Error('Invalid trace id.');
    const a = this.db.prepare('DELETE FROM traces WHERE trace_id = ?').run(traceId);
    const b = this.db.prepare('DELETE FROM spans WHERE trace_id = ?').run(traceId);
    return Number(a.changes) + Number(b.changes) > 0;
  }

  purge(): { traces: number; spans: number; sessions: number } {
    const traces = Number(this.db.prepare('DELETE FROM traces').run().changes);
    const spans = Number(this.db.prepare('DELETE FROM spans').run().changes);
    const sessions = Number(this.db.prepare('DELETE FROM sessions').run().changes);
    this.db.exec('VACUUM');
    return { traces, spans, sessions };
  }

  // -- spans ---------------------------------------------------------------

  insertSpans(spans: StoredSpan[], receivedAt = Date.now()): number {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO spans (trace_id, span_id, parent_span_id, name, kind, start_ms, end_ms, status_code, status_message, attributes, events, service_name, scope, dropped, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN');
    try {
      for (const s of spans) {
        stmt.run(
          s.traceId,
          s.spanId,
          s.parentSpanId ?? null,
          s.name,
          s.kind,
          s.startMs,
          s.endMs,
          s.statusCode,
          s.statusMessage ?? null,
          JSON.stringify(s.attributes),
          JSON.stringify(s.events),
          s.serviceName,
          s.scope,
          s.droppedAttributes,
          receivedAt,
        );
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return spans.length;
  }

  getSpans(traceId: string): StoredSpan[] {
    if (!isTraceId(traceId)) return [];
    return (this.db.prepare('SELECT * FROM spans WHERE trace_id = ? ORDER BY start_ms').all(traceId) as Row[]).map(rowToSpan);
  }

  /** Number of spans received for a trace, and the latest receive time. Used to wait for late-arriving spans. */
  spanStats(traceId: string): { count: number; lastReceivedAt: number } {
    const r = this.db.prepare('SELECT COUNT(*) AS c, MAX(received_at) AS m FROM spans WHERE trace_id = ?').get(traceId) as Row;
    return { count: Number(r.c ?? 0), lastReceivedAt: Number(r.m ?? 0) };
  }

  serverSpanParents(traceId: string): Set<string> {
    const rows = this.db.prepare('SELECT parent_span_id FROM spans WHERE trace_id = ? AND kind = 2 AND parent_span_id IS NOT NULL').all(traceId) as Row[];
    return new Set(rows.map((r) => String(r.parent_span_id)));
  }

  stats(): { sessions: number; traces: number; spans: number } {
    const n = (t: string) => Number((this.db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as Row).c);
    return { sessions: n('sessions'), traces: n('traces'), spans: n('spans') };
  }
}

function rowToSession(r: Row): SessionRecord {
  const s: SessionRecord = {
    sessionId: String(r.session_id),
    origin: String(r.origin),
    allowedOrigins: JSON.parse(String(r.allowed_origins)) as string[],
    allowMutations: Number(r.allow_mutations) === 1,
    startedAt: Number(r.started_at),
  };
  if (r.ended_at !== null && r.ended_at !== undefined) s.endedAt = Number(r.ended_at);
  return s;
}

function rowToTrace(r: Row): TraceRecord {
  const t: TraceRecord = {
    traceId: String(r.trace_id),
    sessionId: String(r.session_id),
    kind: String(r.kind) as TraceKind,
    startedAt: Number(r.started_at),
    endedAt: Number(r.ended_at),
    network: JSON.parse(String(r.network)),
    events: JSON.parse(String(r.events)),
  };
  if (r.interaction) t.interaction = JSON.parse(String(r.interaction));
  if (r.page_url_before) t.pageUrlBefore = String(r.page_url_before);
  if (r.page_url_after) t.pageUrlAfter = String(r.page_url_after);
  return t;
}

function rowToSpan(r: Row): StoredSpan {
  const s: StoredSpan = {
    traceId: String(r.trace_id),
    spanId: String(r.span_id),
    name: String(r.name),
    kind: Number(r.kind),
    startMs: Number(r.start_ms),
    endMs: Number(r.end_ms),
    statusCode: Number(r.status_code),
    attributes: JSON.parse(String(r.attributes)),
    events: JSON.parse(String(r.events)),
    serviceName: String(r.service_name),
    scope: String(r.scope),
    droppedAttributes: Number(r.dropped),
  };
  if (r.parent_span_id) s.parentSpanId = String(r.parent_span_id);
  if (r.status_message) s.statusMessage = String(r.status_message);
  return s;
}
