import { Hono } from 'hono';
import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { makeCtx } from '../ctx';
import type { Ctx } from '../ctx';
import { adminCreateAgent, adminDeleteAgent, adminReissueToken, adminRevokeAgent, listAgents } from '../domain/agents';
import { adminApprove } from '../domain/approvals';
import { addEvent, cancelEvent, daySchedule, listEvents, updateEvent } from '../domain/calendar';
import type { Importance } from '../domain/calendar';
import { recentChanges } from '../domain/changelog';
import { adminAckHold, adminListHolds, adminReleaseHold } from '../domain/holds';
import { adminDeleteDocument, getDocument, listDocuments, listVersions } from '../domain/documents';
import type { Document } from '../domain/documents';
import { postNotice } from '../domain/escalation';
import { adminAckMessage, allMessages, pendingMessages, withdrawMessage } from '../domain/messages';
import {
  addMember,
  adminCreateProject,
  adminDeleteProject,
  archiveProject,
  getOwnerSetting,
  getProject,
  listProjects,
  projectMembers,
  registerRepo,
  removeMember,
  removeRepo,
  renameProject,
  repoStatusRows,
  setOwnerSetting,
  updateProjectSettings,
} from '../domain/projects';
import { adminClearScratchpad, adminEditEntry, readScratchpad } from '../domain/scratchpad';
import { adminClearTodoClaim, adminDeleteTodo, adminEditTodo, listTodos } from '../domain/todos';
import { addWebhook, checkWebhookUrl, listWebhooks, removeWebhook } from '../domain/webhooks';
import type { Actor } from '../types';
import { EchoError } from '../errors';
import { githubAppConfigured, kickStatusJobs } from '../github/status';
import { parseZonedTime } from '../time';
import { COOKIE, SESSION_MS, csp, makeSession, passwordOk, randomNonce, requireAdmin } from './auth';
import type { AdminEnv } from './auth';
import { chooseDay, dayOptions, dayRange, zoneFromCookieHeader } from './localtime';
import { loginPage, plainPage, projectPage, projectsPage, scheduleFragment, sectionPage } from './views';
import type { Section, SectionData, Shown } from './views';

export const admin = new Hono<AdminEnv>();

admin.use('*', async (c, next) => {
  const nonce = randomNonce();
  c.set('nonce', nonce);
  await next();
  c.header('Content-Security-Policy', csp(nonce));
  c.header('Cache-Control', 'no-store');
});

admin.use('*', (c, next) => requireAdmin(() => makeCtx(c.env).now())(c, next));

admin.onError((e, c) => {
  console.error('admin error', e);
  c.header('Content-Security-Policy', csp(c.get('nonce') ?? randomNonce()));
  return c.html(plainPage('Echo hit a problem', 'The page could not be built. Try again shortly.'), 500);
});

const ADMIN_NOTE = 'by the owner';

/** The viewer's zone from the echo_tz cookie, else Eastern. */
const zoneOf = (c: Context<AdminEnv>) => zoneFromCookieHeader(c.req.header('cookie'));

// ---------------------------------------------------------------- login

admin.get('/login', (c) => c.html(loginPage()));

admin.post('/login', async (c) => {
  const ctx = makeCtx(c.env);
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  if (c.env.LOGIN_LIMIT) {
    const { success } = await c.env.LOGIN_LIMIT.limit({ key: ip });
    if (!success) return c.html(plainPage('Too many attempts', 'Too many login attempts. Wait a minute and try again.'), 429);
  }
  const form = await c.req.parseBody();
  const password = typeof form.password === 'string' ? form.password : '';
  if (!(await passwordOk(c.env, password))) return c.html(loginPage('That password is not right.'), 401);
  setCookie(c, COOKIE, await makeSession(c.env, ctx.now()), {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/admin',
    maxAge: SESSION_MS / 1000,
  });
  return c.redirect('/admin', 303);
});

admin.post('/logout', (c) => {
  deleteCookie(c, COOKIE, { path: '/admin', secure: true });
  return c.redirect('/admin/login', 303);
});

// ---------------------------------------------------------------- pages

