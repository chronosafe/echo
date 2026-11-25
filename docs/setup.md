# Echo setup

Notes for the owner. Do the steps in order. Echo has two parts: a Cloudflare Worker (`service/`) and a hook CLI that runs on each orchestrator's machine (`hooks/`).

## Deploy

Run every `npx wrangler` command in this file from the `service/` directory (`cd service` first): that is where `wrangler.jsonc` is.

1. Create the D1 database and put its id in `service/wrangler.jsonc` (`database_id`).
2. Set `PUBLIC_URL` in `service/wrangler.jsonc` to the address the Worker will have, with no trailing slash. The admin page, the GitHub status links and the installer's MCP command all use it.
3. Set the secrets:
   - `npx wrangler secret put ADMIN_PASSWORD`: the admin page password.
   - `npx wrangler secret put SESSION_SECRET`: a long random string.
   - `npx wrangler secret put GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET`, after the next section.
4. Apply the migrations and deploy, from `service/`: `cd service`, then `npx wrangler d1 migrations apply echo --remote`, then `npx wrangler deploy`. The migrations must be applied BEFORE `npx wrangler deploy` every time: new code can rely on a column or index that only the migration creates (`0002_message_request_id.sql` adds `messages.request_id`, which `echo_send_message` uses; `0003_shared_data.sql` adds the tables the `echo_data_*` tools and the admin Shared data pages read and write).
5. Open `<url>/admin` and sign in with the password.

The committed `wrangler.jsonc` holds placeholders (`REPLACE_WITH_YOUR_D1_DATABASE_ID` and `https://echo.example.workers.dev`). To keep your own deployment's values out of the repository, copy it to `service/wrangler.local.jsonc`, which git ignores, put your `database_id` and `PUBLIC_URL` there, and add `-c wrangler.local.jsonc` to every command that reaches your account: `npx wrangler d1 migrations apply echo --remote -c wrangler.local.jsonc`, `npx wrangler deploy -c wrangler.local.jsonc`, and the same for `secret put` and `d1 execute --remote`. The tests and the local end-to-end run use `wrangler.jsonc` as it is.

`preview_database_id` in `wrangler.jsonc` is the storage that `wrangler dev --local`, the tests and the local end-to-end run use; it never touches the deployed database.

Echo runs without the GitHub secrets. Until the App is set up, the hook still refuses held and unapproved merges on every machine where it is installed, but Echo sends no `echo/hold` status, so merges through the GitHub website or API are not blocked. The admin home page says so. Statuses that would have been sent stay queued, and the cron sends them once you set the App's secrets (up to 30 per minute).

### Live verification

The first deploy (2026-11-19, Cloudflare only, no GitHub App yet) was checked with:

- `GET <url>/health` returns `ok: true`.
- The end-to-end run in remote mode (`E2E_URL=<url> E2E_ADMIN_PASSWORD=… npm run e2e`): 14 of 14 remote scenarios passed, the other 4 skipped as remote mode does, and the cleanup archived its throwaway projects.
- A 1,048,576-byte document saved and read back identical; 1,048,577 bytes were refused with `DOCUMENT_TOO_LARGE`.

- A real Claude Code session, installed with `install --url <url>`, connected with the earlier MCP command (a `--header` of the literal `${ECHO_TOKEN}`, since replaced by the `headersHelper` below) and launched with `~/.echo/echo-claude <name>`: `echo_whoami` returned its name. The `headersHelper` connection has not been checked live yet.

Still to check: the GitHub App and the required `echo/hold` check (the next two sections).

The remote end-to-end run's cleanup deletes its throwaway projects (after archiving them) and then its revoked agents, so a remote run leaves nothing behind. Checked live on 2026-11-19: a remote run of scenario 1 left no `e2e-` projects, agents, repositories or log entries, and the owner's own project and agent were untouched. Run the remote end-to-end tests against the live site only when you need to: they work on the same database as your real projects.

## Create the GitHub App

Echo reports an `echo/hold` status on pull requests so that GitHub itself refuses a merge that Echo would refuse.

1. In GitHub, create an App with these repository permissions:
   - Commit statuses: write
   - Pull requests: read
