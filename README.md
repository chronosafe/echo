# Echo

Echo is a coordination service for AI coding agents. It gives several Claude Code agents, running on different machines or accounts, one reliable place to:

- send each other messages that must be read and acknowledged,
- put a **hold** on a pull request so no agent merges it until the problem is fixed,
- schedule merges and require approval before they happen,
- share to-dos, an append-only scratchpad and versioned documents per project.

Holds are **enforced**, not just announced. A Claude Code hook checks every `gh pr merge` against Echo before it runs and refuses it if the PR is held or unapproved. An optional GitHub App adds an `echo/hold` status check, so GitHub itself refuses the merge however it is attempted.

Echo runs as a single Cloudflare Worker with a D1 (SQLite) database. It is sized for tens of agents and a handful of projects, and the design target is a running cost of a few dollars a month at most.

## Why it exists

Agents that coordinate through general-purpose chat threads or shared notes fail in quiet ways:

- A message is refused or dropped, and the sender can't tell whether it landed.
- An agent loses track of a conversation after a restart or a context compaction.
- The same information is copied into two places, and the copies drift apart.
- A reviewer says "don't merge this yet", but the agent doing the merge never sees it.

The incident Echo was designed around: a reviewing agent had a blocking finding on a PR. Its warning didn't get through, and the merging agent merged the PR twenty minutes before the warning arrived. Echo is built so that sequence can't happen:

- Every message is either stored or refused with a reason the sender can act on.
- Delivered and acknowledged are separate states.
- An agent can't end its turn while a message it must acknowledge is waiting.
- A hold blocks the merge itself, at the moment of the merge, instead of relying on the merging agent to remember to look.

## How it works

```
 ┌──────────── each agent's machine ────────────┐          ┌──────── Cloudflare ────────┐
 │                                              │   MCP    │                            │
 │  Claude Code ── echo_* tools ────────────────┼─────────▶│  /mcp                      │
 │      │                                       │          │                            │
 │      └─ hooks (~/.echo/echo-hook.mjs) ───────┼─────────▶│  /api/v1  (hook API)       │  Echo Worker
 │          • new-message notices               │  HTTPS   │                            │  + D1 database
 │          • merge check before gh pr merge    │          │  /admin   (owner's page)   │  + 1-minute cron
 │          • stop check for unacked messages   │          │                            │
 └──────────────────────────────────────────────┘          │  /github/webhook ◀─────────┼── GitHub App (optional)
                                                           └─────────────┬──────────────┘
                                                                         │ echo/hold commit status
                                                                         ▼
                                                                       GitHub
```

There are two parts:

1. **The service** (`service/`): a Cloudflare Worker that stores everything in D1 and serves four things:
   - an **MCP server** at `/mcp`, which gives agents the `echo_*` tools;
   - a small **hook API** at `/api/v1`, used by the Claude Code hooks;
   - an **admin page** at `/admin`, where the owner manages projects, agents and repositories and can see and correct everything;
   - a **GitHub webhook** at `/github/webhook`, plus a cron job that runs every minute for status retries, approval windows, escalations and outgoing webhooks.
2. **The hooks** (`hooks/`): a small Node CLI, bundled into one file and installed on each agent's machine. It registers Claude Code hooks:

   | Hook | What it does |
   |---|---|
   | `SessionStart` | Tells the agent who it is in Echo and what is waiting for it. |
   | `UserPromptSubmit`, `PostToolUse` | Show new messages as they arrive, while the agent is working. |
   | `PreToolUse` (Bash) | The **merge check**: parses the command, and if it merges a PR in a registered repository, asks Echo whether the merge is allowed. Held, unapproved or unparseable merges are refused with the reason. |
   | `PostToolUse` (Bash) | Reports a completed merge to Echo. |
   | `Stop` | Keeps the agent working while a message it must acknowledge is unanswered (at most once per message). |

   The CLI also has an `install` command, a `set-token` command for token rotation, a `wait` command that wakes an idle agent when a message arrives, and the MCP headers helper that supplies each session's token to Claude Code.

### Concepts

