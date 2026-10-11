/**
 * End-to-end: real demo app (instrumented via `causecam run`), real Chromium, real MCP server over
 * stdio, real spans. Reproduces the seeded bug, diagnoses it from the trace, applies the fix to a
 * scratch copy of the demo, re-runs the interaction and compares the traces.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const TSX = createRequire(import.meta.url).resolve('tsx/cli');
// Inside the repo so the copied demo resolves express/knex from the root node_modules.
const WORK = path.join(ROOT, '.causecam-test', randomBytes(4).toString('hex'));
const DATA = path.join(WORK, '.data');

let appPort: number;
let collectorPort: number;
let app: ChildProcess | undefined;
let client: Client;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function startApp(): Promise<void> {
  app = spawn(process.execPath, [CLI, 'run', '--service', 'e2e-demo', '--', process.execPath, TSX, path.join(WORK, 'demo', 'src', 'server.ts')], {
    cwd: WORK,
    env: { ...process.env, CAUSECAM_DATA_DIR: DATA, CAUSECAM_COLLECTOR_PORT: String(collectorPort), PORT: String(appPort), DEMO_DB: path.join(DATA, 'demo.sqlite') },
    stdio: ['ignore', 'ignore', 'inherit'],
    detached: true,
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${appPort}/healthz`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('demo app did not start');
}

async function stopApp(): Promise<void> {
  if (!app?.pid) return;
  const exited = new Promise((r) => app!.once('exit', r));
  try {
    process.kill(-app.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  app = undefined;
}

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const r = await client.callTool({ name, arguments: args });
  return { text: (r.content as { text: string }[]).map((c) => c.text).join('\n'), isError: r.isError === true };
}

const sessionOf = (t: string) => /session (ses_[0-9a-f]{8}) started/.exec(t)![1]!;
const traceOf = (t: string) => /trace=([0-9a-f]{32})/.exec(t)![1]!;

beforeAll(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  fs.cpSync(path.join(ROOT, 'demo'), path.join(WORK, 'demo'), { recursive: true, filter: (src) => !src.includes(`${path.sep}data`) });
  appPort = await freePort();
  collectorPort = await freePort();
  await startApp();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp'],
    cwd: WORK,
    env: { ...(process.env as Record<string, string>), CAUSECAM_DATA_DIR: DATA, CAUSECAM_REPO_ROOT: WORK },
    stderr: 'inherit',
  });
  client = new Client({ name: 'e2e', version: '0' });
  await client.connect(transport);
}, 90_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await stopApp();
  fs.rmSync(WORK, { recursive: true, force: true });
});

describe('end-to-end: reproduce, diagnose, fix, verify', () => {
  const url = () => `http://localhost:${appPort}/`;

  it('refuses remote targets', async () => {
    const r = await call('causecam_start_session', { url: 'https://example.com/' });
    expect(r.isError).toBe(true);
  });

  it('blocks mutating requests when the session did not allow them', async () => {
    const start = await call('causecam_start_session', { url: url() });
    expect(start.isError).toBe(false);
    const sessionId = sessionOf(start.text);
    await call('causecam_perform_action', { sessionId, action: 'select', target: { testId: 'timezone' }, value: 'Europe/Berlin' });
    const click = await call('causecam_perform_action', { sessionId, action: 'click', target: { role: 'button', name: 'Save settings' } });
    expect(click.text).toContain('PUT /api/settings -> blocked (mutation-not-permitted)');
    const inspect = await call('causecam_inspect_trace', { traceId: traceOf(click.text) });
    expect(inspect.text).toContain('status=BLOCKED');
    expect(inspect.text).toContain('BLOCKED (mutation-not-permitted)');
    await call('causecam_stop_session', { sessionId });
  }, 60_000);

  it('captures the failure, fixes it, and confirms the improvement by comparison', async () => {
    const start = await call('causecam_start_session', { url: url(), allowMutations: true });
    const sessionId = sessionOf(start.text);
    expect(start.text).toMatch(/GET \/api\/settings -> 200/);

    // 1. Reproduce
    await call('causecam_perform_action', { sessionId, action: 'select', target: { testId: 'timezone' }, value: 'Europe/Berlin' });
    const fail = await call('causecam_perform_action', { sessionId, action: 'click', target: { role: 'button', name: 'Save settings' } });
    expect(fail.text).toContain('PUT /api/settings -> 500');
    const failingTrace = traceOf(fail.text);

    // 2. Inspect: real HTTP, real backend spans linked by traceparent, the DB failure and its source.
    const inspect = await call('causecam_inspect_trace', { traceId: failingTrace });
    const t = inspect.text;
    expect(t).toContain('status=ERROR');
    expect(t).toMatch(/PUT \/api\/settings -> 500 \(\d+(\.\d)?ms\) fetch\s+\[inferred: action window\]/);
    expect(t).toMatch(/server PUT \/api\/settings -> 500 ERROR .*\[observed: traceparent\]/);
    expect(t).toContain('handler PUT /settings ERROR');
    expect(t).toContain('demo/src/routes/settings.ts:18:10 (route registration, verified)');
    expect(t).toContain('db update user_settings ERROR');
    expect(t).toContain('demo/src/routes/settings.ts:25:11 (query call site, verified)');
    expect(t).toContain('"NOT NULL constraint failed: user_settings.timezone"');
    expect(t).toContain('[browser console-error] "Saving settings failed with HTTP 500"');
    // privacy: the submitted display name and bind values are never stored
    expect(t).not.toContain('Ada Lovelace');
    const json = JSON.parse((await call('causecam_inspect_trace', { traceId: failingTrace, format: 'json' })).text);
    expect(json.errors[0]).toMatchObject({ layer: 'database', certainty: 'observed', source: { path: 'demo/src/routes/settings.ts', line: 25, verified: true } });
    expect(JSON.stringify(json)).not.toContain('Ada Lovelace');

    // 3. Fix the root cause in the scratch copy (normalizeTimezone dropped canonical IANA names) and restart.
    const file = path.join(WORK, 'demo', 'src', 'settings-transform.ts');
    const src = fs.readFileSync(file, 'utf8');
    const fixed = src.replace(
      'return TIMEZONE_ALIASES[key] ?? null;',
      'return TIMEZONE_ALIASES[key] ?? (IANA_ZONES.has(input.trim()) ? input.trim() : null);',
    );
    expect(fixed).not.toBe(src);
    fs.writeFileSync(file, fixed);
    await stopApp();
    await startApp();

    // 4. Repeat the same interaction in the same browser session.
    const ok = await call('causecam_perform_action', { sessionId, action: 'click', target: { role: 'button', name: 'Save settings' } });
    expect(ok.text).toContain('PUT /api/settings -> 200');
    const okTrace = traceOf(ok.text);
    expect((await call('causecam_inspect_trace', { traceId: okTrace })).text).toContain('status=OK');

    // 5. Compare
    const cmp = (await call('causecam_compare_traces', { traceIdA: failingTrace, traceIdB: okTrace })).text;
    expect(cmp).toMatch(/PUT \/api\/settings: 500 [\d.]+ms -> 200 [\d.]+ms {2}<- changed/);
    expect(cmp).toMatch(/changed: db update user_settings \| update `user_settings` set .*: error [\d.]+ms -> no error/);
    expect(cmp).toContain('present in A, absent in B: [database] db update user_settings failed (SQLITE_CONSTRAINT_NOTNULL)');
    expect(cmp).not.toContain('new in B');

    const list = (await call('causecam_list_traces', { sessionId, limit: 10 })).text;
    expect(list).toContain(`${okTrace}  OK`);
    expect(list).toContain(`${failingTrace}  ERROR`);
    expect((await call('causecam_stop_session', { sessionId })).text).toContain('browser closed');
  }, 120_000);
});
