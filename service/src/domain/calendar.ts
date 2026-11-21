import type { Ctx } from '../ctx';
import { EchoError, ruleError } from '../errors';
import { parseZonedTime } from '../time';
import type { Actor } from '../types';
import { actorLabel } from '../types';
import { changeStmt } from './changelog';
import { checkTitleSize } from './messages';
import { findRepo, getProject, requireMember } from './projects';

export type Importance = 'low' | 'normal' | 'high';
const IMPORTANCES: Importance[] = ['low', 'normal', 'high'];

export type EventView = {
  id: number;
  projectId: number;
  title: string;
  startsAt: string;
  enteredAs: string;
  importance: Importance;
  kind: string;
  repo: string | null;
  pr: number | null;
  merger: string | null;
  createdBy: string;
  mergedAt: string | null;
  mergedBy: string | null;
  afterTheFact: boolean;
  cancelled: boolean;
};

/** What a merge event's reply adds: whether approval is needed, from whom, and when they can approve. */
export type ApproverView = {
  name: string;
  response: 'approved' | 'objected' | null;
  /** When the response was recorded, UTC without milliseconds; null while there is none. */
  at: string | null;
  /** Who recorded it: the approver, or 'admin' for an approve-for. */
  by: string | null;
  /** The blocking hold an objection placed. */
  holdId?: number;
};
export type ApprovalInfo = { approvalRequired: boolean; approvers: ApproverView[]; windowStart?: string; windowEnd?: string };

export type ScheduleStatus = 'waiting_approval' | 'approved' | 'window_closed' | 'blocked' | 'merged' | 'scheduled';
export type ScheduleRow = EventView & {
  status: ScheduleStatus;
  isNext: boolean;
  approvers: ApproverView[];
};

export type EventApprovalsHook = {
  /**
   * Before a merge event is inserted: resolves its approvers and throws the rule error that refuses it (for example
   * NO_APPROVERS), so a refused request leaves no event behind.
   */
  checkCreate?(ctx: Ctx, draft: { projectId: number; merger: string | null }, approvers?: string[]): Promise<void>;
  onCreate(ctx: Ctx, event: EventView, approvers?: string[]): Promise<D1PreparedStatement[]>;
  /** Given the event as it will be after the move; the statements run in the same batch as the move. */
  onMove(ctx: Ctx, event: EventView): Promise<D1PreparedStatement[]>;
  /** Statements run in the same batch as the cancellation. */
  onCancel?(ctx: Ctx, event: EventView): Promise<D1PreparedStatement[]>;
  /** The approval facts of stored merge events, read with one query for all of them (the rows mergeDecision reads). */
  describeMany?(ctx: Ctx, events: EventView[]): Promise<Map<number, ApprovalInfo>>;
};

/** A merge event's view with its approval facts; any other event is returned as it is. */
async function withApprovals<T extends EventView>(ctx: Ctx, events: T[]): Promise<(T & Partial<ApprovalInfo>)[]> {
  const merges = events.filter((e) => e.kind === 'merge');
  if (!merges.length) return events;
  const infos = approvalsHook?.describeMany ? await approvalsHook.describeMany(ctx, merges) : new Map<number, ApprovalInfo>();
  return events.map((e) => (e.kind === 'merge' ? { ...e, ...(infos.get(e.id) ?? { approvalRequired: false, approvers: [] }) } : e));
}

async function withApproval(ctx: Ctx, event: EventView): Promise<EventView & Partial<ApprovalInfo>> {
  return (await withApprovals(ctx, [event]))[0];
}
export type ScheduleDecider = (
  ctx: Ctx,
  event: EventView,
  info: ApprovalInfo,
) => Promise<Exclude<ScheduleStatus, 'merged'>>;

let approvalsHook: EventApprovalsHook | null = null;
let scheduleDecider: ScheduleDecider | null = null;

/** Task 6 registers the approvals behaviour here (kept out of imports to avoid a cycle). */
export function setEventApprovalsHook(h: EventApprovalsHook | null): void {
  approvalsHook = h;
}
/** Task 6 registers mergeDecision's schedule view here. */
export function setScheduleDecider(d: ScheduleDecider | null): void {
  scheduleDecider = d;
}

