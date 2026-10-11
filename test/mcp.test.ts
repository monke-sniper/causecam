import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/mcp/server.js';
import { CauseCam } from '../src/services.js';

let dir: string;
let cc: CauseCam;
let client: Client;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'causecam-mcp-'));
  cc = new CauseCam({ dataDir: dir, repoRoot: dir, collectorPort: 0 });
  const server = buildServer(cc);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await cc.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Calls a tool and returns its error text, whether the SDK reports it as a tool error or a protocol error. */
async function expectError(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    const r = await client.callTool({ name, arguments: args });
    expect(r.isError).toBe(true);
    return (r.content as { text: string }[]).map((c) => c.text).join('\n');
  } catch (e) {
    return (e as Error).message;
  }
}

describe('MCP tools', () => {
  it('exposes exactly the six documented tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['causecam_compare_traces', 'causecam_inspect_trace', 'causecam_list_traces', 'causecam_perform_action', 'causecam_start_session', 'causecam_stop_session'].sort(),
    );
    for (const t of tools) expect(t.description?.length).toBeGreaterThan(20);
  });

  it.each([
    ['https://example.com/', /only allows local origins/],
    ['http://192.168.1.10:3000/', /only allows local origins/],
    ['http://localhost.evil.com/', /only allows local origins/],
    ['file:///etc/passwd', /Only http\(s\) URLs/],
    ['http://user:pw@localhost:3000/', /credentials/],
  ])('rejects non-local or unsafe capture target %s', async (url, re) => {
    expect(await expectError('causecam_start_session', { url })).toMatch(re);
  });

  it('rejects remote extra origins', async () => {
    expect(await expectError('causecam_start_session', { url: 'http://localhost:1/', extraOrigins: ['https://api.example.com'] })).toMatch(/only allows local origins/);
  });

  it('validates ids and arguments', async () => {
    expect(await expectError('causecam_inspect_trace', { traceId: '../../etc/passwd' })).toMatch(/trace ids|Invalid|validation/i);
    expect(await expectError('causecam_inspect_trace', { traceId: 'deadbeefdeadbeef' })).toMatch(/No trace found/);
    expect(await expectError('causecam_perform_action', { sessionId: 'ses_deadbeef', action: 'click', target: { testId: 'x' } })).toMatch(/Unknown session/);
    expect(await expectError('causecam_perform_action', { sessionId: 'ses_deadbeef', action: 'click' })).toMatch(/requires target/);
    expect(await expectError('causecam_perform_action', { sessionId: 'ses_deadbeef', action: 'shell', command: 'rm -rf /' })).toMatch(/invalid|validation|Unrecognized/i);
    expect(await expectError('causecam_list_traces', { limit: 500 })).toMatch(/too big|less than|<=|validation/i);
    expect(await expectError('causecam_compare_traces', { traceIdA: 'zz', traceIdB: 'yy' })).toMatch(/trace ids|validation/i);
  });

  it('lists traces (empty store)', async () => {
    const r = await client.callTool({ name: 'causecam_list_traces', arguments: {} });
    expect((r.content as { text: string }[])[0]!.text).toBe('No traces stored yet.');
  });
});
