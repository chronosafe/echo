import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { admin } from '../src/admin/routes';

const app = new Hono().route('/admin', admin); // as index.ts mounts it
import { parseZonedTime } from '../src/time';
import { resetInstallationTokens } from '../src/github/app';
import { RECONCILE_KEY } from '../src/github/status';
import { fakeGithub } from './fake-github';
import { makeSession } from '../src/admin/auth';
import { createAgent } from '../src/domain/agents';
import { mergeDecision, registerApprovals } from '../src/domain/approvals';
import { addEvent } from '../src/domain/calendar';
import { changesSince } from '../src/domain/changelog';
import { adminReleaseHold, placeHold } from '../src/domain/holds';
import { deferMessage, sendMessage } from '../src/domain/messages';
import { addMember } from '../src/domain/projects';
import { addTodo } from '../src/domain/todos';
import { seed, testCtx } from './helpers';

const ORIGIN = 'https://echo.test';
const ctx = testCtx();
let ipCounter = 0;

async function login(password = 'correct horse', headers: Record<string, string> = {}) {
  return SELF.fetch(`${ORIGIN}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': `10.0.0.${++ipCounter}`, ...headers },
    body: new URLSearchParams({ password }),
  });
}

async function sessionCookie(): Promise<string> {
  const res = await login();
  const set = res.headers.get('set-cookie')!;
  return set.split(';')[0]!;
}

function get(path: string, cookie?: string) {
  return SELF.fetch(`${ORIGIN}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
}

function post(path: string, cookie: string | null, form: Record<string, string> = {}, headers: Record<string, string> = {}) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}), ...headers },
    body: new URLSearchParams(form),
  });
}

let s: Awaited<ReturnType<typeof seed>>;
beforeEach(async () => {
  ctx.setNow(new Date().toISOString());
  s = await seed(ctx);
});

