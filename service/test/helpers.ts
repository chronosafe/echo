import { env } from 'cloudflare:test';
import type { Ctx } from '../src/ctx';
import type { Actor } from '../src/types';

export type TestCtx = Ctx & { setNow(iso: string): void };

export function testCtx(now = '2026-11-18T20:00:00.000Z'): TestCtx {
  let current = now;
  return {
    db: env.DB,
    env,
    now: () => current,
    setNow(iso: string) {
      current = iso;
    },
  };
}

export type ProjectRow = {
  id: number;
  name: string;
  approvals_required: number;
  approval_window_min: number;
};
export type AgentRow = { id: number; name: string; token: string };
export type RepoRow = { id: number; full_name: string; project_id: number };

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function makeAgent(ctx: Ctx, name: string): Promise<AgentRow> {
  const token = 'echo_' + b64url(crypto.getRandomValues(new Uint8Array(32)));
  const row = await ctx.db
    .prepare(`INSERT INTO agents (name, token_hash, created_at) VALUES (?,?,?) RETURNING id`)
    .bind(name, await sha256Hex(token), ctx.now())
    .first<{ id: number }>();
  return { id: row!.id, name, token };
}

async function makeProject(ctx: Ctx, name: string, approvalsRequired: number): Promise<ProjectRow> {
  const row = await ctx.db
    .prepare(
      `INSERT INTO projects (name, approvals_required, created_at) VALUES (?,?,?)
       RETURNING id, name, approvals_required, approval_window_min`,
    )
    .bind(name, approvalsRequired, ctx.now())
    .first<ProjectRow>();
  return row!;
}

async function join(ctx: Ctx, projectId: number, agentId: number): Promise<void> {
  await ctx.db.prepare(`INSERT INTO project_agents (project_id, agent_id) VALUES (?,?)`).bind(projectId, agentId).run();
}

const agentActor = (a: AgentRow): Actor => ({ kind: 'agent', agentId: a.id, name: a.name });

async function seedWith(ctx: Ctx, approvalsRequired: number) {
  const project = await makeProject(ctx, 'core', approvalsRequired);
  const other = await makeProject(ctx, 'other', 0);
  const alice = await makeAgent(ctx, 'Alice');
  const bob = await makeAgent(ctx, 'Bob');
  const carol = await makeAgent(ctx, 'Carol');
  await join(ctx, project.id, alice.id);
  await join(ctx, project.id, bob.id);
  await join(ctx, other.id, carol.id);
  const repoRow = await ctx.db
    .prepare(`INSERT INTO repos (full_name, project_id, installation_id) VALUES (?,?,NULL) RETURNING id, full_name, project_id`)
    .bind('acme/app', project.id)
    .first<RepoRow>();
  return {
    project,
    other,
    alice,
    bob,
    carol,
    repo: repoRow!,
    aliceA: agentActor(alice),
    bobA: agentActor(bob),
    carolA: agentActor(carol),
  };
}

/** Alice and Bob in `core` (approvals off), Carol in `other`, repo acme/app registered to `core`. */
export function seed(ctx: Ctx) {
  return seedWith(ctx, 0);
}

/** Same as seed, with core.approvals_required = 1. */
export function seedApprovals(ctx: Ctx) {
  return seedWith(ctx, 1);
}

export type NetRequest = { url: string; method: string; headers: Record<string, string>; body: string; hasSignal: boolean };

/** A recording fake fetch. `respond` picks the status for each request (default 200); a thrown error simulates a network failure. */
export function fakeNet(respond: (r: NetRequest, n: number) => number = () => 200) {
  const requests: NetRequest[] = [];
  const net = {
    requests,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      const r: NetRequest = { url: String(url), method: init?.method ?? 'GET', headers, body: String(init?.body ?? ''), hasSignal: !!init?.signal };
      requests.push(r);
      return new Response('', { status: respond(r, requests.length) });
    }) as typeof fetch,
  };
  return net;
}