type EventRow = {
  id: number;
  project_id: number;
  title: string;
  starts_at: string;
  entered_as: string;
  importance: Importance;
  kind: string;
  repo: string | null;
  pr_number: number | null;
  merger: string | null;
  created_by: string;
  merged_at: string | null;
  merged_by: string | null;
  after_the_fact: number;
  cancelled_at: string | null;
};

const EVENT_SELECT = `
  SELECT e.id, e.project_id, e.title, e.starts_at, e.entered_as, e.importance, e.kind,
         r.full_name AS repo, e.pr_number, a.name AS merger, e.created_by,
         e.merged_at, e.merged_by, e.after_the_fact, e.cancelled_at
  FROM events e
  LEFT JOIN repos r ON r.id = e.repo_id
  LEFT JOIN agents a ON a.id = e.merger_agent_id`;

function toView(r: EventRow): EventView {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    startsAt: r.starts_at,
    enteredAs: r.entered_as,
    importance: r.importance,
    kind: r.kind,
    repo: r.repo,
    pr: r.pr_number,
    merger: r.merger,
    createdBy: r.created_by,
    mergedAt: r.merged_at,
    mergedBy: r.merged_by,
    afterTheFact: r.after_the_fact === 1,
    cancelled: r.cancelled_at !== null,
  };
}

export async function loadEvent(ctx: Ctx, id: number, inProject?: number): Promise<EventView> {
  const row = await ctx.db.prepare(`${EVENT_SELECT} WHERE e.id = ?`).bind(id).first<EventRow>();
  if (!row || (inProject !== undefined && row.project_id !== inProject)) throw ruleError('EVENT_NOT_FOUND', `There is no event ${id}.`, 'Check the event id.', 404);
  return toView(row);
}

async function requireProjectAccess(ctx: Ctx, actor: Actor, projectId: number): Promise<void> {
  if (actor.kind === 'agent') await requireMember(ctx, actor.agentId, projectId);
}

function checkImportance(i: string | undefined): Importance {
  if (i === undefined) return 'normal';
  if (!IMPORTANCES.includes(i as Importance)) {
    throw ruleError('BAD_IMPORTANCE', `Importance "${i}" is not one of low, normal, high.`, 'Use low, normal or high.');
  }
  return i as Importance;
}