describe('admin login and guards', () => {
  it('pages redirect to login without a cookie; a wrong password does not set one', async () => {
    for (const path of ['/admin', `/admin/p/${s.project.id}`, `/admin/p/${s.project.id}/schedule?from=a&to=b`]) {
      const res = await get(path);
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/admin/login');
    }
    expect((await get('/admin/login')).status).toBe(200);

    const bad = await login('correct horsf');
    expect(bad.status).toBe(401);
    expect(bad.headers.get('set-cookie')).toBeNull();

    const good = await login();
    expect(good.status).toBe(303);
    expect(good.headers.get('location')).toBe('/admin');
    const set = good.headers.get('set-cookie')!;
    expect(set).toMatch(/^echo_admin=\d+\.[0-9a-f]{64};/);
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/admin', 'Max-Age=43200']) expect(set).toContain(attr);
    expect((await get('/admin', set.split(';')[0])).status).toBe(200);
  });

  it('rate-limits login per IP', async () => {
    const ip = { 'cf-connecting-ip': '203.0.113.9' };
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await login('nope', ip)).status);
    expect(codes).toContain(429);
    expect(codes[0]).toBe(401);
  });

  it('a forged or expired cookie is refused; a foreign Origin POST is refused', async () => {
    const good = await sessionCookie();
    const [name, value] = good.split('=');
    const [expiry, sig] = value!.split('.');
    const forged = `${name}=${Number(expiry) + 1000}.${sig}`; // same signature, different expiry
    const junk = `${name}=${expiry}.${'0'.repeat(64)}`;
    const expired = `${name}=${await makeSession(env, '2020-01-01T00:00:00.000Z')}`;
    for (const c of [forged, junk, expired, `${name}=garbage`]) {
      const page = await get('/admin', c);
      expect(page.status, c).toBe(303);
      expect(page.headers.get('location')).toBe('/admin/login');
      expect((await post(`/admin/holds/1/release`, c)).status, c).toBe(403);
    }

    // valid cookie, but a foreign or missing Origin
    expect((await post('/admin/holds/1/release', good, {}, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post('/admin/holds/1/release', good, {}, { origin: 'null' })).status).toBe(403);
    const noOrigin = await SELF.fetch(`${ORIGIN}/admin/holds/1/release`, { method: 'POST', redirect: 'manual', headers: { cookie: good } });
    expect(noOrigin.status).toBe(403);
    // login is exempt from the cookie check but not from the Origin check
    expect((await login('correct horse', { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('sends a restrictive CSP with a per-response nonce, and logout clears the cookie', async () => {
    const cookie = await sessionCookie();
    const a = await get(`/admin/p/${s.project.id}`, cookie);
    const b = await get(`/admin/p/${s.project.id}`, cookie);
    const cspA = a.headers.get('content-security-policy')!;
    expect(cspA).toMatch(/^default-src 'self'; style-src 'unsafe-inline'; script-src 'self' 'nonce-[\w-]+'; form-action 'self'; frame-ancestors 'none'$/);
    const nonce = cspA.match(/'nonce-([\w-]+)'/)![1]!;
    expect(await a.text()).toContain(`<script nonce="${nonce}" data-reload=`);
    expect(b.headers.get('content-security-policy')).not.toBe(cspA);

    const out = await post('/admin/logout', cookie);
    expect(out.status).toBe(303);
    expect(out.headers.get('set-cookie')).toMatch(/echo_admin=;.*(Max-Age=0|Expires=)/);
  });
});

describe('admin actions', () => {
  it('force-release of a blocking hold lets the next merge-check through and logs actor admin', async () => {
    const hold = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 5, reason: 'bad' });
    expect((await mergeDecision(ctx, 'acme/app', 5)).allowed).toBe(false);
    const cookie = await sessionCookie();
    const res = await post(`/admin/holds/${hold.id}/release`, cookie, { note: 'checked it' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin');
    expect((await mergeDecision(ctx, 'acme/app', 5)).allowed).toBe(true);
    const logged = (await changesSince(ctx, s.project.id, 0)).filter((c) => c.kind === 'hold.released');
    expect(logged).toHaveLength(1);
    expect(logged[0]!.actor).toBe('admin');
    const row = await ctx.db.prepare(`SELECT release_note, released_by FROM holds WHERE id = ?`).bind(hold.id).first<any>();
    expect(row).toEqual({ release_note: 'checked it', released_by: 'admin' });
  });

  it('defaults the note to "by the owner"', async () => {
    const hold = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 5, reason: 'bad' });
    await post(`/admin/holds/${hold.id}/release`, await sessionCookie());
    const row = await ctx.db.prepare(`SELECT release_note FROM holds WHERE id = ?`).bind(hold.id).first<any>();
    expect(row.release_note).toBe('by the owner');
  });

  it('force-ack of a blocking hold records the ack but the merge stays blocked', async () => {
    const hold = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 5, reason: 'bad' });
    const res = await post(`/admin/holds/${hold.id}/force-ack`, await sessionCookie(), {});
    expect(res.status).toBe(303);
    const row = await ctx.db.prepare(`SELECT acked_by, ack_note, state FROM holds WHERE id = ?`).bind(hold.id).first<any>();
    expect(row).toEqual({ acked_by: 'admin', ack_note: 'by the owner', state: 'open' });
    expect((await mergeDecision(ctx, 'acme/app', 5)).allowed).toBe(false);
  });

  it('force-release enqueues a status job for an affected PR', async () => {
    const hold = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 5, reason: 'bad' });
    for (const pr of [5, 6]) {
      await ctx.db
        .prepare(`INSERT INTO pr_heads (repo_id, pr_number, head_sha, open, updated_at) VALUES (?,?,?,1,?)`)
        .bind(s.repo.id, pr, 'sha-shared', ctx.now())
        .run();
    }
    await ctx.db.prepare(`DELETE FROM status_jobs`).run();
    const res = await post(`/admin/holds/${hold.id}/release`, await sessionCookie());
    expect(res.status).toBe(303);
    const jobs = await ctx.db.prepare(`SELECT pr_number FROM status_jobs WHERE repo_id = ? ORDER BY pr_number`).bind(s.repo.id).all<any>();
    expect(jobs.results.map((j) => j.pr_number)).toEqual([5, 6]); // PR 6 shares the head commit
  });

  it('a domain error renders the project page with an escaped banner, not a 500', async () => {
    const hold = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 5, reason: 'bad' });
    const cookie = await sessionCookie();
    await post(`/admin/holds/${hold.id}/release`, cookie);
    const again = await post(`/admin/holds/${hold.id}/release`, cookie);
    expect(again.status).toBe(409);
    const text = await again.text();
    expect(text).toContain('HOLD_CLOSED');
    expect(text).toContain('Open holds'); // the project page, with the error banner
    const unknown = await post('/admin/holds/9999/release', cookie);
    expect(unknown.status).toBe(404);
  });

  it('redirects back to a same-origin /admin Referer only', async () => {
    const cookie = await sessionCookie();
    const mk = async () => (await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 5, reason: 'r' })).id;
    const ref = async (referer: string) => {
      const id = await mk();
      return (await post(`/admin/holds/${id}/release`, cookie, {}, { referer })).headers.get('location');
    };
    expect(await ref(`${ORIGIN}/admin/p/${s.project.id}?x=1`)).toBe(`/admin/p/${s.project.id}?x=1`);
    expect(await ref('https://evil.example/admin/p/1')).toBe('/admin');
    expect(await ref(`${ORIGIN}/elsewhere`)).toBe('/admin');
    expect(await ref('not a url')).toBe('/admin');
  });
});

