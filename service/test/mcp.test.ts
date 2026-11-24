import { beforeEach, describe, expect, it, vi } from 'vitest';
import { revokeAgent } from '../src/domain/agents';
import { registerApprovals } from '../src/domain/approvals';
import { addEvent } from '../src/domain/calendar';
import { listHolds, placeHold } from '../src/domain/holds';
import { readInbox, sendMessage } from '../src/domain/messages';
import { serviceError, ruleError } from '../src/errors';
import { toolResult } from '../src/mcp/result';
import { seed, testCtx } from './helpers';
import { mcpCall, mcpRaw } from './mcp-client';

const ctx = testCtx();
let s: Awaited<ReturnType<typeof seed>>;
let SLOT: string; // a merge slot 10 minutes away, inside its own approval window
let SLOT_UTC: string;

// The Worker under test (SELF) reads the real clock, so anything time-relative is built from the real now.
const minutesFromNow = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
const within = (iso: string, expectedMs: number, slackMs = 30_000) => Math.abs(Date.parse(iso) - expectedMs) <= slackMs;

beforeEach(async () => {
  ctx.setNow(new Date().toISOString());
  SLOT_UTC = minutesFromNow(10);
  SLOT = SLOT_UTC;
  s = await seed(ctx);
  registerApprovals(); // other test files clear the calendar hooks
});

/** Calls a tool and parses its JSON text; fails loudly if the call was refused. */
async function ok(token: string, tool: string, args: unknown): Promise<any> {
  const r = await mcpCall(token, tool, args);
  if (r.isError) throw new Error(`${tool} refused: ${r.text}`);
  return JSON.parse(r.text);
}

const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

describe('identity', () => {
  it('whoami returns name, projects and server time', async () => {
    expect(JSON.parse((await mcpCall(s.alice.token, 'echo_whoami', {})).text)).toEqual({
      name: 'Alice',
      projects: ['core'],
      now: expect.stringMatching(/Z$/),
    });
  });

  it('tools/list names every tool, carries the required descriptions, and never exposes an internal time field', async () => {
    const { status, json } = await mcpRaw(s.alice.token, 'tools/list', {});
    expect(status).toBe(200);
    const tools: { name: string; description: string; inputSchema: any }[] = json.result.tools;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(
      [
        'echo_whoami',
        'echo_send_message', 'echo_inbox', 'echo_ack_message', 'echo_defer_message', 'echo_message_status', 'echo_withdraw_message',
        'echo_place_hold', 'echo_list_holds', 'echo_ack_hold', 'echo_release_hold',
        'echo_pending_approvals', 'echo_approve_merge', 'echo_object_merge',
        'echo_calendar_add', 'echo_calendar_list', 'echo_calendar_update', 'echo_calendar_cancel',
        'echo_todo_add', 'echo_todo_list', 'echo_todo_claim', 'echo_todo_release', 'echo_todo_complete',
        'echo_scratchpad_append', 'echo_scratchpad_read',
        'echo_doc_save', 'echo_doc_get', 'echo_doc_list', 'echo_doc_versions', 'echo_changes_since',
        'echo_data_get', 'echo_data_list', 'echo_data_put', 'echo_data_delete', 'echo_data_batch', 'echo_data_history',
      ].sort(),
    );
    expect(byName.echo_send_message.description).toMatch(/document/i);
    expect(byName.echo_ack_message.description).toMatch(/does not clear the hold/i);
    expect(byName.echo_ack_message.description).toMatch(/defer/i);
    expect(byName.echo_ack_hold.description).toMatch(/does not clear the block/i);
    // Every schema is closed, and the internal absolute escalation time is nowhere to be seen.
    for (const t of tools) expect(t.inputSchema.additionalProperties).toBe(false);
    expect(JSON.stringify(tools)).not.toMatch(/escalateAt|escalate_at/);
    expect(Object.keys(byName.echo_send_message.inputSchema.properties)).toContain('escalate_after_minutes');
    expect(Object.keys(byName.echo_send_message.inputSchema.properties)).toContain('request_id');
    expect(byName.echo_send_message.description).toMatch(/SAME request_id/);
    expect(Object.keys(byName.echo_calendar_add.inputSchema.properties)).toEqual(
      expect.arrayContaining(['project', 'title', 'starts_at', 'merger', 'approvers']),
    );
  });
});

