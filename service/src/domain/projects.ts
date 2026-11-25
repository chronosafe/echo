import type { Ctx } from '../ctx';
import { ruleError } from '../errors';
import { slotText } from '../time';
import { enqueueOpenPrs } from '../github/status';
import type { Actor } from '../types';
import type { AgentRow } from './agents';
import { changeStmt } from './changelog';

export type ProjectRow = {
  id: number;
  name: string;
  approvals_required: number;
  approval_window_min: number;
  archived_at: string | null;
  created_at: string;
};
export type RepoRow = { id: number; full_name: string; project_id: number; installation_id: number | null };

const PROJECT_COLS = 'id, name, approvals_required, approval_window_min, archived_at, created_at';
const ADMIN: Actor = { kind: 'admin' };

function nameTaken(n: string) {
  return ruleError('NAME_TAKEN', `A project named "${n}" already exists.`, 'Choose a different name.', 409);
}

export async function createProject(ctx: Ctx, name: string): Promise<ProjectRow> {
  const n = name.trim();
  if (!n) throw ruleError('BAD_NAME', 'A project needs a name.', 'Give the project a non-empty name.');
  try {
    return (await ctx.db
      .prepare(`INSERT INTO projects (name, created_at) VALUES (?,?) RETURNING ${PROJECT_COLS}`)
      .bind(n, ctx.now())
      .first<ProjectRow>())!;
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw nameTaken(n);
    throw e;
  }
}

/** The owner creates a project; the change entry is written in the same batch. */
export async function adminCreateProject(ctx: Ctx, name: string): Promise<ProjectRow> {
  const n = name.trim();
  if (!n) throw ruleError('BAD_NAME', 'A project needs a name.', 'Give the project a non-empty name.');
  try {
    const [ins] = await ctx.db.batch([
      ctx.db.prepare(`INSERT INTO projects (name, created_at) VALUES (?,?) RETURNING ${PROJECT_COLS}`).bind(n, ctx.now()),
      ctx.db
        .prepare(`INSERT INTO change_log (project_id, at, actor, kind, data) SELECT id, ?, 'admin', 'project.updated', ? FROM projects WHERE name = ?`)
        .bind(ctx.now(), JSON.stringify({ created: true, name: n }), n),
    ]);
    return ins.results[0] as ProjectRow;
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw nameTaken(n);
    throw e;
  }
}

export async function getProject(ctx: Ctx, id: number): Promise<ProjectRow> {
  const p = await ctx.db.prepare(`SELECT ${PROJECT_COLS} FROM projects WHERE id = ?`).bind(id).first<ProjectRow>();
  if (!p) throw ruleError('PROJECT_NOT_FOUND', `There is no project ${id}.`, 'Check the project id.', 404);
  return p;
}

export async function listProjects(ctx: Ctx): Promise<ProjectRow[]> {
  const { results } = await ctx.db.prepare(`SELECT ${PROJECT_COLS} FROM projects ORDER BY name`).all<ProjectRow>();
  return results;
}

export async function renameProject(ctx: Ctx, id: number, name: string): Promise<void> {
  const n = name.trim();
  if (!n) throw ruleError('BAD_NAME', 'A project needs a name.', 'Give the project a non-empty name.');
  await getProject(ctx, id);
  try {
    await ctx.db.batch([
      ctx.db.prepare(`UPDATE projects SET name = ? WHERE id = ?`).bind(n, id),
      changeStmt(ctx, { projectId: id, actor: ADMIN, kind: 'project.updated', data: { name: n } }),
    ]);
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw nameTaken(n);
    throw e;
  }
}

export async function archiveProject(ctx: Ctx, id: number): Promise<void> {
  await getProject(ctx, id);
  // Gating follows registration alone, so a project with registered repositories cannot leave them behind ungated or
  // orphaned. The check is part of the update itself, so a registration landing meanwhile cannot slip past it.
  const [res] = await ctx.db.batch([
    ctx.db
      .prepare(`UPDATE projects SET archived_at = COALESCE(archived_at, ?) WHERE id = ? AND NOT EXISTS (SELECT 1 FROM repos WHERE project_id = ?)`)
      .bind(ctx.now(), id, id),
    changeStmt(ctx, { projectId: id, actor: ADMIN, kind: 'project.updated', data: { archived: true } }, { guarded: true }),
  ]);
  if (res.meta.changes === 0) {
    throw ruleError(
      'ARCHIVE_HAS_REPOS',
      "Remove this project's repositories first; registered repositories stay gated.",
      'Remove each repository on the Repositories page, then archive the project.',
      409,
    );
  }
}

