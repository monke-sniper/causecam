export type DigestFrequency = 'daily' | 'weekly' | 'never';

export interface SettingsInput {
  displayName: string;
  timezone: string;
  digestFrequency: DigestFrequency;
  marketingEmails: boolean;
}

export interface SettingsRow {
  user_id: number;
  display_name: string;
  timezone: string | null;
  digest_frequency: DigestFrequency;
  marketing_emails: number | boolean;
  updated_at: string;
}

const DIGEST_FREQUENCIES: readonly DigestFrequency[] = ['daily', 'weekly', 'never'];

/** Friendly names accepted from older clients. */
export const TIMEZONE_ALIASES: Record<string, string> = {
  utc: 'UTC',
  gmt: 'UTC',
  eastern: 'America/New_York',
  central: 'America/Chicago',
  pacific: 'America/Los_Angeles',
};

const IANA_ZONES = new Set(Intl.supportedValuesOf('timeZone'));
IANA_ZONES.add('UTC');

export function isKnownTimezone(tz: string): boolean {
  return IANA_ZONES.has(tz) || tz.trim().toLowerCase() in TIMEZONE_ALIASES;
}

/** Map aliases to canonical IANA zone names. */
export function normalizeTimezone(input: string): string | null {
  const key = input.trim().toLowerCase();
  return TIMEZONE_ALIASES[key] ?? null;
}

export type ValidationResult = { ok: true; value: SettingsInput } | { ok: false; errors: string[] };

export function validateSettingsInput(body: unknown): ValidationResult {
  const errors: string[] = [];
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const displayName = typeof b.displayName === 'string' ? b.displayName.trim() : '';
  if (!displayName || displayName.length > 80) errors.push('displayName must be 1-80 characters');
  const timezone = typeof b.timezone === 'string' ? b.timezone : '';
  if (!isKnownTimezone(timezone)) errors.push('timezone is not a known time zone');
  const digestFrequency = b.digestFrequency as DigestFrequency;
  if (!DIGEST_FREQUENCIES.includes(digestFrequency)) errors.push('digestFrequency must be daily, weekly or never');
  const marketingEmails = b.marketingEmails === true;
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { displayName, timezone, digestFrequency, marketingEmails } };
}

export function toSettingsRow(s: SettingsInput): Omit<SettingsRow, 'user_id'> {
  return {
    display_name: s.displayName,
    timezone: normalizeTimezone(s.timezone),
    digest_frequency: s.digestFrequency,
    marketing_emails: s.marketingEmails ? 1 : 0,
    updated_at: new Date().toISOString(),
  };
}

export function fromSettingsRow(row: SettingsRow): SettingsInput & { updatedAt: string } {
  return {
    displayName: row.display_name,
    timezone: row.timezone ?? 'UTC',
    digestFrequency: row.digest_frequency,
    marketingEmails: Boolean(row.marketing_emails),
    updatedAt: row.updated_at,
  };
}
