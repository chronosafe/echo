# Echo design: review from an orchestrating agent

Date: 2026-11-18
Reviewer: one of the two orchestrating agents whose coordination failures section 1 describes. This review measures the design against how the two orchestrators actually work today.
Reviews: `2026-11-18-echo-agent-comms-design.md`, the version the owner approved on 2026-11-18.
Status: feedback for the owner. Nothing here is decided until the owner rules on it.

## Summary

The design is sound. It starts from a real incident. It checks the hold at the moment of the merge rather than relying on an agent to remember to look. It keeps delivered and acknowledged as separate states. Its size error names the limit and says what to do instead. Its scratchpad is append-only, which removes the divergent-copies failure by construction.

Three points matter more than the rest, because each one leaves a path by which the 2026-11-17 sequence could still happen:

1. **An acknowledgment releases a hold.** That turns a block into a speed bump (finding 1).
2. **The merge gate only models a "no".** The owner's merge rule needs a positive "yes" (finding 2).
3. **Enforcement exists only in a client-side hook.** Any merge path the hook doesn't see bypasses every hold (finding 3).

Findings 4 to 10 are smaller and can be folded in during planning.

## Findings

### 1. A blocking hold must not be released by the agent it blocks (section 6.5)

**What the design says.** Any agent in the project other than the placer may acknowledge a hold, with a short note. Once acknowledged, the hold stops blocking for everyone.

**Why it falls short.** Replay the incident with Echo in place. The reviewing agent places a hold on PR #709 for a blocking finding. The merging agent runs `gh pr merge` and is refused with the reason shown, which is exactly right. But the merging agent can then acknowledge the hold with the note "noted" and merge on the next command. The hold has slowed the merge down without stopping it. The finding was meant to stop the merge until it was fixed, and nothing in the design makes that happen.

**Proposal.** Give a hold a kind, chosen by the placer:

- **Advisory.** Behaves as designed: the acknowledgment, with its note, releases it. Use it for "make sure you've seen this".
- **Blocking.** Only the placer or the owner can release it. The merging agent can acknowledge it, which tells the placer the hold was seen and carries the note, but the merge stays refused. Use it for "do not merge until I say so".

The handoff notes that the owner said acknowledgment releases the hold "initially" and expects stricter rules later. This proposal is that stricter rule, scoped so the lighter behavior stays available.

**Decision needed from the owner:** adopt the two kinds in version 1, or keep acknowledgment-releases for now.

### 2. Model the positive confirmation the merge rule requires (sections 6.5, 6.7)

**What the design says.** A merge is refused only while an open hold exists. A merge with no calendar entry is allowed and shown afterwards.

**Why it falls short.** The owner's standing merge rule for these agents runs the other way. Before any merge fires, the merge and the day's schedule are posted, and the merge goes ahead only after the other orchestrator confirms there is no conflict. With no confirmation by the slot, the merging agent holds, posts again, and after 30 minutes asks the owner. Today the two orchestrators carry out that rule by hand every evening, which is the traffic that failed in section 1. Echo as designed would carry the messages but would not enforce the rule. Silence would still read as "no objection", and a dropped confirmation would not stop a merge.

**Proposal.** Let a calendar event of kind "merge" name required approvers: agents, or "every other orchestrator in the project".

- Each approver approves or objects through an MCP tool. An objection becomes a blocking hold (finding 1).
- The merge check refuses a scheduled merge until every required approver has approved.
- An unscheduled merge in a repository whose project requires approvals is refused, since the rule says unscheduled merges are not allowed. Projects that don't set the requirement keep the current "allowed and shown afterwards" behavior.
- An approval that hasn't arrived N minutes before the slot is escalated to the owner (finding 5).

This also covers a gap: today the recipient quotes back each load-bearing message, because the sender can't otherwise tell it was received. Echo's acknowledgment-with-note does that natively, and approvals would make it structural.

**Decision needed from the owner:** whether approvals are per project, and whether version 1 includes them.

### 3. Enforce holds on GitHub as well as in the hook (sections 3, 6.5)

**What the design says.** The `PreToolUse` hook refuses `gh pr merge` while a hold is open. Merges made any other way are out of scope; a required GitHub status check is mentioned as possible later work.

**Why it falls short.** The anti-goal is that a hold is lost. A hook that recognizes only one command misses every other merge path an agent or the owner can use:

- `gh api repos/.../pulls/N/merge`;
- a GitHub MCP server's merge tool, which agents may have connected;
- the GitHub web UI;
- any machine where the hook is missing or misconfigured, including the other orchestrator's machine after a fresh setup.

**Proposal.** In version 1, have the Worker maintain a commit status (or check run) named, for example, `echo/hold` on the head of every PR in a registered repository:

- `failure` while an open blocking hold or a missing required approval applies;
- `success` otherwise.

The owner then makes `echo/hold` a required check in branch protection. GitHub itself then refuses the merge on every path. The hook stays, because it gives the agent an immediate refusal with the reason in its context, which a status check alone does not. The extra cost is a GitHub App or fine-grained token held as a Worker secret, plus updating the status when a hold changes and when a PR's head moves (from a GitHub webhook, or by checking again whenever the hook calls in). This does reverse the section 3 non-goal of "any other GitHub integration", so it needs the owner's approval.

**Decision needed from the owner:** accept the GitHub integration for version 1.

### 4. Make the emergency override single-use (section 6.5)

**What the design says.** A human sets an environment variable that lets one merge through when the service is down. The hook records the override and reports it later.

**Why it falls short.** Agent shells live a long time. A variable exported into one stays set, and "one merge" depends on the hook clearing something it can't clear from the parent shell. An override that stays live after the emergency silently lets later merges past holds.

**Proposal.** The override is a short code, entered once:

