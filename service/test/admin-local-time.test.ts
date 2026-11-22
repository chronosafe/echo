import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  TZ_SCRIPT, addDays, chooseDay, dayOptions, dayRange, fmtDateTime, fmtTime, localDayStart, localDate, resolveZone, zoneFromCookieHeader,
} from '../src/admin/localtime';
import { summarizeMerge, summarizeMergeDetail } from '../src/admin/summary';
import { seed, testCtx } from './helpers';

const NY = 'America/New_York';
let ip = 0;

describe('local time formatting', () => {
  const now = '2026-11-22T12:00:00.000Z';
  it('formats in EST and EDT with an abbreviation', () => {
    expect(fmtDateTime('2026-11-18T23:30:00Z', NY, now)).toBe('Nov 18, 6:30 PM EST');
    expect(fmtDateTime('2026-07-04T23:30:00Z', NY, now)).toBe('Jul 4, 7:30 PM EDT');
    expect(fmtTime('2026-11-18T23:30:00Z', NY)).toBe('6:30 PM EST');
    expect(fmtDateTime('2026-11-18T05:00:00Z', NY, now)).toBe('Nov 18, 12:00 AM EST');
  });
  it('shows the year only when it is not the current year in the zone', () => {
    expect(fmtDateTime('2025-12-31T23:30:00Z', NY, now)).toBe('Dec 31 2025, 6:30 PM EST');
    expect(fmtDateTime('2027-01-01T03:00:00Z', 'UTC', '2026-12-31T23:00:00Z')).toBe('Jan 1 2027, 3:00 AM UTC');
  });
  it('switches abbreviation across the fall-back and spring-forward instants', () => {
    expect(fmtDateTime('2026-11-01T05:59:00Z', NY, now)).toBe('Nov 1, 1:59 AM EDT');
    expect(fmtDateTime('2026-11-01T06:00:00Z', NY, now)).toBe('Nov 1, 1:00 AM EST');
    expect(fmtDateTime('2026-03-08T06:59:00Z', NY, now)).toBe('Mar 8, 1:59 AM EST');
    expect(fmtDateTime('2026-03-08T07:00:00Z', NY, now)).toBe('Mar 8, 3:00 AM EDT');
  });
  it('uses another zone when given one, and returns null for an unreadable time', () => {
    expect(fmtTime('2026-11-18T23:30:00Z', 'America/Chicago')).toBe('5:30 PM CST');
    expect(fmtDateTime('not a time', NY, now)).toBeNull();
  });
  it('falls back to Eastern for a missing, malformed or unknown zone', () => {
    expect(resolveZone(undefined)).toBe(NY);
    expect(resolveZone('')).toBe(NY);
    expect(resolveZone('Not/AZone')).toBe(NY);
    expect(resolveZone('<script>')).toBe(NY);
    expect(resolveZone('Europe/London')).toBe('Europe/London');
    expect(resolveZone('america/new_york')).toBe(NY); // canonical case, so the label and the cache are stable
    expect(zoneFromCookieHeader('echo_tz=EUROPE%2Flondon')).toBe('Europe/London');
    expect(zoneFromCookieHeader(undefined)).toBe(NY);
    expect(zoneFromCookieHeader('a=b; echo_tz=Europe%2FLondon; c=d')).toBe('Europe/London');
    expect(zoneFromCookieHeader('echo_tz=%E0%A4%A')).toBe(NY);
    expect(zoneFromCookieHeader('echo_tz=Mars%2FBase')).toBe(NY);
  });
});

