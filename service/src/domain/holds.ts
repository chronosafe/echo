import type { Ctx } from '../ctx';
import { ruleError, serviceError } from '../errors';
import type { Actor } from '../types';
import { actorLabel } from '../types';
import { enqueueStatus } from '../github/status';
import { changeStmt } from './changelog';
import { ackOwnRecipientStmts, MAX_MESSAGE_BYTES, newMessageStmts, noticeStmts } from './messages';
import { findRepo, normalizeRepo, requireMember } from './projects';

export type HoldKind = 'blocking' | 'advisory';

export type HoldView = {
  id: number;
  repo: string;
  pr: number;
  kind: HoldKind;
  reason: string;
  placedBy: string;
  placedAt: string;
  acknowledged: { by: string; at: string; note: string } | null;
  state: 'open' | 'released';
  released: { by: string; at: string; note: string } | null;
  blocksMerge: boolean;
  message: { delivered: number; acknowledged: number; recipients: number };
};

type HoldChangeListener = (ctx: Ctx, repoId: number, pr: number) => Promise<void>;

let listener: HoldChangeListener | null = null;

/** Called after a hold's batch has committed. (The echo/hold status job is enqueued inside the batch itself.) */
export function setHoldChangeListener(fn: HoldChangeListener | null): void {
  listener = fn;
}

/** A listener failure must never turn a committed hold change into a failed call. */
async function notifyChange(ctx: Ctx, repoId: number, pr: number): Promise<void> {
  if (!listener) return;
  try {
    await listener(ctx, repoId, pr);
  } catch (e) {
    console.error('hold change listener failed', e);
  }
}

type HoldRow = {
  id: number;
  project_id: number;
  repo_id: number;
  pr_number: number;
  repo: string;
  kind: HoldKind;
  reason: string;
  placed_by_agent_id: number | null;
  placed_by_label: string;
  placed_at: string;
  message_id: number | null;
  acked_at: string | null;
  acked_by: string | null;
  ack_note: string | null;
  state: 'open' | 'released';
  released_at: string | null;
  released_by: string | null;
  release_note: string | null;
  msg_recipients: number;
  msg_delivered: number;
  msg_acked: number;
};

const HOLD_SELECT = `
  SELECT h.id, h.project_id, h.repo_id, h.pr_number, r.full_name AS repo, h.kind, h.reason,
         h.placed_by_agent_id, h.placed_by_label, h.placed_at, h.message_id,
         h.acked_at, h.acked_by, h.ack_note, h.state, h.released_at, h.released_by, h.release_note,
         (SELECT COUNT(*) FROM message_recipients mr WHERE mr.message_id = h.message_id) AS msg_recipients,
         (SELECT COUNT(*) FROM message_recipients mr WHERE mr.message_id = h.message_id AND mr.delivered_at IS NOT NULL) AS msg_delivered,
         (SELECT COUNT(*) FROM message_recipients mr WHERE mr.message_id = h.message_id AND mr.acked_at IS NOT NULL) AS msg_acked
  FROM holds h JOIN repos r ON r.id = h.repo_id
  WHERE h.target_kind = 'pr'`;

function toView(r: HoldRow): HoldView {
  return {
    id: r.id,
    repo: r.repo,
    pr: r.pr_number,
    kind: r.kind,
    reason: r.reason,
    placedBy: r.placed_by_label,
    placedAt: r.placed_at,
    acknowledged: r.acked_at ? { by: r.acked_by!, at: r.acked_at, note: r.ack_note! } : null,
    state: r.state,
    released: r.state === 'released' ? { by: r.released_by!, at: r.released_at!, note: r.release_note! } : null,
    blocksMerge: r.state === 'open' && (r.kind === 'blocking' || r.acked_at === null),
    message: { delivered: r.msg_delivered, acknowledged: r.msg_acked, recipients: r.msg_recipients },
  };
}

async function loadHold(ctx: Ctx, holdId: number): Promise<HoldRow> {
  const row = await ctx.db.prepare(`${HOLD_SELECT} AND h.id = ?`).bind(holdId).first<HoldRow>();
  if (!row) throw ruleError('HOLD_NOT_FOUND', `There is no hold ${holdId}.`, 'Check the hold id with echo_list_holds.', 404);
  return row;
}

function closedError(r: Pick<HoldRow, 'id' | 'released_by' | 'released_at'>) {
  return ruleError(
    'HOLD_CLOSED',
    `Hold ${r.id} was already released by ${r.released_by} at ${r.released_at}.`,
    'Nothing more is needed; list the PR\'s holds to see what is still open.',
    409,
  );
}

