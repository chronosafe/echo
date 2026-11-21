import type { Ctx } from '../ctx';
import { EchoError, ruleError, serviceError } from '../errors';
import { enqueueStatus } from '../github/status';
import { parseZonedTime, slotText } from '../time';
import type { Actor } from '../types';
import { actorLabel } from '../types';
import type { ApprovalInfo, ApproverView, EventApprovalsHook, EventView, ScheduleStatus } from './calendar';
import { loadEvent, setEventApprovalsHook, setScheduleDecider } from './calendar';
import { changeStmt } from './changelog';
import type { HoldView } from './holds';
import { holdsFor, placeHold } from './holds';
import { ackMessageInternal, adminAckMessage, newMessageStmts } from './messages';
import { findRepo, getProject, normalizeRepo } from './projects';

export const DEFAULT_APPROVAL_WINDOW_MIN = 30;
export const APPROVAL_ESCALATE_MIN = 30;

const ECHO: Actor = { kind: 'system', name: 'Echo' };
const ADMIN: Actor = { kind: 'admin' };
const MINUTE = 60_000;

export type Block =
  | { kind: 'hold'; hold: HoldView }
  | { kind: 'no_slot' }
  | { kind: 'approval_missing'; eventId: number; startsAt: string; missing: string[] }
  | { kind: 'outside_window'; eventId: number; startsAt: string; windowStart: string; windowEnd: string };

export type MergeDecision = { gated: boolean; allowed: boolean; blocks: Block[]; eventId: number | null };

export type PendingApproval = { eventId: number; repo: string; pr: number; startsAt: string; merger: string };

// ---------------------------------------------------------------- time helpers

/** Epoch milliseconds; NaN for anything unreadable, which every comparison below treats as "not inside". */
function ms(iso: string): number {
  return Date.parse(iso);
}

function windowMs(project: { approval_window_min: number }): number {
  const w = project.approval_window_min;
  return (Number.isFinite(w) && w >= 0 ? w : DEFAULT_APPROVAL_WINDOW_MIN) * MINUTE;
}

/** Inclusive at both edges: [start − W, start + W]. */
function inWindow(nowMs: number, startMs: number, w: number): boolean {
  return startMs - w <= nowMs && nowMs <= startMs + w;
}

/**
 * An approval counts only for the slot it was given for: `approved_for_starts_at` must be the event's
 * current start, compared as instants. A move clears approvals too; this is the second guard.
 */
function approvedFor(r: { response: string | null; approved_for_starts_at: string | null }, startsAt: string): boolean {
  if (r.response !== 'approved' || r.approved_for_starts_at === null) return false;
  const given = ms(r.approved_for_starts_at);
  return Number.isFinite(given) && given === ms(startsAt);
}

function iso(t: number, fallback: string): string {
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback;
}

/** The event's PR needs its echo/hold status recomputed; goes in the same batch as the change. */
async function statusJob(ctx: Ctx, e: Pick<EventView, 'repo' | 'pr'>): Promise<D1PreparedStatement[]> {
  if (e.repo === null || e.pr === null) return [];
  const repo = await findRepo(ctx, e.repo);
  return repo ? [enqueueStatus(ctx, repo.id, e.pr)] : [];
}

// ---------------------------------------------------------------- approvers and their requests

type Member = { id: number; name: string };

