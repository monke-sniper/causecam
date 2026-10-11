#!/usr/bin/env node
import { createRequire } from 'node:module';
import path from 'node:path';
import { Command } from 'commander';
import { DEFAULT_DEMO_PORT, loadConfig, parsePort } from './config.js';

// node:sqlite prints an ExperimentalWarning on load. It is expected; keep stderr readable.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const msg = typeof warning === 'string' ? warning : warning.message;
  if (msg.includes('SQLite is an experimental feature')) return;
  return (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const program = new Command();
program.name('causecam').description('Source-linked runtime tracing for AI coding agents').version('0.1.0');

program
  .command('mcp')
  .description('Start the MCP server on stdio (for Claude Code and other MCP clients)')
  .action(async () => {
    const { runMcpServer } = await import('./mcp/server.js');
    await runMcpServer(loadConfig());
  });

program
  .command('run')
  .description('Run a Node.js server with CAUSECAM instrumentation and a local collector: causecam run -- npm run dev')
  .option('--service <name>', 'service name reported in traces')
  .option('--esm', 'also instrument ES modules (enables the OpenTelemetry loader hook)')
  .argument('<command...>', 'command to run')
  .action(async (command: string[], opts: { service?: string; esm?: boolean }) => {
    const { runInstrumented } = await import('./run.js');
    process.exitCode = await runInstrumented(command, loadConfig(), {
      ...(opts.service ? { serviceName: opts.service } : {}),
      ...(opts.esm ? { esm: true } : {}),
    });
  });

program
  .command('collector')
  .description('Run only the local OTLP/HTTP JSON collector (for apps that configure their own OpenTelemetry SDK)')
  .action(async () => {
    const { TraceStore } = await import('./core/store.js');
    const { ensureCollector } = await import('./collector.js');
    const config = loadConfig();
    const store = new TraceStore(config.dataDir);
    const c = await ensureCollector(store, config.collectorPort);
    console.log(`collector ${c.owned ? 'listening' : 'already running'} at ${c.url} (store: ${store.file})`);
    console.log('Point your exporter at it: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=' + c.url + ' OTEL_EXPORTER_OTLP_PROTOCOL=http/json');
    if (!c.owned) process.exit(0);
  });

program
  .command('demo')
  .description('Start the bundled demo app (with its seeded bug) under CAUSECAM instrumentation')
  .option('--port <port>', 'demo app port', String(DEFAULT_DEMO_PORT))
  .option('--no-watch', 'do not restart the app when demo source files change')
  .action(async (opts: { port: string; watch: boolean }) => {
    const { runInstrumented, PKG_ROOT } = await import('./run.js');
    const port = parsePort(opts.port, DEFAULT_DEMO_PORT);
    const config = loadConfig({ ...process.env, CAUSECAM_REPO_ROOT: process.env.CAUSECAM_REPO_ROOT ?? PKG_ROOT }, PKG_ROOT);
    const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
    const args = [tsxCli, ...(opts.watch ? ['watch', '--clear-screen=false'] : []), path.join(PKG_ROOT, 'demo', 'src', 'server.ts')];
    console.log(
      [
        '',
        `CAUSECAM demo: settings app at http://localhost:${port}`,
        `  traces:   ${config.dataDir}`,
        `  bug:      saving settings with a time zone such as Europe/Berlin fails`,
        `  connect:  claude mcp add causecam -- node ${path.join(PKG_ROOT, 'dist', 'cli.js')} mcp`,
        `  then ask Claude: "Use causecam to reproduce the settings-save failure at http://localhost:${port} with time zone Europe/Berlin, find the cause, fix it, and verify."`,
        '',
      ].join('\n'),
    );
    process.exitCode = await runInstrumented([process.execPath, ...args], config, {
      cwd: PKG_ROOT,
      serviceName: 'causecam-demo',
      env: { PORT: String(port), DEMO_DB: path.join(config.dataDir, 'demo.sqlite') },
    });
  });

program
  .command('doctor')
  .description('Check dependencies and configuration')
  .action(async () => {
    const { doctor } = await import('./doctor.js');
    const { checks, ok } = await doctor(loadConfig());
    for (const c of checks) console.log(`${c.ok ? '✓' : c.warn ? '!' : '✗'} ${c.name}: ${c.detail}`);
    console.log(ok ? '\nAll required checks passed.' : '\nSome required checks failed.');
    process.exitCode = ok ? 0 : 1;
  });

const traces = program.command('traces').description('Inspect locally stored traces');

traces
  .command('list', { isDefault: true })
  .description('List recent traces')
  .option('--session <id>', 'only traces from this session')
  .option('--limit <n>', 'maximum number of traces', '20')
  .option('--all', 'include background activity')
  .action(async (opts: { session?: string; limit: string; all?: boolean }) => {
    const cc = await service();
    console.log(cc.listTraces({ ...(opts.session ? { sessionId: opts.session } : {}), limit: Number(opts.limit), includeBackground: !!opts.all }));
    await cc.shutdown();
  });

traces
  .command('show <traceId>')
  .description('Show one trace')
  .option('--json', 'structured JSON output')
  .option('--verbose', 'show static resources and middleware spans')
  .action(async (id: string, opts: { json?: boolean; verbose?: boolean }) => {
    const cc = await service();
    console.log(cc.inspect(id, { format: opts.json ? 'json' : 'text', verbose: !!opts.verbose }));
    await cc.shutdown();
  });

traces
  .command('compare <a> <b>')
  .description('Compare two traces')
  .action(async (a: string, b: string) => {
    const cc = await service();
    console.log(cc.compare(a, b));
    await cc.shutdown();
  });

traces
  .command('delete <traceId>')
  .description('Delete one trace and its spans')
  .action(async (id: string) => {
    const cc = await service();
    const full = cc.store.resolveTraceRef(id);
    cc.store.deleteTrace(full);
    console.log(`deleted ${full}`);
    await cc.shutdown();
  });

traces
  .command('purge')
  .description('Delete ALL local trace data')
  .option('--yes', 'confirm')
  .action(async (opts: { yes?: boolean }) => {
    if (!opts.yes) {
      console.error('Refusing to purge without --yes');
      process.exitCode = 1;
      return;
    }
    const cc = await service();
    const r = cc.store.purge();
    console.log(`purged ${r.traces} traces, ${r.spans} spans, ${r.sessions} sessions from ${cc.store.file}`);
    await cc.shutdown();
  });

async function service() {
  const { CauseCam } = await import('./services.js');
  return new CauseCam(loadConfig());
}

program.parseAsync(process.argv).catch((e: Error) => {
  console.error(`causecam: ${e.message}`);
  process.exit(1);
});
