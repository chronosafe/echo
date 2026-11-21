import type { Ctx } from '../ctx';
import { EchoError, ruleError } from '../errors';
import { addMinutes, parseZonedTime } from '../time';
import type { Actor } from '../types';
import { actorLabel } from '../types';
import { changeStmt } from './changelog';
import { requireMember } from './projects';

export const MAX_MESSAGE_BYTES = 8192;

export type MessageKind = 'plain' | 'hold' | 'approval_request' | 'system';

export type SendInput = {
  projectId: number;
  to: string;
  body: string;
  requiresAck: boolean;
  escalateAfterMin?: number;
  /**
   * Internal only: an absolute UTC ISO time, set by domain code (approval requests).
   * Never exposed through an API or MCP schema. Exclusive with escalateAfterMin; needs requiresAck.
   */
  escalateAt?: string;
  kind?: MessageKind;
  refId?: number;
  /**
   * Client-chosen idempotency key (agent senders only). Repeating it from the same sender in the same project
   * stores nothing new and returns the original message with duplicate: true.
   */
  requestId?: string;
};

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

export type InboxItem = {
  messageId: number;
  projectId: number;
  projectName: string;
  kind: MessageKind;
  refId: number | null;
  from: string;
  body: string;
  requiresAck: boolean;
  sentAt: string;
  deliveredAt: string | null;
  deferredUntil: string | null;
  acknowledged: boolean;
};

export type SentStatus = {
  messageId: number;
  sentAt: string;
  withdrawn: boolean;
  escalateAt: string | null;
  recipients: {
    name: string;
    delivered: boolean;
    deferredUntil: string | null;
    deferReason: string | null;
    acknowledged: boolean;
    note: string | null;
    escalated: boolean;
  }[];
};

export type PendingRow = {
  messageId: number;
  projectId: number;
  from: string;
  body: string;
  sentAt: string;
  escalateAt: string | null;
  requiresAck: boolean;
  recipientId: number;
  recipient: string;
  deliveredAt: string | null;
  deferredUntil: string | null;
  deferReason: string | null;
  escalatedAt: string | null;
  lastCheckedInAt: string | null;
};

const ECHO: Actor = { kind: 'system', name: 'Echo' };
const ADMIN: Actor = { kind: 'admin' };

// ---------------------------------------------------------------- helpers

