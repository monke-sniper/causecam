/**
 * CAUSECAM runtime bootstrap. Preload it into a Node.js server process:
 *
 *   NODE_OPTIONS="--import=<path>/dist/runtime/register.js" node server.js
 *
 * (`causecam run -- <cmd>` does this for you.) It initialises the official OpenTelemetry Node SDK with
 * HTTP, Express and Knex instrumentation plus CAUSECAM's route-handler hook, and exports spans
 * immediately (no batching delay) over OTLP/HTTP JSON to the local CAUSECAM collector.
 *
 * CommonJS-loaded modules are instrumented. ESM-loaded modules additionally need the OpenTelemetry
 * loader hook, enabled with CAUSECAM_ESM=1.
 */
import { register as registerLoader } from 'node:module';
import path from 'node:path';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { KnexInstrumentation } from '@opentelemetry/instrumentation-knex';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { installRouteHandlerHooks } from './handlers.js';
import { QueryCallSiteProcessor, installKnexCallSiteHook } from './knex.js';

const GLOBAL_KEY = Symbol.for('causecam.runtime.registered');
const g = globalThis as Record<symbol, unknown>;

function loopbackEndpoint(raw: string | undefined): string {
  const fallback = 'http://127.0.0.1:4319/v1/traces';
  if (!raw) return fallback;
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return u.toString();
  } catch {
    /* ignore */
  }
  process.stderr.write(`[causecam] refusing non-loopback collector URL; using ${fallback}\n`);
  return fallback;
}

if (!g[GLOBAL_KEY]) {
  g[GLOBAL_KEY] = true;
  const endpoint = loopbackEndpoint(process.env.CAUSECAM_COLLECTOR_URL);
  const collectorHost = new URL(endpoint).host;
  const serviceName = process.env.OTEL_SERVICE_NAME || process.env.CAUSECAM_SERVICE_NAME || path.basename(process.cwd());

  if (process.env.CAUSECAM_ESM === '1') {
    registerLoader('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
  }

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': serviceName }),
    spanProcessors: [new QueryCallSiteProcessor(), new SimpleSpanProcessor(new OTLPTraceExporter({ url: endpoint, timeoutMillis: 2000 }))],
  });
  provider.register();

  registerInstrumentations({
    instrumentations: [
      new HttpInstrumentation({
        ignoreOutgoingRequestHook: (req) => `${req.hostname ?? req.host ?? ''}:${req.port ?? ''}` === collectorHost,
      }),
      new ExpressInstrumentation(),
      new KnexInstrumentation({ maxQueryLength: 2000 }),
    ],
  });
  installKnexCallSiteHook(); // after registerInstrumentations: see knex.ts
  installRouteHandlerHooks();

  const shutdown = () => {
    provider.shutdown().catch(() => undefined);
  };
  process.once('beforeExit', shutdown);
}