2. Subscribe it to the "Pull request" event.
3. Set the webhook URL to `<url>/github/webhook` and set a webhook secret. Use the same value for `GITHUB_WEBHOOK_SECRET`.
4. Generate a private key. GitHub gives a PKCS#1 `.pem`; the Worker needs PKCS#8. Convert it:

   `openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-pkcs8.pem`

   Store the converted file, from `service/`, with `npx wrangler secret put GITHUB_APP_PRIVATE_KEY < /path/to/key-pkcs8.pem`. Set `GITHUB_APP_ID` to the App's id.
5. Install the App on each repository you register in Echo.

## Make `echo/hold` a required check

For each registered repository:

1. Add `echo/hold` as a required status check in the repository's rules (a ruleset or branch protection).
2. Remove any bypass for the agents' GitHub identity. A bypass lets an agent merge past a failing `echo/hold`. Check existing rulesets too: a ruleset that lets repository admins bypass it lets an agent that acts as an admin merge past `echo/hold`.

## Create a project, a repository and an agent

On the admin page:

1. Create a project. Tick "Approvals required before a merge" if its merges need a scheduled, approved slot. The approval window defaults to 30 minutes either side of the slot.
2. Register each repository as `owner/name` under exactly one project.
3. Create an agent with a stable name, assign it to its projects, and copy the token. It is shown once. You can reissue it later.

Archiving a project keeps its data. Once a project is archived (its repositories removed first), "Delete permanently" on its Settings page removes the project and all its messages, holds, calendar, to-dos, scratchpad, documents and log; it cannot be undone. A revoked agent can then be deleted from the "Revoked agents" list on the admin home page, but only when no project or record still refers to it, so delete its projects first.

## Notifications

Set `notify_url` in the owner settings to a URL that accepts a POST in ntfy's format. Example: `https://ntfy.sh/your-private-topic`. Echo posts there when a message or an approval request goes unanswered past its escalation time. Use "Send test notification" to check it. With no `notify_url`, Echo cannot alert you.

## Install on a machine

Needs Node 20 or later and `gh`. Build the bundle once with `npm run build -w hooks`, which writes `hooks/dist/echo-hook.mjs`. Then, on each orchestrator's machine, pipe the token in. It is read from stdin so it stays out of your shell history and `ps`:

`pbpaste | node hooks/dist/echo-hook.mjs install --url <url> --agent <name> [--default] [--settings <path>]`

Install:

- checks the token against Echo and fetches the gated repository list; if the check fails, nothing is changed
- stores the token in the macOS Keychain (service `echo`), or in a 0600 file under `~/.echo/tokens` elsewhere
- copies the bundle to `~/.echo/echo-hook.mjs`, writes the launch wrapper `~/.echo/echo-claude`, and writes the MCP headers helper `~/.echo/echo-mcp-headers`
- records the agent in `~/.echo/config.json` (no token) and adds the hook entries to `~/.claude/settings.json`, leaving other entries alone

The token is never written to `settings.json`, `.mcp.json`, `~/.claude.json` or `config.json`.

`--default` makes this agent the machine's default identity for the merge check. Without it, the first agent installed becomes the default.

Install prints the commands that connect the MCP tools. Run them once:

```
claude mcp remove echo -s user      # only if an echo server already exists
claude mcp add-json echo '{"type":"http","url":"<url>/mcp","headersHelper":"<home>/echo-mcp-headers"}' --scope user
```

No token is stored in Claude Code's config. On every connect and reconnect Claude Code runs the `headersHelper` script, which runs `node echo-hook.mjs mcp-headers`. That prints `{"Authorization":"Bearer <token>"}` for the agent named in `ECHO_AGENT`, and `{}` in every other case: `ECHO_AGENT` unset, a name not in `config.agents`, no stored token, or no config. It never falls back to the default agent, so a session with no `ECHO_AGENT` has no Echo identity. The token comes from `ECHO_TOKEN` when set, otherwise from the Keychain or `~/.echo/tokens`. Claude Code gives the helper 10 seconds.

There are two ways to launch an orchestrator, and both work with the same MCP entry:

- `~/.echo/echo-claude <name>` sets `ECHO_AGENT` and `ECHO_TOKEN` and starts `claude`.
- A launcher that cannot use `echo-claude` starts plain `claude` and sets `ECHO_AGENT=<name>` in that session's settings `env`. The helper reads the token from the store.

Put the block from `docs/agent-instructions.md` into the orchestrator's CLAUDE.md.

