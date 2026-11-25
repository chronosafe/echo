import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { strictParse } from '../api/hooks';
import type { Ctx } from '../ctx';
import { ruleError } from '../errors';
import type { Actor } from '../types';
import type { AgentRow } from '../domain/agents';
import { approveMerge, objectMerge, pendingApprovals } from '../domain/approvals';
import { addEvent, cancelEvent, listEvents, updateEvent } from '../domain/calendar';
import { changesSince } from '../domain/changelog';
import { batchWrite, deleteEntry, entryHistory, getEntry, listEntries, putEntry } from '../domain/data';
import type { Entry, HistoryRow } from '../domain/data';
import { getDocument, listDocuments, listVersions, saveDocument } from '../domain/documents';
import { ackHold, listHolds, placeHold, releaseHold } from '../domain/holds';
import { ackMessage, deferMessage, messageStatus, readInbox, REQUEST_ID_PATTERN, sendMessage, withdrawMessage } from '../domain/messages';
import { agentProjects } from '../domain/projects';
import { appendScratchpad, readScratchpad } from '../domain/scratchpad';
import { addTodo, claimTodo, completeTodo, listTodos, releaseTodo } from '../domain/todos';
import { toolResult } from './result';

const FIX = 'Send exactly the documented fields; see the tool description. Times are never supplied, except a calendar starts_at, from and to.';

const id = z.number().int().positive();
const project = z.string().min(1).describe('Project name');
const OK = { ok: true } as const;

/**
 * The SDK would answer a bad argument with its own text. Advertise the strict schema (so clients see the real
 * fields and additionalProperties:false) but let every call through, so the tool body can refuse it as the
 * rule error BAD_REQUEST, in the same words the hook API uses.
 */
function advertised(schema: z.ZodType): StandardSchemaWithJSON {
  return { '~standard': { ...schema['~standard'], validate: (value: unknown) => ({ value }) } } as unknown as StandardSchemaWithJSON;
}

