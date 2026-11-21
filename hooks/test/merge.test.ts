import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveConfig } from '../src/config';
import type { HookInput } from '../src/input';
import { dispatch } from '../src/main';
import { postBash } from '../src/merge-post';
import { noteOverrideSeen, OVERRIDE_TTL_MS, preBash, type HookOutput } from '../src/merge-pre';
import * as state from '../src/state';
import { writeToken } from '../src/token-store';
import { startFakeServer, type FakeServer, type RecordedRequest } from './fake-server';

const BIN = path.join(import.meta.dirname, 'fixtures/bin');
const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);
const PR_VIEW = JSON.stringify({ url: 'https://github.com/Acme/App/pull/709', state: 'OPEN', mergedAt: null });

let tmp: string;
let server: FakeServer;
let env: NodeJS.ProcessEnv;
let log: string;
let routes: Record<string, { status: number; body?: unknown }>;

const denied = (out: HookOutput): boolean =>
  JSON.parse(out.stdout ?? '{}').hookSpecificOutput?.permissionDecision === 'deny';
const reason = (out: HookOutput): string => JSON.parse(out.stdout ?? '{}').hookSpecificOutput?.permissionDecisionReason ?? '';
const context = (out: HookOutput): string => JSON.parse(out.stdout ?? '{}').hookSpecificOutput?.additionalContext ?? '';

function bashInput(command: string, extra: Partial<HookInput> = {}): HookInput {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    cwd: tmp,
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: 'toolu_1',
    ...extra,
  };
}
const postInput = (command: string, extra: Partial<HookInput> = {}): HookInput =>
  bashInput(command, { hook_event_name: 'PostToolUse', ...extra });

const blocking709 = { id: 7, repo: 'acme/app', pr: 709, kind: 'blocking', reason: 'blocking finding', placedBy: 'Alice', placedAt: '2026-11-17T21:08:00Z' };
const allowedReply = { status: 200, body: { gated: true, allowed: true, blocks: [] } };
const reqs = (suffix: string): RecordedRequest[] => server.requests.filter((r) => r.url === suffix);
const ghLog = (): string => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');

