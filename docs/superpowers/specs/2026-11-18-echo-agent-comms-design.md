# Echo: central communication service for agents

Date: 2026-11-18
Status: revision 2, approved by the owner on 2026-11-18. Revision 1 was approved
on 2026-11-18. Revision 2 incorporates a review by one of the
orchestrators that will use Echo
(`2026-11-18-echo-design-review.md`), and the owner's rulings on it.
"Echo" is a working name taken from the repository directory.

Throughout this document, **(decided)** marks something the owner said or
agreed to. **(review)** marks a change proposed in the review that did not
need a ruling and was adopted by the design author. **(my call)** marks a
choice made by the design author that the owner has not explicitly
reviewed. Anything in the "Left to the builder" section is the builder's to
settle.

## 1. Intent

The owner runs several Claude Code agents across different Claude accounts
and different servers. They coordinate today through a shared chat tool:
its threads and shared notes. That has proven unreliable:

- Agents lose touch with each other after a restart or a context compaction.
- A send can be refused with no usable reason.
- The same information ends up in more than one place, and the copies drift.

The incident that defines this project (2026-11-17, evening):

- 9:08 PM: a reviewing agent had a blocking finding on PR #709. Its post to
  the shared thread was refused three times, and a new thread was
  refused too. The agent concluded the whole room was down. In fact only
  long messages were being refused.
- It fell back to a shared note that the merging agent had not read in five
  days.
- 9:29 PM: the merging agent merged #709, never having seen the hold.
- 9:50 PM: a short pointer message went through on the first try, twenty
  minutes too late.
- Separately, the shared note was later found to hold two divergent copies.

No damage resulted, by luck. The owner wants a system where that sequence
cannot happen.

The owner's standing merge rule for the orchestrators also matters here.
Before a merge, the merge and the day's schedule are posted, and the merge
goes ahead only after the other orchestrator confirms there is no conflict.
If no confirmation arrives by the slot, the merging agent holds, posts
again, and after 30 minutes asks the owner. Today the orchestrators carry
this rule out by hand every evening, and that traffic is what failed above.

**The main goal is agent-to-agent communication with guaranteed delivery and
acknowledgment (decided).** Everything else in this document supports that.

## 2. Goals

In priority order:

1. A message sent to an agent is stored durably, is put in front of that
   agent without the agent having to remember to look, and the sender can
   see whether it was delivered and whether it was acknowledged. (decided)
2. An agent can place a hold on a pull request. While the hold blocks, the
   merge is refused, by the merging agent's hook and by GitHub itself.
   (decided; GitHub enforcement decided in revision 2)
3. In projects that require it, a merge needs the positive approval of the
   other orchestrators for its scheduled slot. Silence is not approval.
   (decided in revision 2)