function notArchived(name: string) {
  return ruleError(
    'PROJECT_NOT_ARCHIVED',
    `Project "${name}" is not archived, so it cannot be deleted.`,
    'Archive the project first (Settings, Archive), then delete it.',
    409,
  );
}

/**
 * Permanently deletes an archived project and everything that belongs to it, in one batch. No table declares foreign
 * keys, so the order is for readability: children first (found through the project's own rows), the project row last.
 * Every statement carries the archived guard, so a project unarchived or already deleted meanwhile loses nothing; the
 * last statement's change count then reports the refusal.
 */
export async function adminDeleteProject(ctx: Ctx, id: number): Promise<void> {
  const project = await getProject(ctx, id);
  if (!project.archived_at) throw notArchived(project.name);
  const guard = `EXISTS (SELECT 1 FROM projects WHERE id = ?1 AND archived_at IS NOT NULL)`;
  const repoIds = `SELECT id FROM repos WHERE project_id = ?1`;
  const steps: [table: string, sql: string][] = [
    ['pr_heads', `DELETE FROM pr_heads WHERE repo_id IN (${repoIds}) AND ${guard}`],
    ['status_jobs', `DELETE FROM status_jobs WHERE repo_id IN (${repoIds}) AND ${guard}`],
    ['commit_statuses', `DELETE FROM commit_statuses WHERE repo_id IN (${repoIds}) AND ${guard}`],
    ['event_approvers', `DELETE FROM event_approvers WHERE event_id IN (SELECT id FROM events WHERE project_id = ?1) AND ${guard}`],
    ['message_recipients', `DELETE FROM message_recipients WHERE message_id IN (SELECT id FROM messages WHERE project_id = ?1) AND ${guard}`],
    ['holds', `DELETE FROM holds WHERE project_id = ?1 AND ${guard}`],
    ['events', `DELETE FROM events WHERE project_id = ?1 AND ${guard}`],
    ['messages', `DELETE FROM messages WHERE project_id = ?1 AND ${guard}`],
    ['todos', `DELETE FROM todos WHERE project_id = ?1 AND ${guard}`],
    ['scratchpad_entries', `DELETE FROM scratchpad_entries WHERE project_id = ?1 AND ${guard}`],
    ['documents', `DELETE FROM documents WHERE project_id = ?1 AND ${guard}`],
    ['data_requests', `DELETE FROM data_requests WHERE project_id = ?1 AND ${guard}`],
    ['data_history', `DELETE FROM data_history WHERE project_id = ?1 AND ${guard}`],
    ['data_entries', `DELETE FROM data_entries WHERE project_id = ?1 AND ${guard}`],
    ['webhooks', `DELETE FROM webhooks WHERE project_id = ?1 AND ${guard}`],
    ['change_log', `DELETE FROM change_log WHERE project_id = ?1 AND ${guard}`],
    ['project_agents', `DELETE FROM project_agents WHERE project_id = ?1 AND ${guard}`],
    ['repos', `DELETE FROM repos WHERE project_id = ?1 AND ${guard}`],
    // Last: every guard above reads this row.
    ['projects', `DELETE FROM projects WHERE id = ?1 AND archived_at IS NOT NULL`],
  ];
  const res = await ctx.db.batch(steps.map(([, sql]) => ctx.db.prepare(sql).bind(id)));
  if (res[res.length - 1]!.meta.changes === 0) {
    const now = await ctx.db.prepare(`SELECT name FROM projects WHERE id = ?`).bind(id).first<{ name: string }>();
    if (!now) throw ruleError('PROJECT_NOT_FOUND', `There is no project ${id}.`, 'Check the project id.', 404);
    throw notArchived(now.name);
  }
  // One line in Workers Logs: the deletion is not in the change log (that went with the project).
  const rows = steps.map(([t], i) => `${t}=${res[i]!.meta.changes}`).join(' ');
  console.log(`project deleted: id=${id} name=${project.name} ${rows}`);
}

