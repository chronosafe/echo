import { beforeEach, describe, expect, it, vi } from 'vitest';
import { changesSince } from '../src/domain/changelog';
import { ackMessage, awaitingAckFor, readInbox, takeAwaitingForStop, takeForHook } from '../src/domain/messages';
import {
  ackHold,
  adminAckHold,
  adminReleaseHold,
  holdsFor,
  listHolds,
  placeHold,
  releaseHold,
  setHoldChangeListener,
} from '../src/domain/holds';
import { seed, testCtx } from './helpers';

const ctx = testCtx();
let s: Awaited<ReturnType<typeof seed>>;

beforeEach(async () => {
  ctx.setNow('2026-11-18T20:00:00.000Z');
  s = await seed(ctx);
  setHoldChangeListener(async () => {});
});

describe('holds', () => {
  it('a blocking hold still blocks after the merging agent acknowledges it', async () => {
    const h = await placeHold(ctx, s.aliceA, { repo: 'Acme/App', pr: 709, reason: 'blocking finding' });
    expect(h.kind).toBe('blocking');
    expect(h).toMatchObject({ repo: 'acme/app', pr: 709, placedBy: 'Alice', state: 'open', blocksMerge: true, acknowledged: null });
    await ackHold(ctx, s.bob.id, h.id, 'noted');
    expect((await holdsFor(ctx, 'acme/app', 709))[0]).toMatchObject({ blocksMerge: true, acknowledged: { by: 'Bob', note: 'noted' } });
    await releaseHold(ctx, s.alice.id, h.id, 'fixed in #712');
    expect(await holdsFor(ctx, 'acme/app', 709)).toEqual([]);
  });

  it('sends the hold message with the exact blocking body, requiring acknowledgment', async () => {
    const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 5, reason: 'bad migration' });
    const [item] = await readInbox(ctx, s.bob.id);
    expect(item).toMatchObject({ kind: 'hold', refId: h.id, requiresAck: true, from: 'Alice' });
    expect(item.body).toBe(
      'BLOCKING HOLD on acme/app#5 by Alice: bad migration. Acknowledging this message means "seen" only. ' +
        'Only Alice or the owner can release it; echo_ack_hold records that you have seen it but does not clear it.',
    );
    expect(h.message).toEqual({ delivered: 0, acknowledged: 0, recipients: 1 });
  });

  it('an advisory hold is released by an acknowledgment with a note', async () => {
    const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 2, reason: 'consider squashing', kind: 'advisory' });
    expect(h).toMatchObject({ kind: 'advisory', blocksMerge: true });
    const [item] = await readInbox(ctx, s.bob.id);
    expect(item.body).toBe(
      `ADVISORY HOLD on acme/app#2 by Alice: consider squashing. Acknowledging this message means "seen" only. ` +
        `The merging agent clears it with echo_ack_hold (hold_id=${h.id}, note required).`,
    );
    await expect(ackHold(ctx, s.bob.id, h.id, '  ')).rejects.toMatchObject({ code: 'NOTE_REQUIRED' });
    expect(await holdsFor(ctx, 'acme/app', 2)).toHaveLength(1);
    await ackHold(ctx, s.bob.id, h.id, 'squashed');
    expect(await holdsFor(ctx, 'acme/app', 2)).toEqual([]);
    const [view] = await listHolds(ctx, s.alice.id, { state: 'all' });
    expect(view).toMatchObject({
      state: 'released',
      blocksMerge: false,
      acknowledged: { by: 'Bob', note: 'squashed' },
      released: { by: 'Bob', note: 'squashed' },
    });
    const told = (await readInbox(ctx, s.alice.id)).map((i) => i.body).join('\n');
    expect(told).toContain('Bob');
    expect(told).toContain('squashed');
  });

  it('a blocking acknowledgment sends the note to the placer and leaves the hold open', async () => {
    await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 3, reason: 'r' });
    const [h] = await holdsFor(ctx, 'acme/app', 3);
    await ackHold(ctx, s.bob.id, h.id, 'will rebase first');
    const inbox = await readInbox(ctx, s.alice.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ from: 'Echo', requiresAck: false });
    expect(inbox[0].body).toContain('Bob');
    expect(inbox[0].body).toContain('will rebase first');
    expect(await holdsFor(ctx, 'acme/app', 3)).toHaveLength(1);
  });

  it('only the placer or the owner can release a blocking hold', async () => {
    const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 1, reason: 'r' });
    await expect(releaseHold(ctx, s.bob.id, h.id, 'x')).rejects.toMatchObject({ code: 'NOT_PLACER' });
    await expect(releaseHold(ctx, s.alice.id, h.id, ' ')).rejects.toMatchObject({ code: 'NOTE_REQUIRED' });
    await adminReleaseHold(ctx, h.id, 'owner says ok');
    const [view] = await listHolds(ctx, s.alice.id, { state: 'all' });
    expect(view.released).toMatchObject({ by: 'admin', note: 'owner says ok' });
  });

  it('the placer cannot acknowledge, a non-member cannot place or acknowledge, an unregistered repo is refused', async () => {
    const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 1, reason: 'r' });
    await expect(ackHold(ctx, s.alice.id, h.id, 'n')).rejects.toMatchObject({ code: 'PLACER_MUST_RELEASE' });
    await expect(ackHold(ctx, s.carol.id, h.id, 'n')).rejects.toMatchObject({ code: 'NOT_MEMBER' });
    await expect(placeHold(ctx, s.carolA, { repo: 'acme/app', pr: 1, reason: 'r' })).rejects.toMatchObject({ code: 'NOT_MEMBER' });
    await expect(placeHold(ctx, s.aliceA, { repo: 'acme/none', pr: 1, reason: 'r' })).rejects.toMatchObject({ code: 'REPO_NOT_REGISTERED' });
    await expect(placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 1, reason: '  ' })).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
  });

  it('acknowledging the hold message does not acknowledge the hold', async () => {
    const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 4, reason: 'r' });
    const [item] = await readInbox(ctx, s.bob.id);
    await ackMessage(ctx, s.bob.id, item.messageId);
    const [view] = await holdsFor(ctx, 'acme/app', 4);
    expect(view).toMatchObject({ id: h.id, acknowledged: null, blocksMerge: true, message: { acknowledged: 1, recipients: 1 } });
  });

  describe('acknowledging a hold also acknowledges its notice message, for that agent', () => {
    const joinCarol = () => ctx.db.prepare(`INSERT INTO project_agents (project_id, agent_id) VALUES (?,?)`).bind(s.project.id, s.carol.id).run();
    const messageAcks = async () => (await changesSince(ctx, s.project.id, 0)).filter((c) => c.kind === 'message.acknowledged');

    it('the agent recipient row is acknowledged, so stop-check and poll no longer list the message', async () => {
      const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 20, reason: 'r' });
      expect(await takeAwaitingForStop(ctx, s.bob.id)).toHaveLength(1);
      await ackHold(ctx, s.bob.id, h.id, 'seen, will wait');
      expect(await takeAwaitingForStop(ctx, s.bob.id)).toEqual([]);
      expect(await awaitingAckFor(ctx, s.bob.id)).toEqual([]);
      const polled = await takeForHook(ctx, s.bob.id);
      expect([...polled.fresh, ...polled.awaitingAck]).toEqual([]);
      const row = await ctx.db
        .prepare(`SELECT acked_by, ack_note FROM message_recipients WHERE agent_id = ?`)
        .bind(s.bob.id)
        .first<{ acked_by: string; ack_note: string }>();
      expect(row).toEqual({ acked_by: 'Bob', ack_note: 'seen, will wait' });
      expect(await messageAcks()).toMatchObject([{ actor: 'Bob', data: { agentId: s.bob.id, note: 'seen, will wait' } }]);
    });

    it('leaves the other recipients unacknowledged', async () => {
      await joinCarol();
      const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 21, reason: 'r' });
      await ackHold(ctx, s.bob.id, h.id, 'seen');
      expect(await takeAwaitingForStop(ctx, s.bob.id)).toEqual([]);
      expect(await takeAwaitingForStop(ctx, s.carol.id)).toHaveLength(1);
    });

    it('sends the placer exactly one notice', async () => {
      const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 22, reason: 'r' });
      await ackHold(ctx, s.bob.id, h.id, 'seen');
      const inbox = await readInbox(ctx, s.alice.id);
      expect(inbox).toHaveLength(1);
      expect(inbox[0].body).toContain(`acknowledged blocking hold ${h.id}`);
    });

    it('a message the agent already acknowledged is unchanged and logs nothing more', async () => {
      const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 23, reason: 'r' });
      const [item] = await readInbox(ctx, s.bob.id);
      ctx.setNow('2026-11-18T20:01:00.000Z');
      await ackMessage(ctx, s.bob.id, item.messageId, 'first');
      ctx.setNow('2026-11-18T20:02:00.000Z');
      await ackHold(ctx, s.bob.id, h.id, 'second');
      const row = await ctx.db
        .prepare(`SELECT acked_at, ack_note FROM message_recipients WHERE agent_id = ?`)
        .bind(s.bob.id)
        .first<{ acked_at: string; ack_note: string }>();
      expect(row).toEqual({ acked_at: '2026-11-18T20:01:00.000Z', ack_note: 'first' });
      expect(await messageAcks()).toHaveLength(1);
    });

    it('the advisory path, which releases, acknowledges the message too', async () => {
      const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 24, reason: 'consider', kind: 'advisory' });
      await ackHold(ctx, s.bob.id, h.id, 'squashed');
      expect(await takeAwaitingForStop(ctx, s.bob.id)).toEqual([]);
      expect(await messageAcks()).toHaveLength(1);
      expect(await readInbox(ctx, s.alice.id)).toHaveLength(1);
    });

    it('an admin force-acknowledgment does not touch message rows', async () => {
      const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 25, reason: 'r' });
      await adminAckHold(ctx, h.id, 'owner saw it');
      expect(await takeAwaitingForStop(ctx, s.bob.id)).toHaveLength(1);
      expect(await messageAcks()).toHaveLength(0);
    });

    for (const kind of ['blocking', 'advisory'] as const) {
      it(`a ${kind} acknowledgment that loses the race to a release changes nothing, message included`, async () => {
        const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 27, reason: 'r', kind });
        // A rival releases the hold after ackAs' pre-check and before its batch.
        const racing = {
          ...ctx,
          db: {
            prepare: (q: string) => ctx.db.prepare(q),
            batch: async (stmts: D1PreparedStatement[]) => {
              await ctx.db
                .prepare(`UPDATE holds SET state = 'released', released_at = ?, released_by = 'Alice', release_note = 'fixed' WHERE id = ?`)
                .bind(ctx.now(), h.id)
                .run();
              return ctx.db.batch(stmts);
            },
          } as unknown as D1Database,
        };
        await expect(ackHold(racing, s.bob.id, h.id, 'seen')).rejects.toMatchObject({ code: 'HOLD_CLOSED' });
        const row = await ctx.db
          .prepare(`SELECT acked_at FROM message_recipients WHERE agent_id = ?`)
          .bind(s.bob.id)
          .first<{ acked_at: string | null }>();
        expect(row!.acked_at).toBeNull();
        expect(await messageAcks()).toHaveLength(0);
        expect((await changesSince(ctx, s.project.id, 0)).filter((c) => c.kind === 'hold.acknowledged')).toHaveLength(0);
        expect(await readInbox(ctx, s.alice.id)).toHaveLength(0);
      });
    }

    it('a hold with no message (message_id NULL) still acknowledges fine', async () => {
      const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 26, reason: 'r' });
      await ctx.db.prepare(`UPDATE holds SET message_id = NULL WHERE id = ?`).bind(h.id).run();
      await ackHold(ctx, s.bob.id, h.id, 'seen');
      expect((await holdsFor(ctx, 'acme/app', 26))[0].acknowledged).toMatchObject({ by: 'Bob', note: 'seen' });
      expect(await messageAcks()).toHaveLength(0);
    });
  });

  it('a one-member project still gets the hold, with no message', async () => {
    await ctx.db.prepare(`DELETE FROM project_agents WHERE agent_id = ?`).bind(s.bob.id).run();
    const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 6, reason: 'r' });
    expect(h.blocksMerge).toBe(true);
    expect(h.message).toEqual({ delivered: 0, acknowledged: 0, recipients: 0 });
    const row = await ctx.db.prepare(`SELECT message_id FROM holds WHERE id = ?`).bind(h.id).first<{ message_id: number | null }>();
    expect(row!.message_id).toBeNull();
  });

  it('an explicit unknown notify target is refused and places nothing', async () => {
    await expect(placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 6, reason: 'r', notify: 'Zed' })).rejects.toMatchObject({
      code: 'UNKNOWN_RECIPIENT',
    });
    expect(await holdsFor(ctx, 'acme/app', 6)).toEqual([]);
  });

  it('notify can name one agent', async () => {
    const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 6, reason: 'r', notify: 'bob' });
    expect(h.message.recipients).toBe(1);
  });

  it('two concurrent releases: exactly one succeeds, the other gets HOLD_CLOSED naming the first', async () => {
    const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 1, reason: 'r' });
    const rs = await Promise.allSettled([releaseHold(ctx, s.alice.id, h.id, 'a'), adminReleaseHold(ctx, h.id, 'b')]);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((rs.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ kind: 'rule', code: 'HOLD_CLOSED' });
    const log = await changesSince(ctx, s.project.id, 0);
    expect(log.filter((c) => c.kind === 'hold.released')).toHaveLength(1);
  });

  it('the loser of a race that passed its preflight read gets HOLD_CLOSED from the conditional update', async () => {
    const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 1, reason: 'r' });
    ctx.setNow('2026-11-18T20:05:00.000Z');
    // Wrap the db so the winner commits right after the loser's preflight read of the hold.
    let armed = true;
    const real = ctx.db;
    const racing = {
      ...ctx,
      db: {
        prepare(sql: string) {
          const st = real.prepare(sql);
          if (!armed || !/^\s*SELECT/i.test(sql) || !/FROM holds/i.test(sql)) return st;
          return new Proxy(st, {
            get(t: any, p) {
              if (p === 'bind') {
                return (...a: unknown[]) =>
                  new Proxy(t.bind(...a), {
                    get(b: any, q) {
                      if (q === 'first') {
                        return async (...args: unknown[]) => {
                          const row = await b.first(...args);
                          if (armed) {
                            armed = false;
                            await adminReleaseHold(ctx, h.id, 'winner');
                          }
                          return row;
                        };
                      }
                      const v = b[q];
                      return typeof v === 'function' ? v.bind(b) : v;
                    },
                  });
              }
              const v = t[p];
              return typeof v === 'function' ? v.bind(t) : v;
            },
          });
        },
        batch: (stmts: D1PreparedStatement[]) => real.batch(stmts),
      } as unknown as D1Database,
    };
    await expect(releaseHold(racing, s.alice.id, h.id, 'loser')).rejects.toMatchObject({
      kind: 'rule',
      code: 'HOLD_CLOSED',
      message: `Hold ${h.id} was already released by admin at 2026-11-18T20:05:00.000Z.`,
    });
    expect(armed).toBe(false);
    const log = await changesSince(ctx, s.project.id, 0);
    expect(log.filter((c) => c.kind === 'hold.released')).toHaveLength(1);
  });

  it('an advisory ack racing a release: exactly one wins', async () => {
    const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 8, reason: 'r', kind: 'advisory' });
    const rs = await Promise.allSettled([ackHold(ctx, s.bob.id, h.id, 'done'), releaseHold(ctx, s.alice.id, h.id, 'withdrawn')]);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((rs.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ kind: 'rule', code: 'HOLD_CLOSED' });
    const [view] = await listHolds(ctx, s.alice.id, { state: 'all' });
    expect(view.state).toBe('released');
    const log = await changesSince(ctx, s.project.id, 0);
    expect(log.filter((c) => c.kind === 'hold.released')).toHaveLength(1);
    // the loser leaves no acknowledgment entry or placer notice behind
    expect(log.filter((c) => c.kind === 'hold.acknowledged')).toHaveLength(view.released!.by === 'Bob' ? 1 : 0);
  });

  it('refuses to acknowledge or release a closed hold, naming who closed it', async () => {
    const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 9, reason: 'r' });
    ctx.setNow('2026-11-18T21:00:00.000Z');
    await releaseHold(ctx, s.alice.id, h.id, 'done');
    await expect(ackHold(ctx, s.bob.id, h.id, 'n')).rejects.toMatchObject({
      code: 'HOLD_CLOSED',
      message: `Hold ${h.id} was already released by Alice at 2026-11-18T21:00:00.000Z.`,
    });
    await expect(releaseHold(ctx, s.alice.id, h.id, 'again')).rejects.toMatchObject({ code: 'HOLD_CLOSED' });
    await expect(adminAckHold(ctx, h.id, 'n')).rejects.toMatchObject({ code: 'HOLD_CLOSED' });
  });

  it('holdsFor reports to an agent outside the project, case-insensitively', async () => {
    await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 7, reason: 'r' });
    const views = await holdsFor(ctx, 'ACME/App', 7);
    expect(views).toHaveLength(1);
    expect(views[0].blocksMerge).toBe(true);
    // Carol (project `other`) cannot list it, but holdsFor needs no membership.
    expect(await listHolds(ctx, s.carol.id, { state: 'all' })).toEqual([]);
    expect(await holdsFor(ctx, 'acme/unknown', 7)).toEqual([]);
  });

  it('listHolds filters by project and state and checks membership', async () => {
    const a = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 1, reason: 'r' });
    await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 2, reason: 'r' });
    await releaseHold(ctx, s.alice.id, a.id, 'done');
    expect(await listHolds(ctx, s.bob.id, { projectId: s.project.id })).toHaveLength(1);
    expect(await listHolds(ctx, s.bob.id, { projectId: s.project.id, state: 'all' })).toHaveLength(2);
    await expect(listHolds(ctx, s.carol.id, { projectId: s.project.id })).rejects.toMatchObject({ code: 'NOT_MEMBER' });
  });

  it('the change listener is called with repo id and PR on place, ack and release', async () => {
    const fn = vi.fn(async (..._a: unknown[]) => {});
    setHoldChangeListener(fn);
    const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 11, reason: 'r' });
    await ackHold(ctx, s.bob.id, h.id, 'n');
    await releaseHold(ctx, s.alice.id, h.id, 'done');
    expect(fn).toHaveBeenCalledTimes(3);
    for (const call of fn.mock.calls) expect(call.slice(1)).toEqual([s.repo.id, 11]);
  });

  it('a failing change listener does not fail a committed hold change', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    setHoldChangeListener(async () => {
      throw new Error('boom');
    });
    const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 12, reason: 'r' });
    expect(h.state).toBe('open');
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('logs placement, acknowledgment and release in the change log', async () => {
    const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 13, reason: 'r' });
    await ackHold(ctx, s.bob.id, h.id, 'n');
    await releaseHold(ctx, s.alice.id, h.id, 'done');
    const log = (await changesSince(ctx, s.project.id, 0)).filter((c) => c.kind.startsWith('hold.'));
    expect(log.map((c) => [c.kind, c.actor, c.subjectId])).toEqual([
      ['hold.placed', 'Alice', h.id],
      ['hold.acknowledged', 'Bob', h.id],
      ['hold.released', 'Alice', h.id],
    ]);
  });

  it('a failure while storing the hold message rolls the whole placement back', async () => {
    const fn = vi.fn(async (..._a: unknown[]) => {});
    setHoldChangeListener(fn);
    await ctx.db.prepare(`CREATE TRIGGER fail_recipients BEFORE INSERT ON message_recipients BEGIN SELECT RAISE(ABORT, 'boom'); END`).run();
    try {
      await expect(placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 14, reason: 'r' })).rejects.toBeDefined();
    } finally {
      await ctx.db.prepare(`DROP TRIGGER fail_recipients`).run();
    }
    expect(await holdsFor(ctx, 'acme/app', 14)).toEqual([]);
    expect((await ctx.db.prepare(`SELECT COUNT(*) AS n FROM holds`).first<{ n: number }>())!.n).toBe(0);
    expect((await ctx.db.prepare(`SELECT COUNT(*) AS n FROM messages`).first<{ n: number }>())!.n).toBe(0);
    expect(fn).not.toHaveBeenCalled();
  });

  it('links the hold to its message and logs the message send', async () => {
    const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 15, reason: 'r', kind: 'advisory' });
    const row = await ctx.db.prepare(`SELECT message_id FROM holds WHERE id = ?`).bind(h.id).first<{ message_id: number }>();
    const m = await ctx.db.prepare(`SELECT ref_id, kind, body FROM messages WHERE id = ?`).bind(row!.message_id).first<{ ref_id: number; kind: string; body: string }>();
    expect(m).toMatchObject({ ref_id: h.id, kind: 'hold' });
    expect(m!.body).toContain(`hold_id=${h.id},`);
    const log = await changesSince(ctx, s.project.id, 0);
    expect(log.map((c) => c.kind)).toEqual(['hold.placed', 'message.sent']);
    expect(log[1].subjectId).toBe(row!.message_id);
  });
});
