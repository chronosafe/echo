import type { Ctx } from '../ctx';
import { ruleError } from '../errors';
import type { Actor } from '../types';
import { actorLabel } from '../types';
import { changeStmt } from './changelog';
import { MAX_MESSAGE_BYTES } from './messages';
import { requireMember } from './projects';

const ADMIN: Actor = { kind: 'admin' };
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export type ScratchEntry = {
  id: number;
  projectId: number;
  author: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
};

type EntryDb = { id: number; project_id: number; author: string; body: string; created_at: string; edited_at: string | null };
const COLS = 'id, project_id, author, body, created_at, edited_at';

function view(r: EntryDb): ScratchEntry {
  return { id: r.id, projectId: r.project_id, author: r.author, body: r.body, createdAt: r.created_at, editedAt: r.edited_at };
}

async function authorize(ctx: Ctx, actor: Actor, projectId: number): Promise<void> {
  if (actor.kind === 'agent') await requireMember(ctx, actor.agentId, projectId);
}

function checkSize(body: string): void {
  const size = new TextEncoder().encode(body).length;
  if (size > MAX_MESSAGE_BYTES) {
    throw ruleError(
      'ENTRY_TOO_LARGE',
      'The scratchpad entry is too large.',
      `Your entry is ${size} bytes; the limit is ${MAX_MESSAGE_BYTES} bytes. Shorten it, or save the long content as a document and append a short entry that names it.`,
    );
  }
}

/** Append-only for agents: the server assigns the id (order) and the time. */
export async function appendScratchpad(ctx: Ctx, actor: Actor, projectId: number, body: string): Promise<ScratchEntry> {
  await authorize(ctx, actor, projectId);
  if (!body.trim()) throw ruleError('EMPTY_ENTRY', 'The scratchpad entry is empty.', 'Write something to append.');
  checkSize(body);
  const [ins] = await ctx.db.batch([
    ctx.db
      // The time is stamped before the batch and appends can commit in either order, so an entry's time is never
      // earlier than the newest entry's in the project: times stay in id order (ISO strings compare as times).
      .prepare(
        `INSERT INTO scratchpad_entries (project_id, author, body, created_at)
         VALUES (?1, ?2, ?3, MAX(?4, COALESCE((SELECT MAX(created_at) FROM scratchpad_entries WHERE project_id = ?1), '')))
         RETURNING ${COLS}`,
      )
      .bind(projectId, actorLabel(actor), body, ctx.now()),
    changeStmt(ctx, { projectId, actor, kind: 'scratchpad.appended' }),
    // The entry's id exists only inside this batch: the newest entry is the one just inserted.
    ctx.db.prepare(
      `UPDATE change_log SET subject_id = (SELECT MAX(id) FROM scratchpad_entries) WHERE seq = (SELECT MAX(seq) FROM change_log)`,
    ),
  ]);
  return view(ins.results[0] as EntryDb);
}

/** Entries in id order; `afterId` is exclusive. Default limit 100, at most 500. */
export async function readScratchpad(
  ctx: Ctx,
  actor: Actor,
  projectId: number,
  opts: { afterId?: number; limit?: number },
): Promise<ScratchEntry[]> {
  await authorize(ctx, actor, projectId);
  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw ruleError('BAD_LIMIT', `A limit of ${limit} is not allowed.`, `Use a whole number from 1 to ${MAX_LIMIT}.`);
  }
  const { results } = await ctx.db
    .prepare(`SELECT ${COLS} FROM scratchpad_entries WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?`)
    .bind(projectId, opts.afterId ?? 0, limit)
    .all<EntryDb>();
  return results.map(view);
}

export async function adminEditEntry(ctx: Ctx, id: number, body: string, inProject?: number): Promise<void> {
  checkSize(body);
  const row = await ctx.db.prepare(`SELECT project_id FROM scratchpad_entries WHERE id = ?`).bind(id).first<{ project_id: number }>();
  if (!row || (inProject !== undefined && row.project_id !== inProject)) throw ruleError('NO_SUCH_ENTRY', `There is no scratchpad entry ${id}.`, 'Read the scratchpad to find the id.', 404);
  await ctx.db.batch([
    ctx.db.prepare(`UPDATE scratchpad_entries SET body = ?, edited_at = ? WHERE id = ?`).bind(body, ctx.now(), id),
    changeStmt(ctx, { projectId: row.project_id, actor: ADMIN, kind: 'scratchpad.edited', subjectId: id }),
  ]);
}

export async function adminClearScratchpad(ctx: Ctx, projectId: number): Promise<void> {
  await ctx.db.batch([
    ctx.db.prepare(`DELETE FROM scratchpad_entries WHERE project_id = ?`).bind(projectId),
    changeStmt(ctx, { projectId, actor: ADMIN, kind: 'scratchpad.cleared' }),
  ]);
}