describe('admin views', () => {
  it('a message to all shows each recipient separately with deferral and escalation', async () => {
    const dave = (await createAgent(ctx, 'Dave')).agent;
    await addMember(ctx, { kind: 'admin' }, s.project.id, dave.id);
    const sent = await sendMessage(ctx, s.aliceA, { projectId: s.project.id, to: 'all', body: 'ship it?', requiresAck: true, escalateAfterMin: 30 });
    await deferMessage(ctx, s.bob.id, sent.messageId, 15, 'in a meeting');
    const html = await (await get(`/admin/p/${s.project.id}`, await sessionCookie())).text();
    expect(html).toContain('ship it?');
    expect(html).toContain('Bob');
    expect(html).toContain('Dave');
    expect(html).toContain('in a meeting');
    expect(html).toMatch(/escalat/i);
    expect(html).toContain(`/admin/messages/${sent.messageId}/withdraw`);
    expect(html).toContain(`/admin/messages/${sent.messageId}/force-ack`);
    // one force-ack button per recipient
    expect(html.match(new RegExp(`/admin/messages/${sent.messageId}/force-ack`, 'g'))).toHaveLength(2);
  });

  it('force-ack and withdraw of a message act on the recipient and the message', async () => {
    const sent = await sendMessage(ctx, s.aliceA, { projectId: s.project.id, to: 'Bob', body: 'x', requiresAck: true });
    const cookie = await sessionCookie();
    expect((await post(`/admin/messages/${sent.messageId}/force-ack`, cookie, { agent: String(s.bob.id) })).status).toBe(303);
    const r = await ctx.db.prepare(`SELECT acked_by FROM message_recipients WHERE message_id = ?`).bind(sent.messageId).first<any>();
    expect(r.acked_by).toBe('admin');
    const other = await sendMessage(ctx, s.aliceA, { projectId: s.project.id, to: 'Bob', body: 'y', requiresAck: true });
    expect((await post(`/admin/messages/${other.messageId}/withdraw`, cookie)).status).toBe(303);
    const m = await ctx.db.prepare(`SELECT withdrawn_at FROM messages WHERE id = ?`).bind(other.messageId).first<any>();
    expect(m.withdrawn_at).not.toBeNull();
  });

  it('agent-supplied text is HTML-escaped on every page', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const weird = (await createAgent(ctx, `<b>Eve</b>`)).agent;
    await addMember(ctx, { kind: 'admin' }, s.project.id, weird.id);
    await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 5, reason: evil });
    await sendMessage(ctx, s.aliceA, { projectId: s.project.id, to: 'Bob', body: evil, requiresAck: true });
    await addTodo(ctx, s.aliceA, s.project.id, evil);
    await addEvent(ctx, s.aliceA, { projectId: s.project.id, title: evil, startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    await addEvent(ctx, s.aliceA, {
      projectId: s.project.id, title: 'm', startsAt: new Date(Date.now() + 3_600_000).toISOString(), kind: 'merge', repo: 'acme/app', pr: 9, merger: '<b>Eve</b>',
    });
    const cookie = await sessionCookie();
    const now = Date.now();
    const pages = [
      await get('/admin', cookie),
      await get(`/admin/p/${s.project.id}`, cookie),
      await get(
        `/admin/p/${s.project.id}/schedule?from=${new Date(now - 86_400_000).toISOString()}&to=${new Date(now + 86_400_000).toISOString()}`,
        cookie,
      ),
    ];
    const bodies = await Promise.all(pages.map((p) => p.text()));
    for (const b of bodies) {
      expect(b).not.toContain('<img src=x');
      expect(b).not.toContain('<b>Eve</b>');
    }
    expect(bodies[1]).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(bodies[1]).toContain('&lt;b&gt;Eve&lt;/b&gt;');
    expect(bodies[2]).toContain('&lt;b&gt;Eve&lt;/b&gt;'); // the merger's name in the schedule fragment
  });

  it('the overview says "never checked in" for an agent that has not checked in, and the time once it has', async () => {
    const cookie = await sessionCookie();
    await ctx.db.prepare(`UPDATE agents SET last_checked_in_at = NULL`).run();
    let html = await (await get(`/admin/p/${s.project.id}`, cookie)).text();
    expect(html).toContain('never checked in');
    expect(html).not.toContain('checked in never');
    await ctx.db.prepare(`UPDATE agents SET last_checked_in_at = '2026-11-19T15:41:00.000Z' WHERE id = ?`).bind(s.alice.id).run();
    html = await (await get(`/admin/p/${s.project.id}`, cookie)).text();
    expect(html).toMatch(/checked in <time[^>]*>Nov 19, 10:41 AM EST<\/time>/);
  });

  it('shows the notify_url banner when unset, and the failed GitHub status banner naming repo and error', async () => {
    const cookie = await sessionCookie();
    let html = await (await get('/admin', cookie)).text();
    expect(html).toMatch(/notif/i);
    expect(html).not.toContain('last GitHub status write failed');

    await ctx.db.prepare(`INSERT INTO owner_settings (key, value) VALUES ('notify_url', 'https://ntfy.example/x')`).run();
    await ctx.db
      .prepare(`INSERT INTO status_jobs (repo_id, pr_number, attempts, next_attempt_at, last_error) VALUES (?,?,?,?,?)`)
      .bind(s.repo.id, 7, 2, ctx.now(), 'GitHub said <403> forbidden')
      .run();
    // With the App configured, a failed write is shown, naming the repository and the error.
    const withApp = { ...env, GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY: 'configured' };
    const appCookie = `echo_admin=${await makeSession(withApp, new Date().toISOString())}`;
    html = await (await app.request(`${ORIGIN}/admin`, { headers: { cookie: appCookie } }, withApp)).text();
    expect(html).not.toMatch(/notify_url/);
    expect(html).toContain('acme/app');
    expect(html).toContain('GitHub said &lt;403&gt; forbidden');
    expect(html).toMatch(/GitHub status write failed/i);
    expect(html).not.toContain('GitHub App is not set up');
  });

  it('without the GitHub App, the home page says statuses are off instead of showing write failures', async () => {
    const cookie = await sessionCookie();
    await ctx.db
      .prepare(`INSERT INTO status_jobs (repo_id, pr_number, attempts, next_attempt_at, last_error) VALUES (?,?,?,?,?)`)
      .bind(s.repo.id, 7, 57, ctx.now(), 'GITHUB_APP_ID is not set.')
      .run();
    const html = await (await get('/admin', cookie)).text();
    expect(html).toContain('GitHub App is not set up');
    expect(html).not.toMatch(/GitHub status write failed/i);
    expect(html).not.toContain('GITHUB_APP_ID is not set');
  });

  it('schedule fragment for a -06:00 browser day includes a slot stored as 03:00Z the next UTC day', async () => {
    const insert = (pr: number, startsAt: string, enteredAs = startsAt) =>
      ctx.db
        .prepare(
          `INSERT INTO events (project_id, title, starts_at, entered_as, kind, repo_id, pr_number, merger_agent_id, created_by, updated_at)
           VALUES (?,?,?,?,'merge',?,?,?,'Alice',?)`,
        )
        .bind(s.project.id, `merge ${pr}`, startsAt, enteredAs, s.repo.id, pr, s.alice.id, ctx.now())
        .run();
    const slot = parseZonedTime('2026-11-18T21:00:00-06:00'); // 21:00 local, stored as 2026-11-19T03:00:00Z
    expect(slot.utc).toBe('2026-11-19T03:00:00.000Z');
    await insert(31, slot.utc, slot.enteredAs);
    await insert(32, '2026-11-19T07:00:00.000Z'); // next local day
    await insert(33, '2026-11-18T05:00:00.000Z'); // previous local day
    const cookie = await sessionCookie();
    const res = await get(`/admin/p/${s.project.id}/schedule?from=2026-11-18T06:00:00.000Z&to=2026-11-19T06:00:00.000Z`, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('acme/app#31');
    expect(html).not.toContain('#32');
    expect(html).not.toContain('#33');
    expect((await get(`/admin/p/${s.project.id}/schedule?from=garbage&to=2026-11-19T06:00:00.000Z`, cookie)).status).toBe(400);
  });
});

