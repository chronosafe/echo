import type { Ctx } from '../ctx';
import { ruleError } from '../errors';
import type { Actor } from '../types';
import { changeStmt } from './changelog';
import { checkTitleSize } from './messages';
import { requireMember } from './projects';

const ADMIN: Actor = { kind: 'admin' };

export type Todo = {
  id: number;
  projectId: number;
  title: string;
  addedBy: string;
  claimedBy: string | null;
  claimedAt: string | null;
  doneAt: string | null;
  createdAt: string;
};

type TodoDb = {
  id: number;
  project_id: number;
  title: string;
  added_by: string;
  claimed_by: string | null;
  claimed_at: string | null;
  done_at: string | null;
  created_at: string;
};

const COLS = 'id, project_id, title, added_by, claimed_by, claimed_at, done_at, created_at';

function view(r: TodoDb): Todo {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    addedBy: r.added_by,
    claimedBy: r.claimed_by,
    claimedAt: r.claimed_at,
    doneAt: r.done_at,
    createdAt: r.created_at,
  };
}

function name(actor: Actor): string {
  return actor.kind === 'agent' ? actor.name : actor.kind === 'admin' ? 'admin' : actor.name;
}

/** Agents must belong to the project; the owner (admin) and Echo itself need no membership. */
async function authorize(ctx: Ctx, actor: Actor, projectId: number): Promise<void> {
  if (actor.kind === 'agent') await requireMember(ctx, actor.agentId, projectId);
}

/** With `inProject`, a to-do of another project is reported as missing (a project's admin page cannot reach it). */
async function getTodo(ctx: Ctx, id: number, inProject?: number): Promise<TodoDb> {
  const row = await ctx.db.prepare(`SELECT ${COLS} FROM todos WHERE id = ?`).bind(id).first<TodoDb>();
  if (!row || (inProject !== undefined && row.project_id !== inProject)) throw ruleError('NO_SUCH_TODO', `There is no to-do ${id}.`, 'List the project to-dos (echo_todo_list) to find the id.', 404);
  return row;
}

function cleanTitle(title: string): string {
  const t = title.trim();
  if (!t) throw ruleError('BAD_TITLE', 'A to-do needs a title.', 'Give a short, non-empty title.');
  checkTitleSize(t, 'to-do');
  return t;
}

export async function addTodo(ctx: Ctx, actor: Actor, projectId: number, title: string): Promise<Todo> {
  await authorize(ctx, actor, projectId);
  const t = cleanTitle(title);
  const [ins] = await ctx.db.batch([
    ctx.db
      .prepare(`INSERT INTO todos (project_id, title, added_by, created_at) VALUES (?,?,?,?) RETURNING ${COLS}`)
      .bind(projectId, t, name(actor), ctx.now()),
    changeStmt(ctx, { projectId, actor, kind: 'todo.added', data: { title: t } }),
  ]);
  return view(ins.results[0] as TodoDb);
}

export async function listTodos(ctx: Ctx, actor: Actor, projectId: number, opts: { includeDone?: boolean }): Promise<Todo[]> {
  await authorize(ctx, actor, projectId);
  const { results } = await ctx.db
    .prepare(`SELECT ${COLS} FROM todos WHERE project_id = ? ${opts.includeDone ? '' : 'AND done_at IS NULL'} ORDER BY id`)
    .bind(projectId)
    .all<TodoDb>();
  return results.map(view);
}

export async function claimTodo(ctx: Ctx, actor: Actor, id: number): Promise<Todo> {
  const before = await getTodo(ctx, id);
  await authorize(ctx, actor, before.project_id);
  const [upd] = await ctx.db.batch([
    ctx.db
      .prepare(`UPDATE todos SET claimed_by = ?, claimed_at = ? WHERE id = ? AND claimed_by IS NULL AND done_at IS NULL`)
      .bind(name(actor), ctx.now(), id),
    changeStmt(ctx, { projectId: before.project_id, actor, kind: 'todo.claimed', subjectId: id }, { guarded: true }),
  ]);
  if (upd.meta.changes === 0) {
    const now = await getTodo(ctx, id);
    if (now.done_at !== null) {
      throw ruleError('TODO_DONE', `To-do ${id} was already completed at ${now.done_at}.`, 'Nothing to claim. Add a new to-do if more work is needed.', 409);
    }
    throw ruleError(
      'ALREADY_CLAIMED',
      `To-do ${id} is already claimed by ${now.claimed_by} (since ${now.claimed_at}).`,
      `Pick another to-do, or ask ${now.claimed_by} to finish it or to release it (echo_todo_release) so you can claim it.`,
      409,
    );
  }
  return view(await getTodo(ctx, id));
}