async function renderIndex(c: Context<AdminEnv>, ctx: Ctx, extra: { error?: string; notice?: string } = {}, status: ContentfulStatusCode = 200) {
  const failures = await ctx.db
    .prepare(
      `SELECT r.full_name AS repo, j.last_error AS error FROM status_jobs j JOIN repos r ON r.id = j.repo_id
       WHERE j.last_error IS NOT NULL ORDER BY r.full_name, j.pr_number`,
    )
    .all<{ repo: string; error: string }>();
  // One banner per repository, showing its first error.
  const byRepo = new Map<string, string>();
  for (const f of failures.results) if (!byRepo.has(f.repo)) byRepo.set(f.repo, f.error);
  const notify = await getOwnerSetting(ctx, 'notify_url');
  return c.html(
    projectsPage(
      await listProjects(ctx),
      (await listAgents(ctx)).filter((a) => a.revoked_at),
      notify,
      // Without the App nothing is written, so there are no write failures to show: the page says statuses are off.
      githubAppConfigured(ctx) ? [...byRepo].map(([repo, error]) => ({ repo, error })) : null,
      { ...extra, tz: zoneOf(c), nonce: c.get('nonce'), reload: c.req.method === 'GET', now: ctx.now() },
    ),
    status,
  );
}

admin.get('/', (c) => renderIndex(c, makeCtx(c.env)));

function idParam(c: Context<AdminEnv>): number | null {
  const n = Number(c.req.param('id'));
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function renderProject(c: Context<AdminEnv>, ctx: Ctx, projectId: number, error?: string, status: ContentfulStatusCode = 200) {
  const project = await getProject(ctx, projectId);
  const tz = zoneOf(c);
  const now = ctx.now();
  const days = dayOptions(Date.parse(now), tz);
  const day = chooseDay(c.req.query('day'), days);
  const range = dayRange(day.value, tz);
  const [holds, messages, agents, todos, changes, schedule] = await Promise.all([
    adminListHolds(ctx, projectId),
    pendingMessages(ctx, projectId),
    projectMembers(ctx, projectId),
    listTodos(ctx, { kind: 'admin' }, projectId, {}),
    recentChanges(ctx, projectId, 20),
    daySchedule(ctx, projectId, range.from, range.to),
  ]);
  return c.html(projectPage({ project, holds, messages, agents, todos, changes, now, nonce: c.get('nonce'), tz, reload: c.req.method === 'GET', schedule: day.today ? schedule : schedule.map((r) => ({ ...r, isNext: false })), days, day, error }), status);
}

function errorResponse(c: Context<AdminEnv>, e: EchoError) {
  return c.html(plainPage(e.code, `${e.message} ${e.fix}`), e.status as ContentfulStatusCode);
}

admin.get('/p/:id', async (c) => {
  const id = idParam(c);
  if (id === null) return c.html(plainPage('Not found', 'There is no such project.'), 404);
  try {
    return await renderProject(c, makeCtx(c.env), id);
  } catch (e) {
    if (e instanceof EchoError && e.kind === 'rule') return errorResponse(c, e);
    throw e;
  }
});

admin.get('/p/:id/schedule', async (c) => {
  const id = idParam(c);
  if (id === null) return c.text('Bad project id.', 400);
  let from: string;
  let to: string;
  try {
    from = parseZonedTime(c.req.query('from') ?? '').utc;
    to = parseZonedTime(c.req.query('to') ?? '').utc;
  } catch {
    return c.text('from and to must be ISO 8601 times with a zone.', 400);
  }
  const ctx = makeCtx(c.env);
  try {
    await getProject(ctx, id);
  } catch (e) {
    if (e instanceof EchoError && e.kind === 'rule') return c.text(e.message, e.status as ContentfulStatusCode);
    throw e;
  }
  return c.html(scheduleFragment(await daySchedule(ctx, id, from, to), zoneOf(c)));
});

// ---------------------------------------------------------------- actions

/** Back to the page the form was on, if that is a same-origin /admin page; otherwise the project list. */
function backTo(c: Context<AdminEnv>): string {
  const referer = c.req.header('referer');
  if (referer) {
    try {
      const u = new URL(referer);
      if (u.origin === new URL(c.req.url).origin && (u.pathname === '/admin' || u.pathname.startsWith('/admin/'))) {
        return u.pathname + u.search;
      }
    } catch {
      // fall through
    }
  }
  return '/admin';
}

async function projectIdOf(ctx: Ctx, table: 'holds' | 'messages' | 'events', id: number): Promise<number | null> {
  const row = await ctx.db.prepare(`SELECT project_id FROM ${table} WHERE id = ?`).bind(id).first<{ project_id: number }>();
  return row?.project_id ?? null;
}

/** Runs one admin change; on success redirects back and kicks the echo/hold status jobs, on a rule error shows the project page with the error. */
async function action(
  c: Context<AdminEnv>,
  table: 'holds' | 'messages' | 'events',
  run: (ctx: Ctx, id: number, form: Record<string, string>) => Promise<void>,
) {
  const ctx = makeCtx(c.env);
  const id = idParam(c);
  const projectId = id === null ? null : await projectIdOf(ctx, table, id);
  if (id === null || projectId === null) return c.html(plainPage('Not found', `There is no such ${table.slice(0, -1)}.`), 404);
  const body = await c.req.parseBody();
  const form: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === 'string') form[k] = v;
  try {
    await run(ctx, id, form);
  } catch (e) {
    if (e instanceof EchoError && e.kind === 'rule') {
      return renderProject(c, ctx, projectId, `${e.code}: ${e.message} ${e.fix}`, e.status as ContentfulStatusCode);
    }
    throw e;
  }
  kickStatusJobs(ctx, (p) => c.executionCtx.waitUntil(p));
  return c.redirect(backTo(c), 303);
}