/** Named approvers, or by default every active project member other than the merger. */
async function resolveApprovers(ctx: Ctx, event: { projectId: number; merger: string | null }, named: string[] | undefined): Promise<Member[]> {
  const { results: members } = await ctx.db
    .prepare(
      `SELECT a.id, a.name FROM agents a JOIN project_agents pa ON pa.agent_id = a.id
       WHERE pa.project_id = ? AND a.revoked_at IS NULL ORDER BY a.name`,
    )
    .bind(event.projectId)
    .all<Member>();
  const merger = event.merger?.toLowerCase() ?? null;
  let chosen: Member[];
  if (named && named.length) {
    chosen = [];
    for (const raw of named) {
      const want = raw.trim().toLowerCase();
      const hit = members.find((m) => m.name.toLowerCase() === want);
      if (!hit) {
        throw ruleError(
          'UNKNOWN_APPROVER',
          `"${raw}" is not an agent in this project.`,
          `Name approvers from: ${members.map((m) => m.name).join(', ') || '(no agents)'}.`,
          404,
        );
      }
      if (hit.name.toLowerCase() === merger) {
        throw ruleError('APPROVER_IS_MERGER', `${hit.name} is the merging agent and cannot approve its own merge.`, 'Name other agents in the project as approvers.');
      }
      if (!chosen.some((c) => c.id === hit.id)) chosen.push(hit);
    }
  } else {
    chosen = members.filter((m) => m.name.toLowerCase() !== merger);
  }
  if (!chosen.length) {
    throw ruleError(
      'NO_APPROVERS',
      'Nobody in this project other than the merging agent could approve this merge.',
      'Ask the owner to add another agent to the project, or to turn off approvals for it.',
    );
  }
  return chosen;
}

function requestBody(e: EventView): string {
  return `APPROVAL REQUESTED: ${e.merger ?? e.createdBy} plans to merge ${e.repo}#${e.pr} at ${slotText(e.startsAt)}. Approve with echo_approve_merge (event_id=${e.id}) or object with echo_object_merge.`;
}

/** max(now, min(now + 30 min, slot)): never before the request exists, never after the slot. */
function requestEscalateAt(ctx: Ctx, e: EventView): string {
  const now = ms(ctx.now());
  const start = ms(e.startsAt);
  const at = Math.max(now, Math.min(now + APPROVAL_ESCALATE_MIN * MINUTE, Number.isFinite(start) ? start : now));
  return new Date(at).toISOString();
}

/** True while the event is open and still at the time this batch was built for. */
const EVENT_AT = `EXISTS (SELECT 1 FROM events WHERE id = ? AND starts_at = ? AND cancelled_at IS NULL AND merged_at IS NULL)`;

/**
 * One approver's request: `first` must change exactly one row when the request should be sent (it carries
 * the EVENT_AT guard); the message, its log entries and the link then run only if it did.
 */
function requestStmts(ctx: Ctx, e: EventView, approver: Member, first: D1PreparedStatement): D1PreparedStatement[] {
  return [
    first,
    ...newMessageStmts(
      ctx,
      ECHO,
      {
        projectId: e.projectId,
        senderAgentId: null,
        label: 'Echo',
        body: requestBody(e),
        requiresAck: true,
        escalateAt: requestEscalateAt(ctx, e),
        kind: 'approval_request',
        refId: e.id,
        recipientIds: [approver.id],
      },
      true,
    ),
    ctx.db
      .prepare(`UPDATE event_approvers SET request_message_id = (SELECT MAX(id) FROM messages) WHERE event_id = ? AND agent_id = ? AND changes() > 0`)
      .bind(e.id, approver.id),
    changeStmt(
      ctx,
      { projectId: e.projectId, actor: ECHO, kind: 'approval.requested', subjectId: e.id, data: { approver: approver.name, startsAt: e.startsAt } },
      { guarded: true },
    ),
  ];
}

function createStmts(ctx: Ctx, e: EventView, approvers: Member[]): D1PreparedStatement[] {
  // INSERT OR IGNORE: a re-run for an approver who already has a row sends nothing.
  return approvers.flatMap((a) =>
    requestStmts(
      ctx,
      e,
      a,
      ctx.db
        .prepare(`INSERT OR IGNORE INTO event_approvers (event_id, agent_id) SELECT ?, ? WHERE ${EVENT_AT}`)
        .bind(e.id, a.id, e.id, e.startsAt),
    ),
  );
}

/**
 * Withdraws the event's approval requests that nobody has acknowledged, logging each one. Guarded so that a batch
 * whose own change was refused withdraws nothing: after a move, only while the event is still open at the new slot;
 * after a cancel, only once the event is cancelled (a refused cancel of a merged event leaves it uncancelled).
 */
