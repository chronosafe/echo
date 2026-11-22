import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { admin } from '../src/admin/routes';
import { makeSession } from '../src/admin/auth';
import { authenticate, createAgent } from '../src/domain/agents';
import { mergeDecision } from '../src/domain/approvals';
import { addEvent } from '../src/domain/calendar';
import { changesSince } from '../src/domain/changelog';
import { placeHold, releaseHold } from '../src/domain/holds';
import { saveDocument } from '../src/domain/documents';
import { sendMessage } from '../src/domain/messages';
import { agentProjects, gatedRepos } from '../src/domain/projects';
import { appendScratchpad } from '../src/domain/scratchpad';
import { addWebhook } from '../src/domain/webhooks';
import { addTodo, claimTodo } from '../src/domain/todos';
import { runStatusJobs } from '../src/github/status';
import { fakeGithub } from './fake-github';
import { resetInstallationTokens } from '../src/github/app';
import { fakeNet, seed, testCtx } from './helpers';

const app = new Hono().route('/admin', admin);
const ORIGIN = 'https://echo.test';
const ctx = testCtx();
let ip = 100;

async function sessionCookie(): Promise<string> {
  const res = await SELF.fetch(`${ORIGIN}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': `10.1.0.${++ip}` },
    body: new URLSearchParams({ password: 'correct horse' }),
  });
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

const get = (path: string, cookie: string) => SELF.fetch(`${ORIGIN}${path}`, { redirect: 'manual', headers: { cookie } });
const post = (path: string, cookie: string, form: Record<string, string> = {}) =>
  SELF.fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams(form),
  });

let s: Awaited<ReturnType<typeof seed>>;
let cookie: string;
let P: string;
beforeEach(async () => {
  ctx.setNow(new Date().toISOString());
  s = await seed(ctx);
  cookie = await sessionCookie();
  P = `/admin/p/${s.project.id}`;
});

const logKinds = async () => (await changesSince(ctx, s.project.id, 0)).map((c) => `${c.actor}:${c.kind}`);

describe('agents and tokens', () => {
  it('creating an agent shows the token once; no later page contains it', async () => {
    const res = await post(`${P}/agents`, cookie, { name: 'Dana' });
    expect(res.status).toBe(200); // rendered directly: no redirect, so the token is in no URL or Referer
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.text();
    const token = body.match(/echo_[A-Za-z0-9_-]{43}/)?.[0];
    expect(token).toBeTruthy();
    expect(body).toMatch(/shown once/i);

    // the token really works, and the agent joined the project
    const agent = await authenticate(ctx, `Bearer ${token}`);
    expect(agent.name).toBe('Dana');
    expect((await agentProjects(ctx, agent.id)).map((p) => p.id)).toEqual([s.project.id]);

    for (const path of [`${P}/agents`, P, '/admin', `${P}/settings`, `${P}/messages`, `${P}/webhooks`, `${P}/repos`]) {
      const page = await get(path, cookie);
      expect(page.status, path).toBe(200);
      expect(page.headers.get('cache-control')).toBe('no-store');
      expect(await page.text(), path).not.toContain(token);
    }
    // the token is not in the change log either, and the entry is by admin
    const log = JSON.stringify(await changesSince(ctx, s.project.id, 0));
    expect(log).not.toContain(token);
    expect(await logKinds()).toContain('admin:member.added');
  });

  it('reissue shows the new token once and kills the old one; revoke needs confirm=yes', async () => {
    const dana = await createAgent(ctx, 'Dana');
    await ctx.db.prepare(`INSERT INTO project_agents (project_id, agent_id) VALUES (?,?)`).bind(s.project.id, dana.agent.id).run();
    const unconfirmed = await post(`${P}/agents/${dana.agent.id}/reissue`, cookie);
    expect(unconfirmed.status).toBe(400);
    expect(await unconfirmed.text()).toContain('CONFIRM_NEEDED');
    expect((await authenticate(ctx, `Bearer ${dana.token}`)).name).toBe('Dana'); // untouched
    const res = await post(`${P}/agents/${dana.agent.id}/reissue`, cookie, { confirm: 'yes' });
    expect(res.status).toBe(200);
    const token = (await res.text()).match(/echo_[A-Za-z0-9_-]{43}/)![0];
    expect(token).not.toBe(dana.token);
    await expect(authenticate(ctx, `Bearer ${dana.token}`)).rejects.toMatchObject({ code: 'BAD_TOKEN' });
    expect((await authenticate(ctx, `Bearer ${token}`)).name).toBe('Dana');
    expect(await (await get(`${P}/agents`, cookie)).text()).not.toContain(token);

    const noConfirm = await post(`${P}/agents/${dana.agent.id}/revoke`, cookie);
    expect(noConfirm.status).toBe(400);
    expect(await noConfirm.text()).toContain('CONFIRM_NEEDED');
    expect((await authenticate(ctx, `Bearer ${token}`)).name).toBe('Dana');
    const ok = await post(`${P}/agents/${dana.agent.id}/revoke`, cookie, { confirm: 'yes' });
    expect(ok.status).toBe(303);
    await expect(authenticate(ctx, `Bearer ${token}`)).rejects.toMatchObject({ code: 'BAD_TOKEN' });
    const kinds = await logKinds();
    expect(kinds).toContain('admin:agent.reissued');
    expect(kinds).toContain('admin:agent.revoked');
  });

  it('reissue and revoke refuse an agent that is not in the project, and a revoked agent is labelled', async () => {
    for (const action of ['reissue', 'revoke']) {
      const res = await post(`${P}/agents/${s.carol.id}/${action}`, cookie, { confirm: 'yes' });
      expect(res.status, action).toBe(404);
      expect(await res.text()).toContain('NOT_MEMBER');
    }
    expect((await authenticate(ctx, `Bearer ${s.carol.token}`)).name).toBe('Carol');
    await post(`${P}/agents/${s.bob.id}/revoke`, cookie, { confirm: 'yes' });
    expect(await (await get(`${P}/agents`, cookie)).text()).toContain('Reissue token (re-enables this agent)');
  });

  it('assigns an existing agent to the project; a duplicate name shows an escaped banner', async () => {
    const res = await post(`${P}/agents/assign`, cookie, { agent: String(s.carol.id) });
    expect(res.status).toBe(303);
    expect((await agentProjects(ctx, s.carol.id)).map((p) => p.id).sort()).toContain(s.project.id);
    const dup = await post(`${P}/agents`, cookie, { name: '<i>Alice</i>' });
    expect(dup.status).toBe(200); // a new agent whose name is escaped on the page
    const html = await dup.text();
    expect(html).not.toContain('<i>Alice</i>');
    expect(html).toContain('&lt;i&gt;Alice&lt;/i&gt;');
    const taken = await post(`${P}/agents`, cookie, { name: 'Alice' });
    expect(taken.status).toBe(409);
    expect(await taken.text()).toContain('NAME_TAKEN');
  });
});

describe('settings and approvals', () => {
  it('turning approvals on makes an unscheduled merge-check return no_slot', async () => {
    expect((await mergeDecision(ctx, 'acme/app', 5)).allowed).toBe(true);
    const res = await post(`${P}/settings`, cookie, { approvals: 'on', window: '45' });
    expect(res.status).toBe(303);
    const d = await mergeDecision(ctx, 'acme/app', 5);
    expect(d.allowed).toBe(false);
    expect(d.blocks.map((b) => b.kind)).toContain('no_slot');
    const row = await ctx.db.prepare(`SELECT approvals_required, approval_window_min FROM projects WHERE id = ?`).bind(s.project.id).first<any>();
    expect(row).toEqual({ approvals_required: 1, approval_window_min: 45 });
    expect(await logKinds()).toContain('admin:project.updated');
    // off again: an absent checkbox means off
    await post(`${P}/settings`, cookie, { window: '45' });
    expect((await mergeDecision(ctx, 'acme/app', 5)).allowed).toBe(true);
  });

  it('a bad window shows an escaped error banner and changes nothing', async () => {
    const res = await post(`${P}/settings`, cookie, { approvals: 'on', window: '3' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('BAD_WINDOW');
    const res2 = await post(`${P}/settings`, cookie, { approvals: 'on', window: 'abc' });
    expect(res2.status).toBe(400);
    const row = await ctx.db.prepare(`SELECT approvals_required, approval_window_min FROM projects WHERE id = ?`).bind(s.project.id).first<any>();
    expect(row).toEqual({ approvals_required: 0, approval_window_min: 30 });
  });
});

describe('repositories', () => {
  it('the repository page shows a GitHub status error recorded by runStatusJobs', async () => {
    const gh = fakeGithub();
    resetInstallationTokens();
    await ctx.db.prepare(`UPDATE repos SET installation_id = 77 WHERE id = ?`).bind(s.repo.id).run();
    await ctx.db.prepare(`INSERT INTO pr_heads (repo_id, pr_number, head_sha, open, updated_at) VALUES (?,?,?,1,?)`).bind(s.repo.id, 5, 'sha5', ctx.now()).run();
    gh.pulls.set('acme/app#5', { head: 'sha5', state: 'open', mergedAt: null });
    gh.fail(1000);
    const pem = await newPem();
    const c2 = { ...ctx, env: { ...env, GITHUB_API_URL: 'https://gh.test', GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: pem } };
    await ctx.db.prepare(`INSERT INTO status_jobs (repo_id, pr_number, attempts, next_attempt_at) VALUES (?,?,0,?)`).bind(s.repo.id, 5, ctx.now()).run();
    await ctx.db.prepare(`INSERT INTO owner_settings (key, value) VALUES ('status_reconcile_at', ?)`).bind(new Date().toISOString()).run();
    expect(await (await get(`${P}/repos`, cookie)).text()).toContain('acme/app');
    await runStatusJobs(c2, gh.fetch);
    const job = await ctx.db.prepare(`SELECT last_error FROM status_jobs WHERE repo_id = ?`).bind(s.repo.id).first<{ last_error: string | null }>();
    expect(job?.last_error).toBeTruthy();
    const html = await (await get(`${P}/repos`, cookie)).text();
    const escaped = job!.last_error!.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    expect(html).toContain(escaped);
    expect(html).toMatch(/yes/i); // the App is installed
  });

  it('the remove form warns about the required echo/hold check', async () => {
    const html = await (await get(`${P}/repos`, cookie)).text();
    expect(html).toContain('If echo/hold is a required check in GitHub, remove it from the branch rules too, or open PRs keep their last status.');
    expect(html).toContain('name="confirm" value="yes"');
    // another project's repo cannot be removed through this project's page
    const other = await ctx.db.prepare(`INSERT INTO repos (full_name, project_id) VALUES ('acme/other', ?) RETURNING id`).bind(s.other.id).first<{ id: number }>();
    const res = await post(`${P}/repos/${other!.id}/remove`, cookie, { confirm: 'yes' });
    expect(res.status).toBe(404);
    expect(await gatedRepos(ctx)).toContain('acme/other');
  });

  it('shows installed yes/no and the latest commit status time and result', async () => {
    let html = await (await get(`${P}/repos`, cookie)).text();
    expect(html).toContain('acme/app');
    expect(html).toContain('App installed: no');
    await ctx.db.prepare(`UPDATE repos SET installation_id = 9 WHERE id = ?`).bind(s.repo.id).run();
    await ctx.db.prepare(`INSERT INTO commit_statuses (repo_id, sha, state, description, updated_at) VALUES (?,?,?,?,?)`).bind(s.repo.id, 'a', 'failure', 'd', '2026-11-18T10:00:00.000Z').run();
    await ctx.db.prepare(`INSERT INTO commit_statuses (repo_id, sha, state, description, updated_at) VALUES (?,?,?,?,?)`).bind(s.repo.id, 'b', 'success', 'd', '2026-11-18T11:00:00.000Z').run();
    html = await (await get(`${P}/repos`, cookie)).text();
    expect(html).toContain('App installed: yes');
    expect(html).toContain('2026-11-18T11:00:00.000Z');
    expect(html).toContain('success');
    expect(html).not.toContain('2026-11-18T10:00:00.000Z');
  });

  it('adds and removes a repository, lowercased, with change-log entries by admin', async () => {
    const res = await post(`${P}/repos`, cookie, { repo: 'Acme/Tool' });
    expect(res.status).toBe(303);
    expect(await gatedRepos(ctx)).toContain('acme/tool');
    const bad = await post(`${P}/repos`, cookie, { repo: 'nonsense' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('BAD_REPO');
    const id = (await ctx.db.prepare(`SELECT id FROM repos WHERE full_name = 'acme/tool'`).first<{ id: number }>())!.id;
    const unconfirmed = await post(`${P}/repos/${id}/remove`, cookie);
    expect(unconfirmed.status).toBe(400);
    expect(await unconfirmed.text()).toContain('CONFIRM_NEEDED');
    expect(await gatedRepos(ctx)).toContain('acme/tool');
    expect((await post(`${P}/repos/${id}/remove`, cookie, { confirm: 'yes' })).status).toBe(303);
    expect(await gatedRepos(ctx)).not.toContain('acme/tool');
    const kinds = await logKinds();
    expect(kinds).toContain('admin:repo.registered');
    expect(kinds).toContain('admin:repo.removed');
  });

  it('the remove confirmation says open holds and merge events must be closed first', async () => {
    const html = await (await get(`${P}/repos`, cookie)).text();
    expect(html).toContain('A repository with open holds or open merge events cannot be removed');
  });
});

describe('projects', () => {
  it('archiving is refused while a repository is registered, and allowed after it is removed; gating is unchanged', async () => {
    await addTodo(ctx, s.aliceA, s.project.id, 'keep me');
    await sendMessage(ctx, s.aliceA, { projectId: s.project.id, to: 'Bob', body: 'still here', requiresAck: false });
    const hold = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 5, reason: 'bad' });
    const before = await mergeDecision(ctx, 'acme/app', 5);
    expect(before.allowed).toBe(false);

    const noConfirm = await post(`${P}/archive`, cookie);
    expect(noConfirm.status).toBe(400);
    expect(await noConfirm.text()).toContain('CONFIRM_NEEDED');

    const refused = await post(`${P}/archive`, cookie, { confirm: 'yes' });
    expect(refused.status).toBe(409);
    const text = await refused.text();
    expect(text).toContain('ARCHIVE_HAS_REPOS');
    expect(text).toContain('Remove this project&#39;s repositories first; registered repositories stay gated.');
    expect((await ctx.db.prepare(`SELECT archived_at FROM projects WHERE id = ?`).bind(s.project.id).first<any>()).archived_at).toBeNull();
    expect(await mergeDecision(ctx, 'acme/app', 5)).toEqual(before);
    expect(await gatedRepos(ctx)).toContain('acme/app');

    // The open hold keeps the repository registered until it is released.
    const blocked = await post(`${P}/repos/${s.repo.id}/remove`, cookie, { confirm: 'yes' });
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).toContain('REPO_HAS_OPEN_ITEMS');
    await releaseHold(ctx, s.alice.id, hold.id, 'done');
    expect((await post(`${P}/repos/${s.repo.id}/remove`, cookie, { confirm: 'yes' })).status).toBe(303);
    expect((await agentProjects(ctx, s.alice.id)).map((p) => p.name)).toContain('core');
    const res = await post(`${P}/archive`, cookie, { confirm: 'yes' });
    expect(res.status).toBe(303);
    expect((await agentProjects(ctx, s.alice.id)).map((p) => p.name)).not.toContain('core'); // hidden from whoami
    expect((await ctx.db.prepare(`SELECT COUNT(*) AS n FROM todos WHERE project_id = ?`).bind(s.project.id).first<any>()).n).toBe(1);
    expect((await ctx.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE project_id = ?`).bind(s.project.id).first<any>()).n).toBeGreaterThanOrEqual(1);
    expect(await logKinds()).toContain('admin:project.updated');
  });

  it('registering a repository on an archived project is refused, and the page hides the add form', async () => {
    await post(`${P}/repos/${s.repo.id}/remove`, cookie, { confirm: 'yes' });
    await post(`${P}/archive`, cookie, { confirm: 'yes' });
    const res = await post(`${P}/repos`, cookie, { repo: 'acme/new' });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('PROJECT_ARCHIVED');
    expect(await gatedRepos(ctx)).not.toContain('acme/new');
    expect(await (await get(`${P}/repos`, cookie)).text()).not.toContain('Add repository');
  });

  it('the archive form says registered repositories block archiving', async () => {
    const html = await (await get(`${P}/settings`, cookie)).text();
    expect(html).toMatch(/registered repositories stay gated/i);
    expect(html).toContain('name="confirm" value="yes"');
  });

  it('creates and renames projects; a taken name shows a banner', async () => {
    const res = await post('/admin/projects', cookie, { name: 'fresh' });
    expect(res.status).toBe(303);
    const row = await ctx.db.prepare(`SELECT id FROM projects WHERE name = 'fresh'`).first<{ id: number }>();
    expect(row).toBeTruthy();
    expect((await changesSince(ctx, row!.id, 0)).map((c) => `${c.actor}:${c.kind}`)).toEqual(['admin:project.updated']);
    const dup = await post('/admin/projects', cookie, { name: 'fresh' });
    expect(dup.status).toBe(409);
    expect(await dup.text()).toContain('NAME_TAKEN');
    expect((await post(`${P}/rename`, cookie, { name: 'core2' })).status).toBe(303);
    expect((await ctx.db.prepare(`SELECT name FROM projects WHERE id = ?`).bind(s.project.id).first<any>()).name).toBe('core2');
  });
});

