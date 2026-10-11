import { spanLabel } from './assemble.js';
import { describeInteraction, q, UNTRUSTED_NOTE } from './render.js';
import type { ErrorItem, SpanNode, TraceView } from './types.js';

export interface RequestDiff {
  key: string;
  a?: { status?: number; outcome: string; durationMs?: number };
  b?: { status?: number; outcome: string; durationMs?: number };
}

export interface SpanDiff {
  signature: string;
  a?: { status: string; durationMs: number };
  b?: { status: string; durationMs: number };
}

export interface Comparison {
  a: { traceId: string; status: string; durationMs: number };
  b: { traceId: string; status: string; durationMs: number };
  sameTrigger: boolean;
  requests: RequestDiff[];
  spans: { changed: SpanDiff[]; onlyInA: string[]; onlyInB: string[] };
  queries: { onlyInA: string[]; onlyInB: string[]; common: number };
  errors: { resolvedInB: ErrorItem[]; newInB: ErrorItem[]; persisting: ErrorItem[] };
  sources: { onlyInA: string[]; onlyInB: string[] };
}

function triggerKey(v: TraceView): string {
  const t = v.trigger;
  if (!t) return 'background';
  return JSON.stringify([t.type, t.target ?? null, t.element?.name ?? null, t.element?.testId ?? null, t.url ?? null]);
}

function outcome(r: TraceView['requests'][number]): string {
  return r.blocked ? `blocked:${r.blocked}` : r.failure ? 'failed' : r.status !== undefined ? String(r.status) : 'pending';
}

function stripQuery(path: string): string {
  return path.split('?')[0] ?? path;
}

function flatten(v: TraceView): SpanNode[] {
  const out: SpanNode[] = [];
  const walk = (n: SpanNode) => {
    out.push(n);
    n.children.forEach(walk);
  };
  v.requests.forEach((r) => r.spans.forEach(walk));
  v.unattachedSpans.forEach(walk);
  return out;
}

function signature(n: SpanNode): string {
  const sql = n.details['db.query.text'] ?? n.details['db.statement'];
  return n.layer === 'db' && typeof sql === 'string' ? `${spanLabel(n)} | ${sql}` : `${n.layer}: ${spanLabel(n)}`;
}

/** Group items by key, preserving occurrence order so repeated requests/spans align pairwise. */
function keyed<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    m.set(k, [...(m.get(k) ?? []), it]);
  }
  return m;
}

function errorKey(e: ErrorItem): string {
  return `${e.layer}|${e.summary.replace(/; error also recorded on:.*$/, '')}|${e.message ?? ''}`;
}

/**
 * Structural comparison of two traces. It reports where the runs diverge; it deliberately does not
 * label any difference as the cause of a bug.
 */
export function compareTraces(a: TraceView, b: TraceView): Comparison {
  const reqA = keyed(a.requests, (r) => `${r.method} ${stripQuery(r.path)}`);
  const reqB = keyed(b.requests, (r) => `${r.method} ${stripQuery(r.path)}`);
  const requests: RequestDiff[] = [];
  for (const key of new Set([...reqA.keys(), ...reqB.keys()])) {
    const la = reqA.get(key) ?? [];
    const lb = reqB.get(key) ?? [];
    for (let i = 0; i < Math.max(la.length, lb.length); i++) {
      const ra = la[i];
      const rb = lb[i];
      const d: RequestDiff = { key: la.length > 1 || lb.length > 1 ? `${key} #${i + 1}` : key };
      if (ra) d.a = { outcome: outcome(ra), ...(ra.status !== undefined ? { status: ra.status } : {}), ...(ra.durationMs !== undefined ? { durationMs: ra.durationMs } : {}) };
      if (rb) d.b = { outcome: outcome(rb), ...(rb.status !== undefined ? { status: rb.status } : {}), ...(rb.durationMs !== undefined ? { durationMs: rb.durationMs } : {}) };
      requests.push(d);
    }
  }

  const spA = keyed(flatten(a), signature);
  const spB = keyed(flatten(b), signature);
  const changed: SpanDiff[] = [];
  const onlyInA: string[] = [];
  const onlyInB: string[] = [];
  for (const sig of new Set([...spA.keys(), ...spB.keys()])) {
    const la = spA.get(sig) ?? [];
    const lb = spB.get(sig) ?? [];
    for (let i = 0; i < Math.max(la.length, lb.length); i++) {
      const sa = la[i];
      const sb = lb[i];
      if (sa && !sb) onlyInA.push(sig);
      else if (sb && !sa) onlyInB.push(sig);
      else if (sa && sb) {
        const durDelta = Math.abs(sa.durationMs - sb.durationMs);
        if (sa.status !== sb.status || durDelta > Math.max(20, 0.5 * Math.max(sa.durationMs, sb.durationMs))) {
          changed.push({ signature: sig, a: { status: sa.status, durationMs: sa.durationMs }, b: { status: sb.status, durationMs: sb.durationMs } });
        }
      }
    }
  }

  const sqlOf = (v: TraceView) =>
    flatten(v)
      .filter((n) => n.layer === 'db')
      .map((n) => String(n.details['db.query.text'] ?? n.details['db.statement'] ?? spanLabel(n)));
  const qa = sqlOf(a);
  const qb = sqlOf(b);
  const errA = new Map(a.errors.map((e) => [errorKey(e), e]));
  const errB = new Map(b.errors.map((e) => [errorKey(e), e]));
  const srcOf = (v: TraceView) =>
    new Set(
      flatten(v)
        .filter((n) => n.source)
        .map((n) => `${n.source!.path}:${n.source!.line ?? '?'} (${n.source!.origin})`),
    );
  const sa = srcOf(a);
  const sb = srcOf(b);

  return {
    a: { traceId: a.traceId, status: a.status, durationMs: a.durationMs },
    b: { traceId: b.traceId, status: b.status, durationMs: b.durationMs },
    sameTrigger: triggerKey(a) === triggerKey(b),
    requests,
    spans: { changed, onlyInA, onlyInB },
    queries: { onlyInA: qa.filter((x) => !qb.includes(x)), onlyInB: qb.filter((x) => !qa.includes(x)), common: qa.filter((x) => qb.includes(x)).length },
    errors: {
      resolvedInB: [...errA].filter(([k]) => !errB.has(k)).map(([, e]) => e),
      newInB: [...errB].filter(([k]) => !errA.has(k)).map(([, e]) => e),
      persisting: [...errA].filter(([k]) => errB.has(k)).map(([, e]) => e),
    },
    sources: { onlyInA: [...sa].filter((x) => !sb.has(x)), onlyInB: [...sb].filter((x) => !sa.has(x)) },
  };
}

