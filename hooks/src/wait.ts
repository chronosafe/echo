import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { api, Refused, Unreachable } from './client';
import { echoHome, loadConfig, type EchoConfig } from './config';
import type { CommandResult } from './install';
import { NAME_RE, readToken } from './token-store';

export const WAIT_EXIT = { found: 0, config: 2, timeout: 3, auth: 4, alreadyWaiting: 5, orphaned: 6 } as const;
export const DEFAULT_INTERVAL_S = 25;
export const DEFAULT_TIMEOUT_S = 4 * 60 * 60;
const INTERVAL_RANGE = [5, 300] as const;
const TIMEOUT_RANGE = [1, 86_400] as const;
const BACKOFF_CAP_MS = 120_000;
const MAX_LISTED = 10;

export type WaitDeps = {
  call: (cfg: EchoConfig, token: string, path: string, body: unknown) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  isAlive: (pid: number) => boolean;
  pid: number;
  /** The parent PID right now. A waiter whose parent changes has been orphaned. */
  ppid: () => number;
  /**
   * The parent of the given process, or null when unknown. Under Claude Code's Bash tool the waiter's parent is a
   * short-lived-looking `zsh -c` wrapper that outlives a dead harness, so the harness is the grandparent and is
   * watched through this.
   */
  parentOf: (pid: number) => number | null;
  /** The command name of the given process, or null when unknown. */
  commOf: (pid: number) => string | null;
};

/**
 * Where the waiter came from, captured once at start and used for both the lock and the orphan checks. `chain` is the
 * run of shell ancestors from the parent up to the topmost shell (empty when the parent is not a shell), and `harness`
 * is the first non-shell process above it (the Claude Code process, or the app that launched it), or null when unknown. Under the Bash
 * tool the parent is a `zsh -c` wrapper that outlives a dead harness; a subshell or `sh -c` can add more shells.
 */
type Born = { ppid: number; chain: number[]; harness: number | null };

function ps(column: string, pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', `${column}=`, '-p', String(pid)], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim();
  } catch {
    return null;
  }
}

/** A shell: the Bash tool's `zsh -c` wrapper is one, and the first non-shell above it is the harness. */
const SHELL = /(^|\/)-?(zsh|bash|sh|dash|ksh|fish)$/;
/** What PID 1 is on a real host. A harness that is PID 1 inside a container is not one of these. */
const INIT = /(^|\/)(launchd|init|systemd)$/;
const MAX_WALK = 8;

const twice = <T,>(f: () => T | null): T | null => f() ?? f();

function lookupBorn(deps: WaitDeps, ppid: number): Born {
  const comm = twice(() => deps.commOf(ppid));
  if (comm === null || !SHELL.test(comm)) return { ppid, chain: [], harness: null };
  const chain = [ppid];
  let harness: number | null = null;
  for (let i = 0; i < MAX_WALK; i++) {
    const up = twice(() => deps.parentOf(chain[chain.length - 1]));
    if (up === null) break; // unknown: watch what we can
    const c = up <= 1 ? null : twice(() => deps.commOf(up));
    if (c !== null && SHELL.test(c)) {
      chain.push(up);
      continue;
    }
    harness = up;
    break;
  }
  return { ppid, chain, harness };
}

const detachedHarness = (deps: WaitDeps, harness: number | null): boolean => {
  if (harness !== 1) return false;
  const c = twice(() => deps.commOf(1));
  return c !== null && INIT.test(c);
};

/** True when the process that started the waiter is gone: its parent changed, or a recorded link of the shell chain broke. */
function orphanedNow(deps: WaitDeps, born: Born): boolean {
  if (deps.ppid() !== born.ppid) return true;
  for (let i = 0; i < born.chain.length; i++) {
    const pid = born.chain[i];
    const expected = i + 1 < born.chain.length ? born.chain[i + 1] : born.harness;
    const cur = deps.parentOf(pid);
    if (cur === null) {
      if (!deps.isAlive(pid)) return true;
      continue; // ps did not answer: no change
    }
    if (expected !== null && cur !== expected) return true;
  }
  return false;
}