describe('notifications', () => {
  async function sendTest(net = fakeNet()) {
    const e = { ...env, PUBLIC_URL: ORIGIN };
    const c = `echo_admin=${await makeSession(e, new Date().toISOString())}`;
    const ec = { waitUntil() {}, passThroughOnException() {} } as any;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(net.fetch);
    try {
      const res = await app.request(
        `${ORIGIN}/admin/settings/test-notify`,
        { method: 'POST', headers: { origin: ORIGIN, cookie: c, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams() },
        e,
        ec,
      );
      return { res, text: await res.text(), net };
    } finally {
      spy.mockRestore();
    }
  }

  it('the test notification POSTs to notify_url', async () => {
    const set = await post('/admin/settings/notify-url', cookie, { url: 'https://ntfy.example/echo' });
    expect(set.status).toBe(303);
    const { res, text, net } = await sendTest();
    expect(res.status).toBe(200);
    expect(text).toContain('sent (HTTP 200)');
    expect(net.requests).toHaveLength(1);
    expect(net.requests[0]!.url).toBe('https://ntfy.example/echo');
    expect(net.requests[0]!.method).toBe('POST');
    expect(net.requests[0]!.headers['title']).toMatch(/Echo/);
    expect(net.requests[0]!.body).toMatch(/test/i);
  });

  it('shows the failure when the endpoint rejects, and an escaped error when no notify_url is set', async () => {
    await ctx.db.prepare(`DELETE FROM owner_settings WHERE key = 'notify_url'`).run();
    const none = await sendTest();
    expect(none.net.requests).toHaveLength(0);
    expect(none.res.status).toBe(400);
    expect(none.text).toContain('NO_NOTIFY_URL');

    await ctx.db.prepare(`INSERT INTO owner_settings (key, value) VALUES ('notify_url', 'https://ntfy.example/x')`).run();
    const rejected = await sendTest(fakeNet(() => 503));
    expect(rejected.res.status).toBe(502);
    expect(rejected.text).toContain('HTTP 503');
    expect(rejected.text).not.toContain('sent (HTTP');
  });

  it('notify_url must be https, or http only for localhost and 127.0.0.1; empty clears it', async () => {
    for (const bad of ['http://ntfy.example/x', 'ftp://x/y', 'not a url']) {
      const res = await post('/admin/settings/notify-url', cookie, { url: bad });
      expect(res.status, bad).toBe(400);
      expect(await res.text()).toContain('BAD_NOTIFY_URL');
    }
    expect((await post('/admin/settings/notify-url', cookie, { url: 'http://127.0.0.1:8787/x' })).status).toBe(303);
    expect((await post('/admin/settings/notify-url', cookie, { url: 'http://localhost/x' })).status).toBe(303);
    expect((await post('/admin/settings/notify-url', cookie, { url: '' })).status).toBe(303);
    expect(await ctx.db.prepare(`SELECT value FROM owner_settings WHERE key = 'notify_url'`).first<any>()).toEqual({ value: null });
  });
});

describe('webhooks', () => {
  it('shows the secret once, never again, and removing stops the hook', async () => {
    const res = await post(`${P}/webhooks`, cookie, { url: 'https://hooks.example/echo' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const secret = (await res.text()).match(/\b[0-9a-f]{64}\b/)?.[0];
    expect(secret).toBeTruthy();
    const stored = await ctx.db.prepare(`SELECT id, secret FROM webhooks WHERE project_id = ?`).bind(s.project.id).first<any>();
    expect(stored.secret).toBe(secret);
    for (const path of [`${P}/webhooks`, P, '/admin']) expect(await (await get(path, cookie)).text()).not.toContain(secret!);
    expect(JSON.stringify(await changesSince(ctx, s.project.id, 0))).not.toContain(secret!);
    const page = await (await get(`${P}/webhooks`, cookie)).text();
    expect(page).toContain('https://hooks.example/echo');

    const bad = await post(`${P}/webhooks`, cookie, { url: 'http://hooks.example/echo' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('BAD_WEBHOOK_URL');

    expect((await post(`${P}/webhooks/${stored.id}/remove`, cookie)).status).toBe(303);
    expect((await ctx.db.prepare(`SELECT disabled_at FROM webhooks WHERE id = ?`).bind(stored.id).first<any>()).disabled_at).not.toBeNull();
    expect(await logKinds()).toEqual(expect.arrayContaining(['admin:webhook.added', 'admin:webhook.removed']));
  });
});

describe('content', () => {
  it('lists all messages with every recipient, escaped', async () => {
    await sendMessage(ctx, s.aliceA, { projectId: s.project.id, to: 'all', body: '<script>alert(1)</script>', requiresAck: false });
    const html = await (await get(`${P}/messages`, cookie)).text();
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Bob');
  });

  it('edits and deletes a to-do; delete needs confirm=yes', async () => {
    const t = await addTodo(ctx, s.aliceA, s.project.id, 'old');
    expect((await post(`${P}/todos/${t.id}/edit`, cookie, { title: 'new <b>' })).status).toBe(303);
    const html = await (await get(`${P}/todos`, cookie)).text();
    expect(html).toContain('new &lt;b&gt;');
    const no = await post(`${P}/todos/${t.id}/delete`, cookie);
    expect(no.status).toBe(400);
    expect(await no.text()).toContain('CONFIRM_NEEDED');
    expect((await post(`${P}/todos/${t.id}/delete`, cookie, { confirm: 'yes' })).status).toBe(303);
    expect(await ctx.db.prepare(`SELECT id FROM todos WHERE id = ?`).bind(t.id).first()).toBeNull();
    expect(await logKinds()).toEqual(expect.arrayContaining(['admin:todo.edited', 'admin:todo.deleted']));
    expect((await post(`${P}/todos/${t.id}/delete`, cookie, { confirm: 'yes' })).status).toBe(404);
  });

  it('clears a to-do claim as admin: button only on claimed open to-dos, logged as admin, needs cookie and Origin', async () => {
    const t = await addTodo(ctx, s.aliceA, s.project.id, 'held');
    expect(await (await get(`${P}/todos`, cookie)).text()).not.toContain('/clear-claim');
    await claimTodo(ctx, s.bobA, t.id);
    expect(await (await get(`${P}/todos`, cookie)).text()).toContain(`${P}/todos/${t.id}/clear-claim`);
    const path = `${P}/todos/${t.id}/clear-claim`;
    expect((await SELF.fetch(`${ORIGIN}${path}`, { method: 'POST', redirect: 'manual', headers: { origin: ORIGIN } })).status).toBe(403);
    const evil = await SELF.fetch(`${ORIGIN}${path}`, { method: 'POST', redirect: 'manual', headers: { origin: 'https://evil.example', cookie } });
    expect(evil.status).toBe(403);
    expect((await ctx.db.prepare(`SELECT claimed_by FROM todos WHERE id = ?`).bind(t.id).first<any>()).claimed_by).toBe('Bob');
    expect(await logKinds()).not.toContain('admin:todo.released');
    expect((await post(path, cookie)).status).toBe(303);
    expect((await ctx.db.prepare(`SELECT claimed_by FROM todos WHERE id = ?`).bind(t.id).first<any>()).claimed_by).toBeNull();
    expect(await logKinds()).toContain('admin:todo.released');
    const again = await post(path, cookie);
    expect(again.status).toBe(409);
    expect(await again.text()).toContain('TODO_NOT_CLAIMED');
    expect((await logKinds()).filter((k) => k === 'admin:todo.released')).toHaveLength(1);
    expect(await (await get(`${P}/todos`, cookie)).text()).not.toContain('/clear-claim');
  });

  it('an admin route refuses an item that belongs to another project: 404, nothing changes, nothing is logged', async () => {
    const o = s.other.id;
    const todo = await addTodo(ctx, s.carolA, o, 'theirs');
    await claimTodo(ctx, s.carolA, todo.id);
    const ev = await addEvent(ctx, s.carolA, { projectId: o, title: 'theirs', startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    const entry = await appendScratchpad(ctx, s.carolA, o, 'theirs');
    const hook = await addWebhook(ctx, o, 'https://hooks.test/theirs');
    const state = async () =>
      JSON.stringify(
        await Promise.all(
          ['todos', 'events', 'scratchpad_entries', 'webhooks', 'change_log'].map(async (t) => (await ctx.db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()).results),
        ),
      );
    const before = await state();
    const routes: [string, Record<string, string>][] = [
      [`todos/${todo.id}/edit`, { title: 'hijacked' }],
      [`todos/${todo.id}/clear-claim`, {}],
      [`todos/${todo.id}/delete`, { confirm: 'yes' }],
      [`events/${ev.id}/move`, { starts_at: '2030-01-01T00:00:00Z' }],
      [`events/${ev.id}/cancel`, {}],
      [`scratchpad/${entry.id}/edit`, { body: 'hijacked' }],
      [`webhooks/${hook.id}/remove`, {}],
    ];
    for (const [path, form] of routes) {
      const res = await post(`${P}/${path}`, cookie, form);
      expect(res.status, path).toBe(404);
      expect(await state(), path).toBe(before);
    }
  });

  it('adds, moves and cancels a calendar event; a zoneless time is refused', async () => {
    const add = await post(`${P}/events`, cookie, { title: 'Release', starts_at: '2026-12-01T21:00:00-06:00', importance: 'high' });
    expect(add.status).toBe(303);
    const ev = await ctx.db.prepare(`SELECT id, starts_at, entered_as FROM events WHERE title = 'Release'`).first<any>();
    expect(ev.starts_at).toBe('2026-12-02T03:00:00.000Z');
    expect(ev.entered_as).toBe('2026-12-01T21:00:00-06:00');
    const zoneless = await post(`${P}/events`, cookie, { title: 'x', starts_at: '2026-12-01T21:00:00' });
    expect(zoneless.status).toBe(400);
    expect(await (await get(`${P}/calendar?show=all`, cookie)).text()).toContain('Release');
    expect((await post(`${P}/events/${ev.id}/move`, cookie, { starts_at: '2026-12-03T10:00:00Z' })).status).toBe(303);
    expect((await ctx.db.prepare(`SELECT starts_at FROM events WHERE id = ?`).bind(ev.id).first<any>()).starts_at).toBe('2026-12-03T10:00:00.000Z');
    expect((await post(`${P}/events/${ev.id}/cancel`, cookie)).status).toBe(303);
    expect((await ctx.db.prepare(`SELECT cancelled_at FROM events WHERE id = ?`).bind(ev.id).first<any>()).cancelled_at).not.toBeNull();
    expect(await logKinds()).toEqual(expect.arrayContaining(['admin:event.added', 'admin:event.moved', 'admin:event.cancelled']));
  });

  describe('calendar pending filter', () => {
    const HOUR = 3_600_000;
    const at = (h: number) => new Date(Date.now() + h * HOUR).toISOString();
    const TITLES = ['PastPlain', 'FuturePlain', 'CancelledPlain', 'FutureMerge', 'OverdueMerge', 'MergedMerge', 'CancelledMerge'];
    const shown = (page: string) => TITLES.filter((t) => page.includes(`>${t}`)).sort();

    async function fill() {
      const plain = (title: string, h: number) => addEvent(ctx, s.aliceA, { projectId: s.project.id, title, startsAt: at(h) });
      const merge = (title: string, h: number, pr: number) =>
        addEvent(ctx, s.aliceA, { projectId: s.project.id, title, startsAt: at(h), kind: 'merge', repo: 'acme/app', pr });
      await plain('PastPlain', -48);
      await plain('FuturePlain', 48);
      const cp = await plain('CancelledPlain', 24);
      await merge('FutureMerge', 48, 11);
      await merge('OverdueMerge', -48, 12);
      const mm = await merge('MergedMerge', 24, 13);
      const cm = await merge('CancelledMerge', 24, 14);
      await ctx.db.prepare(`UPDATE events SET cancelled_at = ? WHERE id IN (?, ?)`).bind(ctx.now(), cp.id, cm.id).run();
      await ctx.db.prepare(`UPDATE events SET merged_at = ?, merged_by = 'x' WHERE id = ?`).bind(ctx.now(), mm.id).run();
    }

    it('shows only pending entries by default and says how many are hidden', async () => {
      await fill();
      const page = await (await get(`${P}/calendar`, cookie)).text();
      expect(shown(page)).toEqual(['FuturePlain', 'FutureMerge', 'OverdueMerge'].sort());
      expect(page).toContain('4 past or closed entries hidden');
      expect(page).toContain(`${P}/calendar?show=all`);
    });

    it('show=all lists everything and links back to the default', async () => {
      await fill();
      const page = await (await get(`${P}/calendar?show=all`, cookie)).text();
      expect(shown(page)).toEqual([...TITLES].sort());
      expect(page).not.toContain('hidden.');
      expect(page).toContain(`href="${P}/calendar"`);
    });

    it('says "1 past or closed entry hidden" in the singular', async () => {
      await addEvent(ctx, s.aliceA, { projectId: s.project.id, title: 'PastPlain', startsAt: at(-5) });
      expect(await (await get(`${P}/calendar`, cookie)).text()).toContain('1 past or closed entry hidden');
    });

    it('a refused action keeps the Show all view, and a plain page does not leak it', async () => {
      await fill();
      const past = await ctx.db.prepare(`SELECT id FROM events WHERE title = 'PastPlain'`).first<any>();
      const move = (referer: string) =>
        SELF.fetch(`${ORIGIN}${P}/events/${past.id}/move`, {
          method: 'POST',
          redirect: 'manual',
          headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie, referer },
          body: new URLSearchParams({ starts_at: 'not a time' }),
        });
      const all = await move(`${ORIGIN}${P}/calendar?show=all`);
      expect(all.status).toBe(400);
      expect(shown(await all.text())).toEqual([...TITLES].sort());
      const plain = await move(`${ORIGIN}${P}/calendar`);
      expect(plain.status).toBe(400);
      expect(shown(await plain.text())).not.toContain('PastPlain');
      // On success the redirect goes back to the same view.
      const ok = await SELF.fetch(`${ORIGIN}${P}/events/${past.id}/cancel`, {
        method: 'POST',
        redirect: 'manual',
        headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie, referer: `${ORIGIN}${P}/calendar?show=all` },
        body: new URLSearchParams(),
      });
      expect(ok.status).toBe(303);
      expect(ok.headers.get('location')).toContain('show=all');
    });

    it('two refusals in a row from the Show all view both stay on it, and success returns to the Calendar', async () => {
      await fill();
      const past = await ctx.db.prepare(`SELECT id FROM events WHERE title = 'PastPlain'`).first<any>();
      const submit = (url: string, referer: string, form: Record<string, string>) =>
        SELF.fetch(`${ORIGIN}${url}`, {
          method: 'POST',
          redirect: 'manual',
          headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie, referer },
          body: new URLSearchParams(form),
        });
      // The browser posts to the form's own action and sends the page it is on as the Referer.
      const actionOf = (page: string, re: RegExp) => page.match(re)![1]!.replace(/&amp;/g, '&');
      const moveRe = new RegExp(`action="(${P}/events/${past.id}/move[^"]*)"`);
      let page = await (await get(`${P}/calendar?show=all`, cookie)).text();
      let from = `${ORIGIN}${P}/calendar?show=all`;
      for (let i = 0; i < 3; i++) {
        const url = actionOf(page, moveRe);
        expect(url, `refusal ${i}`).toContain('show=all');
        const res = await submit(url, from, { starts_at: 'not a time' });
        expect(res.status).toBe(400);
        page = await res.text();
        expect(shown(page), `refusal ${i}`).toEqual([...TITLES].sort());
        from = `${ORIGIN}${url}`;
      }
      // Add and Cancel forms carry it too, and a refused Add stays on Show all.
      expect(page).toMatch(new RegExp(`action="${P}/events\\?show=all"`));
      expect(page).toMatch(new RegExp(`action="${P}/events/${past.id}/cancel\\?show=all"`));
      const add = await submit(`${P}/events?show=all`, from, { title: '', starts_at: at(1) });
      expect(add.status).toBe(400);
      expect(shown(await add.text())).toEqual([...TITLES].sort());
      // After refusals, a successful action goes back to the Calendar page itself, not the POST URL.
      const ok = await submit(actionOf(page, new RegExp(`action="(${P}/events/${past.id}/cancel[^"]*)"`)), from, {});
      expect(ok.status).toBe(303);
      expect(ok.headers.get('location')).toBe(`${P}/calendar?show=all`);
    });

    describe('a move posted to ?show=all with no Referer header (the form URL alone carries the view)', () => {
      const moveNoReferer = async (starts_at: string) => {
        await fill();
        const past = await ctx.db.prepare(`SELECT id FROM events WHERE title = 'PastPlain'`).first<any>();
        return SELF.fetch(`${ORIGIN}${P}/events/${past.id}/move?show=all`, {
          method: 'POST',
          redirect: 'manual',
          headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie },
          body: new URLSearchParams({ starts_at }),
        });
      };

      it('a refusal renders the 400 page with every entry, including cancelled, merged and past', async () => {
        const res = await moveNoReferer('not a time');
        expect(res.status).toBe(400);
        const page = await res.text();
        expect(shown(page)).toEqual([...TITLES].sort());
        expect(page).not.toContain('hidden.');
      });

      it('a success redirects to the Calendar with show=all', async () => {
        const res = await moveNoReferer(at(72));
        expect(res.status).toBe(303);
        expect(res.headers.get('location')).toBe(`${P}/calendar?show=all`);
      });
    });

    it('the default view puts no show=all in its forms, and a refusal there stays on the default view', async () => {
      await fill();
      const page = await (await get(`${P}/calendar`, cookie)).text();
      expect(page).not.toMatch(/events[^"]*show=all"/);
      const futurePlain = await ctx.db.prepare(`SELECT id FROM events WHERE title = 'FuturePlain'`).first<any>();
      const res = await SELF.fetch(`${ORIGIN}${P}/events/${futurePlain.id}/move`, {
        method: 'POST', redirect: 'manual',
        headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie, referer: `${ORIGIN}${P}/calendar` },
        body: new URLSearchParams({ starts_at: 'bad' }),
      });
      expect(res.status).toBe(400);
      expect(shown(await res.text())).toEqual(['FuturePlain', 'FutureMerge', 'OverdueMerge'].sort());
    });

    it('says so when nothing is hidden, and an unknown show value is the default view', async () => {
      await addEvent(ctx, s.aliceA, { projectId: s.project.id, title: 'FuturePlain', startsAt: at(5) });
      const page = await (await get(`${P}/calendar?show=nope`, cookie)).text();
      expect(page).toContain('0 past or closed entries hidden');
      expect(shown(page)).toEqual(['FuturePlain']);
    });
  });

  it('adds a merge event for a repository PR with approvers', async () => {
    await ctx.db.prepare(`UPDATE projects SET approvals_required = 1 WHERE id = ?`).bind(s.project.id).run();
    const res = await post(`${P}/events`, cookie, {
      title: 'merge 9', starts_at: new Date(Date.now() + 3_600_000).toISOString(), repo: 'acme/app', pr: '9', merger: 'Alice', approvers: 'Bob',
    });
    expect(res.status).toBe(303);
    const row = await ctx.db.prepare(`SELECT kind, pr_number FROM events WHERE title = 'merge 9'`).first<any>();
    expect(row).toEqual({ kind: 'merge', pr_number: 9 });
  });

  it('edits a scratchpad entry and clears all with confirm; bodies are escaped', async () => {
    const e = await appendScratchpad(ctx, s.aliceA, s.project.id, 'first <i>x</i>');
    await appendScratchpad(ctx, s.bobA, s.project.id, 'second');
    expect(await (await get(`${P}/scratchpad`, cookie)).text()).toContain('first &lt;i&gt;x&lt;/i&gt;');
    expect((await post(`${P}/scratchpad/${e.id}/edit`, cookie, { body: 'edited' })).status).toBe(303);
    expect((await ctx.db.prepare(`SELECT body, edited_at FROM scratchpad_entries WHERE id = ?`).bind(e.id).first<any>()).body).toBe('edited');
    const no = await post(`${P}/scratchpad/clear`, cookie);
    expect(no.status).toBe(400);
    expect((await ctx.db.prepare(`SELECT COUNT(*) AS n FROM scratchpad_entries`).first<any>()).n).toBe(2);
    expect((await post(`${P}/scratchpad/clear`, cookie, { confirm: 'yes' })).status).toBe(303);
    expect((await ctx.db.prepare(`SELECT COUNT(*) AS n FROM scratchpad_entries`).first<any>()).n).toBe(0);
    expect(await logKinds()).toEqual(expect.arrayContaining(['admin:scratchpad.edited', 'admin:scratchpad.cleared']));
  });

  it('shows document versions inside <pre>, escaped, and deletes with confirm', async () => {
    await saveDocument(ctx, s.aliceA, { projectId: s.project.id, name: 'notes.md', format: 'markdown', content: 'v1 <script>x</script>' });
    await saveDocument(ctx, s.aliceA, { projectId: s.project.id, name: 'notes.md', format: 'markdown', content: 'v2 body' });
    const list = await (await get(`${P}/documents`, cookie)).text();
    expect(list).toContain('notes.md');
    const v1 = await (await get(`${P}/documents/notes.md?version=1`, cookie)).text();
    expect(v1).toMatch(/<pre[^>]*>\n?v1 &lt;script&gt;x&lt;\/script&gt;<\/pre>/);
    expect(v1).not.toContain('<script>x');
    const latest = await (await get(`${P}/documents/notes.md`, cookie)).text();
    expect(latest).toContain('v2 body');
    expect((await get(`${P}/documents/missing.md`, cookie)).status).toBe(404);

    expect((await post(`${P}/documents/delete`, cookie, { name: 'notes.md' })).status).toBe(400);
    expect((await ctx.db.prepare(`SELECT COUNT(*) AS n FROM documents`).first<any>()).n).toBe(2);
    expect((await post(`${P}/documents/delete`, cookie, { name: 'notes.md', confirm: 'yes' })).status).toBe(303);
    expect((await ctx.db.prepare(`SELECT COUNT(*) AS n FROM documents`).first<any>()).n).toBe(0);
    expect(await logKinds()).toContain('admin:document.deleted');
  });

  it('every new page needs a login and every new POST needs a session', async () => {
    for (const path of ['messages', 'todos', 'calendar', 'scratchpad', 'documents', 'agents', 'repos', 'webhooks', 'settings']) {
      const r = await SELF.fetch(`${ORIGIN}${P}/${path}`, { redirect: 'manual' });
      expect(r.status, path).toBe(303);
    }
    const r = await SELF.fetch(`${ORIGIN}${P}/archive`, {
      method: 'POST', redirect: 'manual', headers: { origin: ORIGIN }, body: new URLSearchParams({ confirm: 'yes' }),
    });
    expect(r.status).toBe(403);
    expect((await get(`/admin/p/99999/todos`, cookie)).status).toBe(404);
  });
});

async function newPem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  let bin = '';
  for (const b of der) bin += String.fromCharCode(b);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(bin).match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
}