describe('admin approvals', () => {
  it('approve-for records responded_by admin and the merge becomes allowed in its window', async () => {
    registerApprovals(); // other test files clear the calendar hooks
    await ctx.db.prepare(`UPDATE projects SET approvals_required = 1 WHERE id = ?`).bind(s.project.id).run();
    const startsAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const ev = await addEvent(ctx, s.bobA, {
      projectId: s.project.id, title: 'ship', startsAt, kind: 'merge', repo: 'acme/app', pr: 40, approvers: ['Alice'],
    });
    ctx.setNow(new Date().toISOString());
    expect((await mergeDecision(ctx, 'acme/app', 40)).allowed).toBe(false);

    const cookie = await sessionCookie();
    const page = await (
      await get(`/admin/p/${s.project.id}/schedule?from=${new Date(Date.now() - 3_600_000).toISOString()}&to=${new Date(Date.now() + 3_600_000).toISOString()}`, cookie)
    ).text();
    expect(page).toContain('Approve for Alice');
    expect(page).toContain(`/admin/events/${ev.id}/approve`);

    const res = await post(`/admin/events/${ev.id}/approve`, cookie, { agent: 'Alice' });
    expect(res.status).toBe(303);
    const row = await ctx.db.prepare(`SELECT response, responded_by FROM event_approvers WHERE event_id = ?`).bind(ev.id).first<any>();
    expect(row).toEqual({ response: 'approved', responded_by: 'admin' });
    ctx.setNow(new Date().toISOString());
    expect((await mergeDecision(ctx, 'acme/app', 40)).allowed).toBe(true);

    const after = await (
      await get(`/admin/p/${s.project.id}/schedule?from=${new Date(Date.now() - 3_600_000).toISOString()}&to=${new Date(Date.now() + 3_600_000).toISOString()}`, cookie)
    ).text();
    expect(after).not.toContain('Approve for Alice');
  });
});

