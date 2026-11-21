import { beforeEach, describe, expect, it } from 'vitest';
import {
  adminApprove,
  approvalsHook,
  approveMerge,
  mergeDecision,
  objectMerge,
  pendingApprovals,
  registerApprovals,
  windowEdgesBetween,
} from '../src/domain/approvals';
import { addEvent, cancelEvent, daySchedule, listEvents, loadEvent, recordMerge, setEventApprovalsHook, updateEvent } from '../src/domain/calendar';
import { changesSince } from '../src/domain/changelog';
import { placeHold, releaseHold } from '../src/domain/holds';
import { readInbox } from '../src/domain/messages';
import { scheduleFragment } from '../src/admin/views';
import { env } from 'cloudflare:test';
import { seedApprovals, testCtx } from './helpers';

const ctx = testCtx();
let s: Awaited<ReturnType<typeof seedApprovals>>;
let projectId: number;
const SLOT = '2026-11-18T21:00:00-06:00'; // 2026-11-19T03:00:00Z
const SLOT_UTC = '2026-11-19T03:00:00.000Z';

beforeEach(async () => {
  ctx.setNow('2026-11-18T20:00:00.000Z');
  s = await seedApprovals(ctx);
  projectId = s.project.id;
  registerApprovals(); // other test files clear the calendar hooks
});

const schedule = (input: { pr?: number; startsAt?: string; approvers?: string[] } = {}) =>
  addEvent(ctx, s.bobA, {
    projectId,
    title: 'm',
    startsAt: input.startsAt ?? SLOT,
    kind: 'merge',
    repo: 'acme/app',
    pr: input.pr ?? 709,
    approvers: input.approvers,
  });

const approverRows = (eventId: number) =>
  ctx.db
    .prepare(
      `SELECT a.name, ea.response, ea.responded_by, ea.approved_for_starts_at, ea.request_message_id, ea.objection_hold_id
       FROM event_approvers ea JOIN agents a ON a.id = ea.agent_id WHERE ea.event_id = ? ORDER BY a.name`,
    )
    .bind(eventId)
    .all<{
      name: string; response: string | null; responded_by: string | null; approved_for_starts_at: string | null;
      request_message_id: number | null; objection_hold_id: number | null;
    }>()
    .then((r) => r.results);

const requestMessages = (eventId: number) =>
  ctx.db
    .prepare(
      `SELECT m.id, m.body, m.escalate_at, m.requires_ack, m.withdrawn_at, m.created_at, r.acked_at, r.acked_by, a.name AS recipient
       FROM messages m JOIN message_recipients r ON r.message_id = m.id JOIN agents a ON a.id = r.agent_id
       WHERE m.kind = 'approval_request' AND m.ref_id = ? ORDER BY m.id`,
    )
    .bind(eventId)
    .all<{
      id: number; body: string; escalate_at: string | null; requires_ack: number; withdrawn_at: string | null; created_at: string;
      acked_at: string | null; acked_by: string | null; recipient: string;
    }>()
    .then((r) => r.results);

const logged = (kind: string) => changesSince(ctx, projectId, 0).then((c) => c.filter((x) => x.kind === kind));

/** A merge event straight into the table, with no event_approvers rows (as if the hook's batch failed). */
async function bareMergeEvent(startsAt: string, pr = 709): Promise<number> {
  const row = await ctx.db
    .prepare(
      `INSERT INTO events (project_id, title, starts_at, entered_as, importance, kind, repo_id, pr_number, merger_agent_id, created_by, updated_at)
       VALUES (?, 'bare', ?, ?, 'normal', 'merge', ?, ?, ?, 'Bob', ?) RETURNING id`,
    )
    .bind(projectId, startsAt, startsAt, s.repo.id, pr, s.bob.id, ctx.now())
    .first<{ id: number }>();
  return row!.id;
}

