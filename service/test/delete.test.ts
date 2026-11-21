import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adminDeleteAgent, adminRevokeAgent } from '../src/domain/agents';
import { adminDeleteProject, archiveProject } from '../src/domain/projects';
import { EchoError } from '../src/errors';
import { seed, testCtx } from './helpers';

const ORIGIN = 'https://echo.test';
const ctx = testCtx();
let ip = 200;

async function sessionCookie(): Promise<string> {
  const res = await SELF.fetch(`${ORIGIN}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': `10.2.0.${++ip}` },
    body: new URLSearchParams({ password: 'correct horse' }),
  });
  return res.headers.get('set-cookie')!.split(';')[0]!;
}
const get = (path: string, cookie: string) => SELF.fetch(`${ORIGIN}${path}`, { redirect: 'manual', headers: { cookie } });
const post = (path: string, cookie: string | null, form: Record<string, string> = {}, headers: Record<string, string> = {}) =>
  SELF.fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}), ...headers },
    body: new URLSearchParams(form),
  });

const q = async (sql: string, ...b: unknown[]) => (await env.DB.prepare(sql).bind(...b).all<any>()).results;
const n = async (sql: string, ...b: unknown[]) => (await q(sql, ...b))[0]!.n as number;
const rejects = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as EchoError;
  }
  throw new Error('expected a refusal');
};

/** One row in every table that belongs to a project, plus children and repo-keyed status rows. Read with `counts`. */
async function fill(projectId: number, agentId: number, agentName: string, repoName: string): Promise<void> {
  const t = '2026-11-18T20:00:00.000Z';
  const run = (sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b).run();
  await run(`INSERT OR IGNORE INTO project_agents (project_id, agent_id) VALUES (?,?)`, projectId, agentId);
  const repo = (await env.DB.prepare(`INSERT INTO repos (full_name, project_id) VALUES (?,?) RETURNING id`).bind(repoName, projectId).first<any>())!.id;
  await run(`INSERT INTO pr_heads (repo_id, pr_number, head_sha, updated_at) VALUES (?,?,?,?)`, repo, 1, 'abc', t);
  await run(`INSERT INTO commit_statuses (repo_id, sha, state, updated_at) VALUES (?,?,?,?)`, repo, 'abc', 'success', t);
  await run(`INSERT INTO status_jobs (repo_id, pr_number, next_attempt_at) VALUES (?,?,?)`, repo, 1, t);
  const msg = (await env.DB.prepare(`INSERT INTO messages (project_id, sender_agent_id, sender_label, body, created_at) VALUES (?,?,?,?,?) RETURNING id`).bind(projectId, agentId, agentName, 'hi', t).first<any>())!.id;
  await run(`INSERT INTO message_recipients (message_id, agent_id) VALUES (?,?)`, msg, agentId);
  await run(`INSERT INTO holds (project_id, repo_id, pr_number, kind, reason, placed_by_agent_id, placed_by_label, placed_at) VALUES (?,?,?,?,?,?,?,?)`, projectId, repo, 1, 'blocking', 'r', agentId, agentName, t);
  const ev = (await env.DB.prepare(`INSERT INTO events (project_id, title, starts_at, entered_as, kind, merger_agent_id, created_by, updated_at) VALUES (?,?,?,?,?,?,?,?) RETURNING id`).bind(projectId, 'e', t, 'UTC', 'merge', agentId, agentName, t).first<any>())!.id;
  await run(`INSERT INTO event_approvers (event_id, agent_id) VALUES (?,?)`, ev, agentId);
  await run(`INSERT INTO todos (project_id, title, added_by, created_at) VALUES (?,?,?,?)`, projectId, 't', agentName, t);
  await run(`INSERT INTO scratchpad_entries (project_id, author, body, created_at) VALUES (?,?,?,?)`, projectId, agentName, 'b', t);
  await run(`INSERT INTO documents (project_id, name, version, format, content, saved_by, created_at) VALUES (?,?,?,?,?,?,?)`, projectId, 'd', 1, 'markdown', 'x', agentName, t);
  await run(`INSERT INTO change_log (project_id, at, actor, kind) VALUES (?,?,?,?)`, projectId, t, agentName, 'todo.added');
  await run(`INSERT INTO webhooks (project_id, url, secret, created_at) VALUES (?,?,?,?)`, projectId, 'https://x.example/h', 's', t);
}

const PROJECT_TABLES = ['project_agents', 'repos', 'messages', 'holds', 'events', 'todos', 'scratchpad_entries', 'documents', 'change_log', 'webhooks'];

/** Row counts of every table, restricted to the project (and its children) where scoped. */
async function counts(projectId: number): Promise<Record<string, number>> {
  const r: Record<string, number> = { projects: await n(`SELECT COUNT(*) AS n FROM projects WHERE id = ?`, projectId) };
  for (const tb of PROJECT_TABLES) r[tb] = await n(`SELECT COUNT(*) AS n FROM ${tb} WHERE project_id = ?`, projectId);
  r.message_recipients = await n(`SELECT COUNT(*) AS n FROM message_recipients WHERE message_id IN (SELECT id FROM messages WHERE project_id = ?)`, projectId);
  r.event_approvers = await n(`SELECT COUNT(*) AS n FROM event_approvers WHERE event_id IN (SELECT id FROM events WHERE project_id = ?)`, projectId);
  for (const tb of ['pr_heads', 'commit_statuses', 'status_jobs']) {
    r[tb] = await n(`SELECT COUNT(*) AS n FROM ${tb} WHERE repo_id IN (SELECT id FROM repos WHERE project_id = ?)`, projectId);
  }
  return r;
}

/** Everything in the database, for the "nothing changed" checks. */
async function snapshot(): Promise<string> {
  const tables = (await q(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' ORDER BY name`)).map((r) => r.name as string);
  const out: Record<string, unknown[]> = {};
  for (const tb of tables) out[tb] = await q(`SELECT * FROM ${tb} ORDER BY rowid`);
  return JSON.stringify(out);
}

