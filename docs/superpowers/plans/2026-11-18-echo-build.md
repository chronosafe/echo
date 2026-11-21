# Echo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Echo, a Cloudflare Worker with a D1 database. It gives Claude Code orchestrating agents durable, acknowledged messaging; PR holds and per-project merge approvals, enforced by a Claude Code hook and by a required GitHub `echo/hold` status; escalation to the owner; shared project items; and an admin page.

**Architecture:** There are two packages in one repository.

`service/` is a single Worker. Its HTTP routes are:

| Route | Serves |
|---|---|
| `/mcp` | a stateless `createMcpHandler` |
| `/api/v1/*` | the JSON API the hooks call |
| `/github/webhook` | events from the GitHub App |
| `/admin/*` | server-rendered HTML |

An every-minute cron trigger runs the outgoing webhooks, escalations, approval-window status refreshes and GitHub status retries. Every domain module takes a `Ctx` holding the D1 handle, a clock and configuration. One function, `mergeDecision`, decides whether a PR may merge now, and it feeds both the hook API and the GitHub status.

`hooks/` is a dependency-free Node CLI, bundled into one file, that Claude Code runs for each hook event. It reads the orchestrator's token from the macOS Keychain or a 0600 file, and talks to the API and to the local `gh`.

**Tech Stack:** TypeScript (strict), Cloudflare Workers, D1, Wrangler, Hono (routing and `hono/html`), `agents` (`createMcpHandler`), `@modelcontextprotocol/server` v2, zod 4 (at least 4.5.0), Web Crypto (HMAC, SHA-256, RS256 for the GitHub App JWT), Vitest with `@cloudflare/vitest-pool-workers` for the service, Vitest on Node for the hooks, esbuild for the hook bundle.

**Spec:** `docs/superpowers/specs/2026-11-18-echo-agent-comms-design.md`, revision 2, approved 2026-11-18. Read it before any task. Section numbers below refer to it. The review behind revision 2 is `docs/superpowers/specs/2026-11-18-echo-design-review.md`.

## Global Constraints

- **MCP endpoint:** use `createMcpHandler` from `agents/mcp/server`, with a server factory that builds a fresh server per request. Never use `McpAgent`, and add no Durable Objects. Streamable HTTP only. Pin `@modelcontextprotocol/server` to the exact version the installed `agents` release requires.
- **Data:** all of it lives in D1. Large values (message bodies, documents) are always passed as bound parameters, never inlined into SQL text.
- **Times:** every stored time comes from `ctx.now()` on the Worker, in UTC ISO-8601 (spec 6.11). No API, MCP tool or hook request carries a timestamp for a record, with three exceptions:
  - A calendar event's `starts_at` is chosen by the agent. It must carry `Z` or an explicit offset, and the original string is stored alongside.
  - Deferral and escalation are given as minutes from now, never as absolute times.
  - Merge times come from GitHub.
- **Repository names:** always normalized to lowercase `owner/name`, in the service and in the hooks.
- **Limits:**
  - message body and scratchpad entry: 8,192 bytes of UTF-8 (`MAX_MESSAGE_BYTES = 8192`)
  - document: 1,048,576 bytes (`MAX_DOCUMENT_BYTES = 1048576`), with the last 50 versions kept (`DOC_VERSIONS_KEPT = 50`)
  - hook polling after tool calls: at most once per 30 s (`POLL_INTERVAL_MS = 30000`)
  - the merge check: never throttled
  - default approval window: ±30 minutes (`DEFAULT_APPROVAL_WINDOW_MIN = 30`)
  - approval request escalation: 30 minutes (`APPROVAL_ESCALATE_MIN = 30`)
  - override lifetime: 30 minutes (`OVERRIDE_TTL_MS = 1800000`)