describe('merge decision', () => {
  it('an unscheduled merge is refused with no_slot', async () => {
    const d = await mergeDecision(ctx, 'acme/app', 709);
    expect(d.blocks).toEqual([{ kind: 'no_slot' }]);
    expect(d).toMatchObject({ gated: true, allowed: false, eventId: null });
  });

  it('the merge is refused until every approver approves, then allowed inside the window', async () => {
    const e = await schedule();
    ctx.setNow('2026-11-19T03:00:00.000Z');
    const before = await mergeDecision(ctx, 'acme/app', 709);
    expect(before.blocks[0]).toMatchObject({ kind: 'approval_missing', missing: ['Alice'], eventId: e.id, startsAt: SLOT_UTC });
    expect(before).toMatchObject({ allowed: false, eventId: e.id });
    await approveMerge(ctx, s.alice.id, e.id);
    const after = await mergeDecision(ctx, 'acme/app', 709);
    expect(after).toEqual({ gated: true, allowed: true, blocks: [], eventId: e.id });
  });

  it.each([
    ['2026-11-19T02:30:00.000Z', true],
    ['2026-11-19T03:30:00.000Z', true],
    ['2026-11-19T03:30:01.000Z', false],
    ['2026-11-19T02:29:59.000Z', false],
  ])('window edge at %s → allowed %s', async (now, allowed) => {
    const e = await schedule();
    await approveMerge(ctx, s.alice.id, e.id); // approved ahead of the window, at 20:00Z
    ctx.setNow(now);
    const d = await mergeDecision(ctx, 'acme/app', 709);
    expect(d.allowed).toBe(allowed);
    expect(d.eventId).toBe(e.id);
    if (allowed) expect(d.blocks).toEqual([]);
    else
      expect(d.blocks).toEqual([
        { kind: 'outside_window', eventId: e.id, startsAt: SLOT_UTC, windowStart: '2026-11-19T02:30:00.000Z', windowEnd: '2026-11-19T03:30:00.000Z' },
      ]);
  });

  it('window edges are compared as instants, not strings, when a stored time has no milliseconds', async () => {
    const id = await bareMergeEvent('2026-11-19T03:00:00Z');
    await ctx.db
      .prepare(
        `INSERT INTO event_approvers (event_id, agent_id, response, responded_at, responded_by, approved_for_starts_at)
         VALUES (?, ?, 'approved', ?, 'Alice', '2026-11-19T03:00:00.000Z')`,
      )
      .bind(id, s.alice.id, ctx.now())
      .run();
    ctx.setNow('2026-11-19T03:30:00.000Z');
    expect(await mergeDecision(ctx, 'acme/app', 709)).toEqual({ gated: true, allowed: true, blocks: [], eventId: id });
    ctx.setNow('2026-11-19T02:30:00.000Z');
    expect((await mergeDecision(ctx, 'acme/app', 709)).allowed).toBe(true);
    ctx.setNow('2026-11-19T03:30:00.001Z');
    expect((await mergeDecision(ctx, 'acme/app', 709)).blocks).toMatchObject([{ kind: 'outside_window', eventId: id }]);
  });

  it('uses the project approval window setting', async () => {
    await ctx.db.prepare(`UPDATE projects SET approval_window_min = 10 WHERE id = ?`).bind(projectId).run();
    const e = await schedule();
    await approveMerge(ctx, s.alice.id, e.id);
    ctx.setNow('2026-11-19T03:10:00.000Z');
    expect((await mergeDecision(ctx, 'acme/app', 709)).allowed).toBe(true);
    ctx.setNow('2026-11-19T03:10:01.000Z');
    expect((await mergeDecision(ctx, 'acme/app', 709)).blocks).toMatchObject([
      { kind: 'outside_window', windowStart: '2026-11-19T02:50:00.000Z', windowEnd: '2026-11-19T03:10:00.000Z' },
    ]);
  });

  it('a merge event with no approver rows is never treated as approved', async () => {
    const id = await bareMergeEvent(SLOT_UTC);
    ctx.setNow(SLOT_UTC);
    const d = await mergeDecision(ctx, 'acme/app', 709);
    expect(d).toEqual({
      gated: true,
      allowed: false,
      blocks: [{ kind: 'approval_missing', eventId: id, startsAt: SLOT_UTC, missing: [] }],
      eventId: id,
    });
  });

  it('an unregistered repository is not gated', async () => {
    expect(await mergeDecision(ctx, 'Nobody/Else', 1)).toEqual({ gated: false, allowed: true, blocks: [], eventId: null });
  });

  it('normalizes the repository name before deciding', async () => {
    const e = await schedule();
    await approveMerge(ctx, s.alice.id, e.id);
    ctx.setNow(SLOT_UTC);
    expect(await mergeDecision(ctx, ' Acme/App ', 709)).toEqual({ gated: true, allowed: true, blocks: [], eventId: e.id });
  });

  it('outside every window, the event nearest now is reported; inside one, that event is chosen', async () => {
    const early = await schedule({ startsAt: '2026-11-19T01:00:00Z' });
    const late = await schedule({ startsAt: '2026-11-19T05:00:00Z' });
    ctx.setNow('2026-11-19T02:59:00.000Z'); // nearer to 01:00 + window than to 05:00
    expect((await mergeDecision(ctx, 'acme/app', 709)).blocks).toMatchObject([{ kind: 'outside_window', eventId: early.id }]);
    ctx.setNow('2026-11-19T03:01:00.000Z');
    expect((await mergeDecision(ctx, 'acme/app', 709)).blocks).toMatchObject([{ kind: 'outside_window', eventId: late.id }]);
    await approveMerge(ctx, s.alice.id, late.id);
    ctx.setNow('2026-11-19T04:45:00.000Z');
    expect(await mergeDecision(ctx, 'acme/app', 709)).toEqual({ gated: true, allowed: true, blocks: [], eventId: late.id });
  });

  it('cancelled and merged events are not candidates', async () => {
    const e = await schedule();
    await approveMerge(ctx, s.alice.id, e.id);
    await cancelEvent(ctx, s.bobA, e.id);
    ctx.setNow(SLOT_UTC);
    expect((await mergeDecision(ctx, 'acme/app', 709)).blocks).toEqual([{ kind: 'no_slot' }]);
  });

  it('an approval survives a new commit (decision has no commit input) but not a move', async () => {
    const e = await schedule();
    await approveMerge(ctx, s.alice.id, e.id);
    ctx.setNow(SLOT_UTC);
    expect((await mergeDecision(ctx, 'acme/app', 709)).allowed).toBe(true);
    // A new commit changes nothing Echo sees; a title change is not a move either.
    await updateEvent(ctx, s.bobA, e.id, { title: 'rebased onto main' });
    expect((await mergeDecision(ctx, 'acme/app', 709)).allowed).toBe(true);

    const [oldRequest] = await requestMessages(e.id);
    ctx.setNow('2026-11-19T02:00:00.000Z');
    await updateEvent(ctx, s.bobA, e.id, { startsAt: '2026-11-18T22:00:00-06:00' });
    ctx.setNow('2026-11-19T04:00:00.000Z');
    expect((await mergeDecision(ctx, 'acme/app', 709)).blocks).toEqual([
      { kind: 'approval_missing', eventId: e.id, startsAt: '2026-11-19T04:00:00.000Z', missing: ['Alice'] },
    ]);
    expect(await approverRows(e.id)).toMatchObject([{ name: 'Alice', response: null, responded_by: null, approved_for_starts_at: null }]);
    const msgs = await requestMessages(e.id);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ id: oldRequest.id, acked_by: 'Alice' }); // the answered request stays as history
    expect(msgs[1].body).toBe(
      `APPROVAL REQUESTED: Bob plans to merge acme/app#709 at 2026-11-19T04:00:00Z. Approve with echo_approve_merge (event_id=${e.id}) or object with echo_object_merge.`,
    );
    expect(msgs[1]).toMatchObject({ acked_at: null, withdrawn_at: null, recipient: 'Alice' });
    expect((await approverRows(e.id))[0].request_message_id).toBe(msgs[1].id);
    expect(await logged('approval.cleared')).toHaveLength(1);
    await approveMerge(ctx, s.alice.id, e.id);
    expect((await approverRows(e.id))[0].approved_for_starts_at).toBe('2026-11-19T04:00:00.000Z');
    expect((await mergeDecision(ctx, 'acme/app', 709)).allowed).toBe(true);
  });

  it.each([
    ['onMove throws', async () => {
      throw new Error('D1 unavailable');
    }],
    ['its batch fails', async (c: typeof ctx, ev: Parameters<typeof approvalsHook.onMove>[1]) => [
      ...(await approvalsHook.onMove(c, ev)),
      c.db.prepare(`INSERT INTO no_such_table VALUES (1)`),
    ]],
  ])('a move whose approval changes cannot be written does not happen (%s)', async (_label, onMove) => {
    const e = await schedule();
    await approveMerge(ctx, s.alice.id, e.id);
    setEventApprovalsHook({ ...approvalsHook, onMove: onMove as typeof approvalsHook.onMove });
    await expect(updateEvent(ctx, s.bobA, e.id, { startsAt: '2026-11-18T22:00:00-06:00' })).rejects.toThrow();
    // Nothing of the move committed: the event, its approval and its single request are as before.
    expect((await loadEvent(ctx, e.id)).startsAt).toBe(SLOT_UTC);
    expect(await approverRows(e.id)).toMatchObject([{ response: 'approved', approved_for_starts_at: SLOT_UTC }]);
    expect(await requestMessages(e.id)).toHaveLength(1);
    expect(await logged('event.moved')).toHaveLength(0);
    // The merge is refused at the time the move asked for, and still allowed only in the approved slot.
    ctx.setNow('2026-11-19T04:00:00.000Z');
    expect((await mergeDecision(ctx, 'acme/app', 709)).blocks).toMatchObject([{ kind: 'outside_window', eventId: e.id }]);
    ctx.setNow(SLOT_UTC);
    expect((await mergeDecision(ctx, 'acme/app', 709)).allowed).toBe(true);
  });

  it('an approval counts only for the start time it was given for', async () => {
    const e = await schedule();
    await approveMerge(ctx, s.alice.id, e.id);
    expect((await approverRows(e.id))[0].approved_for_starts_at).toBe(SLOT_UTC);
    // The event's time changes without the move's clearing (as if that had been skipped).
    await ctx.db.prepare(`UPDATE events SET starts_at = '2026-11-19T04:00:00.000Z' WHERE id = ?`).bind(e.id).run();
    ctx.setNow('2026-11-19T04:00:00.000Z');
    expect((await mergeDecision(ctx, 'acme/app', 709)).blocks).toEqual([
      { kind: 'approval_missing', eventId: e.id, startsAt: '2026-11-19T04:00:00.000Z', missing: ['Alice'] },
    ]);
    const DAY = ['2026-11-19T00:00:00Z', '2026-11-20T00:00:00Z'] as const;
    expect((await daySchedule(ctx, projectId, ...DAY))[0]).toMatchObject({ status: 'waiting_approval', approvers: [{ name: 'Alice', response: null }] });
    // Approving again is not mistaken for a repeat: it records the approval for the new start.
    await approveMerge(ctx, s.alice.id, e.id);
    expect((await approverRows(e.id))[0].approved_for_starts_at).toBe('2026-11-19T04:00:00.000Z');
    expect((await mergeDecision(ctx, 'acme/app', 709)).allowed).toBe(true);
  });

  it('a move withdraws unanswered requests and sends one fresh request each', async () => {
    const e = await schedule();
    await updateEvent(ctx, s.bobA, e.id, { startsAt: '2026-11-18T22:00:00-06:00' });
    const msgs = await requestMessages(e.id);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].withdrawn_at).toBe(ctx.now());
    expect(msgs[1].withdrawn_at).toBeNull();
    const inbox = await readInbox(ctx, s.alice.id);
    expect(inbox.map((i) => i.messageId)).toEqual([msgs[1].id]);
    expect(await logged('message.withdrawn')).toHaveLength(1);
  });

  it('a move re-creates approvers when the event had none', async () => {
    const id = await bareMergeEvent(SLOT_UTC);
    await updateEvent(ctx, s.bobA, id, { startsAt: '2026-11-18T22:00:00-06:00' });
    const rows = await approverRows(id);
    expect(rows).toMatchObject([{ name: 'Alice', response: null }]);
    const msgs = await requestMessages(id);
    expect(msgs).toHaveLength(1);
    expect(rows[0].request_message_id).toBe(msgs[0].id);
  });

  it('cancelling the event withdraws its unanswered approval requests', async () => {
    const e = await schedule();
    expect((await readInbox(ctx, s.alice.id)).filter((i) => i.kind === 'approval_request')).toHaveLength(1);
    await cancelEvent(ctx, s.bobA, e.id);
    expect(await readInbox(ctx, s.alice.id)).toEqual([]);
    expect((await requestMessages(e.id))[0].withdrawn_at).toBe(ctx.now());
    expect(await logged('message.withdrawn')).toHaveLength(1);
    expect(await pendingApprovals(ctx, s.alice.id)).toEqual([]);
  });

  it('a refused cancel of a merged event changes no rows and writes no change_log', async () => {
    const e = await schedule();
    await recordMerge(ctx, s.bobA, { repo: 'acme/app', pr: 709, mergedAt: '2026-11-18T20:01:00Z', source: 'hook' });
    const before = await changesSince(ctx, projectId, 0);
    const msgsBefore = await requestMessages(e.id);
    expect(msgsBefore[0].withdrawn_at).toBeNull(); // the merge left the request unanswered
    ctx.setNow('2026-11-18T20:02:00.000Z');
    await expect(cancelEvent(ctx, s.bobA, e.id)).rejects.toMatchObject({ kind: 'rule', code: 'EVENT_CLOSED' });
    expect(await requestMessages(e.id)).toEqual(msgsBefore);
    expect(await changesSince(ctx, projectId, 0)).toEqual(before);
    expect((await readInbox(ctx, s.alice.id)).filter((i) => i.kind === 'approval_request')).toHaveLength(1);
  });

  it('an objection becomes a blocking hold by the objector and blocks the merge', async () => {
    const e = await schedule();
    await objectMerge(ctx, s.alice.id, e.id, 'tests are flaky');
    const [row] = await approverRows(e.id);
    expect(row).toMatchObject({ name: 'Alice', response: 'objected', responded_by: 'Alice' });
    expect(row.objection_hold_id).not.toBeNull();
    const [req] = await requestMessages(e.id);
    expect(req).toMatchObject({ acked_by: 'Alice' });
    expect(req.acked_at).not.toBeNull();

    ctx.setNow(SLOT_UTC);
    const d = await mergeDecision(ctx, 'acme/app', 709);
    expect(d.allowed).toBe(false);
    // Reported once, as the hold; not again as a missing approval.
    expect(d.blocks).toHaveLength(1);
    expect(d.blocks[0]).toMatchObject({
      kind: 'hold',
      hold: {
        id: row.objection_hold_id,
        placedBy: 'Alice',
        kind: 'blocking',
        blocksMerge: true,
        reason: `Objection to the 2026-11-19T03:00:00Z merge slot: tests are flaky`,
      },
    });
    expect(await logged('approval.objected')).toHaveLength(1);

    // While the objection hold is open, the objector cannot turn it into an approval.
    await expect(approveMerge(ctx, s.alice.id, e.id)).rejects.toMatchObject({ kind: 'rule', code: 'OBJECTION_OPEN' });
    await releaseHold(ctx, s.alice.id, row.objection_hold_id!, 'flake fixed');
    // Released objection, no approval yet: still blocked, now as a missing approval.
    expect((await mergeDecision(ctx, 'acme/app', 709)).blocks).toEqual([
      { kind: 'approval_missing', eventId: e.id, startsAt: SLOT_UTC, missing: ['Alice'] },
    ]);
    await approveMerge(ctx, s.alice.id, e.id);
    expect((await mergeDecision(ctx, 'acme/app', 709)).allowed).toBe(true);
  });

  it('an objection hold stays open across a move', async () => {
    const e = await schedule();
    await objectMerge(ctx, s.alice.id, e.id, 'no');
    const [before] = await approverRows(e.id);
    await updateEvent(ctx, s.bobA, e.id, { startsAt: '2026-11-18T22:00:00-06:00' });
    expect(await approverRows(e.id)).toMatchObject([{ response: null, objection_hold_id: null }]);
    await approveMerge(ctx, s.alice.id, e.id);
    ctx.setNow('2026-11-19T04:00:00.000Z');
    const d = await mergeDecision(ctx, 'acme/app', 709);
    expect(d.blocks).toMatchObject([{ kind: 'hold', hold: { id: before.objection_hold_id } }]);
  });

  it('objecting needs a reason', async () => {
    const e = await schedule();
    await expect(objectMerge(ctx, s.alice.id, e.id, '  ')).rejects.toMatchObject({ kind: 'rule', code: 'REASON_REQUIRED' });
    expect(await approverRows(e.id)).toMatchObject([{ response: null }]);
  });

  it('the approval request shows the slot time once, as UTC without milliseconds', async () => {
    const e = await schedule();
    const [m] = await requestMessages(e.id);
    expect(m.body.split('2026-11-19T03:00:00Z')).toHaveLength(2); // exactly once
    expect(m.body).not.toContain('.000Z');
    expect(m.body).not.toContain('-06:00');
  });

  describe('calendar results carry the approval block', () => {
    const list = () => listEvents(ctx, s.aliceA, { projectId, from: '2026-11-19T00:00:00Z', to: '2026-11-20T00:00:00Z' });
    const windowOf = { windowStart: '2026-11-19T02:30:00Z', windowEnd: '2026-11-19T03:30:00Z' };

    it('the list for an approved slot names the approver, approved, and when', async () => {
      const e = await schedule();
      ctx.setNow('2026-11-18T20:05:00.000Z');
      await approveMerge(ctx, s.alice.id, e.id);
      const [ev] = (await list()) as any[];
      expect(ev).toMatchObject({ id: e.id, kind: 'merge', title: 'm', approvalRequired: true, ...windowOf });
      expect(ev.approvers).toEqual([{ name: 'Alice', response: 'approved', at: '2026-11-18T20:05:00Z', by: 'Alice' }]);
    });

    it('an unanswered approver shows null response, at and by', async () => {
      await schedule();
      const [ev] = (await list()) as any[];
      expect(ev.approvers).toEqual([{ name: 'Alice', response: null, at: null, by: null }]);
    });

    it('approve-for shows by admin', async () => {
      const e = await schedule();
      await adminApprove(ctx, e.id, 'Alice');
      const [ev] = (await list()) as any[];
      expect(ev.approvers).toEqual([{ name: 'Alice', response: 'approved', at: '2026-11-18T20:00:00Z', by: 'admin' }]);
    });

    it('an objection shows objected and the hold id', async () => {
      const e = await schedule();
      await objectMerge(ctx, s.alice.id, e.id, 'tests are flaky');
      const [ev] = (await list()) as any[];
      const [hold] = await ctx.db.prepare(`SELECT id FROM holds ORDER BY id DESC LIMIT 1`).all<{ id: number }>().then((r) => r.results);
      expect(ev.approvers).toEqual([{ name: 'Alice', response: 'objected', at: '2026-11-18T20:00:00Z', by: 'Alice', holdId: hold.id }]);
    });

    it('the day schedule carries the same block, for merged slots too', async () => {
      const e = await schedule();
      await approveMerge(ctx, s.alice.id, e.id);
      const [row] = await daySchedule(ctx, projectId, '2026-11-19T00:00:00Z', '2026-11-20T00:00:00Z');
      expect(row).toMatchObject({ status: 'approved', approvalRequired: true, ...windowOf });
      expect(row.approvers).toEqual([{ name: 'Alice', response: 'approved', at: '2026-11-18T20:00:00Z', by: 'Alice' }]);
      ctx.setNow('2026-11-19T03:05:00.000Z');
      await recordMerge(ctx, s.bobA, { repo: 'acme/app', pr: 709, mergedAt: '2026-11-19T03:05:00Z', source: 'hook' });
      const [done] = await daySchedule(ctx, projectId, '2026-11-19T00:00:00Z', '2026-11-20T00:00:00Z');
      expect(done).toMatchObject({ status: 'merged', approvalRequired: true });
      expect(done.approvers).toMatchObject([{ name: 'Alice', response: 'approved' }]);
    });

    it('a slot with approvals off shows approvalRequired false and no approvers', async () => {
      await schedule();
      await ctx.db.prepare(`UPDATE projects SET approvals_required = 0 WHERE id = ?`).bind(projectId).run();
      const [ev] = (await list()) as any[];
      expect(ev).toMatchObject({ approvalRequired: false, approvers: [] });
      expect(ev).not.toHaveProperty('windowStart');
    });

    it('a non-merge event has no approval block', async () => {
      await addEvent(ctx, s.bobA, { projectId, title: 'Freeze', startsAt: SLOT });
      const [ev] = (await list()) as any[];
      expect(ev).not.toHaveProperty('approvalRequired');
      expect(ev).not.toHaveProperty('approvers');
    });

    it('reads the approver rows in one query for all merge events', async () => {
      await schedule({ pr: 1 });
      await schedule({ pr: 2 });
      await schedule({ pr: 3 });
      let reads = 0;
      const counting = {
        ...ctx,
        db: {
          prepare: (q: string) => {
            if (/FROM event_approvers/.test(q) && !/^\s*(UPDATE|INSERT)/.test(q)) reads++;
            return ctx.db.prepare(q);
          },
          batch: (st: D1PreparedStatement[]) => ctx.db.batch(st),
        } as unknown as D1Database,
      };
      expect(await listEvents(counting, s.aliceA, { projectId, from: '2026-11-19T00:00:00Z', to: '2026-11-20T00:00:00Z' })).toHaveLength(3);
      expect(reads).toBe(1);
    });
  });

  it('approval requests escalate at min(sent + 30 min, slot)', async () => {
    // Sent at 20:00Z for a 03:00Z slot: escalates 30 minutes after sending.
    const far = await schedule();
    const [m1] = await requestMessages(far.id);
    expect(m1).toMatchObject({ requires_ack: 1, recipient: 'Alice', escalate_at: '2026-11-18T20:30:00.000Z' });
    expect(m1.body).toBe(
      `APPROVAL REQUESTED: Bob plans to merge acme/app#709 at 2026-11-19T03:00:00Z. Approve with echo_approve_merge (event_id=${far.id}) or object with echo_object_merge.`,
    );
    // Sent ten minutes before the slot: escalates at the slot.
    ctx.setNow('2026-11-19T02:50:00.000Z');
    const near = await schedule({ pr: 710 });
    expect((await requestMessages(near.id))[0].escalate_at).toBe(SLOT_UTC);
    // A slot already in the past escalates now, never before the message exists.
    const past = await schedule({ pr: 711, startsAt: '2026-11-19T02:40:00Z' });
    expect((await requestMessages(past.id))[0].escalate_at).toBe('2026-11-19T02:50:00.000Z');
    expect(await logged('approval.requested')).toHaveLength(3);
  });

  it('projects without approvals: only holds block, unscheduled merges allowed', async () => {
    await ctx.db.prepare(`UPDATE projects SET approvals_required = 0 WHERE id = ?`).bind(projectId).run();
    expect(await mergeDecision(ctx, 'acme/app', 709)).toEqual({ gated: true, allowed: true, blocks: [], eventId: null });
    const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 709, reason: 'wait' });
    const d = await mergeDecision(ctx, 'acme/app', 709);
    expect(d).toMatchObject({ gated: true, allowed: false });
    expect(d.blocks).toMatchObject([{ kind: 'hold', hold: { id: h.id } }]);
    // No approval requests are sent for a merge event in such a project.
    const e = await schedule({ pr: 800 });
    expect(await approverRows(e.id)).toEqual([]);
    expect(await mergeDecision(ctx, 'acme/app', 800)).toMatchObject({ allowed: true, blocks: [] });
  });

  it('admin approval records responded_by admin', async () => {
    const e = await schedule();
    await adminApprove(ctx, e.id, 'Alice');
    expect(await approverRows(e.id)).toMatchObject([{ name: 'Alice', response: 'approved', responded_by: 'admin' }]);
    expect((await requestMessages(e.id))[0]).toMatchObject({ acked_by: 'admin' });
    const [entry] = await logged('approval.approved');
    expect(entry.actor).toBe('admin');
    ctx.setNow(SLOT_UTC);
    expect((await mergeDecision(ctx, 'acme/app', 709)).allowed).toBe(true);
    await expect(adminApprove(ctx, e.id, 'Carol')).rejects.toMatchObject({ code: 'NOT_APPROVER' });
  });
});

