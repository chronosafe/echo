import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { changesSince } from '../src/domain/changelog';
import { ackHold, placeHold } from '../src/domain/holds';
import {
  MAX_MESSAGE_BYTES,
  ackMessage,
  ackMessageInternal,
  adminAckMessage,
  deferMessage,
  messageStatus,
  noticeStmts,
  pendingMessages,
  readInbox,
  sendMessage,
  takeForHook,
  withdrawMessage,
} from '../src/domain/messages';
import { seed, testCtx } from './helpers';

const ctx = testCtx();
let s: Awaited<ReturnType<typeof seed>>;
let projectId: number;

beforeEach(async () => {
  ctx.setNow('2026-11-18T20:00:00.000Z');
  s = await seed(ctx);
  projectId = s.project.id;
});

const ids = (xs: { messageId: number }[]) => xs.map((m) => m.messageId);

describe('send', () => {
  it('has an 8192-byte limit', () => expect(MAX_MESSAGE_BYTES).toBe(8192));

  it('refuses a body over 8192 UTF-8 bytes and names both sizes', async () => {
    const p = sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: '😀'.repeat(3000), requiresAck: false });
    await expect(p).rejects.toMatchObject({ kind: 'rule', code: 'MESSAGE_TOO_LARGE', fix: expect.stringContaining('12000 bytes') });
    await expect(p).rejects.toMatchObject({
      fix: 'Messages are limited to 8192 bytes; this one is 12000 bytes. Save the long content as a project document (echo_doc_save) and send a short message naming the document.',
    });
  });

  it('accepts exactly 8192 bytes', async () => {
    await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'a'.repeat(8192), requiresAck: false });
  });

  it('a short message straight after a refused one succeeds', async () => {
    await expect(
      sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'x'.repeat(9000), requiresAck: false }),
    ).rejects.toMatchObject({ code: 'MESSAGE_TOO_LARGE' });
    const { messageId, recipients } = await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'short', requiresAck: false });
    expect(recipients).toEqual(['Bob']);
    expect(ids(await readInbox(ctx, s.bob.id))).toEqual([messageId]);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it('refuses empty bodies, unknown recipients and a to-all with nobody else', async () => {
    await expect(sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: '  ', requiresAck: false })).rejects.toMatchObject({ code: 'EMPTY_MESSAGE' });
    await expect(sendMessage(ctx, s.aliceA, { projectId, to: 'Carol', body: 'hi', requiresAck: false })).rejects.toMatchObject({ code: 'UNKNOWN_RECIPIENT' });
    await expect(sendMessage(ctx, s.carolA, { projectId: s.other.id, to: 'all', body: 'hi', requiresAck: false })).rejects.toMatchObject({ code: 'NO_RECIPIENTS' });
  });

  it('records the send in the change log and stores sender label and time from the server clock', async () => {
    const { messageId } = await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'hello', requiresAck: true });
    const row = await env.DB.prepare('SELECT * FROM messages WHERE id=?').bind(messageId).first<any>();
    expect(row).toMatchObject({ sender_label: 'Alice', sender_agent_id: s.alice.id, created_at: '2026-11-18T20:00:00.000Z', requires_ack: 1, kind: 'plain' });
    const log = await changesSince(ctx, projectId, 0);
    expect(log).toEqual([expect.objectContaining({ kind: 'message.sent', actor: 'Alice', subjectId: messageId })]);
  });

  it('escalateAfterMin needs requiresAck and 1..1440', async () => {
    await expect(sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'x', requiresAck: false, escalateAfterMin: 5 })).rejects.toMatchObject({ code: 'ESCALATION_NEEDS_ACK' });
    for (const n of [0, 1441, 1.5]) {
      await expect(sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'x', requiresAck: true, escalateAfterMin: n })).rejects.toMatchObject({ code: 'BAD_MINUTES' });
    }
  });

  it('a message with escalateAfterMin stores escalate_at from the server clock', async () => {
    const { messageId } = await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'x', requiresAck: true, escalateAfterMin: 15 });
    const row = await env.DB.prepare('SELECT escalate_at FROM messages WHERE id=?').bind(messageId).first<{ escalate_at: string }>();
    expect(row!.escalate_at).toBe('2026-11-18T20:15:00.000Z');
    expect((await messageStatus(ctx, s.alice.id, messageId))[0].escalateAt).toBe('2026-11-18T20:15:00.000Z');
  });

  it('internal escalateAt is stored as given, needs requiresAck, and excludes escalateAfterMin', async () => {
    const { messageId } = await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'x', requiresAck: true, escalateAt: '2026-11-18T22:00:00.000Z' });
    const row = await env.DB.prepare('SELECT escalate_at FROM messages WHERE id=?').bind(messageId).first<{ escalate_at: string }>();
    expect(row!.escalate_at).toBe('2026-11-18T22:00:00.000Z');
    await expect(sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'x', requiresAck: false, escalateAt: '2026-11-18T22:00:00.000Z' })).rejects.toMatchObject({ code: 'ESCALATION_NEEDS_ACK' });
    await expect(
      sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'x', requiresAck: true, escalateAt: '2026-11-18T22:00:00.000Z', escalateAfterMin: 5 }),
    ).rejects.toMatchObject({ kind: 'rule', code: 'BAD_ESCALATION' });
    await expect(sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'x', requiresAck: true, escalateAt: 'nonsense' })).rejects.toMatchObject({ kind: 'rule' });
  });

  it('system and admin actors can send; admin messages have no sender agent', async () => {
    const { messageId } = await sendMessage(ctx, { kind: 'admin' }, { projectId, to: 'all', body: 'notice', requiresAck: false, kind: 'system' });
    const row = await env.DB.prepare('SELECT sender_agent_id, sender_label, kind FROM messages WHERE id=?').bind(messageId).first<any>();
    expect(row).toEqual({ sender_agent_id: null, sender_label: 'admin', kind: 'system' });
    expect(ids(await readInbox(ctx, s.alice.id))).toEqual([messageId]);
    expect(ids(await readInbox(ctx, s.bob.id))).toEqual([messageId]);
  });
});