- **Errors:** every error is either a rule error (the caller's request broke a rule) or a service error (Echo had a problem). The kind, a stable code, a message and a "what to do" line are always present (spec section 7).
- **Indexes:** every column the hook API or the cron filters on is indexed. `agents.last_checked_in_at` is **not** indexed.
- **Merge check:** fails closed for gated repositories. In gated repositories `--auto` and `--admin` are refused, and a queued merge is undone with `--disable-auto` (spec 6.5).
- **Message hooks:** they run only when `ECHO_AGENT` is set and the hook input has no `agent_id` (spec 6.2). The merge check runs in every session.
- **Tokens:** never written in plain text to `settings.json`, `.mcp.json`, `~/.claude.json` or `~/.echo/config.json`. They live in the macOS Keychain (service `echo`, account = agent name) or in `~/.echo/tokens/<name>` with mode 0600 (spec 6.2).
- **Override:** the emergency override is read only from the hook process's own environment (`ECHO_MERGE_OVERRIDE`), never from the Bash command text.
- **Hooks runtime:** Node 20 or later plus `gh`. No runtime npm dependencies in the bundle.
- **Launchers:** no dependency on any particular launcher or chat tool.
- **GitHub API base:** the Worker reads it from `env.GITHUB_API_URL` (default `https://api.github.com`), so tests and the e2e run use a fake.
- **Owner's accounts:** do not create, deploy to, or modify anything in the owner's Cloudflare or GitHub accounts before Task 20, and only with the owner's go-ahead at that point. All earlier work runs locally (Miniflare / `wrangler dev`, with a fake GitHub API).

## Review Focus

1. **Merge commands that aren't a bare `gh pr merge`.** Examples: `cd ../other && gh pr merge 5`, `gh pr merge https://github.com/O/R/pull/5`, `gh pr merge 5 -R O/R`, `GH_REPO=o/r gh pr merge 5`, `gh pr merge 5 --admin`, `bash -c 'gh pr merge 5'`, and `echo "gh pr merge"`. Expected: each real merge is checked against the right repository and PR, in the right directory. `--admin` is refused in gated repositories. Any command that contains `gh pr merge` but can't be parsed cleanly is refused, never allowed. Tests: Task 13.
2. **One merge reported twice.** The after-merge hook and GitHub's `pull_request` closed event can both report the same merge, in either order. Expected: exactly one schedule row, marked merged once, with GitHub's merge time. Tests: Task 5 and Task 11.
3. **Window edges and time zones.** For a slot at 21:00 local, an approved merge must be allowed at exactly 20:30:00 and at 21:30:00, and refused at 21:30:01. A slot entered as `2026-11-18T21:00:00-06:00` is stored as `2026-11-19T03:00:00Z`, and it appears in the admin page's 2026-11-18 schedule for a browser in that zone. A `starts_at` with no zone is refused. Tests: Tasks 5 and 6.
4. **Repository name case.** A hold placed on `Acme/App` must block `gh pr merge` on `acme/app`, and the same holds for GitHub webhook payloads, which arrive in GitHub's own case. Tests: Tasks 2, 4 and 11.
5. **Two actors closing the same hold at once.** Two releases race, or a release races an advisory acknowledgment. Expected: exactly one succeeds. The other gets a rule error naming who closed the hold and when, not a service error. Tests: Task 4.

---

## File Structure

```
package.json                     npm workspaces: service, hooks; root scripts
service/
  package.json  tsconfig.json  vitest.config.ts  wrangler.jsonc
  migrations/0001_init.sql       every table and index
  src/index.ts                   fetch router + scheduled handler
  src/env.ts                     Env bindings type
  src/ctx.ts                     Ctx { db, now, env }, makeCtx(env)
  src/errors.ts                  EchoError, ruleError(), serviceError(), errorJson()
  src/types.ts                   Actor and view types shared by domain modules
  src/time.ts                    parseZonedTime(), addMinutes()
  src/domain/changelog.ts
  src/domain/agents.ts           tokens, authentication, check-in
  src/domain/projects.ts         projects, settings, membership, repositories, owner settings
  src/domain/messages.ts         send, deliver, defer, ack, status, escalation fields
  src/domain/holds.ts            blocking and advisory holds
  src/domain/calendar.ts         events, merge recording, day schedule
  src/domain/approvals.ts        approvers, approve, object, mergeDecision()
  src/domain/todos.ts
  src/domain/scratchpad.ts
  src/domain/documents.ts
  src/domain/escalation.ts       owner notifications (cron)
  src/domain/webhooks.ts         outgoing webhooks (cron)
  src/github/app.ts              App JWT, installation tokens, REST calls
  src/github/status.ts           status jobs: enqueue, compute, write, retry
  src/github/webhook.ts          /github/webhook receiver
  src/api/hooks.ts               /api/v1/*
  src/mcp/server.ts  src/mcp/tools.ts  src/mcp/result.ts
  src/admin/auth.ts  src/admin/routes.ts  src/admin/views.ts
  test/setup.ts  test/helpers.ts  test/fake-github.ts  test/*.test.ts
hooks/
  package.json  tsconfig.json  vitest.config.ts  build.mjs
  src/main.ts                    argv[2] dispatch; never throws to Claude Code
  src/input.ts  src/config.ts  src/token-store.ts  src/client.ts  src/state.ts
  src/parse-merge.ts  src/resolve-pr.ts
  src/merge-pre.ts  src/merge-post.ts  src/messages.ts  src/format.ts
  src/install.ts                 install, token, set-token subcommands
  test/fixtures/bin/{gh,security}  test/fake-server.ts  test/*.test.ts
docs/agent-instructions.md       CLAUDE.md block for agents (spec 10.4)
docs/setup.md                    owner setup notes (spec 10.5)
docs/rollout.md                  spec section 13, as a checklist
scripts/e2e.mjs                  spec section 11 scenarios against wrangler dev
scripts/fake-github.mjs          stand-alone fake GitHub API for e2e
```

---

### Task 1: Service scaffold, schema, errors, time, test harness

**Files:**
- Create: `package.json`, `service/{package.json,tsconfig.json,vitest.config.ts,wrangler.jsonc}`, `service/migrations/0001_init.sql`, `service/src/{index,env,ctx,errors,types,time}.ts`, `service/test/{setup,helpers,fake-github}.ts`, `service/test/foundation.test.ts`

**Interfaces:**
- Produces:
  - `Env { DB: D1Database; ADMIN_PASSWORD: string; SESSION_SECRET: string; PUBLIC_URL: string; ALLOWED_HOSTNAMES?: string; GITHUB_API_URL?: string; GITHUB_APP_ID?: string; GITHUB_APP_PRIVATE_KEY?: string; GITHUB_WEBHOOK_SECRET?: string; LOGIN_LIMIT?: RateLimit }`
  - `type Ctx = { db: D1Database; now: () => string; env: Env }` and `makeCtx(env: Env): Ctx`
  - `class EchoError extends Error { kind: 'rule' | 'service'; code: string; fix: string; status: number }`
  - `ruleError(code, message, fix, status = 400)`
  - `serviceError(code, message)`, with status 503 and the fix "Your request was not applied. Retry shortly; if it keeps failing, tell the owner."
  - `errorJson(e: unknown): { ok: false; error: { kind; code; message; fix } }`, which maps any non-`EchoError` to a service error with code `INTERNAL`
  - `type Actor = { kind: 'agent'; agentId: number; name: string } | { kind: 'admin' } | { kind: 'system'; name: 'Echo' | 'github' }` and `actorLabel(a: Actor): string`, which gives the agent name, `admin`, `Echo` or `github`
  - `parseZonedTime(s: string): { utc: string; enteredAs: string }`. It throws the rule error `TIME_NEEDS_ZONE` when `s` lacks `Z` or a `±HH:MM` offset, and `BAD_TIME` when `s` is unparseable.
  - `addMinutes(iso: string, n: number): string`
  - test helpers:
    - `testCtx(now = '2026-11-18T20:00:00.000Z')` returns a `Ctx` whose clock tests can move with `ctx.setNow(iso)`.
    - `seed(ctx)` returns `{ project, other, alice, bob, carol, repo, aliceA, bobA, carolA }`. Alice and Bob are in `project` (approvals off), and Carol is in `other`. `repo` is `acme/app`, registered to `project`. Each agent comes with its `token`, and `*A` is the agent's `Actor`.
    - `seedApprovals(ctx)` does the same with `project.approvals_required = 1`.
  - `fake-github.ts`: `fakeGithub()` returns `{ fetch: typeof fetch; statuses: { repo; sha; state; description }[]; pulls: Map<string, { head: string; state: string; mergedAt: string | null }>; fail(n: number): void }`. Domain code receives it through `ctx.env.GITHUB_API_URL` plus a `fetchFn` parameter.

- [ ] **Step 1: Scaffold.**
  - Root `package.json`: workspaces `service` and `hooks`; scripts `test` and `e2e`.
  - In `service`, install these, all pinned exactly: `wrangler`, `@cloudflare/vitest-pool-workers`, `vitest`, `typescript`, `@cloudflare/workers-types`, `hono`, `agents`, `@modelcontextprotocol/server` (the version `agents` requires) and `zod`.
  - `wrangler.jsonc`:
    - `main: src/index.ts`, a current `compatibility_date`, `compatibility_flags: ["nodejs_compat"]`
    - the D1 binding `DB` with `migrations_dir: "migrations"`
    - `triggers.crons: ["* * * * *"]`
    - the `vars` `PUBLIC_URL` and `GITHUB_API_URL`
    - a `ratelimits` binding `LOGIN_LIMIT` (5 per 60 s)
  - Vitest: the workers pool, with `readD1Migrations` passed in and applied in `test/setup.ts`.

- [ ] **Step 2: Write `migrations/0001_init.sql`.** Every `*_at` column is TEXT holding UTC ISO.
  - `projects(id, name UNIQUE, approvals_required INTEGER DEFAULT 0, approval_window_min INTEGER DEFAULT 30, archived_at, created_at)`
  - `owner_settings(key PRIMARY KEY, value)`, for `notify_url`
  - `agents(id, name UNIQUE, token_hash UNIQUE, revoked_at, last_checked_in_at, created_at)`
  - `project_agents(project_id, agent_id, PRIMARY KEY(project_id, agent_id))`
  - `repos(id, full_name UNIQUE, project_id, installation_id, last_status_ok, last_status_error, last_status_at)`
  - `messages(id, project_id, sender_agent_id, sender_label, body, requires_ack, escalate_at, kind CHECK(kind IN ('plain','hold','approval_request','system')), ref_id, withdrawn_at, created_at)`
  - `message_recipients(message_id, agent_id, delivered_at, deferred_until, defer_reason, acked_at, ack_note, acked_by, escalated_at, PRIMARY KEY(message_id, agent_id))`
  - `holds(id, project_id, target_kind CHECK(target_kind IN ('pr','gate')) DEFAULT 'pr', repo_id, pr_number, gate_name, kind CHECK(kind IN ('blocking','advisory')), reason, placed_by_agent_id, placed_by_label, placed_at, message_id, acked_at, acked_by, ack_note, state CHECK(state IN ('open','released')), released_at, released_by, release_note)`
  - `events(id, project_id, title, starts_at, entered_as, importance CHECK(importance IN ('low','normal','high')), kind, repo_id, pr_number, merger_agent_id, created_by, merged_at, merged_by, after_the_fact, cancelled_at, updated_at)`
  - `event_approvers(event_id, agent_id, request_message_id, response CHECK(response IN ('approved','objected')), responded_at, responded_by, objection_hold_id, PRIMARY KEY(event_id, agent_id))`
  - `todos(id, project_id, title, added_by, claimed_by, claimed_at, done_at, created_at)`
  - `scratchpad_entries(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id, author, body, created_at, edited_at)`
  - `documents(project_id, name, version, format CHECK(format IN ('json','markdown')), content, saved_by, created_at, PRIMARY KEY(project_id, name, version))`
  - `change_log(seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id, at, actor, kind, subject_id, data)`
  - `webhooks(id, project_id, url, secret, cursor_seq, attempts, next_attempt_at, last_error, created_at, disabled_at)`
  - `pr_heads(repo_id, pr_number, head_sha, open INTEGER, last_state, last_sha, updated_at, PRIMARY KEY(repo_id, pr_number))`
  - `status_jobs(repo_id, pr_number, attempts DEFAULT 0, next_attempt_at, last_error, PRIMARY KEY(repo_id, pr_number))`

  Indexes:
  - `message_recipients(agent_id, acked_at)`
  - `message_recipients(escalated_at, acked_at)`
  - `messages(escalate_at)`
  - `holds(repo_id, pr_number, state)`
  - `holds(project_id, state)`
  - `events(project_id, starts_at)`
  - `events(repo_id, pr_number)`
  - `event_approvers(agent_id, response)`
  - `change_log(project_id, seq)`
  - `status_jobs(next_attempt_at)`

- [ ] **Step 3: Write the failing tests** `test/foundation.test.ts`:

```ts
it('stores a 1.5 MB string through a bound parameter', async () => {
  const big = 'x'.repeat(1_500_000);
  await env.DB.prepare(`INSERT INTO documents VALUES (1,'big',1,'markdown',?,'t','2026-01-01T00:00:00Z')`).bind(big).run();
  expect((await env.DB.prepare(`SELECT length(content) n FROM documents`).first<{ n: number }>())?.n).toBe(1_500_000);
});
it('errorJson maps unknown errors to a service error', () => {
  expect(errorJson(new Error('boom')).error).toMatchObject({ kind: 'service', code: 'INTERNAL' });
  expect(errorJson(ruleError('X', 'm', 'f')).error).toEqual({ kind: 'rule', code: 'X', message: 'm', fix: 'f' });
});
it('parseZonedTime converts offsets to UTC and refuses zoneless times', () => {
  expect(parseZonedTime('2026-11-18T21:00:00-06:00')).toEqual({ utc: '2026-11-19T03:00:00.000Z', enteredAs: '2026-11-18T21:00:00-06:00' });
  expect(() => parseZonedTime('2026-11-18T21:00:00')).toThrow(expect.objectContaining({ code: 'TIME_NEEDS_ZONE' }));
});
it('GET /health returns ok and the server time', async () => {
  expect(await (await SELF.fetch('https://echo.test/health')).json()).toMatchObject({ ok: true, now: expect.any(String) });
});
```

- [ ] **Step 4: Run** `npm test -w service`. Expected: FAIL (the imports are missing).
- [ ] **Step 5: Implement `errors.ts`, `ctx.ts`, `types.ts`, `time.ts`, and an `index.ts` that uses Hono with `GET /health`.** Errors pass through `errorJson`, with HTTP status taken from `EchoError.status` (500 for unknown errors). `fake-github.ts` serves `POST /repos/:o/:r/statuses/:sha`, `GET /repos/:o/:r/pulls/:n`, `GET /repos/:o/:r/installation` and `POST /app/installations/:id/access_tokens`.
- [ ] **Step 6: Run** `npm test -w service`. Expected: PASS.
- [ ] **Step 7: Commit** with the message `feat(service): scaffold, schema, errors, time handling`.

---

### Task 2: Agents, projects, repositories, settings, change log

**Files:**
- Create: `service/src/domain/{agents,projects,changelog}.ts`, `service/test/identity.test.ts`

**Interfaces:**
- Produces:
  - `changeStmt(ctx, e: { projectId: number; actor: Actor; kind: ChangeKind; subjectId?: number | string; data?: unknown }): D1PreparedStatement`. Every state change puts it in the same `db.batch()` as the change itself.
  - `ChangeKind` is the union of these strings:
    - messages: `message.sent`, `message.delivered`, `message.deferred`, `message.acknowledged`, `message.withdrawn`, `message.escalated`
    - holds: `hold.placed`, `hold.acknowledged`, `hold.released`
    - approvals: `approval.requested`, `approval.approved`, `approval.objected`, `approval.cleared`
    - merges: `merge.refused`, `merge.recorded`, `override.used`
    - GitHub: `github.status`
    - to-dos: `todo.added`, `todo.claimed`, `todo.completed`, `todo.edited`, `todo.deleted`
    - calendar: `event.added`, `event.updated`, `event.moved`, `event.cancelled`
    - scratchpad: `scratchpad.appended`, `scratchpad.edited`, `scratchpad.cleared`
    - documents: `document.saved`, `document.deleted`
    - project administration: `project.updated`, `repo.registered`, `repo.removed`, `member.added`, `member.removed`, `webhook.added`, `webhook.removed`
  - `changesSince(ctx, projectId, sinceSeq, limit = 200): Promise<Change[]>`, where `Change = { seq; at; actor: string; kind; subjectId; data }`
  - `createAgent(ctx, name): Promise<{ agent: AgentRow; token: string }>`; `reissueToken(ctx, agentId): Promise<string>`; `revokeAgent(ctx, agentId)`
  - `authenticate(ctx, authorization: string | null): Promise<AgentRow>`, which throws the rule error `BAD_TOKEN` with status 401
  - `touchCheckIn(ctx, agentId)`
  - `createProject(ctx, name)`, `renameProject`, `archiveProject`, `listProjects(ctx)`, `getProject(ctx, id)`
  - `updateProjectSettings(ctx, id, { approvalsRequired?: boolean; approvalWindowMin?: number })`. The window must be between 5 and 240 minutes (`BAD_WINDOW`).
  - `addMember(ctx, actor, projectId, agentId)`, `removeMember`, `projectMembers(ctx, projectId): Promise<AgentRow[]>`, `agentProjects(ctx, agentId): Promise<ProjectRow[]>` (archived projects excluded)
  - `requireMember(ctx, agentId, projectId)`, which throws the rule error `NOT_MEMBER` with status 403
  - `registerRepo(ctx, actor, projectId, fullName)`, which refuses `REPO_TAKEN` naming the owning project; `removeRepo(ctx, actor, repoId)`
  - `findRepo(ctx, fullName): Promise<RepoRow | null>`, case-insensitive; `gatedRepos(ctx): Promise<string[]>`; `normalizeRepo(s): string`
  - `getOwnerSetting(ctx, key)` and `setOwnerSetting(ctx, key, value)`

Tokens are `echo_` followed by 32 random bytes in base64url. The stored hash is the hex SHA-256 of the whole token.

- [ ] **Step 1: Write the failing tests:**

```ts
it('a token authenticates until revoked, then is refused', async () => {
  const { agent, token } = await createAgent(ctx, 'Carol');
  expect((await authenticate(ctx, `Bearer ${token}`)).id).toBe(agent.id);
  await revokeAgent(ctx, agent.id);
  await expect(authenticate(ctx, `Bearer ${token}`)).rejects.toMatchObject({ kind: 'rule', code: 'BAD_TOKEN', status: 401 });
});
it('the database never holds the raw token', async () => {
  const { token } = await createAgent(ctx, 'A');
  expect(JSON.stringify((await env.DB.prepare('SELECT * FROM agents').all()).results)).not.toContain(token);
});
it('reissue invalidates the old token', async () => {});
it('repositories are case-insensitive and belong to one project', async () => {
  const s = await seed(ctx);
  expect((await findRepo(ctx, 'ACME/App'))?.id).toBe(s.repo.id);
  await expect(registerRepo(ctx, { kind: 'admin' }, s.other.id, 'Acme/APP')).rejects.toMatchObject({ code: 'REPO_TAKEN' });
});
it('requireMember refuses a non-member', async () => {});
it('change log sequence increases and changesSince filters by project', async () => {});
it('approval window outside 5..240 is refused', async () => {});
```

- [ ] **Step 2: Run** `npm test -w service -- identity`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use Web Crypto for token bytes and hashing. Look tokens up through the unique hash index, so no raw token is ever compared.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(service): agents, tokens, projects, repositories, change log`.

---

### Task 3: Messages: send, deliver, defer, acknowledge, status

**Files:**
- Create: `service/src/domain/messages.ts`, `service/test/messages.test.ts`

**Interfaces:**
- Consumes: Task 2
- Produces:
  - `MAX_MESSAGE_BYTES = 8192`
  - `sendMessage(ctx, actor: Actor, input: { projectId; to: string; body: string; requiresAck: boolean; escalateAfterMin?: number; kind?: MessageKind; refId?: number }): Promise<{ messageId; recipients: string[] }>`. Here `to` is an agent name, or `'all'` for every member except the sender. `escalateAfterMin` requires `requiresAck` (`ESCALATION_NEEDS_ACK`) and must be between 1 and 1440. It sets `escalate_at = addMinutes(now, n)`.
  - `InboxItem = { messageId; projectId; projectName; kind; refId; from: string; body; requiresAck; sentAt; deliveredAt; deferredUntil: string | null; acknowledged: boolean }`
  - `readInbox(ctx, agentId, opts?: { projectId?; includeAcknowledged? }): Promise<InboxItem[]>`, which marks returned items delivered
  - `takeForHook(ctx, agentId): Promise<{ fresh: InboxItem[]; awaitingAck: InboxItem[] }>`. `fresh` holds the items not yet delivered, plus deferred items whose time has passed (those have their `deferred_until` cleared). It marks fresh items delivered. `awaitingAck` holds delivered, requires-ack, unacknowledged items that are not currently deferred.
  - `deferMessage(ctx, agentId, messageId, forMinutes: number, reason: string)`. It needs a requires-ack message (`NOT_DEFERRABLE`), a reason (`REASON_REQUIRED`) and 1–1440 minutes. It tells the sender through the inbox, as a message from `Echo`.
  - `ackMessage(ctx, agentId, messageId, note?: string)`. Each acknowledgment of a requires-ack message sends the sender a message from `Echo`, naming the acknowledger and including the note.
  - `ackMessageInternal(ctx, agentId, messageId, note)`, used by approvals (Task 6) to acknowledge request messages without telling the sender
  - `messageStatus(ctx, agentId, messageId?): Promise<SentStatus[]>`, where `SentStatus = { messageId; sentAt; withdrawn; escalateAt; recipients: { name; delivered; deferredUntil; deferReason; acknowledged; note; escalated }[] }`
  - `withdrawMessage(ctx, actor, messageId)`, for the sender or the admin; refused with `ALREADY_ACKNOWLEDGED` once anyone has acknowledged
  - `adminAckMessage(ctx, messageId, agentId)`
  - `pendingMessages(ctx, projectId)`, for the admin page: every recipient row not yet acknowledged, with deferral, escalation and last check-in

Rule codes: `MESSAGE_TOO_LARGE`, `UNKNOWN_RECIPIENT`, `NOT_MEMBER`, `NOT_RECIPIENT`, `NOT_SENDER`, `ALREADY_ACKNOWLEDGED`, `EMPTY_MESSAGE`, `NO_RECIPIENTS`, `NOT_DEFERRABLE`, `REASON_REQUIRED`, `BAD_MINUTES`, `ESCALATION_NEEDS_ACK`. The fix text for `MESSAGE_TOO_LARGE` is exactly: `Messages are limited to 8192 bytes; this one is ${n} bytes. Save the long content as a project document (echo_doc_save) and send a short message naming the document.`

- [ ] **Step 1: Write the failing tests:**

```ts
it('refuses a body over 8192 UTF-8 bytes and names both sizes', async () => {
  await expect(sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: '😀'.repeat(3000), requiresAck: false }))
    .rejects.toMatchObject({ kind: 'rule', code: 'MESSAGE_TOO_LARGE', fix: expect.stringContaining('12000 bytes') });
});
it('a short message straight after a refused one succeeds', async () => {});
it('sent → delivered → acknowledged, re-shown until acked, sender told with the note', async () => {
  const { messageId } = await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'hold #709', requiresAck: true });
  expect((await takeForHook(ctx, s.bob.id)).fresh.map(m => m.messageId)).toEqual([messageId]);
  expect((await takeForHook(ctx, s.bob.id)).awaitingAck.map(m => m.messageId)).toEqual([messageId]);
  await ackMessage(ctx, s.bob.id, messageId, 'seen, will wait');
  expect((await takeForHook(ctx, s.bob.id)).awaitingAck).toEqual([]);
  expect((await readInbox(ctx, s.alice.id)).at(-1)).toMatchObject({ from: 'Echo', body: expect.stringContaining('seen, will wait') });
});
it('a deferred message leaves awaitingAck and comes back as fresh when its time passes', async () => {
  const { messageId } = await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'x', requiresAck: true });
  await takeForHook(ctx, s.bob.id);
  await deferMessage(ctx, s.bob.id, messageId, 10, 'waiting on the owner');
  expect((await takeForHook(ctx, s.bob.id)).awaitingAck).toEqual([]);
  ctx.setNow('2026-11-18T20:10:01.000Z');
  expect((await takeForHook(ctx, s.bob.id)).fresh.map(m => m.messageId)).toEqual([messageId]);
  expect((await messageStatus(ctx, s.alice.id, messageId))[0].recipients[0]).toMatchObject({ deferReason: 'waiting on the owner' });
});
it("'all' shows each recipient separately in status", async () => {});
it('a message with escalateAfterMin stores escalate_at from the server clock', async () => {});
it('withdraw hides an unacknowledged message; refused after acknowledgment', async () => {});
it('an agent outside the project cannot send to it or read its messages', async () => {});
```

- [ ] **Step 2: Run** `npm test -w service -- messages`. Expected: FAIL.
- [ ] **Step 3: Implement.** Measure size with `TextEncoder`. Send writes the message, its recipient rows and the change entry in one batch. Delivery is a single `UPDATE ... WHERE delivered_at IS NULL`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(service): messages with delivery, deferral and acknowledgment`.