describe('approving', () => {
  it('only a listed approver may approve', async () => {
    const e = await schedule();
    await expect(approveMerge(ctx, s.bob.id, e.id)).rejects.toMatchObject({ kind: 'rule', code: 'NOT_APPROVER' });
    await expect(approveMerge(ctx, s.carol.id, e.id)).rejects.toMatchObject({ kind: 'rule', code: 'NOT_APPROVER' });
  });

  it('approving twice is a quiet success', async () => {
    const e = await schedule();
    await approveMerge(ctx, s.alice.id, e.id);
    await approveMerge(ctx, s.alice.id, e.id);
    expect(await approverRows(e.id)).toMatchObject([{ response: 'approved', responded_by: 'Alice' }]);
    expect(await logged('approval.approved')).toHaveLength(1);
    expect((await requestMessages(e.id))[0]).toMatchObject({ acked_by: 'Alice' });
  });

  it('is refused once the window has closed, and for a cancelled or merged event', async () => {
    const e = await schedule();
    ctx.setNow('2026-11-19T03:30:00.000Z');
    await approveMerge(ctx, s.alice.id, e.id); // still inside, at the edge
    const late = await schedule({ pr: 710 });
    ctx.setNow('2026-11-19T03:30:01.000Z');
    await expect(approveMerge(ctx, s.alice.id, late.id)).rejects.toMatchObject({ kind: 'rule', code: 'WINDOW_CLOSED' });

    ctx.setNow('2026-11-18T20:00:00.000Z');
    const c = await schedule({ pr: 711 });
    await cancelEvent(ctx, s.bobA, c.id);
    await expect(approveMerge(ctx, s.alice.id, c.id)).rejects.toMatchObject({ kind: 'rule', code: 'EVENT_CLOSED' });
    const m = await schedule({ pr: 712 });
    await recordMerge(ctx, s.bobA, { repo: 'acme/app', pr: 712, mergedAt: '2026-11-18T20:01:00Z', source: 'hook' });
    await expect(approveMerge(ctx, s.alice.id, m.id)).rejects.toMatchObject({ kind: 'rule', code: 'EVENT_CLOSED' });
    await expect(approveMerge(ctx, s.alice.id, 99999)).rejects.toMatchObject({ kind: 'rule', code: 'EVENT_NOT_FOUND' });
  });

  it('named approvers replace the default, and must be other project members', async () => {
    await ctx.db.prepare(`INSERT INTO project_agents (project_id, agent_id) VALUES (?, ?)`).bind(projectId, s.carol.id).run();
    const e = await schedule({ approvers: ['carol'] });
    expect((await approverRows(e.id)).map((r) => r.name)).toEqual(['Carol']);
    const d = await schedule({ pr: 710 });
    expect((await approverRows(d.id)).map((r) => r.name)).toEqual(['Alice', 'Carol']);
    await expect(schedule({ pr: 711, approvers: ['Zed'] })).rejects.toMatchObject({ kind: 'rule', code: 'UNKNOWN_APPROVER' });
    await expect(schedule({ pr: 712, approvers: ['Bob'] })).rejects.toMatchObject({ kind: 'rule', code: 'APPROVER_IS_MERGER' });
    // A refused event does not stay on the calendar as an open slot.
    ctx.setNow('2026-11-19T03:00:00.000Z');
    expect((await mergeDecision(ctx, 'acme/app', 711)).blocks).toEqual([{ kind: 'no_slot' }]);
  });

  it('a refused approval request leaves no event, cancelled or not, and no log entries', async () => {
    const before = await changesSince(ctx, projectId, 0);
    const events = () => ctx.db.prepare(`SELECT COUNT(*) AS n FROM events`).first<{ n: number }>().then((r) => r!.n);
    await expect(schedule({ approvers: ['Zed'] })).rejects.toMatchObject({ code: 'UNKNOWN_APPROVER' });
    await expect(schedule({ approvers: ['Bob'] })).rejects.toMatchObject({ code: 'APPROVER_IS_MERGER' });
    await ctx.db.prepare(`DELETE FROM project_agents WHERE project_id = ? AND agent_id = ?`).bind(projectId, s.alice.id).run();
    await expect(schedule()).rejects.toMatchObject({ code: 'NO_APPROVERS' });
    // The owner naming a merger is checked the same way.
    await expect(
      addEvent(ctx, { kind: 'admin' }, { projectId, title: 'm', startsAt: SLOT, kind: 'merge', repo: 'acme/app', pr: 709, merger: 'Bob' }),
    ).rejects.toMatchObject({ code: 'NO_APPROVERS' });
    expect(await events()).toBe(0);
    expect(await changesSince(ctx, projectId, 0)).toEqual(before);
  });

  it('NO_APPROVERS when the merger is the only member', async () => {
    await ctx.db.prepare(`DELETE FROM project_agents WHERE project_id = ? AND agent_id = ?`).bind(projectId, s.alice.id).run();
    await expect(schedule()).rejects.toMatchObject({ kind: 'rule', code: 'NO_APPROVERS' });
    ctx.setNow(SLOT_UTC);
    expect((await mergeDecision(ctx, 'acme/app', 709)).blocks).toEqual([{ kind: 'no_slot' }]);
  });

  it('pendingApprovals lists unanswered requests until answered', async () => {
    const e = await schedule();
    expect(await pendingApprovals(ctx, s.alice.id)).toEqual([
      { eventId: e.id, repo: 'acme/app', pr: 709, startsAt: SLOT_UTC, merger: 'Bob' },
    ]);
    expect(await pendingApprovals(ctx, s.bob.id)).toEqual([]);
    await approveMerge(ctx, s.alice.id, e.id);
    expect(await pendingApprovals(ctx, s.alice.id)).toEqual([]);
    const late = await schedule({ pr: 710 });
    ctx.setNow('2026-11-19T03:30:01.000Z');
    expect((await pendingApprovals(ctx, s.alice.id)).map((p) => p.eventId)).not.toContain(late.id);
  });
});