const noteOf = (f: Record<string, string>) => f.note?.trim() || ADMIN_NOTE;

admin.post('/holds/:id/force-ack', (c) => action(c, 'holds', (ctx, id, f) => adminAckHold(ctx, id, noteOf(f))));
admin.post('/holds/:id/release', (c) => action(c, 'holds', (ctx, id, f) => adminReleaseHold(ctx, id, noteOf(f))));

admin.post('/messages/:id/force-ack', (c) =>
  action(c, 'messages', async (ctx, id, f) => {
    const agentId = Number(f.agent);
    if (!Number.isInteger(agentId) || agentId < 1) {
      throw new EchoError('rule', 'BAD_AGENT', 'No recipient was given.', 'Use the button next to the recipient.', 400);
    }
    await adminAckMessage(ctx, id, agentId);
  }),
);
admin.post('/messages/:id/withdraw', (c) => action(c, 'messages', (ctx, id) => withdrawMessage(ctx, { kind: 'admin' }, id)));

admin.post('/events/:id/approve', (c) =>
  action(c, 'events', async (ctx, id, f) => {
    if (!f.agent) throw new EchoError('rule', 'BAD_AGENT', 'No approver was given.', 'Use the button next to the approver.', 400);
    await adminApprove(ctx, id, f.agent);
  }),
);

// ---------------------------------------------------------------- project sub-pages

const SECTIONS: Section[] = ['messages', 'todos', 'calendar', 'scratchpad', 'documents', 'agents', 'repos', 'webhooks', 'settings'];
const ADMIN_ACTOR: Actor = { kind: 'admin' };
const EVERYTHING = { from: '1970-01-01T00:00:00Z', to: '2200-01-01T00:00:00Z' };

async function sectionData(ctx: Ctx, projectId: number, section: Section, open?: Document, showAll = false, rawOnly = false): Promise<SectionData> {
  switch (section) {
    case 'messages':
      return { section, lines: await allMessages(ctx, projectId) };
    case 'todos':
      return { section, todos: await listTodos(ctx, ADMIN_ACTOR, projectId, { includeDone: true }) };
    case 'calendar': {
      const all = await listEvents(ctx, ADMIN_ACTOR, { projectId, ...EVERYTHING });
      if (showAll) return { section, events: all, hidden: 0, showAll };
      // Pending: not cancelled, not merged and, for a plain event only, not started yet. A merge whose time passed
      // without merging stays, because it still needs attention.
      const now = ctx.now();
      const events = all.filter((e) => !e.cancelled && !e.mergedAt && (e.kind !== 'event' || e.startsAt >= now));
      return { section, events, hidden: all.length - events.length, showAll };
    }
    case 'scratchpad':
      return { section, entries: await readScratchpad(ctx, ADMIN_ACTOR, projectId, { limit: 500 }) };
    case 'documents': {
      const docs = await listDocuments(ctx, ADMIN_ACTOR, projectId);
      return {
        section,
        open,
        rawOnly,
        docs: await Promise.all(docs.map(async (info) => ({ info, versions: (await listVersions(ctx, ADMIN_ACTOR, projectId, info.name)).map((v) => v.version) }))),
      };
    }
    case 'agents': {
      const members = await projectMembers(ctx, projectId);
      const ids = new Set(members.map((m) => m.id));
      return { section, members, others: (await listAgents(ctx)).filter((a) => !ids.has(a.id)) };
    }
    case 'repos':
      return { section, repos: await repoStatusRows(ctx, projectId) };
    case 'webhooks':
      return { section, hooks: await listWebhooks(ctx, projectId) };
    case 'settings':
      return { section };
  }
}