function withdrawStmts(ctx: Ctx, eventId: number, guard: { startsAt: string } | { cancelled: true }): D1PreparedStatement[] {
  const event =
    'startsAt' in guard
      ? `EXISTS (SELECT 1 FROM events WHERE id = ?1 AND starts_at = ?3 AND cancelled_at IS NULL AND merged_at IS NULL)`
      : `EXISTS (SELECT 1 FROM events WHERE id = ?1 AND cancelled_at IS NOT NULL)`;
  const open = `m.kind = 'approval_request' AND m.ref_id = ?1 AND m.withdrawn_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM message_recipients r WHERE r.message_id = m.id AND r.acked_at IS NOT NULL)
    AND ${event}`;
  const binds = 'startsAt' in guard ? [eventId, ctx.now(), guard.startsAt] : [eventId, ctx.now()];
  return [
    ctx.db
      .prepare(
        `INSERT INTO change_log (project_id, at, actor, kind, subject_id, data)
         SELECT m.project_id, ?2, 'Echo', 'message.withdrawn', m.id, NULL FROM messages m WHERE ${open} ORDER BY m.id`,
      )
      .bind(...binds),
    ctx.db.prepare(`UPDATE messages AS m SET withdrawn_at = ?2 WHERE ${open}`).bind(...binds),
  ];
}

async function onCreate(ctx: Ctx, event: EventView, named?: string[]): Promise<D1PreparedStatement[]> {
  return [...createStmts(ctx, event, await resolveApprovers(ctx, event, named)), ...(await statusJob(ctx, event))];
}

async function onMove(ctx: Ctx, event: EventView): Promise<D1PreparedStatement[]> {
  const project = await getProject(ctx, event.projectId);
  const { results: approvers } = await ctx.db
    .prepare(`SELECT ea.agent_id AS id, COALESCE(a.name, 'agent ' || ea.agent_id) AS name FROM event_approvers ea LEFT JOIN agents a ON a.id = ea.agent_id WHERE ea.event_id = ? ORDER BY name`)
    .bind(event.id)
    .all<Member>();
  const stmts = withdrawStmts(ctx, event.id, { startsAt: event.startsAt });
  const clear = (agentId: number) =>
    ctx.db
      .prepare(
        `UPDATE event_approvers SET response = NULL, responded_at = NULL, responded_by = NULL, approved_for_starts_at = NULL,
           objection_hold_id = NULL, request_message_id = NULL
         WHERE event_id = ? AND agent_id = ? AND ${EVENT_AT}`,
      )
      .bind(event.id, agentId, event.id, event.startsAt);

  if (approvers.length) {
    stmts.push(
      ctx.db
        .prepare(
          `INSERT INTO change_log (project_id, at, actor, kind, subject_id, data) SELECT ?, ?, 'Echo', 'approval.cleared', ?, ? WHERE ${EVENT_AT}`,
        )
        .bind(event.projectId, ctx.now(), event.id, JSON.stringify({ startsAt: event.startsAt }), event.id, event.startsAt),
    );
    for (const a of approvers) {
      stmts.push(...(project.approvals_required ? requestStmts(ctx, event, a, clear(a.id)) : [clear(a.id)]));
    }
  } else if (project.approvals_required) {
    // The create-time batch never ran (or failed): set the approvers up now, with the default list.
    let fresh: Member[] = [];
    try {
      fresh = await resolveApprovers(ctx, event, undefined);
    } catch (e) {
      if (!(e instanceof EchoError && e.code === 'NO_APPROVERS')) throw e;
      // Nobody can approve: the merge decision keeps refusing (approval_missing with no names).
    }
    stmts.push(...createStmts(ctx, event, fresh));
  }
  stmts.push(...(await statusJob(ctx, event)));
  return stmts;
}

async function onCancel(ctx: Ctx, event: EventView): Promise<D1PreparedStatement[]> {
  return [...withdrawStmts(ctx, event.id, { cancelled: true }), ...(await statusJob(ctx, event))];
}

