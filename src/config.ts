import path from 'node:path';

/** Default port for the local OTLP/HTTP receiver. 4318 is the OTLP default; we use 4319 to avoid clashing with a real collector. */
export const DEFAULT_COLLECTOR_PORT = 4319;
export const DEFAULT_DEMO_PORT = 4400;

export interface CauseCamConfig {
  /** Directory that holds causecam.db. */
  dataDir: string;
  /** Repository root used to make source paths repo-relative. Paths outside it are never presented as app source. */
  repoRoot: string;
  collectorPort: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): CauseCamConfig {
  const repoRoot = path.resolve(env.CAUSECAM_REPO_ROOT ?? cwd);
  const dataDir = path.resolve(env.CAUSECAM_DATA_DIR ?? path.join(repoRoot, '.causecam'));
  const collectorPort = parsePort(env.CAUSECAM_COLLECTOR_PORT, DEFAULT_COLLECTOR_PORT);
  return { dataDir, repoRoot, collectorPort };
}

export function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Invalid port: ${value}`);
  return n;
}

/** Internal diagnostics always go to stderr so the MCP stdio stream is never corrupted. */
export function log(...args: unknown[]): void {
  process.stderr.write(`[causecam] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
}