/** Only the agent holding the claim may give it up; it then becomes claimable by anyone. */
export async function releaseTodo(ctx: Ctx, actor: Actor, id: number): Promise<Todo> {
  const before = await getTodo(ctx, id);
  await authorize(ctx, actor, before.project_id);
  const [upd] = await ctx.db.batch([
    ctx.db
      .prepare(`UPDATE todos SET claimed_by = NULL, claimed_at = NULL WHERE id = ? AND claimed_by = ? AND done_at IS NULL`)
      .bind(id, name(actor)),
    changeStmt(ctx, { projectId: before.project_id, actor, kind: 'todo.released', subjectId: id }, { guarded: true }),
  ]);
  if (upd.meta.changes === 0) {
    const now = await getTodo(ctx, id);
    if (now.done_at !== null) {
      throw ruleError('TODO_DONE', `To-do ${id} was already completed at ${now.done_at}.`, 'A completed to-do has no claim to release.', 409);
    }
    if (now.claimed_by === null) {
      throw ruleError('TODO_NOT_CLAIMED', `To-do ${id} is not claimed, so there is nothing to release.`, 'Claim it first (echo_todo_claim) if you want to work on it.', 409);
    }
    throw ruleError(
      'NOT_CLAIMER',
      `To-do ${id} is claimed by ${now.claimed_by}, not by you.`,
      `Only ${now.claimed_by} can release it. Ask ${now.claimed_by} to release it, or ask the owner to clear the claim.`,
      409,
    );
  }
  return view(await getTodo(ctx, id));
}

/** Any member may complete a to-do; who did it is recorded in the change log. */
export async function completeTodo(ctx: Ctx, actor: Actor, id: number): Promise<Todo> {
  const before = await getTodo(ctx, id);
  await authorize(ctx, actor, before.project_id);
  const [upd] = await ctx.db.batch([
    ctx.db.prepare(`UPDATE todos SET done_at = ? WHERE id = ? AND done_at IS NULL`).bind(ctx.now(), id),
    changeStmt(
      ctx,
      { projectId: before.project_id, actor, kind: 'todo.completed', subjectId: id, data: { claimedBy: before.claimed_by } },
      { guarded: true },
    ),
  ]);
  if (upd.meta.changes === 0) {
    const now = await getTodo(ctx, id);
    throw ruleError('TODO_DONE', `To-do ${id} was already completed at ${now.done_at}.`, 'Nothing more to do for it.', 409);
  }
  return view(await getTodo(ctx, id));
}

export async function adminEditTodo(ctx: Ctx, id: number, title: string, inProject?: number): Promise<void> {
  const before = await getTodo(ctx, id, inProject);
  const t = cleanTitle(title);
  await ctx.db.batch([
    ctx.db.prepare(`UPDATE todos SET title = ? WHERE id = ?`).bind(t, id),
    changeStmt(ctx, { projectId: before.project_id, actor: ADMIN, kind: 'todo.edited', subjectId: id, data: { from: before.title, to: t } }),
  ]);
}

export async function adminDeleteTodo(ctx: Ctx, id: number, inProject?: number): Promise<void> {
  const before = await getTodo(ctx, id, inProject);
  await ctx.db.batch([
    ctx.db.prepare(`DELETE FROM todos WHERE id = ?`).bind(id),
    changeStmt(ctx, { projectId: before.project_id, actor: ADMIN, kind: 'todo.deleted', subjectId: id, data: { title: before.title } }),
  ]);
}

/**
 * Owner action: clear the claim on an open, claimed to-do. The UPDATE is bound to the claimer read here, so
 * the logged `claimedBy` is the claim actually cleared; if the claim changed in between, it is refused (not retried).
 */
export async function adminClearTodoClaim(ctx: Ctx, id: number, inProject?: number): Promise<void> {
  const before = await getTodo(ctx, id, inProject);
  if (before.done_at === null && before.claimed_by === null) {
    throw ruleError('TODO_NOT_CLAIMED', `To-do ${id} is not claimed.`, 'There is no claim to clear.', 409);
  }
  const [upd] = await ctx.db.batch([
    ctx.db
      .prepare(`UPDATE todos SET claimed_by = NULL, claimed_at = NULL WHERE id = ? AND claimed_by = ? AND done_at IS NULL`)
      .bind(id, before.claimed_by),
    changeStmt(
      ctx,
      { projectId: before.project_id, actor: ADMIN, kind: 'todo.released', subjectId: id, data: { claimedBy: before.claimed_by } },
      { guarded: true },
    ),
  ]);
  if (upd.meta.changes === 0) {
    const now = await getTodo(ctx, id);
    if (now.done_at !== null) {
      throw ruleError('TODO_DONE', `To-do ${id} was already completed at ${now.done_at}.`, 'A completed to-do has no claim to clear.', 409);
    }
    if (now.claimed_by === null) {
      throw ruleError('TODO_NOT_CLAIMED', `To-do ${id} is not claimed.`, 'There is no claim to clear.', 409);
    }
    throw ruleError('CLAIM_CHANGED', `The claim on to-do ${id} changed to ${now.claimed_by} while you were clearing it.`, 'Reload the page and clear it again if you still want to.', 409);
  }
}