---

### Task 4: Blocking and advisory holds

**Files:**
- Create: `service/src/domain/holds.ts`, `service/test/holds.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 3. Task 11 later registers an `onHoldChange` callback through the hook below.
- Produces:
  - `HoldView = { id; repo: string; pr: number; kind: 'blocking' | 'advisory'; reason; placedBy: string; placedAt; acknowledged: { by; at; note } | null; state: 'open' | 'released'; released: { by; at; note } | null; blocksMerge: boolean; message: { delivered: number; acknowledged: number; recipients: number } }`
  - `blocksMerge` is `state === 'open' && (kind === 'blocking' || acknowledged === null)`. For an advisory hold the acknowledgment releases it, so an open advisory hold is always unacknowledged.
  - `placeHold(ctx, actor, input: { repo; pr; reason; kind?: 'blocking' | 'advisory'; notify?: string }): Promise<HoldView>`. The kind defaults to `blocking`. It refuses `REPO_NOT_REGISTERED` and `NOT_MEMBER`, and requires a reason. It sends a requires-ack message of kind `hold`, to `notify` or `'all'`, with the body `${KIND} HOLD on ${repo}#${pr} by ${name}: ${reason}. Acknowledging this message means "seen" only. ${clearText}`. `clearText` is `Only ${name} or the owner can release it; echo_ack_hold records that you have seen it but does not clear it.` for a blocking hold, and `The merging agent clears it with echo_ack_hold (hold_id=${id}, note required).` for an advisory one.
  - `ackHold(ctx, agentId, holdId, note)`. Requires membership, refuses the placer (`PLACER_MUST_RELEASE`), requires a note (`NOTE_REQUIRED`), and refuses a released hold (`HOLD_CLOSED`). On a blocking hold it records the acknowledgment, leaves the hold open, and sends the note to the placer. On an advisory hold it records the acknowledgment and releases the hold in the same conditional update, then sends the note.
  - `releaseHold(ctx, agentId, holdId, note)`, for the placer only (`NOT_PLACER`); note required
  - `adminAckHold(ctx, holdId, note)` (the same effect as `ackHold`, with actor `admin`) and `adminReleaseHold(ctx, holdId, note)`
  - `listHolds(ctx, agentId, { projectId?; state?: 'open' | 'all' })`
  - `holdsFor(ctx, repo, pr): Promise<HoldView[]>`, open holds only, with no membership check
  - `setHoldChangeListener(fn: (ctx, repoId: number, pr: number) => Promise<void>)`, a module-level hook that every hold change calls after its batch (Task 11 enqueues a status job there)

The release is a conditional `UPDATE holds SET state='released', ... WHERE id=? AND state='open'`. When zero rows change, read the row and throw `HOLD_CLOSED`: `Hold ${id} was already released by ${by} at ${at}.`

- [ ] **Step 1: Write the failing tests:**

```ts
it('a blocking hold still blocks after the merging agent acknowledges it', async () => {
  const h = await placeHold(ctx, s.aliceA, { repo: 'Acme/App', pr: 709, reason: 'blocking finding' });
  expect(h.kind).toBe('blocking');
  await ackHold(ctx, s.bob.id, h.id, 'noted');
  expect((await holdsFor(ctx, 'acme/app', 709))[0]).toMatchObject({ blocksMerge: true, acknowledged: { by: 'Bob', note: 'noted' } });
  await releaseHold(ctx, s.alice.id, h.id, 'fixed in #712');
  expect(await holdsFor(ctx, 'acme/app', 709)).toEqual([]);
});
it('an advisory hold is released by an acknowledgment with a note', async () => {});
it('only the placer or the owner can release a blocking hold', async () => {
  const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 1, reason: 'r' });
  await expect(releaseHold(ctx, s.bob.id, h.id, 'x')).rejects.toMatchObject({ code: 'NOT_PLACER' });
});
it('acknowledging the hold message does not acknowledge the hold', async () => {});
it('two concurrent releases: exactly one succeeds, the other gets HOLD_CLOSED naming the first', async () => {
  const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 1, reason: 'r' });
  const rs = await Promise.allSettled([releaseHold(ctx, s.alice.id, h.id, 'a'), adminReleaseHold(ctx, h.id, 'b')]);
  expect(rs.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect((rs.find(r => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ kind: 'rule', code: 'HOLD_CLOSED' });
});
it('an advisory ack racing a release: exactly one wins', async () => {});
it('holdsFor reports to an agent outside the project', async () => {});
it('the change listener is called with repo id and PR on place, ack and release', async () => {});
```