export async function updateProjectSettings(
  ctx: Ctx,
  id: number,
  s: { approvalsRequired?: boolean; approvalWindowMin?: number },
): Promise<void> {
  if (s.approvalWindowMin !== undefined) {
    const w = s.approvalWindowMin;
    if (!Number.isInteger(w) || w < 5 || w > 240) {
      throw ruleError('BAD_WINDOW', `An approval window of ${w} minutes is not allowed.`, 'Use a whole number of minutes from 5 to 240.');
    }
  }
  await getProject(ctx, id);
  const sets: string[] = [];
  const binds: (number | string)[] = [];
  if (s.approvalsRequired !== undefined) {
    sets.push('approvals_required = ?');
    binds.push(s.approvalsRequired ? 1 : 0);
  }
  if (s.approvalWindowMin !== undefined) {
    sets.push('approval_window_min = ?');
    binds.push(s.approvalWindowMin);
  }
  if (!sets.length) return;
  await ctx.db.batch([
    ctx.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id),
    changeStmt(ctx, { projectId: id, actor: ADMIN, kind: 'project.updated', data: s }),
    // Approvals on or off, or a new window, changes the merge decision of every open PR in the project.
    ...enqueueOpenPrs(ctx, { projectId: id }),
  ]);
}

export async function addMember(ctx: Ctx, actor: Actor, projectId: number, agentId: number): Promise<void> {
  await getProject(ctx, projectId);
  const agent = await ctx.db.prepare(`SELECT id FROM agents WHERE id = ?`).bind(agentId).first();
  if (!agent) throw ruleError('AGENT_NOT_FOUND', `There is no agent ${agentId}.`, 'Check the agent id.', 404);
  const already = await ctx.db
    .prepare(`SELECT 1 AS x FROM project_agents WHERE project_id = ? AND agent_id = ?`)
    .bind(projectId, agentId)
    .first();
  if (already) return;
  // The insert checks the agent in the statement itself, so an agent deleted meanwhile cannot gain a membership.
  const [ins] = await ctx.db.batch([
    ctx.db.prepare(`INSERT OR IGNORE INTO project_agents (project_id, agent_id) SELECT ?, id FROM agents WHERE id = ?`).bind(projectId, agentId),
    changeStmt(ctx, { projectId, actor, kind: 'member.added', subjectId: agentId }, { guarded: true }),
  ]);
  if (ins.meta.changes === 0) {
    const stillThere = await ctx.db.prepare(`SELECT id FROM agents WHERE id = ?`).bind(agentId).first();
    if (!stillThere) throw ruleError('AGENT_NOT_FOUND', `There is no agent ${agentId}.`, 'Check the agent id.', 404);
  }
}

export async function removeMember(ctx: Ctx, actor: Actor, projectId: number, agentId: number): Promise<void> {
  const already = await ctx.db
    .prepare(`SELECT 1 AS x FROM project_agents WHERE project_id = ? AND agent_id = ?`)
    .bind(projectId, agentId)
    .first();
  if (!already) return;
  await ctx.db.batch([
    ctx.db.prepare(`DELETE FROM project_agents WHERE project_id = ? AND agent_id = ?`).bind(projectId, agentId),
    changeStmt(ctx, { projectId, actor, kind: 'member.removed', subjectId: agentId }),
  ]);
}

export async function projectMembers(ctx: Ctx, projectId: number): Promise<AgentRow[]> {
  const { results } = await ctx.db
    .prepare(
      `SELECT a.id, a.name, a.revoked_at, a.last_checked_in_at, a.created_at
       FROM agents a JOIN project_agents pa ON pa.agent_id = a.id
       WHERE pa.project_id = ? ORDER BY a.name`,
    )
    .bind(projectId)
    .all<AgentRow>();
  return results;
}

