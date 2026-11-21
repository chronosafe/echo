import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { revokeAgent } from '../src/domain/agents';
import { registerApprovals } from '../src/domain/approvals';
import { addEvent } from '../src/domain/calendar';
import { changesSince } from '../src/domain/changelog';
import { ackHold, placeHold, releaseHold } from '../src/domain/holds';
import { ackMessage, deferMessage, sendMessage, withdrawMessage } from '../src/domain/messages';
import { archiveProject, removeMember } from '../src/domain/projects';
import { seed, testCtx } from './helpers';

const ctx = testCtx();
let s: Awaited<ReturnType<typeof seed>>;

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const res = await SELF.fetch(`https://echo.test${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}
const postRaw = (path: string, token: string | null, body: unknown = {}) => call('POST', `/api/v1${path}`, token, body);
const post = async (path: string, token: string, body: unknown = {}) => (await postRaw(path, token, body)).json;
const NOFLAGS = { auto: false, admin: false };
const checkedIn = async (id: number) =>
  (await ctx.db.prepare(`SELECT last_checked_in_at AS t FROM agents WHERE id = ?`).bind(id).first<{ t: string | null }>())!.t;
const logged = (projectId: number, kind: string) => changesSince(ctx, projectId, 0).then((c) => c.filter((x) => x.kind === kind));

beforeEach(async () => {
  ctx.setNow('2026-11-18T20:00:00.000Z');
  s = await seed(ctx);
  registerApprovals(); // other test files clear the calendar hooks
});

describe('hook API', () => {
  it('incident replay at the API level with a blocking hold', async () => {
    const hold = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 709, reason: 'blocking finding' });
    const r1 = await post('/merge-check', s.bob.token, { repo: 'ACME/app', pr: 709, flags: NOFLAGS });
    expect(r1).toMatchObject({
      gated: true,
      allowed: false,
      blocks: [{ kind: 'hold', hold: expect.objectContaining({ id: hold.id, placedBy: 'Alice', kind: 'blocking' }) }],
    });
    await ackHold(ctx, s.bob.id, hold.id, 'noted');
    expect((await post('/merge-check', s.bob.token, { repo: 'acme/app', pr: 709, flags: NOFLAGS })).allowed).toBe(false);
    await releaseHold(ctx, s.alice.id, hold.id, 'fixed');
    expect((await post('/merge-check', s.bob.token, { repo: 'acme/app', pr: 709, flags: NOFLAGS })).allowed).toBe(true);
  });

  it('orient includes the server time and pending approvals', async () => {
    await ctx.db.prepare(`UPDATE projects SET approvals_required = 1 WHERE id = ?`).bind(s.project.id).run();
    const slot = '2030-01-01T12:00:00Z';
    const ev = await addEvent(ctx, s.bobA, {
      projectId: s.project.id, title: 'merge 709', startsAt: slot, kind: 'merge', repo: 'acme/app', pr: 709, approvers: ['Alice'],
    });
    const hold = await placeHold(ctx, s.bobA, { repo: 'acme/app', pr: 3, reason: 'look' });
    await sendMessage(ctx, s.bobA, { projectId: s.project.id, to: 'Alice', body: 'hi alice', requiresAck: false });
    await archiveProject(ctx, s.other.id);

    const o = await post('/orient', s.alice.token);
    expect(Math.abs(Date.parse(o.now) - Date.now())).toBeLessThan(60_000);
    expect(o.agent).toMatchObject({ id: s.alice.id, name: 'Alice' });
    expect(o.projects).toEqual([{ id: s.project.id, name: 'core' }]);
    expect(o.pendingApprovals).toEqual([
      { eventId: ev.id, repo: 'acme/app', pr: 709, startsAt: '2030-01-01T12:00:00.000Z', merger: 'Bob' },
    ]);
    expect(o.openHolds.map((h: any) => h.id)).toEqual([hold.id]);
    expect(o.fresh.map((m: any) => m.body)).toContain('hi alice');
    expect(o.gatedRepos).toEqual(['acme/app']);
    expect(await checkedIn(s.alice.id)).not.toBeNull();

    const c = await post('/orient', s.carol.token);
    expect(c.projects).toEqual([]); // archived projects are left out
    expect(c.openHolds).toEqual([]);
  });

  it('merge-check works for an agent outside the project and is not gated for unregistered repos', async () => {
    await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 5, reason: 'x' });
    const outside = await post('/merge-check', s.carol.token, { repo: 'acme/app', pr: 5, flags: NOFLAGS });
    expect(outside).toMatchObject({ gated: true, allowed: false });
    const open = await post('/merge-check', s.carol.token, { repo: 'nobody/else', pr: 5, flags: { auto: true, admin: true } });
    expect(open).toEqual({ gated: false, allowed: true, blocks: [] });
    expect(await logged(s.project.id, 'merge.refused')).toHaveLength(1); // only the gated, refused one
    const bad = await postRaw('/merge-check', s.carol.token, { repo: 'not a repo', pr: 5, flags: NOFLAGS });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('BAD_REPO');
  });

  it('poll updates last_checked_in_at; merge-check does not', async () => {
    expect(await checkedIn(s.alice.id)).toBeNull();
    await post('/merge-check', s.alice.token, { repo: 'acme/app', pr: 1, flags: NOFLAGS });
    await post('/merge-report', s.alice.token, { repo: 'acme/app', pr: 1, mergedAt: '2026-11-18T19:00:00Z' });
    expect(await checkedIn(s.alice.id)).toBeNull();
    await post('/poll', s.alice.token);
    const t = await checkedIn(s.alice.id);
    expect(t).not.toBeNull();
    expect(Math.abs(Date.parse(t!) - Date.now())).toBeLessThan(60_000);
    await post('/stop-check', s.bob.token);
    expect(await checkedIn(s.bob.id)).not.toBeNull();
  });

  it('a revoked token gets 401 BAD_TOKEN on every route', async () => {
    await revokeAgent(ctx, s.alice.id);
    const routes: [string, string, unknown?][] = [
      ['POST', '/api/v1/orient', {}],
      ['POST', '/api/v1/poll', {}],
      ['POST', '/api/v1/stop-check', {}],
      ['POST', '/api/v1/merge-check', { repo: 'acme/app', pr: 1, flags: NOFLAGS }],
      ['POST', '/api/v1/merge-report', { repo: 'acme/app', pr: 1, mergedAt: '2026-11-18T19:00:00Z' }],
      ['POST', '/api/v1/override-report', { repo: 'acme/app', pr: 1, reason: 'x' }],
      ['GET', '/api/v1/repos'],
    ];
    for (const [m, p, b] of routes) {
      for (const tok of [s.alice.token, null]) {
        const r = await call(m, p, tok, b);
        expect([p, r.status]).toEqual([p, 401]);
        expect(r.json.error).toMatchObject({ kind: 'rule', code: 'BAD_TOKEN' });
      }
    }
  });

  it('a body with an unexpected time field is rejected (strict schemas)', async () => {
    const r = await postRaw('/merge-report', s.alice.token, {
      repo: 'acme/app', pr: 1, mergedAt: '2026-11-18T19:00:00Z', sentAt: '2026-11-18T19:00:00Z',
    });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatchObject({ kind: 'rule', code: 'BAD_REQUEST' });
    expect(r.json.error.message).toContain('sentAt');
    const p = await postRaw('/poll', s.alice.token, { sentAt: 'x' });
    expect(p.status).toBe(400);
    expect(p.json.error.message).toContain('sentAt');
    const o = await postRaw('/override-report', s.alice.token, { repo: 'acme/app', pr: 1, reason: 'r', at: 'x' });
    expect(o.json.error.code).toBe('BAD_REQUEST');
    expect(await logged(s.project.id, 'merge.recorded')).toHaveLength(0);
    expect(await checkedIn(s.alice.id)).toBeNull(); // rejected before any side effect
  });

  it('rejects bad pr, missing flags and malformed json as BAD_REQUEST', async () => {
    for (const pr of [0, -1, 1.5, '7']) {
      const r = await postRaw('/merge-check', s.alice.token, { repo: 'acme/app', pr, flags: NOFLAGS });
      expect([pr, r.status, r.json.error.code]).toEqual([pr, 400, 'BAD_REQUEST']);
    }
    expect((await postRaw('/merge-check', s.alice.token, { repo: 'acme/app', pr: 1 })).json.error.code).toBe('BAD_REQUEST');
    const res = await SELF.fetch('https://echo.test/api/v1/poll', {
      method: 'POST',
      headers: { authorization: `Bearer ${s.alice.token}` },
      body: '{nope',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe('BAD_REQUEST');
  });

  it('merge-check with a flag in a gated repo returns the decision and logs merge.refused', async () => {
    const r = await post('/merge-check', s.bob.token, { repo: 'acme/app', pr: 8, flags: { auto: true, admin: false } });
    expect(r).toEqual({ gated: true, allowed: true, blocks: [] });
    const rows = await logged(s.project.id, 'merge.refused');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'Bob', data: { pr: 8, blocks: [], flags: { auto: true, admin: false } } });
    await post('/merge-check', s.bob.token, { repo: 'acme/app', pr: 9, flags: NOFLAGS }); // allowed, no flag: nothing
    expect(await logged(s.project.id, 'merge.refused')).toHaveLength(1);
  });

  it('merge.refused stores the PR number as a numeric subject and the repository in data', async () => {
    await post('/merge-check', s.bob.token, { repo: 'ACME/app', pr: 8, flags: { auto: true, admin: false } });
    const [row] = await logged(s.project.id, 'merge.refused');
    expect(row.subjectId).toBe(8);
    expect(typeof row.subjectId).toBe('number');
    expect(row.data).toMatchObject({ repo: 'acme/app', pr: 8 });
  });

  it('merge-report records once with the reported time; unregistered repo is not recorded', async () => {
    const body = { repo: 'ACME/app', pr: 12, mergedAt: '2026-11-18T13:00:00-06:00' };
    expect(await post('/merge-report', s.alice.token, body)).toEqual({ recorded: true });
    expect(await post('/merge-report', s.alice.token, body)).toEqual({ recorded: true });
    const rows = await logged(s.project.id, 'merge.recorded');
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toMatchObject({ mergedAt: '2026-11-18T19:00:00.000Z', source: 'hook' });
    expect(await post('/merge-report', s.alice.token, { repo: 'x/y', pr: 1, mergedAt: '2026-11-18T19:00:00Z' })).toEqual({ recorded: false });
    const noZone = await postRaw('/merge-report', s.alice.token, { repo: 'acme/app', pr: 13, mergedAt: '2026-11-18T19:00:00' });
    expect(noZone.status).toBe(400);
    expect(noZone.json.error.code).toBe('TIME_NEEDS_ZONE');
  });

  it('override-report logs override.used for a registered repo only', async () => {
    expect(await post('/override-report', s.alice.token, { repo: 'ACME/app', pr: 4, reason: 'prod down' })).toEqual({ recorded: true });
    const rows = await logged(s.project.id, 'override.used');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'Alice', data: { repo: 'acme/app', pr: 4, reason: 'prod down' } });
    expect(rows[0].subjectId).toBe(4);
    expect(Math.abs(Date.parse(rows[0].at) - Date.now())).toBeLessThan(60_000);
    expect(await post('/override-report', s.alice.token, { repo: 'x/y', pr: 4, reason: 'r' })).toEqual({ recorded: false });
    expect(await logged(s.project.id, 'override.used')).toHaveLength(1);
  });

  it('poll, stop-check and repos return their documented shapes', async () => {
    await sendMessage(ctx, s.aliceA, { projectId: s.project.id, to: 'Bob', body: 'hello', requiresAck: true });
    const poll = await post('/poll', s.bob.token);
    expect(Object.keys(poll).sort()).toEqual(['awaitingAck', 'fresh', 'gatedRepos', 'now']);
    expect(poll.fresh).toHaveLength(1);
    expect(poll.fresh[0].body).toBe('hello');
    expect(poll.gatedRepos).toEqual(['acme/app']);
    const stop = await post('/stop-check', s.bob.token);
    expect(Object.keys(stop)).toEqual(['awaitingAck']);
    expect(stop.awaitingAck).toHaveLength(1);
    // stop-check leaves a plain message for the next poll.
    await sendMessage(ctx, s.aliceA, { projectId: s.project.id, to: 'Bob', body: 'later', requiresAck: false });
    expect((await post('/stop-check', s.bob.token)).awaitingAck).toHaveLength(1);
    expect((await post('/poll', s.bob.token)).fresh.map((m: any) => m.body)).toEqual(['later']);
    const repos = await call('GET', '/api/v1/repos', s.bob.token);
    expect(repos.json).toEqual({ gatedRepos: ['acme/app'] });
  });

  it('stop-check returns a never-polled requires-ack message and delivers it', async () => {
    await sendMessage(ctx, s.aliceA, { projectId: s.project.id, to: 'Bob', body: 'must ack', requiresAck: true });
    const stop = await post('/stop-check', s.bob.token);
    expect(stop.awaitingAck.map((m: any) => m.body)).toEqual(['must ack']);
    expect(await logged(s.project.id, 'message.delivered')).toHaveLength(1);
    const poll = await post('/poll', s.bob.token);
    expect(poll.fresh).toEqual([]);
    expect(poll.awaitingAck.map((m: any) => m.body)).toEqual(['must ack']);
  });
  describe('peek', () => {
    const send = (body: string, requiresAck = false) =>
      sendMessage(ctx, s.aliceA, { projectId: s.project.id, to: 'Bob', body, requiresAck });
    const peek = (token: string) => postRaw('/peek', token);
    const snapshot = async () => ({
      recipients: (await ctx.db.prepare(`SELECT * FROM message_recipients ORDER BY message_id, agent_id`).all()).results,
      log: (await ctx.db.prepare(`SELECT COUNT(*) AS n FROM change_log`).first<{ n: number }>())!.n,
      checkedIn: await checkedIn(s.bob.id),
    });

    it('counts undelivered messages with ids and senders, never bodies', async () => {
      const a = await send('secret body one');
      const b = await send('secret body two', true);
      const r = await peek(s.bob.token);
      expect(r.status).toBe(200);
      expect(Object.keys(r.json).sort()).toEqual(['count', 'messages', 'now']);
      expect(r.json.count).toBe(2);
      expect(r.json.messages.map((m: any) => m.messageId)).toEqual([a.messageId, b.messageId]);
      expect(Object.keys(r.json.messages[0]).sort()).toEqual(['from', 'messageId']);
      expect(JSON.stringify(r.json)).not.toContain('secret body');
    });

    it('changes no state: a following poll still returns the message as fresh', async () => {
      await send('hello', true);
      const before = await snapshot();
      await peek(s.bob.token);
      await peek(s.bob.token);
      expect(await snapshot()).toEqual(before);
      expect(before.checkedIn).toBeNull();
      const poll = await post('/poll', s.bob.token);
      expect(poll.fresh.map((m: any) => m.body)).toEqual(['hello']);
      expect((await peek(s.bob.token)).json.count).toBe(0);
    });

    it('excludes delivered messages that only await an ack', async () => {
      await send('needs ack', true);
      await post('/poll', s.bob.token);
      expect((await peek(s.bob.token)).json.count).toBe(0);
      const poll = await post('/poll', s.bob.token);
      expect(poll.awaitingAck).toHaveLength(1);
    });

    it('excludes deferred messages until due, then counts them without resurfacing', async () => {
      // The API runs on the real clock, so "not due" is deferred from the real now and "due" from the past.
      const notDue = await send('not yet', true);
      const due = await send('due', true);
      await post('/poll', s.bob.token);
      ctx.setNow(new Date().toISOString());
      await deferMessage(ctx, s.bob.id, notDue.messageId, 30, 'busy');
      ctx.setNow('2026-11-18T20:00:00.000Z');
      await deferMessage(ctx, s.bob.id, due.messageId, 30, 'busy');
      const before = await snapshot();
      const r = await peek(s.bob.token);
      expect(r.json.messages.map((x: any) => x.messageId)).toEqual([due.messageId]);
      expect(await snapshot()).toEqual(before);
      const poll = await post('/poll', s.bob.token);
      expect(poll.fresh.map((x: any) => x.messageId)).toEqual([due.messageId]);
      expect((await peek(s.bob.token)).json.count).toBe(0);
    });

    it('excludes messages of a project the agent was removed from, exactly as poll does', async () => {
      await send('before removal');
      expect((await peek(s.bob.token)).json.count).toBe(1);
      await removeMember(ctx, { kind: 'admin' }, s.project.id, s.bob.id);
      expect((await peek(s.bob.token)).json.count).toBe(0);
      expect((await post('/poll', s.bob.token)).fresh).toEqual([]);
    });

    it('excludes acknowledged and withdrawn messages', async () => {
      const a = await send('to ack', true);
      const w = await send('to withdraw');
      await ackMessage(ctx, s.bob.id, a.messageId);
      await withdrawMessage(ctx, s.aliceA, w.messageId);
      expect((await peek(s.bob.token)).json.count).toBe(0);
    });

    it('does not show one agent another agent\'s messages, needs a token and takes an empty body only', async () => {
      await send('for bob');
      expect((await peek(s.alice.token)).json.count).toBe(0);
      expect((await peek(null as any)).status).toBe(401);
      const bad = await postRaw('/peek', s.bob.token, { sentAt: 'x' });
      expect(bad.status).toBe(400);
      expect(bad.json.error.code).toBe('BAD_REQUEST');
    });
  });
});
