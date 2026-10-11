import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceClass, SourceOrigin, SourceRef } from './types.js';

export interface RawFrame {
  fn?: string;
  file: string;
  line?: number;
  column?: number;
}

// V8 stack frame formats:
//   at fn (file:line:col)      at async fn (file:line:col)      at file:line:col      at new Foo (file:line:col)
const FRAME_WITH_FN = /^\s*at\s+(?:async\s+)?(.+?)\s+\((.+?)(?::(\d+))?(?::(\d+))?\)\s*$/;
const FRAME_BARE = /^\s*at\s+(?:async\s+)?(.+?)(?::(\d+))?(?::(\d+))?\s*$/;

/** Parse a V8 (Node/Chromium) stack trace. Lines that are not frames (the message) are skipped. */
export function parseStack(stack: string): RawFrame[] {
  const frames: RawFrame[] = [];
  for (const line of stack.split('\n')) {
    if (!/^\s*at\s/.test(line)) continue;
    const m = FRAME_WITH_FN.exec(line);
    if (m) {
      frames.push(clean({ fn: m[1], file: m[2]!, line: num(m[3]), column: num(m[4]) }));
      continue;
    }
    const b = FRAME_BARE.exec(line);
    if (b) frames.push(clean({ file: b[1]!, line: num(b[2]), column: num(b[3]) }));
  }
  return frames;
}

function num(s: string | undefined): number | undefined {
  return s === undefined ? undefined : Number(s);
}

function clean(f: RawFrame): RawFrame {
  const out: RawFrame = { file: f.file };
  if (f.fn) out.fn = f.fn;
  if (f.line !== undefined) out.line = f.line;
  if (f.column !== undefined) out.column = f.column;
  return out;
}

const GENERATED_RE = /(^|\/)(dist|build|out|\.next|\.nuxt|\.output|\.svelte-kit|coverage)\/|\.min\.js$|(^|\/)bundle[.-]/;

/**
 * Maps file references from spans and stack traces to repo-relative source references.
 *
 * Guarantees:
 *  - only paths that resolve (after symlinks) inside the repo root are classified as `app`;
 *  - dependency, generated, node-internal and browser URLs are labelled as such, never as app source;
 *  - `verified` is true only when the file exists and the line is within it;
 *  - the resolver never invents a location: it can only classify what it was given.
 */
export class SourceResolver {
  private readonly root: string;
  private readonly lineCounts = new Map<string, number | null>();

  constructor(repoRoot: string) {
    this.root = safeRealpath(path.resolve(repoRoot)) ?? path.resolve(repoRoot);
  }

  resolve(file: string, opts: { line?: number; column?: number; fn?: string; origin: SourceOrigin }): SourceRef {
    const base = { origin: opts.origin, ...(opts.fn ? { function: cleanFn(opts.fn) } : {}) };
    const pos = {
      ...(opts.line !== undefined && Number.isFinite(opts.line) ? { line: opts.line } : {}),
      ...(opts.column !== undefined && Number.isFinite(opts.column) ? { column: opts.column } : {}),
    };
    const ref = (p: string, classification: SourceClass, verified = false): SourceRef => ({ path: p, ...pos, ...base, classification, verified });

    if (!file || file === '<anonymous>' || file === 'native') return ref(file || '<unknown>', 'unknown');
    if (file.startsWith('node:') || file.startsWith('internal/')) return ref(file, 'node-internal');
    if (/^https?:\/\//.test(file)) {
      try {
        const u = new URL(file);
        return ref(`${u.origin}${u.pathname}`, 'browser-url');
      } catch {
        return ref('<invalid url>', 'unknown');
      }
    }

    let abs: string;
    try {
      abs = file.startsWith('file://') ? fileURLToPath(file) : file;
    } catch {
      return ref('<invalid file url>', 'unknown');
    }
    if (!path.isAbsolute(abs)) abs = path.resolve(this.root, abs);
    abs = path.normalize(abs);

    const nm = abs.lastIndexOf(`${path.sep}node_modules${path.sep}`);
    if (nm !== -1) return ref(`node_modules/${abs.slice(nm + 14).split(path.sep).join('/')}`, 'dependency');

    const real = safeRealpath(abs) ?? abs;
    const rel = path.relative(this.root, real);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      return ref(`(outside repo) ${path.basename(abs)}`, 'outside-repo');
    }
    const relPosix = rel.split(path.sep).join('/');
    const classification: SourceClass = GENERATED_RE.test(relPosix) ? 'generated' : 'app';
    return ref(relPosix, classification, this.verify(real, opts.line));
  }

  resolveStack(stack: string, origin: SourceOrigin = 'stack-trace'): SourceRef[] {
    return parseStack(stack).map((f) => this.resolve(f.file, { line: f.line, column: f.column, fn: f.fn, origin }));
  }

  private verify(real: string, line: number | undefined): boolean {
    let count = this.lineCounts.get(real);
    if (count === undefined) {
      try {
        const st = fs.statSync(real);
        count = st.isFile() && st.size < 5_000_000 ? fs.readFileSync(real, 'utf8').split('\n').length : null;
      } catch {
        count = null;
      }
      this.lineCounts.set(real, count);
    }
    if (count === null) return false;
    return line === undefined || (line >= 1 && line <= count);
  }
}

function cleanFn(fn: string): string {
  return fn.replace(/^async\s+/, '').slice(0, 120);
}

function safeRealpath(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

export function firstAppFrame(frames: SourceRef[]): SourceRef | undefined {
  return frames.find((f) => f.classification === 'app');
}