/** Projects the agent belongs to; archived projects are left out. */
export async function agentProjects(ctx: Ctx, agentId: number): Promise<ProjectRow[]> {
  const { results } = await ctx.db
    .prepare(
      `SELECT p.id, p.name, p.approvals_required, p.approval_window_min, p.archived_at, p.created_at
       FROM projects p JOIN project_agents pa ON pa.project_id = p.id
       WHERE pa.agent_id = ? AND p.archived_at IS NULL ORDER BY p.name`,
    )
    .bind(agentId)
    .all<ProjectRow>();
  return results;
}

export async function requireMember(ctx: Ctx, agentId: number, projectId: number): Promise<void> {
  const row = await ctx.db
    .prepare(`SELECT 1 AS x FROM project_agents WHERE project_id = ? AND agent_id = ?`)
    .bind(projectId, agentId)
    .first();
  if (!row) {
    throw ruleError('NOT_MEMBER', `You are not a member of project ${projectId}.`, 'Ask the owner to add you to the project.', 403);
  }
}

/** Lowercase, trimmed owner/name. Anything else is refused. */
export function normalizeRepo(s: string): string {
  const n = s.trim().toLowerCase();
  if (!/^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(n)) {
    throw ruleError('BAD_REPO', `"${s}" is not a repository name.`, 'Use the form owner/name, for example acme/app.');
  }
  return n;
}

export async function findRepo(ctx: Ctx, fullName: string): Promise<RepoRow | null> {
  return ctx.db
    .prepare(`SELECT id, full_name, project_id, installation_id FROM repos WHERE full_name = ?`)
    .bind(normalizeRepo(fullName))
    .first<RepoRow>();
}

export async function registerRepo(ctx: Ctx, actor: Actor, projectId: number, fullName: string): Promise<RepoRow> {
  const name = normalizeRepo(fullName);
  const project = await getProject(ctx, projectId);
  if (project.archived_at) {
    throw ruleError('PROJECT_ARCHIVED', `Project "${project.name}" is archived.`, 'Register the repository on an active project.', 409);
  }
  const takenError = async () => {
    const existing = await findRepo(ctx, name);
    if (!existing) return null;
    const owner = await getProject(ctx, existing.project_id);
    return ruleError(
      'REPO_TAKEN',
      `${name} is already registered to project "${owner.name}".`,
      'Remove it from that project first, or use that project.',
      409,
    );
  };
  const early = await takenError();
  if (early) throw early;
  try {
    const [ins] = await ctx.db.batch([
      ctx.db
        .prepare(`INSERT INTO repos (full_name, project_id) VALUES (?,?) RETURNING id, full_name, project_id, installation_id`)
        .bind(name, projectId),
      changeStmt(ctx, { projectId, actor, kind: 'repo.registered', data: { repo: name } }),
    ]);
    return ins.results[0] as RepoRow;
  } catch (e) {
    if (String(e).includes('UNIQUE')) {
      const late = await takenError();
      if (late) throw late;
    }
    throw e;
  }
}