describe('admin change-log actor', () => {
  it('every admin action is logged with actor admin', async () => {
    registerApprovals();
    await ctx.db.prepare(`UPDATE projects SET approvals_required = 1 WHERE id = ?`).bind(s.project.id).run();
    const cookie = await sessionCookie();
    // The newest row of the action's own kind (a force-ack also queues a notice message after it).
    const newest = async (kind: string) =>
      (await ctx.db.prepare(`SELECT actor, kind FROM change_log WHERE project_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1`).bind(s.project.id, kind).first<any>())!;

    const hold1 = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 5, reason: 'r' });
    await post(`/admin/holds/${hold1.id}/force-ack`, cookie);
    expect(await newest('hold.acknowledged')).toEqual({ actor: 'admin', kind: 'hold.acknowledged' });
    await post(`/admin/holds/${hold1.id}/release`, cookie);
    expect(await newest('hold.released')).toEqual({ actor: 'admin', kind: 'hold.released' });

    const m1 = await sendMessage(ctx, s.aliceA, { projectId: s.project.id, to: 'Bob', body: 'x', requiresAck: true });
    await post(`/admin/messages/${m1.messageId}/force-ack`, cookie, { agent: String(s.bob.id) });
    expect(await newest('message.acknowledged')).toEqual({ actor: 'admin', kind: 'message.acknowledged' });
    const m2 = await sendMessage(ctx, s.aliceA, { projectId: s.project.id, to: 'Bob', body: 'y', requiresAck: true });
    await post(`/admin/messages/${m2.messageId}/withdraw`, cookie);
    expect(await newest('message.withdrawn')).toEqual({ actor: 'admin', kind: 'message.withdrawn' });

    const ev = await addEvent(ctx, s.bobA, {
      projectId: s.project.id, title: 'ship', startsAt: new Date(Date.now() + 600_000).toISOString(), kind: 'merge', repo: 'acme/app', pr: 41, approvers: ['Alice'],
    });
    await post(`/admin/events/${ev.id}/approve`, cookie, { agent: 'Alice' });
    expect(await newest('approval.approved')).toEqual({ actor: 'admin', kind: 'approval.approved' });
  });
});