- [ ] **Step 2: Run** `npm test -w service -- holds`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(service): blocking and advisory holds`.

---

### Task 5: Calendar, merge recording, day schedule

**Files:**
- Create: `service/src/domain/calendar.ts`, `service/test/calendar.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 4
- Produces:
  - `EventView = { id; projectId; title; startsAt; enteredAs; importance; kind; repo: string | null; pr: number | null; merger: string | null; createdBy; mergedAt; mergedBy; afterTheFact: boolean; cancelled: boolean }`
  - `addEvent(ctx, actor, input: { projectId; title; startsAt: string; importance?; kind?; repo?; pr?; merger?: string; approvers?: string[] }): Promise<EventView>`
    - `startsAt` goes through `parseZonedTime`.
    - Kind `merge` requires `repo` and `pr`, and `merger` defaults to the acting agent.
    - The repository must belong to the event's project (`REPO_OTHER_PROJECT`).
    - When the project requires approvals, it calls the approvals hook (set by Task 6) to create approvers and requests.
  - `updateEvent(ctx, actor, id, patch: { title?; startsAt?; importance? })`. A changed `startsAt` writes `event.moved` and calls the approvals hook to clear and re-request.
  - `cancelEvent(ctx, actor, id)`
  - `listEvents(ctx, actor, { projectId; from; to })`
  - `setEventApprovalsHook(h: { onCreate(ctx, event, approvers?: string[]): Promise<D1PreparedStatement[]>; onMove(ctx, event): Promise<D1PreparedStatement[]> })`
  - `recordMerge(ctx, actor, { repo; pr; mergedAt; source: 'hook' | 'github' }): Promise<EventView | null>`
    - Returns `null` for an unregistered repository.
    - **Idempotent:** if an event for this repository and PR already has `merged_at`, it returns that event unchanged.
    - Otherwise it marks the uncancelled, unmerged `merge` event for this repository and PR whose `startsAt` is nearest `mergedAt`, or creates one with `afterTheFact = true`. It writes `merge.recorded`.
    - The unique partial index `CREATE UNIQUE INDEX one_merge ON events(repo_id, pr_number) WHERE merged_at IS NOT NULL` makes a lost race fail, and the loser then returns the winner's row.
  - `ScheduleRow = EventView & { status: 'waiting_approval' | 'approved' | 'blocked' | 'merged' | 'scheduled'; isNext: boolean; approvers: { name; response: string | null }[] }`
  - `daySchedule(ctx, projectId, fromIso, toIso): Promise<ScheduleRow[]>`. The status comes from `mergeDecision` (Task 6), which is injected through `setScheduleDecider` to avoid an import cycle. `scheduled` is the status in projects without approvals and with no blocking hold. Until a decider is registered (as in this task's own tests), unmerged rows are `scheduled` and approver lists are empty.

- [ ] **Step 1: Write the failing tests:**

```ts
it('stores a zoned start in UTC and keeps what was entered', async () => {
  const e = await addEvent(ctx, s.bobA, { projectId, title: 'merge 709', startsAt: '2026-11-18T21:00:00-06:00', kind: 'merge', repo: 'acme/app', pr: 709 });
  expect(e).toMatchObject({ startsAt: '2026-11-19T03:00:00.000Z', enteredAs: '2026-11-18T21:00:00-06:00', merger: 'Bob' });
});
it('a start time without a zone is refused with TIME_NEEDS_ZONE', async () => {});
it('an unscheduled merge appears on that day as merged, after the fact', async () => {});
it('recording the same merge from hook then github leaves one row merged once', async () => {
  await recordMerge(ctx, s.bobA, { repo: 'acme/app', pr: 42, mergedAt: '2026-11-18T21:29:00Z', source: 'hook' });
  await recordMerge(ctx, { kind: 'system', name: 'github' }, { repo: 'Acme/App', pr: 42, mergedAt: '2026-11-18T21:29:00Z', source: 'github' });
  const rows = await daySchedule(ctx, projectId, '2026-11-18T00:00:00Z', '2026-11-19T00:00:00Z');
  expect(rows.filter(r => r.pr === 42)).toHaveLength(1);
  expect((await changesSince(ctx, projectId, 0)).filter(c => c.kind === 'merge.recorded')).toHaveLength(1);
});
it('concurrent hook and github recordMerge for the same PR produce one row', async () => {});
it('a merge marks the matching scheduled event instead of creating one', async () => {});
it('recordMerge on an unregistered repository returns null and writes nothing', async () => {});
```

- [ ] **Step 2: Run** `npm test -w service -- calendar`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add the `one_merge` index to `0001_init.sql`; nothing has deployed yet, so editing the first migration is fine.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(service): calendar, idempotent merge recording, schedule`.

---

### Task 6: Approvals and the merge decision

**Files:**
- Create: `service/src/domain/approvals.ts`, `service/test/approvals.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5
- Produces:
  - Registers `setEventApprovalsHook` and `setScheduleDecider` at module load (imported from `index.ts`).
  - On create, the approvers are the named `approvers`, or by default every project member except the merger (`NO_APPROVERS` if that leaves nobody). For each approver it inserts an `event_approvers` row and sends a requires-ack message of kind `approval_request` with `refId = event.id`, `escalate_at = min(now + 30 min, event.startsAt)`, and this body: `APPROVAL REQUESTED: ${merger} plans to merge ${repo}#${pr} at ${startsAt} (${enteredAs}). Approve with echo_approve_merge (event_id=${id}) or object with echo_object_merge.`
  - On move, it clears every response and its `objection_hold_id` link (objection holds stay open until released), withdraws the old request messages, and sends new ones.
  - `approveMerge(ctx, agentId, eventId)`. The caller must be a listed approver (`NOT_APPROVER`). It is refused once the window has closed (`WINDOW_CLOSED`) and for a cancelled or merged event (`EVENT_CLOSED`). It sets the response to `approved` and acknowledges the request message with `ackMessageInternal`.
  - `objectMerge(ctx, agentId, eventId, reason)`. It sets the response to `objected` and places a blocking hold through `placeHold`, as the objector, with the reason `Objection to the ${startsAt} merge slot: ${reason}`. It stores `objection_hold_id` and acknowledges the request.
  - `adminApprove(ctx, eventId, agentName)`, which sets `responded_by = 'admin'`
  - `pendingApprovals(ctx, agentId): Promise<{ eventId; repo; pr; startsAt; merger }[]>`
  - `Block = { kind: 'hold'; hold: HoldView } | { kind: 'no_slot' } | { kind: 'approval_missing'; eventId; startsAt; missing: string[] } | { kind: 'outside_window'; eventId; startsAt; windowStart; windowEnd }`
  - `mergeDecision(ctx, repo, pr): Promise<{ gated: boolean; allowed: boolean; blocks: Block[]; eventId: number | null }>`
    - `gated` is true when the repository is registered.
    - Every hold with `blocksMerge` is a block.
    - When the project requires approvals:
      - The candidate events are uncancelled, unmerged merge events for this repository and PR.
      - If there are none, the result is `no_slot`.
      - If there are some, choose the one whose window `[startsAt − W, startsAt + W]` (inclusive, W = `approval_window_min`) contains now. If that event has missing approvals, the result is `approval_missing`.
      - If no window contains now, the result is `outside_window` for the event nearest now.
    - `allowed` is `blocks.length === 0`.
  - `windowEdgesBetween(ctx, fromIso, toIso): Promise<{ repoId; pr }[]>`, which lists merge events whose window start or end falls in the range (for the cron in Task 11)

- [ ] **Step 1: Write the failing tests** (on `seedApprovals`, with Bob as merger and Alice as approver; the slot is `2026-11-18T21:00:00-06:00`, which is `2026-11-19T03:00:00Z`):

```ts
it('an unscheduled merge is refused with no_slot', async () => {
  expect((await mergeDecision(ctx, 'acme/app', 709)).blocks).toEqual([{ kind: 'no_slot' }]);
});
it('the merge is refused until every approver approves, then allowed inside the window', async () => {
  const e = await addEvent(ctx, s.bobA, { projectId, title: 'm', startsAt: SLOT, kind: 'merge', repo: 'acme/app', pr: 709 });
  ctx.setNow('2026-11-19T03:00:00.000Z');
  expect((await mergeDecision(ctx, 'acme/app', 709)).blocks[0]).toMatchObject({ kind: 'approval_missing', missing: ['Alice'] });
  await approveMerge(ctx, s.alice.id, e.id);
  expect((await mergeDecision(ctx, 'acme/app', 709)).allowed).toBe(true);
});
it.each([
  ['2026-11-19T02:30:00.000Z', true], ['2026-11-19T03:30:00.000Z', true],
  ['2026-11-19T03:30:01.000Z', false], ['2026-11-19T02:29:59.000Z', false],
])('window edge at %s → allowed %s', async (now, allowed) => {});
it('an approval survives a new commit (decision has no commit input) but not a move', async () => {
  // approve, updateEvent startsAt +1h → approval_missing again, new request message sent
});
it('an objection becomes a blocking hold by the objector and blocks the merge', async () => {});
it('approval requests escalate at min(sent + 30 min, slot)', async () => {});
it('projects without approvals: only holds block, unscheduled merges allowed', async () => {});
it('admin approval records responded_by admin', async () => {});
```

- [ ] **Step 2: Run** `npm test -w service -- approvals`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(service): merge approvals and the merge decision`.

---

### Task 7: Hook API

**Files:**
- Create: `service/src/api/hooks.ts`, `service/test/api.test.ts`
- Modify: `service/src/index.ts`

**Interfaces:**
- Consumes: Tasks 2–6
- Produces the HTTP contract for the hook CLI (Tasks 13–15). All routes require `Authorization: Bearer <token>`. Every body is JSON, and errors use the `errorJson` shape. **No request body carries a time.**

| Route | Request | Response | Side effects |
|---|---|---|---|
| `POST /api/v1/orient` | `{}` | `{ now; agent; projects: { id; name }[]; fresh; awaitingAck; openHolds: HoldView[]; pendingApprovals; gatedRepos }` | `takeForHook`, `touchCheckIn` |
| `POST /api/v1/poll` | `{}` | `{ now; fresh; awaitingAck; gatedRepos }` | `takeForHook`, `touchCheckIn` |
| `POST /api/v1/stop-check` | `{}` | `{ awaitingAck }` | `touchCheckIn` |
| `POST /api/v1/merge-check` | `{ repo; pr; flags: { auto: boolean; admin: boolean } }` | `{ gated; allowed; blocks: Block[] }` | writes `merge.refused` when gated and (not allowed, or a flag is set) |
| `POST /api/v1/merge-report` | `{ repo; pr; mergedAt }` | `{ recorded: boolean }` | `recordMerge` with `source: 'hook'`. `mergedAt` is GitHub's time, read by the hook from `gh pr view`. |
| `POST /api/v1/override-report` | `{ repo; pr; reason }` | `{ recorded: true }` | `override.used`; the time is the server's receipt time |
| `GET /api/v1/repos` | | `{ gatedRepos }` | |

`merge-check` and `merge-report` do not call `touchCheckIn`, because subagent sessions use them with the default token.

- [ ] **Step 1: Write the failing tests:**

```ts
it('incident replay at the API level with a blocking hold', async () => {
  const hold = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 709, reason: 'blocking finding' });
  const r1 = await post('/api/v1/merge-check', s.bob.token, { repo: 'ACME/app', pr: 709, flags: { auto: false, admin: false } });
  expect(r1).toMatchObject({ gated: true, allowed: false, blocks: [{ kind: 'hold', hold: expect.objectContaining({ id: hold.id, placedBy: 'Alice', kind: 'blocking' }) }] });
  await ackHold(ctx, s.bob.id, hold.id, 'noted');
  expect((await post('/api/v1/merge-check', s.bob.token, { repo: 'acme/app', pr: 709, flags: { auto: false, admin: false } })).allowed).toBe(false);
  await releaseHold(ctx, s.alice.id, hold.id, 'fixed');
  expect((await post('/api/v1/merge-check', s.bob.token, { repo: 'acme/app', pr: 709, flags: { auto: false, admin: false } })).allowed).toBe(true);
});
it('orient includes the server time and pending approvals', async () => {});
it('merge-check works for an agent outside the project and is not gated for unregistered repos', async () => {});
it('poll updates last_checked_in_at; merge-check does not', async () => {});
it('a revoked token gets 401 BAD_TOKEN on every route', async () => {});
it('a body with an unexpected time field is rejected (strict schemas)', async () => {});
```

- [ ] **Step 2: Run** `npm test -w service -- api`. Expected: FAIL.
- [ ] **Step 3: Implement** with Hono, a bearer middleware, and strict zod schemas (`.strict()`). Validation failures become the rule error `BAD_REQUEST`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(service): hook API`.

---

### Task 8: MCP endpoint: identity, messages, holds, approvals, calendar

**Files:**
- Create: `service/src/mcp/{server,tools,result}.ts`, `service/test/{mcp,mcp-client}.ts`
- Modify: `service/src/index.ts`