describe('delivery, acknowledgment and defer', () => {
  it('sent → delivered → acknowledged, re-shown until acked, sender told with the note', async () => {
    const { messageId } = await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'hold #709', requiresAck: true });
    const first = await takeForHook(ctx, s.bob.id);
    expect(ids(first.fresh)).toEqual([messageId]);
    expect(first.awaitingAck).toEqual([]);
    expect(ids((await takeForHook(ctx, s.bob.id)).awaitingAck)).toEqual([messageId]);
    await ackMessage(ctx, s.bob.id, messageId, 'seen, will wait');
    expect((await takeForHook(ctx, s.bob.id)).awaitingAck).toEqual([]);
    const last = (await readInbox(ctx, s.alice.id)).at(-1)!;
    expect(last).toMatchObject({ from: 'Echo', kind: 'system', body: expect.stringContaining('seen, will wait') });
    expect(last.body).toContain('Bob');
  });

  it('fresh is not repeated; plain messages are not re-shown once delivered', async () => {
    const { messageId } = await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'fyi', requiresAck: false });
    const first = await takeForHook(ctx, s.bob.id);
    expect(ids(first.fresh)).toEqual([messageId]);
    expect(first.fresh[0]).toMatchObject({ deliveredAt: '2026-11-18T20:00:00.000Z', from: 'Alice', projectName: 'core', acknowledged: false });
    const second = await takeForHook(ctx, s.bob.id);
    expect(second.fresh).toEqual([]);
    expect(second.awaitingAck).toEqual([]);
  });

  it('two concurrent takeForHook calls never both report an item as fresh', async () => {
    for (let i = 0; i < 5; i++) await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: `m${i}`, requiresAck: true });
    const [a, b] = await Promise.all([takeForHook(ctx, s.bob.id), takeForHook(ctx, s.bob.id)]);
    const all = [...ids(a.fresh), ...ids(b.fresh)];
    expect(all).toHaveLength(5);
    expect(new Set(all).size).toBe(5);
  });

  it('delivery by hook writes a change entry once per item', async () => {
    await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'x', requiresAck: false });
    await takeForHook(ctx, s.bob.id);
    await takeForHook(ctx, s.bob.id);
    const kinds = (await changesSince(ctx, projectId, 0)).map((c) => c.kind);
    expect(kinds.filter((k) => k === 'message.delivered')).toHaveLength(1);
  });

  it('concurrent acks of one message record one log entry and send one notice', async () => {
    const { messageId } = await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'x', requiresAck: true });
    await Promise.all([ackMessage(ctx, s.bob.id, messageId, 'a'), ackMessage(ctx, s.bob.id, messageId, 'b')]);
    const kinds = (await changesSince(ctx, projectId, 0)).map((c) => c.kind);
    expect(kinds.filter((k) => k === 'message.acknowledged')).toHaveLength(1);
    expect((await readInbox(ctx, s.alice.id)).filter((m) => m.from === 'Echo')).toHaveLength(1);
  });

  it('an ack batch whose UPDATE does not apply records nothing and notifies nobody', async () => {
    const { messageId } = await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'x', requiresAck: true });
    await ackMessage(ctx, s.bob.id, messageId, 'first');
    // a second batch racing past the preflight: drive the same guarded statements directly
    await env.DB.prepare('UPDATE message_recipients SET acked_at = NULL WHERE message_id = ?').bind(messageId).run();
    await env.DB.prepare('UPDATE messages SET withdrawn_at = ? WHERE id = ?').bind(ctx.now(), messageId).run();
    await expect(ackMessage(ctx, s.bob.id, messageId)).rejects.toMatchObject({ code: 'MESSAGE_WITHDRAWN' });
    const kinds = (await changesSince(ctx, projectId, 0)).map((c) => c.kind);
    expect(kinds.filter((k) => k === 'message.acknowledged')).toHaveLength(1);
    expect((await readInbox(ctx, s.alice.id)).filter((m) => m.from === 'Echo')).toHaveLength(1);
  });

  it('withdraw writes its change entry once, and a refused withdraw writes none', async () => {
    const a = (await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'x', requiresAck: true })).messageId;
    await withdrawMessage(ctx, s.aliceA, a);
    await withdrawMessage(ctx, s.aliceA, a);
    const b = (await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'y', requiresAck: true })).messageId;
    await ackMessage(ctx, s.bob.id, b);
    await expect(withdrawMessage(ctx, s.aliceA, b)).rejects.toMatchObject({ code: 'ALREADY_ACKNOWLEDGED' });
    const kinds = (await changesSince(ctx, projectId, 0)).map((c) => c.kind);
    expect(kinds.filter((k) => k === 'message.withdrawn')).toHaveLength(1);
  });

  it('readInbox marks items delivered, filters by project, and hides acknowledged unless asked', async () => {
    const { messageId } = await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'x', requiresAck: true });
    const inbox = await readInbox(ctx, s.bob.id, { projectId });
    expect(inbox[0]).toMatchObject({ messageId, deliveredAt: '2026-11-18T20:00:00.000Z', acknowledged: false });
    expect((await takeForHook(ctx, s.bob.id)).fresh).toEqual([]);
    await ackMessage(ctx, s.bob.id, messageId);
    expect(await readInbox(ctx, s.bob.id)).toEqual([]);
    expect(ids(await readInbox(ctx, s.bob.id, { includeAcknowledged: true }))).toEqual([messageId]);
    expect((await readInbox(ctx, s.bob.id, { includeAcknowledged: true }))[0].acknowledged).toBe(true);
  });

  it('a deferred message leaves awaitingAck and comes back as fresh when its time passes', async () => {
    const { messageId } = await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'x', requiresAck: true });
    await takeForHook(ctx, s.bob.id);
    await deferMessage(ctx, s.bob.id, messageId, 10, 'waiting on the owner');
    expect((await takeForHook(ctx, s.bob.id)).awaitingAck).toEqual([]);
    ctx.setNow('2026-11-18T20:10:01.000Z');
    const back = await takeForHook(ctx, s.bob.id);
    expect(ids(back.fresh)).toEqual([messageId]);
    expect(back.fresh[0].deferredUntil).toBeNull();
    expect(back.awaitingAck).toEqual([]);
    expect(ids((await takeForHook(ctx, s.bob.id)).awaitingAck)).toEqual([messageId]);
    expect((await takeForHook(ctx, s.bob.id)).fresh).toEqual([]);
    expect((await messageStatus(ctx, s.alice.id, messageId))[0].recipients[0]).toMatchObject({ deferReason: 'waiting on the owner' });
  });

  it('defer tells the sender, as Echo, and status shows the deferral', async () => {
    const { messageId } = await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'x', requiresAck: true });
    await deferMessage(ctx, s.bob.id, messageId, 10, 'waiting on the owner');
    const notice = (await readInbox(ctx, s.alice.id)).at(-1)!;
    expect(notice).toMatchObject({ from: 'Echo', kind: 'system', requiresAck: false });
    expect(notice.body).toContain('Bob');
    expect(notice.body).toContain('waiting on the owner');
    expect(notice.body).toContain('2026-11-18T20:10:00.000Z');
    expect((await messageStatus(ctx, s.alice.id, messageId))[0].recipients[0]).toMatchObject({
      name: 'Bob', delivered: true, deferredUntil: '2026-11-18T20:10:00.000Z', deferReason: 'waiting on the owner', acknowledged: false,
    });
  });

  it('defer rules: needs requires-ack, a reason, 1..1440 minutes, a recipient', async () => {
    const plain = (await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'x', requiresAck: false })).messageId;
    const req = (await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'y', requiresAck: true })).messageId;
    await expect(deferMessage(ctx, s.bob.id, plain, 5, 'why')).rejects.toMatchObject({ code: 'NOT_DEFERRABLE' });
    await expect(deferMessage(ctx, s.bob.id, req, 5, '   ')).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    for (const n of [0, 1441, 2.5]) await expect(deferMessage(ctx, s.bob.id, req, n, 'why')).rejects.toMatchObject({ code: 'BAD_MINUTES' });
    await expect(deferMessage(ctx, s.alice.id, req, 5, 'why')).rejects.toMatchObject({ code: 'NOT_RECIPIENT' });
    await deferMessage(ctx, s.bob.id, req, 1440, 'why');
    await ackMessage(ctx, s.bob.id, req);
    await expect(deferMessage(ctx, s.bob.id, req, 5, 'why')).rejects.toMatchObject({ code: 'ALREADY_ACKNOWLEDGED' });
  });

  it('acknowledging while deferred ends awaiting and does not come back', async () => {
    const { messageId } = await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'x', requiresAck: true });
    await deferMessage(ctx, s.bob.id, messageId, 10, 'later');
    await ackMessage(ctx, s.bob.id, messageId);
    ctx.setNow('2026-11-18T21:00:00.000Z');
    const t = await takeForHook(ctx, s.bob.id);
    expect(t.fresh).toEqual([]);
    expect(t.awaitingAck).toEqual([]);
  });

  it('ack by a non-recipient is refused; a second ack by the recipient is a no-op without a second notice', async () => {
    const { messageId } = await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'x', requiresAck: true });
    await expect(ackMessage(ctx, s.alice.id, messageId)).rejects.toMatchObject({ code: 'NOT_RECIPIENT' });
    await expect(ackMessage(ctx, s.carol.id, messageId)).rejects.toMatchObject({ code: 'NOT_RECIPIENT' });
    await ackMessage(ctx, s.bob.id, messageId, 'one');
    ctx.setNow('2026-11-18T20:05:00.000Z');
    await ackMessage(ctx, s.bob.id, messageId, 'two');
    const notices = (await readInbox(ctx, s.alice.id)).filter((m) => m.from === 'Echo');
    expect(notices).toHaveLength(1);
    const st = (await messageStatus(ctx, s.alice.id, messageId))[0].recipients[0];
    expect(st).toMatchObject({ acknowledged: true, note: 'one' });
  });

  it('ackMessageInternal acknowledges without telling the sender', async () => {
    const { messageId } = await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'x', requiresAck: true });
    await ackMessageInternal(ctx, s.bob.id, messageId, 'approved');
    expect(await readInbox(ctx, s.alice.id)).toEqual([]);
    expect((await messageStatus(ctx, s.alice.id, messageId))[0].recipients[0]).toMatchObject({ acknowledged: true, note: 'approved' });
  });

  it('adminAckMessage acknowledges for the agent and the sender is told who did it', async () => {
    const { messageId } = await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'x', requiresAck: true });
    await adminAckMessage(ctx, messageId, s.bob.id);
    expect((await takeForHook(ctx, s.bob.id)).awaitingAck).toEqual([]);
    const notice = (await readInbox(ctx, s.alice.id)).at(-1)!;
    expect(notice.body).toContain('admin');
    expect(notice.body).toContain('Bob');
    const row = await env.DB.prepare('SELECT acked_by FROM message_recipients WHERE message_id=?').bind(messageId).first<{ acked_by: string }>();
    expect(row!.acked_by).toBe('admin');
  });

  it('no notice when the original sender was not an agent', async () => {
    const { messageId } = await sendMessage(ctx, { kind: 'admin' }, { projectId, to: 'Bob', body: 'x', requiresAck: true });
    await ackMessage(ctx, s.bob.id, messageId);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first<{ n: number }>();
    expect(n!.n).toBe(1);
  });
});

