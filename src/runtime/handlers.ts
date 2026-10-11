import { METHODS } from 'node:http';
import path from 'node:path';
import { SpanKind, SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { Hook } from 'require-in-the-middle';
import { appCallSite, callSiteAttributes, type CallSite } from './callsite.js';

/**
 * Express route-handler instrumentation.
 *
 * The official Express instrumentation reports the route path but not where the handler lives, and
 * (for Express 5 async handlers) does not record the rejection that produced a 500. This hook wraps
 * every handler passed to `Route#get/post/...` at registration time:
 *
 *  - it records the call site of the registration (first frame outside node_modules) as `code.*`
 *    attributes, tagged `causecam.source = route-registration`;
 *  - it opens a child span around the handler so database spans nest under it;
 *  - it records thrown errors and rejected promises (with stack) on that span.
 *
 * Only handlers registered through express/router `Route` objects are covered; plain `app.use`
 * middleware is not wrapped.
 */

const tracer = trace.getTracer('causecam-route-handlers', '0.1.0');
const ROUTE_METHODS = [...METHODS.map((m) => m.toLowerCase()), 'all'];
const PATCHED = Symbol.for('causecam.route.patched');

export function installRouteHandlerHooks(): Hook {
  return new Hook(['router', 'express'], { internals: true }, (exports, name) => {
    const n = name.split(path.sep).join('/');
    if (n === 'router/lib/route.js' || n === 'express/lib/router/route.js') patchRoute(exports as unknown as RouteCtor);
    return exports;
  });
}

type Handler = (...args: unknown[]) => unknown;
interface RouteCtor {
  prototype: Record<string, unknown> & { [PATCHED]?: boolean };
}

export function patchRoute(Route: RouteCtor): void {
  const proto = Route.prototype;
  if (!proto || proto[PATCHED]) return;
  proto[PATCHED] = true;
  for (const method of ROUTE_METHODS) {
    const original = proto[method];
    if (typeof original !== 'function') continue;
    proto[method] = function patched(this: { path?: string }, ...args: unknown[]) {
      const site = appCallSite();
      const routePath = typeof this.path === 'string' ? this.path : '';
      const wrapped = (args as unknown[]).flat(Infinity).map((h) => (typeof h === 'function' ? wrapHandler(h as Handler, method, routePath, site) : h));
      return (original as Handler).apply(this, wrapped);
    };
  }
}

function wrapHandler(fn: Handler, method: string, routePath: string, site: CallSite | undefined): Handler {
  const label = `${method === 'all' ? 'ALL' : method.toUpperCase()} ${routePath || '/'}`;
  const attributes: Record<string, string | number> = {
    ...(site ? callSiteAttributes(site, 'route-registration') : {}),
    'causecam.handler.route': routePath,
    'code.function': fn.name || '<anonymous>',
  };

  const wrapped = function (this: unknown, ...args: unknown[]) {
    return tracer.startActiveSpan(`handler ${label}`, { kind: SpanKind.INTERNAL, attributes }, (span) => {
      let ended = false;
      const end = () => {
        if (!ended) {
          ended = true;
          span.end();
        }
      };
      const nextIdx = findLastIndex(args, (a) => typeof a === 'function');
      if (nextIdx !== -1) {
        const next = args[nextIdx] as Handler;
        args[nextIdx] = function wrappedNext(this: unknown, ...nextArgs: unknown[]) {
          const err = nextArgs[0];
          if (err !== undefined && err !== null && err !== 'route' && err !== 'router') recordError(span, err);
          end();
          return next.apply(this, nextArgs);
        };
      }
      const res = args.find(isResponse);
      try {
        const ret = fn.apply(this, args);
        if (ret && typeof (ret as Promise<unknown>).then === 'function') {
          (ret as Promise<unknown>).then(end, (err: unknown) => {
            recordError(span, err);
            end();
          });
        } else if (res) {
          res.once('finish', end);
          res.once('close', end);
        } else {
          end();
        }
        return ret;
      } catch (err) {
        recordError(span, err);
        end();
        throw err;
      }
    });
  };
  Object.defineProperty(wrapped, 'length', { value: fn.length });
  Object.defineProperty(wrapped, 'name', { value: fn.name });
  return wrapped;
}

function recordError(span: Span, err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  span.recordException(e);
  span.setStatus({ code: SpanStatusCode.ERROR, message: e.message.slice(0, 500) });
}

function isResponse(v: unknown): v is { once(ev: string, cb: () => void): void } {
  return typeof v === 'object' && v !== null && typeof (v as { once?: unknown }).once === 'function' && 'statusCode' in v && 'setHeader' in v;
}

function findLastIndex<T>(a: T[], pred: (x: T) => boolean): number {
  for (let i = a.length - 1; i >= 0; i--) if (pred(a[i]!)) return i;
  return -1;
}