**Interfaces:**
- Consumes: Tasks 2–6
- Produces:
  - `createEchoServer(ctx, agent: AgentRow): McpServer`
  - `toolResult(fn)`. On success it returns JSON text. On an `EchoError` it returns `isError: true` with exactly one of these texts: `Refused (rule ${code}): ${message}\nWhat to do: ${fix}` or `Echo service problem (${code}): ${message}\nWhat to do: ${fix}`.
  - `mcpCall(token, tool, args): Promise<{ isError?: boolean; text: string }>`, a test helper that performs whatever handshake `createMcpHandler` needs (settled in Step 1)
  - Tools (snake_case parameters, projects named by `project` name):
    - `echo_whoami`, returning `{ name, projects, now }`
    - messages: `echo_send_message` (`escalate_after_minutes?`), `echo_inbox`, `echo_ack_message`, `echo_defer_message` (`for_minutes`, `reason`), `echo_message_status`, `echo_withdraw_message`
    - holds: `echo_place_hold` (`kind?`, defaulting to blocking), `echo_list_holds`, `echo_ack_hold`, `echo_release_hold`
    - approvals: `echo_pending_approvals`, `echo_approve_merge`, `echo_object_merge`
    - calendar: `echo_calendar_add` (`starts_at` with zone, `merger?`, `approvers?`), `echo_calendar_list`, `echo_calendar_update`, `echo_calendar_cancel`
  - Every time in a tool result is UTC with `Z`. Every tool's input schema is `.strict()`, so an agent-supplied timestamp field is refused with `BAD_REQUEST` (spec scenario 18).
  - Required descriptions:
    - `echo_send_message`: long content belongs in a document.
    - `echo_ack_message`: acknowledging a hold message does not clear the hold; defer instead of acknowledging anything not yet handled.
    - `echo_ack_hold`: on a blocking hold it does not clear the block.

`index.ts` routing for `/mcp`:
1. `authenticate` the bearer, answering 401 JSON on failure.
2. Then run `createMcpHandler(() => createEchoServer(ctx, agent), { authContext: { props: { agentId } } })(request, env, executionCtx)`, with allowed hostnames taken from `env.ALLOWED_HOSTNAMES` when it is set.

- [ ] **Step 1: Spike the handshake.** Write `mcpCall`, which POSTs JSON-RPC with `Accept: application/json, text/event-stream`. Find out whether a stateless `tools/call` needs an `initialize` first, and record the answer in a comment.
- [ ] **Step 2: Write the failing tests:**

```ts
it('whoami returns name, projects and server time', async () => {
  expect(JSON.parse((await mcpCall(s.alice.token, 'echo_whoami', {})).text)).toEqual({ name: 'Alice', projects: ['core'], now: expect.stringMatching(/Z$/) });
});
it('a rule error is distinguishable from a service error', async () => {
  const r = await mcpCall(s.alice.token, 'echo_send_message', { project: 'core', to: 'Bob', body: 'x'.repeat(9000), requires_ack: false });
  expect(r.isError).toBe(true);
  expect(r.text).toMatch(/^Refused \(rule MESSAGE_TOO_LARGE\)/);
});
it('place_hold defaults to blocking; object_merge creates a blocking hold', async () => {});
it('missing or revoked token gets HTTP 401 before MCP handling', async () => {});
it('an agent cannot act on a project it is not in', async () => {});
```

- [ ] **Step 3: Run** `npm test -w service -- mcp`. Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** the same command. Expected: PASS.
- [ ] **Step 6: Commit** with the message `feat(service): MCP endpoint for messages, holds, approvals, calendar`.

---

### Task 9: To-dos and scratchpad

**Files:**
- Create: `service/src/domain/{todos,scratchpad}.ts`, `service/test/shared.test.ts`
- Modify: `service/src/mcp/tools.ts`

**Interfaces:**
- Produces:
  - `addTodo(ctx, actor, projectId, title)`, `listTodos(ctx, actor, projectId, { includeDone? })`, `claimTodo(ctx, actor, id)` (refuses `ALREADY_CLAIMED` naming the claimer), `completeTodo`, `adminEditTodo`, `adminDeleteTodo`
  - `appendScratchpad(ctx, actor, projectId, body)`, with a limit of `MAX_MESSAGE_BYTES` per entry; `readScratchpad(ctx, actor, projectId, { afterId?; limit? })`; `adminEditEntry(ctx, id, body)`; `adminClearScratchpad(ctx, projectId)`
  - Tools: `echo_todo_add`, `echo_todo_list`, `echo_todo_claim`, `echo_todo_complete`, `echo_scratchpad_append`, `echo_scratchpad_read`. Agents get no edit or delete tool for the scratchpad.

- [ ] **Step 1: Write the failing tests:**

```ts
it('two simultaneous appends are both kept, in id order, stamped by the server', async () => {
  await Promise.all([appendScratchpad(ctx, s.aliceA, pid, 'one'), appendScratchpad(ctx, s.bobA, pid, 'two')]);
  const e = await readScratchpad(ctx, s.aliceA, pid, {});
  expect(e.map(x => x.body).sort()).toEqual(['one', 'two']);
  expect(e[0].id).toBeLessThan(e[1].id);
  expect(e.every(x => x.createdAt === ctx.now())).toBe(true);
});
it('the MCP tool list has no scratchpad edit or delete tool', async () => {});
it('claiming a claimed to-do names the current claimer', async () => {});
```

- [ ] **Step 2: Run** `npm test -w service -- shared`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(service): to-dos and append-only scratchpad`.

---

### Task 10: Documents with retention, and changes-since

**Files:**
- Create: `service/src/domain/documents.ts`, `service/test/documents.test.ts`
- Modify: `service/src/mcp/tools.ts`

**Interfaces:**
- Produces:
  - `MAX_DOCUMENT_BYTES = 1048576`, `DOC_VERSIONS_KEPT = 50`, `DOC_NAME = /^[A-Za-z0-9._-]{1,100}$/`
  - `saveDocument(ctx, actor, { projectId; name; format; content }): Promise<{ name; version }>`
    - Versions start at 1. A save that creates version `v > 50` deletes versions `<= v - 50` in the same batch.
    - Rule codes: `INVALID_JSON` (with the parser's message), `DOCUMENT_TOO_LARGE` (naming both sizes), `BAD_NAME`, `FORMAT_CHANGED`.
  - `getDocument(ctx, actor, projectId, name, version?)`, `listDocuments`, `listVersions`, `adminDeleteDocument`
  - Tools: `echo_doc_save`, `echo_doc_get` (`version?`), `echo_doc_list`, `echo_doc_versions`, `echo_changes_since` (`{ project; since_seq; limit? }`, which returns the changes and `next_seq`)

- [ ] **Step 1: Write the failing tests:**

```ts
it('saving an existing name creates version 2 and keeps version 1', async () => {});
it('the 51st save deletes version 1 and keeps 2..51', async () => {});
it('a document of exactly 1048576 bytes saves; 1048577 is refused naming both sizes', async () => {});
it('invalid JSON is refused with the parser message', async () => {});
it('changes_since returns entries after since_seq for that project only, with next_seq', async () => {});
```

- [ ] **Step 2: Run** `npm test -w service -- documents`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(service): versioned documents with retention, changes-since`.

---

### Task 11: GitHub App: `echo/hold` status and pull request events

**Files:**
- Create: `service/src/github/{app,status,webhook}.ts`, `service/test/github.test.ts`
- Modify: `service/src/index.ts` (the `/github/webhook` route, plus `scheduled` calling `runStatusJobs`), `service/src/domain/{approvals,calendar}.ts` (enqueue on approval and event changes)

**Interfaces:**
- Consumes: Task 6 `mergeDecision` and `windowEdgesBetween`; Task 4 `setHoldChangeListener`; Task 5 `recordMerge`
- Produces:
  - `app.ts`:
    - `appJwt(env, nowSec): Promise<string>`. RS256 over `{ iat: nowSec - 60, exp: nowSec + 540, iss: GITHUB_APP_ID }`, using `crypto.subtle.importKey('pkcs8', ...)` on `GITHUB_APP_PRIVATE_KEY`. That key must be PKCS#8 PEM; the setup notes give the `openssl pkcs8` conversion.
    - `installationToken(env, installationId, fetchFn)`, cached per isolate until 5 minutes before it expires
    - `ghRequest(env, installationId, method, path, body?, fetchFn)`
  - `status.ts`:
    - `STATUS_CONTEXT = 'echo/hold'`
    - `enqueueStatus(ctx, repoId, pr): D1PreparedStatement` (an upsert into `status_jobs` with `next_attempt_at = now`)
    - `describe(decision): { state: 'success' | 'failure'; description: string }`. The description is at most 140 characters, for example `Blocked: blocking hold by Alice (reason…)`, `Waiting for approval from Alice`, `Outside approved slot (21:00Z ±30m)`, `No approved merge slot`, or `Clear: no holds`.
    - `runStatusJobs(ctx, fetchFn = fetch, max = 30)`. For each due job:
      1. Find the head SHA from `pr_heads`, fetching `GET /repos/{o}/{r}/pulls/{n}` if it is missing.
      2. Skip PRs that are closed.
      3. Compute `mergeDecision`.
      4. Write the status unless `last_state` and `last_sha` already match.
      5. On success, delete the job and update `repos.last_status_*`.
      6. On failure, back off 1, 2, 5, 10 and then 10 minutes, retrying forever, and record `last_error`.

      Before processing, it enqueues the PRs returned by `windowEdgesBetween(lastRun, now)`. `lastRun` is stored in `owner_settings` under the key `status_cron_at`.
    - After any hold, approval or event change, the domain modules call `enqueueStatus` in their batch, and `index.ts` runs `ctx.waitUntil(runStatusJobs(...))` for an immediate first attempt.
  - `webhook.ts`: `handleGithubWebhook(ctx, request, fetchFn)`
    - Verifies `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with `GITHUB_WEBHOOK_SECRET`, compared in constant time). A bad signature gets a 401.
    - `pull_request` actions `opened`, `reopened`, `synchronize` and `ready_for_review`: upsert `pr_heads` (head SHA, open) and enqueue.
    - `closed`: mark the PR not open. If `merged` is true, call `recordMerge(..., { mergedAt: pull_request.merged_at, source: 'github' })` with actor `{ kind: 'system', name: 'github' }`.
    - `installation` and `installation_repositories`: set `repos.installation_id` for registered repositories, matched by lowercase name.
    - Unregistered repositories get a 200 and are ignored.
  - A repository with no installation id gets `last_status_error = 'GitHub App not installed on this repository'`, and its jobs back off.

- [ ] **Step 1: Write the failing tests**, using `fakeGithub()` and a generated test key pair:

```ts
it('placing a blocking hold sets failure on the head; releasing sets success', async () => {
  gh.pulls.set('acme/app#709', { head: 'abc', state: 'open', mergedAt: null });
  const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 709, reason: 'finding' });
  await runStatusJobs(ctx, gh.fetch);
  expect(gh.statuses.at(-1)).toMatchObject({ repo: 'acme/app', sha: 'abc', state: 'failure', description: expect.stringContaining('Alice') });
  await releaseHold(ctx, s.alice.id, h.id, 'ok'); await runStatusJobs(ctx, gh.fetch);
  expect(gh.statuses.at(-1)).toMatchObject({ sha: 'abc', state: 'success' });
});
it('a synchronize event with a new head gets a status for the new sha', async () => {});
it('a webhook with a bad signature is refused with 401', async () => {});
it('GitHub failures are retried with backoff and the job survives', async () => {});
it('an approval window opening flips the status to success without any other event', async () => {});
it('pull_request closed+merged records the merge once, even if the hook already reported it', async () => {});
it('payload repository names in mixed case match the registered repository', async () => {});
it('an unchanged state and sha does not write a duplicate status', async () => {});
```

- [ ] **Step 2: Run** `npm test -w service -- github`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(service): echo/hold GitHub status and pull request events`.

---

### Task 12: Escalation to the owner and outgoing webhooks

**Files:**
- Create: `service/src/domain/{escalation,webhooks}.ts`, `service/test/{escalation,webhooks}.test.ts`
- Modify: `service/src/index.ts` (`scheduled` runs `runEscalations`, `deliverWebhooks` and `runStatusJobs`, each in its own try block)