/** Makes Carol a revoked agent that nothing refers to. */
async function orphanCarol(): Promise<void> {
  await adminRevokeAgent(ctx, s.carol.id);
  await env.DB.prepare(`DELETE FROM project_agents WHERE agent_id = ?`).bind(s.carol.id).run();
  await env.DB.prepare(`DELETE FROM change_log WHERE subject_id = ? OR actor = 'Carol'`).bind(s.carol.id).run();
}

let s: Awaited<ReturnType<typeof seed>>;
let cookie: string;
beforeEach(async () => {
  s = await seed(ctx);
  cookie = await sessionCookie();
});

describe('adminDeleteProject', () => {
  it('the test covers every table that has a project_id column', async () => {
    const tables = (await q(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' ORDER BY name`)).map((r) => r.name as string);
    const withProjectId: string[] = [];
    for (const tb of tables) if ((await q(`PRAGMA table_info(${tb})`)).some((c) => c.name === 'project_id')) withProjectId.push(tb);
    expect(withProjectId).toEqual([...PROJECT_TABLES].sort());
    // Child tables are reached through repo_id, message_id or event_id; a new one must be added to the delete and to `counts`.
    const keyed: Record<string, string[]> = { repo_id: [], message_id: [], event_id: [] };
    for (const tb of tables) {
      const cols = (await q(`PRAGMA table_info(${tb})`)).map((c) => c.name as string);
      for (const k of Object.keys(keyed)) if (cols.includes(k)) keyed[k]!.push(tb);
    }
    expect(keyed).toEqual({
      repo_id: ['commit_statuses', 'events', 'holds', 'pr_heads', 'status_jobs'],
      message_id: ['holds', 'message_recipients'],
      event_id: ['event_approvers'],
    });
  });

  it('logs one line with the project id, name and per-table row counts', async () => {
    const id = (await env.DB.prepare(`INSERT INTO projects (name, created_at, archived_at) VALUES ('logged', ?, ?) RETURNING id`).bind(ctx.now(), ctx.now()).first<any>())!.id as number;
    await fill(id, s.alice.id, 'Alice', 'acme/logged');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await adminDeleteProject(ctx, id);
    const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('project deleted'))!;
    spy.mockRestore();
    expect(line).toContain(`id=${id}`);
    expect(line).toContain('name=logged');
    expect(line).toContain('messages=1');
    expect(line).toContain('pr_heads=1');
  });

  it('archive, delete the project, then delete the revoked agent: it succeeds and leaves nothing', async () => {
    await fill(s.other.id, s.carol.id, 'Carol', 'acme/seq');
    await adminRevokeAgent(ctx, s.carol.id);
    expect((await rejects(adminDeleteAgent(ctx, s.carol.id))).code).toBe('AGENT_HAS_HISTORY');
    await archiveProject(ctx, s.other.id).catch(async () => {
      await env.DB.prepare(`DELETE FROM repos WHERE project_id = ?`).bind(s.other.id).run(); // archiving needs its repositories removed first
      await archiveProject(ctx, s.other.id);
    });
    await adminDeleteProject(ctx, s.other.id);
    await adminDeleteAgent(ctx, s.carol.id);
    expect(await n(`SELECT COUNT(*) AS n FROM agents WHERE name = 'Carol'`)).toBe(0);
    for (const tb of ['project_agents', 'messages', 'holds', 'events', 'todos', 'scratchpad_entries', 'documents', 'change_log', 'webhooks', 'message_recipients', 'event_approvers']) {
      expect(await n(`SELECT COUNT(*) AS n FROM ${tb} WHERE ${tb === 'message_recipients' || tb === 'event_approvers' ? 'agent_id' : tb === 'project_agents' ? 'agent_id' : 'project_id'} = ?`, tb === 'message_recipients' || tb === 'event_approvers' || tb === 'project_agents' ? s.carol.id : s.other.id), tb).toBe(0);
    }
  });

  it('deletes an archived project and every row of it, and leaves another project untouched', async () => {
    const doomed = (await env.DB.prepare(`INSERT INTO projects (name, created_at) VALUES ('doomed', ?) RETURNING id`).bind(ctx.now()).first<any>())!.id as number;
    await fill(doomed, s.alice.id, 'Alice', 'acme/doomed');
    await fill(s.project.id, s.alice.id, 'Alice', 'acme/keep');
    const keepBefore = await counts(s.project.id);
    const keepRows = JSON.stringify(await q(`SELECT * FROM messages WHERE project_id = ? ORDER BY id`, s.project.id));
    const before = await counts(doomed);
    for (const [tb, c] of Object.entries(before)) expect(c, tb).toBeGreaterThan(0);

    await env.DB.prepare(`UPDATE projects SET archived_at = ? WHERE id = ?`).bind(ctx.now(), doomed).run();
    await adminDeleteProject(ctx, doomed);

    const after = await counts(doomed);
    for (const [tb, c] of Object.entries(after)) expect(c, tb).toBe(0);
    expect(await counts(s.project.id)).toEqual(keepBefore);
    expect(JSON.stringify(await q(`SELECT * FROM messages WHERE project_id = ? ORDER BY id`, s.project.id))).toBe(keepRows);
    expect(await n(`SELECT COUNT(*) AS n FROM agents`)).toBe(3); // agents are never removed by a project delete
  });

  it('refuses a project that is not archived with PROJECT_NOT_ARCHIVED, and changes nothing', async () => {
    await fill(s.project.id, s.alice.id, 'Alice', 'acme/other');
    const before = await snapshot();
    const e = await rejects(adminDeleteProject(ctx, s.project.id));
    expect(e.code).toBe('PROJECT_NOT_ARCHIVED');
    expect(e.status).toBe(409);
    expect(e.fix).toMatch(/archive/i);
    expect(await snapshot()).toBe(before);
  });

  it('a project that does not exist is a not-found error', async () => {
    const e = await rejects(adminDeleteProject(ctx, 99999));
    expect(e.code).toBe('PROJECT_NOT_FOUND');
    expect(e.status).toBe(404);
  });
});

describe('adminDeleteAgent', () => {
  it('deletes a revoked agent that nothing refers to', async () => {
    await orphanCarol();
    await adminDeleteAgent(ctx, s.carol.id);
    expect(await n(`SELECT COUNT(*) AS n FROM agents WHERE id = ?`, s.carol.id)).toBe(0);
    expect(await n(`SELECT COUNT(*) AS n FROM agents`)).toBe(2);
  });

  it('refuses a revoked agent that still has history in a live project, with AGENT_HAS_HISTORY naming it', async () => {
    await fill(s.project.id, s.alice.id, 'Alice', 'acme/x');
    await adminRevokeAgent(ctx, s.alice.id);
    const before = await snapshot();
    const e = await rejects(adminDeleteAgent(ctx, s.alice.id));
    expect(e.code).toBe('AGENT_HAS_HISTORY');
    expect(e.status).toBe(409);
    expect(e.message).toMatch(/membership/);
    expect(e.message).toMatch(/message/);
    expect(e.fix).toMatch(/delete those projects first/i);
    expect(await snapshot()).toBe(before);
  });

  it('refuses an agent that is not revoked with AGENT_NOT_REVOKED, and changes nothing', async () => {
    const before = await snapshot();
    const e = await rejects(adminDeleteAgent(ctx, s.carol.id));
    expect(e.code).toBe('AGENT_NOT_REVOKED');
    expect(e.status).toBe(409);
    expect(await snapshot()).toBe(before);
    expect((await rejects(adminDeleteAgent(ctx, 99999))).code).toBe('AGENT_NOT_FOUND');
  });

  const T = '2026-11-18T20:00:00.000Z';
  // One reference per kind; each is added to an otherwise unreferenced revoked agent (Carol, id `a`, name `nm`).
  const KINDS: [label: string, add: (a: number, nm: string, p: number) => Promise<unknown>][] = [
    ['project membership', (a, _n, p) => env.DB.prepare(`INSERT INTO project_agents (project_id, agent_id) VALUES (?,?)`).bind(p, a).run()],
    ['messages sent', (a, nm, p) => env.DB.prepare(`INSERT INTO messages (project_id, sender_agent_id, sender_label, body, created_at) VALUES (?,?,?,?,?)`).bind(p, a, 'x', 'b', T).run()],
    ['messages sent', (_a, nm, p) => env.DB.prepare(`INSERT INTO messages (project_id, sender_label, body, created_at) VALUES (?,?,?,?)`).bind(p, nm, 'b', T).run()],
    ['message deliveries', (a) => env.DB.prepare(`INSERT INTO message_recipients (message_id, agent_id) VALUES (999, ?)`).bind(a).run()],
    ['holds', (a, _n, p) => env.DB.prepare(`INSERT INTO holds (project_id, kind, reason, placed_by_agent_id, placed_by_label, placed_at) VALUES (?,?,?,?,?,?)`).bind(p, 'advisory', 'r', a, 'x', T).run()],
    ['calendar events', (a, _n, p) => env.DB.prepare(`INSERT INTO events (project_id, title, starts_at, entered_as, kind, merger_agent_id, created_by, updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(p, 'e', T, 'UTC', 'merge', a, 'x', T).run()],
    ['calendar events', (_a, nm, p) => env.DB.prepare(`INSERT INTO events (project_id, title, starts_at, entered_as, kind, created_by, updated_at) VALUES (?,?,?,?,?,?,?)`).bind(p, 'e', T, 'UTC', 'note', nm, T).run()],
    ['approvals', (a) => env.DB.prepare(`INSERT INTO event_approvers (event_id, agent_id) VALUES (999, ?)`).bind(a).run()],
    ['to-dos', (_a, nm, p) => env.DB.prepare(`INSERT INTO todos (project_id, title, added_by, created_at) VALUES (?,?,?,?)`).bind(p, 't', nm, T).run()],
    ['scratchpad entries', (_a, nm, p) => env.DB.prepare(`INSERT INTO scratchpad_entries (project_id, author, body, created_at) VALUES (?,?,?,?)`).bind(p, nm, 'b', T).run()],
    ['documents', (_a, nm, p) => env.DB.prepare(`INSERT INTO documents (project_id, name, version, format, content, saved_by, created_at) VALUES (?,?,?,?,?,?,?)`).bind(p, 'd', 1, 'markdown', 'x', nm, T).run()],
    ['change log entries', (_a, nm, p) => env.DB.prepare(`INSERT INTO change_log (project_id, at, actor, kind) VALUES (?,?,?,?)`).bind(p, T, nm, 'todo.added').run()],
    ['change log entries', (a, _n, p) => env.DB.prepare(`INSERT INTO change_log (project_id, at, actor, kind, subject_id) VALUES (?,?,?,?,?)`).bind(p, T, 'admin', 'agent.revoked', a).run()],
  ];
  it.each(KINDS.map((k, i) => [i, k[0]] as const))('a lone reference (%i) of kind "%s" is named and blocks the delete', async (i, label) => {
    await orphanCarol();
    await KINDS[i]![1](s.carol.id, 'Carol', s.project.id);
    const before = await snapshot();
    const e = await rejects(adminDeleteAgent(ctx, s.carol.id));
    expect(e.code).toBe('AGENT_HAS_HISTORY');
    expect(e.message).toContain(label);
    expect(await snapshot()).toBe(before);
    expect(await n(`SELECT COUNT(*) AS n FROM agents WHERE id = ?`, s.carol.id)).toBe(1);
  });

  it('a time zone typed into an event is not mistaken for a reference to an agent named like it', async () => {
    await orphanCarol();
    await env.DB.prepare(`UPDATE agents SET name = 'UTC' WHERE id = ?`).bind(s.carol.id).run();
    await env.DB.prepare(`INSERT INTO events (project_id, title, starts_at, entered_as, kind, created_by, updated_at) VALUES (?,?,?,?,?,?,?)`).bind(s.project.id, 'e', T, 'UTC', 'note', 'someone', T).run();
    await adminDeleteAgent(ctx, s.carol.id);
    expect(await n(`SELECT COUNT(*) AS n FROM agents WHERE id = ?`, s.carol.id)).toBe(0);
  });
});

describe('admin routes', () => {
  async function archived(name = 'gone') {
    const id = (await env.DB.prepare(`INSERT INTO projects (name, created_at, archived_at) VALUES (?,?,?) RETURNING id`).bind(name, ctx.now(), ctx.now()).first<any>())!.id as number;
    await fill(id, s.carol.id, 'Carol', `acme/${name}`);
    return id;
  }

  it('POST /admin/p/:id/delete needs the cookie, a same Origin and the tick box', async () => {
    const id = await archived();
    const before = await snapshot();
    expect((await post(`/admin/p/${id}/delete`, null, { confirm: 'yes' })).status).toBe(403);
    expect((await post(`/admin/p/${id}/delete`, 'echo_admin=junk.' + '0'.repeat(64), { confirm: 'yes' })).status).toBe(403);
    expect((await post(`/admin/p/${id}/delete`, cookie, { confirm: 'yes' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await SELF.fetch(`${ORIGIN}/admin/p/${id}/delete`, { method: 'POST', redirect: 'manual', headers: { cookie }, body: new URLSearchParams({ confirm: 'yes' }) })).status).toBe(403);
    const noTick = await post(`/admin/p/${id}/delete`, cookie);
    expect(noTick.status).toBe(400);
    expect(await noTick.text()).toContain('CONFIRM_NEEDED');
    expect(await snapshot()).toBe(before);

    const ok = await post(`/admin/p/${id}/delete`, cookie, { confirm: 'yes' });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/admin');
    expect(await n(`SELECT COUNT(*) AS n FROM projects WHERE id = ?`, id)).toBe(0);
  });

  it('a project that is not archived is refused on the page', async () => {
    const before = await snapshot();
    const res = await post(`/admin/p/${s.other.id}/delete`, cookie, { confirm: 'yes' });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('PROJECT_NOT_ARCHIVED');
    expect(await snapshot()).toBe(before);
  });

  it('an archived project page shows Delete permanently; an active one does not', async () => {
    const id = await archived();
    const arch = await (await get(`/admin/p/${id}/settings`, cookie)).text();
    expect(arch).toContain('Delete permanently');
    expect(arch).toContain(`/admin/p/${id}/delete`);
    expect(arch).toMatch(/cannot be undone/i);
    const live = await (await get(`/admin/p/${s.other.id}/settings`, cookie)).text();
    expect(live).not.toContain('Delete permanently');
    expect(live).not.toContain(`/admin/p/${s.other.id}/delete`);
    await archiveProject(ctx, s.other.id);
    expect(await (await get(`/admin/p/${s.other.id}/settings`, cookie)).text()).toContain('Delete permanently');
  });

  it('a second delete of the same project renders the admin home with a banner, not an error page', async () => {
    const id = await archived();
    expect((await post(`/admin/p/${id}/delete`, cookie, { confirm: 'yes' })).status).toBe(303);
    const again = await post(`/admin/p/${id}/delete`, cookie, { confirm: 'yes' });
    expect(again.status).toBe(404);
    const text = await again.text();
    expect(text).toContain('already deleted');
    expect(text).toContain('All projects');
  });

  it('the project Agents page has no delete-agent form; a revoked agent gets a hint instead', async () => {
    await adminRevokeAgent(ctx, s.alice.id);
    const page = await (await get(`/admin/p/${s.project.id}/agents`, cookie)).text();
    expect(page).not.toContain('/delete');
    expect(page).not.toContain('Delete agent');
    expect(page).toContain('Delete it from the admin home once its projects are deleted.');
    expect(page).toContain(`/agents/${s.bob.id}/revoke`); // the active member still has Revoke
    expect(page).not.toContain(`/agents/${s.alice.id}/revoke`);
  });

  it('the home page keeps two columns: the revoked-agents panel is inside the aside, so .cols has two children', async () => {
    await adminRevokeAgent(ctx, s.carol.id);
    const page = await (await get('/admin', cookie)).text();
    const cols = page.slice(page.indexOf('<div class="cols">'));
    const aside = cols.slice(cols.indexOf('<aside>'), cols.indexOf('</aside>'));
    expect(aside).toContain('Revoked agents');
    expect(aside).toContain('New project');
    expect(cols.slice(0, cols.indexOf('<aside>'))).not.toContain('Revoked agents');
    // exactly two direct children: one section, then the aside
    expect(cols.slice(0, cols.indexOf('<aside>')).match(/<section class="panel">/g)).toHaveLength(1);
  });

  it('POST /admin/agents/:id/delete needs the cookie, a same Origin and the tick box; a refusal renders as a banner', async () => {
    await orphanCarol();
    const path = `/admin/agents/${s.carol.id}/delete`;
    const before = await snapshot();
    expect((await post(path, 'echo_admin=junk.' + '0'.repeat(64), { confirm: 'yes' })).status).toBe(403);
    expect((await post(path, cookie, { confirm: 'yes' }, { origin: 'https://evil.example' })).status).toBe(403);
    const noTick = await post(path, cookie);
    expect(noTick.status).toBe(400);
    expect(await noTick.text()).toContain('CONFIRM_NEEDED');
    expect(await snapshot()).toBe(before);

    const notRevoked = await post(`/admin/agents/${s.bob.id}/delete`, cookie, { confirm: 'yes' });
    expect(notRevoked.status).toBe(409);
    expect(await notRevoked.text()).toContain('AGENT_NOT_REVOKED');

    const index = await (await get('/admin', cookie)).text();
    expect(index).toContain(path);
    expect(index).toContain('Delete agent');

    const ok = await post(path, cookie, { confirm: 'yes' });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/admin');
    expect(await n(`SELECT COUNT(*) AS n FROM agents WHERE id = ?`, s.carol.id)).toBe(0);
  });
});
