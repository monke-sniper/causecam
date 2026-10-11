import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureCollector } from './collector.js';
import { log, type CauseCamConfig } from './config.js';
import { TraceStore } from './core/store.js';

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REGISTER_PATH = path.join(PKG_ROOT, 'dist', 'runtime', 'register.js');

export interface RunOptions {
  serviceName?: string;
  esm?: boolean;
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Run a command with CAUSECAM's runtime preloaded (via NODE_OPTIONS) and a local collector receiving
 * its spans. Resolves with the child's exit code.
 */
export async function runInstrumented(command: string[], config: CauseCamConfig, opts: RunOptions = {}): Promise<number> {
  if (!command.length) throw new Error('No command given. Usage: causecam run -- <command> [args...]');
  const store = new TraceStore(config.dataDir);
  const collector = await ensureCollector(store, config.collectorPort);
  log(`collector ${collector.owned ? 'listening' : 'reused'} at ${collector.url}; traces stored in ${store.file}`);

  const nodeOptions = [process.env.NODE_OPTIONS, `--import=${pathToFileURL(REGISTER_PATH).href}`].filter(Boolean).join(' ');
  const child = spawn(command[0]!, command.slice(1), {
    cwd: opts.cwd ?? process.cwd(),
    stdio: 'inherit',
    env: {
      ...process.env,
      ...opts.env,
      NODE_OPTIONS: nodeOptions,
      CAUSECAM_COLLECTOR_URL: collector.url,
      ...(opts.serviceName ? { OTEL_SERVICE_NAME: opts.serviceName } : {}),
      ...(opts.esm ? { CAUSECAM_ESM: '1' } : {}),
    },
  });

  const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
  const onInt = forward('SIGINT');
  const onTerm = forward('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);

  const code = await new Promise<number>((resolve) => {
    child.on('error', (e) => {
      log(`failed to start ${command[0]}: ${e.message}`);
      resolve(127);
    });
    child.on('exit', (c, sig) => resolve(c ?? (sig ? 128 : 1)));
  });
  process.off('SIGINT', onInt);
  process.off('SIGTERM', onTerm);
  await collector.close();
  store.close();
  return code;
}