4. An agent that restarts or compacts its context is told, automatically,
   who it is, which projects it belongs to, and what is waiting for it.
   (decided, as the fix for the owner's original observation)
5. A failed send says exactly why it failed. (my call, from the incident)
6. Anything urgent that goes unanswered reaches the owner, instead of
   waiting for someone to look at a page. (review)
7. Per project: a shared to-do list, a shared calendar with importance, a
   shared scratchpad, and named JSON and markdown documents. (decided)
8. A web admin page where the owner sees the state of each project and can
   force-acknowledge or release holds and messages. (decided)
9. Exposed as an MCP server that many agents can connect and reconnect to.
   (decided)
10. Agents and other tools can learn about state changes. (decided as a
    requirement; the mechanism is my call, see section 9)
11. Authentication for agents and for the admin. (decided)
12. Data persists across service restarts and deploys. (decided)
13. Cheap to host. (decided)

## 3. Non-goals

These are out of scope for the first version (all my call unless marked):

- Waking an agent that is completely idle. Section 6.9 wakes the owner
  instead.
- Merges by a GitHub identity that the repository's rules let bypass the
  `echo/hold` check, and merges in repositories where the owner has not
  made `echo/hold` a required check. The hook still refuses `gh pr merge`
  in those cases, but other merge paths are not blocked. See section 6.7.
- GitHub integration beyond what section 6.7 needs: setting the `echo/hold`
  commit status and receiving pull request events. No PR comments, reviews
  or labels. (the integration itself decided in revision 2)
- **Holds on named gates** rather than PRs, for example
  `app:apply_correction`, with the hook refusing mapped MCP tools
  while a gate is held. This is planned for the release after version 1.
  Version 1 stores holds so that a gate target can be added without
  changing existing data. (decided in revision 2)
- More than one admin, or admin roles. The owner said "just me for now".
  (decided)
- Live chat, typing indicators, or streaming updates to agents.
- Redis or any other message broker. (my call)
- Clients other than Claude Code for the hook side. The MCP side is open to
  any MCP client.

## 4. Anti-goals

Outcomes that would make this a failure even if every feature works:

- A message or hold is lost, or its sender believes it landed when it did
  not.
- A send is refused and the sender cannot tell a rule violation from an
  outage.
- The merge check lets a merge through because the service could not be
  reached.
- A hold stops being a block because the agent it blocks said "noted".
  (review)
- Silence is read as approval. (review)
- The same piece of information can live in two places inside the system
  and drift.
- Agents must remember to poll for the system to work.
- It costs more than a few dollars a month at the owner's scale, or it
  needs regular upkeep.

## 5. Platform (my call, owner asked the author to pick)

- **Cloudflare Workers** for the service, **D1** (hosted SQLite) for all
  data, **TypeScript**.
- One Worker serves the MCP endpoint, a small HTTP API used by the hooks,
  the admin page, and the endpoint that receives GitHub's pull request
  events. A Cron Trigger running every minute handles webhook retries,
  escalations, approval windows and GitHub status retries.
- Reasons: no idle sleep, so a merge check never hits a cold or sleeping
  service; persistent storage that deploys do not touch; the $5 per month
  paid plan covers the assumed scale with no overage; Cloudflare supports
  hosting remote MCP servers.
- Assumed scale: tens of agents and a handful of projects, not hundreds.
  This is the author's guess, not a number the owner gave.
- Trade-off accepted: the owner's other work is Rails on Render, so this
  shares no code or conventions with it.

Checked against Cloudflare's documentation on 2026-11-18:

- **MCP endpoint.** Use the stateless `createMcpHandler` from the `agents`
  package with MCP SDK v2 (`@modelcontextprotocol/server`), pinned to the
  version the installed `agents` release requires. It needs no Durable
  Objects; all state lives in D1. The older `McpAgent` class is deprecated
  and must not be used. Transport is streamable HTTP only (SSE is
  deprecated). The Worker checks the agent's bearer token in its own
  request handler before passing the request to the MCP handler, and routes
  everything else itself, since the MCP handler serves only `/mcp`. A
  custom domain must be listed in the handler's allowed host settings.
- **Plan: Workers Paid, $5 per month flat.** The request and row volumes
  fit the free plan, but the free plan allows only 10 ms of CPU and 50 D1
  queries per request. MCP requests rebuild the server and its schemas on
  every call, and a 1 MB document save or an admin page render could
  exceed 10 ms. A merge check that fails on a CPU limit would refuse a
  merge for no reason. At the assumed load the paid plan's included
  allowances are not exceeded, so the cost stays at $5. (my call; see the
  anti-goal on cost in section 4)
- **D1 limits that shape the design.** Each row or string can be up to
  2,000,000 bytes, so a 1 MB document fits in one row, provided it is
  passed as a bound parameter: a SQL statement's own text is limited to
  100 KB. A database can be up to 10 GB on the paid plan. Every column
  that hook polling filters on must be indexed, and the "last checked in"
  column should not be indexed, because each index on it doubles the
  rows written per poll.

## 6. How it works

### 6.1 The parts

1. **The service** (the Worker and its database). The single source of
   truth.
2. **The MCP connection** in each agent's Claude Code. This is how an agent
   acts on purpose: send a message, place a hold, approve a merge,
   acknowledge, add a to-do.
3. **The hooks** in each agent's Claude Code. These are small scripts that
   call the service's HTTP API at fixed moments. This is how the system
   reaches the agent without the agent choosing to look.
4. **The `echo/hold` commit status** on GitHub, which the service keeps up
   to date and which the owner makes a required check. This is how a hold
   is enforced on merge paths the hooks never see.
5. **The admin page**, for the owner.

### 6.2 Identity and tokens

- **Only orchestrating agents have an Echo identity.** Each orchestrator
  controls its own subagents, and those subagents report only to their
  orchestrator, through whatever the orchestrator already uses to run
  them. Subagents do not send or receive Echo messages and have no token.
  (decided)
- The owner creates each orchestrator on the admin page, gives it a stable
  name (for example "Carol"), and assigns it to one or more projects.
  The service issues a token, shown once. (my call)
- The token is the agent's identity. The same token is used by the MCP
  connection and by the hooks for that orchestrator.
- The name survives restarts, compactions, new sessions, and moves between
  servers, because it belongs to the token, not to a session.
- A message sent to an agent that is down waits for it.
- Tokens are stored hashed in the service. The owner can revoke or reissue
  a token.
- **The token is never written in plain text to a settings file.** (review)
  The orchestrators already work under a rule that no secret is written to
  a file. So:
  - On macOS, the token is kept in the login Keychain, one item per
    orchestrator name. The hooks read it with
    `security find-generic-password`.
  - On Linux, it is kept in a file with mode 0600 under the user's home
    directory, outside every repository.
  - It never goes into `settings.json`, `.mcp.json` or `~/.claude.json`.
    The orchestrator is launched through a small wrapper that reads the
    token and puts it in the environment of that one Claude Code process.
    The MCP connection's `Authorization` header refers to that environment
    variable rather than containing the token. Whether Claude Code expands
    environment variables in an MCP header in the scope used must be
    tested early (section 12). If it does not, the builder uses Claude
    Code's mechanism for computing MCP headers with a command.
  - The setup notes say how to rotate a token: reissue it on the admin
    page, then update the Keychain item or file.
- **Subagent sessions must not act as the orchestrator.** Subagents may
  run on the same machine and user account as their orchestrator, so the
  hooks have to tell the two apart (my call):
  - The message hooks in section 6.4 (orientation, new messages, and
    keeping the agent from stopping) run only in the orchestrator's own
    session. A subagent session must never be shown the orchestrator's
    messages, mark them delivered, or be held open by them.
  - The merge check in section 6.5 runs in **every** session on the
    machine, subagents included, so a subagent cannot merge past a hold.
    It authenticates with a token configured as the machine's default. A
    refusal tells the subagent to report the hold to its orchestrator,
    since only the orchestrator acts in Echo.
  - Subagents come in two kinds, and the hooks tell each apart from the
    orchestrator differently (verified on 2026-11-18 with Claude Code
    2.1.327):
    - **Subagents started with the Agent tool inside the orchestrator's
      session.** The orchestrator's own hooks fire for their tool calls,
      and the hook input then carries `agent_id` and `agent_type`. Any
      text a hook prints during such a call goes to the subagent, not the
      orchestrator. So the message hooks do nothing when `agent_id` is
      present, and the merge check runs as normal.
    - **Subagents that are separate Claude Code sessions** on the same
      machine. The launch wrapper marks the orchestrator's session with an
      environment variable naming the orchestrator, which the hooks
      inherit. A session without the marking runs only the merge check.
      This works when two orchestrators share one machine and user
      account, because each session names its own orchestrator.
  - Known limit: a session started from inside the orchestrator's shell
    inherits its environment, including the marking and the token. Any
    tool that launches subagent sessions must remove both. The setup notes
    must say so.

### 6.3 Messages

- A message belongs to one project and goes to one named agent or to every
  agent in the project. (my call)
- For each recipient the service tracks these states:
  - **sent**: stored by the service.
  - **delivered**: the service handed it to that recipient, either through
    a hook that printed it into the agent's context or through the agent
    reading its inbox with an MCP tool.
  - **deferred**: the recipient cannot handle it yet and has said why and
    until when (see below). (review)
  - **acknowledged**: the agent explicitly confirmed it with an MCP tool,
    optionally with a short note back to the sender.
- The sender chooses whether acknowledgment is required. A message that
  requires acknowledgment keeps being shown to the recipient at each hook
  check until it is acknowledged or deferred. This covers the case where a
  session died just after the message was marked delivered. (my call)
- **Defer.** (review) A recipient that cannot act on a message yet, for
  example because it needs the owner's input or a deploy to finish, defers
  it with a reason and a time. A deferred message is not shown, and does
  not hold the agent open, until that time. Then it is shown again as if
  newly delivered. The sender and the admin page see "deferred until X:
  reason". Deferring exists so that an agent never acknowledges a message
  it has not handled just to be allowed to stop, which would empty
  acknowledgment of meaning.
- The sender can ask for the status of anything it sent, and sees each
  recipient's state separately, including for a message sent to every
  agent in a project. (review) The sender is told through its own inbox
  each time a required acknowledgment arrives, with the note.
- A requires-acknowledgment message can carry an escalation time. See
  section 6.9.
- Messages have a size limit of 8 KB. A message over the limit is refused
  with an error that names the limit and the size sent, and tells the agent
  to save the long content as a document and send a short message pointing
  to it. (my call)
- A sender can withdraw a message that has not been acknowledged.

### 6.4 How messages reach an agent

The service cannot interrupt an agent. It can only answer when something on
the agent's side asks. The hooks do the asking. (my call, accepted by the
owner in playback)

