import { BrowserSession, type ActionInput, type ActionResult, type SessionOptions } from './browser/session.js';
import { log, type CauseCamConfig } from './config.js';
import { assembleTrace } from './core/assemble.js';
import { compareTraces, renderComparison } from './core/compare.js';
import { isSessionId } from './core/ids.js';
import { describeInteraction, q, renderTrace, UNTRUSTED_NOTE } from './core/render.js';
import { SourceResolver } from './core/source.js';
import { TraceStore } from './core/store.js';
import type { TraceView } from './core/types.js';

const MAX_SESSIONS = 3;

/** Core services shared by the MCP server and the CLI. */
export class CauseCam {
  readonly store: TraceStore;
  readonly resolver: SourceResolver;
  private readonly sessions = new Map<string, BrowserSession>();

  constructor(readonly config: CauseCamConfig) {
    this.store = new TraceStore(config.dataDir);
    this.resolver = new SourceResolver(config.repoRoot);
  }

  // -- sessions ------------------------------------------------------------

  async startSession(opts: SessionOptions): Promise<string> {
    const live = [...this.sessions.values()].filter((s) => !s.isClosed);
    if (live.length >= MAX_SESSIONS) throw new Error(`At most ${MAX_SESSIONS} sessions can be open; stop one first.`);
    const { session, initial } = await BrowserSession.start(this.store, opts);
    this.sessions.set(session.id, session);
    return [
      `session ${session.id} started`,
      `browser: chromium (${opts.headed ? 'headed' : 'headless'}), page: ${session.pageUrl}`,
      `allowed origins: ${[...session.allowedOrigins].join(', ')}`,
      `mutating requests (POST/PUT/PATCH/DELETE): ${session.allowMutations ? 'ALLOWED' : 'BLOCKED (restart with allowMutations=true to permit)'}`,
      '',
      'initial navigation:',
      formatActionResult(initial),
    ].join('\n');
  }

  private session(id: string): BrowserSession {
    if (!isSessionId(id)) throw new Error('Invalid session id.');
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Unknown session ${id}. Sessions live in the process that started them; start a new one.`);
    if (s.isClosed) throw new Error(`Session ${id} is closed.`);
    return s;
  }

  async perform(sessionId: string, input: ActionInput): Promise<ActionResult> {
    return this.session(sessionId).perform(input);
  }

  async stopSession(sessionId: string): Promise<string> {
    const s = this.session(sessionId);
    await s.stop();
    this.sessions.delete(sessionId);
    const traces = this.store.listTraces({ sessionId, limit: 200 });
    const views = traces.map((t) => this.view(t.traceId));
    const errors = views.filter((v) => v.status === 'error').length;
    return [
      `session ${sessionId} stopped; browser closed, ${traces.length} interaction trace(s) stored locally at ${this.store.file}`,
      `traces with errors: ${errors}`,
      ...views.slice(0, 20).map(summaryLine),
    ].join('\n');
  }

  async shutdown(): Promise<void> {
    for (const s of this.sessions.values()) await s.stop().catch((e) => log('stop failed', String(e)));
    this.sessions.clear();
    this.store.close();
  }

  // -- traces --------------------------------------------------------------

  view(traceId: string): TraceView {
    return assembleTrace(traceId, this.store.getTrace(traceId), this.store.getSpans(traceId), this.resolver);
  }

  listTraces(opts: { sessionId?: string; limit?: number; includeBackground?: boolean }): string {
    if (opts.sessionId && !isSessionId(opts.sessionId)) throw new Error('Invalid session id.');
    const entries = this.store.listTraces(opts);
    if (!entries.length) return 'No traces stored yet.';
    return [`${entries.length} most recent trace(s), newest first:`, ...entries.map((e) => summaryLine(this.view(e.traceId))), '', UNTRUSTED_NOTE].join('\n');
  }

  inspect(ref: string, opts: { format?: 'text' | 'json'; verbose?: boolean } = {}): string {
    const id = this.store.resolveTraceRef(ref);
    const v = this.view(id);
    return opts.format === 'json' ? JSON.stringify(v, null, 1) : renderTrace(v, { verbose: opts.verbose ?? false });
  }

  compare(refA: string, refB: string): string {
    const a = this.view(this.store.resolveTraceRef(refA));
    const b = this.view(this.store.resolveTraceRef(refB));
    return renderComparison(compareTraces(a, b), a, b);
  }
}

export function summaryLine(v: TraceView): string {
  const req = v.requests
    .filter((r) => !['script', 'stylesheet', 'image', 'font'].includes(r.resourceType))
    .slice(0, 4)
    .map((r) => `${r.method} ${r.path.split('?')[0]} -> ${r.blocked ? 'blocked' : r.failure ? 'failed' : (r.status ?? '?')}`)
    .join(', ');
  const firstErr = v.errors[0];
  const err = firstErr ? `  first error: ${firstErr.summary.split(';')[0]}${firstErr.message ? ` ${q(firstErr.message.slice(0, 120))}` : ''}` : '';
  return `- ${v.traceId}  ${v.status.toUpperCase()}  ${v.durationMs}ms  ${describeInteraction(v.trigger)}${req ? `  [${req}]` : ''}${err}`;
}

export function formatActionResult(r: ActionResult): string {
  const lines = [
    `${r.interactionId} ${r.action}${r.error ? ` FAILED: ${q(r.error)}` : ' ok'}  trace=${r.traceId}`,
    `page: ${r.pageUrl}`,
    `requests: ${r.requests.length ? r.requests.map((x) => `${x.method} ${x.path} -> ${x.outcome}`).join(', ') : 'none'}`,
    `backend spans received: ${r.backendSpans}; console/page errors: ${r.consoleErrors}`,
  ];
  if (r.blocked) lines.push(`${r.blocked} request(s) were blocked by CAUSECAM policy (see trace).`);
  lines.push(`next: causecam_inspect_trace traceId=${r.traceId}`);
  return lines.join('\n');
}