describe('admin without a limiter, and the status kick', () => {
  let pem: string;
  beforeAll(async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
    let bin = '';
    for (const b of der) bin += String.fromCharCode(b);
    pem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin).match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
  });

  const execCtx = () => {
    const waited: Promise<unknown>[] = [];
    return { waited, ec: { waitUntil: (p: Promise<unknown>) => void waited.push(p), passThroughOnException() {} } as any };
  };

  it('login works when the LOGIN_LIMIT binding is undefined', async () => {
    const res = await app.request(
      `${ORIGIN}/admin/login`,
      { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: 'correct horse' }) },
      { ...env, LOGIN_LIMIT: undefined },
      execCtx().ec,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('set-cookie')).toContain('echo_admin=');
  });

  /** Default: release the hold. Otherwise the hold is released first, then `req` is posted. */
  async function release(withApp: boolean, req?: { path: string; form: Record<string, string> }) {
    const gh = fakeGithub();
    resetInstallationTokens();
    await ctx.db.prepare(`UPDATE repos SET installation_id = 77 WHERE id = ?`).bind(s.repo.id).run();
    await ctx.db.prepare(`INSERT INTO pr_heads (repo_id, pr_number, head_sha, open, updated_at) VALUES (?,?,?,1,?)`).bind(s.repo.id, 5, 'sha5', ctx.now()).run();
    gh.pulls.set('acme/app#5', { head: 'sha5', state: 'open', mergedAt: null });
    const hold = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 5, reason: 'r' });
    if (req) await adminReleaseHold(ctx, hold.id, 'test setup');
    await ctx.db.prepare(`DELETE FROM status_jobs`).run();
    // Stamp the periodic reconcile as just done: it would otherwise re-enqueue every open PR mid-run and push this job past the run's clock.
    await ctx.db.prepare(`INSERT INTO owner_settings (key, value) VALUES (?, ?)`).bind(RECONCILE_KEY, new Date().toISOString()).run();
    const e = {
      ...env,
      GITHUB_API_URL: 'https://gh.test',
      ...(withApp ? { GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY: pem } : {}),
    };
    const cookie = `echo_admin=${await makeSession(e, new Date().toISOString())}`;
    const { waited, ec } = execCtx();
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => gh.fetch(input, init));
    try {
      const res = await app.request(
        `${ORIGIN}${req ? req.path : `/admin/holds/${hold.id}/release`}`,
        {
          method: 'POST',
          headers: { origin: ORIGIN, cookie, ...(req ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
          ...(req ? { body: new URLSearchParams(req.form) } : {}),
        },
        e,
        ec,
      );
      expect(res.status).toBe(303);
      await Promise.all(waited);
    } finally {
      spy.mockRestore();
    }
    return { waited, gh };
  }

  it('with the GitHub App configured, a release hands the status run to waitUntil and the status is written', async () => {
    const { waited, gh } = await release(true);
    expect(waited).toHaveLength(1);
    expect(waited[0]).toBeInstanceOf(Promise);
    expect(gh.statuses.filter((x) => x.repo === 'acme/app' && x.sha === 'sha5')).toHaveLength(1);
    expect(gh.statuses[0]!.state).toBe('success'); // the hold is released
  });

  it('with the GitHub App unconfigured, nothing is registered with waitUntil', async () => {
    const { waited, gh } = await release(false);
    expect(waited).toHaveLength(0);
    expect(gh.statuses).toHaveLength(0);
  });

  it('a settings change (approvals on) hands the status run to waitUntil and flips the status to failure', async () => {
    const { waited, gh } = await release(true, { path: `/admin/p/${s.project.id}/settings`, form: { approvals: 'on', window: '30' } });
    expect(waited).toHaveLength(1);
    const written = gh.statuses.filter((x) => x.repo === 'acme/app' && x.sha === 'sha5');
    expect(written).toHaveLength(1);
    expect(written[0]!.state).toBe('failure'); // no merge is scheduled, and approvals are now required
  });
});
