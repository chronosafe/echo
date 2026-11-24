import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { PRETTY_CAP } from '../src/admin/data-view';
import { adminReleaseOwner, batchWrite, deleteEntry, putEntry } from '../src/domain/data';
import { assertConsistent } from './data-invariants';
import { violations } from './data-oracle';
import { seed, testCtx } from './helpers';

const ORIGIN = 'https://echo.test';
const ctx = testCtx();
let ip = 100;
let s: Awaited<ReturnType<typeof seed>>;
let cookie: string;
let P: string;

async function sessionCookie(): Promise<string> {
  const res = await SELF.fetch(`${ORIGIN}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': `10.7.0.${++ip}` },
    body: new URLSearchParams({ password: 'correct horse' }),
  });
  return res.headers.get('set-cookie')!.split(';')[0]!;
}
const get = (path: string, c: string | null = cookie) => SELF.fetch(`${ORIGIN}${path}`, { redirect: 'manual', headers: c ? { cookie: c } : {} });
const post = (path: string, form: Record<string, string>, c: string | null = cookie, headers: Record<string, string> = {}) =>
  SELF.fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', ...(c ? { cookie: c } : {}), ...headers },
    body: new URLSearchParams(form),
  });
const page = async (path: string) => {
  const res = await get(path);
  const text = await res.text();
  return { status: res.status, text };
};
const q = (key: string, extra = '') => `${P}/data/entry?key=${encodeURIComponent(key)}${extra}`;
const ver = (key: string, v: number) => `${P}/data/version?key=${encodeURIComponent(key)}&v=${v}`;
const A = () => s.aliceA;
const put = (key: string, value: unknown, expectedVersion: number, extra: Record<string, unknown> = {}) =>
  putEntry(ctx, A(), { projectId: s.project.id, key, value, expectedVersion, ...extra });
/** The text of the main region, tags removed, entities decoded just enough to compare. */
const textOf = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

beforeEach(async () => {
  ctx.setNow('2026-11-24T10:00:00.000Z');
  s = await seed(ctx);
  cookie = await sessionCookie();
  P = `/admin/p/${s.project.id}`;
});

describe('access', () => {
  it('pages redirect to login without a cookie; POSTs without a session or with a foreign Origin are refused', async () => {
    await put('k', 1, 0);
    for (const path of [`${P}/data`, q('k'), ver('k', 1)]) {
      const res = await get(path, null);
      expect([res.status, res.headers.get('location')], path).toEqual([303, '/admin/login']);
    }
    for (const act of ['release', 'delete']) {
      expect((await post(`${P}/data/${act}`, { key: 'k', version: '1', reason: 'x', confirm: 'yes' }, null)).status).toBe(403);
      expect((await post(`${P}/data/${act}`, { key: 'k', version: '1', reason: 'x', confirm: 'yes' }, cookie, { origin: 'https://evil.example' })).status).toBe(403);
    }
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM data_history`).first<{ n: number }>())!.n).toBe(1);
  });

  it('the project navigation lists Shared data beside Documents', async () => {
    const { text } = await page(`${P}/data`);
    expect(text).toMatch(/<a href="\/admin\/p\/\d+\/documents"[^>]*>Documents<\/a><a href="\/admin\/p\/\d+\/data"[^>]*>Shared data<\/a>/);
  });
});