export const realWaitDeps = (): WaitDeps => ({
  call: (cfg, token, p, body) => api(cfg, token, p, body, 10_000),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  pid: process.pid,
  ppid: () => process.ppid,
  parentOf: (pid) => {
    const out = ps('ppid', pid);
    const n = Number(out);
    return out !== null && /^\d+$/.test(out) && n >= 0 ? n : null;
  },
  commOf: (pid) => ps('comm', pid) || null,
});

const fail = (exitCode: number, msg: string): CommandResult => ({ stderr: `echo wait: ${msg}\n`, exitCode });

function parseArgs(args: string[]): { intervalS: number; timeoutS: number } | string {
  const out = { intervalS: DEFAULT_INTERVAL_S, timeoutS: DEFAULT_TIMEOUT_S };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const m = /^--(interval|timeout)(?:=(.*))?$/.exec(a);
    if (!m) return `unknown argument "${a}". Usage: wait [--interval S] [--timeout S]`;
    const raw = m[2] ?? args[++i];
    const [lo, hi] = m[1] === 'interval' ? INTERVAL_RANGE : TIMEOUT_RANGE;
    const n = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < lo || n > hi) return `--${m[1]} must be a whole number of seconds from ${lo} to ${hi}.`;
    if (m[1] === 'interval') out.intervalS = n;
    else out.timeoutS = n;
  }
  return out;
}

