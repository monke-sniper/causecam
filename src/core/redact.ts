import type { AttrValue } from './types.js';

/** Query parameter names whose values are never stored. */
const SENSITIVE_PARAM_RE =
  /(token|secret|passw|pwd|auth|session|sid$|^sid|key|code|signature|^sig$|credential|jwt|bearer|otp|nonce|email|phone|ssn|card|cvv)/i;
/** Values that look like credentials regardless of their parameter name. */
const SECRET_VALUE_RE = /^(eyJ[\w-]+\.[\w-]+\.[\w-]+|[A-Za-z0-9+/_-]{40,}={0,2})$/;

export const REDACTED = 'REDACTED';

export function redactSearchParams(params: URLSearchParams): void {
  for (const [k, v] of [...params]) {
    if (SENSITIVE_PARAM_RE.test(k) || SECRET_VALUE_RE.test(v)) params.set(k, REDACTED);
  }
}

/** Redact credentials, fragments, and sensitive query values from an absolute or path-relative URL. */
export function redactUrl(raw: string): string {
  const relative = !/^[a-z][a-z0-9+.-]*:/i.test(raw);
  let u: URL;
  try {
    u = new URL(raw, relative ? 'http://relative.invalid' : undefined);
  } catch {
    return sanitizeText(raw.split('?')[0] ?? '', 500);
  }
  u.username = '';
  u.password = '';
  u.hash = '';
  redactSearchParams(u.searchParams);
  return relative ? `${u.pathname}${u.search}` : u.toString();
}

export function redactQueryString(q: string): string {
  const params = new URLSearchParams(q.startsWith('?') ? q.slice(1) : q);
  redactSearchParams(params);
  return params.toString();
}

/**
 * Replace SQL literals with `?` so bind values and inline literals are never persisted.
 * Identifiers (quoted with backticks, double quotes or brackets) are preserved.
 */
export function normalizeSql(sql: string, max = 1500): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'") {
      // string literal with '' escapes
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      i++;
      out += '?';
      continue;
    }
    if (c === '`' || c === '"' || c === '[') {
      const close = c === '[' ? ']' : c;
      const end = sql.indexOf(close, i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (/[0-9]/.test(c) && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? '')) {
      let j = i;
      while (j < sql.length && /[0-9.xXa-fA-F]/.test(sql[j]!)) j++;
      out += '?';
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f​-‏‪-‮⁦-⁩]/g;

// SQL statements embedded in driver/ORM error messages (e.g. Knex prefixes errors with the
// interpolated statement, including literal bind values).
const EMBEDDED_SQL_RE =
  /\b(?:select\b[^\n]*?\bfrom\b|insert\s+into\b|update\s+\S+\s+set\b|delete\s+from\b|replace\s+into\b)[^\n]*?(?=\s-\s|\n|$)/gi;

export function redactEmbeddedSql(s: string): string {
  return s.replace(EMBEDDED_SQL_RE, (m) => normalizeSql(m, 600));
}

/** Remove secrets that commonly leak into messages. */
export function scrubSecrets(s: string): string {
  return redactEmbeddedSql(s)
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '[REDACTED_JWT]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/((?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)\S+/gi, '$1[REDACTED]');
}

/**
 * Sanitize untrusted text (page content, console output, exception messages) before it is stored
 * or shown to an agent: strip terminal escapes and invisible/bidi control characters, scrub
 * obvious secrets, and bound the length.
 */
export function sanitizeText(s: string, max = 500, keepNewlines = false): string {
  let out = scrubSecrets(String(s).replace(ANSI_RE, '').replace(CONTROL_RE, ''));
  out = keepNewlines ? out.replace(/\r\n?/g, '\n') : out.replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max)}…[+${out.length - max} chars]` : out;
}

const KEEP_ATTRS = new Set([
  'http.method',
  'http.request.method',
  'http.status_code',
  'http.response.status_code',
  'http.route',
  'http.target',
  'http.url',
  'http.scheme',
  'http.flavor',
  'url.full',
  'url.path',
  'url.query',
  'url.scheme',
  'server.address',
  'server.port',
  'net.host.name',
  'net.host.port',
  'net.peer.name',
  'net.peer.port',
  'network.protocol.version',
  'express.name',
  'express.type',
  'db.system',
  'db.system.name',
  'db.name',
  'db.namespace',
  'db.operation',
  'db.operation.name',
  'db.sql.table',
  'db.collection.name',
  'db.statement',
  'db.query.text',
  'code.filepath',
  'code.file.path',
  'code.lineno',
  'code.line.number',
  'code.column',
  'code.column.number',
  'code.function',
  'code.function.name',
  'code.namespace',
  'error.type',
  'exception.type',
  'exception.message',
  'exception.stacktrace',
  'exception.escaped',
  'service.name',
]);

const URL_ATTRS = new Set(['http.target', 'http.url', 'url.full']);
const SQL_ATTRS = new Set(['db.statement', 'db.query.text']);

/**
 * Allowlist-based attribute redaction. Anything not explicitly useful for debugging is dropped,
 * which means new instrumentation cannot silently start persisting headers, bodies or bind values.
 */
export function redactAttributes(attrs: Record<string, AttrValue>): { kept: Record<string, AttrValue>; dropped: number } {
  const kept: Record<string, AttrValue> = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(attrs)) {
    if (!KEEP_ATTRS.has(key) && !key.startsWith('causecam.')) {
      dropped++;
      continue;
    }
    if (typeof value !== 'string') {
      kept[key] = value;
      continue;
    }
    if (URL_ATTRS.has(key)) kept[key] = redactUrl(value);
    else if (key === 'url.query') kept[key] = redactQueryString(value);
    else if (SQL_ATTRS.has(key)) kept[key] = normalizeSql(value);
    else if (key === 'exception.stacktrace') kept[key] = sanitizeText(value, 8000, true);
    else if (key === 'exception.message') kept[key] = sanitizeText(value, 1000);
    else if (key === 'db.namespace' || key === 'db.name') kept[key] = sanitizeText(shortenPaths(value), 200);
    else kept[key] = sanitizeText(value, 500);
  }
  return { kept, dropped };
}

/** Replace absolute filesystem paths with their basename (e.g. SQLite file paths used as db names). */
export function shortenPaths(s: string): string {
  return s.replace(/(?:[A-Za-z]:)?(?:[\\/][^\s\\/'"`]+){2,}/g, (m) => m.split(/[\\/]/).pop() ?? m);
}