**Interfaces:**
- Produces:
  - `runEscalations(ctx, fetchFn = fetch, max = 20)`. It selects recipient rows where:
    - `escalate_at <= now`, `acked_at IS NULL` and `escalated_at IS NULL`;
    - the message is not withdrawn;
    - `deferred_until` is null or `<= now`.

    For each row, it POSTs to the owner setting `notify_url`. The body is plain text: `${recipient} has not answered ${sender}'s message in ${project} (sent ${sentAt} UTC; last check-in ${lastCheckIn ?? 'never'}):\n${first 300 chars}`. The headers are `Title: Echo: unanswered message for ${recipient}`, `Priority: high` and `Click: ${PUBLIC_URL}/admin/p/${projectId}`. On a 2xx response it sets `escalated_at` and writes `message.escalated`. On failure the row stays unescalated and the next run retries it. If no `notify_url` is set, nothing is sent, and the admin page shows a warning banner.
  - `addWebhook(ctx, projectId, url): Promise<{ id; secret }>`, with the secret shown once and the cursor starting at the current maximum `seq`; `removeWebhook(ctx, id)`
  - `deliverWebhooks(ctx, fetchFn = fetch, maxPerRun = 40)`. For each active webhook whose `next_attempt_at` has passed, POST the next change-log entries after its `cursor_seq`, one per request and in order. Headers: `X-Echo-Seq` and `X-Echo-Signature: sha256=<hex HMAC(secret, body)>`. A 2xx response advances the cursor. A failure backs off 1, 5, 30 and then 120 minutes. After the 5th failure, skip the entry and record `last_error`.

- [ ] **Step 1: Write the failing tests:**

```ts
it('an unanswered message escalates exactly once, with a link to the admin page', async () => {
  await setOwnerSetting(ctx, 'notify_url', 'https://ntfy.test/owner');
  await sendMessage(ctx, s.aliceA, { projectId, to: 'Bob', body: 'urgent', requiresAck: true, escalateAfterMin: 5 });
  ctx.setNow('2026-11-18T20:05:00.000Z');
  await runEscalations(ctx, net.fetch); await runEscalations(ctx, net.fetch);
  expect(net.requests.filter(r => r.url === 'https://ntfy.test/owner')).toHaveLength(1);
  expect(net.requests[0].headers.Click).toBe(`${PUBLIC_URL}/admin/p/${projectId}`);
});
it('a deferred message escalates only after its deferral runs out', async () => {});
it('an acknowledged or withdrawn message never escalates', async () => {});
it('a failed notification is retried on the next run', async () => {});
it('webhook delivers entries in order with a verifiable signature; skips after 5 failures', async () => {});
```

- [ ] **Step 2: Run** `npm test -w service -- escalation webhooks`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(service): owner escalation and outgoing webhooks`.

---

### Task 13: Hook CLI foundation: config, token store, client, parser, resolver

**Files:**
- Create: `hooks/{package.json,tsconfig.json,vitest.config.ts}`, `hooks/src/{input,config,token-store,client,state,parse-merge,resolve-pr}.ts`, `hooks/test/fixtures/bin/{gh,security}`, `hooks/test/fake-server.ts`, `hooks/test/{parse-merge,resolve-pr,config}.test.ts`

**Interfaces:**
- Produces:
  - `HookInput = { hook_event_name; session_id; cwd; tool_name?; tool_input?: { command?: string }; tool_use_id?; agent_id?; agent_type?; source?; stop_hook_active? }` and `readInput(stdin): HookInput`
  - `EchoConfig = { url: string; agents: string[]; defaultAgent: string }`, stored at `~/.echo/config.json` (`ECHO_HOME` overrides `~/.echo`). **It holds no tokens.**
  - `loadConfig(env): EchoConfig | null`
  - `token-store.ts`:
    - `readToken(name, env): Promise<string | null>`. If `env.ECHO_AGENT === name` and `env.ECHO_TOKEN` is set, use that. Otherwise on macOS run `security find-generic-password -s echo -a <name> -w`, and on other platforms read `~/.echo/tokens/<name>`. `ECHO_TOKEN_STORE=file` forces the file store, for tests.
    - `writeToken(name, token)`. On macOS: `security add-generic-password -U -s echo -a <name> -w <token>`. Elsewhere: write the file with mode 0600, refusing any path inside a git work tree.
  - `messageIdentity(cfg, env, input): Promise<{ name; token } | null>`. It returns non-null only when `env.ECHO_AGENT` is in `cfg.agents`, `input.agent_id` is absent, and a token is found.
  - `mergeCheckToken(cfg, env): Promise<string | null>`, which is the `ECHO_AGENT` token if set, otherwise the `defaultAgent` token
  - `class Unreachable extends Error` (network errors, timeouts, 5xx) and `class Refused extends Error { code; fix }` (4xx)
  - `api(cfg, token, path, body?, timeoutMs = 5000)`. The merge check uses 10,000 ms.
  - `state.ts` writes through a temp file followed by `rename`. It provides:
    - `readGateCache()` and `writeGateCache(repos)`
    - `lastPoll(agent)` and `setLastPoll(agent, ms)`
    - `savePendingMerge(toolUseId, target)` and `takePendingMerge(toolUseId)`
    - `stopShown(sessionId): Set<number>` and `addStopShown(sessionId, ids)`
    - `overrideState(key): { firstSeenMs; usedAtMs } | null` and `setOverrideState(key, s)`
    - `queueReport(r)` and `drainReports(): Report[]`
  - `MergeInvocation = { target: string | null; repoFlag: string | null; envRepo: string | null; cwd: string; auto: boolean; admin: boolean; disableAuto: boolean }`
  - `parseMerge(command, cwd): { kind: 'none' } | { kind: 'merge'; inv } | { kind: 'ambiguous'; why: string }`
  - `PrTarget = { repo: string; pr: number }`
  - `resolvePr(inv, env): Promise<PrTarget & { state: 'OPEN' | 'MERGED' | 'CLOSED'; mergedAt: string | null }>`. It runs `gh pr view [target] [-R repo] --json url,state,mergedAt` in `inv.cwd` (setting `GH_REPO` from `envRepo` when present), parses the URL `https://github.com/O/R/pull/N` and lowercases the repository. It throws `CannotResolve` with gh's stderr.

Parser rules, which the tests pin:
- Tokenize with shell quoting, and split on `&&`, `||`, `;`, `|` and newlines.
- A segment is a merge when its words, after any leading `VAR=value` assignments, start `gh pr merge`.
- A preceding `cd DIR` sets `cwd`. `GH_REPO=` before `gh` sets `envRepo`.
- `--admin`, `--auto` and `--disable-auto` set their flags.
- The result is `ambiguous` when the raw command contains `gh pr merge` and any of these holds:
  - no merge segment was parsed, or more than one was;
  - the command contains `$(`, a backtick, `eval`, `bash -c`, `sh -c` or `xargs`.

  The exception is a command whose only occurrences sit inside quoted arguments to `echo`, `printf`, `git commit` or `grep`, which is `none`.

- [ ] **Step 1: Write the failing parser tests**, table-driven:

```ts
const cases = [
  ['ls -la', '/w', { kind: 'none' }],
  ['gh pr merge', '/w', { kind: 'merge', inv: expect.objectContaining({ target: null, cwd: '/w' }) }],
  ['gh pr merge 709 --squash -d', '/w', { kind: 'merge', inv: expect.objectContaining({ target: '709' }) }],
  ['gh pr merge https://github.com/Acme/App/pull/5', '/w', { kind: 'merge', inv: expect.objectContaining({ target: 'https://github.com/Acme/App/pull/5' }) }],
  ['gh pr merge 5 -R acme/app', '/w', { kind: 'merge', inv: expect.objectContaining({ repoFlag: 'acme/app' }) }],
  ['gh pr merge 5 --repo=acme/app --auto', '/w', { kind: 'merge', inv: expect.objectContaining({ auto: true }) }],
  ['gh pr merge 5 --admin --squash', '/w', { kind: 'merge', inv: expect.objectContaining({ admin: true }) }],
  ['cd ../other && gh pr merge 5', '/w/x', { kind: 'merge', inv: expect.objectContaining({ cwd: '/w/other' }) }],
  ['GH_REPO=acme/app gh pr merge 5', '/w', { kind: 'merge', inv: expect.objectContaining({ envRepo: 'acme/app' }) }],
  ['gh pr merge 5 --disable-auto', '/w', { kind: 'merge', inv: expect.objectContaining({ disableAuto: true }) }],
  ['echo "run gh pr merge later"', '/w', { kind: 'none' }],
  ['git commit -m "gh pr merge after review"', '/w', { kind: 'none' }],
  ["bash -c 'gh pr merge 5'", '/w', { kind: 'ambiguous' }],
  ['gh pr merge 5 && gh pr merge 6', '/w', { kind: 'ambiguous' }],
  ['x=$(gh pr merge 5)', '/w', { kind: 'ambiguous' }],
] as const;
it.each(cases)('%s', (cmd, cwd, expected) => expect(parseMerge(cmd, cwd)).toMatchObject(expected));
```

- [ ] **Step 2: Write the failing resolver, config and token tests.** The fake `gh` and `security` scripts log their argv and cwd to `$FAKE_LOG`, print `$FAKE_<NAME>_STDOUT`, and exit with `$FAKE_<NAME>_EXIT`.

```ts
it('resolves repo and number from the PR url, lowercased, passing -R through', async () => {});
it('throws CannotResolve with gh stderr when gh fails', async () => {});
it('messageIdentity is null inside a subagent, without ECHO_AGENT, or with no token found', async () => {});
it('readToken prefers ECHO_TOKEN for the marked agent, then the Keychain via security', async () => {});
it('writeToken (file store) writes mode 0600 and refuses a path inside a git work tree', async () => {});
it('config.json never contains a token after install-style writes', async () => {});
it('api classifies a refused connection and a 503 as Unreachable, a 403 as Refused', async () => {});
```

- [ ] **Step 3: Run** `npm test -w hooks`. Expected: FAIL.
- [ ] **Step 4: Implement.** Use `execFile` with no shell, and global `fetch` with `AbortSignal.timeout`.
- [ ] **Step 5: Run** `npm test -w hooks`. Expected: PASS.
- [ ] **Step 6: Commit** with the message `feat(hooks): config, token store, client, merge parser, PR resolver`.

---

### Task 14: Merge hooks (PreToolUse and PostToolUse on Bash)

**Files:**
- Create: `hooks/src/{merge-pre,merge-post,format,main}.ts`, `hooks/test/merge.test.ts`

**Interfaces:**
- Consumes: Task 13; the Task 7 routes `merge-check`, `merge-report`, `override-report` and `repos`
- Produces:
  - `noteOverrideSeen(env, nowMs): void` (see Step 3)
  - `preBash(input, env, nowMs = Date.now()): Promise<HookOutput>` and `postBash(input, env): Promise<HookOutput>`, where `HookOutput = { stdout?: string; exitCode: 0 }`. A refusal is the JSON `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason": text}}`.
  - `main.ts` dispatches `argv[2]` across `session-start | prompt | post-tool | stop | pre-bash | post-bash | install | token | set-token | version` and catches everything. `pre-bash` fails closed by refusing with the error text. Every other event prints nothing and exits 0.

`preBash` decision order:
1. Not a merge, or `disableAuto`: allow.
2. `ambiguous`: refuse with `format.ambiguousMerge(why)`.
3. `resolvePr` throws: refuse with `format.cannotResolve(stderr)`.
4. The gate cache exists and lacks the repository: allow.
5. `inv.auto` or `inv.admin`: refuse with `format.flagRefused(target, flag)`, and still send `merge-check` with the flags, best effort, so the refusal is logged.
6. Call `merge-check`. Refresh the gate cache from `GET /repos` (best effort).
   - `gated` false: allow.
   - Not `allowed`: refuse with `format.blocked(target, blocks)`.
   - Otherwise: `savePendingMerge(tool_use_id, target)` and allow.