- It names one repository and PR and expires in, say, 30 minutes.
- The owner generates it on the admin page (signed with a secret the hook can verify offline), or the hook generates it locally and requires the human to type it back.
- The hook records each code's use locally and refuses it a second time.

### 5. Escalate to the owner when an agent stays silent (section 6.4)

**What the design says.** An idle agent runs no hooks, so it sees nothing until its next activity. The admin page's "last checked in" time is the mitigation. Waking idle agents is a non-goal.

**Why it falls short.** Both orchestrators are idle much of the time. One sleeps between scheduled events; the other waits for prompts. "Delivered at next activity" can mean hours, and the admin page only helps if the owner happens to look at it. The owner's merge rule already contains the right fallback: after 30 minutes without confirmation, ask the owner.

**Proposal.** Let a message or approval request carry an escalation time. If it hasn't been acknowledged by then, the service sends a push notification to the owner through the existing outgoing-webhook mechanism, for example to ntfy or Pushover, with a deep link to the admin page. This wakes the owner rather than the agent, so the non-goal stands, but nothing urgent waits on someone happening to look.

### 6. Stamp every time on the server (sections 6.3, 6.6, 6.8)

**Why it matters.** An agent's sense of the current time can be badly wrong. This reviewer has logged its own estimated clock running 30 to 80 minutes ahead during busy stretches. A schedule, a hold time or a "last checked in" taken from the agent would be wrong in the same way.

**Proposal.**

- Every stored time (sent, delivered, acknowledged, held, released, merged, checked in, log entries) is set by the Worker in UTC.
- An agent never supplies a timestamp for a record.
- A calendar event's scheduled time is the one exception, because the agent chooses it; it is stored in UTC with the time zone it was entered in.
- The orientation hook prints the server's current time, so the agent can correct itself.

### 7. Let a hold target more than a pull request (sections 6.5, 7)

**Why it matters.** Merges are not the only actions that must wait for the other orchestrator. Correction applies, data jobs, feature-switch flips and deploy-time cache purges are scheduled and confirmed the same way today, and each has caused or nearly caused an incident.

**Proposal.** A hold's target is either a repository and PR, or a named gate, for example `app:apply_correction` or `app:case-15`. Claude Code hooks can match MCP tool names, so the `PreToolUse` check can cover a list of MCP tools configured per project, mapping each to a gate name. This is the same refusal path as the merge check, with no GitHub involvement, and it can come after version 1 if it would slow the build.

### 8. Don't let the Stop hook teach agents to acknowledge without reading (section 6.4)

**Why it matters.** The `Stop` hook keeps the agent working while acknowledgment-required messages are open. When the message needs something the agent can't do yet (the owner's input, a deploy finishing), the agent's quickest way out of the loop is to acknowledge. If agents learn to acknowledge in order to stop, the acknowledgment no longer means "read and handled", and the delivery guarantee rests on it.

**Proposal.**

- Add a third response next to acknowledge: **defer**, with a reason and a time. A deferred message leaves the Stop check, is shown again at the deferral time, and appears as "deferred until X" to the sender and on the admin page.
- Block `Stop` at most once per message per session, rather than up to the 8-block limit.
- When the agent is idle, rely on escalation (finding 5).

### 9. Keep the agent token out of plain files (sections 6.2, 10)

**Why it matters.** The hooks and the MCP connection both need the token. If it lands in a settings file, it gets committed, copied into backups and read by any tool that scans the configuration. The owner's agents already work under a rule that no key or secret is written to a file.

**Proposal.**

- On macOS, store the token in the login Keychain under a per-orchestrator item. The hook reads it with `security find-generic-password`, keyed by the orchestrator marker variable from section 6.2.
- On Linux servers, read it from a file with mode 0600 outside every repository.
- Never put it in `settings.json` or `.mcp.json` in plain text. If the MCP connection needs a header, use the client's support for reading the header from an environment variable.
- The setup notes say how to rotate it.

### 10. Plan the switchover from the current channels (section 10)

**Why it matters.** Today the orchestrators' standing rules name the current channel by name: the shared chat thread is the place for load-bearing posts, and the merge rule refers to it. If one orchestrator moves to Echo before the other, each will be listening on a channel the other has stopped using, which is the section 1 failure again.

**Proposal.** Add a short rollout section:

1. Deploy, create both orchestrators and register the repository.
2. Run Echo and the current channel side by side for a few days. Every load-bearing message goes to both; acknowledgments are read from Echo.
3. Replay the section 11 scenarios live, especially the incident, with both orchestrators.
4. The owner changes the standing rules to name Echo. Both orchestrators switch the same day, and each confirms the switch in Echo.
5. The old channel is marked read-only.

## Smaller notes

- **Section 6.3, broadcast messages.** A message to every agent in a project needs an acknowledgment from each recipient. Say whether the sender's status view shows each recipient's state or only a summary; the admin page needs each one.
- **Section 6.5, cache of registered repositories.** "If the hook has never fetched the list, it treats every repository as gated." That includes unrelated repositories on a new machine while the service is down. That's acceptable if the setup instructions fetch the list once during installation.
- **Section 6.6, documents.** Versions are kept forever. Add a retention limit (for example the last 50 versions) so a document that is saved often does not grow the database without bound.
- **Section 11, test 1.** Extend it to cover findings 1 and 2: an acknowledged blocking hold still refuses the merge; the merge goes through only after the placer releases it; and a scheduled merge without the required approval is refused.

## What this review did not check

Everything above is reasoned from the design and from how the two orchestrators work today. Nothing was tested: not the Claude Code hook behavior, the Cloudflare limits, nor GitHub's required-check behavior with commit statuses. Those belong in the build's early test list in section 12.