export async function addEvent(
  ctx: Ctx,
  actor: Actor,
  input: {
    projectId: number;
    title: string;
    startsAt: string;
    importance?: Importance;
    kind?: string;
    repo?: string;
    pr?: number;
    merger?: string;
    approvers?: string[];
  },
): Promise<EventView & Partial<ApprovalInfo>> {
  await requireProjectAccess(ctx, actor, input.projectId);
  const project = await getProject(ctx, input.projectId);
  checkTitleSize(input.title, 'event');
  const { utc, enteredAs } = parseZonedTime(input.startsAt);
  const importance = checkImportance(input.importance);
  const kind = input.kind ?? 'event';
  let repoId: number | null = null;
  let pr: number | null = null;
  let mergerId: number | null = null;
  if (kind === 'merge') {
    if (!input.repo || input.pr === undefined) {
      throw ruleError('MERGE_NEEDS_PR', 'A merge event needs a repository and a PR number.', 'Give repo (owner/name) and pr.');
    }
    // Every path, the owner's form included: a stored PR number is what mergeDecision and the status match on.
    if (!Number.isInteger(input.pr) || input.pr < 1) {
      throw ruleError('BAD_PR', `${input.pr} is not a pull request number.`, 'Give the PR number, a whole number from 1, for example 709.');
    }
    const repo = await findRepo(ctx, input.repo);
    if (!repo) {
      throw ruleError('REPO_NOT_REGISTERED', `${input.repo} is not registered to any project.`, 'Ask the owner to register the repository to its project.', 404);
    }
    if (repo.project_id !== input.projectId) {
      throw ruleError('REPO_OTHER_PROJECT', `${repo.full_name} belongs to a different project.`, 'Put the event on the project that owns the repository.', 403);
    }
    repoId = repo.id;
    pr = input.pr;
    let mergerName: string | null = null;
    if (input.merger) {
      const m = await ctx.db
        .prepare(
          `SELECT a.id, a.name FROM agents a JOIN project_agents pa ON pa.agent_id = a.id AND pa.project_id = ? WHERE a.name = ?`,
        )
        .bind(input.projectId, input.merger)
        .first<{ id: number; name: string }>();
      if (!m) throw ruleError('MERGER_NOT_MEMBER', `${input.merger} is not a member of this project.`, 'Name an agent in the project.');
      mergerId = m.id;
      mergerName = m.name;
    } else if (actor.kind === 'agent') {
      mergerId = actor.agentId;
      mergerName = actor.name;
    }
    // Refuse before the event exists, so a refused approval request leaves no event and no log entries behind.
    if (approvalsHook?.checkCreate && project.approvals_required) {
      await approvalsHook.checkCreate(ctx, { projectId: input.projectId, merger: mergerName }, input.approvers);
    }
  }
  const inserted = await ctx.db.batch<{ id: number }>([
    ctx.db
      .prepare(
        `INSERT INTO events (project_id, title, starts_at, entered_as, importance, kind, repo_id, pr_number, merger_agent_id, created_by, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      )
      .bind(input.projectId, input.title, utc, enteredAs, importance, kind, repoId, pr, mergerId, actorLabel(actor), ctx.now()),
    changeStmt(ctx, { projectId: input.projectId, actor, kind: 'event.added', data: { title: input.title, startsAt: utc, kind } }),
    ctx.db.prepare(
      `UPDATE change_log SET subject_id = (SELECT MAX(id) FROM events) WHERE seq = (SELECT MAX(seq) FROM change_log)`,
    ),
  ]);
  const id = inserted[0].results[0].id;
  const event = await loadEvent(ctx, id);
  if (approvalsHook && project.approvals_required && kind === 'merge') {
    // Not in the insert's batch: the hook needs the new event's id. A failure here leaves a
    // merge event without approver rows, which mergeDecision refuses (approval_missing) and a move repairs.
    let stmts: D1PreparedStatement[];
    try {
      stmts = await approvalsHook.onCreate(ctx, event, input.approvers);
    } catch (e) {
      // checkCreate passed, but the approvers were refused now (membership changed in between): take the event
      // back off the calendar so it does not linger as a slot nobody was asked about, then report the refusal.
      if (e instanceof EchoError && e.kind === 'rule') {
        await ctx.db.batch([
          ctx.db
            .prepare(`UPDATE events SET cancelled_at = ?, updated_at = ? WHERE id = ? AND cancelled_at IS NULL AND merged_at IS NULL`)
            .bind(ctx.now(), ctx.now(), id),
          changeStmt(ctx, { projectId: input.projectId, actor, kind: 'event.cancelled', subjectId: id, data: { refused: e.code } }, { guarded: true }),
        ]);
      }
      throw e;
    }
    if (stmts.length) await ctx.db.batch(stmts);
  }
  return withApproval(ctx, event);
}

export async function updateEvent(
  ctx: Ctx,
  actor: Actor,
  id: number,
  patch: { title?: string; startsAt?: string; importance?: Importance },
  inProject?: number,
): Promise<EventView & Partial<ApprovalInfo>> {
  const before = await loadEvent(ctx, id, inProject);
  await requireProjectAccess(ctx, actor, before.projectId);
  if (before.cancelled || before.mergedAt) {
    throw ruleError('EVENT_CLOSED', 'That event is cancelled or already merged, so it cannot be changed.', 'Add a new event instead.');
  }
  if (patch.title !== undefined) checkTitleSize(patch.title, 'event');
  const startsAt = patch.startsAt === undefined ? null : parseZonedTime(patch.startsAt);
  const importance = patch.importance === undefined ? null : checkImportance(patch.importance);
  const moved = startsAt !== null && startsAt.utc !== before.startsAt;
  const guard = `WHERE id = ? AND cancelled_at IS NULL AND merged_at IS NULL`;
  // A move's approval changes (clear the old slot's approvals, withdraw and resend the requests) ride in
  // the move's own batch: either both commit or neither does, so no approval outlives its slot. The hook
  // builds them from the event as it will be after this update; they guard on the new start themselves.
  const hookStmts =
    moved && approvalsHook && before.kind === 'merge'
      ? await approvalsHook.onMove(ctx, {
          ...before,
          title: patch.title ?? before.title,
          startsAt: startsAt!.utc,
          enteredAs: startsAt!.enteredAs,
          importance: importance ?? before.importance,
        })
      : [];
  const res = await ctx.db.batch([
    ctx.db
      .prepare(
        `UPDATE events SET title = COALESCE(?, title), starts_at = COALESCE(?, starts_at), entered_as = COALESCE(?, entered_as),
           importance = COALESCE(?, importance), updated_at = ? ${guard}`,
      )
      .bind(patch.title ?? null, startsAt?.utc ?? null, startsAt?.enteredAs ?? null, importance, ctx.now(), id),
    changeStmt(
      ctx,
      {
        projectId: before.projectId,
        actor,
        kind: moved ? 'event.moved' : 'event.updated',
        subjectId: id,
        data: moved ? { from: before.startsAt, to: startsAt!.utc } : patch,
      },
      { guarded: true },
    ),
    ...hookStmts,
  ]);
  if (res[0].meta.changes === 0) {
    throw ruleError('EVENT_CLOSED', 'That event was cancelled or merged just now, so it cannot be changed.', 'Add a new event instead.', 409);
  }
  return withApproval(ctx, await loadEvent(ctx, id));
}

export async function cancelEvent(ctx: Ctx, actor: Actor, id: number, inProject?: number): Promise<void> {
  const ev = await loadEvent(ctx, id, inProject);
  await requireProjectAccess(ctx, actor, ev.projectId);
  const res = await ctx.db.batch([
    ctx.db
      .prepare(`UPDATE events SET cancelled_at = ?, updated_at = ? WHERE id = ? AND cancelled_at IS NULL AND merged_at IS NULL`)
      .bind(ctx.now(), ctx.now(), id),
    changeStmt(ctx, { projectId: ev.projectId, actor, kind: 'event.cancelled', subjectId: id }, { guarded: true }),
    ...(approvalsHook?.onCancel && ev.kind === 'merge' ? await approvalsHook.onCancel(ctx, ev) : []),
  ]);
  if (res[0].meta.changes === 0) {
    throw ruleError('EVENT_CLOSED', 'That event is already cancelled or merged.', 'Nothing to do.', 409);
  }
}

/** Events whose start falls in [from, to). Cancelled events are included, flagged. */
export async function listEvents(
  ctx: Ctx,
  actor: Actor,
  q: { projectId: number; from: string; to: string },
): Promise<EventView[]> {
  await requireProjectAccess(ctx, actor, q.projectId);
  return withApprovals(ctx, await eventsBetween(ctx, q.projectId, q.from, q.to, false));
}

async function eventsBetween(ctx: Ctx, projectId: number, from: string, to: string, mergesOnly: boolean): Promise<EventView[]> {
  // Stored times carry milliseconds, so bounds are normalised the same way before comparing as strings.
  const lo = parseZonedTime(from).utc;
  const hi = parseZonedTime(to).utc;
  const { results } = await ctx.db
    .prepare(
      `${EVENT_SELECT} WHERE e.project_id = ? AND e.starts_at >= ? AND e.starts_at < ?
       ${mergesOnly ? `AND e.kind = 'merge' AND e.cancelled_at IS NULL` : ''}
       ORDER BY e.starts_at, e.id`,
    )
    .bind(projectId, lo, hi)
    .all<EventRow>();
  return results.map(toView);
}

function isUnique(e: unknown): boolean {
  const text = (x: unknown): string => (x instanceof Error ? `${x.message} ${text((x as { cause?: unknown }).cause)}` : x === undefined ? '' : String(x));
  return /UNIQUE constraint failed/i.test(text(e));
}

async function mergedEvent(ctx: Ctx, repoId: number, pr: number): Promise<EventView | null> {
  const row = await ctx.db
    .prepare(`${EVENT_SELECT} WHERE e.repo_id = ? AND e.pr_number = ? AND e.merged_at IS NOT NULL`)
    .bind(repoId, pr)
    .first<EventRow>();
  return row ? toView(row) : null;
}

/**
 * Records that a PR merged. The first report wins and is kept as stored; later reports (hook after GitHub,
 * GitHub after hook, or a concurrent one) return that row and write nothing. The one_merge unique index
 * is what makes a race lose cleanly.
 */
export async function recordMerge(
  ctx: Ctx,
  actor: Actor,
  m: { repo: string; pr: number; mergedAt: string; source: 'hook' | 'github' },
): Promise<EventView | null> {
  const repo = await findRepo(ctx, m.repo);
  if (!repo) return null;
  const mergedAt = parseZonedTime(m.mergedAt).utc;
  const existing = await mergedEvent(ctx, repo.id, m.pr);
  if (existing) return existing;

  const label = actorLabel(actor);
  const data = { repo: repo.full_name, pr: m.pr, mergedAt, source: m.source };
  const findCandidate = () =>
    ctx.db
      .prepare(
        `SELECT id FROM events WHERE repo_id = ? AND pr_number = ? AND kind = 'merge' AND cancelled_at IS NULL AND merged_at IS NULL
         ORDER BY ABS(julianday(starts_at) - julianday(?)), starts_at, id LIMIT 1`,
      )
      .bind(repo.id, m.pr, mergedAt)
      .first<{ id: number }>();
  try {
    // The chosen event can be cancelled between the SELECT and the guarded UPDATE. With no winner row the merge
    // would then go unrecorded, so search once more, and if nothing is left, record it after the fact below.
    for (let attempt = 0; attempt < 2; attempt++) {
      const candidate = await findCandidate();
      if (!candidate) break;
      const [marked] = await ctx.db.batch([
        ctx.db
          .prepare(`UPDATE events SET merged_at = ?, merged_by = ?, updated_at = ? WHERE id = ? AND merged_at IS NULL AND cancelled_at IS NULL`)
          .bind(mergedAt, label, ctx.now(), candidate.id),
        changeStmt(ctx, { projectId: repo.project_id, actor, kind: 'merge.recorded', subjectId: candidate.id, data }, { guarded: true }),
      ]);
      const winner = await mergedEvent(ctx, repo.id, m.pr);
      if (marked.meta.changes || winner) return winner;
    }
    await ctx.db.batch([
      ctx.db
        .prepare(
          `INSERT INTO events (project_id, title, starts_at, entered_as, importance, kind, repo_id, pr_number, created_by, merged_at, merged_by, after_the_fact, updated_at)
           VALUES (?,?,?,?,'normal','merge',?,?,?,?,?,1,?)`,
        )
        .bind(repo.project_id, `Merged ${repo.full_name}#${m.pr}`, mergedAt, mergedAt, repo.id, m.pr, label, mergedAt, label, ctx.now()),
      changeStmt(ctx, { projectId: repo.project_id, actor, kind: 'merge.recorded', data }),
      ctx.db.prepare(
        `UPDATE change_log SET subject_id = (SELECT MAX(id) FROM events) WHERE seq = (SELECT MAX(seq) FROM change_log)`,
      ),
    ]);
  } catch (e) {
    if (!isUnique(e)) throw e;
    const winner = await mergedEvent(ctx, repo.id, m.pr);
    if (winner) return winner;
    throw e;
  }
  return mergedEvent(ctx, repo.id, m.pr);
}

/** The project's merge events with start in [fromIso, toIso), in time order, with approval status. */
export async function daySchedule(ctx: Ctx, projectId: number, fromIso: string, toIso: string): Promise<ScheduleRow[]> {
  const events = await eventsBetween(ctx, projectId, fromIso, toIso, true);
  const infos = approvalsHook?.describeMany ? await approvalsHook.describeMany(ctx, events) : new Map<number, ApprovalInfo>();
  const now = ctx.now();
  const rows: ScheduleRow[] = [];
  let nextFound = false;
  for (const e of events) {
    let status: ScheduleStatus = 'merged';
    const info = infos.get(e.id) ?? { approvalRequired: false, approvers: [] };
    if (!e.mergedAt) status = scheduleDecider ? await scheduleDecider(ctx, e, info) : 'scheduled';
    const isNext = !e.mergedAt && !nextFound && e.startsAt >= now;
    if (isNext) nextFound = true;
    rows.push({ ...e, ...info, status, isNext, approvers: info.approvers });
  }
  return rows;
}