7. `Unreachable`, with `key = ${repo}#${pr}`:
   - If `env.ECHO_MERGE_OVERRIDE` is not equal to `key` (case-insensitive), refuse with `format.unreachable(target, err)`.
   - Otherwise, load `overrideState(key)`. On first sight, set `firstSeenMs = nowMs`.
   - If `usedAtMs` is set, refuse with `format.overrideUsed(key)`.
   - If `nowMs - firstSeenMs > OVERRIDE_TTL_MS`, refuse with `format.overrideExpired(key)`.
   - Otherwise set `usedAtMs`, queue an override report, save the pending merge, and allow with a line of context saying the override was used.

`postBash`:
- Drain queued reports (best effort).
- If the command was not a merge, do nothing. Otherwise take the pending target by `tool_use_id`; if there is none, do nothing.
- Run `gh pr view <pr> -R <repo> --json url,state,mergedAt`.
- If the PR is `MERGED`, POST `merge-report` with GitHub's `mergedAt`, queuing it on failure.
- If it is `OPEN`, run `gh pr merge <pr> -R <repo> --disable-auto` and add `additionalContext`: `format.queuedDisabled(target)`.

Pinned texts (in `format.ts`):
- `blocked` starts `Merge refused by Echo: ${repo}#${pr} cannot merge now.`, with one line per block:
  - Hold: `- ${Kind} hold ${id} by ${placedBy} at ${placedAt}: ${reason}. ${kind === 'blocking' ? `Only ${placedBy} or the owner can release it; echo_ack_hold tells ${placedBy} you have seen it.` : `Clear it with echo_ack_hold (hold_id=${id}, note required).`}`
  - `- No approved merge slot. Schedule it with echo_calendar_add (kind merge) and wait for approval.`
  - `- Waiting for approval from ${missing.join(', ')} for the ${startsAt} slot.`
  - `- Outside the approved window for the ${startsAt} slot (${windowStart} to ${windowEnd}). Reschedule and get approval again.`

  It ends with `If you are a subagent, do not merge: report this to your orchestrator.`
- `unreachable`: `Merge refused: the Echo service could not be reached (${detail}), and ${repo} is a registered repository, so merges are blocked until Echo answers. A human can allow this one merge, once, within 30 minutes, by restarting Claude Code with ECHO_MERGE_OVERRIDE=${repo}#${pr} in its environment.`
- `flagRefused`: `Merge refused by Echo: ${flag} is not allowed in ${repo}. ${flag === '--auto' ? 'Auto-merge and merge queues let GitHub merge later without checking holds or approvals.' : '--admin skips required checks, including echo/hold.'} Merge directly without it.`

- [ ] **Step 1: Write the failing tests** against `fake-server.ts` and the fake `gh`:

```ts
it('refuses a blocking hold, naming placer, time, reason, and that only the placer can release', async () => {
  server.reply('/api/v1/merge-check', { gated: true, allowed: false, blocks: [{ kind: 'hold', hold: blocking709 }] });
  const r = JSON.parse((await preBash(bashInput('gh pr merge 709 --squash'), env)).stdout!).hookSpecificOutput;
  expect(r.permissionDecision).toBe('deny');
  expect(r.permissionDecisionReason).toContain('Blocking hold 7 by Alice at 2026-11-17T21:08:00Z: blocking finding. Only Alice or the owner can release it');
});
it('refuses with the missing approvers named', async () => {});
it('--admin and --auto in a gated repo are refused and logged', async () => {});
it('unreachable + gated → refused with the override instruction', async () => {});
it('override: allowed once, then refused', async () => {
  server.down(); const e = { ...env, ECHO_MERGE_OVERRIDE: 'acme/app#709' };
  expect(denied(await preBash(bashInput('gh pr merge 709'), e, T0))).toBe(false);
  expect(denied(await preBash(bashInput('gh pr merge 709'), e, T0 + 1000))).toBe(true);
});
it('override: refused 30 minutes after any hook first saw the variable', async () => {
  const e = { ...env, ECHO_MERGE_OVERRIDE: 'acme/app#709' };
  noteOverrideSeen(e, T0);                       // e.g. at session start
  server.down();
  expect(denied(await preBash(bashInput('gh pr merge 709'), e, T0 + 30 * 60_000))).toBe(false);
});
it('override: one millisecond past 30 minutes is refused as expired', async () => {
  const e = { ...env, ECHO_MERGE_OVERRIDE: 'acme/app#709' };
  noteOverrideSeen(e, T0); server.down();
  const out = await preBash(bashInput('gh pr merge 709'), e, T0 + 30 * 60_000 + 1);
  expect(reason(out)).toContain('expired');
});
it('ECHO_MERGE_OVERRIDE in the command text has no effect', async () => {});
it('ungated repo with a fetched cache → allowed even when the service is down', async () => {});
it('no gate cache yet + service down → refused', async () => {});
it('post: uses the target saved by tool_use_id even after --delete-branch switched branches', async () => {});
it('post: PR still OPEN after merge → runs --disable-auto and explains', async () => {});
it('a subagent call (agent_id present) is merge-checked exactly like the orchestrator', async () => {});
it('any thrown error in pre-bash is a refusal, not a crash', async () => {});
```

  The test helpers are `denied(out) = JSON.parse(out.stdout ?? '{}').hookSpecificOutput?.permissionDecision === 'deny'` and `reason(out)`, which returns `permissionDecisionReason`.

- [ ] **Step 2: Run** `npm test -w hooks -- merge`. Expected: FAIL.
- [ ] **Step 3: Implement.** `noteOverrideSeen(env, nowMs)`, in `merge-pre.ts`, records `firstSeenMs` for the variable's value if none is recorded yet. `main.ts` calls it on **every** hook event before dispatching, so the 30 minutes count from the first hook run in a session launched with the variable (normally `SessionStart`). `preBash` also calls it, before applying step 7.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(hooks): merge check, override, merge report`.

---

### Task 15: Message hooks (SessionStart, UserPromptSubmit, PostToolUse, Stop)

**Files:**
- Create: `hooks/src/messages.ts`, `hooks/test/messages.test.ts`
- Modify: `hooks/src/{main,format}.ts`

**Interfaces:**
- Consumes: Task 13 `messageIdentity`, `api`, state; the Task 7 routes `orient`, `poll` and `stop-check`
- Produces:
  - `sessionStart(input, env)`, which prints `format.orientation(o)` to stdout
  - `promptSubmit(input, env)`, which prints `format.newMessages(...)` only when there is something to show
  - `postTool(input, env, nowMs)`. It skips the call if less than `POLL_INTERVAL_MS` has passed since `lastPoll`. Otherwise it prints `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext": text}}` when there is something to show.
  - `stop(input, env)`. It calls `stop-check` and filters out the ids in `stopShown(session_id)`. If any remain, it records them with `addStopShown` and prints `{"decision":"block","reason": format.stopBlocked(items)}`. Otherwise it prints nothing.
  - Each returns immediately when `messageIdentity` is null. When the service is unreachable, `sessionStart` prints `Echo: service unreachable; messages, holds and approvals could not be loaded.` The others print nothing.
  - All four refresh the gate cache.

Pinned text:
- `format.orientation` starts `You are ${name} in Echo. Echo's clock: ${now} (UTC); trust it over your own. Projects: ${list}.`
- It then has the sections "New messages", "Awaiting your acknowledgment", "Merges awaiting your approval" and "Open holds", each omitted when empty.
- It ends with: `Echo: acknowledge messages you have handled with echo_ack_message, or defer with echo_defer_message if you cannot act yet; approve or object to merges with echo_approve_merge / echo_object_merge; a blocking hold stays until its placer releases it; put long content in a document (echo_doc_save).`
- `format.stopBlocked` lists each message and ends with: `Acknowledge each one you have handled. If you cannot act on one yet, defer it with a reason rather than acknowledging it.`

- [ ] **Step 1: Write the failing tests:**

```ts
it('session start prints name, Echo clock, projects, fresh, awaiting-ack, approvals and holds', async () => {});
it('compact source prints the same orientation', async () => {});
it('inside a subagent (agent_id set) no message hook calls the service', async () => {
  for (const fn of [sessionStart, promptSubmit, postTool, stop]) await fn({ ...base, agent_id: 'a1' }, env, 0);
  expect(server.requests).toEqual([]);
});
it('without ECHO_AGENT no message hook calls the service', async () => {});
it('postTool calls the service at most once per 30 s', async () => {});
it('stop blocks once per message per session, and again for a new message', async () => {
  server.reply('/api/v1/stop-check', { awaitingAck: [m1] });
  expect(await stop(base, env)).toMatchObject({ stdout: expect.stringContaining('"decision":"block"') });
  expect((await stop(base, env)).stdout).toBeUndefined();
  server.reply('/api/v1/stop-check', { awaitingAck: [m1, m2] });
  expect((await stop(base, env)).stdout).toContain(m2.body);
  expect((await stop({ ...base, session_id: 'other' }, env)).stdout).toContain(m1.body);
});
it('stop allows when the service is unreachable', async () => {});
```

- [ ] **Step 2: Run** `npm test -w hooks -- messages`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(hooks): message delivery hooks`.

---

### Task 16: Admin login and project overview

**Files:**
- Create: `service/src/admin/{auth,routes,views}.ts`, `service/test/admin.test.ts`
- Modify: `service/src/index.ts`

**Interfaces:**
- Consumes: Tasks 2–6, 9 and 11–12
- Produces:
  - `POST /admin/login`. Applies `LOGIN_LIMIT` per IP, compares the password with `ADMIN_PASSWORD` in constant time, and sets cookie `echo_admin=<expiryMs>.<hex HMAC-SHA256(SESSION_SECRET, expiryMs)>` with `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/admin` and a 12-hour lifetime.
  - `requireAdmin`. A GET without a valid cookie redirects to `/admin/login`. A POST without a valid cookie, or with an `Origin` other than the request's own, gets a 403.
  - `GET /admin` lists projects. It shows a banner when the owner `notify_url` is unset, or when any registered repository's last GitHub status write failed.
  - `GET /admin/p/:id` is the overview, in spec section 8 order:
    1. Today's merges, loaded by a small inline script from `GET /admin/p/:id/schedule?from&to`, with the browser's local midnight to midnight sent as UTC ISO. The fragment shows PR, merger, importance, status and each approver's response, with an "Approve for <name>" button per missing approver.
    2. Open holds, showing kind, placer, reason, message delivered and acknowledged counts, and the hold's own acknowledgment, with Force-acknowledge and Release buttons.
    3. Waiting messages, showing per-recipient state, deferral and reason, escalation, and last check-in, with Force-acknowledge and Withdraw buttons.
    4. A side column: agents and their last check-in, open to-dos, and the 20 most recent changes.
  - POST actions, each redirecting back:
    - `/admin/holds/:id/force-ack` and `/admin/holds/:id/release` (`note`, defaulting to `by the owner`)
    - `/admin/messages/:id/force-ack` (`agent`) and `/admin/messages/:id/withdraw`
    - `/admin/events/:id/approve` (`agent`)
  - Every view goes through `hono/html`, so values are escaped.

- [ ] **Step 1: Write the failing tests:**

```ts
it('pages redirect to login without a cookie; a wrong password does not set one', async () => {});
it('a forged or expired cookie is refused; a foreign Origin POST is refused', async () => {});
it('force-release of a blocking hold lets the next merge-check through and logs actor admin', async () => {});
it('force-ack of a blocking hold records the ack but the merge stays blocked', async () => {});
it('approve-for records responded_by admin and the merge becomes allowed in its window', async () => {});
it('a message to all shows each recipient separately with deferral and escalation', async () => {});
it('agent-supplied text is HTML-escaped on every page', async () => {});
it('schedule fragment for a -06:00 browser day includes a slot stored as 03:00Z the next UTC day', async () => {});
```

- [ ] **Step 2: Run** `npm test -w service -- admin`. Expected: FAIL.
- [ ] **Step 3: Implement**, with plain inline CSS.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(service): admin login and project overview`.