function bytesOf(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** To-do and event titles share the message limit (8,192 bytes of UTF-8). */
export function checkTitleSize(title: string, what: 'to-do' | 'event'): void {
  const n = bytesOf(title);
  if (n > MAX_MESSAGE_BYTES) {
    throw ruleError(
      'TITLE_TOO_LARGE',
      `The ${what} title is ${n} bytes; the limit is ${MAX_MESSAGE_BYTES}.`,
      `Keep the title short: ${what} titles are limited to ${MAX_MESSAGE_BYTES} bytes. Put the detail in a project document (echo_doc_save) and name the document in the title.`,
    );
  }
}

function minutesOk(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 1440;
}

function badMinutes(n: number) {
  return ruleError('BAD_MINUTES', `${n} minutes is not allowed.`, 'Use a whole number of minutes from 1 to 1440.');
}

function excerpt(body: string): string {
  const one = body.replace(/\s+/g, ' ').trim();
  return one.length > 80 ? one.slice(0, 77) + '...' : one;
}

export type NewMessage = {
  projectId: number;
  senderAgentId: number | null;
  label: string;
  body: string;
  requiresAck: boolean;
  escalateAt: string | null;
  kind: MessageKind;
  refId: number | null;
  recipientIds: number[];
  /** Set only for an idempotent send: the insert then does nothing on a conflict and the rest of the group is skipped. */
  requestId?: string | null;
};

/**
 * Statements that store one message, its recipient rows and its change entry.
 * They must run in one db.batch(); D1 runs a batch as one transaction, so the
 * MAX(id) lookups below see the message inserted by the first statement.
 */
export function newMessageStmts(ctx: Ctx, actor: Actor, m: NewMessage, guarded = false): D1PreparedStatement[] {
  // guarded: every statement runs only if the one before it changed a row, so the whole group is
  // skipped when the statement ahead of it in the batch did not apply.
  // With a requestId the first insert is unguarded but ignored on a conflict with the unique request_id index
  // (changes() is then 0), so every later statement is guarded and the whole group is skipped.
  const idem = m.requestId != null;
  const rest = guarded || idem;
  const g = rest ? ' WHERE changes() > 0' : '';
  // The request_id column is named only for an idempotent send, so a deploy that lands before the migration
  // breaks just that feature, never plain sends, holds, approvals or notices.
  const cols = `project_id, sender_agent_id, sender_label, body, requires_ack, escalate_at, kind, ref_id, created_at${idem ? ', request_id' : ''}`;
  const marks = idem ? '?,?,?,?,?,?,?,?,?,?' : '?,?,?,?,?,?,?,?,?';
  const insert = ctx.db
    .prepare(
      guarded
        ? `INSERT INTO messages (${cols})
           SELECT ${marks}${g}`
        : `INSERT INTO messages (${cols})
           VALUES (${marks})${idem ? ' ON CONFLICT DO NOTHING' : ''}`,
    )
    .bind(m.projectId, m.senderAgentId, m.label, m.body, m.requiresAck ? 1 : 0, m.escalateAt, m.kind, m.refId, ctx.now(), ...(idem ? [m.requestId] : []));
  return [
    insert,
    ...m.recipientIds.map((id) =>
      ctx.db
        .prepare(
          rest
            ? `INSERT INTO message_recipients (message_id, agent_id) SELECT (SELECT MAX(id) FROM messages), ?${g}`
            : `INSERT INTO message_recipients (message_id, agent_id) VALUES ((SELECT MAX(id) FROM messages), ?)`,
        )
        .bind(id),
    ),
    changeStmt(
      ctx,
      { projectId: m.projectId, actor, kind: 'message.sent', data: { to: m.recipientIds, requiresAck: m.requiresAck, kind: m.kind } },
      { guarded: rest },
    ),
    ctx.db.prepare(
      `UPDATE change_log SET subject_id = (SELECT MAX(id) FROM messages)
       WHERE seq = (SELECT MAX(seq) FROM change_log)${rest ? ' AND changes() > 0' : ''}`,
    ),
  ];
}

/** A message from Echo to the original sender, or no statements when the sender is not an agent. */
export function noticeStmts(ctx: Ctx, original: { project_id: number; sender_agent_id: number | null }, body: string): D1PreparedStatement[] {
  if (original.sender_agent_id === null) return [];
  return newMessageStmts(
    ctx,
    ECHO,
    {
      projectId: original.project_id,
      senderAgentId: null,
      label: 'Echo',
      body,
      requiresAck: false,
      escalateAt: null,
      kind: 'system',
      refId: null,
      recipientIds: [original.sender_agent_id],
    },
    true,
  );
}

type ItemRow = {
  message_id: number;
  project_id: number;
  project_name: string;
  kind: MessageKind;
  ref_id: number | null;
  sender_label: string;
  body: string;
  requires_ack: number;
  created_at: string;
  delivered_at: string | null;
  deferred_until: string | null;
  acked_at: string | null;
};

const ITEM_SELECT = `
  SELECT m.id AS message_id, m.project_id, p.name AS project_name, m.kind, m.ref_id, m.sender_label, m.body,
         m.requires_ack, m.created_at, r.delivered_at, r.deferred_until, r.acked_at
  FROM message_recipients r
  JOIN messages m ON m.id = r.message_id
  JOIN projects p ON p.id = m.project_id
  JOIN project_agents pa ON pa.project_id = m.project_id AND pa.agent_id = r.agent_id
  WHERE r.agent_id = ? AND m.withdrawn_at IS NULL`;

function toItem(r: ItemRow): InboxItem {
  return {
    messageId: r.message_id,
    projectId: r.project_id,
    projectName: r.project_name,
    kind: r.kind,
    refId: r.ref_id,
    from: r.sender_label,
    body: r.body,
    requiresAck: r.requires_ack === 1,
    sentAt: r.created_at,
    deliveredAt: r.delivered_at,
    deferredUntil: r.deferred_until,
    acknowledged: r.acked_at !== null,
  };
}

async function itemsByIds(ctx: Ctx, agentId: number, messageIds: number[]): Promise<InboxItem[]> {
  if (!messageIds.length) return [];
  const { results } = await ctx.db
    .prepare(`${ITEM_SELECT} AND m.id IN (SELECT value FROM json_each(?)) ORDER BY m.id`)
    .bind(agentId, JSON.stringify(messageIds))
    .all<ItemRow>();
  return results.map(toItem);
}

/**
 * For an UPDATE of message_recipients: the row's message is not withdrawn and the agent (?1) is still in its
 * project. Correlated, so each candidate row looks its message up by id instead of reading every message.
 */
const VISIBLE_IDS = `EXISTS (
  SELECT 1 FROM messages m JOIN project_agents pa ON pa.project_id = m.project_id AND pa.agent_id = ?1
  WHERE m.id = message_recipients.message_id AND m.withdrawn_at IS NULL)`;

/** Deferred items whose time has passed come back: the deferral is cleared and they are reported once. */
async function resurfaceDeferred(ctx: Ctx, agentId: number): Promise<number[]> {
  const { results } = await ctx.db
    .prepare(
      `UPDATE message_recipients SET deferred_until = NULL
       WHERE agent_id = ?1 AND deferred_until IS NOT NULL AND deferred_until <= ?2 AND acked_at IS NULL AND ${VISIBLE_IDS}
       RETURNING message_id`,
    )
    .bind(agentId, ctx.now())
    .all<{ message_id: number }>();
  return results.map((r) => r.message_id);
}

/**
 * One UPDATE decides who delivered each item; only the rows it returns are fresh. The change entries
 * ride in the same batch, one per (message, agent), and only for rows this batch delivered.
 */
async function deliver(ctx: Ctx, agentId: number, onlyIds?: number[]): Promise<number[]> {
  const filter = onlyIds ? ` AND message_id IN (SELECT value FROM json_each(?3))` : '';
  const upd = ctx.db.prepare(
    `UPDATE message_recipients SET delivered_at = ?2
     WHERE agent_id = ?1 AND delivered_at IS NULL AND acked_at IS NULL AND ${VISIBLE_IDS}${filter}
     RETURNING message_id`,
  );
  const log = ctx.db.prepare(
    `INSERT INTO change_log (project_id, at, actor, kind, subject_id, data)
     SELECT m.project_id, ?2, a.name, 'message.delivered', r.message_id, NULL
     FROM message_recipients r JOIN messages m ON m.id = r.message_id JOIN agents a ON a.id = r.agent_id
     WHERE r.agent_id = ?1 AND r.delivered_at = ?2 AND r.acked_at IS NULL AND r.deferred_until IS NULL${
       onlyIds ? ' AND r.message_id IN (SELECT value FROM json_each(?3))' : ''
     }
       AND NOT EXISTS (SELECT 1 FROM change_log c WHERE c.kind = 'message.delivered' AND c.subject_id = r.message_id AND c.actor = a.name)`,
  );
  const args = onlyIds ? [agentId, ctx.now(), JSON.stringify(onlyIds)] : [agentId, ctx.now()];
  const [res] = await ctx.db.batch([upd.bind(...args), log.bind(...args)]);
  return (res.results as { message_id: number }[]).map((r) => r.message_id);
}

// ---------------------------------------------------------------- send

export type SendResult = { messageId: number; recipients: string[]; duplicate?: boolean };

/** The message this sender already stored under the request id, as a repeat's reply; refuses a different message. */
async function existingByRequestId(ctx: Ctx, projectId: number, senderId: number, requestId: string, input: SendInput): Promise<SendResult | null> {
  const row = await ctx.db
    .prepare('SELECT id, body, requires_ack FROM messages WHERE project_id = ? AND sender_agent_id = ? AND request_id = ?')
    .bind(projectId, senderId, requestId)
    .first<{ id: number; body: string; requires_ack: number }>();
  if (!row) return null;
  const { results } = await ctx.db
    .prepare('SELECT a.name FROM message_recipients r JOIN agents a ON a.id = r.agent_id WHERE r.message_id = ? ORDER BY a.name')
    .bind(row.id)
    .all<{ name: string }>();
  // A named recipient must be one the original went to ("all" is not compared: it expands with membership).
  const want = input.to.trim().toLowerCase();
  const otherRecipient = input.to !== 'all' && !results.some((r) => r.name.toLowerCase() === want);
  if (row.body !== input.body || (row.requires_ack === 1) !== input.requiresAck || otherRecipient) {
    throw ruleError(
      'REQUEST_ID_REUSED',
      `request_id "${requestId}" was already used for a different message (message ${row.id}); nothing was sent.`,
      `To retry message ${row.id}, send exactly the same to, body and requires_ack with the same request_id. To send a new message, use a new request_id.`,
      409,
    );
  }
  return { messageId: row.id, recipients: results.map((r) => r.name), duplicate: true };
}

export async function sendMessage(ctx: Ctx, actor: Actor, input: SendInput): Promise<SendResult> {
  if (!input.body.trim()) {
    throw ruleError('EMPTY_MESSAGE', 'The message is empty.', 'Write the message text, then send it again.');
  }
  const n = bytesOf(input.body);
  if (n > MAX_MESSAGE_BYTES) {
    throw ruleError(
      'MESSAGE_TOO_LARGE',
      `The message is ${n} bytes; the limit is ${MAX_MESSAGE_BYTES}.`,
      `Messages are limited to ${MAX_MESSAGE_BYTES} bytes; this one is ${n} bytes. Save the long content as a project document (echo_doc_save) and send a short message naming the document.`,
    );
  }

  let escalateAt: string | null = null;
  if (input.escalateAfterMin !== undefined && input.escalateAt !== undefined) {
    throw ruleError('BAD_ESCALATION', 'Both an escalation delay and an escalation time were given.', 'Give only escalateAfterMin.');
  }
  if ((input.escalateAfterMin !== undefined || input.escalateAt !== undefined) && !input.requiresAck) {
    throw ruleError(
      'ESCALATION_NEEDS_ACK',
      'Escalation only applies to a message that requires acknowledgment.',
      'Set requiresAck to true, or leave out the escalation.',
    );
  }
  if (input.escalateAfterMin !== undefined) {
    if (!minutesOk(input.escalateAfterMin)) throw badMinutes(input.escalateAfterMin);
    escalateAt = addMinutes(ctx.now(), input.escalateAfterMin);
  } else if (input.escalateAt !== undefined) {
    escalateAt = parseZonedTime(input.escalateAt).utc;
  }

  if (actor.kind === 'agent') await requireMember(ctx, actor.agentId, input.projectId);
  const senderId = actor.kind === 'agent' ? actor.agentId : null;

  const requestId = input.requestId;
  if (requestId !== undefined) {
    if (senderId === null || !REQUEST_ID_PATTERN.test(requestId)) {
      throw ruleError('BAD_REQUEST_ID', 'request_id must be 1 to 64 characters from A-Z a-z 0-9 . _ : - .', 'Use a short id such as "ack-pr-42-1", and send it from an agent.');
    }
    const prior = await existingByRequestId(ctx, input.projectId, senderId, requestId, input);
    if (prior) return prior;
  }

  const { results: members } = await ctx.db
    .prepare(
      `SELECT a.id, a.name FROM agents a JOIN project_agents pa ON pa.agent_id = a.id
       WHERE pa.project_id = ? AND a.revoked_at IS NULL ORDER BY a.name`,
    )
    .bind(input.projectId)
    .all<{ id: number; name: string }>();

  let targets: { id: number; name: string }[];
  if (input.to === 'all') {
    targets = members.filter((m) => m.id !== senderId);
    if (!targets.length) {
      throw ruleError('NO_RECIPIENTS', 'There is nobody else in this project to send to.', 'Ask the owner to add agents to the project, or name a recipient.');
    }
  } else {
    const want = input.to.trim().toLowerCase();
    const hit = members.find((m) => m.name.toLowerCase() === want);
    if (!hit) {
      throw ruleError(
        'UNKNOWN_RECIPIENT',
        `"${input.to}" is not an agent in this project.`,
        `Send to one of: ${members.map((m) => m.name).join(', ') || '(no agents)'}, or to "all".`,
        404,
      );
    }
    targets = [hit];
  }

  const results = await ctx.db.batch(
    newMessageStmts(ctx, actor, {
      projectId: input.projectId,
      senderAgentId: senderId,
      label: actorLabel(actor),
      body: input.body,
      requiresAck: input.requiresAck,
      escalateAt,
      kind: input.kind ?? 'plain',
      refId: input.refId ?? null,
      recipientIds: targets.map((t) => t.id),
      requestId: requestId ?? null,
    }),
  );
  if (requestId !== undefined) {
    if (results[0].meta.changes === 0) {
      // Lost a race with a concurrent send of the same request id: the unique index kept one row, so answer with that one.
      const prior = await existingByRequestId(ctx, input.projectId, senderId!, requestId, input);
      if (prior) return prior;
      throw ruleError('SEND_NOT_STORED', 'The message was not stored.', 'Retry with the same request_id.', 503);
    }
    return { messageId: results[0].meta.last_row_id as number, recipients: targets.map((t) => t.name), duplicate: false };
  }
  const messageId = results[0].meta.last_row_id as number;
  return { messageId, recipients: targets.map((t) => t.name) };
}

// ---------------------------------------------------------------- reading

export async function readInbox(
  ctx: Ctx,
  agentId: number,
  opts: { projectId?: number; includeAcknowledged?: boolean } = {},
): Promise<InboxItem[]> {
  if (opts.projectId !== undefined) await requireMember(ctx, agentId, opts.projectId);
  await resurfaceDeferred(ctx, agentId);
  const where =
    (opts.projectId !== undefined ? ' AND m.project_id = ?' : '') +
    (opts.includeAcknowledged ? '' : ' AND r.acked_at IS NULL AND (r.delivered_at IS NULL OR m.requires_ack = 1)');
  const binds: number[] = [agentId];
  if (opts.projectId !== undefined) binds.push(opts.projectId);
  const { results } = await ctx.db.prepare(`${ITEM_SELECT}${where} ORDER BY m.id`).bind(...binds).all<ItemRow>();
  const undelivered = results.filter((r) => r.delivered_at === null).map((r) => r.message_id);
  await deliver(ctx, agentId, undelivered);
  return itemsByIds(ctx, agentId, results.map((r) => r.message_id));
}

export async function takeForHook(ctx: Ctx, agentId: number): Promise<{ fresh: InboxItem[]; awaitingAck: InboxItem[] }> {
  const back = await resurfaceDeferred(ctx, agentId);
  const delivered = await deliver(ctx, agentId);
  const fresh = await itemsByIds(ctx, agentId, [...new Set([...delivered, ...back])]);

  // A fresh item shows in awaitingAck from the second take on.
  const freshIds = new Set(fresh.map((i) => i.messageId));
  return { fresh, awaitingAck: (await awaitingAckFor(ctx, agentId)).filter((i) => !freshIds.has(i.messageId)) };
}

/**
 * Read-only mirror of what the next takeForHook would report as fresh: messages not yet delivered to this agent,
 * plus deferred ones whose time has passed. Same visibility rules (ITEM_SELECT). Writes nothing: no delivery
 * mark, no resurface, no change-log entry. Delivered messages that only await an ack are not counted.
 * Returns ids and sender labels only, never bodies.
 */
export async function peekForHook(ctx: Ctx, agentId: number): Promise<{ messageId: number; from: string }[]> {
  const { results } = await ctx.db
    .prepare(
      `${ITEM_SELECT} AND r.acked_at IS NULL
       AND (r.delivered_at IS NULL OR (r.deferred_until IS NOT NULL AND r.deferred_until <= ?)) ORDER BY m.id`,
    )
    .bind(agentId, ctx.now())
    .all<ItemRow>();
  return results.map((r) => ({ messageId: r.message_id, from: r.sender_label }));
}

async function awaitingRows(ctx: Ctx, agentId: number, deliveredOnly: boolean): Promise<ItemRow[]> {
  const { results } = await ctx.db
    .prepare(
      `${ITEM_SELECT} AND m.requires_ack = 1 AND r.acked_at IS NULL${deliveredOnly ? ' AND r.delivered_at IS NOT NULL' : ''}
       AND (r.deferred_until IS NULL OR r.deferred_until <= ?) ORDER BY m.id`,
    )
    .bind(agentId, ctx.now())
    .all<ItemRow>();
  return results;
}

/** Delivered, unacknowledged, requires-ack messages that are not deferred right now. Read-only. */
export async function awaitingAckFor(ctx: Ctx, agentId: number): Promise<InboxItem[]> {
  return (await awaitingRows(ctx, agentId, true)).map(toItem);
}

/**
 * For the Stop hook: every unacknowledged, non-deferred requires-ack message, delivered or not. Undelivered ones
 * are marked delivered here (the hook prints them). Plain messages are left alone for the next poll.
 */
export async function takeAwaitingForStop(ctx: Ctx, agentId: number): Promise<InboxItem[]> {
  const rows = await awaitingRows(ctx, agentId, false);
  const undelivered = rows.filter((r) => r.delivered_at === null).map((r) => r.message_id);
  if (undelivered.length) await deliver(ctx, agentId, undelivered);
  return itemsByIds(ctx, agentId, rows.map((r) => r.message_id));
}

// ---------------------------------------------------------------- defer and acknowledge

type RecipientRow = {
  project_id: number;
  sender_agent_id: number | null;
  body: string;
  requires_ack: number;
  withdrawn_at: string | null;
  acked_at: string | null;
  agent_name: string;
};

async function loadRecipient(ctx: Ctx, agentId: number, messageId: number): Promise<RecipientRow> {
  const row = await ctx.db
    .prepare(
      `SELECT m.project_id, m.sender_agent_id, m.body, m.requires_ack, m.withdrawn_at, r.acked_at, a.name AS agent_name
       FROM message_recipients r JOIN messages m ON m.id = r.message_id JOIN agents a ON a.id = r.agent_id
       WHERE r.message_id = ? AND r.agent_id = ?`,
    )
    .bind(messageId, agentId)
    .first<RecipientRow>();
  if (!row) {
    throw ruleError('NOT_RECIPIENT', `Message ${messageId} was not sent to you.`, 'Check the message id in your inbox.', 403);
  }
  if (row.withdrawn_at) {
    throw ruleError('MESSAGE_WITHDRAWN', `Message ${messageId} was withdrawn by its sender.`, 'Nothing more is needed for it.', 409);
  }
  return row;
}

export async function deferMessage(ctx: Ctx, agentId: number, messageId: number, forMinutes: number, reason: string): Promise<void> {
  const why = reason.trim();
  if (!why) {
    throw ruleError('REASON_REQUIRED', 'A deferral needs a reason.', 'Say why you cannot act yet, for example "waiting on the owner".');
  }
  if (!minutesOk(forMinutes)) throw badMinutes(forMinutes);
  const row = await loadRecipient(ctx, agentId, messageId);
  if (!row.requires_ack) {
    throw ruleError('NOT_DEFERRABLE', `Message ${messageId} does not require acknowledgment.`, 'Only messages that require acknowledgment can be deferred; just read it.');
  }
  if (row.acked_at) {
    throw ruleError('ALREADY_ACKNOWLEDGED', `Message ${messageId} is already acknowledged.`, 'Nothing more is needed for it.', 409);
  }
  const until = addMinutes(ctx.now(), forMinutes);
  const actor: Actor = { kind: 'agent', agentId, name: row.agent_name };
  await ctx.db.batch([
    ctx.db
      .prepare(
        `UPDATE message_recipients SET deferred_until = ?, defer_reason = ?, delivered_at = COALESCE(delivered_at, ?)
         WHERE message_id = ? AND agent_id = ? AND acked_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM messages WHERE id = ? AND withdrawn_at IS NOT NULL)`,
      )
      .bind(until, why, ctx.now(), messageId, agentId, messageId),
    changeStmt(ctx, { projectId: row.project_id, actor, kind: 'message.deferred', subjectId: messageId, data: { until, reason: why } }, { guarded: true }),
    ...noticeStmts(
      ctx,
      row,
      `${row.agent_name} deferred your message #${messageId} ("${excerpt(row.body)}") until ${until}: ${why}`,
    ),
  ]);
}

/** The statements that acknowledge one recipient row: the update, then its change_log entry guarded by changes(). */
function ackRecipientStmts(
  ctx: Ctx,
  row: Pick<RecipientRow, 'project_id'>,
  agentId: number,
  messageId: number,
  n: string | null,
  by: { actor: Actor; label: string },
  /** Only when this hold acknowledgment landed: a refused hold acknowledgment must change nothing. */
  holdAck?: { holdId: number; at: string },
): D1PreparedStatement[] {
  const binds: (string | number | null)[] = [ctx.now(), n, by.label, ctx.now(), messageId, agentId, messageId];
  if (holdAck) binds.push(holdAck.holdId, holdAck.at, by.label);
  return [
    ctx.db
      .prepare(
        `UPDATE message_recipients
         SET acked_at = ?, ack_note = ?, acked_by = ?, deferred_until = NULL, delivered_at = COALESCE(delivered_at, ?)
         WHERE message_id = ? AND agent_id = ? AND acked_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM messages WHERE id = ? AND withdrawn_at IS NOT NULL)` +
          (holdAck ? ` AND EXISTS (SELECT 1 FROM holds WHERE id = ? AND acked_at = ? AND acked_by = ?)` : ''),
      )
      .bind(...binds),
    changeStmt(ctx, { projectId: row.project_id, actor: by.actor, kind: 'message.acknowledged', subjectId: messageId, data: { agentId, note: n } }, { guarded: true }),
  ];
}

async function acknowledge(
  ctx: Ctx,
  agentId: number,
  messageId: number,
  note: string | undefined,
  by: { actor: Actor; label: string },
  notify: boolean,
): Promise<void> {
  const row = await loadRecipient(ctx, agentId, messageId);
  if (row.acked_at) return; // already acknowledged: retrying is safe and sends nothing more
  const n = note?.trim() || null;
  const onBehalf = by.actor.kind === 'agent' && by.actor.agentId === agentId ? '' : ` on behalf of ${row.agent_name}`;
  const text =
    `${by.label} acknowledged your message #${messageId} ("${excerpt(row.body)}")${onBehalf}` + (n ? `: ${n}` : '.');
  await ctx.db.batch([
    ...ackRecipientStmts(ctx, row, agentId, messageId, n, by),
    ...(notify && row.requires_ack ? noticeStmts(ctx, row, text) : []),
  ]);
}

/**
 * For a hold acknowledgment: the statements that also acknowledge this agent's own recipient row of the hold's
 * message. They are the ones the normal message acknowledgment builds, with no notice to the sender, because the
 * hold acknowledgment's notice already tells them. None when the agent has no row, or it is withdrawn or already
 * acknowledged. Put them last in the batch: they end in an entry guarded by changes().
 */
export async function ackOwnRecipientStmts(
  ctx: Ctx,
  actor: Extract<Actor, { kind: 'agent' }>,
  label: string,
  messageId: number,
  note: string,
  holdAck: { holdId: number; at: string },
): Promise<D1PreparedStatement[]> {
  let row: RecipientRow;
  try {
    row = await loadRecipient(ctx, actor.agentId, messageId);
  } catch (e) {
    if (e instanceof EchoError && (e.code === 'NOT_RECIPIENT' || e.code === 'MESSAGE_WITHDRAWN')) return [];
    throw e;
  }
  if (row.acked_at) return [];
  return ackRecipientStmts(ctx, row, actor.agentId, messageId, note, { actor, label }, holdAck);
}

export async function ackMessage(ctx: Ctx, agentId: number, messageId: number, note?: string): Promise<void> {
  const a = await ctx.db.prepare(`SELECT name FROM agents WHERE id = ?`).bind(agentId).first<{ name: string }>();
  const name = a?.name ?? String(agentId);
  await acknowledge(ctx, agentId, messageId, note, { actor: { kind: 'agent', agentId, name }, label: name }, true);
}

/** For approvals: acknowledges a request message without telling the sender. */
export async function ackMessageInternal(ctx: Ctx, agentId: number, messageId: number, note: string): Promise<void> {
  const a = await ctx.db.prepare(`SELECT name FROM agents WHERE id = ?`).bind(agentId).first<{ name: string }>();
  const name = a?.name ?? String(agentId);
  await acknowledge(ctx, agentId, messageId, note, { actor: { kind: 'agent', agentId, name }, label: name }, false);
}

export async function adminAckMessage(ctx: Ctx, messageId: number, agentId: number): Promise<void> {
  await acknowledge(ctx, agentId, messageId, undefined, { actor: ADMIN, label: 'admin' }, true);
}

// ---------------------------------------------------------------- status, withdraw, pending

export async function messageStatus(ctx: Ctx, agentId: number, messageId?: number): Promise<SentStatus[]> {
  let msgs: { id: number; created_at: string; withdrawn_at: string | null; escalate_at: string | null }[];
  if (messageId !== undefined) {
    const m = await ctx.db
      .prepare(`SELECT id, created_at, withdrawn_at, escalate_at, sender_agent_id FROM messages WHERE id = ?`)
      .bind(messageId)
      .first<{ id: number; created_at: string; withdrawn_at: string | null; escalate_at: string | null; sender_agent_id: number | null }>();
    if (!m || m.sender_agent_id !== agentId) {
      throw ruleError('NOT_SENDER', `You did not send message ${messageId}.`, 'Status is only available for messages you sent.', 403);
    }
    msgs = [m];
  } else {
    const { results } = await ctx.db
      .prepare(
        `SELECT id, created_at, withdrawn_at, escalate_at FROM messages
         WHERE sender_agent_id = ? ORDER BY id DESC LIMIT 50`,
      )
      .bind(agentId)
      .all<{ id: number; created_at: string; withdrawn_at: string | null; escalate_at: string | null }>();
    msgs = results;
  }
  if (!msgs.length) return [];
  const { results: rec } = await ctx.db
    .prepare(
      `SELECT r.message_id, a.name, r.delivered_at, r.deferred_until, r.defer_reason, r.acked_at, r.ack_note, r.escalated_at
       FROM message_recipients r JOIN agents a ON a.id = r.agent_id
       WHERE r.message_id IN (SELECT value FROM json_each(?)) ORDER BY a.name`,
    )
    .bind(JSON.stringify(msgs.map((m) => m.id)))
    .all<{
      message_id: number; name: string; delivered_at: string | null; deferred_until: string | null; defer_reason: string | null;
      acked_at: string | null; ack_note: string | null; escalated_at: string | null;
    }>();
  return msgs.map((m) => ({
    messageId: m.id,
    sentAt: m.created_at,
    withdrawn: m.withdrawn_at !== null,
    escalateAt: m.escalate_at,
    recipients: rec
      .filter((r) => r.message_id === m.id)
      .map((r) => ({
        name: r.name,
        delivered: r.delivered_at !== null,
        deferredUntil: r.deferred_until,
        deferReason: r.defer_reason,
        acknowledged: r.acked_at !== null,
        note: r.ack_note,
        escalated: r.escalated_at !== null,
      })),
  }));
}

export async function withdrawMessage(ctx: Ctx, actor: Actor, messageId: number): Promise<void> {
  const m = await ctx.db
    .prepare(`SELECT project_id, sender_agent_id, withdrawn_at FROM messages WHERE id = ?`)
    .bind(messageId)
    .first<{ project_id: number; sender_agent_id: number | null; withdrawn_at: string | null }>();
  if (!m) throw ruleError('NOT_SENDER', `There is no message ${messageId} that you sent.`, 'Check the message id.', 404);
  if (actor.kind === 'agent' ? m.sender_agent_id !== actor.agentId : actor.kind !== 'admin') {
    throw ruleError('NOT_SENDER', `You did not send message ${messageId}.`, 'Only the sender or the admin can withdraw a message.', 403);
  }
  if (m.withdrawn_at) return;
  const refused = () =>
    ruleError('ALREADY_ACKNOWLEDGED', `Message ${messageId} has already been acknowledged.`, 'An acknowledged message cannot be withdrawn. Send a follow-up message instead.', 409);

  // The guard is inside the UPDATE, so an acknowledgment that lands first wins; the change entry
  // is written in the same batch and only if the UPDATE applied.
  const [res] = await ctx.db.batch([
    ctx.db
      .prepare(
        `UPDATE messages SET withdrawn_at = ?
         WHERE id = ? AND withdrawn_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM message_recipients WHERE message_id = ? AND acked_at IS NOT NULL)`,
      )
      .bind(ctx.now(), messageId, messageId),
    changeStmt(ctx, { projectId: m.project_id, actor, kind: 'message.withdrawn', subjectId: messageId }, { guarded: true }),
  ]);
  if (!res.meta.changes) {
    const now = await ctx.db.prepare(`SELECT withdrawn_at FROM messages WHERE id = ?`).bind(messageId).first<{ withdrawn_at: string | null }>();
    if (now?.withdrawn_at) return; // someone else withdrew it first
    throw refused();
  }
}

/**
 * Admin page: recipient rows still waiting, oldest first: requires-ack ones not yet acknowledged, and plain ones not
 * yet delivered.
 */
export async function pendingMessages(ctx: Ctx, projectId: number): Promise<PendingRow[]> {
  const { results } = await ctx.db
    .prepare(
      `SELECT m.id AS message_id, m.project_id, m.sender_label, m.body, m.created_at, m.escalate_at, m.requires_ack,
              a.id AS recipient_id, a.name AS recipient, r.delivered_at, r.deferred_until, r.defer_reason,
              r.escalated_at, a.last_checked_in_at
       FROM message_recipients r
       JOIN messages m ON m.id = r.message_id
       JOIN agents a ON a.id = r.agent_id
       WHERE m.project_id = ? AND m.withdrawn_at IS NULL AND r.acked_at IS NULL AND (m.requires_ack = 1 OR r.delivered_at IS NULL)
       ORDER BY m.id, a.name`,
    )
    .bind(projectId)
    .all<{
      message_id: number; project_id: number; sender_label: string; body: string; created_at: string; escalate_at: string | null;
      requires_ack: number; recipient_id: number; recipient: string; delivered_at: string | null; deferred_until: string | null; defer_reason: string | null;
      escalated_at: string | null; last_checked_in_at: string | null;
    }>();
  return results.map((r) => ({
    messageId: r.message_id,
    projectId: r.project_id,
    from: r.sender_label,
    body: r.body,
    sentAt: r.created_at,
    escalateAt: r.escalate_at,
    requiresAck: r.requires_ack === 1,
    recipientId: r.recipient_id,
    recipient: r.recipient,
    deliveredAt: r.delivered_at,
    deferredUntil: r.deferred_until,
    deferReason: r.defer_reason,
    escalatedAt: r.escalated_at,
    lastCheckedInAt: r.last_checked_in_at,
  }));
}

export type MessageLine = {
  id: number;
  from: string;
  body: string;
  kind: MessageKind;
  requiresAck: boolean;
  sentAt: string;
  withdrawnAt: string | null;
  recipients: { name: string; deliveredAt: string | null; ackedAt: string | null; ackedBy: string | null; deferredUntil: string | null; escalatedAt: string | null }[];
};

/** Admin page: the newest `limit` messages of a project, newest first, each with every recipient's state. */
export async function allMessages(ctx: Ctx, projectId: number, limit = 200): Promise<MessageLine[]> {
  const { results: msgs } = await ctx.db
    .prepare(
      `SELECT id, sender_label, body, kind, requires_ack, created_at, withdrawn_at FROM messages WHERE project_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .bind(projectId, limit)
    .all<{ id: number; sender_label: string; body: string; kind: MessageKind; requires_ack: number; created_at: string; withdrawn_at: string | null }>();
  if (!msgs.length) return [];
  const { results: recs } = await ctx.db
    .prepare(
      `SELECT r.message_id, a.name, r.delivered_at, r.acked_at, r.acked_by, r.deferred_until, r.escalated_at
       FROM message_recipients r JOIN agents a ON a.id = r.agent_id
       WHERE r.message_id IN (SELECT id FROM messages WHERE project_id = ? ORDER BY id DESC LIMIT ?) ORDER BY r.message_id, a.name`,
    )
    .bind(projectId, limit)
    .all<{ message_id: number; name: string; delivered_at: string | null; acked_at: string | null; acked_by: string | null; deferred_until: string | null; escalated_at: string | null }>();
  return msgs.map((m) => ({
    id: m.id,
    from: m.sender_label,
    body: m.body,
    kind: m.kind,
    requiresAck: m.requires_ack === 1,
    sentAt: m.created_at,
    withdrawnAt: m.withdrawn_at,
    recipients: recs
      .filter((r) => r.message_id === m.id)
      .map((r) => ({ name: r.name, deliveredAt: r.delivered_at, ackedAt: r.acked_at, ackedBy: r.acked_by, deferredUntil: r.deferred_until, escalatedAt: r.escalated_at })),
  }));
}
