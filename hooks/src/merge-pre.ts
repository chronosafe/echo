import { api, Refused, Unreachable } from './client';
import { loadConfig } from './config';
import * as format from './format';
import type { HookInput } from './input';
import { parseMerge } from './parse-merge';
import { CannotResolve, namedTarget, resolvePr, type PrTarget } from './resolve-pr';
import {
  overrideState,
  queueReport,
  readGateCache,
  savePendingMerge,
  setOverrideState,
  writeGateCache,
} from './state';
import { mergeCheckToken } from './token-store';

export type HookOutput = { stdout?: string; exitCode: 0 };

export const OVERRIDE_TTL_MS = 30 * 60_000;
const MERGE_CHECK_TIMEOUT_MS = 10_000;
const REPOS_TIMEOUT_MS = 2_000;

export function deny(reason: string): HookOutput {
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    }),
    exitCode: 0,
  };
}
const allow = (context?: string): HookOutput =>
  context === undefined
    ? { exitCode: 0 }
    : { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } }), exitCode: 0 };

const overrideKey = (env: NodeJS.ProcessEnv): string => (env.ECHO_MERGE_OVERRIDE ?? '').trim().toLowerCase();

/** Records when any hook first saw the override variable, so the 30 minutes count from session start. */
export function noteOverrideSeen(env: NodeJS.ProcessEnv, nowMs: number): void {
  const key = overrideKey(env);
  if (!key || overrideState(key, env)) return;
  setOverrideState(key, { firstSeenMs: nowMs, usedAtMs: null }, env);
}

export async function preBash(input: HookInput, env: NodeJS.ProcessEnv, nowMs: number = Date.now()): Promise<HookOutput> {
  noteOverrideSeen(env, nowMs);
  const command = input.tool_input?.command;
  if (input.tool_name !== 'Bash' || typeof command !== 'string') return allow();
  const parsed = parseMerge(command, input.cwd);
  if (parsed.kind === 'none') return allow();
  if (parsed.kind === 'ambiguous') return deny(format.ambiguousMerge(parsed.why));
  const inv = parsed.inv;
  if (inv.disableAuto) return allow();

  let target: PrTarget;
  try {
    const r = await resolvePr(inv, env);
    target = { repo: r.repo, pr: r.pr };
  } catch (e) {
    if (e instanceof CannotResolve) return deny(format.cannotResolve(e.message, e.ghRefused ? (namedTarget(inv) ?? undefined) : undefined));
    throw e;
  }

  // The gate cache is consulted only when Echo cannot be asked: it may predate a repository's registration.
  // A repository absent from a fetched cache is taken as ungated; one listed in it, or no cache, as gated.
  const cache = readGateCache(env);
  const ungatedByCache = cache !== null && !cache.repos.includes(target.repo);
  const flag = inv.auto ? '--auto' : inv.admin ? '--admin' : null;

  const cfg = loadConfig(env);
  const token = cfg ? await mergeCheckToken(cfg, env) : null;
  const flags = { auto: inv.auto, admin: inv.admin };

  if (!cfg || !token) {
    if (ungatedByCache) return allow();
    if (flag) return deny(format.flagRefused(target, flag));
    if (!cfg) return deny(format.notConfigured());
    return deny(format.noToken(env.ECHO_AGENT || cfg.defaultAgent));
  }

  // The gate cache refresh runs alongside the check, with a short timeout, and never affects the decision.
  const refresh = (async () => {
    try {
      const r = (await api(cfg, token, '/api/v1/repos', undefined, REPOS_TIMEOUT_MS)) as { gatedRepos?: unknown };
      if (Array.isArray(r.gatedRepos)) writeGateCache(r.gatedRepos.filter((x): x is string => typeof x === 'string'), env);
    } catch {
      /* best effort */
    }
  })();
  let check: { gated?: unknown; allowed?: unknown; blocks?: unknown } | null;
  try {
    check = (await api(cfg, token, '/api/v1/merge-check', { ...target, flags }, MERGE_CHECK_TIMEOUT_MS)) as typeof check;
  } catch (e) {
    await refresh;
    if (e instanceof Unreachable) {
      if (ungatedByCache) return allow();
      if (flag) return deny(format.flagRefused(target, flag));
      return whenUnreachable(input, env, target, e.message, nowMs);
    }
    if (e instanceof Refused) return deny(`${e.message} ${e.fix}`);
    throw e;
  }
  await refresh;
  if (check?.gated === false) return allow();
  // In a gated repository --auto and --admin are refused whatever the decision (spec 6.5); the service logged it.
  if (check?.gated === true && flag) return deny(format.flagRefused(target, flag));
  if (check?.gated === true && check.allowed === false && Array.isArray(check.blocks)) {
    return deny(format.blocked(target, check.blocks as format.Block[]));
  }
  if (check?.gated !== true || check.allowed !== true) {
    return deny(
      'Echo returned an unexpected merge-check answer; merges into registered repositories are refused until it answers normally.',
    );
  }
  if (input.tool_use_id) savePendingMerge(input.tool_use_id, target, env);
  return allow();
}

function whenUnreachable(input: HookInput, env: NodeJS.ProcessEnv, t: PrTarget, detail: string, nowMs: number): HookOutput {
  const key = `${t.repo}#${t.pr}`;
  if (overrideKey(env) !== key) return deny(format.unreachable(t, detail));
  const state = overrideState(key, env) ?? { firstSeenMs: nowMs, usedAtMs: null };
  if (state.usedAtMs !== null) return deny(format.overrideUsed(key));
  if (nowMs - state.firstSeenMs > OVERRIDE_TTL_MS) return deny(format.overrideExpired(key));
  // Read-then-write is not atomic: two hooks racing could both pass. GitHub rejects a second merge of the same PR, so this is accepted.
  setOverrideState(key, { ...state, usedAtMs: nowMs }, env);
  queueReport(
    { path: '/api/v1/override-report', body: { repo: t.repo, pr: t.pr, reason: `Echo unreachable (${detail}); ECHO_MERGE_OVERRIDE used` } },
    env,
  );
  if (input.tool_use_id) savePendingMerge(input.tool_use_id, t, env);
  return allow(format.overrideAllowed(key));
}