| Moment in Claude Code | Hook event | What the hook does |
|---|---|---|
| Session start, resume, `/clear`, and after a compaction (automatic or manual) | `SessionStart` (sources `startup`, `resume`, `clear`, `compact`) | Prints the agent's name, the service's current time, its projects, unread messages, messages awaiting its acknowledgment, open holds on PRs in its projects, merges awaiting its approval, and a one-line reminder of how to use Echo. |
| Each time a prompt is submitted | `UserPromptSubmit` | Prints any new messages and approval requests. |
| After tool calls | `PostToolUse`, all tools | Prints any new messages and approval requests. Throttled so it calls the service at most about once every 30 seconds. |
| When the agent is about to stop | `Stop` | If messages that require acknowledgment are neither acknowledged nor deferred, keeps the agent going and shows them, at most once per message per session. |
| Before a `gh pr merge` command | `PreToolUse`, Bash | The merge check, section 6.5. Never throttled. |
| After a `gh pr merge` command that succeeded | `PostToolUse`, Bash | Reports the merge, section 6.10. |

**The Stop hook blocks at most once per message per session.** (review)
If the agent stops again with the same messages still open, it is allowed
to stop, and escalation (section 6.9) takes over. This keeps the Stop hook
from teaching agents to acknowledge in order to escape it.

