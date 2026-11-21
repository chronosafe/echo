import type { Ctx } from '../ctx';
import { ruleError } from '../errors';
import { changeStmt } from './changelog';

export type AgentRow = {
  id: number;
  name: string;
  revoked_at: string | null;
  last_checked_in_at: string | null;
  created_at: string;
};

const AGENT_COLS = 'id, name, revoked_at, last_checked_in_at, created_at';

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newToken(): string {
  return 'echo_' + b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function createAgent(ctx: Ctx, name: string): Promise<{ agent: AgentRow; token: string }> {
  const n = name.trim();
  if (!n) throw ruleError('BAD_NAME', 'An agent needs a name.', 'Give the agent a non-empty name.');
  const token = newToken();
  try {
    const agent = await ctx.db
      .prepare(`INSERT INTO agents (name, token_hash, created_at) VALUES (?,?,?) RETURNING ${AGENT_COLS}`)
      .bind(n, await sha256Hex(token), ctx.now())
      .first<AgentRow>();
    return { agent: agent!, token };
  } catch (e) {
    if (String(e).includes('UNIQUE')) {
      throw ruleError('NAME_TAKEN', `An agent named "${n}" already exists.`, 'Choose a different name.', 409);
    }
    throw e;
  }
}

function agentNotFound(id: number) {
  return ruleError('AGENT_NOT_FOUND', `There is no agent ${id}.`, 'Check the agent id.', 404);
}

/** Replaces the stored hash, so the old token stops working. Also clears a revocation: reissuing is the owner's deliberate act. */
export async function reissueToken(ctx: Ctx, agentId: number): Promise<string> {
  const token = newToken();
  const res = await ctx.db
    .prepare(`UPDATE agents SET token_hash = ?, revoked_at = NULL WHERE id = ?`)
    .bind(await sha256Hex(token), agentId)
    .run();
  if (!res.meta.changes) throw agentNotFound(agentId);
  return token;
}

export async function revokeAgent(ctx: Ctx, agentId: number): Promise<void> {
  const res = await ctx.db
    .prepare(`UPDATE agents SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?`)
    .bind(ctx.now(), agentId)
    .run();
  if (!res.meta.changes) throw agentNotFound(agentId);
}

const badToken = () =>
  ruleError(
    'BAD_TOKEN',
    'The token is missing, wrong or revoked.',
    'Ask the owner to reissue your token, then store it again.',
    401,
  );

export async function authenticate(ctx: Ctx, authorization: string | null): Promise<AgentRow> {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? '');
  if (!m) throw badToken();
  const row = await ctx.db
    .prepare(`SELECT ${AGENT_COLS} FROM agents WHERE token_hash = ?`)
    .bind(await sha256Hex(m[1]))
    .first<AgentRow>();
  if (!row || row.revoked_at) throw badToken();
  return row;
}

export async function touchCheckIn(ctx: Ctx, agentId: number): Promise<void> {
  await ctx.db.prepare(`UPDATE agents SET last_checked_in_at = ? WHERE id = ?`).bind(ctx.now(), agentId).run();
}

export async function listAgents(ctx: Ctx): Promise<AgentRow[]> {
  const { results } = await ctx.db.prepare(`SELECT ${AGENT_COLS} FROM agents ORDER BY name`).all<AgentRow>();
  return results;
}

/** One change entry per project the agent belongs to, in the same batch as the change. The token is never logged. */
function agentChangeStmt(ctx: Ctx, agentId: number, kind: 'agent.reissued' | 'agent.revoked'): D1PreparedStatement {
  return ctx.db
    .prepare(`INSERT INTO change_log (project_id, at, actor, kind, subject_id) SELECT project_id, ?, 'admin', ?, ? FROM project_agents WHERE agent_id = ?`)
    .bind(ctx.now(), kind, agentId, agentId);
}

/** The owner creates an agent and adds it to a project in one batch. The token is returned here and never again. */
export async function adminCreateAgent(ctx: Ctx, projectId: number, name: string): Promise<{ agent: AgentRow; token: string }> {
  const n = name.trim();
  if (!n) throw ruleError('BAD_NAME', 'An agent needs a name.', 'Give the agent a non-empty name.');
  const project = await ctx.db.prepare(`SELECT id FROM projects WHERE id = ?`).bind(projectId).first();
  if (!project) throw ruleError('PROJECT_NOT_FOUND', `There is no project ${projectId}.`, 'Check the project id.', 404);
  const token = newToken();
  try {
    const [ins] = await ctx.db.batch([
      ctx.db
        .prepare(`INSERT INTO agents (name, token_hash, created_at) VALUES (?,?,?) RETURNING ${AGENT_COLS}`)
        .bind(n, await sha256Hex(token), ctx.now()),
      ctx.db.prepare(`INSERT INTO project_agents (project_id, agent_id) SELECT ?, id FROM agents WHERE name = ?`).bind(projectId, n),
      changeStmt(ctx, { projectId, actor: { kind: 'admin' }, kind: 'member.added', data: { agent: n, created: true } }),
    ]);
    return { agent: ins.results[0] as AgentRow, token };
  } catch (e) {
    if (String(e).includes('UNIQUE')) {
      throw ruleError('NAME_TAKEN', `An agent named "${n}" already exists.`, 'Choose a different name, or assign the existing agent.', 409);
    }
    throw e;
  }
}

