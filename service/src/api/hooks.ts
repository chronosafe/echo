import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { makeCtx } from '../ctx';
import type { Ctx } from '../ctx';
import type { Env } from '../env';
import { ruleError } from '../errors';
import type { Actor } from '../types';
import { authenticate, touchCheckIn } from '../domain/agents';
import type { AgentRow } from '../domain/agents';
import { mergeDecision, pendingApprovals } from '../domain/approvals';
import { recordMerge } from '../domain/calendar';
import { changeStmt } from '../domain/changelog';
import { listHolds } from '../domain/holds';
import { peekForHook, takeAwaitingForStop, takeForHook } from '../domain/messages';
import { agentProjects, findRepo, gatedRepos, normalizeRepo } from '../domain/projects';

type Vars = { ctx: Ctx; agent: AgentRow };
type C = Context<{ Bindings: Env; Variables: Vars }>;

const repo = z.string().min(1);
const pr = z.number().int().positive();

const empty = z.object({}).strict();
const mergeCheckBody = z.object({ repo, pr, flags: z.object({ auto: z.boolean(), admin: z.boolean() }).strict() }).strict();
const mergeReportBody = z.object({ repo, pr, mergedAt: z.string().min(1) }).strict();
const overrideReportBody = z.object({ repo, pr, reason: z.string().min(1) }).strict();

/**
 * Validates already-parsed input against a strict schema. Every failure is the rule error BAD_REQUEST naming the
 * field. Shared by the hook API (`what` = the request body) and the MCP tools (`what` = the tool arguments).
 */
export function strictParse<T extends z.ZodType>(schema: T, raw: unknown, what: string, fix: string): z.infer<T> {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  const problems = r.error.issues.map((i) => {
    if (i.code === 'unrecognized_keys') {
      const where = i.path.length ? `${i.path.join('.')}.` : '';
      return `unexpected field ${i.keys.map((k) => `"${where}${k}"`).join(', ')}`;
    }
    return `${i.path.join('.') || 'body'}: ${i.message}`;
  });
  throw ruleError('BAD_REQUEST', `The ${what} is not valid: ${problems.join('; ')}.`, fix);
}

/** Parses the JSON body against a strict schema. Every failure is the rule error BAD_REQUEST naming the field. */
async function body<T extends z.ZodType>(c: C, schema: T): Promise<z.infer<T>> {
  const text = await c.req.text();
  let raw: unknown;
  try {
    raw = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    throw ruleError('BAD_REQUEST', 'The request body is not valid JSON.', 'Send a JSON object as the body.');
  }
  return strictParse(schema, raw, 'request body', 'Send exactly the documented fields. Requests never carry times, except merge-report mergedAt.');
}

const actorOf = (a: AgentRow): Actor => ({ kind: 'agent', agentId: a.id, name: a.name });

export const hookApi = new Hono<{ Bindings: Env; Variables: Vars }>();

hookApi.use('*', async (c, next) => {
  const ctx = makeCtx(c.env);
  c.set('ctx', ctx);
  c.set('agent', await authenticate(ctx, c.req.header('authorization') ?? null));
  await next();
});

hookApi.post('/orient', async (c) => {
  await body(c, empty);
  const ctx = c.get('ctx');
  const agent = c.get('agent');
  const projects = await agentProjects(ctx, agent.id);
  const taken = await takeForHook(ctx, agent.id);
  const openHolds = await listHolds(ctx, agent.id, { state: 'open' });
  const pending = await pendingApprovals(ctx, agent.id);
  await touchCheckIn(ctx, agent.id);
  return c.json({
    now: ctx.now(),
    agent: { id: agent.id, name: agent.name },
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    fresh: taken.fresh,
    awaitingAck: taken.awaitingAck,
    openHolds,
    pendingApprovals: pending,
    gatedRepos: await gatedRepos(ctx),
  });
});

hookApi.post('/poll', async (c) => {
  await body(c, empty);
  const ctx = c.get('ctx');
  const agent = c.get('agent');
  const taken = await takeForHook(ctx, agent.id);
  await touchCheckIn(ctx, agent.id);
  return c.json({ now: ctx.now(), fresh: taken.fresh, awaitingAck: taken.awaitingAck, gatedRepos: await gatedRepos(ctx) });
});

/** Read-only: counts what the next /poll would deliver as fresh. Changes nothing, not even the check-in time. */
hookApi.post('/peek', async (c) => {
  await body(c, empty);
  const ctx = c.get('ctx');
  const messages = await peekForHook(ctx, c.get('agent').id);
  return c.json({ now: ctx.now(), count: messages.length, messages });
});

hookApi.post('/stop-check', async (c) => {
  await body(c, empty);
  const ctx = c.get('ctx');
  const agent = c.get('agent');
  // Requires-ack messages only, delivered or not; plain messages wait for the next poll.
  const awaitingAck = await takeAwaitingForStop(ctx, agent.id);
  await touchCheckIn(ctx, agent.id);
  return c.json({ awaitingAck });
});

hookApi.post('/merge-check', async (c) => {
  const b = await body(c, mergeCheckBody);
  const ctx = c.get('ctx');
  const agent = c.get('agent');
  const name = normalizeRepo(b.repo);
  const d = await mergeDecision(ctx, name, b.pr);
  if (d.gated && (!d.allowed || b.flags.auto || b.flags.admin)) {
    const found = await findRepo(ctx, name);
    if (found) {
      await ctx.db.batch([
        changeStmt(ctx, {
          projectId: found.project_id,
          actor: actorOf(agent),
          kind: 'merge.refused',
          subjectId: b.pr,
          data: { repo: found.full_name, pr: b.pr, blocks: d.blocks, flags: b.flags },
        }),
      ]);
    }
  }
  return c.json({ gated: d.gated, allowed: d.allowed, blocks: d.blocks });
});

hookApi.post('/merge-report', async (c) => {
  const b = await body(c, mergeReportBody);
  const ctx = c.get('ctx');
  const recorded = await recordMerge(ctx, actorOf(c.get('agent')), { repo: b.repo, pr: b.pr, mergedAt: b.mergedAt, source: 'hook' });
  return c.json({ recorded: recorded !== null });
});

hookApi.post('/override-report', async (c) => {
  const b = await body(c, overrideReportBody);
  const ctx = c.get('ctx');
  const found = await findRepo(ctx, b.repo);
  if (!found) return c.json({ recorded: false });
  await ctx.db.batch([
    changeStmt(ctx, {
      projectId: found.project_id,
      actor: actorOf(c.get('agent')),
      kind: 'override.used',
      subjectId: b.pr,
      data: { repo: found.full_name, pr: b.pr, reason: b.reason },
    }),
  ]);
  return c.json({ recorded: true });
});

hookApi.get('/repos', async (c) => c.json({ gatedRepos: await gatedRepos(c.get('ctx')) }));