export async function removeRepo(ctx: Ctx, actor: Actor, repoId: number): Promise<void> {
  const repo = await ctx.db
    .prepare(`SELECT id, full_name, project_id, installation_id FROM repos WHERE id = ?`)
    .bind(repoId)
    .first<RepoRow>();
  if (!repo) throw ruleError('REPO_NOT_FOUND', `There is no repository ${repoId}.`, 'Check the repository id.', 404);
  // Holds and merge events point at the repository by id: removing it under open ones would orphan them. The check
  // is part of the delete, so one placed meanwhile cannot slip past it; the rest of the batch runs only if it went.
  const gone = `NOT EXISTS (SELECT 1 FROM repos WHERE id = ?)`;
  const [del] = await ctx.db.batch([
    ctx.db
      .prepare(
        `DELETE FROM repos WHERE id = ?1
           AND NOT EXISTS (SELECT 1 FROM holds WHERE repo_id = ?1 AND state = 'open')
           AND NOT EXISTS (SELECT 1 FROM events WHERE repo_id = ?1 AND kind = 'merge' AND merged_at IS NULL AND cancelled_at IS NULL)`,
      )
      .bind(repoId),
    changeStmt(ctx, { projectId: repo.project_id, actor, kind: 'repo.removed', data: { repo: repo.full_name } }, { guarded: true }),
    ctx.db.prepare(`DELETE FROM pr_heads WHERE repo_id = ? AND ${gone}`).bind(repoId, repoId),
    ctx.db.prepare(`DELETE FROM status_jobs WHERE repo_id = ? AND ${gone}`).bind(repoId, repoId),
    ctx.db.prepare(`DELETE FROM commit_statuses WHERE repo_id = ? AND ${gone}`).bind(repoId, repoId),
  ]);
  if (del.meta.changes === 0) {
    const { results: holds } = await ctx.db
      .prepare(`SELECT id, pr_number, placed_by_label FROM holds WHERE repo_id = ? AND state = 'open' ORDER BY id`)
      .bind(repoId)
      .all<{ id: number; pr_number: number; placed_by_label: string }>();
    const { results: events } = await ctx.db
      .prepare(
        `SELECT id, pr_number, starts_at FROM events WHERE repo_id = ? AND kind = 'merge' AND merged_at IS NULL AND cancelled_at IS NULL ORDER BY id`,
      )
      .bind(repoId)
      .all<{ id: number; pr_number: number; starts_at: string }>();
    const items = [
      ...holds.map((h) => `hold ${h.id} on #${h.pr_number} by ${h.placed_by_label}`),
      ...events.map((e) => `merge event ${e.id} for #${e.pr_number} at ${slotText(e.starts_at)}`),
    ];
    const todo = [holds.length ? 'release the open holds' : '', events.length ? 'cancel (or merge) the open merge events' : '']
      .filter(Boolean)
      .join(' and ');
    throw ruleError(
      'REPO_HAS_OPEN_ITEMS',
      `${repo.full_name} still has open items: ${items.join('; ') || 'none any more'}.`,
      `First ${todo || 'try again'} (${items.join('; ') || 'they have just closed'}), then remove the repository.`,
      409,
    );
  }
}

/** Every registered repository; these are the ones the merge check gates. */
export async function gatedRepos(ctx: Ctx): Promise<string[]> {
  const { results } = await ctx.db
    .prepare(`SELECT full_name FROM repos ORDER BY full_name`)
    .all<{ full_name: string }>();
  return results.map((r) => r.full_name);
}

export async function getOwnerSetting(ctx: Ctx, key: string): Promise<string | null> {
  const r = await ctx.db.prepare(`SELECT value FROM owner_settings WHERE key = ?`).bind(key).first<{ value: string | null }>();
  return r?.value ?? null;
}

export async function setOwnerSetting(ctx: Ctx, key: string, value: string | null): Promise<void> {
  await ctx.db
    .prepare(`INSERT INTO owner_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(key, value)
    .run();
}

export type RepoStatusRow = {
  id: number;
  fullName: string;
  installed: boolean;
  statusAt: string | null;
  statusState: string | null;
  lastError: string | null;
};

/** For the admin repositories page: the latest commit status row and the latest recorded status-job error, per repository. */
export async function repoStatusRows(ctx: Ctx, projectId: number): Promise<RepoStatusRow[]> {
  const { results } = await ctx.db
    .prepare(
      `SELECT r.id, r.full_name, r.installation_id,
         (SELECT cs.updated_at FROM commit_statuses cs WHERE cs.repo_id = r.id ORDER BY cs.updated_at DESC LIMIT 1) AS status_at,
         (SELECT cs.state FROM commit_statuses cs WHERE cs.repo_id = r.id ORDER BY cs.updated_at DESC LIMIT 1) AS status_state,
         (SELECT j.last_error FROM status_jobs j WHERE j.repo_id = r.id AND j.last_error IS NOT NULL ORDER BY j.next_attempt_at DESC LIMIT 1) AS last_error
       FROM repos r WHERE r.project_id = ? ORDER BY r.full_name`,
    )
    .bind(projectId)
    .all<{ id: number; full_name: string; installation_id: number | null; status_at: string | null; status_state: string | null; last_error: string | null }>();
  return results.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    installed: r.installation_id !== null,
    statusAt: r.status_at,
    statusState: r.status_state,
    lastError: r.last_error,
  }));
}