// ---------------------------------------------------------------- responding

type ApproverRow = {
  agent_id: number;
  name: string;
  request_message_id: number | null;
  response: 'approved' | 'objected' | null;
  approved_for_starts_at: string | null;
  objection_hold_id: number | null;
  hold_open: number;
};

async function loadApprover(ctx: Ctx, eventId: number, who: { agentId: number } | { name: string }): Promise<ApproverRow | null> {
  const byId = 'agentId' in who;
  return ctx.db
    .prepare(
      `SELECT ea.agent_id, a.name, ea.request_message_id, ea.response, ea.approved_for_starts_at, ea.objection_hold_id,
              EXISTS (SELECT 1 FROM holds h WHERE h.id = ea.objection_hold_id AND h.state = 'open') AS hold_open
       FROM event_approvers ea JOIN agents a ON a.id = ea.agent_id
       WHERE ea.event_id = ? AND ${byId ? 'ea.agent_id = ?' : 'lower(a.name) = lower(?)'}`,
    )
    .bind(eventId, byId ? who.agentId : who.name.trim())
    .first<ApproverRow>();
}

function notApprover(eventId: number, who: string) {
  return ruleError('NOT_APPROVER', `${who} is not an approver of event ${eventId}.`, 'Only the approvers listed on the merge event can answer it; see echo_pending_approvals.', 403);
}

function eventClosed(eventId: number) {
  return ruleError('EVENT_CLOSED', `Merge event ${eventId} is cancelled or already merged.`, 'Nothing more is needed for it.', 409);
}

function objectionOpen(row: ApproverRow) {
  return ruleError(
    'OBJECTION_OPEN',
    `${row.name} objected to this merge and objection hold ${row.objection_hold_id} is still open.`,
    `Release hold ${row.objection_hold_id} with echo_release_hold first, then approve.`,
    409,
  );
}

async function ackRequest(ctx: Ctx, row: ApproverRow | null, by: 'agent' | 'admin', note: string): Promise<void> {
  if (!row?.request_message_id) return;
  try {
    if (by === 'admin') await adminAckMessage(ctx, row.request_message_id, row.agent_id);
    else await ackMessageInternal(ctx, row.agent_id, row.request_message_id, note);
  } catch (e) {
    // The event was cancelled in between and its request withdrawn: the response itself stands.
    if (!(e instanceof EchoError && e.code === 'MESSAGE_WITHDRAWN')) throw e;
  }
}

async function approve(ctx: Ctx, eventId: number, who: { agentId: number } | { name: string }, by: Actor): Promise<void> {
  const event = await loadEvent(ctx, eventId);
  const row = await loadApprover(ctx, eventId, who);
  if (!row) throw notApprover(eventId, 'agentId' in who ? actorLabel(by) : who.name);
  if (event.cancelled || event.mergedAt) throw eventClosed(eventId);
  const ackBy = by.kind === 'admin' ? 'admin' : 'agent';
  if (approvedFor(row, event.startsAt)) return ackRequest(ctx, row, ackBy, 'Approved.');
  const project = await getProject(ctx, event.projectId);
  if (!(ms(ctx.now()) <= ms(event.startsAt) + windowMs(project))) {
    throw ruleError(
      'WINDOW_CLOSED',
      `The approval window for the ${slotText(event.startsAt)} merge slot has closed.`,
      'Ask the merging agent to move the event to a new time; a new approval request will follow.',
      409,
    );
  }
  if (row.response === 'objected' && row.hold_open) throw objectionOpen(row);

  const label = actorLabel(by);
  // The update re-checks everything it depends on, so a move, cancel or new objection that lands first wins.
  const [res] = await ctx.db.batch([
    ctx.db
      .prepare(
        `UPDATE event_approvers SET response = 'approved', responded_at = ?, responded_by = ?, approved_for_starts_at = ?, objection_hold_id = NULL
         WHERE event_id = ? AND agent_id = ?
           AND (response IS NULL
             OR (response = 'approved' AND approved_for_starts_at IS NOT ?)
             OR (response = 'objected' AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.id = objection_hold_id AND h.state = 'open')))
           AND ${EVENT_AT}`,
      )
      .bind(ctx.now(), label, event.startsAt, eventId, row.agent_id, event.startsAt, eventId, event.startsAt),
    changeStmt(
      ctx,
      { projectId: event.projectId, actor: by, kind: 'approval.approved', subjectId: eventId, data: { approver: row.name, startsAt: event.startsAt } },
      { guarded: true },
    ),
    ...(await statusJob(ctx, event)),
  ]);
  if (!res.meta.changes) {
    const now = await loadEvent(ctx, eventId);
    if (now.cancelled || now.mergedAt) throw eventClosed(eventId);
    if (now.startsAt !== event.startsAt) {
      throw ruleError('EVENT_MOVED', `Merge event ${eventId} moved to ${slotText(now.startsAt)} while you were approving.`, 'Read the new approval request and answer it.', 409);
    }
    const again = await loadApprover(ctx, eventId, { agentId: row.agent_id });
    if (again && approvedFor(again, now.startsAt)) return ackRequest(ctx, again, ackBy, 'Approved.');
    if (again?.response === 'objected' && again.hold_open) throw objectionOpen(again);
    throw serviceError('APPROVAL_FAILED', `The approval for event ${eventId} could not be recorded.`);
  }
  await ackRequest(ctx, await loadApprover(ctx, eventId, { agentId: row.agent_id }), ackBy, 'Approved.');
}

