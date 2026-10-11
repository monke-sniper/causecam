import path from 'node:path';
import { context, createContextKey, type Context } from '@opentelemetry/api';
import type { Span, SpanProcessor } from '@opentelemetry/sdk-trace-node';
import { Hook } from 'require-in-the-middle';
import { appCallSite, callSiteAttributes, type CallSite } from './callsite.js';

/**
 * Query call-site capture for Knex.
 *
 * Database errors raised by drivers usually carry a stack that ends inside the driver, with no
 * application frames. `await builder` invokes `then()` from a microtask, so the stack there has no
 * application frames either. We therefore capture the call site when the builder is created
 * (`db('table')` / `db.raw()`), which runs synchronously in application code, and put it in the
 * OpenTelemetry context the Knex instrumentation remembers for that builder. A span processor then
 * copies it onto the Knex query span.
 */

const CALL_SITE_KEY = createContextKey('causecam.query-call-site');
const PATCHED = Symbol.for('causecam.knex.patched');
const SITE = Symbol.for('causecam.knex.callsite');
const FACTORY_FILE_RE = /^knex\/lib\/(client|dialects\/[^/]+\/index)\.js$/;

type Fn = (...args: unknown[]) => unknown;
type Proto = Record<string | symbol, unknown>;

/**
 * Two execution paths exist, depending on the dialect:
 *  - Base `Client#queryBuilder`: the Knex instrumentation remembers the context active when the
 *    builder is created and parents the query span on it. Our factory wrapper must be the OUTER
 *    wrapper so the call site is already in that context, so install this hook AFTER
 *    `registerInstrumentations`.
 *  - Dialects that override `queryBuilder` (sqlite3, better-sqlite3, pg, mysql, ...): the
 *    instrumentation falls back to the context active when the query runs, so `then()` re-enters
 *    the call site captured at builder creation.
 */
export function installKnexCallSiteHook(): Hook {
  return new Hook(['knex'], { internals: true }, (exports, name) => {
    const n = name.split(path.sep).join('/');
    if (FACTORY_FILE_RE.test(n)) {
      patchFactories((exports as unknown as { prototype?: Proto }).prototype);
    } else if (n === 'knex/lib/builder-interface-augmenter.js') {
      const mod = exports as unknown as { augmentWithBuilderInterface: (Target: { prototype: Proto }) => void };
      const original = mod.augmentWithBuilderInterface;
      mod.augmentWithBuilderInterface = function (Target) {
        original(Target);
        patchThen(Target.prototype);
      };
    }
    return exports;
  });
}

function patchFactories(proto: Proto | undefined): void {
  if (!proto || Object.prototype.hasOwnProperty.call(proto, PATCHED)) return;
  proto[PATCHED] = true;
  for (const method of ['queryBuilder', 'schemaBuilder', 'raw']) {
    if (!Object.prototype.hasOwnProperty.call(proto, method)) continue;
    const original = proto[method];
    if (typeof original !== 'function') continue;
    proto[method] = function (this: unknown, ...args: unknown[]) {
      const site = appCallSite();
      if (!site) return (original as Fn).apply(this, args);
      return context.with(context.active().setValue(CALL_SITE_KEY, site), () => {
        const builder = (original as Fn).apply(this, args);
        if (builder && typeof builder === 'object' && !(SITE in builder)) (builder as Proto)[SITE] = site;
        return builder;
      });
    };
  }
}

function patchThen(proto: Proto): void {
  if (Object.prototype.hasOwnProperty.call(proto, PATCHED)) return;
  proto[PATCHED] = true;
  const then = proto.then as Fn;
  proto.then = function (this: Proto, ...args: unknown[]) {
    const site = this[SITE] as CallSite | undefined;
    if (!site) return then.apply(this, args);
    return context.with(context.active().setValue(CALL_SITE_KEY, site), () => then.apply(this, args));
  };
}

/** Copies the captured query call site onto spans produced by the Knex instrumentation. */
export class QueryCallSiteProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    const site = parentContext.getValue(CALL_SITE_KEY) as CallSite | undefined;
    if (!site || !span.instrumentationScope.name.includes('knex')) return;
    span.setAttributes(callSiteAttributes(site, 'query-call-site'));
  }
  onEnd(): void {}
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
