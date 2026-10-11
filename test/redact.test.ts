import { describe, expect, it } from 'vitest';
import { normalizeSql, redactAttributes, redactEmbeddedSql, redactUrl, sanitizeText, shortenPaths } from '../src/core/redact.js';

describe('redactUrl', () => {
  it('redacts sensitive query values, credentials and fragments', () => {
    const out = redactUrl('http://user:pw@localhost:3000/cb?code=abc&state=xyz&page=2&api_key=k#frag');
    expect(out).toBe('http://localhost:3000/cb?code=REDACTED&state=xyz&page=2&api_key=REDACTED');
  });
  it('redacts token-like values regardless of the parameter name', () => {
    expect(redactUrl('/x?v=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijkl')).toBe('/x?v=REDACTED');
  });
  it('keeps relative URLs relative', () => {
    expect(redactUrl('/api/settings?password=hunter2')).toBe('/api/settings?password=REDACTED');
  });
});

describe('normalizeSql', () => {
  it('replaces string and numeric literals but keeps identifiers', () => {
    expect(normalizeSql("select * from `t1` where name = 'O''Brien' and age > 42 and \"col2\" = 7")).toBe(
      'select * from `t1` where name = ? and age > ? and "col2" = ?',
    );
  });
  it('keeps NULL (a keyword, not a value)', () => {
    expect(normalizeSql("update t set a = 'x', b = NULL where id = 1")).toBe('update t set a = ?, b = NULL where id = ?');
  });
});

describe('redactEmbeddedSql / sanitizeText', () => {
  it('removes literal bind values from driver error messages', () => {
    const msg = "update `user_settings` set `display_name` = 'Ada', `timezone` = NULL where `user_id` = 1 - NOT NULL constraint failed: user_settings.timezone";
    const out = redactEmbeddedSql(msg);
    expect(out).not.toContain('Ada');
    expect(out).toContain('`timezone` = NULL');
    expect(out).toContain('NOT NULL constraint failed: user_settings.timezone');
  });
  it('strips ANSI and bidi/zero-width control characters and scrubs secrets', () => {
    const out = sanitizeText('\u001b[31mred\u001b[0m ‮evil​ Bearer abc.def password=hunter2 mail me@x.io');
    expect(out).toBe('red evil Bearer [REDACTED] password=[REDACTED] mail [email]');
  });
  it('bounds length', () => {
    expect(sanitizeText('a'.repeat(50), 10)).toBe(`${'a'.repeat(10)}…[+40 chars]`);
  });
});

describe('redactAttributes', () => {
  it('keeps allowlisted attributes, drops everything else, and redacts values', () => {
    const { kept, dropped } = redactAttributes({
      'http.request.method': 'PUT',
      'http.request.header.authorization': 'Bearer secret',
      'http.request.header.cookie': 'sid=1',
      'db.statement': "select * from users where email = 'a@b.co'",
      'url.full': 'http://localhost/x?token=t',
      'db.namespace': '/Users/someone/project/data/app.sqlite',
      'enduser.id': 'u1',
    });
    expect(kept).toEqual({
      'http.request.method': 'PUT',
      'db.statement': 'select * from users where email = ?',
      'url.full': 'http://localhost/x?token=REDACTED',
      'db.namespace': 'app.sqlite',
    });
    expect(dropped).toBe(3);
  });
  it('shortenPaths keeps only the basename of absolute paths', () => {
    expect(shortenPaths('update /tmp/a/b/demo.sqlite.users')).toBe('update demo.sqlite.users');
  });
});