describe('local day ranges', () => {
  it('a 23:30Z event belongs to its Eastern date, not the UTC date', () => {
    const r = dayRange('2026-11-21', NY);
    expect(r.from).toBe('2026-11-21T05:00:00.000Z');
    expect(r.to).toBe('2026-11-22T05:00:00.000Z');
    expect('2026-11-21T23:30:00.000Z' >= r.from && '2026-11-21T23:30:00.000Z' < r.to).toBe(true);
    expect('2026-11-22T02:00:00.000Z' < r.to).toBe(true); // 9 PM Eastern on the 21st
    expect(localDate(Date.parse('2026-11-22T04:59:00Z'), NY)).toBe('2026-11-21');
    expect(localDate(Date.parse('2026-11-22T05:00:00Z'), NY)).toBe('2026-11-22');
  });
  it('a fall-back day is 25 hours and a spring-forward day is 23', () => {
    const fall = dayRange('2026-11-01', NY);
    expect(fall).toEqual({ from: '2026-11-01T04:00:00.000Z', to: '2026-11-02T05:00:00.000Z' });
    const spring = dayRange('2026-03-08', NY);
    expect(spring).toEqual({ from: '2026-03-08T05:00:00.000Z', to: '2026-03-09T04:00:00.000Z' });
    expect((Date.parse(fall.to) - Date.parse(fall.from)) / 3_600_000).toBe(25);
    expect((Date.parse(spring.to) - Date.parse(spring.from)) / 3_600_000).toBe(23);
  });
  it('when local midnight does not exist the day starts at its first valid instant', () => {
    // Santiago springs forward at 00:00 on 2026-09-06, so 00:00 never happens; the day starts at 01:00 local (04:00Z).
    expect(new Date(localDayStart('2026-09-06', 'America/Santiago')).toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(dayRange('2026-09-05', 'America/Santiago').to).toBe('2026-09-06T04:00:00.000Z');
  });
  it('offers seven days, three back to three ahead, labelled in local time, with Today as the default', () => {
    const opts = dayOptions(Date.parse('2026-11-22T03:00:00Z'), NY); // still Sat Nov 21 in New York
    expect(opts.map((o) => o.value)).toEqual(['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24']);
    expect(opts.map((o) => o.label)).toEqual(['Wed Nov 18', 'Thu Nov 19', 'Fri Nov 20', 'Today', 'Sun Nov 22', 'Mon Nov 23', 'Tue Nov 24']);
    expect(chooseDay(undefined, opts).label).toBe('Today');
    expect(chooseDay('2026-11-23', opts).value).toBe('2026-11-23');
    expect(chooseDay('2026-12-25', opts).label).toBe('Today'); // outside the seven
    expect(chooseDay('garbage', opts).label).toBe('Today');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('echo_tz cookie script', () => {
  it('has the reload guards', () => {
    expect(TZ_SCRIPT).toContain('document.cookie.indexOf');
    expect(TZ_SCRIPT).toContain('sessionStorage');
    expect(TZ_SCRIPT).toContain('location.reload()'); // not location.replace: a #merges URL would only scroll
    expect(TZ_SCRIPT).not.toContain('location.replace');
    expect(TZ_SCRIPT).toContain('data-zone');
  });

  function run(o: { cookieSticks: boolean; storage: 'ok' | 'throws' | 'flagged'; existing?: string; reload?: string; rendered?: string }) {
    const calls = { replaced: 0, written: '' };
    let jar = o.existing ?? '';
    const document = {
      get cookie() { return jar; },
      set cookie(v: string) { calls.written = v; if (o.cookieSticks) jar = v.split(';')[0]!; },
      querySelectorAll: () => [],
      currentScript: { getAttribute: (n: string) => (n === 'data-reload' ? (o.reload ?? '1') : (o.rendered ?? 'America/New_York')) },
    };
    const store = new Map<string, string>(o.storage === 'flagged' ? [['echo_tz_reloaded', '1']] : []);
    const sessionStorage = {
      getItem: (k: string) => { if (o.storage === 'throws') throw new Error('blocked'); return store.get(k) ?? null; },
      setItem: (k: string, v: string) => { if (o.storage === 'throws') throw new Error('blocked'); store.set(k, v); },
    };
    const location = { protocol: 'https:', href: 'https://x/admin', reload: () => void calls.replaced++ };
    new Function('document', 'sessionStorage', 'location', TZ_SCRIPT)(document, sessionStorage, location);
    return calls;
  }
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // The test runtime's own zone may be Eastern; make sure "rendered" differs from it when we want a reload.
  const other = zone === 'America/New_York' ? 'Europe/Paris' : 'America/New_York';
  it('writes the cookie and reloads once when it stuck', () => {
    const c = run({ cookieSticks: true, storage: 'ok', rendered: other });
    expect(c.written).toContain(`echo_tz=${encodeURIComponent(zone)}`);
    expect(c.replaced).toBe(1);
  });
  it('does not reload when cookies are blocked, storage throws, the flag is set, or the cookie is current', () => {
    expect(run({ cookieSticks: false, storage: 'ok', rendered: other }).replaced).toBe(0);
    expect(run({ cookieSticks: true, storage: 'throws', rendered: other }).replaced).toBe(0);
    expect(run({ cookieSticks: true, storage: 'flagged', rendered: other }).replaced).toBe(0);
    expect(run({ cookieSticks: true, storage: 'ok', reload: '0', rendered: other }).replaced).toBe(0); // a POST result page is never re-requested
    expect(run({ cookieSticks: true, storage: 'ok', existing: `echo_tz=${encodeURIComponent(zone)}`, rendered: other }).replaced).toBe(0);
    // already in the rendered zone (an Eastern viewer on the default): no cookie, no reload
    const same = run({ cookieSticks: true, storage: 'ok', rendered: zone });
    expect(same.replaced).toBe(0);
    expect(same.written).toBe('');
  });
});

describe('merge summaries', () => {
  it('shortens a real agent note to its intent', () => {
    expect(
      summarizeMerge(
        'Merge #743 Widget Z 2024-25 export module (NEW class; feature_flags.widget_export ON, rotates cache). AgentA merges after Reviewer confirms the final head. Sun 6:30 PM EST.',
      ),
    ).toBe('Widget Z 2024-25 export module');
    expect(summarizeMerge('Merge #744 Gadget 2022-23 labels (rotates cache). Merge Sat 10 PM EST.')).toBe('Gadget 2022-23 labels');
    expect(summarizeMerge('MERGE #743 Widget Z 2024-25')).toBe('Widget Z 2024-25');
  });
  it('does not mangle ordinary titles', () => {
    expect(summarizeMerge('Merge 3 hotfixes after review')).toBe('Merge 3 hotfixes after review');
    expect(summarizeMerge('PR 2024 cleanup')).toBe('PR 2024 cleanup');
    expect(summarizeMerge('Ship v2 at 5 pm')).toBe('Ship v2 at 5 pm'); // no day or zone: an ordinary title
    expect(summarizeMerge('Auth fix merges after 5pm')).toBe('Auth fix');
    expect(summarizeMerge('Dr. Smith rollout')).toBe('Dr. Smith rollout');
    expect(summarizeMerge('Deploy e.g. the new thing')).toBe('Deploy e.g. the new thing');
    expect(summarizeMerge('Merge Sat 10 PM EST')).toBe('Merge Sat 10 PM EST');
  });
  it('handles leftovers: a bare time, a dangling preposition, a stray dash, several PR numbers', () => {
    expect(summarizeMerge('Merge #7 at 5pm')).toBe('Merge #7 at 5pm');
    expect(summarizeMerge('Move cron to 9am')).toBe('Move cron to 9am');
    expect(summarizeMerge('PR #12 (feature flags cleanup) \u2014 remove dead flags. Merge at 5pm')).toBe('remove dead flags');
    expect(summarizeMerge('merge #7 and #8 together: auth + billing')).toBe('together: auth + billing');
  });
  it('stays fast on huge or deeply nested input and handles "PR #5 and PR #6"', () => {
    const t0 = Date.now();
    expect(summarizeMerge('(' .repeat(100_000) + ')'.repeat(100_000)).length).toBeLessThanOrEqual(80);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(summarizeMerge('Merge PR #5 and PR #6: foo')).toBe('foo');
  });
  it('keeps meaning on realistic notes', () => {
    expect(summarizeMerge('Merge #766 St. Louis site codes')).toBe('St. Louis site codes');
    expect(summarizeMerge('Merge #766 St. Louis site codes. Merge Sat 10 PM EST.')).toBe('St. Louis site codes');
    expect(summarizeMerge('Merge #783 Acme Deluxe Mark III 2024-25 Mon. 7 PM')).toBe('Acme Deluxe Mark III 2024-25');
    expect(summarizeMerge('Merge #793 merges after 6 PM')).toBe('Merge #793 merges after 6 PM');
  });
  it('never strips a warning parenthetical', () => {
    expect(summarizeMerge('Merge #787 (HOLD: do not ship) Gadget labels', 787)).toBe('(HOLD: do not ship) Gadget labels');
    expect(summarizeMerge("Merge #787 Gadget labels (don't merge before Monday; blocked on #800)", 787)).toBe("Gadget labels (don't merge before Monday; blocked on #800)");
    expect(summarizeMerge('Merge #787 Gadget labels (rotates cache) (WIP)', 787)).toBe('Gadget labels (WIP)');
  });
  it('keeps a warning that is in a later clause, not only in parentheses', () => {
    expect(summarizeMerge('merge #12 add St. Louis route. Hold until Mon. 7 PM EST', 12)).toBe('add St. Louis route. Hold until Mon. 7 PM EST');
    expect(summarizeMerge('#12 add thing. HOLD for review', 12)).toBe('add thing. HOLD for review');
    expect(summarizeMerge('#12 add thing; do not merge until review', 12)).toBe('add thing. do not merge until review');
    expect(summarizeMerge('#12 add thing. AgentA merges after Reviewer confirms the final head.', 12)).toBe('add thing');
  });
  it('keeps a warning that follows boilerplate in the same clause, a curly apostrophe, and the verb of "do not merge"', () => {
    expect(summarizeMerge('Fix login. Claude merges after Monday 7 PM, do not merge earlier', 1)).toBe('Fix login. Claude merges after Monday 7 PM, do not merge earlier');
    expect(summarizeMerge('Fix login, Claude merges after review but hold if CI is red', 1)).toBe('Fix login, Claude merges after review but hold if CI is red');
    // a negated warning is never reduced to a bare, opposite-looking word
    expect(summarizeMerge('Fix login. Claude merges after CI passes, no need to hold', 1)).toBe('Fix login. Claude merges after CI passes, no need to hold');
    expect(summarizeMerge('Fix X, merges after the revert lands', 1)).toBe('Fix X, merges after the revert lands');
    expect(summarizeMerge('Claude merges after review', 1)).toBe('Claude merges after review');
    expect(summarizeMerge('Add thing. Don\u2019t merge yet', 1)).toBe('Add thing. Don\u2019t merge yet');
    expect(summarizeMerge('Do not merge', 1)).toBe('Do not merge');
    expect(summarizeMerge('Fix X. Do not merge.', 1)).toBe('Fix X. Do not merge');
    expect(summarizeMerge('Fix X. Wait: do not merge until Mon. 7 PM', 1)).toBe('Fix X. Wait: do not merge until Mon. 7 PM');
  });
  it('leaves ordinary titles that end in a time alone, and strips a day or zone time', () => {
    expect(summarizeMerge('Move show to 7pm')).toBe('Move show to 7pm');
    expect(summarizeMerge('Doors at 8 PM')).toBe('Doors at 8 PM');
    expect(summarizeMerge('Do not merge before 7pm')).toBe('Do not merge before 7pm');
    expect(summarizeMerge('Do not merge before Mon 7pm')).toBe('Do not merge before Mon 7pm');
    expect(summarizeMerge('Add labels Sun 6:30 PM EST')).toBe('Add labels');
    expect(summarizeMerge('Add labels 7 PM EST')).toBe('Add labels');
  });
  it('the 80-character cap never hides a warning', () => {
    const long = summarizeMerge('Fix ' + 'A'.repeat(300) + ' do not merge');
    expect(long.length).toBeLessThanOrEqual(82);
    expect(long).toMatch(/^\u26a0 do not merge \u00b7 Fix A/);
    const second = summarizeMerge('Fix X. ' + 'B '.repeat(100) + 'do not merge');
    expect(second).toMatch(/do not merge/);
    expect(summarizeMerge('A short title. HOLD for review')).toBe('A short title. HOLD for review');
  });
  it('a capped headline keeps the negation around a warning and the typo marker', () => {
    const lead = 'Rework the report feature rendering pipeline for all legacy modules and plugins in the cache layer';
    expect(summarizeMerge(`${lead} - no need to hold`)).toMatch(/^\u26a0 no need to hold \u00b7 Rework the report/);
    expect(summarizeMerge(`${lead}, safe, never revert this`)).toMatch(/^\u26a0 never revert this \u00b7 Rework the report/);
    expect(summarizeMerge(`Merge #99 ${lead} hold`, 1)).toMatch(/^\(note says #99\) /);
  });
  it('a bare day or a dangling preposition left by stripping falls back to the whole note', () => {
    expect(summarizeMerge('Merge #5: Sun 6:30 PM EST')).toBe('Merge #5: Sun 6:30 PM EST');
    expect(summarizeMerge('Add show for Sat 7 PM')).toBe('Add show for Sat 7 PM');
  });
  it('catches warnings beyond the first word list, each with the same subject', () => {
    const subject = 'Acme Gadgets 2021-23 exporter';
    for (const w of [
      'Never merge on a Friday.', 'Must not merge before Reviewer OK.', "Can't merge until Monday.", 'Cannot merge yet; Release freeze.',
      'DNM.', 'Blocking: CI red.', 'Blocker on CI.', 'Paused until alice OK.', 'Cancelled \u2014 superseded by #812.', 'NOT before 22:00Z.',
    ]) {
      const h = summarizeMerge(`Merge #800 ${subject}. ${w}`, 800);
      expect(h.startsWith(subject), h).toBe(true);
      expect(h.toLowerCase(), h).toContain(w.replace(/[.;:\u2014].*$/, '').toLowerCase().split(' ')[0]!);
      expect(h.length, h).toBeGreaterThan(subject.length + 2); // the warning clause is in the headline
    }
    expect(summarizeMerge('Merge #818 Widget Z merges after Reviewer unless CI is red', 818)).toBe('Widget Z merges after Reviewer unless CI is red');
  });
  it('a capped headline says what the merge is, split with the warning', () => {
    const h = summarizeMerge('Merge #813 Acme Gadgets 2021-23 export module with collision sweeps, year-digit parity fixtures and cache rotation; hold until Reviewer OK.', 813);
    expect(h).toMatch(/^\u26a0 hold until Reviewer OK \u00b7 Acme Gadgets 2021-23/);
    expect(h.length).toBeLessThanOrEqual(84);
  });
  it('"more" is mechanical: any cut from the note, other than its leading "Merge #N", sets it', () => {
    // nothing cut: a plain title, with or without the leading prefix
    expect(summarizeMergeDetail('Fix login redirect').more).toBe(false);
    expect(summarizeMergeDetail('Merge #1 Acme exporter', 1)).toEqual({ headline: 'Acme exporter', more: false });
    expect(summarizeMergeDetail('Merge #1 Acme exporter.', 1).more).toBe(false); // one trailing period is ignored
    // every other cut sets it, even when it is "just" boilerplate
    expect(summarizeMergeDetail('Merge #44 Widget Z 2024-25. Merge Sun 6:30 PM EST.', 44)).toEqual({ headline: 'Widget Z 2024-25', more: true });
    expect(summarizeMergeDetail('Add labels Sun 6:30 PM EST').more).toBe(true);
    expect(summarizeMergeDetail('Merge #44 Widget Z 2024-25 (rotates cache)', 44).more).toBe(true);
    expect(summarizeMergeDetail('Merge #44 Widget Z 2024-25. Extra detail about rollout order.', 44).more).toBe(true);
    expect(summarizeMergeDetail('x'.repeat(200)).more).toBe(true); // shortened by the cap
    expect(summarizeMergeDetail('Merge #7 and #8: foo', 7).more).toBe(true); // only the first PR number is a prefix
    expect(summarizeMergeDetail('Merge #44 Widget Z 2024-25. AgentA merges after Reviewer confirms the final head. Sun 6:30 PM EST.', 44).more).toBe(true);
  });
  it('"more" is true for every case where an instruction was cut', () => {
    for (const note of [
      'Merge #1 Acme exporter. AgentA merges after Reviewer drains the queue.',
      'Merge #1 Acme exporter. AgentA merges after Reviewer stops the workers.',
      'Merge #1 Acme exporter. AgentA merges after Reviewer holds it',
      'Merge #1 Do not purge AgentA merges after Reviewer drains the queue',
      'Merge #1 Acme exporter, postpone until Sun 7 PM EST',
      'Merge #1 Acme exporter. Postpone to Mon 7 PM EST.',
      `Merge #1 Acme exporter. ${'x '.repeat(1500)}`, // past the 2000-character bound
      'Add X. Merges after Reviewer review, then run script',
      'Add X. Merges when carol approves',
      'Add X, bob merges after Reviewer but also needs carol ok',
    ]) expect(summarizeMergeDetail(note, 1).more, note).toBe(true);
  });
  it('does not strip "merge" from a plain title', () => {
    expect(summarizeMerge('Resolve rebase and merge')).toBe('Resolve rebase and merge');
    expect(summarizeMerge('Fix squash merge')).toBe('Fix squash merge');
  });
  it('a stray ")" does not switch off clause cutting; a dangling "merges" is dropped', () => {
    expect(summarizeMerge('#12 add x :) nice. next', 12)).toBe('add x :) nice');
    expect(summarizeMerge('#12 add thing merges at 7 PM', 12)).toBe('add thing');
    expect(summarizeMerge('#12 add x (not ready) merges at 7 PM', 12)).toBe('add x');
  });
  it('keeps a PR number that differs from the row, so a typo stays visible', () => {
    expect(summarizeMerge('Merge #787 Gadget labels', 788)).toBe('(note says #787) Gadget labels');
    expect(summarizeMerge('Merge #787 Gadget labels', 787)).toBe('Gadget labels');
    expect(summarizeMerge('Merge #787 Gadget labels', null)).toBe('Gadget labels');
  });
  it('returns a plain title unchanged', () => {
    expect(summarizeMerge('Fix login redirect')).toBe('Fix login redirect');
  });
  it('splits only on a dash with spaces both sides, so ranges and model names survive', () => {
    expect(summarizeMerge('Acme v2-beta 2024-25 exporter - AgentA merges after Reviewer')).toBe('Acme v2-beta 2024-25 exporter');
    expect(summarizeMerge('Acme v2-beta 2024-25 exporter')).toBe('Acme v2-beta 2024-25 exporter');
    expect(summarizeMerge('Merge #12 - fix the thing; then more')).toBe('fix the thing');
    expect(summarizeMerge('Merge #753 Acme Widget - Pro 2024-25 exporter')).toBe('Acme Widget - Pro 2024-25 exporter');
  });
  it('drops nested and unclosed parentheticals and a trailing time', () => {
    expect(summarizeMerge('Add labels (a (b) c) for Acme')).toBe('Add labels for Acme');
    expect(summarizeMerge('Add labels (keeps going')).toBe('Add labels');
    expect(summarizeMerge('Add labels Sun 6:30 PM EST')).toBe('Add labels');
  });
  it('caps long text near 80 characters on a word boundary', () => {
    const out = summarizeMerge('Rework ' + 'the report feature rendering pipeline '.repeat(6));
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith('…')).toBe(true);
  });
  it('falls back to the original when nothing is left', () => {
    expect(summarizeMerge('(only a parenthetical)')).toBe('(only a parenthetical)');
    expect(summarizeMerge('')).toBe('');
  });
});

describe('admin pages in local time', () => {
  const ORIGIN = 'https://echo.test';
  const ctx = testCtx();
  let s: Awaited<ReturnType<typeof seed>>;
  let cookie: string;
  beforeEach(async () => {
    ctx.setNow(new Date().toISOString());
    s = await seed(ctx);
    const login = await SELF.fetch(`${ORIGIN}/admin/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': `10.9.9.${++ip}` },
      body: new URLSearchParams({ password: 'correct horse' }),
    });
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  });
  const get = (path: string, tz?: string) =>
    SELF.fetch(`${ORIGIN}${path}`, { redirect: 'manual', headers: { cookie: tz ? `${cookie}; echo_tz=${encodeURIComponent(tz)}` : cookie } });
  const insert = (pr: number, startsAt: string, title: string) =>
    ctx.db
      .prepare(
        `INSERT INTO events (project_id, title, starts_at, entered_as, kind, repo_id, pr_number, merger_agent_id, created_by, updated_at)
         VALUES (?,?,?,?,'merge',?,?,?,'Alice',?)`,
      )
      .bind(s.project.id, title, startsAt, startsAt, s.repo.id, pr, s.alice.id, ctx.now())
      .run();

  it('the overview picker has seven days, defaults to Today, and shows no UTC text', async () => {
    const html = await (await get(`/admin/p/${s.project.id}`)).text();
    expect(html.match(/<option value="\d{4}-\d{2}-\d{2}"/g)).toHaveLength(7);
    expect(html).toMatch(/<option value="[\d-]+" selected>Today<\/option>/);
    expect(html).toMatch(/Today(?:'|&#39;)s merges/);
    expect(html).not.toMatch(/\bUTC\b/);
    expect(html).toContain('America/New York');
  });

  it('?day= picks the day by its Eastern date: 23:30Z shows on its own date and 02:00Z on the one before', async () => {
    const tomorrow = addDays(localDate(Date.now(), NY), 1);
    const dayStartMs = Date.parse(`${tomorrow}T00:00:00Z`);
    await insert(61, new Date(dayStartMs + 23.5 * 3_600_000).toISOString(), 'late merge'); // 6:30 or 7:30 PM Eastern that day
    await insert(62, new Date(dayStartMs + 2 * 3_600_000).toISOString(), 'early merge'); // evening of the day before
    const page = await (await get(`/admin/p/${s.project.id}?day=${tomorrow}`)).text();
    expect(page).toContain('acme/app#61');
    expect(page).not.toContain('acme/app#62');
    expect(page).toContain(`<option value="${tomorrow}" selected>`);
    expect(page).toMatch(/[PE]M E[SD]T/);
    const before = await (await get(`/admin/p/${s.project.id}?day=${addDays(tomorrow, -1)}`)).text();
    expect(before).toContain('acme/app#62');
    expect(before).not.toContain('acme/app#61');
    expect(await (await get(`/admin/p/${s.project.id}?day=1999-01-01`)).text()).toMatch(/selected>Today</);
  });

  it('a future day never badges a merge as next, and a GET page lets the zone script reload', async () => {
    const day = addDays(localDate(Date.now(), NY), 2);
    await insert(65, new Date(localDayStart(day, NY) + 3_600_000 * 15).toISOString(), 'later merge');
    const page = await (await get(`/admin/p/${s.project.id}?day=${day}`)).text();
    expect(page).toContain('acme/app#65');
    expect(page).not.toContain('badge t-info">next');
    expect(page).toContain('data-reload="1"');
  });

  it('a POST result page does not let the script reload (a reload would be a GET of a POST url)', async () => {
    // A rule error on a real route re-renders the page at the POST url, with a non-303 status.
    const res = await SELF.fetch(`${ORIGIN}/admin/p/${s.project.id}/repos`, {
      method: 'POST', redirect: 'manual',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ repo: 'bad' }),
    });
    expect(res.status).not.toBe(303);
    expect(res.status).not.toBe(404);
    const html = await res.text();
    expect(html).toContain('<script nonce=');
    expect(html).toContain('data-reload="0"');
    expect(html).not.toContain('data-reload="1"');
  });

  it('a merge shows its summary as the headline and keeps the full note', async () => {
    const note = 'Merge #743 Widget Z 2024-25 export module (NEW class; rotates cache). AgentA merges after Reviewer confirms the final head. Sun 6:30 PM EST.';
    const today = localDate(Date.now(), NY);
    await insert(743, new Date(localDayStart(today, NY) + 3_600_000 * 20).toISOString(), note);
    const html = await (await get(`/admin/p/${s.project.id}`)).text();
    expect(html).toContain('>Widget Z 2024-25 export module</span>');
    expect(html).toContain('<summary>Full note (more)</summary>'); // the parenthetical was left out
    expect(html).toContain('AgentA merges after Reviewer confirms the final head.');
    expect(html).toContain('title="Merge #743 Widget Z 2024-25 export module (NEW class; rotates cache).');
  });

  it('the server emits the zone it rendered in (data-zone), and the script needs it', async () => {
    expect(await (await get(`/admin/p/${s.project.id}`)).text()).toContain('data-zone="America/New_York"');
    expect(await (await get(`/admin/p/${s.project.id}`, 'America/Chicago')).text()).toContain('data-zone="America/Chicago"');
    expect(await (await get(`/admin/p/${s.project.id}`, 'Mars/Base')).text()).toContain('data-zone="America/New_York"');
  });

  it('times follow the echo_tz cookie, keep the UTC value, and a bad cookie falls back to Eastern', async () => {
    const at = '2026-11-18T23:30:00.000Z';
    await ctx.db.prepare(`UPDATE agents SET last_checked_in_at = ? WHERE id = ?`).bind(at, s.alice.id).run();
    const east = await (await get(`/admin/p/${s.project.id}`)).text();
    expect(east).toContain(`<time datetime="${at}" title="${at}">Nov 18, 6:30 PM EST</time>`);
    const chi = await (await get(`/admin/p/${s.project.id}`, 'America/Chicago')).text();
    expect(chi).toContain('Nov 18, 5:30 PM CST');
    const bad = await (await get(`/admin/p/${s.project.id}`, 'Mars/Base')).text();
    expect(bad).toContain('Nov 18, 6:30 PM EST');
  });

  it('the calendar page has a "When" header with local times and no UTC', async () => {
    await insert(64, '2026-11-18T23:30:00.000Z', 'x');
    const html = await (await get(`/admin/p/${s.project.id}/calendar?show=all`)).text();
    expect(html).toContain('<th>When</th>');
    expect(html).toContain('Nov 18, 6:30 PM EST');
    expect(html).not.toMatch(/\bUTC\b/);
  });
});