---

### Task 17: Admin content, settings and repositories

**Files:**
- Create: `service/test/admin-content.test.ts`
- Modify: `service/src/admin/{routes,views}.ts`

**Interfaces:**
- Produces pages and actions, all going through the domain functions with actor `admin`:
  - per project: all messages; to-dos (edit, delete); calendar (add, move, cancel); scratchpad (edit an entry, clear all); documents (view versions, delete); agents and tokens (create with the token shown once, assign, reissue, revoke); repositories (add, remove, with GitHub App installed yes/no, last status time and last error); webhooks (add with the secret shown once, remove); settings (approvals required, approval window in minutes)
  - across projects: create, rename and archive projects, and the owner `notify_url`, with a "Send test notification" button that POSTs a test message

- [ ] **Step 1: Write the failing tests:**

```ts
it('creating an agent shows the token once; no later page contains it', async () => {});
it('turning approvals on makes an unscheduled merge-check return no_slot', async () => {});
it('the repository page shows a GitHub status error recorded by runStatusJobs', async () => {});
it('archiving a project hides it from whoami but keeps its data', async () => {});
it('the test notification POSTs to notify_url', async () => {});
```

- [ ] **Step 2: Run** `npm test -w service -- admin-content`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(service): admin content, settings, repositories`.

---

### Task 18: Installer, launch wrapper, bundle, docs

**Files:**
- Create: `hooks/build.mjs`, `hooks/src/install.ts`, `hooks/test/install.test.ts`, `docs/agent-instructions.md`, `docs/setup.md`, `docs/rollout.md`

**Interfaces:**
- Produces:
  - `npm run build -w hooks` bundles everything into `hooks/dist/echo-hook.mjs` (esbuild, platform node, target node20, no externals).
  - `node echo-hook.mjs install --url <url> --agent <name> [--default] [--settings <path>]`:
    1. Reads the token from stdin, never from argv, so it is not left in the shell history.
    2. Verifies the token with `GET /api/v1/repos`, which also gives the gated list. A failed verification aborts with no changes made.
    3. Writes the gate cache.
    4. Stores the token with `writeToken`.
    5. Copies the bundle to `~/.echo/echo-hook.mjs`.
    6. Merges the agent name into `~/.echo/config.json`.
    7. Writes `~/.echo/echo-claude`, mode 0755. This `sh` wrapper takes an agent name, reads the token with `node ~/.echo/echo-hook.mjs token "$1"`, exports `ECHO_AGENT` and `ECHO_TOKEN`, shifts, and runs `exec claude "$@"`.
    8. Merges these hook entries into the user settings file, without duplicates and without changing other entries:

       | Event | Matcher | Argument | Timeout |
       |---|---|---|---|
       | `SessionStart` | (none) | `session-start` | |
       | `UserPromptSubmit` | (none) | `prompt` | |
       | `PostToolUse` | `*` | `post-tool` | |
       | `PostToolUse` | `Bash` | `post-bash` | |
       | `PreToolUse` | `Bash` | `pre-bash` | 30 s |
       | `Stop` | (none) | `stop` | |
    9. Prints the MCP command to run once, quoted so that the literal `${ECHO_TOKEN}` is stored rather than the token: `claude mcp add --transport http --scope user echo <url>/mcp --header 'Authorization: Bearer ${ECHO_TOKEN}'`. It then says to launch orchestrators with `~/.echo/echo-claude <name>`.
  - `token <name>` prints the token (used by the wrapper). `set-token <name>` reads a new token from stdin, for rotation.
  - `docs/agent-instructions.md` (spec 10.4) covers: when to send, when to place a hold and which kind, approving and objecting, deferring rather than acknowledging, that long content goes in a document, that the clock to trust is Echo's, and that subagents report holds to their orchestrator.
  - `docs/setup.md` (spec 10.5) covers:
    - deploying, secrets and `PUBLIC_URL`
    - creating the GitHub App: permissions "Commit statuses: write" and "Pull requests: read", the subscription to "Pull request" events, the webhook URL `<url>/github/webhook` with its secret, converting the key with `openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-pkcs8.pem`, and installing the App on the registered repositories
    - adding `echo/hold` as a required check in each repository's rules, and removing the bypass for the agents' GitHub identity (including admin bypasses in existing rulesets)
    - creating a project, a repository and an agent
    - `notify_url` (with ntfy as the example)
    - installing on a machine, and rotating a token
    - the override
    - the warning that launchers of subagent sessions must not pass `ECHO_AGENT` or `ECHO_TOKEN` on
    - the known limits
  - `docs/rollout.md` is spec section 13 as a checklist.

- [ ] **Step 1: Write the failing tests:**

```ts
it('install merges hooks without disturbing existing settings and is idempotent', async () => {});
it('install aborts without changes when the token is refused', async () => {});
it('no file written by install contains the token (file store excepted)', async () => {
  await runInstall(args, { stdin: TOKEN });
  for (const f of [settings, configJson, wrapper]) expect(readFileSync(f, 'utf8')).not.toContain(TOKEN);
});
it('the printed MCP command contains the literal ${ECHO_TOKEN}, not the token', async () => {});
it('the bundle runs with no node_modules present', async () => {});
```

- [ ] **Step 2: Run** `npm test -w hooks -- install`. Expected: FAIL.
- [ ] **Step 3: Implement**, and write the three docs.
- [ ] **Step 4: Run** `npm run build -w hooks && npm test -w hooks`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(hooks): installer, launch wrapper, bundle, docs`.

---

### Task 19: End-to-end scenarios (spec section 11)

**Files:**
- Create: `scripts/e2e.mjs`, `scripts/fake-github.mjs`

**Interfaces:**
- Consumes: everything. The script:
  - starts `scripts/fake-github.mjs` on a free port (the same routes as `test/fake-github.ts`, plus `POST /repos/:o/:r/pulls/:n/merge`, which refuses with 405 when the latest `echo/hold` status for the head is missing or failing, standing in for GitHub's required check)
  - starts `wrangler dev --local --persist-to <tmp>` with `GITHUB_API_URL` pointed at the fake, test secrets, and a generated App key
  - seeds agents A and B, a project and `acme/app` through the admin routes
  - drives `hooks/dist/echo-hook.mjs` with hook JSON on stdin (`ECHO_HOME` in a temp directory, `ECHO_TOKEN_STORE=file`, the fake `gh` on `PATH`) and the MCP tools over JSON-RPC
  - sends signed `pull_request` webhooks to the Worker
  - triggers the cron through `wrangler dev`'s `/__scheduled` endpoint
  - prints `PASS n name` or `FAIL n name: detail` for each scenario, and exits non-zero on any failure

- [ ] **Step 1: Write scenarios 1–18** as spec section 11 states them:
  - Scenario 5 checks that the fake GitHub refuses `PUT .../merge` while the hold is open and accepts it after release, and that a `synchronize` with a new SHA while the Worker is stopped leaves the merge refused.
  - Scenario 10 points `notify_url` at a local listener.
  - Scenario 11 stops the dev server mid-run.
  - Scenario 15 restarts it on the same `--persist-to` directory.
  - Scenario 17 runs `pre-bash` and the message hooks with `agent_id` set.
- [ ] **Step 2: Run** `npm run e2e`. Expected: all 18 `PASS`. Fix any failure in the owning task's module, adding a unit test that reproduces it first.
- [ ] **Step 3: Commit** with the message `test: end-to-end scenarios from the design`.

---

### Task 20: Deploy and live verification (owner go-ahead required)

**Files:**
- Modify: `service/wrangler.jsonc` (the real `database_id` and `PUBLIC_URL`), `docs/setup.md` (results)

- [ ] **Step 1: Stop and ask the owner** for the go-ahead to use their Cloudflare account (on the Workers Paid plan) and their GitHub account (to create the App and change repository rules). Do nothing in either account before they answer.
- [ ] **Step 2: Deploy the Worker.** The commands, in order:
  - `wrangler d1 create echo`
  - `wrangler d1 migrations apply echo --remote`
  - `wrangler secret put` for `ADMIN_PASSWORD`, `SESSION_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET`
  - `wrangler deploy`

  Expected: `GET <url>/health` returns `ok: true`.
- [ ] **Step 3: Set up the GitHub App** by following `docs/setup.md` with the owner, on a throwaway test repository first. Register the repository in Echo, then open a test PR. Expected: the PR shows `echo/hold` as `success`.
- [ ] **Step 4: Live GitHub checks** on that test PR, with `echo/hold` a required check:
  1. With a blocking hold placed, merging through `gh api -X PUT repos/<owner>/<test-repo>/pulls/N/merge` is refused by GitHub.
  2. With the owner's agent identity listed as a bypass actor, try `gh pr merge` without and with `--admin`, and record what GitHub allows. Then remove the bypass and repeat.
  3. Release the hold. The status turns `success` and the merge goes through.

  Record the results in `docs/setup.md`.
- [ ] **Step 5: Remote document check.** Save a document of exactly 1,048,576 bytes (the spec §6.8 cap of 1 MB) through `echo_doc_save` and read it back with `echo_doc_get`. Expected: the length and content match. Then save 1,048,577 bytes. Expected: refused with `DOCUMENT_TOO_LARGE`. The cap is what answers the spec §12 headroom question: no document is larger than 1 MB, so a 1,500,000-byte save is refused by design and is not a test. If the 1,048,576-byte save or read fails, stop and report: the 1 MB limit then needs revisiting.
- [ ] **Step 6: MCP connect check.** Run the installer's `claude mcp add` command (with the literal `${ECHO_TOKEN}`), launch with `~/.echo/echo-claude <name>`, and call `echo_whoami`. Expected: it returns the name. If Claude Code does not expand the variable, switch the installer to Claude Code's command-based MCP header mechanism, re-test, and record which one works.
- [ ] **Step 7: `bypassPermissions` check, run by the owner** (the permission classifier blocks an agent from launching one). With a hold on the test PR, the owner runs `~/.echo/echo-claude <name> --permission-mode bypassPermissions` and asks it to merge the PR. Record whether the hook refused it. If it did not, add a prominent warning to `docs/setup.md`. GitHub's required check still refuses the merge either way.
- [ ] **Step 8: Run the end-to-end scenarios against the deployed Worker** in remote mode, with the admin password in the environment (it is never printed):

  `E2E_URL=<url> E2E_ADMIN_PASSWORD=<password> npm run e2e -- --only 1,3,6,12,13`

  Expected: `PASS` for each, `5/5 scenarios passed`, and a `Remote cleanup:` line that removed 3 repositories, revoked the agents and archived the three `e2e-<timestamp>` projects, with no `CLEANUP FAILED` line. Remote mode works in throwaway projects `e2e-<timestamp>`, `e2e-<timestamp>-approvals` and `e2e-<timestamp>-private`, with its own agents and repositories (`e2e-<timestamp>/app` and so on, which do not exist on GitHub), and does not start wrangler.

  Remote mode supports scenarios 1, 2, 3, 4, 6, 7, 8, 9, 12, 13, 14, 16, 17 and 18 (run without `--only`, all of them run). In those it skips, and prints, the parts that need the Worker's GitHub calls to reach the run's fake GitHub (the opened and synchronize webhooks, waiting for `echo/hold` statuses, and GitHub's required check on a merge: Step 4 covers those on the real GitHub), the scenario 3 part with PR #30 (a slot moved 31 minutes back in the local D1, and the status cron), and the scenario 9 part where the deferral runs out (a local D1 edit). It skips scenarios 5 (GitHub enforcement), 10 (escalation: local D1, `/__scheduled`, a local listener, and it would change the owner's `notify_url`), 11 (it stops the Worker) and 15 (it restarts the Worker), and says so with `SKIP`.
- [ ] **Step 9: Commit** with the message `chore: deploy configuration and live verification notes`. Then hand over to `docs/rollout.md`, which the owner runs with both orchestrators.
