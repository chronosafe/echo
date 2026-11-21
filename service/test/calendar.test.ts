import { beforeEach, describe, expect, it } from 'vitest';
import { changesSince } from '../src/domain/changelog';
import {
  addEvent,
  cancelEvent,
  daySchedule,
  listEvents,
  recordMerge,
  setEventApprovalsHook,
  setScheduleDecider,
  updateEvent,
} from '../src/domain/calendar';
import { ruleError } from '../src/errors';
import { seed, testCtx } from './helpers';

const ctx = testCtx();
let s: Awaited<ReturnType<typeof seed>>;
let projectId: number;
const github = { kind: 'system', name: 'github' } as const;
const DAY = ['2026-11-18T00:00:00Z', '2026-11-19T00:00:00Z'] as const;

beforeEach(async () => {
  ctx.setNow('2026-11-18T20:00:00.000Z');
  s = await seed(ctx);
  projectId = s.project.id;
  setEventApprovalsHook(null);
  setScheduleDecider(null);
});

const logged = (kind: string) => changesSince(ctx, projectId, 0).then((c) => c.filter((x) => x.kind === kind));

describe('calendar', () => {
  it('stores a zoned start in UTC and keeps what was entered', async () => {
    const e = await addEvent(ctx, s.bobA, { projectId, title: 'merge 709', startsAt: '2026-11-18T21:00:00-06:00', kind: 'merge', repo: 'acme/app', pr: 709 });
    expect(e).toMatchObject({ startsAt: '2026-11-19T03:00:00.000Z', enteredAs: '2026-11-18T21:00:00-06:00', merger: 'Bob', repo: 'acme/app', pr: 709, afterTheFact: false, cancelled: false });
    const [row] = await listEvents(ctx, s.bobA, { projectId, from: '2026-11-19T00:00:00Z', to: '2026-11-20T00:00:00Z' });
    expect(row.id).toBe(e.id);
    expect(await listEvents(ctx, s.bobA, { projectId, from: '2026-11-18T00:00:00Z', to: '2026-11-19T00:00:00Z' })).toHaveLength(0);
    expect(await logged('event.added')).toHaveLength(1);
  });

  it('a merge event needs a positive whole PR number, from an agent or the owner', async () => {
    const admin = { kind: 'admin' } as const;
    for (const actor of [s.bobA, admin]) {
      for (const pr of [-5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(
          addEvent(ctx, actor, { projectId, title: 'm', startsAt: '2026-11-18T21:00:00Z', kind: 'merge', repo: 'acme/app', pr }),
        ).rejects.toMatchObject({ kind: 'rule', code: 'BAD_PR', fix: expect.stringContaining('709') });
      }
    }
    expect(await listEvents(ctx, s.bobA, { projectId, from: DAY[0], to: DAY[1] })).toHaveLength(0);
    expect(await logged('event.added')).toHaveLength(0);
  });

  it('event titles are capped at 8,192 bytes, on add and on update', async () => {
    const max = 'é'.repeat(4096); // 8,192 bytes
    const e = await addEvent(ctx, s.bobA, { projectId, title: max, startsAt: '2026-11-18T21:00:00Z' });
    expect(e.title).toBe(max);
    const tooLong = max + 'x';
    await expect(addEvent(ctx, s.bobA, { projectId, title: tooLong, startsAt: '2026-11-18T21:00:00Z' })).rejects.toMatchObject({
      kind: 'rule',
      code: 'TITLE_TOO_LARGE',
      message: expect.stringContaining('8193 bytes'),
      fix: expect.stringContaining('document'),
    });
    await expect(updateEvent(ctx, s.bobA, e.id, { title: tooLong })).rejects.toMatchObject({ code: 'TITLE_TOO_LARGE' });
    expect(await logged('event.added')).toHaveLength(1);
    expect(await logged('event.updated')).toHaveLength(0);
  });

  it('a start time without a zone is refused with TIME_NEEDS_ZONE', async () => {
    await expect(addEvent(ctx, s.bobA, { projectId, title: 'x', startsAt: '2026-11-18T21:00:00' })).rejects.toMatchObject({ code: 'TIME_NEEDS_ZONE' });
    expect(await listEvents(ctx, s.bobA, { projectId, from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z' })).toHaveLength(0);
  });

  it('a merge event needs a repo and PR, and the repo must belong to the project', async () => {
    await expect(addEvent(ctx, s.bobA, { projectId, title: 'x', startsAt: '2026-11-18T21:00:00Z', kind: 'merge' })).rejects.toMatchObject({ kind: 'rule' });
    await expect(addEvent(ctx, s.carolA, { projectId: s.other.id, title: 'x', startsAt: '2026-11-18T21:00:00Z', kind: 'merge', repo: 'acme/app', pr: 1 })).rejects.toMatchObject({ code: 'REPO_OTHER_PROJECT' });
    await expect(addEvent(ctx, s.carolA, { projectId, title: 'x', startsAt: '2026-11-18T21:00:00Z' })).rejects.toMatchObject({ code: 'NOT_MEMBER' });
  });

  it('update moves an event and writes event.moved; cancel hides it from the schedule', async () => {
    const calls: string[] = [];
    setEventApprovalsHook({
      onCreate: async () => [],
      onMove: async (_c, e) => {
        calls.push('move:' + e.startsAt);
        return [];
      },
    });
    const e = await addEvent(ctx, s.bobA, { projectId, title: 'm', startsAt: '2026-11-18T21:00:00Z', kind: 'merge', repo: 'acme/app', pr: 5 });
    const moved = await updateEvent(ctx, s.bobA, e.id, { startsAt: '2026-11-18T22:00:00Z' });
    expect(moved.startsAt).toBe('2026-11-18T22:00:00.000Z');
    expect(calls).toEqual(['move:2026-11-18T22:00:00.000Z']);
    expect(await logged('event.moved')).toHaveLength(1);
    await updateEvent(ctx, s.bobA, e.id, { title: 'renamed' });
    expect(await logged('event.updated')).toHaveLength(1);
    expect(calls).toHaveLength(1);
    await cancelEvent(ctx, s.bobA, e.id);
    expect(await daySchedule(ctx, projectId, ...DAY)).toHaveLength(0);
    await expect(cancelEvent(ctx, s.bobA, e.id)).rejects.toMatchObject({ kind: 'rule' });
    expect(await logged('event.cancelled')).toHaveLength(1);
  });

  it('a move and the approvals hook statements commit together, or not at all', async () => {
    const e = await addEvent(ctx, s.bobA, { projectId, title: 'm', startsAt: '2026-11-18T21:00:00Z', kind: 'merge', repo: 'acme/app', pr: 5 });
    setEventApprovalsHook({ onCreate: async () => [], onMove: async (c) => [c.db.prepare(`INSERT INTO no_such_table VALUES (1)`)] });
    await expect(updateEvent(ctx, s.bobA, e.id, { startsAt: '2026-11-18T22:00:00Z' })).rejects.toThrow();
    setEventApprovalsHook({
      onCreate: async () => [],
      onMove: async () => {
        throw new Error('hook failed');
      },
    });
    await expect(updateEvent(ctx, s.bobA, e.id, { startsAt: '2026-11-18T22:00:00Z' })).rejects.toThrow('hook failed');
    const [row] = await listEvents(ctx, s.bobA, { projectId, from: DAY[0], to: DAY[1] });
    expect(row.startsAt).toBe('2026-11-18T21:00:00.000Z');
    expect(await logged('event.moved')).toHaveLength(0);
    // A hook statement that applies is committed with the move.
    setEventApprovalsHook({
      onCreate: async () => [],
      onMove: async (c, ev) => [c.db.prepare(`UPDATE events SET title = 'hooked' WHERE id = ? AND starts_at = ?`).bind(ev.id, ev.startsAt)],
    });
    const moved = await updateEvent(ctx, s.bobA, e.id, { startsAt: '2026-11-18T22:00:00Z' });
    expect(moved).toMatchObject({ startsAt: '2026-11-18T22:00:00.000Z', title: 'hooked' });
    expect(await logged('event.moved')).toHaveLength(1);
  });

  it('calls the approvals hook on create only when the project requires approvals', async () => {
    const seen: unknown[] = [];
    setEventApprovalsHook({
      onCreate: async (_c, e, approvers) => {
        seen.push([e.id, approvers]);
        return [];
      },
      onMove: async () => [],
    });
    await addEvent(ctx, s.bobA, { projectId, title: 'm', startsAt: '2026-11-18T21:00:00Z', kind: 'merge', repo: 'acme/app', pr: 5, approvers: ['Alice'] });
    expect(seen).toHaveLength(0);
    await ctx.db.prepare(`UPDATE projects SET approvals_required = 1 WHERE id = ?`).bind(projectId).run();
    const e = await addEvent(ctx, s.bobA, { projectId, title: 'm2', startsAt: '2026-11-18T22:00:00Z', kind: 'merge', repo: 'acme/app', pr: 6, approvers: ['Alice'] });
    expect(seen).toEqual([[e.id, ['Alice']]]);
  });

  it('checkCreate refuses before the insert; a refusal that only onCreate sees takes the event back off', async () => {
    await ctx.db.prepare(`UPDATE projects SET approvals_required = 1 WHERE id = ?`).bind(projectId).run();
    const add = (pr: number) => addEvent(ctx, s.bobA, { projectId, title: 'm', startsAt: '2026-11-18T21:00:00Z', kind: 'merge', repo: 'acme/app', pr });
    const drafts: unknown[] = [];
    setEventApprovalsHook({
      checkCreate: async (_c, draft) => {
        drafts.push(draft);
        throw ruleError('NO_APPROVERS', 'nobody', 'add someone');
      },
      onCreate: async () => [],
      onMove: async () => [],
    });
    await expect(add(5)).rejects.toMatchObject({ code: 'NO_APPROVERS' });
    expect(drafts).toEqual([{ projectId, merger: 'Bob' }]);
    expect(await listEvents(ctx, s.bobA, { projectId, from: DAY[0], to: DAY[1] })).toEqual([]);
    expect(await changesSince(ctx, projectId, 0)).toEqual([]);
    // Membership changed between the check and onCreate: the event is cancelled and the refusal reported.
    setEventApprovalsHook({
      checkCreate: async () => {},
      onCreate: async () => {
        throw ruleError('NO_APPROVERS', 'nobody', 'add someone');
      },
      onMove: async () => [],
    });
    await expect(add(6)).rejects.toMatchObject({ code: 'NO_APPROVERS' });
    expect((await listEvents(ctx, s.bobA, { projectId, from: DAY[0], to: DAY[1] })).map((e) => e.cancelled)).toEqual([true]);
    expect((await logged('event.cancelled'))[0].data).toEqual({ refused: 'NO_APPROVERS' });
  });

  it('an unscheduled merge appears on that day as merged, after the fact', async () => {
    const e = await recordMerge(ctx, s.bobA, { repo: 'acme/app', pr: 7, mergedAt: '2026-11-18T21:29:00Z', source: 'hook' });
    expect(e).toMatchObject({ afterTheFact: true, mergedAt: '2026-11-18T21:29:00.000Z', mergedBy: 'Bob', startsAt: '2026-11-18T21:29:00.000Z', kind: 'merge', pr: 7, repo: 'acme/app' });
    const rows = await daySchedule(ctx, projectId, ...DAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pr: 7, status: 'merged', afterTheFact: true, isNext: false });
    expect(await logged('merge.recorded')).toHaveLength(1);
  });

  it('recording the same merge from hook then github leaves one row merged once', async () => {
    await recordMerge(ctx, s.bobA, { repo: 'acme/app', pr: 42, mergedAt: '2026-11-18T21:29:00Z', source: 'hook' });
    const again = await recordMerge(ctx, github, { repo: 'Acme/App', pr: 42, mergedAt: '2026-11-18T21:29:00Z', source: 'github' });
    expect(again).toMatchObject({ mergedBy: 'Bob', mergedAt: '2026-11-18T21:29:00.000Z' });
    const rows = await daySchedule(ctx, projectId, '2026-11-18T00:00:00Z', '2026-11-19T00:00:00Z');
    expect(rows.filter((r) => r.pr === 42)).toHaveLength(1);
    expect((await changesSince(ctx, projectId, 0)).filter((c) => c.kind === 'merge.recorded')).toHaveLength(1);
  });

  it('github first, then the hook, keeps github as the recorder', async () => {
    await recordMerge(ctx, github, { repo: 'acme/app', pr: 43, mergedAt: '2026-11-18T21:29:00Z', source: 'github' });
    const again = await recordMerge(ctx, s.bobA, { repo: 'acme/app', pr: 43, mergedAt: '2026-11-18T21:29:00Z', source: 'hook' });
    expect(again).toMatchObject({ mergedBy: 'github' });
    expect(await logged('merge.recorded')).toHaveLength(1);
    expect(await daySchedule(ctx, projectId, ...DAY)).toHaveLength(1);
  });

  it('concurrent hook and github recordMerge for the same PR produce one row', async () => {
    const [a, b] = await Promise.all([
      recordMerge(ctx, s.bobA, { repo: 'acme/app', pr: 44, mergedAt: '2026-11-18T21:29:00Z', source: 'hook' }),
      recordMerge(ctx, github, { repo: 'acme/app', pr: 44, mergedAt: '2026-11-18T21:29:00Z', source: 'github' }),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).toBe(b!.id);
    expect(a!.mergedBy).toBe(b!.mergedBy);
    expect((await daySchedule(ctx, projectId, ...DAY)).filter((r) => r.pr === 44)).toHaveLength(1);
    expect(await logged('merge.recorded')).toHaveLength(1);
  });

  it('concurrent recordMerge against a scheduled event also records once', async () => {
    const sched = await addEvent(ctx, s.bobA, { projectId, title: 'm', startsAt: '2026-11-18T21:00:00Z', kind: 'merge', repo: 'acme/app', pr: 45 });
    const [a, b] = await Promise.all([
      recordMerge(ctx, s.bobA, { repo: 'acme/app', pr: 45, mergedAt: '2026-11-18T21:29:00Z', source: 'hook' }),
      recordMerge(ctx, github, { repo: 'acme/app', pr: 45, mergedAt: '2026-11-18T21:29:00Z', source: 'github' }),
    ]);
    expect(a!.id).toBe(b!.id);
    expect(a!.id).toBe(sched.id);
    expect(await logged('merge.recorded')).toHaveLength(1);
    expect(await daySchedule(ctx, projectId, ...DAY)).toHaveLength(1);
  });

  it('a merge marks the matching scheduled event instead of creating one', async () => {
    const early = await addEvent(ctx, s.bobA, { projectId, title: 'early', startsAt: '2026-11-18T18:00:00Z', kind: 'merge', repo: 'acme/app', pr: 50 });
    const near = await addEvent(ctx, s.bobA, { projectId, title: 'near', startsAt: '2026-11-18T21:00:00Z', kind: 'merge', repo: 'acme/app', pr: 50 });
    const cancelled = await addEvent(ctx, s.bobA, { projectId, title: 'cancelled', startsAt: '2026-11-18T21:29:00Z', kind: 'merge', repo: 'acme/app', pr: 50 });
    await cancelEvent(ctx, s.bobA, cancelled.id);
    const e = await recordMerge(ctx, s.bobA, { repo: 'acme/app', pr: 50, mergedAt: '2026-11-18T21:29:00Z', source: 'hook' });
    expect(e).toMatchObject({ id: near.id, afterTheFact: false, startsAt: '2026-11-18T21:00:00.000Z', mergedBy: 'Bob' });
    const rows = await daySchedule(ctx, projectId, ...DAY);
    expect(rows.map((r) => [r.id, r.status])).toEqual([[early.id, 'scheduled'], [near.id, 'merged']]);
  });

  it('nearest-time ties go to the earliest start', async () => {
    const a = await addEvent(ctx, s.bobA, { projectId, title: 'a', startsAt: '2026-11-18T20:30:00Z', kind: 'merge', repo: 'acme/app', pr: 51 });
    await addEvent(ctx, s.bobA, { projectId, title: 'b', startsAt: '2026-11-18T21:30:00Z', kind: 'merge', repo: 'acme/app', pr: 51 });
    const e = await recordMerge(ctx, s.bobA, { repo: 'acme/app', pr: 51, mergedAt: '2026-11-18T21:00:00Z', source: 'hook' });
    expect(e!.id).toBe(a.id);
  });

  /** A db whose next merge-marking batch first cancels `eventId`, as a rival would between SELECT and UPDATE. */
  function cancelDuringMark(eventId: number) {
    const real = ctx.db;
    let armed = true;
    let pending = false;
    const db = {
      prepare(sql: string) {
        if (armed && /UPDATE events SET merged_at/.test(sql)) pending = true;
        return real.prepare(sql);
      },
      async batch(stmts: D1PreparedStatement[]) {
        if (pending) {
          pending = false;
          armed = false;
          await real.prepare(`UPDATE events SET cancelled_at = ? WHERE id = ?`).bind(ctx.now(), eventId).run();
        }
        return real.batch(stmts);
      },
    } as unknown as D1Database;
    return { ...ctx, db };
  }

  it('a merge whose chosen event is cancelled mid-record falls back to the next event', async () => {
    const other = await addEvent(ctx, s.bobA, { projectId, title: 'other', startsAt: '2026-11-18T18:00:00Z', kind: 'merge', repo: 'acme/app', pr: 60 });
    const near = await addEvent(ctx, s.bobA, { projectId, title: 'near', startsAt: '2026-11-18T21:00:00Z', kind: 'merge', repo: 'acme/app', pr: 60 });
    const e = await recordMerge(cancelDuringMark(near.id), github, { repo: 'acme/app', pr: 60, mergedAt: '2026-11-18T21:29:00Z', source: 'github' });
    expect(e).toMatchObject({ id: other.id, mergedAt: '2026-11-18T21:29:00.000Z', mergedBy: 'github', afterTheFact: false });
    expect(await logged('merge.recorded')).toHaveLength(1);
  });

  it('a merge whose only event is cancelled mid-record is still recorded, after the fact', async () => {
    const only = await addEvent(ctx, s.bobA, { projectId, title: 'only', startsAt: '2026-11-18T21:00:00Z', kind: 'merge', repo: 'acme/app', pr: 61 });
    const e = await recordMerge(cancelDuringMark(only.id), github, { repo: 'acme/app', pr: 61, mergedAt: '2026-11-18T21:29:00Z', source: 'github' });
    expect(e).not.toBeNull();
    expect(e).toMatchObject({ afterTheFact: true, mergedAt: '2026-11-18T21:29:00.000Z', mergedBy: 'github', pr: 61 });
    expect(e!.id).not.toBe(only.id);
    const merged = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE pr_number = 61 AND merged_at IS NOT NULL`).first<{ n: number }>();
    expect(merged!.n).toBe(1);
    expect(await logged('merge.recorded')).toHaveLength(1);
  });

  it('recordMerge on an unregistered repository returns null and writes nothing', async () => {
    expect(await recordMerge(ctx, s.bobA, { repo: 'nobody/else', pr: 1, mergedAt: '2026-11-18T21:29:00Z', source: 'hook' })).toBeNull();
    const n = await ctx.db.prepare(`SELECT COUNT(*) n FROM events`).first<{ n: number }>();
    expect(n!.n).toBe(0);
    expect(await changesSince(ctx, projectId, 0)).toHaveLength(0);
  });

  it('daySchedule orders by time, marks the next unmerged row, and uses a registered decider', async () => {
    const late = await addEvent(ctx, s.bobA, { projectId, title: 'late', startsAt: '2026-11-18T23:00:00Z', kind: 'merge', repo: 'acme/app', pr: 61 });
    const soon = await addEvent(ctx, s.bobA, { projectId, title: 'soon', startsAt: '2026-11-18T21:00:00Z', kind: 'merge', repo: 'acme/app', pr: 60 });
    await addEvent(ctx, s.bobA, { projectId, title: 'lunch', startsAt: '2026-11-18T22:00:00Z' });
    let rows = await daySchedule(ctx, projectId, ...DAY);
    expect(rows.map((r) => [r.id, r.status, r.isNext, r.approvers])).toEqual([[soon.id, 'scheduled', true, []], [late.id, 'scheduled', false, []]]);
    setScheduleDecider(async (_c, e) => (e.pr === 60 ? 'waiting_approval' : 'blocked'));
    rows = await daySchedule(ctx, projectId, ...DAY);
    expect(rows.map((r) => [r.status, r.approvers])).toEqual([['waiting_approval', []], ['blocked', []]]);
  });
});