async function agentActor(ctx: Ctx, agentId: number): Promise<Actor> {
  const a = await ctx.db.prepare(`SELECT name FROM agents WHERE id = ?`).bind(agentId).first<{ name: string }>();
  if (!a) throw ruleError('AGENT_NOT_FOUND', `There is no agent ${agentId}.`, 'Check the agent id.', 404);
  return { kind: 'agent', agentId, name: a.name };
}

export async function approveMerge(ctx: Ctx, agentId: number, eventId: number): Promise<void> {
  await approve(ctx, eventId, { agentId }, await agentActor(ctx, agentId));
}

/** The owner approves on an absent approver's behalf; the row and the log record 'admin'. */
export async function adminApprove(ctx: Ctx, eventId: number, agentName: string): Promise<void> {
  await approve(ctx, eventId, { name: agentName }, ADMIN);
}

/** Objects with a reason: a blocking hold placed by the objector, linked from the approver row. */
export async function objectMerge(ctx: Ctx, agentId: number, eventId: number, reason: string): Promise<HoldView> {
  const why = reason.trim();
  if (!why) throw ruleError('REASON_REQUIRED', 'An objection needs a reason.', 'Say what must change before this merge, for example "tests are flaky on main".');
  const actor = await agentActor(ctx, agentId);
  const event = await loadEvent(ctx, eventId);
  const row = await loadApprover(ctx, eventId, { agentId });
  if (!row) throw notApprover(eventId, actor.kind === 'agent' ? actor.name : String(agentId));
  if (event.cancelled || event.mergedAt) throw eventClosed(eventId);
  if (row.response === 'objected' && row.hold_open && row.objection_hold_id !== null) {
    const existing = (await holdsFor(ctx, event.repo!, event.pr!)).find((h) => h.id === row.objection_hold_id);
    if (existing) return existing;
  }

  // The hold blocks the PR on its own from here on, whatever happens to the event.
  const hold = await placeHold(ctx, actor, {
    repo: event.repo!,
    pr: event.pr!,
    reason: `Objection to the ${slotText(event.startsAt)} merge slot: ${why}`,
    kind: 'blocking',
  });
  await ctx.db.batch([
    ctx.db
      .prepare(`UPDATE event_approvers SET response = 'objected', responded_at = ?, responded_by = ?, approved_for_starts_at = NULL, objection_hold_id = ?
         WHERE event_id = ? AND agent_id = ?`)
      .bind(ctx.now(), actorLabel(actor), hold.id, eventId, agentId),
    changeStmt(
      ctx,
      { projectId: event.projectId, actor, kind: 'approval.objected', subjectId: eventId, data: { approver: actorLabel(actor), holdId: hold.id, reason: why } },
      { guarded: true },
    ),
    ...(await statusJob(ctx, event)),
  ]);
  await ackRequest(ctx, await loadApprover(ctx, eventId, { agentId }), 'agent', `Objected: ${why}`);
  return hold;
}