/** The conditional update changed nothing: someone else closed the hold first. Report them from the row. */
async function closedByRival(ctx: Ctx, holdId: number): Promise<never> {
  const row = await loadHold(ctx, holdId);
  if (row.state === 'released') throw closedError(row);
  throw serviceError('HOLD_UPDATE_FAILED', `Hold ${holdId} could not be updated.`);
}

async function agentActor(ctx: Ctx, agentId: number): Promise<Actor> {
  const a = await ctx.db.prepare(`SELECT name FROM agents WHERE id = ?`).bind(agentId).first<{ name: string }>();
  if (!a) throw ruleError('AGENT_NOT_FOUND', `There is no agent ${agentId}.`, 'Check the agent id.', 404);
  return { kind: 'agent', agentId, name: a.name };
}

function needNote(note: string): string {
  const n = note.trim();
  if (!n) {
    throw ruleError('NOTE_REQUIRED', 'A note is required.', 'Say what you did about it, for example "rebased and re-ran tests".');
  }
  return n;
}

function holdBody(kind: HoldKind, repo: string, pr: number, name: string, reason: string, holdId: number | string): string {
  const clearText =
    kind === 'blocking'
      ? `Only ${name} or the owner can release it; echo_ack_hold records that you have seen it but does not clear it.`
      : `The merging agent clears it with echo_ack_hold (hold_id=${holdId}, note required).`;
  return `${kind.toUpperCase()} HOLD on ${repo}#${pr} by ${name}: ${reason}. Acknowledging this message means "seen" only. ${clearText}`;
}

// ---------------------------------------------------------------- place

