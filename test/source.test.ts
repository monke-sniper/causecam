import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { firstAppFrame, parseStack, SourceResolver } from '../src/core/source.js';

let root: string;
let outside: string;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causecam-src-')));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causecam-out-')));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'line1\nline2\nline3\n');
  fs.writeFileSync(path.join(root, 'dist', 'app.js'), 'x\n');
  fs.writeFileSync(path.join(outside, 'secret.ts'), 'secret\n');
  fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(root, 'src', 'link.ts'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('parseStack', () => {
  it('parses V8 frames with and without function names', () => {
    const frames = parseStack(
      [
        'Error: boom',
        '    at handler (/repo/src/a.ts:10:5)',
        '    at async Runner.query (/repo/node_modules/knex/lib/runner.js:1:2)',
        '    at /repo/src/b.ts:3:4',
        '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
      ].join('\n'),
    );
    expect(frames).toEqual([
      { fn: 'handler', file: '/repo/src/a.ts', line: 10, column: 5 },
      { fn: 'Runner.query', file: '/repo/node_modules/knex/lib/runner.js', line: 1, column: 2 },
      { file: '/repo/src/b.ts', line: 3, column: 4 },
      { fn: 'process.processTicksAndRejections', file: 'node:internal/process/task_queues', line: 105, column: 5 },
    ]);
  });
});

describe('SourceResolver', () => {
  it('returns verified repo-relative paths for app files', () => {
    const r = new SourceResolver(root);
    const ref = r.resolve(path.join(root, 'src', 'app.ts'), { line: 2, column: 1, origin: 'stack-trace' });
    expect(ref).toMatchObject({ path: 'src/app.ts', line: 2, classification: 'app', verified: true });
  });
  it('does not verify lines that are out of range or files that do not exist', () => {
    const r = new SourceResolver(root);
    expect(r.resolve(path.join(root, 'src', 'app.ts'), { line: 99, origin: 'stack-trace' }).verified).toBe(false);
    expect(r.resolve(path.join(root, 'src', 'missing.ts'), { line: 1, origin: 'stack-trace' })).toMatchObject({ classification: 'app', verified: false });
  });
  it('classifies dependencies, node internals, generated files and browser URLs', () => {
    const r = new SourceResolver(root);
    expect(r.resolve(path.join(root, 'node_modules', 'knex', 'lib', 'x.js'), { origin: 'stack-trace' })).toMatchObject({
      path: 'node_modules/knex/lib/x.js',
      classification: 'dependency',
    });
    expect(r.resolve('node:internal/process/task_queues', { origin: 'stack-trace' }).classification).toBe('node-internal');
    expect(r.resolve(path.join(root, 'dist', 'app.js'), { line: 1, origin: 'stack-trace' }).classification).toBe('generated');
    expect(r.resolve('http://localhost:3000/assets/app.js?v=1', { origin: 'stack-trace' })).toMatchObject({
      path: 'http://localhost:3000/assets/app.js',
      classification: 'browser-url',
      verified: false,
    });
  });
  it('prevents path traversal and symlink escapes', () => {
    const r = new SourceResolver(root);
    const traversal = r.resolve('../../../../etc/passwd', { line: 1, origin: 'stack-trace' });
    expect(traversal.classification).toBe('outside-repo');
    expect(traversal.path).toBe('(outside repo) passwd');
    expect(traversal.verified).toBe(false);
    const symlink = r.resolve(path.join(root, 'src', 'link.ts'), { line: 1, origin: 'stack-trace' });
    expect(symlink.classification).toBe('outside-repo');
    expect(r.resolve(path.join(outside, 'secret.ts'), { origin: 'stack-trace' }).classification).toBe('outside-repo');
  });
  it('picks the first app frame from a stack and never invents one', () => {
    const r = new SourceResolver(root);
    const frames = r.resolveStack(`Error\n    at q (${root}/node_modules/knex/x.js:1:1)\n    at h (${root}/src/app.ts:3:2)`);
    expect(firstAppFrame(frames)).toMatchObject({ path: 'src/app.ts', line: 3, function: 'h' });
    expect(firstAppFrame(r.resolveStack(`Error\n    at q (${root}/node_modules/knex/x.js:1:1)`))).toBeUndefined();
  });
});
