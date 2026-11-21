import { api, Refused, Unreachable } from './client';
import { loadConfig } from './config';
import * as format from './format';
import type { HookInput } from './input';
import type { HookOutput } from './merge-pre';
import { addStopShown, lastPoll, setLastPoll, stopShown, writeGateCache } from './state';
import { messageIdentity } from './token-store';

export const POLL_INTERVAL_MS = 30_000;
const NOTHING: HookOutput = { exitCode: 0 };

type Reply = Record<string, unknown>;
/** null: this hook must not run (no identity, subagent, or throttled). */
type Called = { ok: true; reply: Reply } | { ok: false; error: unknown } | null;

/** Resolves the identity, calls the route, and refreshes the gate cache from gatedRepos when it is an array of strings. */
async function call(
  input: HookInput,
  env: NodeJS.ProcessEnv,
  path: string,
  /** Runs once the identity is known, before the call; returning false skips the call. */
  before?: (name: string) => boolean,
): Promise<Called> {
  const cfg = loadConfig(env);
  if (!cfg) return null;
  const id = await messageIdentity(cfg, env, input);
  if (!id) return null;
  if (before && !before(id.name)) return null;
  try {
    const reply = (await api(cfg, id.token, path, {})) as Reply | null;
    if (!reply || typeof reply !== 'object') throw new Unreachable('Echo returned an unexpected response');
    const g = reply.gatedRepos;
    if (Array.isArray(g) && g.every((r) => typeof r === 'string')) {
      try {
        writeGateCache(g as string[], env);
      } catch {
        /* the cache is best effort and never changes what the hook prints */
      }
    }
    return { ok: true, reply };
  } catch (error) {
    return { ok: false, error };
  }
}

const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export async function sessionStart(input: HookInput, env: NodeJS.ProcessEnv): Promise<HookOutput> {
  const r = await call(input, env, '/api/v1/orient');
  if (!r) return NOTHING;
  if (!r.ok) {
    if (r.error instanceof Refused) return { stdout: `Echo: ${r.error.message} ${r.error.fix}\n`, exitCode: 0 };
    if (r.error instanceof Unreachable) {
      return { stdout: 'Echo: service unreachable; messages, holds and approvals could not be loaded.\n', exitCode: 0 };
    }
    throw r.error;
  }
  const o = r.reply;
  const text = format.orientation({
    now: String(o.now),
    agent: (o.agent as { name: string }) ?? { name: '' },
    projects: list(o.projects),
    fresh: list(o.fresh),
    awaitingAck: list(o.awaitingAck),
    openHolds: list(o.openHolds),
    pendingApprovals: list(o.pendingApprovals),
  });
  return { stdout: text + '\n', exitCode: 0 };
}

async function poll(input: HookInput, env: NodeJS.ProcessEnv, before?: (name: string) => boolean): Promise<string> {
  const r = await call(input, env, '/api/v1/poll', before);
  if (!r || !r.ok) return '';
  return format.newMessages(list(r.reply.fresh), list(r.reply.awaitingAck));
}

export async function promptSubmit(input: HookInput, env: NodeJS.ProcessEnv): Promise<HookOutput> {
  const text = await poll(input, env);
  return text ? { stdout: text + '\n', exitCode: 0 } : NOTHING;
}

export async function postTool(input: HookInput, env: NodeJS.ProcessEnv, nowMs: number = Date.now()): Promise<HookOutput> {
  const text = await poll(input, env, (name) => {
    if (nowMs - lastPoll(name, env) < POLL_INTERVAL_MS) return false;
    // Written before the call, so a failing service is still polled at most once per interval.
    setLastPoll(name, nowMs, env);
    return true;
  });
  return text
    ? { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }), exitCode: 0 }
    : NOTHING;
}

export async function stop(input: HookInput, env: NodeJS.ProcessEnv): Promise<HookOutput> {
  const r = await call(input, env, '/api/v1/stop-check');
  if (!r || !r.ok) return NOTHING;
  // Applies even when stop_hook_active is set: once per message per session is what prevents loops.
  const shown = stopShown(input.session_id, env);
  const items = list<format.MessageItem>(r.reply.awaitingAck).filter((m) => !shown.has(m.messageId));
  if (items.length === 0) return NOTHING;
  addStopShown(
    input.session_id,
    items.map((m) => m.messageId),
    env,
  );
  return { stdout: JSON.stringify({ decision: 'block', reason: format.stopBlocked(items) }), exitCode: 0 };
}