- **Owner**: the one human admin. Signs in to `/admin` with a password.
- **Project**: a group of agents and repositories that work together. Messages, holds, to-dos and the rest belong to a project.
- **Agent**: an orchestrating Claude Code session with a stable name and a bearer token. An agent sees only the projects it is assigned to. Only orchestrators act in Echo; their subagents report to them.
- **Message**: up to 8 KB, addressed to agents or to `all`. It can require an acknowledgement, and it can escalate to the owner if nobody answers in time. A recipient can acknowledge it or defer it with a reason. A `request_id` makes a send safe to retry.
- **Hold**: placed on `owner/repo#PR`.
  - A **blocking** hold refuses the merge until its placer or the owner releases it.
  - An **advisory** hold only needs to be acknowledged by another agent.
- **Calendar and approvals**: a project can require that merges are scheduled in a slot and approved. A merge is allowed only inside the approved slot's window, 30 minutes either side by default.
- **To-dos, scratchpad, documents**: shared project items.
  - To-dos can be claimed and released.
  - The scratchpad is append-only.
  - Documents are versioned and limited to 1 MB.
- **Shared data**: small named key/value entries for facts that more than one agent reads or acts on.
  - Every entry is versioned. A write is a compare-and-set: it names the `expected_version` and is refused with `VERSION_CONFLICT`, carrying the current state, if the entry has moved on.
  - `echo_data_batch` applies up to 25 `put`, `delete` and `check` operations atomically, all or none.
  - An entry can have a single owner, who alone may change or delete it, until released.
  - Writes accept a `request_id`, so a retry after a dropped connection returns the first result instead of a conflict with itself.
  - Every version is kept and readable through `echo_data_history`, and the admin site has Shared data pages for browsing entries and their history.
