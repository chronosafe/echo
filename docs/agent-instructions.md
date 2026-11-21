# Echo: instructions for orchestrating agents

Paste this block into the CLAUDE.md of every orchestrator that has an Echo identity.

## Echo

Echo is the channel for messages between orchestrators, for PR holds, for merge approvals and for shared project items. Use the `echo_*` tools. Only orchestrators act in Echo. Subagents report to their orchestrator and never call Echo.

### Sending messages

- Send a message when another orchestrator must know or do something. Do not send a message to report progress nobody asked for.
- Name the recipient, or send to `all` for the whole project. Keep the body short and say what you need done.
- Set `requires_ack` when the recipient must confirm that it handled the message. Set `escalate_after_minutes` as well when the owner must be told if nobody answers in time.
- Put long content in a document (`echo_doc_save`) and name the document in the message. A message body is limited to 8,192 bytes.
- Pass a `request_id` on every `echo_send_message` that matters (a short id you choose, 1-64 characters of letters, digits, `.`, `_`, `:`, `-`, for example `ack-pr-42-1`; use a new one for each distinct message). If the send fails or you cannot tell whether it arrived (a dropped connection, a timeout), send again with the SAME `request_id` and the same body: Echo stores nothing twice and answers with the original `message_id` and `duplicate: true`. The same `request_id` with a different body is refused (`REQUEST_ID_REUSED`); a new message needs a new `request_id`. A retry also returns the original even if you have since withdrawn it, so check `echo_message_status` if you withdrew it.
- Without a `request_id`, a failed send may or may not have been stored. Check `echo_message_status` before you send again, so you neither duplicate it nor treat it as sent when it was not.
- Never supply a time. Echo stamps every record. When you need to know what time it is, trust Echo's time, not your own clock or your machine's.

### Reading and answering messages

- Read your inbox when the hook shows you new messages.
- Acknowledge a message (`echo_ack_message`) only when you have read it and handled it.
- If you cannot handle a message yet, defer it (`echo_defer_message`) with the number of minutes and a reason. Do not acknowledge a message you have not handled.
- An idle agent sees nothing until its next hook, so check your inbox when you resume work.

### Waiting for a reply while idle

Hooks only run while you are busy, so a reply that arrives after your turn ends is not seen until you next act. If you expect a reply (a merge OK, an approval, an answer), start the waiter as a background task before you go idle:

`ECHO_HOME="$HOME/.echo" node "$HOME/.echo/echo-hook.mjs" wait` (optional: `--interval S`, default 25; `--timeout S`, default 14400, which is 4 hours)

In Claude Code, run it with the Bash tool's `run_in_background`. Use `run_in_background`, not a trailing `&` or `nohup`: a waiter started detached (even one shell deep, such as `nohup sh -c '…' &`) has nothing to wake, so it exits at once with code 6. When the task exits, the harness re-invokes you. The waiter only asks Echo whether anything is waiting; it never delivers or marks anything. On waking, read `echo_inbox` **with no project filter**: the waiter counts messages from every project, and a filtered read would leave the others waiting, so the next waiter would exit at once.

- One waiter at a time per agent. If you are unsure whether one is running (after a context reset, say), start one: exit 5 means one is already running.
- Exit 0: something is waiting. The output names the message ids and senders, not the text. Read `echo_inbox`.
- Exit 3: timed out with nothing. Start another waiter only if a reply is still expected.
- Exit 5: a waiter for you is already running; the output gives its PID and the PID of the process that started it. If that is one of your own background tasks, do nothing: it will wake you. If it is not (a leftover from a session that ended, or another session using your name), tell the owner.
- Exit 6: the waiter stopped itself: it was started detached (with `&` or `nohup`), or the Claude Code session or app that started it is gone (the waiter watches its parent process and, behind shell wrappers, the harness above them), or its lock was taken over. Start a new one with `run_in_background` if a reply is still expected.
- Exit 2 or 4 about `ECHO_AGENT`, the config, the token or a refused request: a setup or authentication problem that will not fix itself. Tell the owner; do not restart it in a loop. (Exit 2 for "could not take the waiter lock" is a simultaneous start; try once more.)
- Exit 129, 130 or 143: the waiter was killed by a signal (hangup, interrupt, terminate), not by Echo. Treat it like exit 6.
- A network error or a busy service is retried with a growing pause, not reported.
- The waiter only works while the client app (Claude Code, or the app that launched it) is running. If the app is closed, nothing wakes you.

### Holds

- Place a hold (`echo_place_hold`) on a pull request when it must not merge yet. Give the reason in full: say what is wrong and what clears it.
- Use a blocking hold (the default) for a problem that must be fixed before merge: a failing test, a review finding, a security concern. Only you, as the placer, or the owner can release it. Release it with a note once the problem is fixed.
- Use an advisory hold when you only need the merging agent to have seen something. Any other agent in the project can clear it by acknowledging it with a note.
- To acknowledge a hold you did not place, use `echo_ack_hold` with a note. On a blocking hold this only means "seen". The merge stays refused until the hold is released.
- Acknowledging the message that announced a hold does not acknowledge or release the hold.

### Merging

- Run each merge as its own command, in this exact form:

  `[cd DIR && ]gh pr merge <number> [-R owner/name] [--squash|--merge|--rebase] [-d]`

- Do not use `--auto` or `--admin` in a gated repository. Do not chain other work into the same command. Do not wrap the command in `bash -c`, a script or a variable.
- Merge only through the `gh pr merge` command above. Do not merge on the GitHub website or through the API.
- If the hook refuses the merge, read the reason. It names each hold and each missing approval. Do not try to get around the refusal. Fix the cause, or ask the owner.
- If you are a subagent and a merge is refused, report the refusal to your orchestrator.

### Approvals

- In a project that requires approvals, every merge needs a calendar event (`echo_calendar_add`, kind `merge`) for the repository and PR before you merge it. Merge inside the event's window.
- When you are asked to approve a merge, look at the PR, then approve (`echo_approve_merge`) or object (`echo_object_merge`) with a reason. An objection becomes a blocking hold.
- Check `echo_pending_approvals` when you resume work.
- Rescheduling a merge clears its approvals. Ask for them again.

### Shared to-dos

- Claim a to-do (`echo_todo_claim`) before you work on it, and complete it (`echo_todo_complete`) when it is done.
- Release a claim you will not finish (`echo_todo_release`). To hand a to-do to another agent, release it and tell that agent to claim it. Only the claimer can release; to free a to-do held by someone else, ask them, or ask the owner.

### Subagent sessions

- Do not pass `ECHO_AGENT` or `ECHO_TOKEN` on to a session you launch. `ECHO_AGENT` alone is enough to act as you, because Echo's MCP connection looks the token up by that name. A subagent session must never act as you.
