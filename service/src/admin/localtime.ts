// Local-time helpers for the admin UI. Stored times stay UTC ISO strings everywhere else; only rendering
// converts. The zone is the viewer's browser zone (sent back in the echo_tz cookie), else America/New_York.

export const DEFAULT_ZONE = 'America/New_York';
export const TZ_COOKIE = 'echo_tz';

const ZONE_SHAPE = /^[A-Za-z0-9_+\-/]{1,64}$/;

/** A usable IANA zone name from untrusted input, or the Eastern default. */
export function resolveZone(value: string | null | undefined): string {
  if (!value || !ZONE_SHAPE.test(value)) return DEFAULT_ZONE;
  try {
    // The canonical name, so "america/new_york" and "America/New_York" are one zone (and one cache entry).
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return DEFAULT_ZONE;
  }
}

/** The echo_tz cookie out of a Cookie header, resolved to a valid zone. */
export function zoneFromCookieHeader(header: string | null | undefined): string {
  if (!header) return DEFAULT_ZONE;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== TZ_COOKIE) continue;
    let v = part.slice(i + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {
      return DEFAULT_ZONE;
    }
    return resolveZone(v);
  }
  return DEFAULT_ZONE;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function fmt(key: string, zone: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = `${key}|${zone}`;
  let f = formatters.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, ...opts });
    formatters.set(k, f);
  }
  return f;
}

type Fields = { y: number; m: number; d: number; h: number; mi: number; s: number };

/** Wall-clock fields of an instant in a zone. */
function fieldsAt(ms: number, zone: string): Fields {
  const parts = fmt('f', zone, {
    hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: n('year'), m: n('month'), d: n('day'), h: n('hour') % 24, mi: n('minute'), s: n('second') };
}

/** The zone's offset from UTC at an instant, in ms (EST is -5 h). */
export function offsetAt(ms: number, zone: string): number {
  const f = fieldsAt(ms, zone);
  return Date.UTC(f.y, f.m - 1, f.d, f.h, f.mi, f.s) - Math.floor(ms / 1000) * 1000;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function abbrev(ms: number, zone: string): string {
  return fmt('z', zone, { timeZoneName: 'short' }).formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value ?? zone;
}

function clock(f: Fields): string {
  const h12 = f.h % 12 === 0 ? 12 : f.h % 12;
  return `${h12}:${String(f.mi).padStart(2, '0')} ${f.h < 12 ? 'AM' : 'PM'}`;
}

/** "6:30 PM EST". */
export function fmtTime(iso: string, zone: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return `${clock(fieldsAt(ms, zone))} ${abbrev(ms, zone)}`;
}

/** "Nov 18, 6:00 PM EST", with the year when it is not the current year in that zone. */
export function fmtDateTime(iso: string, zone: string, nowIso: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const f = fieldsAt(ms, zone);
  const nowYear = fieldsAt(Date.parse(nowIso), zone).y;
  return `${MONTHS[f.m - 1]} ${f.d}${f.y === nowYear ? '' : ` ${f.y}`}, ${clock(f)} ${abbrev(ms, zone)}`;
}

const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** The zone's local calendar date of an instant, as YYYY-MM-DD. */
export function localDate(ms: number, zone: string): string {
  const f = fieldsAt(ms, zone);
  return ymd(f.y, f.m, f.d);
}

/**
 * The first instant of a local calendar date. Bounded: two candidates (the offsets a day either side), no loops.
 * If local midnight does not exist (a DST jump at 00:00), the first valid instant of that date.
 */
export function localDayStart(date: string, zone: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const target = Date.UTC(y, m - 1, d);
  const before = target - offsetAt(target - 86_400_000, zone);
  const after = target - offsetAt(target + 86_400_000, zone);
  const valid = [before, after].filter((t) => localDate(t, zone) === date && fieldsAt(t, zone).h === 0 && fieldsAt(t, zone).mi === 0);
  if (valid.length) return Math.min(...valid);
  // No 00:00 on that date: the jump instant is `before`, where the date's first valid time begins.
  const onDate = [before, after].filter((t) => localDate(t, zone) === date);
  return onDate.length ? Math.min(...onDate) : before;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** [from, to) in UTC ISO for one local date: ends at the next local day's start, so DST days are 23 or 25 hours. */
export function dayRange(date: string, zone: string): { from: string; to: string } {
  return { from: new Date(localDayStart(date, zone)).toISOString(), to: new Date(localDayStart(addDays(date, 1), zone)).toISOString() };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return fmt('l', 'UTC', { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d))).replace(',', '');
}

export type DayOption = { value: string; label: string; today: boolean };

/** Seven days, three back to three ahead of today in the zone. */
export function dayOptions(nowMs: number, zone: string): DayOption[] {
  const today = localDate(nowMs, zone);
  const out: DayOption[] = [];
  for (let k = -3; k <= 3; k++) {
    const value = addDays(today, k);
    out.push({ value, label: k === 0 ? 'Today' : dayLabel(value), today: k === 0 });
  }
  return out;
}

/** The chosen day if it is one of the seven offered, else today. */
export function chooseDay(requested: string | null | undefined, options: DayOption[]): DayOption {
  const hit = requested && DATE_RE.test(requested) ? options.find((o) => o.value === requested) : undefined;
  return hit ?? options.find((o) => o.today)!;
}

export { dayLabel };

/**
 * Static script (no server data): when the browser's zone differs from the zone the server rendered in (data-zone),
 * remembers it in the echo_tz cookie and reloads once so the server renders in it; also submits the day picker when it
 * changes. It reloads only if the cookie really stuck, at most once per tab session, and only on a GET page
 * (data-reload), so blocked cookies or storage never cause a loop (the page just stays as rendered). A viewer already
 * in the rendered zone (Eastern, by default) never reloads.
 */
export const TZ_SCRIPT = `
(function () {
  document.querySelectorAll('select[data-autosubmit]').forEach(function (s) {
    s.addEventListener('change', function () { s.form.submit(); });
  });
  var me = document.currentScript;
  var canReload = !!me && me.getAttribute('data-reload') === '1';
  var rendered = me && me.getAttribute('data-zone');
  var zone;
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return; }
  if (!zone || zone === rendered) return;
  var enc = encodeURIComponent(zone);
  var m = document.cookie.match(/(?:^|; )${TZ_COOKIE}=([^;]*)/);
  if (m && m[1] === enc) return;
  document.cookie = '${TZ_COOKIE}=' + enc + '; path=/admin; max-age=31536000; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
  if (document.cookie.indexOf('${TZ_COOKIE}=' + enc) < 0) return;
  if (!canReload) return;
  try {
    if (sessionStorage.getItem('echo_tz_reloaded')) return;
    sessionStorage.setItem('echo_tz_reloaded', '1');
  } catch (e) { return; }
  location.reload();
})();
`;