export async function placeHold(
  ctx: Ctx,
  actor: Actor,
  input: { repo: string; pr: number; reason: string; kind?: HoldKind; notify?: string },
): Promise<HoldView> {
  const kind = input.kind ?? 'blocking';
  if (kind !== 'blocking' && kind !== 'advisory') {
    throw ruleError('BAD_HOLD_KIND', `"${kind}" is not a hold kind.`, 'Use "blocking" or "advisory".');
  }
  const reason = input.reason.trim();
  if (!reason) throw ruleError('REASON_REQUIRED', 'A hold needs a reason.', 'Say what the problem is, for example "SQL injection in the search endpoint".');
  if (!Number.isInteger(input.pr) || input.pr < 1) {
    throw ruleError('BAD_PR', `${input.pr} is not a pull request number.`, 'Give the PR number, for example 709.');
  }
  const repoName = normalizeRepo(input.repo);
  const repo = await findRepo(ctx, repoName);
  if (!repo) {
    throw ruleError('REPO_NOT_REGISTERED', `${repoName} is not registered to any project.`, 'Ask the owner to register the repository to its project.', 404);
  }
  if (actor.kind === 'agent') await requireMember(ctx, actor.agentId, repo.project_id);
  const label = actorLabel(actor);
  const senderId = actor.kind === 'agent' ? actor.agentId : null;

  // The message body needs the hold id, which exists only after the insert; 10 digits bounds its width.
  const size = new TextEncoder().encode(holdBody(kind, repoName, input.pr, label, reason, '0000000000')).length;
  if (size > MAX_MESSAGE_BYTES) {
    throw ruleError(
      'REASON_TOO_LARGE',
      `The hold message would be ${size} bytes; the limit is ${MAX_MESSAGE_BYTES}.`,
      'Shorten the reason, or put the detail in a project document (echo_doc_save) and name it in the reason.',
    );
  }

  const { results: members } = await ctx.db
    .prepare(
      `SELECT a.id, a.name FROM agents a JOIN project_agents pa ON pa.agent_id = a.id
       WHERE pa.project_id = ? AND a.revoked_at IS NULL ORDER BY a.name`,
    )
    .bind(repo.project_id)
    .all<{ id: number; name: string }>();
  const to = (input.notify ?? 'all').trim() || 'all';
  let recipientIds: number[];
  if (to.toLowerCase() === 'all') {
    recipientIds = members.filter((m) => m.id !== senderId).map((m) => m.id); // may be empty: still place the hold
  } else {
    const hit = members.find((m) => m.name.toLowerCase() === to.toLowerCase());
    if (!hit) {
      throw ruleError(
        'UNKNOWN_RECIPIENT',
        `"${to}" is not an agent in this project.`,
        `Notify one of: ${members.map((m) => m.name).join(', ') || '(no agents)'}, or "all".`,
        404,
      );
    }
    recipientIds = [hit.id];
  }

  // One transaction: hold, its log entry, the message with its recipients and log entry, and the link.
  // The hold id is not known yet, so the message is stored with a placeholder and fixed up in-batch.
  const full = holdBody(kind, repoName, input.pr, label, reason, 0);
  const idAt = kind === 'advisory' ? full.lastIndexOf('hold_id=0') + 'hold_id='.length : -1;
  const messageStmts: D1PreparedStatement[] = recipientIds.length
    ? [
        ...newMessageStmts(ctx, actor, {
          projectId: repo.project_id,
          senderAgentId: senderId,
          label,
          body: full,
          requiresAck: true,
          escalateAt: null,
          kind: 'hold',
          refId: null,
          recipientIds,
        }),
        idAt >= 0
          ? ctx.db
              .prepare(
                `UPDATE messages SET ref_id = (SELECT MAX(id) FROM holds), body = ? || (SELECT MAX(id) FROM holds) || ?
                 WHERE id = (SELECT MAX(id) FROM messages)`,
              )
              .bind(full.slice(0, idAt), full.slice(idAt + 1))
          : ctx.db.prepare(`UPDATE messages SET ref_id = (SELECT MAX(id) FROM holds) WHERE id = (SELECT MAX(id) FROM messages)`),
        ctx.db.prepare(`UPDATE holds SET message_id = (SELECT MAX(id) FROM messages) WHERE id = (SELECT MAX(id) FROM holds)`),
      ]
    : [];
  const [ins] = await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO holds (project_id, target_kind, repo_id, pr_number, kind, reason, placed_by_agent_id, placed_by_label, placed_at)
         VALUES (?,'pr',?,?,?,?,?,?,?)`,
      )
      .bind(repo.project_id, repo.id, input.pr, kind, reason, senderId, label, ctx.now()),
    changeStmt(ctx, { projectId: repo.project_id, actor, kind: 'hold.placed', data: { repo: repoName, pr: input.pr, kind } }, { guarded: true }),
    ctx.db.prepare(`UPDATE change_log SET subject_id = (SELECT MAX(id) FROM holds) WHERE seq = (SELECT MAX(seq) FROM change_log)`),
    ...messageStmts,
    enqueueStatus(ctx, repo.id, input.pr),
  ]);
  const holdId = ins.meta.last_row_id as number;

  await notifyChange(ctx, repo.id, input.pr);
  return toView(await loadHold(ctx, holdId));
}

// ---------------------------------------------------------------- acknowledge

async function ackAs(ctx: Ctx, actor: Actor, holdId: number, note: string): Promise<void> {
  const hold = await loadHold(ctx, holdId);
  if (actor.kind === 'agent') {
    await requireMember(ctx, actor.agentId, hold.project_id);
    if (hold.placed_by_agent_id === actor.agentId) {
      throw ruleError(
        'PLACER_MUST_RELEASE',
        `You placed hold ${holdId}, so you cannot acknowledge it.`,
        `Release it with echo_release_hold when the problem is resolved.`,
        403,
      );
    }
  }
  const n = needNote(note);
  if (hold.state === 'released') throw closedError(hold);

  const who = actorLabel(actor);
  const now = ctx.now();
  const advisory = hold.kind === 'advisory';
  // Advisory: the acknowledgment and the release are one conditional update.
  const update = advisory
    ? ctx.db
        .prepare(
          `UPDATE holds SET acked_at = ?1, acked_by = ?2, ack_note = ?3, state = 'released', released_at = ?1, released_by = ?2, release_note = ?3
           WHERE id = ?4 AND state = 'open'`,
        )
        .bind(now, who, n, holdId)
    : ctx.db
        .prepare(`UPDATE holds SET acked_at = ?1, acked_by = ?2, ack_note = ?3 WHERE id = ?4 AND state = 'open'`)
        .bind(now, who, n, holdId);
  const data = { repo: hold.repo, pr: hold.pr_number, note: n };
  const stmts = [
    update,
    changeStmt(ctx, { projectId: hold.project_id, actor, kind: 'hold.acknowledged', subjectId: holdId, data }, { guarded: true }),
    ...(advisory
      ? [changeStmt(ctx, { projectId: hold.project_id, actor, kind: 'hold.released', subjectId: holdId, data }, { guarded: true })]
      : []),
    ...noticeStmts(
      ctx,
      { project_id: hold.project_id, sender_agent_id: hold.placed_by_agent_id },
      `${who} acknowledged ${hold.kind} hold ${holdId} on ${hold.repo}#${hold.pr_number}${advisory ? ' and released it' : '; it stays in force until you release it'}. Note: ${n}`,
    ),
    enqueueStatus(ctx, hold.repo_id, hold.pr_number),
    // An agent's acknowledgment also covers its own copy of the hold's notice message, so its Stop hook stops asking.
    // Last in the batch: it ends in an entry guarded by changes(), which would break the notice's guard if it came earlier.
    ...(actor.kind === 'agent' && hold.message_id !== null ? await ackOwnRecipientStmts(ctx, actor, who, hold.message_id, n, { holdId, at: now }) : []),
  ];
  const res = await ctx.db.batch(stmts);
  if (res[0].meta.changes === 0) await closedByRival(ctx, holdId);
  await notifyChange(ctx, hold.repo_id, hold.pr_number);
}