/** Merge events the agent has not yet answered whose window has not closed, soonest first. */
export async function pendingApprovals(ctx: Ctx, agentId: number): Promise<PendingApproval[]> {
  const { results } = await ctx.db
    .prepare(
      `SELECT e.id, r.full_name AS repo, e.pr_number, e.starts_at, COALESCE(a.name, e.created_by) AS merger, p.approval_window_min
       FROM event_approvers ea
       JOIN events e ON e.id = ea.event_id
       JOIN projects p ON p.id = e.project_id
       JOIN repos r ON r.id = e.repo_id
       LEFT JOIN agents a ON a.id = e.merger_agent_id
       WHERE ea.agent_id = ? AND ea.response IS NULL AND e.kind = 'merge' AND e.cancelled_at IS NULL AND e.merged_at IS NULL
       ORDER BY e.starts_at, e.id`,
    )
    .bind(agentId)
    .all<{ id: number; repo: string; pr_number: number; starts_at: string; merger: string; approval_window_min: number }>();
  const now = ms(ctx.now());
  return results
    .filter((r) => now <= ms(r.starts_at) + windowMs(r))
    .map((r) => ({ eventId: r.id, repo: r.repo, pr: r.pr_number, startsAt: r.starts_at, merger: r.merger }));
}

// ---------------------------------------------------------------- the decision

type Candidate = { id: number; starts_at: string; start: number };
type ResponseRow = { name: string; response: string | null; approved_for_starts_at: string | null; objection_hold_id: number | null };

async function responses(ctx: Ctx, eventId: number): Promise<ResponseRow[]> {
  // LEFT JOIN: an approver row whose agent cannot be found still counts as not approved.
  const { results } = await ctx.db
    .prepare(
      `SELECT COALESCE(a.name, 'agent ' || ea.agent_id) AS name, ea.response, ea.approved_for_starts_at, ea.objection_hold_id
       FROM event_approvers ea LEFT JOIN agents a ON a.id = ea.agent_id WHERE ea.event_id = ? ORDER BY name`,
    )
    .bind(eventId)
    .all<ResponseRow>();
  return results;
}

/** Nearest start to now first; ties go to the earlier start, then the lower id. Unreadable starts sort last. */
function byNearest(now: number) {
  const d = (c: Candidate) => (Number.isFinite(c.start) ? Math.abs(c.start - now) : Infinity);
  return (a: Candidate, b: Candidate) => d(a) - d(b) || a.start - b.start || a.id - b.id;
}

/**
 * Whether the PR may merge now. Fails closed: in a project that requires approvals, anything short of an
 * open window on an uncancelled, unmerged merge event whose every approver row is approved for that event's
 * current start is a block.
 */