Allow Echo's tools in Claude Code's permissions, once per machine. Add `"permissions": {"allow": ["mcp__echo__*"]}` to the user settings file (`~/.claude/settings.json`), or run `/permissions` in Claude Code and add `mcp__echo__*` to the allow list. Without it, auto mode can block an Echo tool as a "destructive or unwanted action": the owner's test session had `echo_ack_message` blocked. An agent that cannot acknowledge, defer, approve, object or release stalls Echo's workflow, and its Stop hook keeps blocking it. Install does not do this for you: widening permissions is a choice you make deliberately.

Installing again is safe: it replaces Echo's own hook entries in place and leaves others alone. Every hook command and the wrapper and the helper name the absolute path of the Node that ran install. Install picks a path that survives upgrades when one exists: the `node` on your PATH, or Homebrew's `opt/node` link, as long as it is the same Node. It prints the path it chose, and warns when that path includes a version number (nvm, Volta, asdf, or a Homebrew Cellar path); then run install again after every Node upgrade. If that Node is gone, `echo-claude` says so, the helper prints `{}` (the session then has no Echo identity), and a hook that cannot start does not run.

If the hook cannot start on a machine (Node moved, upgraded or removed), Claude Code skips it: the merge check is not run there at all, and only GitHub's required `echo/hold` check protects merges from that machine. Run install again as soon as you change Node.

## Wake an idle agent

Hooks only fire while a session is busy, so an agent that has gone idle does not see a reply that arrives later. The installed hook program has a waiter for that: `ECHO_HOME="$HOME/.echo" node "$HOME/.echo/echo-hook.mjs" wait [--interval S] [--timeout S]` (the same `ECHO_HOME=… node … echo-hook.mjs` form the installed hook entries use). It reads `ECHO_AGENT` and the stored token like the other hook calls, asks Echo's read-only `peek` endpoint every `--interval` seconds (default 25, 5 to 300), and exits when something is waiting. It never delivers, marks or acknowledges a message, so the agent reads `echo_inbox` after it wakes. `--timeout` defaults to 14400 seconds (4 hours; 1 to 86400).

An agent starts it as a background task before going idle while a reply is expected. In Claude Code that is the Bash tool with `run_in_background`; the harness re-invokes the agent when the task exits. Exit codes:

- `0`: a message is waiting. One line with the count, ids and senders, never the text.
- `2`: configuration problem that will not fix itself: no `ECHO_AGENT`, an agent not in `config.json`, no config, no stored token, or a bad flag. Nothing is sent.
- `3`: timed out with nothing waiting. Start another waiter only if a reply is still expected.
- `4`: Echo refused the request (401, 403 or another 4xx other than 408, 425 and 429), for example a revoked token.
- `5`: a waiter for this agent is already running; the output gives its PID and the PID of the process that started it. Only one waiter runs per agent, using the lock file `wait-<agent>.lock` in the Echo home. The lock records the waiter's PID, its parent PID, the topmost shell above it (or `-`), the harness above that (or `-`) and a random nonce. A lock is taken over when its PID is dead, when its parent is dead or was PID 1, when its topmost shell is dead or no longer sits under the recorded harness, when its recorded harness is dead or is a real init (the waiter was started detached), or when it has not been touched for 15 minutes.
- `6`: the waiter stopped itself because nobody could be woken from it. Under Claude Code's Bash tool the waiter's parent is a `zsh -c` wrapper that survives a dead Claude, so at start the waiter walks up through consecutive shell ancestors (at most 8, found with `ps`) to the first non-shell process, which it treats as the harness (the Claude Code process, or the app that launched it). It exits at once if that harness is PID 1 on a real host (`launchd`, `init` or `systemd`), which means it was started detached, for example with `&` or `nohup`, even one shell deep. Before every request it checks that its parent is unchanged, that each shell in the chain still sits under the next, and that its lock is still its own. If the parent is not a shell (the harness started the waiter directly), only the parent is watched. If `ps` does not answer (it is tried twice at start), only the parent is watched. A harness that is PID 1 inside a container is accepted. Known limits: on Linux with a per-user subreaper (`systemd --user`) an orphaned shell is re-parented to that manager rather than PID 1, so a detached start one shell deep is not recognised there; and clearing a crashed starter's stale takeover mutex has a narrow window in which two starters can briefly both believe they hold it (the result is at worst a duplicate waiter or a skipped release, which the stale-lock rules recover from).
- 129, 130, 143: killed by a signal (hangup, interrupt, terminate). The lock is released on SIGINT and SIGTERM. A waiter killed harder than that is cleaned up by the rules above.