export function renderComparison(c: Comparison, a: TraceView, b: TraceView): string {
  const out: string[] = [];
  out.push(`CAUSECAM COMPARE  A=${c.a.traceId} (${c.a.status.toUpperCase()}, ${c.a.durationMs}ms)  vs  B=${c.b.traceId} (${c.b.status.toUpperCase()}, ${c.b.durationMs}ms)`);
  out.push(`trigger A: ${describeInteraction(a.trigger)}`);
  out.push(`trigger B: ${describeInteraction(b.trigger)}`);
  if (!c.sameTrigger) out.push('WARNING: the triggering actions differ, so differences may reflect different workflows.');
  out.push('');

  out.push('REQUESTS (A -> B)');
  for (const r of c.requests) {
    const fa = r.a ? `${r.a.outcome}${r.a.durationMs !== undefined ? ` ${r.a.durationMs}ms` : ''}` : '(absent)';
    const fb = r.b ? `${r.b.outcome}${r.b.durationMs !== undefined ? ` ${r.b.durationMs}ms` : ''}` : '(absent)';
    const mark = r.a?.outcome !== r.b?.outcome ? '  <- changed' : '';
    out.push(`  ${r.key}: ${fa} -> ${fb}${mark}`);
  }
  if (!c.requests.length) out.push('  (no requests in either trace)');
  out.push('');

  out.push('BACKEND SPANS');
  if (!c.spans.changed.length && !c.spans.onlyInA.length && !c.spans.onlyInB.length) out.push('  no structural or status differences');
  // OTel "unset" means no error was recorded on the span.
  const st = (x: string) => (x === 'unset' ? 'no error' : x);
  for (const s of c.spans.changed) out.push(`  changed: ${s.signature}: ${st(s.a!.status)} ${s.a!.durationMs}ms -> ${st(s.b!.status)} ${s.b!.durationMs}ms`);
  for (const s of c.spans.onlyInA) out.push(`  only in A: ${s}`);
  for (const s of c.spans.onlyInB) out.push(`  only in B: ${s}`);
  out.push('');

  out.push(`DATABASE QUERIES: ${c.queries.common} identical statement(s) in both`);
  for (const s of c.queries.onlyInA) out.push(`  only in A: ${s}`);
  for (const s of c.queries.onlyInB) out.push(`  only in B: ${s}`);
  out.push('');

  out.push('ERRORS');
  const errLine = (e: ErrorItem) => `[${e.layer}] ${e.summary}${e.message ? ` message=${q(e.message)}` : ''}`;
  for (const e of c.errors.resolvedInB) out.push(`  present in A, absent in B: ${errLine(e)}`);
  for (const e of c.errors.newInB) out.push(`  new in B: ${errLine(e)}`);
  for (const e of c.errors.persisting) out.push(`  in both: ${errLine(e)}`);
  if (!c.errors.resolvedInB.length && !c.errors.newInB.length && !c.errors.persisting.length) out.push('  none in either trace');
  out.push('');

  if (c.sources.onlyInA.length || c.sources.onlyInB.length) {
    out.push('SOURCE REFERENCES (line numbers can shift when code is edited)');
    for (const s of c.sources.onlyInA) out.push(`  only in A: ${s}`);
    for (const s of c.sources.onlyInB) out.push(`  only in B: ${s}`);
    out.push('');
  }
  out.push('NOTE: these are observed differences between two runs. They show where the runs diverged, not by themselves why.');
  out.push(UNTRUSTED_NOTE);
  return out.join('\n');
}
