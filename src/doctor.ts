import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { probe } from './collector.js';
import type { CauseCamConfig } from './config.js';
import { PKG_ROOT, REGISTER_PATH } from './run.js';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** Warnings do not fail the doctor run. */
  warn?: boolean;
}

export async function doctor(config: CauseCamConfig): Promise<{ checks: Check[]; ok: boolean }> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, warn = false) => checks.push({ name, ok, detail, warn });

  const [maj = 0, min = 0] = process.versions.node.split('.').map(Number);
  add('Node.js >= 22.13', maj > 22 || (maj === 22 && min >= 13), `found ${process.versions.node} (node:sqlite is required)`);

  try {
    await import('node:sqlite');
    add('node:sqlite available', true, 'ok');
  } catch (e) {
    add('node:sqlite available', false, (e as Error).message);
  }

  try {
    const { chromium } = await import('playwright');
    const exe = chromium.executablePath();
    add('Playwright Chromium installed', fs.existsSync(exe), fs.existsSync(exe) ? exe : `missing; run: npx playwright install chromium`);
  } catch (e) {
    add('Playwright Chromium installed', false, (e as Error).message);
  }

  add('runtime bootstrap built', fs.existsSync(REGISTER_PATH), fs.existsSync(REGISTER_PATH) ? REGISTER_PATH : 'missing; run: npm run build');

  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.accessSync(config.dataDir, fs.constants.W_OK);
    add('trace data directory writable', true, config.dataDir);
  } catch (e) {
    add('trace data directory writable', false, `${config.dataDir}: ${(e as Error).message}`);
  }

  const owner = await probe(config.collectorPort);
  const free = await portFree(config.collectorPort);
  add(
    `collector port ${config.collectorPort}`,
    free || !!owner,
    owner ? `CAUSECAM collector running (pid ${owner.pid}, store ${owner.store})` : free ? 'free (a collector starts with `causecam run` / `causecam demo`)' : 'in use by another process; set CAUSECAM_COLLECTOR_PORT',
  );

  const req = createRequire(path.join(PKG_ROOT, 'package.json'));
  for (const mod of ['express', 'knex']) {
    try {
      req.resolve(mod);
      add(`demo dependency ${mod}`, true, 'ok', true);
    } catch {
      add(`demo dependency ${mod}`, false, 'not installed (only needed for the demo)', true);
    }
  }
  try {
    const Database = req('better-sqlite3') as new (f: string) => { close(): void };
    new Database(':memory:').close();
    add('demo dependency better-sqlite3 (native)', true, 'ok', true);
  } catch (e) {
    add('demo dependency better-sqlite3 (native)', false, `${(e as Error).message.split('\n')[0]}; try: npm rebuild better-sqlite3`, true);
  }

  return { checks, ok: checks.every((c) => c.ok || c.warn) };
}

function portFree(port: number): Promise<boolean> {
  return import('node:net').then(
    ({ createServer }) =>
      new Promise<boolean>((resolve) => {
        const s = createServer();
        s.once('error', () => resolve(false));
        s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
      }),
  );
}
