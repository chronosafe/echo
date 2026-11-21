import type { Ctx } from '../ctx';
import type { Actor } from '../types';
import { actorLabel } from '../types';

export type ChangeKind =
  | 'message.sent' | 'message.delivered' | 'message.deferred' | 'message.acknowledged' | 'message.withdrawn' | 'message.escalated'
  | 'hold.placed' | 'hold.acknowledged' | 'hold.released'
  | 'approval.requested' | 'approval.approved' | 'approval.objected' | 'approval.cleared'
  | 'merge.refused' | 'merge.recorded' | 'override.used'
  | 'github.status'
  | 'todo.added' | 'todo.claimed' | 'todo.released' | 'todo.completed' | 'todo.edited' | 'todo.deleted'
  | 'event.added' | 'event.updated' | 'event.moved' | 'event.cancelled'
  | 'scratchpad.appended' | 'scratchpad.edited' | 'scratchpad.cleared'
  | 'document.saved' | 'document.deleted'
  | 'project.updated' | 'repo.registered' | 'repo.removed' | 'member.added' | 'member.removed' | 'webhook.added' | 'webhook.removed' | 'agent.reissued' | 'agent.revoked';

export type Change = {
  seq: number;
  at: string;
  actor: string;
  kind: ChangeKind;
  subjectId: number | string | null;
  data: unknown;
};

/**
 * Put the returned statement in the same db.batch() as the change it records.
 * With `guarded`, the entry is written only if the statement just before it in the batch changed a row
 * (SQLite changes()), so a lost race records nothing.
 */
export function changeStmt(
  ctx: Ctx,
  e: { projectId: number; actor: Actor; kind: ChangeKind; subjectId?: number | string; data?: unknown },
  opts: { guarded?: boolean } = {},
): D1PreparedStatement {
  const binds = [
    e.projectId,
    ctx.now(),
    actorLabel(e.actor),
    e.kind,
    e.subjectId ?? null,
    e.data === undefined ? null : JSON.stringify(e.data),
  ];
  const sql = opts.guarded
    ? `INSERT INTO change_log (project_id, at, actor, kind, subject_id, data) SELECT ?,?,?,?,?,? WHERE changes() > 0`
    : `INSERT INTO change_log (project_id, at, actor, kind, subject_id, data) VALUES (?,?,?,?,?,?)`;
  return ctx.db.prepare(sql).bind(...binds);
}

/** The newest `limit` entries for a project, newest first (admin page). */
export async function recentChanges(ctx: Ctx, projectId: number, limit = 20): Promise<Change[]> {
  const { results } = await ctx.db
    .prepare(`SELECT seq, at, actor, kind, subject_id, data FROM change_log WHERE project_id = ? ORDER BY seq DESC LIMIT ?`)
    .bind(projectId, limit)
    .all<{ seq: number; at: string; actor: string; kind: ChangeKind; subject_id: number | string | null; data: string | null }>();
  return results.map((r) => ({
    seq: r.seq,
    at: r.at,
    actor: r.actor,
    kind: r.kind,
    subjectId: r.subject_id,
    data: r.data === null ? null : JSON.parse(r.data),
  }));
}

export async function changesSince(ctx: Ctx, projectId: number, sinceSeq: number, limit = 200): Promise<Change[]> {
  const { results } = await ctx.db
    .prepare(
      `SELECT seq, at, actor, kind, subject_id, data FROM change_log
       WHERE project_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
    )
    .bind(projectId, sinceSeq, limit)
    .all<{ seq: number; at: string; actor: string; kind: ChangeKind; subject_id: number | string | null; data: string | null }>();
  return results.map((r) => ({
    seq: r.seq,
    at: r.at,
    actor: r.actor,
    kind: r.kind,
    subjectId: r.subject_id,
    data: r.data === null ? null : JSON.parse(r.data),
  }));
}