export async function ackHold(ctx: Ctx, agentId: number, holdId: number, note: string): Promise<void> {
  return ackAs(ctx, await agentActor(ctx, agentId), holdId, note);
}

export function adminAckHold(ctx: Ctx, holdId: number, note: string): Promise<void> {
  return ackAs(ctx, { kind: 'admin' }, holdId, note);
}

// ---------------------------------------------------------------- release

async function releaseAs(ctx: Ctx, actor: Actor, holdId: number, note: string): Promise<void> {
  const hold = await loadHold(ctx, holdId);
  if (actor.kind === 'agent') {
    await requireMember(ctx, actor.agentId, hold.project_id);
    if (hold.placed_by_agent_id !== actor.agentId) {
      throw ruleError(
        'NOT_PLACER',
        `Hold ${holdId} was placed by ${hold.placed_by_label}; only they or the owner can release it.`,
        `Ask ${hold.placed_by_label} to release it, or ask the owner.`,
        403,
      );
    }
  }
  const n = needNote(note);
  if (hold.state === 'released') throw closedError(hold);

  const res = await ctx.db.batch([
    ctx.db
      .prepare(`UPDATE holds SET state = 'released', released_at = ?, released_by = ?, release_note = ? WHERE id = ? AND state = 'open'`)
      .bind(ctx.now(), actorLabel(actor), n, holdId),
    changeStmt(
      ctx,
      { projectId: hold.project_id, actor, kind: 'hold.released', subjectId: holdId, data: { repo: hold.repo, pr: hold.pr_number, note: n } },
      { guarded: true },
    ),
    enqueueStatus(ctx, hold.repo_id, hold.pr_number),
  ]);
  if (res[0].meta.changes === 0) await closedByRival(ctx, holdId);
  await notifyChange(ctx, hold.repo_id, hold.pr_number);
}

export async function releaseHold(ctx: Ctx, agentId: number, holdId: number, note: string): Promise<void> {
  return releaseAs(ctx, await agentActor(ctx, agentId), holdId, note);
}

export function adminReleaseHold(ctx: Ctx, holdId: number, note: string): Promise<void> {
  return releaseAs(ctx, { kind: 'admin' }, holdId, note);
}

// ---------------------------------------------------------------- reading

export async function listHolds(
  ctx: Ctx,
  agentId: number,
  opts: { projectId?: number; state?: 'open' | 'all' } = {},
): Promise<HoldView[]> {
  if (opts.projectId !== undefined) await requireMember(ctx, agentId, opts.projectId);
  const where =
    (opts.projectId !== undefined ? ' AND h.project_id = ?2' : '') + ((opts.state ?? 'open') === 'open' ? ` AND h.state = 'open'` : '');
  const binds: number[] = opts.projectId !== undefined ? [agentId, opts.projectId] : [agentId];
  const { results } = await ctx.db
    .prepare(`${HOLD_SELECT} AND h.project_id IN (SELECT project_id FROM project_agents WHERE agent_id = ?1)${where} ORDER BY h.id`)
    .bind(...binds)
    .all<HoldRow>();
  return results.map(toView);
}

/** Admin page: a project's open holds, oldest first. */
export async function adminListHolds(ctx: Ctx, projectId: number): Promise<HoldView[]> {
  const { results } = await ctx.db
    .prepare(`${HOLD_SELECT} AND h.project_id = ? AND h.state = 'open' ORDER BY h.id`)
    .bind(projectId)
    .all<HoldRow>();
  return results.map(toView);
}

/** Open holds on one PR. No membership check: the merge check asks this for any agent. */
export async function holdsFor(ctx: Ctx, repo: string, pr: number): Promise<HoldView[]> {
  const found = await findRepo(ctx, repo);
  if (!found) return [];
  const { results } = await ctx.db
    .prepare(`${HOLD_SELECT} AND h.repo_id = ? AND h.pr_number = ? AND h.state = 'open' ORDER BY h.id`)
    .bind(found.id, pr)
    .all<HoldRow>();
  return results.map(toView);
}