/** The Calendar's "Show all" view is asked for by ?show=all; a form post sends it back in its Referer. */
function calendarShowAll(section: Section, url: string | null | undefined): boolean {
  if (section !== 'calendar' || !url) return false;
  try {
    return new URL(url, 'https://echo.invalid').searchParams.get('show') === 'all';
  } catch {
    return false;
  }
}

/** A calendar form post: the form's own URL carries show=all; the Referer is only a fallback. */
const postedShowAll = (c: Context<AdminEnv>, section: Section) =>
  calendarShowAll(section, c.req.url) || calendarShowAll(section, c.req.header('referer'));

async function renderSection(
  c: Context<AdminEnv>,
  ctx: Ctx,
  projectId: number,
  section: Section,
  o: { error?: string; shown?: Shown; status?: ContentfulStatusCode; open?: Document; showAll?: boolean; rawOnly?: boolean } = {},
) {
  const project = await getProject(ctx, projectId);
  const data = await sectionData(ctx, projectId, section, o.open, o.showAll, o.rawOnly);
  return c.html(sectionPage({ project, data, error: o.error, shown: o.shown, tz: zoneOf(c), nonce: c.get('nonce'), now: ctx.now(), reload: c.req.method === 'GET' }), o.status ?? 200);
}

for (const section of SECTIONS) {
  admin.get(`/p/:id/${section}`, async (c) => {
    const id = idParam(c);
    if (id === null) return c.html(plainPage('Not found', 'There is no such project.'), 404);
    try {
      return await renderSection(c, makeCtx(c.env), id, section, { showAll: calendarShowAll(section, c.req.url) });
    } catch (e) {
      if (e instanceof EchoError && e.kind === 'rule') return errorResponse(c, e);
      throw e;
    }
  });
}

admin.get('/p/:id/documents/:name', async (c) => {
  const id = idParam(c);
  if (id === null) return c.html(plainPage('Not found', 'There is no such project.'), 404);
  const versionText = c.req.query('version');
  const version = versionText === undefined ? undefined : Number(versionText);
  if (version !== undefined && (!Number.isInteger(version) || version < 1)) return c.html(plainPage('Bad request', 'The version must be a whole number.'), 400);
  const ctx = makeCtx(c.env);
  try {
    const open = await getDocument(ctx, ADMIN_ACTOR, id, c.req.param('name'), version);
    // ?raw=1 never calls the markdown renderer: the way back in for a document whose rendering is too slow or fails.
    return await renderSection(c, ctx, id, 'documents', { open, rawOnly: c.req.query('raw') === '1' });
  } catch (e) {
    if (e instanceof EchoError && e.kind === 'rule') return errorResponse(c, e);
    throw e;
  }
});

type Form = Record<string, string>;
/** A secret to show once: the action's response page is rendered directly, with no redirect. */
type Run = (ctx: Ctx, projectId: number, form: Form) => Promise<Shown | void>;

const needConfirm = (f: Form) => {
  if (f.confirm !== 'yes') {
    throw new EchoError('rule', 'CONFIRM_NEEDED', 'This cannot be undone, so it needs your confirmation.', 'Tick the confirmation box, then press the button again.', 400);
  }
};