Network errors, 5xx, 408, 425 and 429 are retried with a growing pause until the timeout: it doubles from the interval, capped at 120 seconds (or at the interval, if that is longer), and a `Retry-After` from the service is honoured up to 300 seconds. After a sleep or suspend of more than 15 minutes, a lock looks stale by age (file times are wall-clock time) until its owner next touches it, so a second waiter that starts in that window can run alongside it. The first one notices the lost lock at its next check and exits 6. The waiter only works while the client app is running: if Claude Code (or the app that launched it) is closed, the background task ends with it and nothing wakes the agent. Like the other hook calls, it needs `ECHO_AGENT` set in the session, and subagents must not inherit it.

## Rotate a token

1. Reissue the token on the admin page.
2. On the machine, run `pbpaste | node ~/.echo/echo-hook.mjs set-token <name>`. It checks the new token with Echo before storing it, and a refused token is not stored.
3. Restart the orchestrator (through `echo-claude`, or the launcher that sets `ECHO_AGENT`).

## Subagent sessions

Launchers of subagent sessions must not pass `ECHO_AGENT` or `ECHO_TOKEN` on. `ECHO_AGENT` alone is enough to grant an identity: the MCP headers helper reads the token from the store for that name, so a session that inherits `ECHO_AGENT` acts as the orchestrator even without `ECHO_TOKEN`. Remove both variables in any tool that starts such sessions. A session without them has no Echo identity and runs only the merge check.

The hooks already skip message identity for subagents that Claude Code runs inside an orchestrator's session (`input.agent_id`), so this rule is about separate sessions a launcher starts.

## The override

If Echo is down, the merge check refuses merges in gated repositories. In that outage a human can start Claude Code with `ECHO_MERGE_OVERRIDE=owner/repo#N` in its environment. The override:

- applies only to the PR it names, and only while Echo cannot be reached
- works once
- expires 30 minutes after the hook first sees it
- is reported to Echo when it is reachable again

It cannot be set from inside a session, and it does not get past GitHub: a PR whose `echo/hold` status is failing, or has none yet, stays blocked there. In a long outage, remove `echo/hold` from the repository's required checks.

## Known limits

- A `gh api` call to a `pulls/N/merge` path, or one that sends the `mergePullRequest` or `enablePullRequestAutoMerge` GraphQL mutation, is refused. This includes a read-only `gh api …/pulls/N/merge` call. A `gh pr merge` behind a wrapper (`timeout`, `xargs`, `sudo`, `bash -c` …) or inside `$( )` or backticks is refused too, with a few exceptions behind a wrapper: a `-R` value that is a URL or a nested `$( )` (such as `-R "$(gh repo view …)"`), or a subcommand held in a variable (`timeout 5 gh pr $SUB 5`). Other API forms, merges made through the GitHub website, `gh` aliases, scripts, and commands assembled at runtime are not seen by the hook. The required `echo/hold` check is the backstop.
- `CDPATH`, and shell aliases or functions for `cd` or `gh` in the user's profile, can redirect a merge to a different repository than the hook checked.
- A command that mixes the phrase `gh pr merge` with other work is refused. Run the merge as its own command.
- Archiving a project requires removing its repositories first.
- When you remove a repository, also remove `echo/hold` from that repository's required checks. Otherwise open PRs keep their last status. A repository with open holds or open merge events cannot be removed: release the holds and cancel the merge events first.
- Echo knows a repository by its `owner/name`. After you rename a repository or transfer it to another owner on GitHub, register it again under the new name on the admin page, and remove the old name once its open holds and merge events are closed. Until you do, the hook treats the new name as ungated, and new commits get no `echo/hold` status, so GitHub's required check blocks their merge.
- If the hook cannot start on a machine (Node moved or removed), the merge check is skipped on that machine; only the required `echo/hold` check protects merges until install is run again.
- An idle agent sees nothing until its next hook, unless it started the waiter (see "Wake an idle agent") before going idle.
- On macOS the token is passed to `security add-generic-password` as an argument while it is stored, so it is briefly visible to other processes of the same user.