function down(): void {
  saveConfig(env, { url: 'http://127.0.0.1:1', agents: ['orch'], defaultAgent: 'orch' });
}

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'echo-merge-')));
  log = path.join(tmp, 'fake.log');
  server = await startFakeServer();
  routes = {
    '/api/v1/merge-check': allowedReply,
    '/api/v1/repos': { status: 200, body: { gatedRepos: ['acme/app'] } },
    '/api/v1/merge-report': { status: 200, body: { recorded: true } },
    '/api/v1/override-report': { status: 200, body: { recorded: true } },
  };
  server.reply((req) => routes[req.url] ?? { status: 404 });
  env = {
    PATH: `${BIN}:${process.env.PATH}`,
    ECHO_HOME: path.join(tmp, 'echo'),
    ECHO_TOKEN_STORE: 'file',
    ECHO_AGENT: 'orch',
    FAKE_LOG: log,
    FAKE_GH_STDOUT: PR_VIEW,
  };
  saveConfig(env, { url: server.url, agents: ['orch'], defaultAgent: 'orch' });
  await writeToken('orch', 'tok-orch', env);
});
afterEach(async () => {
  await server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('preBash: the merge check', () => {
  it('refuses a blocking hold, naming placer, time, reason, and that only the placer can release', async () => {
    routes['/api/v1/merge-check'] = { status: 200, body: { gated: true, allowed: false, blocks: [{ kind: 'hold', hold: blocking709 }] } };
    const out = await preBash(bashInput('gh pr merge 709 --squash'), env, T0);
    const r = JSON.parse(out.stdout!).hookSpecificOutput;
    expect(r.hookEventName).toBe('PreToolUse');
    expect(r.permissionDecision).toBe('deny');
    expect(r.permissionDecisionReason).toContain('Merge refused by Echo: acme/app#709 cannot merge now.');
    expect(r.permissionDecisionReason).toContain(
      'Blocking hold 7 by Alice at 2026-11-17T21:08:00Z: blocking finding. Only Alice or the owner can release it',
    );
    expect(r.permissionDecisionReason).toContain('If you are a subagent, do not merge: report this to your orchestrator.');
    const sent = JSON.parse(reqs('/api/v1/merge-check')[0].body);
    expect(sent).toEqual({ repo: 'acme/app', pr: 709, flags: { auto: false, admin: false } });
    expect(reqs('/api/v1/merge-check')[0].headers.authorization).toBe('Bearer tok-orch');
  });

  it('refuses with the missing approvers named, and the other block lines', async () => {
    routes['/api/v1/merge-check'] = {
      status: 200,
      body: {
        gated: true,
        allowed: false,
        blocks: [
          { kind: 'approval_missing', eventId: 1, startsAt: '2026-11-19T03:00:00Z', missing: ['Bob', 'Cy'] },
          { kind: 'no_slot' },
          { kind: 'outside_window', eventId: 2, startsAt: '2026-11-19T03:00:00Z', windowStart: '02:30', windowEnd: '03:30' },
          { kind: 'hold', hold: { ...blocking709, kind: 'advisory', id: 9 } },
        ],
      },
    };
    const text = reason(await preBash(bashInput('gh pr merge 709'), env, T0));
    expect(text).toContain('- Waiting for approval from Bob, Cy for the 2026-11-19T03:00:00Z slot.');
    expect(text).toContain('- No approved merge slot. Schedule it with echo_calendar_add (kind merge) and wait for approval.');
    expect(text).toContain('- Outside the approved window for the 2026-11-19T03:00:00Z slot (02:30 to 03:30). Reschedule and get approval again.');
    expect(text).toContain('Advisory hold 9 by Alice');
    expect(text).toContain('Clear it with echo_ack_hold (hold_id=9, note required).');
  });

  it('an event whose approvers were never asked is explained, not printed as an empty list', async () => {
    routes['/api/v1/merge-check'] = {
      status: 200,
      body: { gated: true, allowed: false, blocks: [{ kind: 'approval_missing', eventId: 1, startsAt: '2026-11-19T03:00:00Z', missing: [] }] },
    };
    const text = reason(await preBash(bashInput('gh pr merge 709'), env, T0));
    expect(text).toContain(
      '- No approvers were asked for the 2026-11-19T03:00:00Z slot; move the event (echo_calendar_update) to send requests, or ask the owner.',
    );
    expect(text).not.toContain('approval from  for');
  });

  it('allows an allowed merge and saves the pending target by tool_use_id', async () => {
    const out = await preBash(bashInput('gh pr merge 709'), env, T0);
    expect(denied(out)).toBe(false);
    expect(out.stdout).toBeUndefined();
    expect(state.takePendingMerge('toolu_1', env)).toEqual({ repo: 'acme/app', pr: 709 });
  });

  it('allows a merge in a repository the service says is not gated, and refreshes the gate cache', async () => {
    routes['/api/v1/merge-check'] = { status: 200, body: { gated: false, allowed: true, blocks: [] } };
    routes['/api/v1/repos'] = { status: 200, body: { gatedRepos: ['other/thing'] } };
    expect(denied(await preBash(bashInput('gh pr merge 709'), env, T0))).toBe(false);
    expect(state.readGateCache(env)?.repos).toEqual(['other/thing']);
  });

  it('a failing gate cache refresh never changes the decision', async () => {
    routes['/api/v1/repos'] = { status: 500 };
    expect(denied(await preBash(bashInput('gh pr merge 709'), env, T0))).toBe(false);
    expect(state.readGateCache(env)).toBeNull();
  });

  it('--admin and --auto in a gated repo are refused and logged with the flags', async () => {
    const admin = await preBash(bashInput('gh pr merge 709 --admin'), env, T0);
    expect(denied(admin)).toBe(true);
    expect(reason(admin)).toContain('Merge refused by Echo: --admin is not allowed in acme/app.');
    expect(reason(admin)).toContain('--admin skips required checks, including echo/hold. Merge directly without it.');
    const auto = await preBash(bashInput('gh pr merge 709 --auto', { tool_use_id: 'toolu_2' }), env, T0);
    expect(reason(auto)).toContain('--auto is not allowed in acme/app. Auto-merge and merge queues let GitHub merge later');
    const sent = reqs('/api/v1/merge-check').map((r) => JSON.parse(r.body));
    expect(sent).toEqual([
      { repo: 'acme/app', pr: 709, flags: { auto: false, admin: true } },
      { repo: 'acme/app', pr: 709, flags: { auto: true, admin: false } },
    ]);
  });

  it('--admin is still refused when the service is down', async () => {
    down();
    expect(denied(await preBash(bashInput('gh pr merge 709 --admin'), env, T0))).toBe(true);
  });

  it('ungated repo with a fetched cache -> allowed even when the service is down', async () => {
    state.writeGateCache(['someone/else'], env);
    down();
    expect(denied(await preBash(bashInput('gh pr merge 709'), env, T0))).toBe(false);
  });

  it('repo missing from a stale cache but gated by the service -> refused', async () => {
    // The cache was fetched before acme/app was registered.
    state.writeGateCache(['someone/else'], env);
    routes['/api/v1/merge-check'] = { status: 200, body: { gated: true, allowed: false, blocks: [{ kind: 'hold', hold: blocking709 }] } };
    const out = await preBash(bashInput('gh pr merge 709'), env, T0);
    expect(denied(out)).toBe(true);
    expect(reason(out)).toContain('blocking finding');
    expect(reqs('/api/v1/merge-check')).toHaveLength(1);
  });

  it('--admin in a repo missing from a stale cache but gated by the service -> refused', async () => {
    state.writeGateCache(['someone/else'], env);
    const out = await preBash(bashInput('gh pr merge 709 --admin'), env, T0);
    expect(denied(out)).toBe(true);
    expect(reason(out)).toContain('--admin is not allowed in acme/app');
  });

  it('a flag in a repo the service says is not gated is allowed', async () => {
    routes['/api/v1/merge-check'] = { status: 200, body: { gated: false, allowed: true, blocks: [] } };
    expect(denied(await preBash(bashInput('gh pr merge 709 --admin'), env, T0))).toBe(false);
    expect(denied(await preBash(bashInput('gh pr merge 709 --auto', { tool_use_id: 'toolu_2' }), env, T0))).toBe(false);
  });

  it('a flag in a repo absent from a fetched cache is allowed when the service is down', async () => {
    state.writeGateCache(['someone/else'], env);
    down();
    expect(denied(await preBash(bashInput('gh pr merge 709 --auto'), env, T0))).toBe(false);
  });

  it('a flag in a repo listed in the cache is refused when the service is down', async () => {
    state.writeGateCache(['acme/app'], env);
    down();
    const out = await preBash(bashInput('gh pr merge 709 --auto'), { ...env, ECHO_MERGE_OVERRIDE: 'acme/app#709' }, T0);
    expect(reason(out)).toContain('--auto is not allowed in acme/app');
  });

  it('a fetched cache that lists the repo still checks it, and refuses when the service is down', async () => {
    state.writeGateCache(['acme/app'], env);
    down();
    expect(denied(await preBash(bashInput('gh pr merge 709'), env, T0))).toBe(true);
  });

  it('no gate cache yet + service down -> refused', async () => {
    down();
    expect(denied(await preBash(bashInput('gh pr merge 709'), env, T0))).toBe(true);
  });

  it('a 5xx from the service counts as unreachable', async () => {
    routes['/api/v1/merge-check'] = { status: 503 };
    const text = reason(await preBash(bashInput('gh pr merge 709'), env, T0));
    expect(text).toContain('the Echo service could not be reached (Echo answered 503)');
  });

  it('commands that are not merges, and --disable-auto, are allowed without calling Echo', async () => {
    expect(denied(await preBash(bashInput('ls -la'), env, T0))).toBe(false);
    expect(denied(await preBash(bashInput('echo "gh pr merge later"'), env, T0))).toBe(false);
    expect(denied(await preBash(bashInput('gh pr merge 709 --disable-auto'), env, T0))).toBe(false);
    expect(server.requests).toHaveLength(0);
  });

  it('slot times from the service lose their milliseconds in the refusal lines', async () => {
    routes['/api/v1/merge-check'] = {
      status: 200,
      body: {
        gated: true,
        allowed: false,
        blocks: [
          { kind: 'approval_missing', eventId: 1, startsAt: '2026-11-19T03:00:00.000Z', missing: ['Bob'] },
          { kind: 'outside_window', eventId: 2, startsAt: '2026-11-19T03:00:00.000Z', windowStart: '2026-11-19T02:30:00.000Z', windowEnd: '2026-11-19T03:30:00.000Z' },
        ],
      },
    };
    const text = reason(await preBash(bashInput('gh pr merge 709'), env, T0));
    expect(text).toContain('- Waiting for approval from Bob for the 2026-11-19T03:00:00Z slot.');
    expect(text).toContain('slot (2026-11-19T02:30:00Z to 2026-11-19T03:30:00Z).');
    expect(text).not.toContain('.000Z');
  });

  it('an ambiguous command is refused with the exact-merge explanation and the fix', async () => {
    const text = reason(await preBash(bashInput("bash -c 'gh pr merge 5'"), env, T0));
    expect(text).toContain('could not tell exactly what this command merges');
    expect(text).toContain('[cd DIR && ]gh pr merge <number> [-R owner/name] [flags]');
    expect(text).toContain('separate `echo`, `grep` or `git commit` command');
    expect(server.requests).toHaveLength(0);
  });

  it('a PR that gh cannot resolve is refused with gh stderr', async () => {
    const e = { ...env, FAKE_GH_EXIT: '1', FAKE_GH_STDERR: 'no pull requests found for branch "x"' };
    const text = reason(await preBash(bashInput('gh pr merge'), e, T0));
    expect(text).toContain('no pull requests found for branch "x"');
    expect(server.requests).toHaveLength(0);
  });

  it('when the command already names the repository and number, a gh failure says gh could not find it', async () => {
    const e = { ...env, FAKE_GH_EXIT: '1', FAKE_GH_STDERR: 'Could not resolve to a Repository' };
    for (const cmd of ['gh pr merge 1 -R acme/app --squash', 'GH_REPO=Acme/App gh pr merge 1', 'gh pr merge https://github.com/acme/app/pull/1']) {
      const out = await preBash(bashInput(cmd), e, T0);
      expect(denied(out)).toBe(true);
      const text = reason(out);
      expect(text).toBe(
        'Merge refused: gh could not find acme/app#1 (Could not resolve to a Repository). Check the repository name and number, and that gh is logged in with access to it (`gh auth status`).',
      );
      expect(text).not.toContain('Name the pull request explicitly');
    }
    expect(server.requests).toHaveLength(0);
  });

  it('when the target was incomplete, the refusal keeps the name-the-pull-request text', async () => {
    const e = { ...env, FAKE_GH_EXIT: '1', FAKE_GH_STDERR: 'no pull requests found' };
    for (const cmd of ['gh pr merge 1', 'gh pr merge -R acme/app', 'gh pr merge']) {
      const text = reason(await preBash(bashInput(cmd), e, T0));
      expect(text).toContain('could not work out which pull request this command merges (no pull requests found)');
      expect(text).toContain('Name the pull request explicitly, for example `gh pr merge <number> -R owner/name`');
    }
  });

  it('a subagent call (agent_id present) is merge-checked exactly like the orchestrator', async () => {
    routes['/api/v1/merge-check'] = { status: 200, body: { gated: true, allowed: false, blocks: [{ kind: 'hold', hold: blocking709 }] } };
    const out = await preBash(bashInput('gh pr merge 709', { agent_id: 'sub-1', agent_type: 'general-purpose' }), env, T0);
    expect(denied(out)).toBe(true);
    expect(reqs('/api/v1/merge-check')).toHaveLength(1);
  });

  it('with no ECHO_AGENT the default agent token is used', async () => {
    const e = { ...env };
    delete e.ECHO_AGENT;
    await preBash(bashInput('gh pr merge 709'), e, T0);
    expect(reqs('/api/v1/merge-check')[0].headers.authorization).toBe('Bearer tok-orch');
  });

  it('no token: refused with the agent name and set-token fix, and the override does not cover it', async () => {
    fs.rmSync(path.join(env.ECHO_HOME!, 'tokens', 'orch'));
    const e = { ...env, ECHO_MERGE_OVERRIDE: 'acme/app#709' };
    const out = await preBash(bashInput('gh pr merge 709'), e, T0);
    expect(denied(out)).toBe(true);
    expect(reason(out)).toContain('no Echo token was found for orch');
    expect(reason(out)).toContain('Store one with `node ~/.echo/echo-hook.mjs set-token orch`');
    expect(server.requests).toHaveLength(0);
    expect(state.overrideState('acme/app#709', e)?.usedAtMs).toBeNull();
  });

  it('no token but the gate cache says the repo is ungated: allowed', async () => {
    fs.rmSync(path.join(env.ECHO_HOME!, 'tokens', 'orch'));
    state.writeGateCache(['other/thing'], env);
    expect(denied(await preBash(bashInput('gh pr merge 709'), env, T0))).toBe(false);
  });

  it('no config at all: refused, not allowed', async () => {
    fs.rmSync(path.join(env.ECHO_HOME!, 'config.json'));
    const out = await preBash(bashInput('gh pr merge 709'), env, T0);
    expect(denied(out)).toBe(true);
    expect(reason(out)).toContain('not configured');
  });
});

describe('preBash: the emergency override', () => {
  it('unreachable + gated -> refused with the override instruction', async () => {
    down();
    const text = reason(await preBash(bashInput('gh pr merge 709'), env, T0));
    expect(text).toContain('is a registered repository, so merges are blocked until Echo answers.');
    expect(text).toContain('ECHO_MERGE_OVERRIDE=acme/app#709');
  });

  it('a different PR in the variable does not allow this merge', async () => {
    down();
    expect(denied(await preBash(bashInput('gh pr merge 709'), { ...env, ECHO_MERGE_OVERRIDE: 'acme/app#710' }, T0))).toBe(true);
  });

  it('override: allowed once, then refused', async () => {
    down();
    const e = { ...env, ECHO_MERGE_OVERRIDE: 'acme/app#709' };
    const first = await preBash(bashInput('gh pr merge 709'), e, T0);
    expect(denied(first)).toBe(false);
    expect(context(first)).toContain('override');
    const second = await preBash(bashInput('gh pr merge 709', { tool_use_id: 'toolu_2' }), e, T0 + 1000);
    expect(denied(second)).toBe(true);
    expect(reason(second)).toContain('already used');
  });

  it('override matches case-insensitively', async () => {
    down();
    expect(denied(await preBash(bashInput('gh pr merge 709'), { ...env, ECHO_MERGE_OVERRIDE: 'Acme/App#709' }, T0))).toBe(false);
  });

  it('override: queues an override report and saves the pending merge', async () => {
    down();
    const e = { ...env, ECHO_MERGE_OVERRIDE: 'acme/app#709' };
    await preBash(bashInput('gh pr merge 709'), e, T0);
    const queued = state.drainReports(e);
    expect(queued).toHaveLength(1);
    expect(queued[0].path).toBe('/api/v1/override-report');
    expect(queued[0].body).toMatchObject({ repo: 'acme/app', pr: 709 });
    expect(state.takePendingMerge('toolu_1', e)).toEqual({ repo: 'acme/app', pr: 709 });
  });

  it('override: still allowed at exactly 30 minutes after first sight', async () => {
    const e = { ...env, ECHO_MERGE_OVERRIDE: 'acme/app#709' };
    expect(OVERRIDE_TTL_MS).toBe(30 * 60_000);
    noteOverrideSeen(e, T0);
    down();
    expect(denied(await preBash(bashInput('gh pr merge 709'), e, T0 + 30 * 60_000))).toBe(false);
  });

  it('override: one millisecond past 30 minutes is refused as expired', async () => {
    const e = { ...env, ECHO_MERGE_OVERRIDE: 'acme/app#709' };
    noteOverrideSeen(e, T0);
    down();
    const out = await preBash(bashInput('gh pr merge 709'), e, T0 + 30 * 60_000 + 1);
    expect(denied(out)).toBe(true);
    expect(reason(out)).toContain('expired');
  });

  it('noteOverrideSeen records the first sight only, and does nothing without the variable', () => {
    noteOverrideSeen(env, T0);
    expect(state.overrideState('acme/app#709', env)).toBeNull();
    const e = { ...env, ECHO_MERGE_OVERRIDE: 'acme/app#709' };
    noteOverrideSeen(e, T0);
    noteOverrideSeen(e, T0 + 5000);
    expect(state.overrideState('acme/app#709', e)).toEqual({ firstSeenMs: T0, usedAtMs: null });
  });

  it('ECHO_MERGE_OVERRIDE in the command text has no effect', async () => {
    down();
    const out = await preBash(bashInput('ECHO_MERGE_OVERRIDE=acme/app#709 gh pr merge 709'), env, T0);
    expect(denied(out)).toBe(true);
    const out2 = await preBash(bashInput('export ECHO_MERGE_OVERRIDE=acme/app#709; gh pr merge 709', { tool_use_id: 'toolu_2' }), env, T0);
    expect(denied(out2)).toBe(true);
    expect(state.overrideState('acme/app#709', env)).toBeNull();
  });

  it('the override never applies when Echo answers: a blocked merge stays blocked', async () => {
    routes['/api/v1/merge-check'] = { status: 200, body: { gated: true, allowed: false, blocks: [{ kind: 'no_slot' }] } };
    const e = { ...env, ECHO_MERGE_OVERRIDE: 'acme/app#709' };
    expect(denied(await preBash(bashInput('gh pr merge 709'), e, T0))).toBe(true);
  });
});

describe('postBash', () => {
  it('uses the target saved by tool_use_id even after --delete-branch switched branches, and reports GitHub\'s mergedAt', async () => {
    await preBash(bashInput('gh pr merge 709 --delete-branch'), env, T0);
    const e = {
      ...env,
      FAKE_GH_STDOUT: JSON.stringify({ url: 'https://github.com/Acme/App/pull/709', state: 'MERGED', mergedAt: '2026-11-19T12:00:07Z' }),
    };
    fs.rmSync(log);
    const out = await postBash(postInput('gh pr merge --delete-branch'), e);
    expect(out.stdout).toBeUndefined();
    const args = ghLog().split('\n').filter((l) => l.startsWith('arg: '));
    expect(args).toEqual(['arg: pr', 'arg: view', 'arg: 709', 'arg: -R', 'arg: acme/app', 'arg: --json', 'arg: url,state,mergedAt']);
    expect(JSON.parse(reqs('/api/v1/merge-report')[0].body)).toEqual({ repo: 'acme/app', pr: 709, mergedAt: '2026-11-19T12:00:07Z' });
    expect(state.takePendingMerge('toolu_1', env)).toBeNull();
  });

  it('PR still OPEN after merge -> runs --disable-auto and explains', async () => {
    await preBash(bashInput('gh pr merge 709'), env, T0);
    fs.rmSync(log);
    const out = await postBash(postInput('gh pr merge 709'), env);
    const logged = ghLog();
    expect(logged).toContain('arg: --disable-auto');
    expect(logged).toContain('arg: merge');
    expect(logged).toContain('arg: acme/app');
    expect(JSON.parse(out.stdout!).hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(context(out)).toContain('acme/app#709');
    expect(context(out)).toContain('--disable-auto');
    expect(reqs('/api/v1/merge-report')).toHaveLength(0);
  });

  it('does nothing when there is no pending target for the tool_use_id', async () => {
    const e = { ...env, FAKE_GH_STDOUT: JSON.stringify({ url: 'https://github.com/Acme/App/pull/709', state: 'MERGED', mergedAt: 'x' }) };
    const out = await postBash(postInput('gh pr merge 709', { tool_use_id: 'toolu_unknown' }), e);
    expect(out).toEqual({ exitCode: 0 });
    expect(ghLog()).toBe('');
    expect(server.requests).toHaveLength(0);
  });

  it('does nothing for a command that was not a merge', async () => {
    state.savePendingMerge('toolu_1', { repo: 'acme/app', pr: 709 }, env);
    expect(await postBash(postInput('ls'), env)).toEqual({ exitCode: 0 });
    expect(ghLog()).toBe('');
  });

  it('queues the merge report when Echo is down, and sends it on the next run', async () => {
    state.savePendingMerge('toolu_1', { repo: 'acme/app', pr: 709 }, env);
    const merged = JSON.stringify({ url: 'https://github.com/Acme/App/pull/709', state: 'MERGED', mergedAt: '2026-11-19T12:00:07Z' });
    const e = { ...env, FAKE_GH_STDOUT: merged };
    down();
    await postBash(postInput('gh pr merge 709'), e);
    expect(reqs('/api/v1/merge-report')).toHaveLength(0);
    saveConfig(env, { url: server.url, agents: ['orch'], defaultAgent: 'orch' });
    await postBash(postInput('ls', { tool_use_id: 'toolu_9' }), e);
    expect(JSON.parse(reqs('/api/v1/merge-report')[0].body)).toEqual({ repo: 'acme/app', pr: 709, mergedAt: '2026-11-19T12:00:07Z' });
  });

  it('drains a queued override report to override-report, and keeps it queued while Echo is down', async () => {
    state.queueReport({ path: '/api/v1/override-report', body: { repo: 'acme/app', pr: 709, reason: 'r' } }, env);
    down();
    await postBash(postInput('ls'), env);
    expect(server.requests).toHaveLength(0);
    saveConfig(env, { url: server.url, agents: ['orch'], defaultAgent: 'orch' });
    await postBash(postInput('ls'), env);
    expect(JSON.parse(reqs('/api/v1/override-report')[0].body)).toEqual({ repo: 'acme/app', pr: 709, reason: 'r' });
    expect(state.drainReports(env)).toEqual([]);
  });
});

describe('main dispatch', () => {
  const none = (): string => '';

  it('any thrown error in pre-bash is a refusal, not a crash', async () => {
    const out = await dispatch('pre-bash', () => 'not json{', env, T0);
    expect(denied(out as HookOutput)).toBe(true);
    expect(reason(out as HookOutput)).toContain('refused');
    routes['/api/v1/merge-check'] = { status: 403, body: { error: { code: 'X', message: 'no', fix: 'fix' } } };
    const input = JSON.stringify(bashInput('gh pr merge 709'));
    const out2 = await dispatch('pre-bash', () => input, env, T0);
    expect(denied(out2 as HookOutput)).toBe(true);
  });

  it('pre-bash through dispatch runs the check and notes the override on the way in', async () => {
    down();
    const e = { ...env, ECHO_MERGE_OVERRIDE: 'acme/app#709' };
    const out = await dispatch('pre-bash', () => JSON.stringify(bashInput('gh pr merge 709')), e, T0);
    expect(denied(out as HookOutput)).toBe(false);
    expect(state.overrideState('acme/app#709', e)?.firstSeenMs).toBe(T0);
  });

  it('every event notes the override first, so the 30 minutes count from session start', async () => {
    const e = { ...env, ECHO_MERGE_OVERRIDE: 'acme/app#709' };
    await dispatch('session-start', none, e, T0);
    expect(state.overrideState('acme/app#709', e)?.firstSeenMs).toBe(T0);
  });

  it.each(['session-start', 'prompt', 'post-tool', 'stop'])('%s with unusable input prints nothing and exits 0', async (ev) => {
    expect(await dispatch(ev, none, env, T0)).toEqual({ exitCode: 0 });
  });

  it('post-bash with unparseable input prints nothing and exits 0', async () => {
    expect(await dispatch('post-bash', () => '{{', env, T0)).toEqual({ exitCode: 0 });
  });

  it('version prints the package version', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../package.json'), 'utf8')) as { version?: string };
    const out = (await dispatch('version', none, env, T0)) as HookOutput;
    expect(out.stdout?.trim()).toBe(pkg.version);
  });
});

describe('fix round 1', () => {
  it.each([
    ['an empty answer', {}],
    ['gated null', { gated: null, allowed: true, blocks: [] }],
    ['allowed as a string', { gated: true, allowed: 'yes', blocks: [] }],
    ['allowed:false with no blocks', { gated: true, allowed: false }],
    ['gated as a string', { gated: 'false', allowed: true }],
  ])('a malformed merge-check answer (%s) is refused', async (_n, body) => {
    routes['/api/v1/merge-check'] = { status: 200, body };
    const out = await preBash(bashInput('gh pr merge 709'), env, T0);
    expect(denied(out)).toBe(true);
    expect(reason(out)).toContain('Echo returned an unexpected merge-check answer');
    expect(state.takePendingMerge('toolu_1', env)).toBeNull();
  });

  it('a 4xx from merge-check is refused with the service message and fix', async () => {
    routes['/api/v1/merge-check'] = { status: 403, body: { error: { code: 'X', message: 'Token revoked.', fix: 'Ask the owner for a new token.' } } };
    const out = await preBash(bashInput('gh pr merge 709'), env, T0);
    expect(reason(out)).toBe('Token revoked. Ask the owner for a new token.');
  });

  it('expired and used override texts do not suggest restarting with the same value', async () => {
    down();
    const e = { ...env, ECHO_MERGE_OVERRIDE: 'acme/app#709' };
    noteOverrideSeen(e, T0);
    const expired = reason(await preBash(bashInput('gh pr merge 709'), e, T0 + OVERRIDE_TTL_MS + 1));
    expect(expired).toContain('remove echo/hold from the repository');
    expect(expired).not.toContain('restarting');
    const e2 = { ...env, ECHO_MERGE_OVERRIDE: 'acme/app#709', ECHO_HOME: path.join(tmp, 'echo2') };
    saveConfig(e2, { url: 'http://127.0.0.1:1', agents: ['orch'], defaultAgent: 'orch' });
    await writeToken('orch', 'tok-orch', e2);
    await preBash(bashInput('gh pr merge 709'), e2, T0);
    const used = reason(await preBash(bashInput('gh pr merge 709', { tool_use_id: 'toolu_2' }), e2, T0 + 1));
    expect(used).toContain('remove echo/hold from the repository');
    expect(used).not.toContain('restarting');
  });

  it('the gate cache refresh uses a short timeout and cannot hold up the decision past it', async () => {
    routes['/api/v1/repos'] = { status: 200, body: { gatedRepos: ['acme/app'] } };
    server.reply((req) => (req.url === '/api/v1/repos' ? { status: 200, body: { gatedRepos: ['acme/app'] }, delayMs: 3000 } : routes[req.url] ?? { status: 404 }));
    const t = Date.now();
    expect(denied(await preBash(bashInput('gh pr merge 709'), env, T0))).toBe(false);
    expect(Date.now() - t).toBeLessThan(2900);
    expect(state.readGateCache(env)).toBeNull();
  }, 10_000);

  it('a queued report that gets a 4xx is dropped; one that meets an outage is kept', async () => {
    state.queueReport({ path: '/api/v1/override-report', body: { repo: 'acme/app', pr: 709, reason: 'r' } }, env);
    routes['/api/v1/override-report'] = { status: 400, body: { error: { code: 'BAD_REQUEST', message: 'm', fix: 'f' } } };
    await postBash(postInput('ls'), env);
    expect(reqs('/api/v1/override-report')).toHaveLength(1);
    expect(state.drainReports(env)).toEqual([]);
    state.queueReport({ path: '/api/v1/override-report', body: { repo: 'acme/app', pr: 709, reason: 'r' } }, env);
    routes['/api/v1/override-report'] = { status: 503 };
    await postBash(postInput('ls'), env);
    expect(state.drainReports(env)).toHaveLength(1);
  });

  it('the CLI entry point refuses when run through a symlinked path', () => {
    const real = path.join(tmp, 'real');
    fs.mkdirSync(real);
    buildSync({
      entryPoints: [path.join(import.meta.dirname, '../src/cli.ts')],
      bundle: true, platform: 'node', format: 'esm', outfile: path.join(real, 'cli.mjs'), logLevel: 'silent',
    });
    const link = path.join(tmp, 'link');
    fs.symlinkSync(real, link);
    const r = spawnSync(process.execPath, [path.join(link, 'cli.mjs'), 'pre-bash'], {
      input: JSON.stringify(bashInput("bash -c 'gh pr merge 5'")),
      env, encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});