describe('errors', () => {
  it('a rule error is distinguishable from a service error', async () => {
    const r = await mcpCall(s.alice.token, 'echo_send_message', { project: 'core', to: 'Bob', body: 'x'.repeat(9000), requires_ack: false });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Refused \(rule MESSAGE_TOO_LARGE\)/);
    expect(r.text).toMatch(/\nWhat to do: .+document/);

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const rule = await toolResult(async () => {
        throw ruleError('SOME_RULE', 'You broke it.', 'Fix it.');
      });
      expect(rule).toEqual({ isError: true, content: [{ type: 'text', text: 'Refused (rule SOME_RULE): You broke it.\nWhat to do: Fix it.' }] });

      const svc = await toolResult(async () => {
        throw serviceError('DB_DOWN', 'The database did not answer.');
      });
      expect(svc.isError).toBe(true);
      expect(svc.content[0].text).toMatch(/^Echo service problem \(DB_DOWN\): The database did not answer\.\nWhat to do: .*Retry/);

      const unknown = await toolResult(async () => {
        throw new Error('boom with internals');
      });
      expect(unknown.isError).toBe(true);
      expect(unknown.content[0].text).toMatch(/^Echo service problem \(INTERNAL\)/);
      expect(unknown.content[0].text).not.toMatch(/boom/);

      const fine = await toolResult(async () => ({ a: 1 }));
      expect(fine).toEqual({ content: [{ type: 'text', text: '{"a":1}' }] });
    } finally {
      spy.mockRestore();
    }
  });

  it('missing or revoked token gets HTTP 401 before MCP handling', async () => {
    const none = await mcpRaw(null, 'tools/list', {});
    expect(none.status).toBe(401);
    expect(none.json).toMatchObject({ ok: false, error: { kind: 'rule' } });
    const bad = await mcpRaw('echo_not-a-real-token', 'tools/list', {});
    expect(bad.status).toBe(401);

    expect((await mcpRaw(s.bob.token, 'tools/list', {})).status).toBe(200);
    await revokeAgent(ctx, s.bob.id);
    const revoked = await mcpRaw(s.bob.token, 'tools/call', { name: 'echo_whoami', arguments: {} });
    expect(revoked.status).toBe(401);
    expect(revoked.json.result).toBeUndefined();
  });

  it('an agent cannot act on a project it is not in', async () => {
    const send = await mcpCall(s.alice.token, 'echo_send_message', { project: 'other', to: 'Carol', body: 'hi', requires_ack: false });
    expect(send.isError).toBe(true);
    expect(send.text).toMatch(/^Refused \(rule NOT_MEMBER\)/);
    const nope = await mcpCall(s.alice.token, 'echo_inbox', { project: 'does-not-exist' });
    expect(nope.text).toMatch(/^Refused \(rule NOT_MEMBER\)/);
    const cal = await mcpCall(s.alice.token, 'echo_calendar_add', { project: 'other', title: 't', starts_at: '2026-11-19T03:00:00Z' });
    expect(cal.text).toMatch(/^Refused \(rule NOT_MEMBER\)/);
    expect(await ctx.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE project_id = ?`).bind(s.other.id).first('n')).toBe(0);

    // A hold on a repository of a project the caller is not in is refused too.
    await ctx.db.prepare(`INSERT INTO repos (full_name, project_id, installation_id) VALUES ('acme/theirs', ?, NULL)`).bind(s.other.id).run();
    const hold = await mcpCall(s.alice.token, 'echo_place_hold', { repo: 'acme/theirs', pr: 1, reason: 'x' });
    expect(hold.isError).toBe(true);
    expect(hold.text).toMatch(/^Refused \(rule NOT_MEMBER\)/);
    expect(await listHolds(ctx, s.carol.id)).toEqual([]);
  });
});

describe('echo_send_message request_id', () => {
  const send = (token: string, extra: Record<string, unknown>) =>
    mcpCall(token, 'echo_send_message', { project: 'core', to: 'Bob', body: 'hi', requires_ack: false, ...extra });

  it('a retry returns the original id with duplicate: true; without request_id the reply has no duplicate field', async () => {
    const a = await ok(s.alice.token, 'echo_send_message', { project: 'core', to: 'Bob', body: 'hi', requires_ack: false, request_id: 'r-1' });
    expect(a).toEqual({ message_id: expect.any(Number), recipients: ['Bob'], duplicate: false });
    const b = await ok(s.alice.token, 'echo_send_message', { project: 'core', to: 'Bob', body: 'hi', requires_ack: false, request_id: 'r-1' });
    expect(b).toEqual({ message_id: a.message_id, recipients: ['Bob'], duplicate: true });
    const plain = await ok(s.alice.token, 'echo_send_message', { project: 'core', to: 'Bob', body: 'hi', requires_ack: false });
    expect(Object.keys(plain).sort()).toEqual(['message_id', 'recipients']);
  });

  it('refuses a malformed request_id and a different body, and stores nothing for either', async () => {
    for (const bad of ['', 'x'.repeat(65), 'has space', 'ünï']) {
      const r = await send(s.alice.token, { request_id: bad });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^Refused \(rule BAD_REQUEST\)/);
    }
    const rows = async () => ({
      messages: await ctx.db.prepare(`SELECT COUNT(*) AS n FROM messages`).first('n'),
      recipients: await ctx.db.prepare(`SELECT COUNT(*) AS n FROM message_recipients`).first('n'),
      sent: await ctx.db.prepare(`SELECT COUNT(*) AS n FROM change_log WHERE kind = 'message.sent'`).first('n'),
    });
    expect(await rows()).toEqual({ messages: 0, recipients: 0, sent: 0 });
    await ok(s.alice.token, 'echo_send_message', { project: 'core', to: 'Bob', body: 'hi', requires_ack: false, request_id: 'r-2' });
    const r = await send(s.alice.token, { request_id: 'r-2', body: 'changed' });
    expect(r.text).toMatch(/^Refused \(rule REQUEST_ID_REUSED\)/);
    expect(await rows()).toEqual({ messages: 1, recipients: 1, sent: 1 });
  });
});

describe('strict input (spec scenario 18)', () => {
  it('an agent-supplied timestamp field is refused with BAD_REQUEST naming the field', async () => {
    const r = await mcpCall(s.alice.token, 'echo_send_message', {
      project: 'core', to: 'Bob', body: 'hi', requires_ack: false, sent_at: '2020-01-01T00:00:00Z',
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Refused \(rule BAD_REQUEST\):/);
    expect(r.text).toContain('"sent_at"');
    expect(await ctx.db.prepare(`SELECT COUNT(*) AS n FROM messages`).first('n')).toBe(0);
  });

  it('the internal escalateAt is not accepted, and escalate_after_minutes is', async () => {
    const bad = await mcpCall(s.alice.token, 'echo_send_message', {
      project: 'core', to: 'Bob', body: 'hi', requires_ack: true, escalateAt: '2026-11-18T21:00:00Z',
    });
    expect(bad.text).toMatch(/^Refused \(rule BAD_REQUEST\):.*"escalateAt"/);
    const good = await ok(s.alice.token, 'echo_send_message', { project: 'core', to: 'Bob', body: 'hi', requires_ack: true, escalate_after_minutes: 15 });
    const status = await ok(s.alice.token, 'echo_message_status', { message_id: good.message_id });
    expect(within(status[0].escalateAt, Date.now() + 15 * 60_000)).toBe(true);
  });

  it('wrong types and missing fields are BAD_REQUEST naming the field', async () => {
    const r = await mcpCall(s.alice.token, 'echo_defer_message', { message_id: 'one', for_minutes: 10 });
    expect(r.text).toMatch(/^Refused \(rule BAD_REQUEST\):/);
    expect(r.text).toContain('message_id');
    expect(r.text).toContain('reason');
  });

  it('a starts_at without a zone is refused', async () => {
    const r = await mcpCall(s.alice.token, 'echo_calendar_add', { project: 'core', title: 't', starts_at: '2026-11-18T21:00:00' });
    expect(r.text).toMatch(/^Refused \(rule TIME_NEEDS_ZONE\)/);
  });
});

describe('messages', () => {
  it('send, inbox, defer, ack, status and withdraw work end to end', async () => {
    const sent = await ok(s.alice.token, 'echo_send_message', { project: 'core', to: 'Bob', body: 'please review', requires_ack: true });
    expect(sent).toEqual({ message_id: expect.any(Number), recipients: ['Bob'] });

    const inbox = await ok(s.bob.token, 'echo_inbox', { project: 'core' });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ messageId: sent.message_id, from: 'Alice', body: 'please review', requiresAck: true, projectName: 'core', acknowledged: false });
    expect(inbox[0].sentAt).toMatch(ISO_Z);

    const deferred = await ok(s.bob.token, 'echo_defer_message', { message_id: sent.message_id, for_minutes: 30, reason: 'waiting on the owner' });
    expect(deferred).toEqual({ ok: true });
    const midway = await ok(s.alice.token, 'echo_message_status', { message_id: sent.message_id });
    expect(midway[0].recipients[0]).toMatchObject({ name: 'Bob', delivered: true, acknowledged: false, deferReason: 'waiting on the owner' });
    expect(within(midway[0].recipients[0].deferredUntil, Date.now() + 30 * 60_000)).toBe(true);

    await ok(s.bob.token, 'echo_ack_message', { message_id: sent.message_id, note: 'done' });
    const after = await ok(s.alice.token, 'echo_message_status', {});
    expect(after[0].recipients[0]).toMatchObject({ acknowledged: true, note: 'done' });

    const second = await ok(s.alice.token, 'echo_send_message', { project: 'core', to: 'Bob', body: 'never mind' });
    await ok(s.alice.token, 'echo_withdraw_message', { message_id: second.message_id });
    expect((await mcpCall(s.bob.token, 'echo_ack_message', { message_id: second.message_id })).text).toMatch(/^Refused \(rule MESSAGE_WITHDRAWN\)/);
    expect(await readInbox(ctx, s.bob.id)).toEqual([]);
  });

  it('only the sender can withdraw', async () => {
    const sent = await ok(s.alice.token, 'echo_send_message', { project: 'core', to: 'Bob', body: 'x' });
    const r = await mcpCall(s.bob.token, 'echo_withdraw_message', { message_id: sent.message_id });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Refused \(rule /);
  });
});

describe('holds', () => {
  it('place_hold defaults to blocking', async () => {
    const placed = await ok(s.alice.token, 'echo_place_hold', { repo: 'ACME/app', pr: 709, reason: 'SQL injection in search' });
    expect(placed).toMatchObject({ repo: 'acme/app', pr: 709, kind: 'blocking', blocksMerge: true, placedBy: 'Alice', state: 'open' });
    expect(placed.placedAt).toMatch(ISO_Z);
    const listed = await ok(s.bob.token, 'echo_list_holds', { project: 'core' });
    expect(listed.map((h: any) => h.id)).toEqual([placed.id]);

    const adv = await ok(s.alice.token, 'echo_place_hold', { repo: 'acme/app', pr: 710, reason: 'heads up', kind: 'advisory' });
    // An advisory hold stops the merge only until someone acknowledges it.
    expect(adv).toMatchObject({ kind: 'advisory', blocksMerge: true });
    await ok(s.bob.token, 'echo_ack_hold', { hold_id: adv.id, note: 'noted' });
    const [, advAfter] = await ok(s.bob.token, 'echo_list_holds', { state: 'all' });
    expect(advAfter).toMatchObject({ id: adv.id, kind: 'advisory', blocksMerge: false });

  });

  it('object_merge by an approver creates a blocking hold on the PR', async () => {
    await ctx.db.prepare(`UPDATE projects SET approvals_required = 1 WHERE id = ?`).bind(s.project.id).run();
    const ev = await addEvent(ctx, s.bobA, {
      projectId: s.project.id, title: 'm', startsAt: SLOT, kind: 'merge', repo: 'acme/app', pr: 709,
    });
    const pending = await ok(s.alice.token, 'echo_pending_approvals', {});
    expect(pending).toEqual([expect.objectContaining({ eventId: ev.id, repo: 'acme/app', pr: 709, startsAt: SLOT_UTC, merger: 'Bob' })]);

    const hold = await ok(s.alice.token, 'echo_object_merge', { event_id: ev.id, reason: 'tests are flaky on main' });
    expect(hold).toMatchObject({ kind: 'blocking', blocksMerge: true, pr: 709, placedBy: 'Alice' });
    expect(hold.reason).toContain('tests are flaky on main');
    expect((await listHolds(ctx, s.bob.id, { state: 'open' })).map((h) => h.id)).toEqual([hold.id]);
    expect(await ok(s.alice.token, 'echo_pending_approvals', {})).toEqual([]);
  });

  it('approve_merge records an approval', async () => {
    await ctx.db.prepare(`UPDATE projects SET approvals_required = 1 WHERE id = ?`).bind(s.project.id).run();
    const ev = await addEvent(ctx, s.bobA, {
      projectId: s.project.id, title: 'm', startsAt: SLOT, kind: 'merge', repo: 'acme/app', pr: 709,
    });
    expect(await ok(s.alice.token, 'echo_approve_merge', { event_id: ev.id })).toEqual({ ok: true });
    const row = await ctx.db.prepare(`SELECT response FROM event_approvers WHERE event_id = ? AND agent_id = ?`).bind(ev.id, s.alice.id).first<{ response: string }>();
    expect(row?.response).toBe('approved');
    expect(await ok(s.alice.token, 'echo_pending_approvals', {})).toEqual([]);
    // Bob is the merger and not an approver.
    expect((await mcpCall(s.bob.token, 'echo_approve_merge', { event_id: ev.id })).text).toMatch(/^Refused \(rule /);
  });

  it('ack_hold records an advisory acknowledgment without clearing a blocking hold; release clears it', async () => {
    const hold = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 709, reason: 'blocking finding' });
    await ok(s.bob.token, 'echo_ack_hold', { hold_id: hold.id, note: 'seen' });
    const [after] = await ok(s.bob.token, 'echo_list_holds', {});
    expect(after.acknowledged).toMatchObject({ by: 'Bob', note: 'seen' });
    expect(after.blocksMerge).toBe(true);
    expect(after.acknowledged.at).toMatch(ISO_Z);

    await ok(s.alice.token, 'echo_release_hold', { hold_id: hold.id, note: 'fixed in abc123' });
    expect(await ok(s.bob.token, 'echo_list_holds', {})).toEqual([]);
    const all = await ok(s.bob.token, 'echo_list_holds', { state: 'all' });
    expect(all[0]).toMatchObject({ state: 'released', released: { by: 'Alice', note: 'fixed in abc123' } });

    const again = await mcpCall(s.bob.token, 'echo_release_hold', { hold_id: hold.id, note: 'me too' });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/^Refused \(rule /);
    expect(again.text).toContain('Alice');
  });
});

describe('calendar', () => {
  it('add stores a zoned time as UTC, list and update and cancel follow', async () => {
    const ev = await ok(s.alice.token, 'echo_calendar_add', { project: 'core', title: 'Release freeze', starts_at: '2026-11-18T21:00:00-06:00', importance: 'high' });
    expect(ev).toMatchObject({ title: 'Release freeze', startsAt: '2026-11-19T03:00:00.000Z', enteredAs: '2026-11-18T21:00:00-06:00', importance: 'high', cancelled: false });

    const listed = await ok(s.bob.token, 'echo_calendar_list', { project: 'core', from: '2026-11-19T00:00:00Z', to: '2026-11-20T00:00:00Z' });
    expect(listed.map((e: any) => e.id)).toEqual([ev.id]);
    expect(listed[0].startsAt).toMatch(ISO_Z);
    expect(await ok(s.bob.token, 'echo_calendar_list', { project: 'core', from: '2026-11-20T00:00:00Z', to: '2026-11-21T00:00:00Z' })).toEqual([]);

    const moved = await ok(s.alice.token, 'echo_calendar_update', { event_id: ev.id, starts_at: '2026-11-19T10:00:00Z', title: 'Freeze' });
    expect(moved).toMatchObject({ title: 'Freeze', startsAt: '2026-11-19T10:00:00.000Z' });

    expect(await ok(s.alice.token, 'echo_calendar_cancel', { event_id: ev.id })).toEqual({ ok: true });
    const [cancelled] = await ok(s.bob.token, 'echo_calendar_list', { project: 'core', from: '2026-11-19T00:00:00Z', to: '2026-11-20T00:00:00Z' });
    expect(cancelled.cancelled).toBe(true);
  });

  it('a merge event names the merger and, where required, the approvers', async () => {
    await ctx.db.prepare(`UPDATE projects SET approvals_required = 1 WHERE id = ?`).bind(s.project.id).run();
    const ev = await ok(s.alice.token, 'echo_calendar_add', {
      project: 'core', title: 'Merge 709', starts_at: SLOT, kind: 'merge', repo: 'acme/app', pr: 709, merger: 'Bob', approvers: ['Alice'],
    });
    expect(ev).toMatchObject({ kind: 'merge', repo: 'acme/app', pr: 709, merger: 'Bob' });
    expect(await ok(s.alice.token, 'echo_pending_approvals', {})).toEqual([expect.objectContaining({ eventId: ev.id, merger: 'Bob' })]);
  });

  describe('a merge event says who must approve', () => {
    const require1 = () => ctx.db.prepare(`UPDATE projects SET approvals_required = 1 WHERE id = ?`).bind(s.project.id).run();
    const window = (startsAt: string) => ({
      windowStart: new Date(Date.parse(startsAt) - 30 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      windowEnd: new Date(Date.parse(startsAt) + 30 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    });

    it('the default approvers are named in the reply, with the window', async () => {
      await require1();
      const ev = await ok(s.alice.token, 'echo_calendar_add', { project: 'core', title: 'Merge 1', starts_at: SLOT, kind: 'merge', repo: 'acme/app', pr: 1 });
      expect(ev).toMatchObject({ kind: 'merge', approvalRequired: true, approvers: [{ name: 'Bob', response: null, at: null, by: null }], ...window(SLOT_UTC) });
    });

    it('explicit approvers are named', async () => {
      await require1();
      const ev = await ok(s.alice.token, 'echo_calendar_add', {
        project: 'core', title: 'Merge 2', starts_at: SLOT, kind: 'merge', repo: 'acme/app', pr: 2, merger: 'Bob', approvers: ['Alice'],
      });
      expect(ev).toMatchObject({ approvalRequired: true, approvers: [{ name: 'Alice', response: null, at: null, by: null }] });
    });

    it('with approvals off: approvalRequired false, no approvers, no window', async () => {
      const ev = await ok(s.alice.token, 'echo_calendar_add', { project: 'core', title: 'Merge 3', starts_at: SLOT, kind: 'merge', repo: 'acme/app', pr: 3 });
      expect(ev).toMatchObject({ approvalRequired: false, approvers: [] });
      expect(ev).not.toHaveProperty('windowStart');
      expect(ev).not.toHaveProperty('windowEnd');
    });

    it('a plain event carries none of these fields', async () => {
      const ev = await ok(s.alice.token, 'echo_calendar_add', { project: 'core', title: 'Freeze', starts_at: SLOT });
      expect(ev).not.toHaveProperty('approvalRequired');
    });

    it('a move returns the new window and the approvers who were asked again', async () => {
      await require1();
      const ev = await ok(s.alice.token, 'echo_calendar_add', { project: 'core', title: 'Merge 4', starts_at: SLOT, kind: 'merge', repo: 'acme/app', pr: 4 });
      const later = new Date(Date.parse(SLOT_UTC) + 3 * 3_600_000).toISOString();
      const moved = await ok(s.alice.token, 'echo_calendar_update', { event_id: ev.id, starts_at: later });
      expect(moved).toMatchObject({ startsAt: later, approvalRequired: true, approvers: [{ name: 'Bob', response: null, at: null, by: null }], ...window(later) });
    });
  });

  it('another project cannot see or change the event', async () => {
    const ev = await ok(s.alice.token, 'echo_calendar_add', { project: 'core', title: 'x', starts_at: '2026-11-19T03:00:00Z' });
    expect((await mcpCall(s.carol.token, 'echo_calendar_cancel', { event_id: ev.id })).text).toMatch(/^Refused \(rule NOT_MEMBER\)/);
    expect((await mcpCall(s.carol.token, 'echo_calendar_update', { event_id: ev.id, title: 'y' })).text).toMatch(/^Refused \(rule NOT_MEMBER\)/);
  });
});

describe('direct domain state matches what tools show', () => {
  it('a message sent by the domain shows in the tool inbox with a UTC Z time', async () => {
    await sendMessage(ctx, s.aliceA, { projectId: s.project.id, to: 'Bob', body: 'direct', requiresAck: false });
    const inbox = await ok(s.bob.token, 'echo_inbox', {});
    expect(inbox[0].body).toBe('direct');
    expect(inbox[0].sentAt).toBe(ctx.now());
    expect(inbox[0].deliveredAt).toMatch(ISO_Z);
  });
});