describe('status, withdraw, pending, membership', () => {
  it("'all' shows each recipient separately in status", async () => {
    const dave = await env.DB.prepare(`INSERT INTO agents (name, token_hash, created_at) VALUES ('Dave','h',?) RETURNING id`).bind(ctx.now()).first<{ id: number }>();
    await env.DB.prepare('INSERT INTO project_agents (project_id, agent_id) VALUES (?,?)').bind(projectId, dave!.id).run();
    const m1 = await sendMessage(ctx, s.aliceA, { projectId, to: 'all', body: 'everyone', requiresAck: true });
    expect(m1.recipients.sort()).toEqual(['Bob', 'Dave']);
    const m2 = await sendMessage(ctx, s.aliceA, { projectId, to: 'all', body: 'again', requiresAck: true });
    await takeForHook(ctx, s.bob.id);
    await ackMessage(ctx, s.bob.id, m2.messageId, 'ok');
    const [st] = await messageStatus(ctx, s.alice.id, m2.messageId);
    expect(st.recipients.map((r) => r.name).sort()).toEqual(['Bob', 'Dave']);
    expect(st.recipients.find((r) => r.name === 'Bob')).toMatchObject({ delivered: true, acknowledged: true, note: 'ok', escalated: false });
    expect(st.recipients.find((r) => r.name === 'Dave')).toMatchObject({ delivered: false, acknowledged: false, note: null });
    expect(st).toMatchObject({ messageId: m2.messageId, sentAt: '2026-11-18T20:00:00.000Z', withdrawn: false, escalateAt: null });
    const all = await messageStatus(ctx, s.alice.id);
    expect(ids(all).sort()).toEqual([m1.messageId, m2.messageId].sort());
  });

  it('status is only for the sender', async () => {
    const { messageId } = await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'x', requiresAck: true });
    await expect(messageStatus(ctx, s.bob.id, messageId)).rejects.toMatchObject({ code: 'NOT_SENDER' });
    expect(await messageStatus(ctx, s.bob.id)).toEqual([]);
  });

  it('withdraw hides an unacknowledged message; refused after acknowledgment', async () => {
    const a = (await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'x', requiresAck: true })).messageId;
    await expect(withdrawMessage(ctx, s.bobA, a)).rejects.toMatchObject({ code: 'NOT_SENDER' });
    await withdrawMessage(ctx, s.aliceA, a);
    expect(await readInbox(ctx, s.bob.id)).toEqual([]);
    const t = await takeForHook(ctx, s.bob.id);
    expect(t.fresh).toEqual([]);
    expect(t.awaitingAck).toEqual([]);
    expect((await messageStatus(ctx, s.alice.id, a))[0].withdrawn).toBe(true);
    expect((await changesSince(ctx, projectId, 0)).map((c) => c.kind)).toContain('message.withdrawn');

    const b = (await sendMessage(ctx, s.aliceA, { projectId, to: 'all', body: 'y', requiresAck: true })).messageId;
    await ackMessage(ctx, s.bob.id, b);
    await expect(withdrawMessage(ctx, s.aliceA, b)).rejects.toMatchObject({ code: 'ALREADY_ACKNOWLEDGED' });
    await expect(withdrawMessage(ctx, { kind: 'admin' }, b)).rejects.toMatchObject({ code: 'ALREADY_ACKNOWLEDGED' });
  });

  it('the admin can withdraw any unacknowledged message; acknowledging a withdrawn message is refused', async () => {
    const a = (await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'x', requiresAck: true })).messageId;
    await withdrawMessage(ctx, { kind: 'admin' }, a);
    await expect(ackMessage(ctx, s.bob.id, a)).rejects.toMatchObject({ kind: 'rule' });
  });

  it('an agent outside the project cannot send to it or read its messages', async () => {
    await expect(sendMessage(ctx, s.carolA, { projectId, to: 'Bob', body: 'x', requiresAck: false })).rejects.toMatchObject({ code: 'NOT_MEMBER' });
    const { messageId } = await sendMessage(ctx, s.aliceA, { projectId, to: 'all', body: 'secret', requiresAck: true });
    await expect(readInbox(ctx, s.carol.id, { projectId })).rejects.toMatchObject({ code: 'NOT_MEMBER' });
    expect(await readInbox(ctx, s.carol.id)).toEqual([]);
    expect(await takeForHook(ctx, s.carol.id)).toEqual({ fresh: [], awaitingAck: [] });
    await expect(ackMessage(ctx, s.carol.id, messageId)).rejects.toMatchObject({ code: 'NOT_RECIPIENT' });
  });

  it('a member removed from the project no longer sees its messages', async () => {
    await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'x', requiresAck: true });
    await env.DB.prepare('DELETE FROM project_agents WHERE project_id=? AND agent_id=?').bind(projectId, s.bob.id).run();
    expect(await readInbox(ctx, s.bob.id)).toEqual([]);
    expect(await takeForHook(ctx, s.bob.id)).toEqual({ fresh: [], awaitingAck: [] });
  });

  it('pendingMessages lists unacknowledged recipients with deferral, escalation and last check-in', async () => {
    await env.DB.prepare('UPDATE agents SET last_checked_in_at=? WHERE id=?').bind('2026-11-18T19:55:00.000Z', s.bob.id).run();
    const a = (await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'x', requiresAck: true, escalateAfterMin: 20 })).messageId;
    const b = (await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'y', requiresAck: true })).messageId;
    await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'plain', requiresAck: false });
    await deferMessage(ctx, s.bob.id, b, 30, 'blocked');
    await ackMessage(ctx, s.bob.id, a);
    const c = (await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'z', requiresAck: true, escalateAfterMin: 20 })).messageId;
    const all = await pendingMessages(ctx, projectId);
    const rows = all.filter((r) => r.recipient === 'Bob');
    // The plain message (sent between a and b) is still undelivered: it waits too, until a poll delivers it.
    const plain = b + 1;
    expect(rows.map((r) => r.messageId).sort()).toEqual([b, plain, c].sort());
    expect(rows.find((r) => r.messageId === plain)).toMatchObject({ body: 'plain', requiresAck: false, deliveredAt: null });
    expect(rows.find((r) => r.messageId === c)).toMatchObject({ requiresAck: true });
    // So do Echo's undelivered notices to Alice (Bob deferred b and acknowledged a).
    expect(all.filter((r) => r.recipient === 'Alice').map((r) => [r.from, r.requiresAck])).toEqual([
      ['Echo', false],
      ['Echo', false],
    ]);
    await takeForHook(ctx, s.bob.id); // delivers the plain message (and c)
    expect((await pendingMessages(ctx, projectId)).filter((r) => r.recipient === 'Bob').map((r) => r.messageId).sort()).toEqual([b, c].sort());
    expect(rows.find((r) => r.messageId === b)).toMatchObject({ recipient: 'Bob', from: 'Alice', deferredUntil: '2026-11-18T20:30:00.000Z', deferReason: 'blocked', lastCheckedInAt: '2026-11-18T19:55:00.000Z', escalateAt: null, escalatedAt: null });
    expect(rows.find((r) => r.messageId === c)).toMatchObject({ escalateAt: '2026-11-18T20:20:00.000Z', body: 'z' });
    expect(await pendingMessages(ctx, s.other.id)).toEqual([]);
  });
});