describe('list', () => {
  it('groups by first segment, filters by prefix, toggles deleted keys and shows counts and history size', async () => {
    await put('rulings/a', { r: 1 }, 0, { owner: 'me', note: 'owner, verbatim' });
    await put('rulings/b_c', 'x', 0);
    await put('rulings/bXc', 'y', 0);
    await put('slots/2026-03-12', { by: 'Bob' }, 0);
    await put('top', 1, 0);
    await put('gone', 1, 0);
    await deleteEntry(ctx, A(), { projectId: s.project.id, key: 'gone', expectedVersion: 1 });
    const all = await page(`${P}/data`);
    expect(all.status).toBe(200);
    expect(violations(all.text)).toEqual([]);
    const t = textOf(all.text);
    expect(t).toContain('5 live keys');
    expect(t).toMatch(/History: 7 versions, \d/);
    expect(t).toContain('rulings/ 3');
    expect(t).toContain('slots/ 1');
    expect(t).toContain('No namespace 1');
    expect(t).toContain('owner, verbatim');
    expect(t).toContain('shared');
    expect(t).not.toContain('gone'); // tombstones hidden by default
    expect((await page(`${P}/data?deleted=1`)).text).toContain('>gone</a>');
    const pre = textOf((await page(`${P}/data?prefix=${encodeURIComponent('rulings/b_')}`)).text);
    expect(pre).toContain('rulings/b_c');
    expect(pre).not.toContain('rulings/bXc'); // "_" is literal
    expect(pre).not.toContain('rulings/a ');
    expect(textOf((await page(`${P}/data?prefix=RULINGS`)).text)).toContain('No keys match');
  });

  it('shows local time through the existing helper', async () => {
    await put('k', 1, 0);
    const { text } = await page(`${P}/data`);
    expect(text).toMatch(/<time datetime="2026-11-24T10:00:00.000Z" title="2026-11-24T10:00:00.000Z">Nov 24, \d+:00 (AM|PM) E[SD]T<\/time>/);
  });

  it('previews at most 200 characters and never loads the whole value; deleted keys show no value', async () => {
    await put('big', { text: 'z'.repeat(60000) }, 0);
    const { text } = await page(`${P}/data`);
    const m = /<div class="pv">([^<]*)<\/div>/.exec(text)!;
    expect(m[1]!.replace(/&quot;/g, '"').length).toBeLessThanOrEqual(201);
    expect(m[1]).toMatch(/…$/);
    expect(text.length).toBeLessThan(40000); // the page never carried the 60 KB value
  });

  it('pages at 500 keys with a link to the next', async () => {
    await env.DB.exec(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 520) INSERT INTO data_entries SELECT ${s.project.id}, 'k' || printf('%04d', i), 1, '1', NULL, 'Alice', '2026-11-24T10:00:00.000Z', NULL, 0 FROM n`,
    );
    const first = await page(`${P}/data`);
    expect((first.text.match(/class="ref" href="[^"]*\/data\/entry/g) ?? []).length).toBe(500);
    const next = /href="([^"]*after=[^"]*)"/.exec(first.text)!;
    expect(next[1]!.replace(/&amp;/g, '&')).toContain('after=k0500');
    const second = await page(next[1]!.replace(/&amp;/g, '&'));
    expect((second.text.match(/class="ref" href="[^"]*\/data\/entry/g) ?? []).length).toBe(20);
    expect(second.text).not.toContain('Next keys');
  });

  it('empty project says so', async () => {
    expect(textOf((await page(`${P}/data`)).text)).toContain('No shared data yet');
  });
});

describe('entry and version pages', () => {
  it('shows the pretty value and the history without values; dotted keys work through ?key=; bad keys are 404', async () => {
    await put('v1.2/a.b', { secret: 'FIRST-VALUE' }, 0);
    await put('v1.2/a.b', { secret: 'SECOND-VALUE' }, 1, { note: 'changed' });
    const { status, text } = await page(q('v1.2/a.b'));
    expect(status).toBe(200);
    expect(violations(text)).toEqual([]);
    expect(text).toContain('<pre>\n{\n  &quot;secret&quot;: &quot;SECOND-VALUE&quot;\n}</pre>');
    expect(text).not.toContain('FIRST-VALUE'); // history lists no values
    expect(textOf(text)).toMatch(/v2.*v1/);
    expect(text).toContain('/data/version?key=v1.2%2Fa.b&amp;v=2');
    for (const bad of ['a/../b', '..', '.', 'a//b', '<script>', '', 'x'.repeat(201)]) {
      expect((await get(q(bad))).status, bad).toBe(404);
      expect((await get(ver(bad, 1))).status, bad).toBe(404);
    }
    expect((await get(q('missing'))).status).toBe(404);
    expect((await get(ver('v1.2/a.b', 9))).status).toBe(404);
    expect((await get(ver('v1.2/a.b', 0))).status).toBe(404);
    expect((await get(`${P}/data/version?key=v1.2/a.b`)).status).toBe(404);
    expect((await get(q('v1.2/a.b', '&before=x'))).status).toBe(404);
  });

  it('lists 50 versions per page, newest first, with a link to older ones', async () => {
    await put('many', 0, 0);
    for (let i = 1; i < 60; i++) await put('many', i, i);
    const first = await page(q('many'));
    const versions = [...first.text.matchAll(/data\/version\?key=many&amp;v=(\d+)"/g)].map((m) => Number(m[1]));
    expect(versions).toHaveLength(50);
    expect(versions[0]).toBe(60);
    expect(versions[49]).toBe(11);
    const older = /href="([^"]*before=10[^"]*)"|href="([^"]*before=11[^"]*)"/.exec(first.text)!;
    const second = await page((older[1] ?? older[2])!.replace(/&amp;/g, '&'));
    expect([...second.text.matchAll(/data\/version\?key=many&amp;v=(\d+)"/g)].map((m) => Number(m[1]))).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(second.text).not.toContain('Older versions');
  });

  it('a version page shows ONE exact diff against the previous version, from empty for the first, and for delete and recreate', async () => {
    await put('d', { a: 1, b: [1, 2] }, 0);
    await put('d', { a: 2, b: [1, 2] }, 1, { note: 'bump a' });
    await deleteEntry(ctx, A(), { projectId: s.project.id, key: 'd', expectedVersion: 2, note: 'done' });
    await put('d', { z: true }, 3);
    const lines = (html: string) => [...html.matchAll(/<div class="(add|del|gap|)">([^<]*)<\/div>/g)].map((m) => `${m[1] === 'add' ? '+' : m[1] === 'del' ? '-' : m[1] === 'gap' ? '~' : ' '}|${m[2]!.replace(/&quot;/g, '"')}`);
    expect(lines((await page(ver('d', 1))).text)).toEqual(['+|+ {', '+|+   "a": 1,', '+|+   "b": [', '+|+     1,', '+|+     2', '+|+   ]', '+|+ }']);
    const v2 = await page(ver('d', 2));
    expect(violations(v2.text)).toEqual([]);
    expect(lines(v2.text)).toEqual([' |  {', '-|-   "a": 1,', '+|+   "a": 2,', ' |    "b": [', ' |      1,', ' |      2', '~|2 unchanged lines']);
    expect(textOf(v2.text)).toContain('bump a');
    const v3 = await page(ver('d', 3));
    expect(lines(v3.text).every((l) => l.startsWith('-|'))).toBe(true);
    expect(textOf(v3.text)).toMatch(/delete/);
    const v4 = await page(ver('d', 4));
    expect(lines(v4.text)).toEqual(['+|+ {', '+|+   "z": true', '+|+ }']); // recreated: from empty, not from v2
    expect(v4.text).toContain('v=3'); // previous link
    expect(v4.text).not.toContain('v=5');
  });

  it('admin_release shows an unchanged value; a retired owner is named', async () => {
    await put('r', { v: 1 }, 0, { owner: 'me' });
    await adminReleaseOwner(ctx, s.project.id, 'r', 1, 'gone');
    const v2 = await page(ver('r', 2));
    expect(textOf(v2.text)).toContain('No change in the value');
    expect(textOf(v2.text)).toContain('admin_release');
    expect(textOf(v2.text)).toContain('note: gone');
  });

  it('past the pretty-print cap the page shows the raw stored text; past the diff cap both versions are shown', async () => {
    const wide = Array.from({ length: 4000 }, () => [[[[[0]]]]]); // ~56 KB compact, about 700 KB pretty-printed
    expect(JSON.stringify(wide).length).toBeLessThan(65536);
    await put('wide', wide, 0);
    const entry = await page(q('wide'));
    expect(entry.status).toBe(200);
    expect(textOf(entry.text)).toContain('Too large to pretty-print');
    expect(entry.text).toContain('[[[[[0]]]]],[[[[[0]]]]]');
    const v1 = await page(ver('wide', 1));
    expect(textOf(v1.text)).toContain('too large to pretty-print');
    expect(PRETTY_CAP).toBe(262144);
    // many changed lines, but within the pretty cap
    await put('chg', Array.from({ length: 1500 }, (_, i) => i), 0);
    await put('chg', Array.from({ length: 1500 }, (_, i) => i + 5000), 1);
    const v2 = await page(ver('chg', 2));
    expect(textOf(v2.text)).toContain('Too many changes');
    expect(v2.text).toContain('<summary>Previous version</summary>');
    expect(violations(v2.text)).toEqual([]);
  });

  it('the worst case page renders quickly', async () => {
    await put('w', Array.from({ length: 16000 }, () => 0), 0);
    await put('w', Array.from({ length: 16000 }, (_, i) => (i % 2 ? 1 : 0)), 1);
    const t0 = Date.now();
    const r = await page(ver('w', 2));
    const ms = Date.now() - t0;
    expect(r.status).toBe(200);
    expect(ms, `version page of 16,000-line values took ${ms} ms`).toBeLessThan(5000);
  });
});

describe('the version page shows the value itself', () => {
  it('shows that version in full above the diff, also for a version with no change', async () => {
    await put('vv', { a: 1, long: Array.from({ length: 30 }, (_, i) => i) }, 0, { owner: 'me' });
    await adminReleaseOwner(ctx, s.project.id, 'vv', 1, 'x');
    const v2 = (await page(ver('vv', 2))).text;
    expect(v2).toContain('<h3>Value</h3><pre>\n{\n  &quot;a&quot;: 1,');
    expect(v2).toContain('    29\n');
    expect(textOf(v2)).toContain('No change in the value');
    await deleteEntry(ctx, A(), { projectId: s.project.id, key: 'vv', expectedVersion: 2 });
    expect(textOf((await page(ver('vv', 3))).text)).toContain('This version has no value (a delete).');
  });
});

describe('repair actions', () => {
  const act = (name: string, key: string, version: number, extra: Record<string, string> = {}) =>
    post(`${P}/data/${name}`, { key, version: String(version), reason: 'cleanup', confirm: 'yes', ...extra });
  const history = async (key: string) => (await env.DB.prepare(`SELECT version, op, actor, note, owner FROM data_history WHERE key = ? ORDER BY version`).bind(key).all<any>()).results;

  it('Release owner and Delete entry need the confirm box and a reason, then write history as admin', async () => {
    await put('mine', { v: 1 }, 0, { owner: 'me' });
    await put('doomed', { v: 2 }, 0);
    expect(textOf((await page(q('mine'))).text)).toContain('Release owner');
    expect(textOf((await page(q('doomed'))).text)).not.toContain('Release owner'); // nothing to release
    expect((await page(q('doomed'))).text).toContain(`action="${P}/data/delete"`);

    const noConfirm = await act('release', 'mine', 1, { confirm: '' });
    expect(noConfirm.status).toBe(400);
    expect(textOf(await noConfirm.text())).toContain('CONFIRM_NEEDED');
    const noReason = await act('release', 'mine', 1, { reason: '  ' });
    expect(noReason.status).toBe(400);
    expect(textOf(await noReason.text())).toContain('REASON_REQUIRED');
    expect(await history('mine')).toHaveLength(1);

    const rel = await act('release', 'mine', 1, { reason: 'Alice is gone' });
    expect(rel.status).toBe(303);
    expect(await history('mine')).toMatchObject([{}, { version: 2, op: 'admin_release', actor: 'admin', note: 'Alice is gone', owner: null }]);
    const del = await act('delete', 'doomed', 1, { reason: 'stale' });
    expect(del.status).toBe(303);
    expect((await history('doomed'))[1]).toMatchObject({ version: 2, op: 'admin_delete', actor: 'admin', note: 'stale' });
    const log = (await env.DB.prepare(`SELECT kind, actor, data FROM change_log WHERE actor = 'admin' ORDER BY seq`).all<any>()).results;
    expect(log.map((l) => [l.kind, JSON.parse(l.data).op])).toEqual([['data.put', 'admin_release'], ['data.deleted', 'admin_delete']]);
    expect(textOf((await page(q('doomed'))).text)).toContain('Deleted. The history below is kept.');
    await assertConsistent();
  });

  it('a stale version, a deleted entry and bad input are refused with a banner and change nothing', async () => {
    await put('k', 1, 0, { owner: 'me' });
    await put('k', 2, 1);
    const stale = await act('delete', 'k', 1);
    expect(stale.status).toBe(409);
    expect(textOf(await stale.text())).toContain('VERSION_CONFLICT');
    expect((await act('delete', 'k', 0)).status).toBe(400);
    expect((await act('delete', 'a/../b', 1)).status).toBe(400);
    expect((await act('delete', 'nope', 1)).status).toBe(409);
    expect(await history('k')).toHaveLength(2);
    await assertConsistent();
  });
});

describe('what agents wrote is escaped, and invisible characters are shown', () => {
  const BIDI = String.fromCodePoint(0x202e);
  const ZW = String.fromCodePoint(0x200b);

  it('shows bidi and zero-width characters as visible escapes in the value, note, owner and actor, never raw', async () => {
    const hostile = await env.DB.prepare(`INSERT INTO agents (name, token_hash, created_at) VALUES (?,?,?) RETURNING id`).bind(`Eve${BIDI}ZW${ZW}`, 'h1', '2026-11-24T10:00:00.000Z').first<{ id: number }>();
    await env.DB.prepare(`INSERT INTO project_agents (project_id, agent_id) VALUES (?,?)`).bind(s.project.id, hostile!.id).run();
    const eve = { kind: 'agent' as const, agentId: hostile!.id, name: `Eve${BIDI}ZW${ZW}` };
    await putEntry(ctx, eve, { projectId: s.project.id, key: 'e', value: { v: `a${BIDI}b${ZW}c` }, expectedVersion: 0, owner: 'me', note: `n${BIDI}${ZW}` });
    for (const path of [`${P}/data`, q('e'), ver('e', 1)]) {
      const { text } = await page(path);
      expect(text, path).not.toContain(BIDI);
      expect(text, path).not.toContain(ZW);
    }
    const entry = (await page(q('e'))).text;
    expect(entry).toContain('a\\u{202E}b\\u{200B}c');
    expect(entry).toContain('Eve\\u{202E}ZW\\u{200B}');
    expect(entry).toContain('n\\u{202E}\\u{200B}');
    expect(violations(entry)).toEqual([]);
  });

  it('a change made only with an invisible character shows in the diff; typed escapes look different from real ones', async () => {
    await put('inv', 'abc', 0);
    await put('inv', `ab${ZW}c`, 1);
    const v2 = (await page(ver('inv', 2))).text;
    expect(v2).toContain('<div class="del">- &quot;abc&quot;</div>');
    expect(v2).toContain('<div class="add">+ &quot;ab\\u{200B}c&quot;</div>');
    await put('typed', String.fromCharCode(92) + 'u{200B}', 0);
    const typed = (await page(q('typed'))).text;
    expect(typed).toContain('&quot;' + String.fromCharCode(92).repeat(4) + 'u{200B}&quot;'); // JSON doubles the backslash and visible() doubles both: never a lone real escape
  });

  const FRAGMENTS = ['<', '>', '"', "'", '&', '&lt;', '&#39;', '</pre>', '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>', 'javascript:alert(1)', '`', '${x}', '{{x}}', '\n', '\t', '\\', '\u{1F600}', String.fromCodePoint(0x2028), String.fromCodePoint(0xfeff), '</td></tr></table>', '<!--', '-->', '<a href="https://evil.example">x</a>', 'a'.repeat(300)];

  it('survives a seeded fuzz of hostile values, notes and reasons on every page', async () => {
    let seedState = 99;
    const rand = () => ((seedState = (seedState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const make = (max: number) => {
      let out = '';
      for (let i = 0; i < 1 + Math.floor(rand() * 8); i++) out += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)];
      return out.slice(0, max);
    };
    for (let i = 0; i < 25; i++) {
      const key = `fz/${i}`;
      const v1 = { s: make(2000), [make(30)]: make(100), list: [make(50), null, 3] };
      await put(key, v1, 0, { note: make(500), owner: i % 2 ? 'me' : undefined });
      await put(key, { ...v1, s: make(2000) }, 1, { note: make(500) });
      if (i % 5 === 0) await deleteEntry(ctx, A(), { projectId: s.project.id, key, expectedVersion: 2, note: make(100) });
    }
    for (const path of [`${P}/data`, `${P}/data?deleted=1`, `${P}/data?prefix=fz%2F1`, P]) {
      const { status, text } = await page(path);
      expect(status, path).toBe(200);
      expect(violations(text), path).toEqual([]);
    }
    for (let i = 0; i < 25; i++) {
      for (const path of [q(`fz/${i}`), ver(`fz/${i}`, 1), ver(`fz/${i}`, 2)]) {
        const { status, text } = await page(path);
        expect(status, path).toBe(200);
        expect(violations(text), path).toEqual([]);
      }
    }
    // a hostile prefix is escaped in the filter box
    const hp = await page(`${P}/data?prefix=${encodeURIComponent('"><script>x</script>')}`);
    expect(violations(hp.text)).toEqual([]);
    expect(textOf(hp.text)).toContain('No keys match');
  });

  it('the CSP is unchanged: scripts only by nonce, and the page has no inline handlers', async () => {
    await put('k', '<script>alert(1)</script>', 0);
    const res = await get(q('k'));
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toMatch(/'nonce-[^']+'/);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    const text = await res.text();
    expect(text).not.toContain('<script>alert(1)');
    expect(text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect((text.match(/<script/g) ?? []).length).toBe(1); // only the nonce'd zone script
  });
});

describe('the activity feed', () => {
  it('shows data changes with the exact key and a link to the entry, also for keys that look like numbers', async () => {
    await put('007', { n: 1 }, 0);
    await put('rulings/x', 1, 0);
    await deleteEntry(ctx, A(), { projectId: s.project.id, key: 'rulings/x', expectedVersion: 1 });
    const { text } = await page(P);
    expect(violations(text)).toEqual([]);
    expect(text).toContain(`href="${P}/data/entry?key=007"`);
    expect(text).toContain(`href="${P}/data/entry?key=rulings%2Fx"`);
    expect(text).toMatch(/<b>data\.put<\/b> <a class="ref"/);
    expect(text).toMatch(/<b>data\.deleted<\/b> <a class="ref"/);
  });

  it('batch writes appear as one row per key', async () => {
    await batchWrite(ctx, A(), { projectId: s.project.id, ops: [{ op: 'put', key: 'a', value: 1, expectedVersion: 0 }, { op: 'put', key: 'b', value: 1, expectedVersion: 0 }] });
    const t = (await page(P)).text;
    expect(t).toContain('key=a"');
    expect(t).toContain('key=b"');
  });
});