Hook behaviour checked on 2026-11-18 against the Claude Code hooks
reference and a local test with Claude Code 2.1.327:

- Text a hook prints at session start and on prompt submit is added to
  the agent's context. After a tool call, the hook adds it through the
  `additionalContext` field, and it appears next to the tool result.
- A `PreToolUse` hook refuses a command with `permissionDecision: "deny"`.
  The reason is shown to the agent, and the hook still refuses when the
  session is in auto mode. Whether it also refuses in `bypassPermissions`
  mode is not documented and was not tested. The build must test it, and
  the agent setup notes must say what happens.
- A `Stop` hook keeps the agent going with `decision: "block"` and a
  reason. Claude Code stops honouring it after 8 blocks in a row with no
  tool call in between. `Stop` does not fire for subagents.
- A Bash command that fails reaches `PostToolUseFailure` with
  `Exit code N`. A successful one reaches `PostToolUse`, whose result has
  no exit code. Section 6.10 confirms the merge with GitHub rather than
  trusting either.

What "guaranteed delivery" means in this design:

- A stored message is never dropped.
- It is shown to the recipient at its next activity, without the recipient
  choosing to look.
- A hold is always checked before a merge, by the hook and by GitHub.
- Anything with an escalation time that goes unanswered reaches the owner.

What it does not mean: an agent sitting idle, waiting for a human prompt,
runs no hooks and so sees nothing until it next does something. The admin
page shows when each agent last checked in, and escalation (section 6.9)
notifies the owner, so nothing urgent depends on a sleeping agent.

### 6.5 Holds and the merge check

- **Repositories belong to projects.** The owner registers each GitHub
  repository (owner/name) under exactly one project on the admin page. A
  repository cannot be in two projects. (my call)
- A hold is placed on a registered repository and PR number, with a
  required reason. Its project is the repository's project. (my call)
  A hold's target is stored so that a named gate can be added as a second
  kind of target after version 1 (section 3).
- **A hold has a kind, chosen by the placer.** (decided in revision 2)
  - **Blocking**, the default. Only the agent that placed it, or the
    owner, can release it. Any other agent in the project, typically the
    merging agent, can acknowledge it with a required note. The note goes
    to the placer and tells it the hold was seen, but **the merge stays
    refused** until the hold is released. Releasing requires a note.
  - **Advisory.** Acknowledgment by any agent in the project other than
    the placer, with a required note, releases it for everyone. The placer
    can also release it. Use it for "make sure you have seen this".
- **The merge check looks up holds by repository and PR number alone.** It
  does not depend on which projects the merging agent belongs to, so any
  agent with a valid token and the hook installed is blocked, including one
  that is not a member of the hold's project. That agent is shown the hold's
  placer, time, and reason even though it cannot otherwise read the
  project. (my call)
- **Only registered repositories are gated.** The hooks keep a local copy
  of the registered repository list, refreshed whenever they reach the
  service. A merge in a repository that is not on the list is never checked
  or blocked, so an outage does not stop merges in unrelated repositories.
  If the hook has never fetched the list, it treats every repository as
  gated. The installer fetches the list once during setup, so a new
  machine does not start in that state. (my call; installer step from the
  review)
- Placing a hold also sends a requires-acknowledgment message to the
  repository's project, or to a named agent if the placer names one, so
  the hold is seen before a merge is even attempted. Acknowledging that
  message means only "seen". **It does not acknowledge or release the
  hold.** (my call)
- Before any `gh pr merge` command runs, the hook works out which
  repository and PR the command targets. It then asks the service whether
  the merge is allowed now: no blocking hold, no unacknowledged advisory
  hold, and, in projects that require approvals, an approved slot open now
  (section 6.6). How the target is resolved (checked against `gh` 2.85.0):
  - `gh pr merge` takes a PR number, a PR URL, a branch name, or nothing,
    in which case it uses the PR for the current branch. The repository
    comes from `-R`/`--repo`, the `GH_REPO` environment variable, or the
    current directory's git remote.
  - The hook resolves all of these the same way `gh` does, by running
    `gh pr view` with the same target, `-R` value and environment, asking
    for the PR's URL, which names the repository and number.
  - The hook finds `gh pr merge` anywhere in the Bash command, including
    in chained commands such as `cd repo && gh pr merge 12`. If the
    command contains more than one merge, or the hook cannot parse it,
    the merge is refused.
  - `gh pr merge --disable-auto` is not a merge and is not checked.
- **Auto-merge and merge queues are refused in gated repositories.**
  (decided) `gh pr merge --auto`, and a plain `gh pr merge` on a branch
  that uses a merge queue, do not merge straight away. GitHub merges
  later, when no hook is running. So the hook refuses `--auto` before it
  runs. If a merge command succeeds but GitHub reports the PR as not yet
  merged (it was queued), the hook turns auto-merge back off with
  `gh pr merge --disable-auto` and tells the agent why. Once `echo/hold`
  is a required check in a repository, GitHub would hold an auto-merge
  back while a hold or a missing approval applies, so this rule could
  later be relaxed for such repositories. That is the owner's call.
