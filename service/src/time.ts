import { ruleError } from './errors';

const ISO_LOCAL = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?`;
const ZONED = new RegExp(`^${ISO_LOCAL}(?:Z|[+-]\\d{2}:\\d{2})$`);
const ZONELESS = new RegExp(`^${ISO_LOCAL}$`);

/** Accepts only ISO-8601 `YYYY-MM-DDTHH:MM(:SS(.sss)?)?` followed by an uppercase Z or a +/-HH:MM offset. */
export function parseZonedTime(s: string): { utc: string; enteredAs: string } {
  const t = s.trim();
  if (ZONELESS.test(t)) {
    throw ruleError(
      'TIME_NEEDS_ZONE',
      `The time "${s}" has no time zone.`,
      'Give the time with Z or an explicit offset, for example 2026-11-18T21:00:00-06:00.',
    );
  }
  const ms = ZONED.test(t) ? Date.parse(t) : NaN;
  if (Number.isNaN(ms)) {
    throw ruleError(
      'BAD_TIME',
      `The time "${s}" could not be read.`,
      'Use ISO 8601 with a zone, for example 2026-11-18T21:00:00-06:00.',
    );
  }
  return { utc: new Date(ms).toISOString(), enteredAs: t };
}

export function addMinutes(iso: string, n: number): string {
  return new Date(Date.parse(iso) + n * 60_000).toISOString();
}

/** A stored UTC time as agents read it: ISO, no milliseconds, for example 2026-11-19T15:26:00Z. */
export function slotText(utcIso: string): string {
  return utcIso.replace(/\.\d{3}Z$/, 'Z');
}