/** A held lock whose file has not been touched for this long is stale even if its PID is alive (PID reuse after a crash). */
const LOCK_STALE_MS = 15 * 60_000;
const TAKEOVER_STALE_MS = 10_000;

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const ageMs = (file: string): number => {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * Takes the takeover mutex (a directory, so mkdir is atomic). A mutex a crashed starter left behind is cleared after
 * TAKEOVER_STALE_MS. Returns false when someone else holds it; the caller retries.
 */
function enterMutex(mutex: string, deps: WaitDeps): boolean {
  try {
    fs.mkdirSync(mutex);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  if (ageMs(mutex) > TAKEOVER_STALE_MS) {
    try {
      // Rename first: only one starter can move a given directory away.
      const gone = `${mutex}.old.${deps.pid}.${randomBytes(4).toString('hex')}`;
      fs.renameSync(mutex, gone);
      // Two starters can both have seen the same stale mutex; the second rename may have moved a fresh one. Keep it then.
      if (ageMs(gone) > TAKEOVER_STALE_MS) fs.rmSync(gone, { recursive: true, force: true });
      else {
        try {
          fs.renameSync(gone, mutex);
        } catch {
          fs.rmSync(gone, { recursive: true, force: true }); // someone made a new mutex meanwhile: do not leak the parked one
        }
      }
    } catch {
      /* another starter cleared it */
    }
  } else pause(50);
  return false;
}

type Held = { pid: number; ppid: number | null; top: number | null; harness: number | null };

function parseLock(text: string): Held {
  const [p0, p1, p2, p3] = text.trim().split(/\s+/);
  const n = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : null);
  return { pid: n(p0) ?? NaN, ppid: n(p1), top: n(p2), harness: n(p3) };
}

/**
 * One waiter per agent: a lock file holding "pid ppid top harness nonce". The file is created whole (temp file, then link,
 * which fails if the lock exists), so it is never seen empty. A stale lock is taken over, and our own lock released,
 * under the takeover mutex, which re-checks the file first, so nobody removes a lock that a newer waiter now owns.
 * Stale means: the holder's PID is dead, its parent, topmost shell or harness (recorded at its start) is gone or changed
 * (it is orphaned and will exit on its own at its next check), its parent was PID 1 at start (started detached), or
 * the file was not touched for LOCK_STALE_MS. Returns release and touch functions, or who holds the lock.
 */
function acquireLock(
  file: string,
  deps: WaitDeps,
  born: Born,
): { release: () => void; touch: () => boolean } | { heldBy: number; heldByParent: number | null } {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mutex = file + '.takeover';
  const mine = `${deps.pid} ${born.ppid} ${born.chain.at(-1) ?? '-'} ${born.harness ?? '-'} ${randomBytes(6).toString('hex')}\n`;
  const tryCreate = (): boolean => {
    const tmp = `${file}.${deps.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, mine, { mode: 0o600 });
      fs.linkSync(tmp, file);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  };
  const isStale = (t: string): { stale: boolean; held: Held } => {
    const held = parseLock(t);
    // Our own PID cannot be a live other waiter here: we have not created the lock yet (a reused PID after a crash).
    const live = Number.isInteger(held.pid) && held.pid !== deps.pid && deps.isAlive(held.pid);
    let orphaned = false;
    if (held.ppid !== null) {
      // Parent 1 at start: the holder was started detached (with & or nohup) and never had a harness to wake.
      orphaned = held.ppid === 1 || !deps.isAlive(held.ppid);
      if (!orphaned && held.top !== null) {
        const above = deps.parentOf(held.top);
        orphaned = !deps.isAlive(held.top) || (held.harness !== null && above !== null && above !== held.harness);
      }
      if (!orphaned && held.harness !== null) orphaned = held.harness === 1 ? detachedHarness(deps, 1) : !deps.isAlive(held.harness);
    }
    return { stale: !live || orphaned || ageMs(file) > LOCK_STALE_MS, held };
  };
  for (let attempt = 0; attempt < 260; attempt++) {
    // 260 x 50 ms is about 13 s: longer than a crashed starter's mutex survives.
    if (tryCreate()) {
      return {
        release: () => {
          // Under the mutex, so a starter that just took the lock over is never undone. If the mutex stays busy the
          // lock is left: its PID is dead after we exit, and the next starter takes it over.
          for (let i = 0; i < 40; i++) {
            try {
              if (!enterMutex(mutex, deps)) continue;
            } catch {
              return; // the Echo home became unwritable: leave the lock, it goes stale with our PID
            }
            try {
              if (fs.readFileSync(file, 'utf8') === mine) fs.unlinkSync(file);
            } catch {
              /* already gone */
            } finally {
              fs.rmSync(mutex, { recursive: true, force: true });
            }
            return;
          }
        },
        /** False when the lock is no longer ours (taken over, or deleted): the caller must stop. */
        touch: () => {
          try {
            if (fs.readFileSync(file, 'utf8') !== mine) return false;
            const now = new Date();
            fs.utimesSync(file, now, now);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
            /* anything else is best effort */
          }
          return true;
        },
      };
    }
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // vanished between the two calls: try again
    }
    const first = isStale(text);
    if (!first.stale) return { heldBy: first.held.pid, heldByParent: first.held.ppid };
    if (!enterMutex(mutex, deps)) continue;
    try {
      // Re-check under the mutex: only remove the very lock we judged stale.
      if (fs.readFileSync(file, 'utf8') === text && isStale(text).stale) fs.unlinkSync(file);
    } catch {
      /* gone already */
    } finally {
      fs.rmSync(mutex, { recursive: true, force: true });
    }
  }
  throw new Error('could not take the waiter lock (another waiter is starting at the same moment; try again)');
}

const oneLine = (s: unknown) => String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 80);

/** null when the reply is not the documented shape; the caller treats that as a service problem to retry. */
function summary(reply: unknown): { count: number; line: string } | null {
  const r = reply as { count?: unknown; messages?: unknown } | null;
  if (!r || typeof r !== 'object' || !Number.isInteger(r.count) || (r.count as number) < 0 || !Array.isArray(r.messages)) return null;
  const count = r.count as number;
  const entries = r.messages as unknown[];
  for (const m of entries) {
    const e = m as { messageId?: unknown; from?: unknown } | null;
    if (!e || typeof e !== 'object' || !Number.isInteger(e.messageId) || typeof e.from !== 'string') return null;
  }
  if (count === 0) return { count: 0, line: '' };
  const items = (entries as { messageId: number; from: string }[]).slice(0, MAX_LISTED).map((m) => `#${m.messageId} from ${oneLine(m.from)}`);
  const more = count > items.length ? `, and ${count - items.length} more` : '';
  return { count, line: `echo: ${count} message(s) waiting: ${items.join(', ')}${more}. Read them with echo_inbox, with no project filter.\n` };
}

export async function waitCommand(args: string[], env: NodeJS.ProcessEnv, deps: WaitDeps = realWaitDeps()): Promise<CommandResult> {
  const opts = parseArgs(args);
  if (typeof opts === 'string') return fail(WAIT_EXIT.config, opts);
  const name = env.ECHO_AGENT;
  if (!name) return fail(WAIT_EXIT.config, 'ECHO_AGENT is not set, so there is no agent to wait for. Set it to the agent name Echo knows you by.');
  if (!NAME_RE.test(name)) return fail(WAIT_EXIT.config, 'ECHO_AGENT is not a valid agent name.');
  const cfg = loadConfig(env);
  if (!cfg) return fail(WAIT_EXIT.config, 'Echo is not set up on this machine (no usable config.json in the Echo home). Run the installer.');
  if (!cfg.agents.includes(name)) return fail(WAIT_EXIT.config, `"${name}" is not an agent configured on this machine.`);
  const token = await readToken(name, env);
  if (!token) return fail(WAIT_EXIT.config, `no token stored for "${name}". Store one with the token command.`);

  // One reading of where we came from, used for the lock and for every later orphan check.
  const ppid = deps.ppid();
  if (ppid === 1) {
    return fail(WAIT_EXIT.orphaned, 'the waiter has no parent process (it was started detached, for example with & or nohup), so nothing would wake from it. Start it with the Bash tool\'s run_in_background.');
  }
  // Shell ancestors are walked up to the first non-shell: that is the harness. A harness that is a real init means the
  // waiter was started detached one shell deep (for example `nohup sh -c ... &`), so nothing would wake from it.
  const born = lookupBorn(deps, ppid);
  if (detachedHarness(deps, born.harness)) {
    return fail(WAIT_EXIT.orphaned, 'the waiter was started detached (for example with nohup or &), so nothing would wake from it. Start it with the Bash tool\'s run_in_background.');
  }
  let lock: ReturnType<typeof acquireLock>;
  try {
    lock = acquireLock(path.join(echoHome(env), `wait-${name}.lock`), deps, born);
  } catch (e) {
    return fail(WAIT_EXIT.config, e instanceof Error ? e.message : String(e));
  }
  if ('heldBy' in lock) {
    const by = lock.heldByParent === null ? '' : `, started by PID ${lock.heldByParent}`;
    return fail(
      WAIT_EXIT.alreadyWaiting,
      `already waiting for "${name}" (PID ${lock.heldBy}${by}). One waiter at a time. If that is not one of your own background tasks, tell the owner.`,
    );
  }

  const onSignal = (code: number) => () => {
    lock.release();
    process.exit(code);
  };
  const sigint = onSignal(130);
  const sigterm = onSignal(143);
  process.once('SIGINT', sigint);
  process.once('SIGTERM', sigterm);
  try {
    const intervalMs = opts.intervalS * 1000;
    const deadline = deps.now() + opts.timeoutS * 1000;
    let failures = 0;
    for (;;) {
      if (orphanedNow(deps, born)) {
        return fail(WAIT_EXIT.orphaned, 'the process that started this waiter is gone, so nobody would be woken. Exiting.');
      }
      if (!lock.touch()) return fail(WAIT_EXIT.orphaned, 'the waiter lock was taken over or removed. Exiting so only one waiter runs.');
      let delay = intervalMs;
      try {
        const s = summary(await deps.call(cfg, token, '/api/v1/peek', {}));
        if (!s) throw new Unreachable('Echo returned an unexpected response');
        failures = 0;
        if (s.count > 0) return { stdout: s.line, exitCode: WAIT_EXIT.found };
      } catch (e) {
        const retryable = e instanceof Unreachable || (e instanceof Refused && [408, 425, 429].includes(e.status));
        if (!retryable) {
          if (e instanceof Refused) return fail(WAIT_EXIT.auth, `Echo refused the request (${e.status}): ${e.message} ${e.fix}`);
          return fail(WAIT_EXIT.config, `unexpected error: ${e instanceof Error ? e.message : 'unknown'}`);
        }
        failures++;
        delay = Math.min(Math.max(intervalMs, BACKOFF_CAP_MS), intervalMs * 2 ** failures);
        if (e instanceof Refused && e.retryAfterMs) delay = Math.min(Math.max(delay, e.retryAfterMs), 300_000);
      }
      const left = deadline - deps.now();
      if (left <= 0) return fail(WAIT_EXIT.timeout, `no messages within ${opts.timeoutS}s. Start another waiter only if a reply is still expected.`);
      await deps.sleep(Math.min(delay, left));
    }
  } finally {
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
    lock.release();
  }
}