export async function mergeDecision(ctx: Ctx, repo: string, pr: number): Promise<MergeDecision> {
  const name = normalizeRepo(repo);
  const found = await findRepo(ctx, name);
  if (!found) return { gated: false, allowed: true, blocks: [], eventId: null };

  const project = await getProject(ctx, found.project_id);
  const holds = (await holdsFor(ctx, name, pr)).filter((h) => h.blocksMerge);
  const blocks: Block[] = holds.map((hold) => ({ kind: 'hold', hold }));
  let eventId: number | null = null;

  if (project.approvals_required) {
    const { results } = await ctx.db
      .prepare(
        `SELECT id, starts_at FROM events
         WHERE repo_id = ? AND pr_number = ? AND kind = 'merge' AND cancelled_at IS NULL AND merged_at IS NULL`,
      )
      .bind(found.id, pr)
      .all<{ id: number; starts_at: string }>();
    const candidates: Candidate[] = results.map((r) => ({ ...r, start: ms(r.starts_at) }));
    if (!candidates.length) {
      blocks.push({ kind: 'no_slot' });
    } else {
      const now = ms(ctx.now());
      const w = windowMs(project);
      const open = candidates.filter((c) => inWindow(now, c.start, w)).sort(byNearest(now));
      if (open.length) {
        const chosen = open[0];
        eventId = chosen.id;
        const rows = await responses(ctx, chosen.id);
        // An objector whose hold is blocking right now is already reported, as that hold.
        const blockingHoldIds = new Set(holds.map((h) => h.id));
        const missing = rows
          .filter((r) => !approvedFor(r, chosen.starts_at))
          .filter((r) => !(r.response === 'objected' && r.objection_hold_id !== null && blockingHoldIds.has(r.objection_hold_id)))
          .map((r) => r.name);
        // No approver rows at all is never "everyone approved".
        if (rows.length === 0 || missing.length) {
          blocks.push({ kind: 'approval_missing', eventId: chosen.id, startsAt: chosen.starts_at, missing });
        }
      } else {
        const nearest = [...candidates].sort(byNearest(now))[0];
        eventId = nearest.id;
        blocks.push({
          kind: 'outside_window',
          eventId: nearest.id,
          startsAt: nearest.starts_at,
          windowStart: iso(nearest.start - w, nearest.starts_at),
          windowEnd: iso(nearest.start + w, nearest.starts_at),
        });
      }
    }
  }
  return { gated: true, allowed: blocks.length === 0, blocks, eventId };
}

/** PRs with an open merge event whose window opens or closes in [fromIso, toIso). For the status cron. */
export async function windowEdgesBetween(ctx: Ctx, fromIso: string, toIso: string): Promise<{ repoId: number; pr: number }[]> {
  const lo = ms(parseZonedTime(fromIso).utc);
  const hi = ms(parseZonedTime(toIso).utc);
  const widest = await ctx.db.prepare(`SELECT MAX(approval_window_min) AS w FROM projects`).first<{ w: number | null }>();
  // A wide string prefilter (one extra minute covers stored times with or without milliseconds);
  // the exact test is done on epoch milliseconds below.
  const margin = ((widest?.w ?? DEFAULT_APPROVAL_WINDOW_MIN) + 1) * MINUTE;
  const { results } = await ctx.db
    .prepare(
      `SELECT e.repo_id, e.pr_number, e.starts_at, p.approval_window_min
       FROM projects p JOIN events e ON e.project_id = p.id
       WHERE e.starts_at >= ? AND e.starts_at <= ? AND e.kind = 'merge' AND e.repo_id IS NOT NULL
         AND e.cancelled_at IS NULL AND e.merged_at IS NULL
       ORDER BY e.repo_id, e.pr_number`,
    )
    .bind(new Date(lo - margin).toISOString(), new Date(hi + margin).toISOString())
    .all<{ repo_id: number; pr_number: number; starts_at: string; approval_window_min: number }>();
  const out: { repoId: number; pr: number }[] = [];
  for (const r of results) {
    const s = ms(r.starts_at);
    const w = windowMs(r);
    const hit = [s - w, s + w].some((edge) => lo <= edge && edge < hi);
    if (hit && !out.some((o) => o.repoId === r.repo_id && o.pr === r.pr_number)) out.push({ repoId: r.repo_id, pr: r.pr_number });
  }
  return out;
}

// ---------------------------------------------------------------- schedule view and registration

