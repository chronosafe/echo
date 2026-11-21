import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerApprovals } from '../src/domain/approvals';
import { addEvent } from '../src/domain/calendar';
import { changesSince } from '../src/domain/changelog';
import { runEscalations } from '../src/domain/escalation';
import { ackMessage, deferMessage, readInbox, sendMessage, withdrawMessage } from '../src/domain/messages';
import { setOwnerSetting } from '../src/domain/projects';
import { fakeNet, seed, testCtx } from './helpers';

const ctx = testCtx();
const NTFY = 'https://ntfy.test/owner';
let s: Awaited<ReturnType<typeof seed>>;
let projectId: number;

beforeEach(async () => {
  ctx.setNow('2026-11-18T20:00:00.000Z');
  s = await seed(ctx);
  projectId = s.project.id;
  await setOwnerSetting(ctx, 'notify_url', NTFY);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const send = (body = 'urgent', escalateAfterMin = 5) =>
  sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body, requiresAck: true, escalateAfterMin });
const escalatedLog = async () => (await changesSince(ctx, projectId, 0)).filter((c) => c.kind === 'message.escalated');

describe('escalation', () => {
  it('an unanswered message escalates exactly once, with a link to the admin page', async () => {
    const net = fakeNet();
    const { messageId } = await send();
    ctx.setNow('2026-11-18T20:05:00.000Z');
    await runEscalations(ctx, net.fetch);
    await runEscalations(ctx, net.fetch);
    expect(net.requests.filter((r) => r.url === NTFY)).toHaveLength(1);
    const r = net.requests[0];
    expect(r.method).toBe('POST');
    expect(r.headers.click).toBe(`${ctx.env.PUBLIC_URL}/admin/p/${projectId}`);
    expect(r.headers.title).toBe('Echo: unanswered message for Bob');
    expect(r.headers.priority).toBe('high');
    expect(r.hasSignal).toBe(true);
    expect(r.body).toBe(
      `Bob has not answered Alice's message in core (sent 2026-11-18 20:00:00 UTC; last check-in never):\nurgent`,
    );
    const log = await escalatedLog();
    expect(log).toHaveLength(1);
    expect(log[0].subjectId).toBe(messageId);
  });

  it('does not escalate before escalate_at, and sends nothing without a notify_url', async () => {
    const net = fakeNet();
    await send();
    ctx.setNow('2026-11-18T20:04:59.000Z');
    await runEscalations(ctx, net.fetch);
    expect(net.requests).toHaveLength(0);
    await setOwnerSetting(ctx, 'notify_url', null);
    ctx.setNow('2026-11-18T21:00:00.000Z');
    await runEscalations(ctx, net.fetch);
    expect(net.requests).toHaveLength(0);
    expect(await escalatedLog()).toHaveLength(0);
    await setOwnerSetting(ctx, 'notify_url', NTFY); // once configured, the overdue message goes out
    await runEscalations(ctx, net.fetch);
    expect(net.requests).toHaveLength(1);
  });

  it('a deferred message escalates only after its deferral runs out', async () => {
    const net = fakeNet();
    const { messageId } = await send();
    await readInbox(ctx, s.bob.id);
    await deferMessage(ctx, s.bob.id, messageId, 30, 'waiting on the owner'); // until 20:30
    ctx.setNow('2026-11-18T20:29:59.000Z');
    await runEscalations(ctx, net.fetch);
    expect(net.requests).toHaveLength(0);
    ctx.setNow('2026-11-18T20:30:00.000Z');
    await runEscalations(ctx, net.fetch);
    expect(net.requests).toHaveLength(1);
    expect(await escalatedLog()).toHaveLength(1);
  });

  it('an acknowledged or withdrawn message never escalates', async () => {
    const net = fakeNet();
    const acked = await send('acked one');
    const withdrawn = await send('withdrawn one');
    await readInbox(ctx, s.bob.id);
    await ackMessage(ctx, s.bob.id, acked.messageId);
    await withdrawMessage(ctx, s.aliceA, withdrawn.messageId);
    ctx.setNow('2026-11-18T22:00:00.000Z');
    await runEscalations(ctx, net.fetch);
    expect(net.requests).toHaveLength(0);
    expect(await escalatedLog()).toHaveLength(0);
  });

  it('a failed notification is retried on the next run', async () => {
    const net = fakeNet((_r, n) => (n === 1 ? 500 : 200));
    await send();
    ctx.setNow('2026-11-18T20:05:00.000Z');
    await runEscalations(ctx, net.fetch);
    expect(net.requests).toHaveLength(1);
    expect(await escalatedLog()).toHaveLength(0);
    const row = await ctx.db.prepare(`SELECT escalated_at FROM message_recipients`).first<{ escalated_at: string | null }>();
    expect(row!.escalated_at).toBeNull();
    await runEscalations(ctx, net.fetch);
    expect(net.requests).toHaveLength(2);
    expect(await escalatedLog()).toHaveLength(1);
    await runEscalations(ctx, net.fetch);
    expect(net.requests).toHaveLength(2);
  });

  it('a 4xx for one row does not block later rows; a 5xx stops the run', async () => {
    await send('first');
    await send('second');
    ctx.setNow('2026-11-18T20:05:00.000Z');
    const four = fakeNet((_r, n) => (n === 1 ? 400 : 200));
    await runEscalations(ctx, four.fetch);
    expect(four.requests).toHaveLength(2);
    expect(await escalatedLog()).toHaveLength(1); // the rejected row stays unescalated
    const five = fakeNet(() => 503);
    await runEscalations(ctx, five.fetch);
    expect(five.requests).toHaveLength(1); // the rejected row is retried, and the run stops there
  });

  it('a 5xx on the first of two rows means the second is not sent that run', async () => {
    await send('first');
    await send('second');
    ctx.setNow('2026-11-18T20:05:00.000Z');
    const net = fakeNet((_r, n) => (n === 1 ? 503 : 200));
    await runEscalations(ctx, net.fetch);
    expect(net.requests).toHaveLength(1);
    expect(await escalatedLog()).toHaveLength(0);
  });

  it('a network error leaves the row for the next run', async () => {
    const failing = (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    await send();
    ctx.setNow('2026-11-18T20:05:00.000Z');
    await runEscalations(ctx, failing);
    expect(await escalatedLog()).toHaveLength(0);
    const net = fakeNet();
    await runEscalations(ctx, net.fetch);
    expect(net.requests).toHaveLength(1);
  });

  it('cuts the body at 300 characters without splitting a surrogate pair, and keeps the Title header ASCII-safe', async () => {
    const net = fakeNet();
    await send('😀'.repeat(400));
    await ctx.db.prepare(`UPDATE agents SET name = ? WHERE id = ?`).bind('Bób', s.bob.id).run();
    ctx.setNow('2026-11-18T20:05:00.000Z');
    await runEscalations(ctx, net.fetch);
    const r = net.requests[0];
    const text = r.body.slice(r.body.indexOf(':\n') + 2);
    expect(Array.from(text)).toHaveLength(300);
    expect(text).toBe('😀'.repeat(300));
    expect(/^[\x20-\x7e]*$/.test(r.headers.title)).toBe(true);
    const m = /^=\?UTF-8\?B\?(.+)\?=$/.exec(r.headers.title);
    expect(m).not.toBeNull();
    expect(new TextDecoder().decode(Uint8Array.from(atob(m![1]), (c) => c.charCodeAt(0)))).toBe('Echo: unanswered message for Bób');
  });

  it('escalates an approval request for an open event, but not for a merged or cancelled one', async () => {
    registerApprovals();
    await ctx.db.prepare(`UPDATE projects SET approvals_required = 1 WHERE id = ?`).bind(projectId).run();
    const net = fakeNet();
    const mk = (pr: number) =>
      addEvent(ctx, s.bobA, { projectId, title: 'm', startsAt: '2026-11-18T21:00:00-06:00', kind: 'merge', repo: 'acme/app', pr });
    const open = await mk(1);
    const cancelled = await mk(2);
    const merged = await mk(3);
    // Straight to the table, so the selection query itself (not cleanup elsewhere) is what is under test.
    await ctx.db.prepare(`UPDATE events SET cancelled_at = ? WHERE id = ?`).bind(ctx.now(), cancelled.id).run();
    await ctx.db.prepare(`UPDATE events SET merged_at = ? WHERE id = ?`).bind(ctx.now(), merged.id).run();
    const requests = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE kind = 'approval_request' AND withdrawn_at IS NULL`).first<{ n: number }>();
    expect(requests!.n).toBe(3); // all three requests are live messages, so only the join can exclude two
    ctx.setNow('2026-11-18T23:00:00.000Z');
    await runEscalations(ctx, net.fetch);
    expect(net.requests).toHaveLength(1);
    const esc = await escalatedLog();
    expect(esc).toHaveLength(1);
    const msg = await ctx.db.prepare(`SELECT ref_id FROM messages WHERE id = ?`).bind(esc[0].subjectId).first<{ ref_id: number }>();
    expect(msg!.ref_id).toBe(open.id);
  });
});