/** Like reissueToken, with the change entries in the same batch. */
export async function adminReissueToken(ctx: Ctx, agentId: number): Promise<string> {
  const token = newToken();
  const [upd] = await ctx.db.batch([
    ctx.db.prepare(`UPDATE agents SET token_hash = ?, revoked_at = NULL WHERE id = ?`).bind(await sha256Hex(token), agentId),
    agentChangeStmt(ctx, agentId, 'agent.reissued'),
  ]);
  if (!upd.meta.changes) throw agentNotFound(agentId);
  return token;
}

export async function adminRevokeAgent(ctx: Ctx, agentId: number): Promise<void> {
  const [upd] = await ctx.db.batch([
    ctx.db.prepare(`UPDATE agents SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?`).bind(ctx.now(), agentId),
    agentChangeStmt(ctx, agentId, 'agent.revoked'),
  ]);
  if (!upd.meta.changes) throw agentNotFound(agentId);
}

/**
 * Every place that can still refer to an agent: by id, or by its name (messages, holds, events, to-dos, scratchpad,
 * documents and the change log keep the name as text). Each condition reads `agents.id` / `agents.name`, so the same
 * text serves the DELETE (as NOT cond) and the query that names what is left.
 */
const AGENT_REFS: [label: string, cond: string][] = [
  ['project membership', `EXISTS (SELECT 1 FROM project_agents WHERE agent_id = agents.id)`],
  ['messages sent', `EXISTS (SELECT 1 FROM messages WHERE sender_agent_id = agents.id OR sender_label = agents.name)`],
  ['message deliveries', `EXISTS (SELECT 1 FROM message_recipients WHERE agent_id = agents.id OR acked_by = agents.name)`],
  ['holds', `EXISTS (SELECT 1 FROM holds WHERE placed_by_agent_id = agents.id OR placed_by_label = agents.name OR acked_by = agents.name OR released_by = agents.name)`],
  ['calendar events', `EXISTS (SELECT 1 FROM events WHERE merger_agent_id = agents.id OR created_by = agents.name OR merged_by = agents.name)`],
  ['approvals', `EXISTS (SELECT 1 FROM event_approvers WHERE agent_id = agents.id OR responded_by = agents.name)`],
  ['to-dos', `EXISTS (SELECT 1 FROM todos WHERE added_by = agents.name OR claimed_by = agents.name)`],
  ['scratchpad entries', `EXISTS (SELECT 1 FROM scratchpad_entries WHERE author = agents.name)`],
  ['documents', `EXISTS (SELECT 1 FROM documents WHERE saved_by = agents.name)`],
  [
    'change log entries',
    `EXISTS (SELECT 1 FROM change_log WHERE actor = agents.name OR (subject_id = agents.id AND kind IN ('agent.reissued','agent.revoked','member.added','member.removed')))`,
  ],
];

/**
 * Permanently deletes a revoked agent that nothing refers to any more. Both conditions are part of the DELETE itself,
 * so a reference added meanwhile cannot slip past an earlier check; if it deletes nothing, a second read says why.
 */
export async function adminDeleteAgent(ctx: Ctx, agentId: number): Promise<void> {
  const none = AGENT_REFS.map(([, c]) => `NOT ${c}`).join(' AND ');
  const named = await ctx.db.prepare(`SELECT name FROM agents WHERE id = ?`).bind(agentId).first<{ name: string }>(); // for the log line only
  const [res] = await ctx.db.batch([ctx.db.prepare(`DELETE FROM agents WHERE id = ? AND revoked_at IS NOT NULL AND ${none}`).bind(agentId)]);
  if (res.meta.changes > 0) {
    console.log(`agent deleted: id=${agentId} name=${named?.name ?? '?'}`);
    return;
  }
  const flags = AGENT_REFS.map(([, c], i) => `(CASE WHEN ${c} THEN 1 ELSE 0 END) AS r${i}`).join(', ');
  const row = await ctx.db.prepare(`SELECT name, revoked_at, ${flags} FROM agents WHERE id = ?`).bind(agentId).first<Record<string, number | string | null>>();
  if (!row) throw agentNotFound(agentId);
  if (!row.revoked_at) {
    throw ruleError('AGENT_NOT_REVOKED', `Agent "${row.name}" is not revoked, so it cannot be deleted.`, 'Revoke the agent first, then delete it.', 409);
  }
  const left = AGENT_REFS.filter((_, i) => row[`r${i}`]).map(([label]) => label);
  throw ruleError(
    'AGENT_HAS_HISTORY',
    `Agent "${row.name}" still appears in: ${left.join(', ') || 'records that changed just now'}.`,
    'Delete those projects first (archive each, then delete it), and remove the agent from any project it is still in; then delete the agent.',
    409,
  );
}