function subId(c: Context<AdminEnv>, name = 'sid'): number {
  const n = Number(c.req.param(name));
  if (!Number.isInteger(n) || n < 1) throw new EchoError('rule', 'BAD_ID', 'That id is not valid.', 'Use the button on the page.', 400);
  return n;
}

async function readForm(c: Context<AdminEnv>): Promise<Form> {
  const body = await c.req.parseBody();
  const form: Form = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === 'string') form[k] = v;
  return form;
}

function projectGone(c: Context<AdminEnv>, ctx: Ctx) {
  return renderIndex(c, ctx, { error: 'PROJECT_NOT_FOUND: That project was not found (already deleted?). Pick a project from the list.' }, 404);
}

/**
 * Runs one admin change on a project's sub-page. On success it redirects back and kicks the status jobs;
 * a rule error re-renders the page with an escaped banner. An action that returns a secret skips the redirect:
 * the secret is in this one response, never in a URL, the Referer or a later page.
 */
async function act(c: Context<AdminEnv>, section: Section, run: Run, o: { confirm?: boolean; to?: (projectId: number, result: unknown) => string } = {}) {
  const ctx = makeCtx(c.env);
  const projectId = idParam(c);
  if (projectId === null) return c.html(plainPage('Not found', 'There is no such project.'), 404);
  try {
    await getProject(ctx, projectId);
  } catch (e) {
    if (e instanceof EchoError && e.code === 'PROJECT_NOT_FOUND') return projectGone(c, ctx);
    if (e instanceof EchoError && e.kind === 'rule') return errorResponse(c, e);
    throw e;
  }
  const form = await readForm(c);
  let shown: Shown | void;
  try {
    if (o.confirm) needConfirm(form);
    shown = await run(ctx, projectId, form);
  } catch (e) {
    // Two clicks on a delete: the project can vanish between the check above and the action.
    if (e instanceof EchoError && e.code === 'PROJECT_NOT_FOUND') return projectGone(c, ctx);
    if (e instanceof EchoError && e.kind === 'rule') {
      return renderSection(c, ctx, projectId, section, { error: `${e.code}: ${e.message} ${e.fix}`, status: e.status as ContentfulStatusCode, showAll: postedShowAll(c, section) });
    }
    throw e;
  }
  if (shown) return renderSection(c, ctx, projectId, section, { shown, showAll: postedShowAll(c, section) });
  kickStatusJobs(ctx, (p) => c.executionCtx.waitUntil(p));
  return c.redirect(o.to ? o.to(projectId, shown) : backTo(c), 303);
}

const intOf = (s: string | undefined) => (s === undefined || s.trim() === '' ? undefined : Number(s));

// to-dos
admin.post('/p/:id/todos/:sid/edit', (c) => act(c, 'todos', (ctx, projectId, f) => adminEditTodo(ctx, subId(c), f.title ?? '', projectId)));
admin.post('/p/:id/todos/:sid/clear-claim', (c) => act(c, 'todos', (ctx, projectId) => adminClearTodoClaim(ctx, subId(c), projectId)));
admin.post('/p/:id/todos/:sid/delete', (c) => act(c, 'todos', (ctx, projectId) => adminDeleteTodo(ctx, subId(c), projectId), { confirm: true }));

// calendar: success goes back to the Calendar page in the view the form came from
const calendarAct = (c: Context<AdminEnv>, run: Run) =>
  act(c, 'calendar', run, { to: (projectId) => `/admin/p/${projectId}/calendar${postedShowAll(c, 'calendar') ? '?show=all' : ''}` });
admin.post('/p/:id/events', (c) =>
  calendarAct(c, async (ctx, projectId, f) => {
    if (!f.title?.trim()) throw new EchoError('rule', 'BAD_TITLE', 'An event needs a title.', 'Give a short title.', 400);
    const merge = !!f.repo?.trim();
    await addEvent(ctx, ADMIN_ACTOR, {
      projectId,
      title: f.title.trim(),
      startsAt: f.starts_at ?? '',
      importance: (f.importance as Importance | undefined) || undefined,
      ...(merge
        ? {
            kind: 'merge',
            repo: f.repo!.trim(),
            pr: intOf(f.pr),
            merger: f.merger?.trim() || undefined,
            approvers: f.approvers?.split(',').map((a) => a.trim()).filter(Boolean),
          }
        : {}),
    });
  }),
);
admin.post('/p/:id/events/:sid/move', (c) => calendarAct(c, async (ctx, projectId, f) => void (await updateEvent(ctx, ADMIN_ACTOR, subId(c), { startsAt: f.starts_at ?? '' }, projectId))));
admin.post('/p/:id/events/:sid/cancel', (c) => calendarAct(c, (ctx, projectId) => cancelEvent(ctx, ADMIN_ACTOR, subId(c), projectId)));

