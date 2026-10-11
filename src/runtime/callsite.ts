import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CallSite {
  file: string;
  line: number;
  column: number;
  fn?: string;
}

// dist/runtime -> package root. Frames from CAUSECAM's own runtime (compiled or, via source maps,
// the original src/runtime files) are never reported as application call sites.
const RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(RUNTIME_DIR, '..', '..');
const SKIP_DIRS = [RUNTIME_DIR, path.join(PKG_ROOT, 'src', 'runtime'), path.join(PKG_ROOT, 'dist', 'runtime')].map((d) => d + path.sep);
const NM = `${path.sep}node_modules${path.sep}`;
const FRAME_RE = /^\s*at\s+(?:async\s+)?(?:(.*?)\s+\()?((?:file:\/\/)?\/[^():]+|[A-Za-z]:\\[^():]+):(\d+):(\d+)\)?\s*$/;

/** First stack frame that belongs to application code (not node internals, dependencies or CAUSECAM). */
export function appCallSite(): CallSite | undefined {
  const prev = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = prev;
  for (const line of stack.split('\n').slice(1)) {
    const m = FRAME_RE.exec(line);
    if (!m) continue;
    let file = m[2]!;
    if (file.startsWith('file://')) file = fileURLToPath(file);
    if (file.includes(NM) || SKIP_DIRS.some((d) => file.startsWith(d))) continue;
    const site: CallSite = { file, line: Number(m[3]), column: Number(m[4]) };
    if (m[1] && !m[1].startsWith('new Promise')) site.fn = m[1];
    return site;
  }
  return undefined;
}

export function callSiteAttributes(site: CallSite, source: string): Record<string, string | number> {
  const a: Record<string, string | number> = {
    'code.filepath': site.file,
    'code.lineno': site.line,
    'code.column': site.column,
    'causecam.source': source,
  };
  if (site.fn) a['code.function'] = site.fn;
  return a;
}
