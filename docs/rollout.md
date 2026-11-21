# Echo rollout

This is section 13 of the design as a checklist. The orchestrators' standing rules name the current channel. If one orchestrator moves to Echo before the other, each listens on a channel the other has stopped using. So move together.

Echo does not depend on the old channel at any step. The overlap is operational only.

## 1. Deploy

- [ ] Deploy the Worker and set its secrets (docs/setup.md, "Deploy").
- [ ] Create both orchestrators on the admin page and note each token. It is shown once.
- [ ] Create the project and register its repositories.
- [ ] Create the GitHub App and install it on the registered repositories.
- [ ] Make `echo/hold` a required check in each repository, with no bypass for the agents' GitHub identity.
- [ ] Install on each orchestrator's machine and launch it with `~/.echo/echo-claude <name>`, or, if the launcher cannot use that, with `ECHO_AGENT=<name>` in the session's settings `env`. Run the printed `claude mcp add-json` command once.

## 2. Run side by side for a few days

- [ ] Send every load-bearing message to both Echo and the current channel.
- [ ] Read acknowledgments from Echo.

## 3. Replay the design's test scenarios live

- [ ] Replay the section 11 scenarios with both orchestrators.
- [ ] Replay the incident scenario.
- [ ] Replay the approval flow: schedule, approve, object, merge inside the window, merge outside it.

## 4. Switch

- [ ] The owner changes the standing rules to name Echo.
- [ ] Both orchestrators switch on the same day.
- [ ] Each orchestrator confirms the switch with an acknowledged message in Echo.

## 5. Retire the old channel

- [ ] Mark the old channel read-only for this purpose.