async function decideSchedule(ctx: Ctx, event: EventView, info: ApprovalInfo): Promise<Exclude<ScheduleStatus, 'merged'>> {
  // The approvers come from the rows describeMany read; an approval given for another start is already shown as no response.
  const blocked = event.repo !== null && event.pr !== null && (await holdsFor(ctx, event.repo, event.pr)).some((h) => h.blocksMerge);
  if (blocked) return 'blocked';
  if (!info.approvalRequired) return 'scheduled';
  const project = await getProject(ctx, event.projectId);
  // Past the window's inclusive end mergeDecision refuses this slot whatever its approvals (outside_window), and
  // approving it is refused too. (Merged events never reach here; cancelled ones are not in the schedule.)
  if (!(ms(ctx.now()) <= ms(event.startsAt) + windowMs(project))) return 'window_closed';
  const all = info.approvers.length > 0 && info.approvers.every((a) => a.response === 'approved');
  return all ? 'approved' : 'waiting_approval';
}

/** Called at module load; exported so tests can re-register after clearing the calendar's hooks. */
async function checkCreate(ctx: Ctx, draft: { projectId: number; merger: string | null }, named?: string[]): Promise<void> {
  await resolveApprovers(ctx, draft, named);
}

type ListedApproverRow = ResponseRow & { event_id: number; responded_at: string | null; responded_by: string | null };

/** One query for the approver rows of every given event (chunked under D1's bound-parameter limit). */
async function approverRows(ctx: Ctx, eventIds: number[]): Promise<Map<number, ListedApproverRow[]>> {
  const byEvent = new Map<number, ListedApproverRow[]>();
  for (let i = 0; i < eventIds.length; i += 90) {
    const ids = eventIds.slice(i, i + 90);
    const { results } = await ctx.db
      .prepare(
        `SELECT ea.event_id, COALESCE(a.name, 'agent ' || ea.agent_id) AS name, ea.response, ea.approved_for_starts_at,
                ea.objection_hold_id, ea.responded_at, ea.responded_by
         FROM event_approvers ea LEFT JOIN agents a ON a.id = ea.agent_id
         WHERE ea.event_id IN (${ids.map(() => '?').join(',')}) ORDER BY ea.event_id, name`,
      )
      .bind(...ids)
      .all<ListedApproverRow>();
    for (const r of results) byEvent.set(r.event_id, [...(byEvent.get(r.event_id) ?? []), r]);
  }
  return byEvent;
}

async function describeMany(ctx: Ctx, events: EventView[]): Promise<Map<number, ApprovalInfo>> {
  const out = new Map<number, ApprovalInfo>();
  const merges = events.filter((e) => e.kind === 'merge');
  if (!merges.length) return out;
  const projects = new Map<number, Awaited<ReturnType<typeof getProject>>>();
  for (const e of merges) if (!projects.has(e.projectId)) projects.set(e.projectId, await getProject(ctx, e.projectId));
  const needed = merges.filter((e) => projects.get(e.projectId)!.approvals_required);
  const rows = needed.length ? await approverRows(ctx, needed.map((e) => e.id)) : new Map<number, ListedApproverRow[]>();
  for (const e of merges) {
    const project = projects.get(e.projectId)!;
    if (!project.approvals_required) {
      out.set(e.id, { approvalRequired: false, approvers: [] });
      continue;
    }
    const w = windowMs(project);
    out.set(e.id, {
      approvalRequired: true,
      approvers: (rows.get(e.id) ?? []).map((r): ApproverView => {
        // An approval given for another start time is shown as no response: it does not count.
        const response = r.response === 'approved' ? (approvedFor(r, e.startsAt) ? 'approved' : null) : r.response === 'objected' ? 'objected' : null;
        return {
          name: r.name,
          response,
          at: response && r.responded_at ? slotText(r.responded_at) : null,
          by: response ? r.responded_by : null,
          ...(response === 'objected' && r.objection_hold_id !== null ? { holdId: r.objection_hold_id } : {}),
        };
      }),
      windowStart: slotText(new Date(ms(e.startsAt) - w).toISOString()),
      windowEnd: slotText(new Date(ms(e.startsAt) + w).toISOString()),
    });
  }
  return out;
}

export const approvalsHook: EventApprovalsHook = { checkCreate, onCreate, onMove, onCancel, describeMany };

export function registerApprovals(): void {
  setEventApprovalsHook(approvalsHook);
  setScheduleDecider(decideSchedule);
}

registerApprovals();