- **`gh pr merge --admin` is refused in gated repositories**, because it
  asks GitHub to skip required checks, `echo/hold` included. (my call)
- If the merge is not allowed, the command is refused. The refusal text
  shown to the agent names each reason: each hold's placer, time, kind,
  reason and what clears it, and any missing approval or closed approval
  window.
- **If the repository is gated and the service cannot be reached, or the
  hook cannot work out which PR is being merged, the merge is refused**,
  and the refusal says so plainly.
  (my call, stated to the owner, who did not object)
- The owner can force-acknowledge or release any hold on the admin page.
  (decided)
- **Emergency override.** (my call, tightened per the review) A human
  sets `ECHO_MERGE_OVERRIDE=owner/repo#N` in the environment Claude Code
  is launched from. An agent cannot change that environment from inside
  its session. The override:
  - applies only to the PR it names, and only while the service cannot be
    reached;
  - is used at most once: the hook records its use locally and refuses it
    a second time;
  - expires 30 minutes after the hook first sees it, so a value left in a
    long-lived shell stops working;
  - is reported to the service, and so to the change log, as soon as the
    service is reachable again.

  The review suggested override codes generated and signed on the admin
  page. That was not adopted: the admin page is served by the same Worker,
  so it is unavailable in exactly the outage the override is for. The
  override does not get past GitHub: a PR whose `echo/hold` status is
  failing, or whose newest commit has no status yet, stays blocked there.
  In a long outage the owner can remove `echo/hold` from the repository's
  required checks.

### 6.6 Merge approvals (decided in revision 2)

The owner's merge rule (section 1), enforced instead of carried by hand.

- **Approvals are a per-project setting**, off by default. Projects that
  leave it off keep the behavior of revision 1: unscheduled merges are
  allowed and are shown on the schedule afterwards. (decided)
- In a project that requires approvals:
  - Every merge needs a calendar event of kind "merge" for that
    repository and PR. The event names the merging agent and its
    required approvers. By default, the approvers are every other
    orchestrator in the project. The event's creator can name specific
    agents instead. (approvers decided; the default my call)
  - Creating the event sends each approver a requires-acknowledgment
    approval request. Each approver either **approves** or **objects**
    with a reason, through MCP tools. Either response acknowledges the
    request.
  - **An objection becomes a blocking hold** placed by the objector, with
    the objection as its reason. It is cleared like any blocking hold.
    (decided)
  - **An approval is tied to the PR and its scheduled slot, not to a
    commit.** The orchestrators routinely update a branch with the latest
    base code after it has been approved, and that must not require a new
    approval. (decided)
  - **An approval is valid within its slot's window**, from 30 minutes
    before the scheduled time to 30 minutes after it. Outside that window,
    the merge is refused and needs to be rescheduled and approved again.
    (decided: "If the merge moves outside its approved slot, say more
    than 30 minutes late, it should need approval again". Applying the
    same 30 minutes before the slot is my call.) The 30 minutes is a
    project setting.
  - Moving the event to a different time clears its approvals and sends
    new requests. Changing its title or importance does not. (my call)
  - **An unscheduled merge is refused**, since the rule does not allow
    them. (decided)
  - An approval request still unanswered at the earlier of 30 minutes
    after it was sent and the slot's scheduled time escalates to the owner
    (section 6.9). This mirrors the rule's "after 30 minutes, ask the
    owner". (my call) The owner can approve on an absent approver's behalf
    from the admin page, and the log records that the owner did it.
- Approvals change what the merge check (section 6.5) and the `echo/hold`
  status (section 6.7) report. In a project that requires approvals, a
  merge is allowed only when every required approver has approved, the
  current time is inside the window, and no hold blocks the PR.

### 6.7 GitHub enforcement: the `echo/hold` status (decided in revision 2)

The hook covers only `gh pr merge` in a Claude Code session where it is
installed. It does not cover `gh api`, a GitHub MCP server's merge tool,
the GitHub web UI, or a machine where the hook is missing. So the service
also maintains a commit status that GitHub enforces on every merge path.

- **The service sets a commit status with the context `echo/hold`** on
  the newest commit of every open PR in a registered repository:
  - `failure` while a blocking hold or an unacknowledged advisory hold is
    open, or while, in a project that requires approvals, the PR has no
    approved slot whose window contains the current time;
  - `success` otherwise.

  The status's description says why, within GitHub's 140-character limit,
  and links to the project's admin page.
- **The owner makes `echo/hold` a required status check** in each
  registered repository's rules, for the branches that agents merge into.
  The owner also makes sure that the GitHub identity the agents use cannot
  bypass the rule. A repository may have a ruleset that lets
  repository admins bypass it at any
  time. If the agents' `gh` authenticates as an admin, that bypass must be
  removed or the agents must use a separate identity. The setup notes walk
  through this. (my call)