export function registerTools(server: McpServer, ctx: Ctx, agent: AgentRow): void {
  const actor: Actor = { kind: 'agent', agentId: agent.id, name: agent.name };

  /** Resolves a project name among the caller's own, non-archived projects. */
  async function projectId(name: string): Promise<number> {
    const mine = await agentProjects(ctx, agent.id);
    const hit = mine.find((p) => p.name === name);
    if (!hit) {
      throw ruleError(
        'NOT_MEMBER',
        `You are not a member of a project named "${name}".`,
        `Your projects: ${mine.map((p) => p.name).join(', ') || '(none)'}. Ask the owner to add you to the project.`,
        403,
      );
    }
    return hit.id;
  }

  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  ): void {
    const schema = z.object(shape).strict();
    server.registerTool(name, { description, inputSchema: advertised(schema) }, async (raw: unknown) =>
      toolResult(async () => run(strictParse(schema, raw ?? {}, 'tool arguments', FIX))),
    );
  }

  // ------------------------------------------------------------ identity

  tool(
    'echo_whoami',
    "Who you are, the projects you belong to, and the service clock (UTC). Echo's clock is the only clock that stamps records.",
    {},
    async () => ({
      name: agent.name,
      projects: (await agentProjects(ctx, agent.id)).map((p) => p.name),
      now: ctx.now(),
    }),
  );

  // ------------------------------------------------------------ messages

  tool(
    'echo_send_message',
    'Send a message to one agent in a project, or to "all". Keep it short (8,192 bytes at most): long content belongs in a document, and the message should name it. ' +
      'Set requires_ack when the recipient must confirm it handled it; escalate_after_minutes (needs requires_ack) tells the owner if nobody acknowledges in time. Echo stamps the send time; never supply one. ' +
      'To make a send safe to retry, pass request_id: a short id you choose (1-64 characters of letters, digits, dot, underscore, colon, hyphen), new for each distinct message. ' +
      'If a send fails or its outcome is unknown (a dropped connection), send again with the SAME request_id and the same body and requires_ack: Echo stores nothing twice and returns the original message_id and recipients with duplicate: true. ' +
      'The same request_id with a different body is refused (REQUEST_ID_REUSED). Without a request_id, check echo_message_status before resending.',
    {
      project,
      to: z.string().min(1).describe('Recipient agent name, or "all"'),
      body: z.string(),
      requires_ack: z.boolean().default(false),
      escalate_after_minutes: z.number().int().positive().optional(),
      request_id: z.string().regex(REQUEST_ID_PATTERN).optional().describe('Retry key, 1-64 chars of [A-Za-z0-9._:-]; reuse it only to retry the same message'),
    },
    async (a) => {
      const r = await sendMessage(ctx, actor, {
        projectId: await projectId(a.project),
        to: a.to,
        body: a.body,
        requiresAck: a.requires_ack,
        escalateAfterMin: a.escalate_after_minutes,
        requestId: a.request_id,
      });
      return { message_id: r.messageId, recipients: r.recipients, ...(r.duplicate === undefined ? {} : { duplicate: r.duplicate }) };
    },
  );

  tool(
    'echo_inbox',
    'Read your messages. Reading delivers them. Returns unacknowledged messages (and plain messages not yet delivered); set include_acknowledged for history.',
    { project: project.optional(), include_acknowledged: z.boolean().optional() },
    async (a) =>
      readInbox(ctx, agent.id, {
        projectId: a.project === undefined ? undefined : await projectId(a.project),
        includeAcknowledged: a.include_acknowledged,
      }),
  );

  tool(
    'echo_ack_message',
    'Acknowledge a message: you have read it AND handled it. Acknowledging a hold message does not clear the hold; release the hold (echo_release_hold) when the problem is fixed. ' +
      'Defer (echo_defer_message) instead of acknowledging anything you have not yet handled.',
    { message_id: id, note: z.string().optional() },
    async (a) => {
      await ackMessage(ctx, agent.id, a.message_id, a.note);
      return OK;
    },
  );

  tool(
    'echo_defer_message',
    'Put a message aside for a number of minutes, with the reason. It comes back to your inbox when the time is up. Use this for anything you cannot handle yet.',
    { message_id: id, for_minutes: z.number().int().positive(), reason: z.string().min(1) },
    async (a) => {
      await deferMessage(ctx, agent.id, a.message_id, a.for_minutes, a.reason);
      return OK;
    },
  );

  tool(
    'echo_message_status',
    'Per-recipient status of messages you sent: delivered, deferred (with reason), acknowledged, escalated. Give message_id for one message, or omit it for your recent ones.',
    { message_id: id.optional() },
    async (a) => messageStatus(ctx, agent.id, a.message_id),
  );

  tool(
    'echo_withdraw_message',
    'Withdraw a message you sent. Recipients who have not acknowledged it stop seeing it.',
    { message_id: id },
    async (a) => {
      await withdrawMessage(ctx, actor, a.message_id);
      return OK;
    },
  );

  // ------------------------------------------------------------ holds

  tool(
    'echo_place_hold',
    "Place a hold on a pull request. A blocking hold (the default) stops merging until it is released. An advisory hold stops merging only until someone acknowledges it (echo_ack_hold). The hold is announced to the project's agents. The reason is shown to them: say what is wrong.",
    {
      repo: z.string().min(1).describe('owner/name; case does not matter'),
      pr: id,
      reason: z.string().min(1),
      kind: z.enum(['blocking', 'advisory']).optional(),
      notify: z.string().optional().describe('Agent name to notify instead of everyone'),
    },
    async (a) => placeHold(ctx, actor, { repo: a.repo, pr: a.pr, reason: a.reason, kind: a.kind, notify: a.notify }),
  );

  tool(
    'echo_list_holds',
    'List holds in your projects. Open holds by default; state "all" includes released ones.',
    { project: project.optional(), state: z.enum(['open', 'all']).optional() },
    async (a) =>
      listHolds(ctx, agent.id, {
        projectId: a.project === undefined ? undefined : await projectId(a.project),
        state: a.state,
      }),
  );

  tool(
    'echo_ack_hold',
    'Record that you have seen a hold. On a blocking hold it does not clear the block: only echo_release_hold does. On an advisory hold your acknowledgment closes the hold.',
    { hold_id: id, note: z.string().min(1) },
    async (a) => {
      await ackHold(ctx, agent.id, a.hold_id, a.note);
      return OK;
    },
  );

  tool(
    'echo_release_hold',
    'Release a hold once the problem is fixed, with a note saying how. If someone else closed it first you are told who and when.',
    { hold_id: id, note: z.string().min(1) },
    async (a) => {
      await releaseHold(ctx, agent.id, a.hold_id, a.note);
      return OK;
    },
  );

  // ------------------------------------------------------------ approvals

  tool('echo_pending_approvals', 'Merges waiting for your approval whose window has not closed, soonest first.', {}, async () =>
    pendingApprovals(ctx, agent.id),
  );

  tool(
    'echo_approve_merge',
    'Approve a scheduled merge (an event id from echo_pending_approvals) for its current slot. Moving the slot voids the approval.',
    { event_id: id },
    async (a) => {
      await approveMerge(ctx, agent.id, a.event_id);
      return OK;
    },
  );

  tool(
    'echo_object_merge',
    'Object to a scheduled merge with a reason. This places a blocking hold on the PR, which stays until it is released.',
    { event_id: id, reason: z.string().min(1) },
    async (a) => objectMerge(ctx, agent.id, a.event_id, a.reason),
  );

  // ------------------------------------------------------------ calendar

  tool(
    'echo_calendar_add',
    'Add a calendar event. starts_at must carry a zone: Z or an offset, for example 2026-11-18T21:00:00-06:00 (it is stored as UTC). ' +
      'For a merge slot use kind "merge" with repo and pr; merger names the agent who will merge (default you), and approvers (where the project requires approvals) the agents who must approve. ' +
      'For a merge event the reply also says approvalRequired, approvers (each { name, response, at, by }; empty when approval is not required) and, when required, windowStart and windowEnd (UTC): the span in which approval and the merge are allowed.',
    {
      project,
      title: z.string().min(1),
      starts_at: z.string().min(1),
      importance: z.enum(['low', 'normal', 'high']).optional(),
      kind: z.enum(['event', 'merge']).optional(),
      repo: z.string().optional(),
      pr: id.optional(),
      merger: z.string().optional(),
      approvers: z.array(z.string().min(1)).optional(),
    },
    async (a) =>
      addEvent(ctx, actor, {
        projectId: await projectId(a.project),
        title: a.title,
        startsAt: a.starts_at,
        importance: a.importance,
        kind: a.kind,
        repo: a.repo,
        pr: a.pr,
        merger: a.merger,
        approvers: a.approvers,
      }),
  );

  tool(
    'echo_calendar_list',
    'List calendar events whose start falls in [from, to). from and to carry a zone, like starts_at. Cancelled events are included, flagged. A merge event also carries approvalRequired, approvers ({ name, response: approved, objected or null, at, by, and holdId for an objection }) and, when approval is required, windowStart and windowEnd (UTC).',
    { project, from: z.string().min(1), to: z.string().min(1) },
    async (a) => listEvents(ctx, actor, { projectId: await projectId(a.project), from: a.from, to: a.to }),
  );

  tool(
    'echo_calendar_update',
    "Change an event's title, start (with a zone) or importance. Moving a merge slot voids approvals given for the old slot and asks the approvers again; the reply for a merge event says approvalRequired, approvers and the new windowStart and windowEnd.",
    {
      event_id: id,
      title: z.string().min(1).optional(),
      starts_at: z.string().min(1).optional(),
      importance: z.enum(['low', 'normal', 'high']).optional(),
    },
    async (a) => updateEvent(ctx, actor, a.event_id, { title: a.title, startsAt: a.starts_at, importance: a.importance }),
  );

  tool('echo_calendar_cancel', 'Cancel a calendar event that has not merged.', { event_id: id }, async (a) => {
    await cancelEvent(ctx, actor, a.event_id);
    return OK;
  });

  // ------------------------------------------------------------ to-dos

  const todoView = (t: Awaited<ReturnType<typeof addTodo>>) => ({
    id: t.id,
    title: t.title,
    added_by: t.addedBy,
    created_at: t.createdAt,
    claimed_by: t.claimedBy,
    claimed_at: t.claimedAt,
    done_at: t.doneAt,
  });

  tool(
    'echo_todo_add',
    "Add an item to the project's shared to-do list. Any member can claim and complete it.",
    { project, title: z.string().min(1) },
    async (a) => ({ todo_id: (await addTodo(ctx, actor, await projectId(a.project), a.title)).id }),
  );

  tool(
    'echo_todo_list',
    'List the project to-dos with who added and claimed each. Open items by default; include_done adds completed ones.',
    { project, include_done: z.boolean().optional() },
    async (a) => ({ todos: (await listTodos(ctx, actor, await projectId(a.project), { includeDone: a.include_done })).map(todoView) }),
  );

  tool(
    'echo_todo_claim',
    'Claim an open to-do so nobody else works on it. If it is already claimed you are told by whom; ask that agent to release it.',
    { todo_id: id },
    async (a) => todoView(await claimTodo(ctx, actor, a.todo_id)),
  );

  tool(
    'echo_todo_release',
    'Give up your claim on a to-do so someone else can claim it. To hand a to-do to another agent, release it and ask them to claim it.',
    { todo_id: id },
    async (a) => todoView(await releaseTodo(ctx, actor, a.todo_id)),
  );

  tool(
    'echo_todo_complete',
    'Mark a to-do done. Any member of the project may; Echo records who did.',
    { todo_id: id },
    async (a) => todoView(await completeTodo(ctx, actor, a.todo_id)),
  );

  // ------------------------------------------------------------ scratchpad (append-only: agents cannot edit or delete)

  tool(
    'echo_scratchpad_append',
    "Append an entry to the project's shared scratchpad (8,192 bytes at most). Entries are stamped with your name and the time, and cannot be edited or deleted by agents.",
    { project, body: z.string() },
    async (a) => ({ entry_id: (await appendScratchpad(ctx, actor, await projectId(a.project), a.body)).id }),
  );

  tool(
    'echo_scratchpad_read',
    'Read scratchpad entries in order. after_id returns only entries after that id (to read what is new); limit defaults to 100, at most 500.',
    { project, after_id: z.number().int().nonnegative().optional(), limit: z.number().int().optional() },
    async (a) => ({
      entries: (await readScratchpad(ctx, actor, await projectId(a.project), { afterId: a.after_id, limit: a.limit })).map((e) => ({
        id: e.id,
        author: e.author,
        body: e.body,
        created_at: e.createdAt,
        edited_at: e.editedAt,
      })),
    }),
  );

  // ------------------------------------------------------------ documents and changes

  tool(
    'echo_doc_save',
    'Save a document (1,048,576 bytes at most) as a new version. Saving an existing name keeps the earlier versions (the last 50). ' +
      'Names use letters, digits, dot, underscore and hyphen. format is "json" (validated, stored exactly as given) or "markdown"; it cannot change between versions.',
    { project, name: z.string(), format: z.enum(['json', 'markdown']), content: z.string() },
    async (a) => saveDocument(ctx, actor, { projectId: await projectId(a.project), name: a.name, format: a.format, content: a.content }),
  );

  tool(
    'echo_doc_get',
    'Read a document: the latest version, or a specific one with version. Returns its format, version, who saved it and when.',
    { project, name: z.string(), version: id.optional() },
    async (a) => {
      const d = await getDocument(ctx, actor, await projectId(a.project), a.name, a.version);
      return { name: d.name, version: d.version, format: d.format, content: d.content, saved_by: d.savedBy, created_at: d.createdAt };
    },
  );

  tool(
    'echo_doc_list',
    'List the project documents: name, format, latest version, who saved it and when. Content is not included; use echo_doc_get.',
    { project },
    async (a) => ({
      documents: (await listDocuments(ctx, actor, await projectId(a.project))).map((d) => ({
        name: d.name,
        format: d.format,
        version: d.version,
        saved_by: d.savedBy,
        created_at: d.createdAt,
      })),
    }),
  );

  tool(
    'echo_doc_versions',
    'List the versions of one document that are still kept (the last 50), oldest first, with who saved each and when.',
    { project, name: z.string() },
    async (a) => ({
      versions: (await listVersions(ctx, actor, await projectId(a.project), a.name)).map((d) => ({
        version: d.version,
        format: d.format,
        saved_by: d.savedBy,
        created_at: d.createdAt,
      })),
    }),
  );

  // ------------------------------------------------------------ shared data

  const dkey = z.string().min(1).max(200).describe('1-200 chars from A-Z a-z 0-9 . _ : / - ; "/" separates namespaces; no leading/trailing "/", no "//", no segment "." or ".."');
  const expectedVersion = z.number().int().nonnegative().describe('The version you read: 0 for a key that has never existed; a deleted key needs its tombstone version. Required: there is no unconditional write.');
  const dnote = z.string().max(500).optional().describe('Why you changed it (500 chars at most). Give one for any change another agent will act on.');
  const downer = z.union([z.literal('me'), z.null()]).optional().describe('"me": you own the entry (only when it is created). null: release it. Omit to leave the owner as it is.');
  const dnotify = z
    .union([z.literal('all'), z.array(z.string().min(1)).min(1).max(20)])
    .optional()
    .describe('Agent names, or "all": they get a generated message "Shared data key@vN (put|delete) by you: note", written in the same transaction as the write');
  const drequest = z.string().regex(REQUEST_ID_PATTERN).optional().describe('Retry key, 1-64 chars of [A-Za-z0-9._:-]. Repeat it only to retry the SAME write: you get the first result back (duplicate: true), never a conflict with yourself.');
  const dvalue = z
    .unknown()
    .refine((v) => v !== undefined, 'value is required')
    .describe('Any JSON value (object, array, string, number, boolean, null): at most 65,536 bytes serialized, at most 32 levels deep. Stored as JSON.stringify of it, so key order and number formatting follow the JavaScript serializer.');

  const LOOP =
    'The loop: echo_data_get the key and note its version; change the value; echo_data_put with expected_version set to that version. ' +
    'On VERSION_CONFLICT nothing was written: the error details carry the current state; merge your change with it and put again with the current version. Never retry a conflict unchanged.';

  const entryView = (e: Entry) => ({
    key: e.key,
    version: e.version,
    ...('value' in e ? { value: e.value } : {}),
    owner: e.owner,
    updated_by: e.updatedBy,
    updated_at: e.updatedAt,
    note: e.note,
    deleted: e.deleted,
  });
  const historyView = (h: HistoryRow) => ({
    version: h.version,
    op: h.op,
    ...('value' in h ? { value: h.value } : {}),
    owner: h.owner,
    actor: h.actor,
    at: h.at,
    note: h.note,
    batch_id: h.batchId,
  });

  tool(
    'echo_data_get',
    'Read one shared-data entry: its value and version, who changed it last and when. With version, read that exact version from history (a message that says key@v3 points at it). ' +
      'A deleted key is DATA_NOT_FOUND whose details give the tombstone version (the expected_version to recreate it). ' +
      LOOP,
    { project, key: dkey, version: id.optional() },
    async (a) => {
      const r = await getEntry(ctx, actor, await projectId(a.project), a.key, a.version);
      return 'op' in r ? { key: r.key, ...historyView(r) } : entryView(r);
    },
  );

  tool(
    'echo_data_list',
    'List shared-data entries in key order: key, version, owner, updated_by, updated_at, note, deleted (and the value with include_values). prefix matches keys that start with it, exactly (case-sensitive, "_" is literal). ' +
      'limit defaults to 200, at most 500. A response stops early at 1 MiB; when more_after_key is present, pass it as after_key to continue. To follow changes, use echo_changes_since (data.put and data.deleted rows carry data.key).',
    {
      project,
      prefix: z.string().max(200).optional(),
      include_values: z.boolean().optional(),
      include_deleted: z.boolean().optional(),
      limit: z.number().int().optional(),
      after_key: z.string().max(200).optional(),
    },
    async (a) => {
      const r = await listEntries(ctx, actor, await projectId(a.project), {
        prefix: a.prefix,
        includeValues: a.include_values,
        includeDeleted: a.include_deleted,
        limit: a.limit,
        afterKey: a.after_key,
      });
      return { entries: r.entries.map(entryView), ...(r.afterKey === undefined ? {} : { more_after_key: r.afterKey }) };
    },
  );

  tool(
    'echo_data_put',
    'Create or change a shared-data entry, conditional on expected_version (0 to create a key that has never existed). Echo stamps who and when. ' +
      'owner "me" makes you the only agent who may change or delete it (set it when you create the entry; there is no hand-over; release with owner null; an owner who has left the project or is revoked counts as released). ' +
      'Returns {key, version, previous_version}. Refusals: VERSION_CONFLICT (409), NOT_OWNER (403). ' +
      LOOP,
    { project, key: dkey, value: dvalue, expected_version: expectedVersion, owner: downer, note: dnote, notify: dnotify, request_id: drequest },
    async (a) => {
      const r = await putEntry(ctx, actor, {
        projectId: await projectId(a.project),
        key: a.key,
        value: a.value,
        expectedVersion: a.expected_version,
        owner: a.owner,
        note: a.note,
        notify: a.notify,
        requestId: a.request_id,
      });
      return { key: r.key, version: r.version, previous_version: r.previousVersion, ...(r.duplicate ? { duplicate: true } : {}) };
    },
  );

  tool(
    'echo_data_delete',
    'Delete a shared-data entry, conditional on expected_version. The key keeps a tombstone and its history; to create it again, put it with the tombstone version this returns. A delete releases the owner. ' + LOOP,
    { project, key: dkey, expected_version: expectedVersion, note: dnote, notify: dnotify, request_id: drequest },
    async (a) => {
      const r = await deleteEntry(ctx, actor, {
        projectId: await projectId(a.project),
        key: a.key,
        expectedVersion: a.expected_version,
        note: a.note,
        notify: a.notify,
        requestId: a.request_id,
      });
      return { key: r.key, version: r.version, ...(r.duplicate ? { duplicate: true } : {}) };
    },
  );

  tool(
    'echo_data_batch',
    'Apply 1-25 shared-data operations atomically: every operation applies, or none does (one VERSION_CONFLICT lists every conflicting key in its details). ' +
      'Operations: put {key, value, expected_version, owner?}, delete {key, expected_version}, check {key, expected_version} (asserts the version, writes nothing: "only do this if the ruling I read is still v4"). ' +
      'A key may appear once; at least one put or delete; the values add up to at most 512 KiB. One note, notify and request_id apply to the whole batch. Returns {batch_id, results: [{key, version}]}. ' +
      LOOP,
    {
      project,
      ops: z
        .array(
          z.discriminatedUnion('op', [
            z.object({ op: z.literal('put'), key: dkey, value: dvalue, expected_version: expectedVersion, owner: downer }).strict(),
            z.object({ op: z.literal('delete'), key: dkey, expected_version: expectedVersion }).strict(),
            z.object({ op: z.literal('check'), key: dkey, expected_version: expectedVersion }).strict(),
          ]),
        )
        .min(1)
        .max(25),
      note: dnote,
      notify: dnotify,
      request_id: drequest,
    },
    async (a) => {
      const r = await batchWrite(ctx, actor, {
        projectId: await projectId(a.project),
        ops: a.ops.map((o) =>
          o.op === 'put'
            ? { op: 'put' as const, key: o.key, value: o.value, expectedVersion: o.expected_version, owner: o.owner }
            : { op: o.op, key: o.key, expectedVersion: o.expected_version },
        ),
        note: a.note,
        notify: a.notify,
        requestId: a.request_id,
      });
      return { batch_id: r.batchId, results: r.results, ...(r.duplicate ? { duplicate: true } : {}) };
    },
  );

  tool(
    'echo_data_history',
    'Every version of one entry, newest first: version, op (put, delete, admin_release, admin_delete), value, owner, actor, at, note, batch_id. limit defaults to 50, at most 200; before_version pages back. ' +
      'include_values (default true) false leaves the values out. A response stops early at 1 MiB; when more_before_version is present pass it as before_version.',
    { project, key: dkey, limit: z.number().int().optional(), before_version: id.optional(), include_values: z.boolean().optional() },
    async (a) => {
      const r = await entryHistory(ctx, actor, await projectId(a.project), a.key, { limit: a.limit, beforeVersion: a.before_version, includeValues: a.include_values });
      return { versions: r.versions.map(historyView), ...(r.beforeVersion === undefined ? {} : { more_before_version: r.beforeVersion }) };
    },
  );

  tool(
    'echo_changes_since',
    'What changed in a project after change number since_seq (use 0 for everything). Returns the changes in order and next_seq: pass it as since_seq next time. limit defaults to 200, at most 500.',
    { project, since_seq: z.number().int().nonnegative(), limit: z.number().int().optional() },
    async (a) => {
      const limit = a.limit ?? 200;
      if (limit < 1 || limit > 500) {
        throw ruleError('BAD_LIMIT', `A limit of ${limit} is not allowed.`, 'Use a whole number from 1 to 500.');
      }
      const changes = await changesSince(ctx, await projectId(a.project), a.since_seq, limit);
      return {
        changes: changes.map((c) => ({ seq: c.seq, at: c.at, actor: c.actor, kind: c.kind, subject_id: c.subjectId, data: c.data })),
        next_seq: changes.length ? changes[changes.length - 1].seq : a.since_seq,
      };
    },
  );
}