describe('schedule and window edges', () => {
  it('the day schedule shows waiting, approved and blocked', async () => {
    const e = await schedule();
    const DAY = ['2026-11-19T00:00:00Z', '2026-11-20T00:00:00Z'] as const;
    expect((await daySchedule(ctx, projectId, ...DAY))[0]).toMatchObject({ id: e.id, status: 'waiting_approval', approvers: [{ name: 'Alice', response: null }] });
    await approveMerge(ctx, s.alice.id, e.id);
    expect((await daySchedule(ctx, projectId, ...DAY))[0]).toMatchObject({ status: 'approved', approvers: [{ name: 'Alice', response: 'approved' }] });
    await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 709, reason: 'wait' });
    expect((await daySchedule(ctx, projectId, ...DAY))[0]).toMatchObject({ status: 'blocked' });
  });

  it('the admin schedule and merge-check agree once a slot\'s window has closed: window closed, no approve buttons', async () => {
    const e = await schedule();
    await approveMerge(ctx, s.alice.id, e.id);
    const DAY = ['2026-11-19T00:00:00Z', '2026-11-20T00:00:00Z'] as const;
    ctx.setNow('2026-11-19T03:30:00.000Z'); // the window's inclusive end: still approved and allowed
    expect((await daySchedule(ctx, projectId, ...DAY))[0]).toMatchObject({ status: 'approved' });
    expect(await mergeDecision(ctx, 'acme/app', 709)).toMatchObject({ allowed: true });

    ctx.setNow('2026-11-19T03:30:01.000Z');
    const decision = await mergeDecision(ctx, 'acme/app', 709);
    expect(decision).toMatchObject({ allowed: false, blocks: [{ kind: 'outside_window' }] });
    const rows = await daySchedule(ctx, projectId, ...DAY);
    expect(rows[0]).toMatchObject({ id: e.id, status: 'window_closed' });
    const fragment = String(await scheduleFragment(rows));
    expect(fragment).toContain('window closed');
    expect(fragment).not.toContain('approved</td>');

    // An unanswered approver of a closed slot gets no button: approving would be refused (WINDOW_CLOSED).
    const late = await schedule({ pr: 710, startsAt: '2026-11-19T02:00:00Z' });
    const lateRow = (await daySchedule(ctx, projectId, ...DAY)).find((r) => r.id === late.id)!;
    expect(lateRow).toMatchObject({ status: 'window_closed', approvers: [{ name: 'Alice', response: null }] });
    expect(String(await scheduleFragment([lateRow]))).not.toContain('Approve for');
    await expect(approveMerge(ctx, s.alice.id, late.id)).rejects.toMatchObject({ code: 'WINDOW_CLOSED' });
  });

  it('the day schedule shows an event with no approver rows as waiting', async () => {
    const id = await bareMergeEvent(SLOT_UTC);
    const [row] = await daySchedule(ctx, projectId, '2026-11-19T00:00:00Z', '2026-11-20T00:00:00Z');
    expect(row).toMatchObject({ id, status: 'waiting_approval', approvers: [] });
  });

  it('windowEdgesBetween lists PRs whose window opens or closes in the range', async () => {
    await schedule();
    await bareMergeEvent('2026-11-19T06:00:00Z', 900);
    const r = s.repo.id;
    expect(await windowEdgesBetween(ctx, '2026-11-19T02:29:00Z', '2026-11-19T02:31:00Z')).toEqual([{ repoId: r, pr: 709 }]);
    expect(await windowEdgesBetween(ctx, '2026-11-19T02:31:00Z', '2026-11-19T03:29:00Z')).toEqual([]);
    expect(await windowEdgesBetween(ctx, '2026-11-19T03:30:00Z', '2026-11-19T03:31:00Z')).toEqual([{ repoId: r, pr: 709 }]);
    expect(await windowEdgesBetween(ctx, '2026-11-19T03:29:00Z', '2026-11-19T03:30:00Z')).toEqual([]); // end exclusive
    expect(await windowEdgesBetween(ctx, '2026-11-19T05:30:00Z', '2026-11-19T05:30:01Z')).toEqual([{ repoId: r, pr: 900 }]);
    expect(await windowEdgesBetween(ctx, '2026-11-19T00:00:00Z', '2026-11-20T00:00:00Z')).toEqual([
      { repoId: r, pr: 709 },
      { repoId: r, pr: 900 },
    ]);
  });
});

describe('request_id stays out of approval requests', () => {
  it('requesting an approval issues no SQL that mentions request_id (a deploy before migration 0002 must not break approvals)', async () => {
    const seen: string[] = [];
    const spy = {
      ...ctx,
      db: {
        prepare: (q: string) => (seen.push(q), env.DB.prepare(q)),
        batch: (b: D1PreparedStatement[]) => env.DB.batch(b),
      } as unknown as D1Database,
    };
    await addEvent(spy, s.bobA, { projectId, title: 'm', startsAt: SLOT, kind: 'merge', repo: 'acme/app', pr: 709 });
    expect(seen.some((q) => /INSERT INTO messages/.test(q))).toBe(true);
    expect(seen.filter((q) => /request_id/.test(q))).toEqual([]);
  });
});