describe('send with a request_id', () => {
  const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
  const send = (actor: typeof s.aliceA, over: Partial<Parameters<typeof sendMessage>[2]> = {}) =>
    sendMessage(ctx, actor, { projectId, to: 'Bob', body: 'merge it', requiresAck: true, requestId: 'req-1', ...over });

  it('runs the real migration: a partial unique index exists and takes ON CONFLICT DO NOTHING', async () => {
    const idx = await env.DB.prepare(`SELECT sql FROM sqlite_master WHERE name='messages_request_id_uq'`).first<{ sql: string }>();
    expect(idx!.sql).toMatch(/WHERE request_id IS NOT NULL/);
    await env.DB.prepare(`INSERT INTO messages (project_id, sender_agent_id, sender_label, body, created_at, request_id) VALUES (1,1,'a','b','t','dup')`).run();
    const again = await env.DB.prepare(
      `INSERT INTO messages (project_id, sender_agent_id, sender_label, body, created_at, request_id) VALUES (1,1,'a','b','t','dup') ON CONFLICT DO NOTHING`,
    ).run();
    expect(again.meta.changes).toBe(0);
    // NULL request ids never conflict.
    for (let i = 0; i < 2; i++) {
      await env.DB.prepare(`INSERT INTO messages (project_id, sender_agent_id, sender_label, body, created_at) VALUES (1,1,'a','b','t')`).run();
    }
    expect(await count('messages')).toBe(3);
  });

  it('a repeat returns the original id and recipients and stores one message, one recipient row, one change', async () => {
    const first = await send(s.aliceA);
    expect(first).toEqual({ messageId: expect.any(Number), recipients: ['Bob'], duplicate: false });
    ctx.setNow('2026-11-18T20:05:00.000Z');
    const second = await send(s.aliceA);
    expect(second).toEqual({ messageId: first.messageId, recipients: ['Bob'], duplicate: true });
    expect(await count('messages')).toBe(1);
    expect(await count('message_recipients')).toBe(1);
    const sent = (await changesSince(ctx, projectId, 0, 500)).filter((c) => c.kind === 'message.sent');
    expect(sent).toHaveLength(1);
    expect(sent[0].subjectId).toBe(first.messageId);
  });

  it('a repeat to "all" returns the original recipients even after the roster changed', async () => {
    const first = await send(s.aliceA, { to: 'all' });
    await env.DB.prepare(`DELETE FROM project_agents WHERE agent_id = ?`).bind(s.bob.id).run();
    const again = await send(s.aliceA, { to: 'all' });
    expect(again).toEqual({ messageId: first.messageId, recipients: first.recipients, duplicate: true });
    expect(await count('messages')).toBe(1);
  });

  it('a different sender with the same request_id is independent', async () => {
    const a = await send(s.aliceA);
    const b = await send(s.bobA, { to: 'Alice' });
    expect(b.duplicate).toBe(false);
    expect(b.messageId).not.toBe(a.messageId);
    expect(await count('messages')).toBe(2);
  });

  it('the same request_id in a different project is independent', async () => {
    const a = await send(s.aliceA);
    await env.DB.prepare(`INSERT INTO project_agents (project_id, agent_id) VALUES (?, ?)`).bind(s.other.id, s.alice.id).run();
    const b = await sendMessage(ctx, s.aliceA, { projectId: s.other.id, to: 'Carol', body: 'merge it', requiresAck: true, requestId: 'req-1' });
    expect(b.duplicate).toBe(false);
    expect(b.messageId).not.toBe(a.messageId);
    expect(await count('messages')).toBe(2);
  });

  it('refuses a repeat with a different body or requires_ack, naming the original, and stores nothing', async () => {
    const first = await send(s.aliceA);
    const p = send(s.aliceA, { body: 'merge it NOT' });
    await expect(p).rejects.toMatchObject({ kind: 'rule', code: 'REQUEST_ID_REUSED', status: 409, message: expect.stringContaining(`message ${first.messageId}`) });
    await expect(send(s.aliceA, { requiresAck: false })).rejects.toMatchObject({ code: 'REQUEST_ID_REUSED' });
    await env.DB.prepare(`INSERT INTO project_agents (project_id, agent_id) VALUES (?, ?)`).bind(projectId, s.carol.id).run();
    await expect(send(s.aliceA, { to: 'Carol' })).rejects.toMatchObject({ code: 'REQUEST_ID_REUSED' });
    expect(await send(s.aliceA, { to: 'bob' })).toMatchObject({ messageId: first.messageId, duplicate: true });
    expect(await count('messages')).toBe(1);
    expect(await count('message_recipients')).toBe(1);
  });

  it('concurrent sends with one request_id store one row and agree on the id', async () => {
    const rs = await Promise.all(Array.from({ length: 5 }, () => send(s.aliceA)));
    expect(new Set(rs.map((r) => r.messageId)).size).toBe(1);
    expect(rs.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(await count('messages')).toBe(1);
    expect(await count('message_recipients')).toBe(1);
    expect((await changesSince(ctx, projectId, 0, 500)).filter((c) => c.kind === 'message.sent')).toHaveLength(1);
  });

  it('a repeat with to spelled differently from "all" is judged as a name, as a fresh send would be', async () => {
    await send(s.aliceA, { to: 'all' });
    await expect(send(s.aliceA, { to: 'ALL' })).rejects.toMatchObject({ code: 'REQUEST_ID_REUSED' });
    await expect(send(s.aliceA, { to: ' all' })).rejects.toMatchObject({ code: 'REQUEST_ID_REUSED' });
    expect(await count('messages')).toBe(1);
  });

  it('a send without request_id issues no SQL that mentions request_id (a deploy before the migration only breaks the new feature)', async () => {
    const seen: string[] = [];
    const spy = {
      ...ctx,
      db: {
        prepare: (q: string) => (seen.push(q), env.DB.prepare(q)),
        batch: (b: D1PreparedStatement[]) => env.DB.batch(b),
      } as unknown as D1Database,
    };
    await sendMessage(spy, s.aliceA, { projectId, to: 'Bob', body: 'plain', requiresAck: false });
    expect(seen.some((q) => /INSERT INTO messages/.test(q))).toBe(true);
    expect(seen.filter((q) => /request_id/.test(q))).toEqual([]);
    await sendMessage(spy, s.aliceA, { projectId, to: 'Bob', body: 'keyed', requiresAck: false, requestId: 'k-1' });
    expect(seen.some((q) => /request_id/.test(q))).toBe(true);
  });

  // The same guard for every other path through newMessageStmts: they must never name request_id, or a deploy
  // that lands before migration 0002 would break holds, approvals and notices too.
  const recordSql = () => {
    const seen: string[] = [];
    const spy = {
      ...ctx,
      db: {
        prepare: (q: string) => (seen.push(q), env.DB.prepare(q)),
        batch: (b: D1PreparedStatement[]) => env.DB.batch(b),
      } as unknown as D1Database,
    };
    return { seen, spy };
  };
  const mentioning = (seen: string[]) => seen.filter((q) => /request_id/.test(q));

  it('the guarded notice path (notices, approval requests) issues no SQL that mentions request_id', async () => {
    const { seen, spy } = recordSql();
    const stmts = noticeStmts(spy, { project_id: projectId, sender_agent_id: s.alice.id }, 'a notice');
    expect(seen.some((q) => /INSERT INTO messages/.test(q) && /changes\(\) > 0/.test(q))).toBe(true);
    expect(mentioning(seen)).toEqual([]);
    await env.DB.batch([env.DB.prepare('SELECT 1'), ...stmts]);
  });

  it('placing a hold issues no SQL that mentions request_id', async () => {
    const { seen, spy } = recordSql();
    await placeHold(spy, s.aliceA, { repo: 'acme/app', pr: 5, reason: 'blocking finding' });
    expect(seen.some((q) => /INSERT INTO messages/.test(q))).toBe(true);
    expect(mentioning(seen)).toEqual([]);
  });

  it('acknowledging a hold (which sends the placer a notice) issues no SQL that mentions request_id', async () => {
    const hold = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 5, reason: 'blocking finding' });
    const { seen, spy } = recordSql();
    await ackHold(spy, s.bob.id, hold.id, 'noted');
    expect(seen.some((q) => /INSERT INTO messages/.test(q))).toBe(true);
    expect(mentioning(seen)).toEqual([]);
  });

  it('refuses a malformed request_id', async () => {
    for (const bad of ['', 'a b', 'x'.repeat(65)]) {
      await expect(send(s.aliceA, { requestId: bad })).rejects.toMatchObject({ code: 'BAD_REQUEST_ID' });
    }
    expect(await count('messages')).toBe(0);
  });

  it('without a request_id nothing changes: identical sends are separate messages and the reply has no duplicate', async () => {
    const a = await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'same', requiresAck: false });
    const b = await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'same', requiresAck: false });
    expect(Object.keys(a).sort()).toEqual(['messageId', 'recipients']);
    expect(b.messageId).not.toBe(a.messageId);
    expect(await count('messages')).toBe(2);
    const row = await env.DB.prepare(`SELECT request_id FROM messages WHERE id = ?`).bind(a.messageId).first<{ request_id: string | null }>();
    expect(row!.request_id).toBeNull();
  });
});