// scratchpad
admin.post('/p/:id/scratchpad/clear', (c) => act(c, 'scratchpad', (ctx, projectId) => adminClearScratchpad(ctx, projectId), { confirm: true }));
admin.post('/p/:id/scratchpad/:sid/edit', (c) => act(c, 'scratchpad', (ctx, projectId, f) => adminEditEntry(ctx, subId(c), f.body ?? '', projectId)));

// documents
admin.post('/p/:id/documents/delete', (c) => act(c, 'documents', (ctx, projectId, f) => adminDeleteDocument(ctx, projectId, f.name ?? ''), { confirm: true }));

// agents and tokens
const TOKEN_NOTE = 'Copy it now. It is not stored in a recoverable form, and no other page or log will show it again.';
admin.post('/p/:id/agents', (c) =>
  act(c, 'agents', async (ctx, projectId, f) => {
    const { agent, token } = await adminCreateAgent(ctx, projectId, f.name ?? '');
    return { title: `Token for ${agent.name} (shown once)`, secret: token, note: TOKEN_NOTE };
  }),
);
admin.post('/p/:id/agents/assign', (c) => act(c, 'agents', (ctx, projectId, f) => addMember(ctx, ADMIN_ACTOR, projectId, Number(f.agent))));
admin.post('/p/:id/agents/:sid/unassign', (c) => act(c, 'agents', (ctx, projectId) => removeMember(ctx, ADMIN_ACTOR, projectId, subId(c))));
/** The agent must belong to this project, so a button on one project's page cannot act on another project's agent. */
async function requireMemberOf(ctx: Ctx, projectId: number, agentId: number): Promise<void> {
  const row = await ctx.db.prepare(`SELECT 1 AS x FROM project_agents WHERE project_id = ? AND agent_id = ?`).bind(projectId, agentId).first();
  if (!row) throw new EchoError('rule', 'NOT_MEMBER', `Agent ${agentId} is not in this project.`, 'Use the buttons on the page of a project the agent belongs to.', 404);
}

admin.post('/p/:id/agents/:sid/reissue', (c) =>
  act(c, 'agents', async (ctx, projectId) => {
    const agentId = subId(c);
    await requireMemberOf(ctx, projectId, agentId);
    const token = await adminReissueToken(ctx, agentId);
    const a = await ctx.db.prepare(`SELECT name FROM agents WHERE id = ?`).bind(agentId).first<{ name: string }>();
    return { title: `New token for ${a?.name ?? 'the agent'} (shown once)`, secret: token, note: `The old token no longer works. ${TOKEN_NOTE}` };
  }, { confirm: true }),
);
admin.post('/p/:id/agents/:sid/revoke', (c) =>
  act(c, 'agents', async (ctx, projectId) => {
    await requireMemberOf(ctx, projectId, subId(c));
    await adminRevokeAgent(ctx, subId(c));
  }, { confirm: true }),
);

// repositories
admin.post('/p/:id/repos', (c) => act(c, 'repos', async (ctx, projectId, f) => void (await registerRepo(ctx, ADMIN_ACTOR, projectId, f.repo ?? ''))));
admin.post('/p/:id/repos/:sid/remove', (c) =>
  act(c, 'repos', async (ctx, projectId) => {
    const repo = await ctx.db.prepare(`SELECT project_id FROM repos WHERE id = ?`).bind(subId(c)).first<{ project_id: number }>();
    if (repo && repo.project_id !== projectId) {
      throw new EchoError('rule', 'REPO_OTHER_PROJECT', 'That repository belongs to a different project.', 'Use the Repositories page of its own project.', 404);
    }
    await removeRepo(ctx, ADMIN_ACTOR, subId(c));
  }, { confirm: true }),
);