- **Change log**: every state change is recorded in the same database transaction as the change itself. The admin log, `echo_changes_since` and outgoing signed webhooks are all built from it.
- **Notifications**: escalations and approval requests are posted to a URL you choose, in [ntfy](https://ntfy.sh) format.

### MCP tools

| Area | Tools |
|---|---|
| Identity | `echo_whoami`, `echo_changes_since` |
| Messages | `echo_send_message`, `echo_inbox`, `echo_ack_message`, `echo_defer_message`, `echo_withdraw_message`, `echo_message_status` |
| Holds | `echo_place_hold`, `echo_release_hold`, `echo_ack_hold`, `echo_list_holds` |
| Calendar and approvals | `echo_calendar_add`, `echo_calendar_update`, `echo_calendar_cancel`, `echo_calendar_list`, `echo_pending_approvals`, `echo_approve_merge`, `echo_object_merge` |
| To-dos | `echo_todo_add`, `echo_todo_claim`, `echo_todo_release`, `echo_todo_complete`, `echo_todo_list` |
| Scratchpad | `echo_scratchpad_append`, `echo_scratchpad_read` |
| Documents | `echo_doc_save`, `echo_doc_get`, `echo_doc_list`, `echo_doc_versions` |
| Shared data | `echo_data_put`, `echo_data_get`, `echo_data_list`, `echo_data_history`, `echo_data_delete`, `echo_data_batch` |

Echo stamps every record with its own clock; agents never supply times. Every refusal carries a stable code (for example `DOCUMENT_TOO_LARGE`), a sentence saying what was wrong, and what to do instead.

## Repository layout

```
.
├── service/                  Cloudflare Worker (TypeScript, Hono, D1)
│   ├── src/
│   │   ├── index.ts          Routes, webhook entry point and the 1-minute cron
│   │   ├── mcp/              MCP server and the echo_* tool definitions
│   │   ├── api/hooks.ts      Hook API: orient, poll, peek, stop-check, merge-check, merge-report, …
│   │   ├── admin/            Admin page: sign-in, routes, server-rendered views
│   │   ├── domain/           Business rules: agents, projects, messages, holds, calendar,
│   │   │                     approvals, to-dos, scratchpad, documents, change log, webhooks, escalation
│   │   └── github/           GitHub App auth, the echo/hold status writer, webhook handling
│   ├── migrations/           D1 schema (applied with wrangler d1 migrations apply)
│   ├── test/                 Vitest tests run inside the Workers runtime
│   └── wrangler.jsonc        Worker configuration
├── hooks/                    Claude Code hook CLI
│   ├── src/                  Merge-command parser, hook handlers, install, token store, waiter
│   ├── test/
│   └── build.mjs             Bundles everything into dist/echo-hook.mjs
├── scripts/
│   ├── e2e.mjs               End-to-end scenarios against a local Worker and the real hook bundle
│   ├── fake-github.mjs       Fake GitHub API used by the end-to-end run
│   └── check-peers.mjs       Checks dependency peer versions
├── LICENSE                   MIT
└── docs/
    ├── setup.md              Full setup and operations guide (deploy, GitHub App, install, limits)
    ├── agent-instructions.md The block to paste into each orchestrator's CLAUDE.md
    ├── rollout.md            Checklist for moving a team of agents onto Echo
    └── superpowers/          Design document, design review and build plan
```

## Installation

You need:

- a Cloudflare account (the free plan works) and Node.js 20 or later;
- on each agent's machine: Node.js 20 or later, Claude Code and the GitHub CLI (`gh`);
- optionally, a GitHub account where you can create a GitHub App, for the `echo/hold` status check.

The steps below are a summary. [`docs/setup.md`](docs/setup.md) has the full detail, including token rotation, the emergency override and the known limits.

### 1. Get the code and test it

```sh
git clone <this repository> echo && cd echo
npm ci
npm test                       # service and hook unit tests
npm run build -w hooks         # writes hooks/dist/echo-hook.mjs
```

### 2. Deploy the service

Run these from `service/` (`cd service`), where `wrangler.jsonc` is.

1. Sign in to Cloudflare: `npx wrangler login`.
2. Create the database: `npx wrangler d1 create echo`. Put the `database_id` it prints into `wrangler.jsonc`, replacing `REPLACE_WITH_YOUR_D1_DATABASE_ID`. (To keep your values out of git, put them in a copy named `wrangler.local.jsonc` instead, which is ignored, and add `-c wrangler.local.jsonc` to the commands below. See [`docs/setup.md`](docs/setup.md).)
3. In `wrangler.jsonc`, set `PUBLIC_URL` to your Worker's address, with no trailing slash, for example `https://echo.<your-subdomain>.workers.dev`. The admin page, GitHub status links and the installer's printed commands all use it.
4. Set the two required secrets:
   ```sh
   npx wrangler secret put ADMIN_PASSWORD    # the admin page password
   npx wrangler secret put SESSION_SECRET    # a long random string, e.g. from: openssl rand -hex 32
   ```
5. Apply the schema and deploy:
   ```sh
   npx wrangler d1 migrations apply echo --remote
   npx wrangler deploy
   ```
6. Check `https://<your-worker>/health` returns `{"ok":true,…}`, then open `/admin` and sign in.

### 3. Set up a project

On the admin page:

1. **Create a project.** Tick "Approvals required before a merge" if merges must be scheduled and approved.
2. **Register repositories** as `owner/name`. A repository belongs to exactly one project, and only registered repositories are gated by the merge check.
3. **Create an agent** for each orchestrator, give it a stable name and assign it to the project. Copy its token: it is shown once, but you can reissue it.
4. Optionally, set `notify_url` in the owner settings (for example `https://ntfy.sh/<your-private-topic>`) so Echo can tell you when a message or approval goes unanswered. Use "Send test notification" to check it.

### 4. Install on each agent's machine

From a checkout with the hook built (step 1), pipe the agent's token in on stdin, so it stays out of your shell history:

```sh
read -rs T && printf %s "$T" | node hooks/dist/echo-hook.mjs install --url https://<your-worker> --agent <name>; unset T
```

`install` does the following:

- checks the token with Echo first, and changes nothing if the check fails;
- stores the token in the macOS Keychain, or in a `0600` file under `~/.echo/tokens` on other systems;
- copies the bundle to `~/.echo/echo-hook.mjs` and writes the `~/.echo/echo-claude` launcher and the `~/.echo/echo-mcp-headers` helper;
- adds Echo's hook entries to `~/.claude/settings.json`, leaving your other entries alone.

The token is never written to `settings.json`, `.mcp.json`, `~/.claude.json` or `~/.echo/config.json`. Running `install` again is safe.

Then:

1. **Connect the MCP tools** with the command `install` prints:
   ```sh
   claude mcp add-json echo '{"type":"http","url":"https://<your-worker>/mcp","headersHelper":"'"$HOME"'/.echo/echo-mcp-headers"}' --scope user
   ```
   If an `echo` server is already registered, run `claude mcp remove echo -s user` first.
2. **Allow Echo's tools** by adding `mcp__echo__*` to the allow list in `~/.claude/settings.json` (or with `/permissions`). Without it, auto mode may block acknowledgements, which stalls the workflow.
3. **Launch the orchestrator** as its agent:
   ```sh
   ~/.echo/echo-claude <name>
   ```
   A launcher that can't use that wrapper can start plain `claude` with `ECHO_AGENT=<name>` in the session's environment instead.
4. **Check the connection** by asking the session to call `echo_whoami`. It should return the agent's name.
5. **Give the agent its instructions**: paste the block from [`docs/agent-instructions.md`](docs/agent-instructions.md) into the CLAUDE.md of the project it works in.

Sessions that a launcher starts as helpers must not inherit `ECHO_AGENT` or `ECHO_TOKEN`. A session without them has no Echo identity and runs only the merge check.

### 5. Optional: make GitHub enforce holds

Without a GitHub App, Echo works fully, and the hook refuses held and unapproved merges on every machine where it is installed. Some merges still get through:

- merges made on the GitHub website or through the API;
- merges from a machine without the hook;
- the few command forms the hook can't parse.

To close those gaps, follow "Create the GitHub App" and "Make `echo/hold` a required check" in [`docs/setup.md`](docs/setup.md). In brief:

1. Create a GitHub App with two permissions, "Commit statuses: write" and "Pull requests: read". Subscribe it to the "Pull request" event, with the webhook URL `https://<your-worker>/github/webhook`.
2. Convert its private key to PKCS#8 (`openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-pkcs8.pem`), then set the three secrets: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET`.
3. Install the App on each registered repository.
4. Make `echo/hold` a required status check, and make sure the agents' GitHub identity can't bypass it.

Until the App is configured, the admin home page says that statuses are off. Statuses that would have been sent stay queued and go out once the secrets are set.

## Development

```sh
npm test                                   # all unit tests (service runs inside the Workers runtime)
npm run typecheck -w service
npm run typecheck -w hooks
npm run e2e                                # end-to-end scenarios, fully local
npm run e2e -- --only 1,3                  # selected scenarios
```

The end-to-end run starts the Worker under `wrangler dev --local` with a throwaway database and a fake GitHub. It drives the real hook bundle with fake `gh` and `claude` commands, in temporary home directories, so it never touches your real `~/.claude`, `~/.echo`, Keychain or GitHub. It can also run against a deployed Worker (see `scripts/e2e.mjs`), but that uses your live database, so do it only when you need to.

To run the Worker locally by hand, put `ADMIN_PASSWORD` and `SESSION_SECRET` in `service/.dev.vars`, then:

```sh
cd service
npx wrangler d1 migrations apply echo --local
npx wrangler dev --local
```

Some rules the codebase follows:

- Every state change and its change-log entry are written in one D1 batch, which is one transaction.
- Conditional updates use guarded statements (`WHERE changes() > 0`) instead of check-then-act.
- All HTML is rendered through escaping templates.
- Tests never touch real GitHub, the real home directory or a deployed Worker.

## Limits and security notes

- **The merge check is a guard against accidents, not against a determined adversary.** It recognises `gh pr merge` commands in their plain form and refuses anything that looks like a merge it cannot read exactly. It doesn't see merges made through the website, `gh` aliases, scripts, or commands assembled at runtime. The required `echo/hold` check is the backstop. The full list is under "Known limits" in [`docs/setup.md`](docs/setup.md).
- **If Echo can't be reached, merges in gated repositories are refused.** There is a one-time, 30-minute, single-PR override for outages.
- **Tokens are bearer tokens.** Treat them like passwords, and reissue one from the admin page if it leaks.
- **Echo has one admin**, the owner, signed in with a password. Sign-in attempts are rate-limited.
- **An idle agent sees nothing until its next hook runs.** The `wait` command can wake it when a reply arrives, as long as the app that runs it stays open.

## Design documents

The design, the review that shaped revision 2, and the build plan are in [`docs/superpowers/`](docs/superpowers/). They explain why each rule exists, for example why an acknowledgement is separate from delivery, why silence is never approval, and why a hold blocks at the moment of the merge.

## License

MIT. See [`LICENSE`](LICENSE).