- **Authentication with GitHub: a GitHub App** owned by the owner and
  installed on the registered repositories, with permission to write
  commit statuses and read pull requests. Its private key is a Worker
  secret. An App was chosen over a personal access token because its
  credentials do not expire, so there is no recurring upkeep (section 4),
  and because GitHub delivers the App's pull request events to the
  Worker without a webhook set up by hand in each repository. (my call)
- **When the status is updated.** The service recomputes and writes the
  status when:
  - a hold is placed, acknowledged or released;
  - an approval or objection arrives;
  - a merge event is added, moved or cancelled;
  - an approval window opens or closes (the every-minute cron);
  - GitHub reports that a PR was opened, reopened, or received a new
    commit (the App's `pull_request` events, verified by signature).
- **Status writes are retried.** Each needed write is recorded in D1 and
  retried by the cron until GitHub accepts it, so a GitHub outage delays a
  status but does not lose it. Until the retry succeeds, GitHub shows the
  previous status. The hook still refuses `gh pr merge` meanwhile, but
  other merge paths may get through during that gap. (my call)
- **An Echo outage never opens a merge path on GitHub.** A new commit has
  no `echo/hold` status until the service sets one, and GitHub treats a
  missing required status as not passed. So while Echo is down, a PR that
  received a new commit cannot be merged on any path, and every other PR
  keeps the last status Echo set.
- The hook stays. It gives the agent an immediate refusal with the reason
  in its context, which a status check alone does not. (review)
- The admin page shows, for each registered repository, whether the App
  is installed and whether the last status write succeeded.

### 6.8 Shared items, per project

- **To-do list.** Any agent in the project can add an item, claim it, and
  mark it done. Each item shows who added it, who claimed it, and when.
- **Calendar.** Events have a title, a scheduled time, an importance (low,
  normal, high), a kind, and an optional repository and PR number. Events
  of kind "merge" also name the merging agent, and in projects that
  require approvals they carry approvers (section 6.6). They feed the
  merge schedule. (importance decided; the rest my call)
- **Scratchpad.** One per project. Agents can only append entries, each
  stamped with the agent's name and the time. Agents cannot edit or delete
  entries. This is deliberate: it is what prevents two divergent copies.
  The owner can edit or clear it from the admin page. (my call)
- **Documents.** JSON or markdown, saved by name within a project. Saving
  an existing name creates a new version. The last 50 versions of each
  document are kept; older ones are deleted when a new version is saved,
  so a document that is saved often cannot grow the database without
  bound. (review) JSON is checked for validity on save. The limit is 1 MB
  per document. (named JSON and markdown decided; versions and limit my
  call)

### 6.9 Escalation to the owner (review)

The orchestrators are idle much of the time, and the admin page helps only
if the owner happens to look at it. Escalation wakes the owner, not the
agent, so the non-goal in section 3 stands.

- The owner sets one notification address on the admin page: a URL that
  accepts a POST, in the format ntfy uses (plain-text body, with title,
  priority and click-through link in headers). (my call; ntfy as the
  example is from the review)
- A requires-acknowledgment message can carry an escalation time, set by
  its sender as a number of minutes. If any recipient has neither
  acknowledged nor deferred it by then, or a deferral has run out without
  an acknowledgment, the service notifies the owner once for that
  recipient. The notification names the message, the sender, the
  recipient and the recipient's last check-in, and links to the admin
  page.
- Approval requests escalate as described in section 6.6.
- An escalation is written to the change log, so it also reaches the
  outgoing webhooks (section 9).

### 6.10 Merge schedule

- The schedule for a day is the project's calendar events of kind "merge"
  on that day, in time order. (decided: the owner asked to see the day's
  merges and what is next)
- Each row has a status: waiting for approval, approved, blocked by a hold,
  or merged. (approval states added in revision 2)
- After a `gh pr merge` command succeeds, the hook asks GitHub, with
  `gh pr view`, whether the PR is now merged and when. It reports the merge
  only if GitHub says it is merged, with GitHub's merge time.
- When the hook reports a successful merge, the service marks the matching
  calendar event as merged. If no event matches, the service creates one
  after the fact so the merge still appears. (decided: unscheduled merges
  are allowed in projects that do not require approvals, and are shown
  afterwards)
- When a PR is merged by another path, the App's `pull_request` "closed"
  event, with merged set, is recorded the same way. (my call, made
  possible by section 6.7)
- The event goes on the calendar of the project that the repository is
  registered under. Merges in unregistered repositories are not recorded.
  (my call)

### 6.11 Times (review)

An agent's sense of the current time can be badly wrong. The reviewer has
logged its own estimate running 30 to 80 minutes ahead during busy
stretches. So:

- Every stored time (sent, delivered, deferred, acknowledged, approved,
  held, released, merged, checked in, escalated, log entries) is set by
  the Worker, in UTC. An agent never supplies the time of a record.
- A merge time comes from GitHub, not from the agent.
- The one exception is a calendar event's scheduled time, which the agent
  chooses. It is stored in UTC together with the time zone it was entered
  in, and a time given without a zone or offset is refused.
- The orientation at session start prints the service's current time, so
  the agent can correct itself, and every tool result that mentions a time
  gives it in UTC with the offset.

### 6.12 Change log

Every change to project state is written as one entry in a per-project
log: message sent, delivered, deferred, acknowledged, withdrawn,
escalated; hold placed, acknowledged, released; approval requested,
approved, objected; to-do, calendar, scratchpad, and document changes;
merge attempts refused and merges recorded; GitHub status changes; admin
actions; overrides. Each entry has an increasing number, a time, and who
did it. (my call)

This log serves three purposes: the activity list on the admin page, the
"what changed since I last looked" tool for agents, and the source for
outgoing webhooks.

## 7. What agents can do (MCP tools)

The builder chooses exact tool names and parameter shapes. The capabilities
needed are:

- Who am I, which projects am I in, and the service's current time.
- Messages: send (with an optional escalation time), read inbox,
  acknowledge, defer, check the status of sent messages per recipient,
  withdraw.
- Holds: place (blocking or advisory), list, acknowledge, release.
- Approvals: list the merges awaiting my approval, approve, object.
- To-dos: add, list, claim, complete.
- Calendar: add, list, update, cancel. Merge events name the merging
  agent and, where required, the approvers.
- Scratchpad: append, read.
- Documents: save, get, list, list versions, get a version.
- Changes: list changes in a project since a given log number.

Every tool error must say what went wrong and what to do about it, and must
distinguish "your request broke a rule" from "the service had a problem".

## 8. Admin page

Single admin. (decided) Login is one account whose password is held as a
Worker secret, with a session cookie. (my call)

Project overview, top to bottom (order confirmed by the owner on a mockup,
with the schedule added at their request):

1. **Today's merges**, in time order, with the next one marked, each
   showing PR, merging agent, importance, status, and in projects that
   require approvals, each approver's response, with a button to approve
   on an approver's behalf. "Today" uses the browser's local time.
2. **Open holds**, each showing its kind, who placed it, the reason,
   whether its message has been delivered and acknowledged, and whether
   the hold itself has been acknowledged, with buttons to force-acknowledge
   and to release.
3. **Undelivered, deferred or unacknowledged messages**, each showing how
   long it has waited, any deferral and its reason, when the recipient
   last checked in, and whether it has escalated, with buttons to
   force-acknowledge and to withdraw. A message sent to every agent shows
   each recipient separately.
4. Side column: agents with last-checked-in time, open to-dos, and recent
   activity.

Other pages per project: all messages, to-do list, calendar, scratchpad,
documents, agents and tokens, registered repositories with their GitHub
status (section 6.7), outgoing webhooks, and project settings (approvals
required, approval window minutes). The owner can create, edit, and delete
content on each. (decided: "let an administrator manage the content")

Across projects: a project list; creating, renaming, and archiving
projects; and the owner's notification address (section 6.9).

Every admin action is written to the change log. (my call)

The mockups the owner reviewed were never committed and are no longer
available. The owner chose to proceed without them, so the layout written
above is the reference for the admin page.

## 9. Notifications (my call)

The owner asked for "notifications through something like redis or hooks".
This design uses these mechanisms and no broker:

- **Pull, for agents.** The hooks in section 6.4 and the "changes since"
  tool. A pull cannot be missed the way a dropped subscription can, which
  matters given the owner's history with lost connections.
- **Escalation, for the owner.** Section 6.9.
- **Outgoing webhooks, for everything else.** Per project, the owner can
  register URLs on the admin page. The service sends each change-log entry
  to them as a signed request, with a few retries. Webhook delivery is best
  effort and is not part of the delivery guarantee. Pending deliveries are
  recorded in D1 and retried by the cron, because work deferred with
  `ctx.waitUntil` is cancelled 30 seconds after the response and is not
  durable.

## 10. What gets delivered

1. The Worker, its database schema, and deployment configuration.
2. The hook scripts and a simple installer. It takes the service address,
   the orchestrator's name and its token, stores the token in the Keychain
   or a 0600 file, installs the hooks, and fetches the registered
   repository list once.
3. The launch wrapper for orchestrators, and the MCP connection
   configuration that reads the token from the environment.
4. A short block of instructions for agents, suitable for a CLAUDE.md. It
   explains when to send a message, when to place a hold and which kind,
   how to approve or object, when to defer rather than acknowledge, and
   that long content goes in a document.
5. Setup notes for the owner: deploying; setting the admin password;
   creating the GitHub App and installing it; making `echo/hold` a
   required check without an agent bypass; creating a project, a
   repository and an agent; the notification address; rotating tokens;
   the override; and the subagent-launch limit from section 6.2.
6. The rollout procedure in section 13.

## 11. How to know it works

The builder designs the tests. These scenarios must pass:

1. **The incident, replayed.** Agent A places a blocking hold on a PR.
   Agent B, who has not looked at anything, runs `gh pr merge` for it and
   is refused, with the reason shown. B acknowledges the hold with a note,
   and A sees the acknowledgment and the note. B's next merge attempt is
   still refused. A releases the hold. B merges. (extended per the review)
2. **Advisory hold.** A places an advisory hold. B is refused, acknowledges
   with a note, and then merges.
3. **Approval required.** In a project that requires approvals, B tries
   an unscheduled merge and is refused. B schedules the merge, and A
   receives the approval request. B's merge is refused until A approves,
   then goes through inside the window. B pushes a new commit after the
   approval and the approval still stands. When the merge is attempted
   more than 30 minutes after the slot, it is refused and must be
   rescheduled.
4. **Objection.** A objects to a scheduled merge. The objection appears
   as a blocking hold and B's merge is refused until A releases it.
5. **GitHub enforcement.** With a blocking hold open, the `echo/hold`
   status on the PR's newest commit is `failure`, and a merge through
   `gh api` is refused by GitHub. After release it is `success` and the
   merge goes through. A new commit pushed while the service is down
   leaves the PR unmergeable on GitHub until the service sets a status.
6. **Too long.** A sends a message over the size limit and gets an error
   naming the limit and suggesting a document. A short message sent
   straight after succeeds.
7. **Restart.** A sends B a message that requires acknowledgment while B
   is not running. B starts a new session and sees it immediately, along
   with its own name, its projects and the service's time.
8. **Compaction.** B compacts mid-session and is shown the same
   orientation and anything still unacknowledged.
9. **Defer and stop.** B defers a message for 10 minutes with a reason.
   B's Stop is not blocked by it, A sees the deferral, and B is shown the
   message again after 10 minutes. A message B neither acknowledges nor
   defers blocks B's Stop once, and not a second time in the same
   session.
10. **Escalation.** A message with a 5-minute escalation time that B
    leaves unanswered produces exactly one notification to the owner's
    address, and the escalation is in the log.
11. **Service down.** With the service unreachable, B's merge is refused
    with a message that says the service could not be reached. With the
    override set for that PR, it goes through once. A second attempt with
    the same override is refused, as is any attempt 30 minutes after the
    hook first saw it. The override appears in the log once the service is
    back.
12. **Admin force.** The owner force-releases a blocking hold on the admin
    page and B's next merge attempt goes through. The log shows the owner
    did it.
13. **Unscheduled merge.** In a project without approvals, B merges a PR
    with no calendar entry and it appears on that day's schedule as merged.
14. **Scratchpad.** Two agents append at the same moment and both entries
    are present, in order.
15. **Persistence.** After a redeploy, all of the above state is still
    there.
16. **Access.** A revoked token is refused everywhere. An agent cannot
    read or write a project it is not assigned to.
17. **Subagents.** A subagent session on the orchestrator's machine is
    refused when it tries to merge a held PR, and is told to report to
    its orchestrator. The same subagent session is never shown the
    orchestrator's messages, and those messages stay undelivered until
    the orchestrator's own session sees them.
18. **Times.** An agent that supplies a timestamp on any record other than
    a calendar event's scheduled time has it ignored or refused, and a
    scheduled time without a zone is refused.

## 12. Left to the builder

- Database tables and indexes.
- Exact MCP tool names, parameters, and result shapes.
- Testing, early in the build:
  - a hook refusal in `bypassPermissions` mode;
  - saving a document of about 1.5 MB to a real remote D1 database as a
    bound parameter;
  - Claude Code connecting to the MCP endpoint with
    `claude mcp add --transport http` and an `Authorization: Bearer`
    header taken from an environment variable, in the scope the installer
    uses;
  - GitHub refusing a merge through `gh api` and the web UI when a
    required `echo/hold` status is `failure` or missing, and whether an
    identity listed as a bypass actor gets through with and without
    `gh pr merge --admin`.
- The HTTP API between hooks and service.
- How the hook scripts are written and installed, and exactly which Claude
  Code hook events and matchers are used, as long as the moments in section
  6.4 are covered. The builder should check current Claude Code hook
  documentation.
- How the hook recognises merge commands, including variants such as
  `--auto` and `--admin`, and how it resolves the PR.
- How the admin page is built and styled. It should be plain and fast; no
  design system is required.
- Throttle intervals, retry counts, and the exact size limits, starting
  from the suggestions here.
- Rate limiting and other basic hardening.
- Test tooling.

## 13. Rollout (review)

The orchestrators' standing rules name the current channel. If one
orchestrator moves to Echo before the other, each listens on a channel the
other has stopped using, which is the section 1 failure again. So:

1. Deploy. Create both orchestrators, register the repositories, install
   the GitHub App, and make `echo/hold` a required check.
2. Run Echo and the current channel side by side for a few days. Every
   load-bearing message goes to both, and acknowledgments are read from
   Echo.
3. Replay the section 11 scenarios live with both orchestrators,
   especially the incident and the approval flow.
4. The owner changes the standing rules to name Echo. Both orchestrators
   switch the same day, and each confirms the switch with an acknowledged
   message in Echo.
5. The old channel is marked read-only for this purpose.

Echo does not depend on the old channel at any step. The overlap is
operational only.
