import { createMcpHandler } from 'agents/mcp/server';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { admin } from './admin/routes';
import { hookApi } from './api/hooks';
import { makeCtx } from './ctx';
import { authenticate } from './domain/agents';
import './domain/approvals'; // registers the calendar's approvals hook and schedule decider
import { runEscalations } from './domain/escalation';
import { deliverWebhooks } from './domain/webhooks';
import type { Env } from './env';
import { EchoError, errorJson, errorStatus } from './errors';
import { githubAppConfigured, kickStatusJobs, runStatusJobs } from './github/status';
import { handleGithubWebhook } from './github/webhook';
import { createEchoServer } from './mcp/server';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true, now: makeCtx(c.env).now() }));

app.route('/api/v1', hookApi);
app.route('/admin', admin);

app.all('/mcp', async (c) => {
  const ctx = makeCtx(c.env);
  const agent = await authenticate(ctx, c.req.header('authorization') ?? null); // 401 JSON before any MCP handling
  const allowed = c.env.ALLOWED_HOSTNAMES?.split(',').map((h) => h.trim()).filter(Boolean);
  const handler = createMcpHandler(() => createEchoServer(ctx, agent), {
    authContext: { props: { agentId: agent.id } },
    ...(allowed?.length ? { allowedHostnames: allowed } : {}),
  });
  // Hono types the context from workers-types; agents expects the newer runtime shape. Same object at runtime.
  const res = await handler(c.req.raw, c.env, c.executionCtx as unknown as Parameters<typeof handler>[2]);
  if (!res.body || !githubAppConfigured(ctx)) return res;
  // Tool calls run while the response streams; once it has finished, their changes have committed, so any
  // echo/hold status they queued gets its first attempt then.
  const { readable, writable } = new TransformStream();
  const finished = res.body.pipeTo(writable);
  kickStatusJobs(ctx, (p) => c.executionCtx.waitUntil(p), finished);
  return new Response(readable, res);
});

app.post('/github/webhook', async (c) => {
  const ctx = makeCtx(c.env);
  const res = await handleGithubWebhook(ctx, c.req.raw);
  kickStatusJobs(ctx, (p) => c.executionCtx.waitUntil(p));
  return res;
});

app.onError((e, c) => {
  // An EchoError is an answer the code chose; anything else is a fault nobody would otherwise see. Only the method
  // and path are logged: never the body, the query string or the headers, which carry tokens and message text.
  if (!(e instanceof EchoError)) console.error(`unexpected error on ${c.req.method} ${c.req.path}`, e);
  return c.json(errorJson(e), errorStatus(e) as ContentfulStatusCode);
});

export default {
  fetch: app.fetch,
  /** Every minute: approval-window edges and GitHub status retries (they gate merges, so first), then best-effort owner escalations and outgoing webhooks. */
  async scheduled(_controller, env, exec) {
    const ctx = makeCtx(env);
    exec.waitUntil(
      (async () => {
        try {
          await runStatusJobs(ctx);
        } catch (e) {
          console.error('status cron failed', e);
        }
        try {
          await runEscalations(ctx);
        } catch (e) {
          console.error('escalation cron failed', e);
        }
        try {
          await deliverWebhooks(ctx);
        } catch (e) {
          console.error('webhook cron failed', e);
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