// webhooks
admin.post('/p/:id/webhooks', (c) =>
  act(c, 'webhooks', async (ctx, projectId, f) => {
    const { secret } = await addWebhook(ctx, projectId, (f.url ?? '').trim());
    return { title: 'Signing secret (shown once)', secret, note: 'Echo signs each request with HMAC-SHA256 of the body using this secret, in X-Echo-Signature. It will not be shown again.' };
  }),
);
admin.post('/p/:id/webhooks/:sid/remove', (c) => act(c, 'webhooks', (ctx, projectId) => removeWebhook(ctx, subId(c), projectId)));

// settings, rename, archive
admin.post('/p/:id/settings', (c) =>
  act(c, 'settings', (ctx, projectId, f) =>
    updateProjectSettings(ctx, projectId, { approvalsRequired: f.approvals === 'on', approvalWindowMin: intOf(f.window) }),
  ),
);
admin.post('/p/:id/rename', (c) => act(c, 'settings', (ctx, projectId, f) => renameProject(ctx, projectId, f.name ?? '')));
admin.post('/p/:id/archive', (c) => act(c, 'settings', (ctx, projectId) => archiveProject(ctx, projectId), { confirm: true, to: () => '/admin' }));
// Permanent: the project must be archived first (adminDeleteProject refuses otherwise).
admin.post('/p/:id/delete', (c) => act(c, 'settings', (ctx, projectId) => adminDeleteProject(ctx, projectId), { confirm: true, to: () => '/admin' }));

// ---------------------------------------------------------------- across projects

async function indexAction(c: Context<AdminEnv>, run: (ctx: Ctx, form: Form) => Promise<{ notice?: string; to?: string } | void>) {
  const ctx = makeCtx(c.env);
  const form = await readForm(c);
  try {
    const r = await run(ctx, form);
    if (r?.notice) return renderIndex(c, ctx, { notice: r.notice });
    kickStatusJobs(ctx, (p) => c.executionCtx.waitUntil(p));
    return c.redirect(r?.to ?? '/admin', 303);
  } catch (e) {
    if (e instanceof EchoError && e.kind === 'rule') {
      return renderIndex(c, ctx, { error: `${e.code}: ${e.message} ${e.fix}` }, e.status as ContentfulStatusCode);
    }
    throw e;
  }
}

admin.post('/agents/:id/delete', (c) =>
  indexAction(c, async (ctx, f) => {
    needConfirm(f);
    const id = idParam(c);
    if (id === null) throw new EchoError('rule', 'BAD_ID', 'That id is not valid.', 'Use the button on the page.', 400);
    await adminDeleteAgent(ctx, id);
  }),
);

admin.post('/projects', (c) => indexAction(c, async (ctx, f) => ({ to: `/admin/p/${(await adminCreateProject(ctx, f.name ?? '')).id}` })));

admin.post('/settings/notify-url', (c) =>
  indexAction(c, async (ctx, f) => {
    const url = (f.url ?? '').trim();
    if (url) checkWebhookUrl(url, 'notification address', 'BAD_NOTIFY_URL');
    await setOwnerSetting(ctx, 'notify_url', url || null);
  }),
);

admin.post('/settings/test-notify', (c) =>
  indexAction(c, async (ctx) => {
    const url = await getOwnerSetting(ctx, 'notify_url');
    if (!url) throw new EchoError('rule', 'NO_NOTIFY_URL', 'No notification address is set, so there is nowhere to send a test.', 'Save a notification address first.', 400);
    let res: Response;
    try {
      res = await postNotice((input, init) => fetch(input, init), url, {
        title: 'Echo: test notification',
        click: `${ctx.env.PUBLIC_URL}/admin`,
        body: 'This is a test from the Echo admin page. If you can read it, notifications work.',
      });
    } catch (e) {
      throw new EchoError('rule', 'NOTIFY_FAILED', `The test notification could not be sent: ${e instanceof Error ? e.message : String(e)}.`, 'Check the notification address.', 502);
    }
    if (!res.ok) {
      throw new EchoError('rule', 'NOTIFY_REJECTED', `The notification address answered HTTP ${res.status}.`, 'Check the notification address.', 502);
    }
    return { notice: `Test notification sent (HTTP ${res.status}).` };
  }),
);
