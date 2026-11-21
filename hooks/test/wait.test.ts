import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, Refused, Unreachable } from '../src/client';
import { saveConfig } from '../src/config';
import { dispatch } from '../src/main';
import { writeToken } from '../src/token-store';
import { realWaitDeps, waitCommand, type WaitDeps } from '../src/wait';
import { startFakeServer, type FakeServer } from './fake-server';

const TOKEN = 'tok-SECRET-wait-9f3a';
let tmp: string;
let env: NodeJS.ProcessEnv;
let lockFile: string;

const found = (n = 2) => ({
  now: 'x',
  count: n,
  messages: [
    { messageId: 41, from: 'Carol' },
    { messageId: 42, from: 'Alice' },
  ].slice(0, n),
});
const none = { now: 'x', count: 0, messages: [] };

/** A fake clock: sleeping advances it, and every sleep length is recorded. No real time passes. */
type Proc = { ppid: number | null; comm: string };
/** A tiny process table: 100 is the Bash tool's zsh wrapper, 50 the harness (claude), 1 launchd. Tests mutate it to simulate deaths. */
const table = (extra: Record<number, Proc> = {}): Record<number, Proc> => ({
  100: { ppid: 50, comm: '/bin/zsh' },
  50: { ppid: 10, comm: '/usr/local/bin/claude' },
  10: { ppid: 1, comm: '/Applications/Launcher' },
  1: { ppid: 0, comm: '/sbin/launchd' },
  ...extra,
});

function harness(replies: (() => unknown)[], over: Partial<WaitDeps> & { procs?: Record<number, Proc> } = {}) {
  const { procs = table(), ...rest } = over;
  let t = 1_000_000;
  const sleeps: number[] = [];
  const calls: { path: string; body: unknown; token: string }[] = [];
  let i = 0;
  const deps: WaitDeps = {
    call: async (_cfg, token, p, body) => {
      calls.push({ path: p, body, token });
      const r = replies[Math.min(i++, replies.length - 1)]();
      return r;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    now: () => t,
    isAlive: () => false,
    pid: 4242,
    ppid: () => 100,
    parentOf: (pid) => procs[pid]?.ppid ?? null,
    commOf: (pid) => procs[pid]?.comm ?? null,
    ...rest,
  };
  return { deps, sleeps, calls, procs };
}
const reply = (v: unknown) => () => v;
const boom = (e: Error) => () => {
  throw e;
};
const refused = (status: number, retryAfterMs?: number) => new Refused('X', 'nope', 'fix it', status, retryAfterMs);
const everything = (r: { stdout?: string; stderr?: string }) => (r.stdout ?? '') + (r.stderr ?? '');

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'echo-wait-')));
  env = { ECHO_HOME: path.join(tmp, 'echo'), ECHO_TOKEN_STORE: 'file', ECHO_AGENT: 'orch' };
  saveConfig(env, { url: 'http://127.0.0.1:1', agents: ['orch'], defaultAgent: 'orch' });
  await writeToken('orch', TOKEN, env);
  lockFile = path.join(tmp, 'echo', 'wait-orch.lock');
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('wait: result', () => {
  it('exits 0 at once with a one-line summary (count, ids, senders, no bodies)', async () => {
    const h = harness([reply(found())]);
    const r = await waitCommand([], env, h.deps);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('echo: 2 message(s) waiting: #41 from Carol, #42 from Alice. Read them with echo_inbox, with no project filter.\n');
    expect(r.stdout!.trim().split('\n')).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
    expect(h.calls).toEqual([{ path: '/api/v1/peek', body: {}, token: TOKEN }]);
  });

  it('keeps checking every interval until something is waiting', async () => {
    const h = harness([reply(none), reply(none), reply(found(1))]);
    const r = await waitCommand(['--interval', '10'], env, h.deps);
    expect(r.exitCode).toBe(0);
    expect(h.sleeps).toEqual([10_000, 10_000]);
  });

  it('defaults to a 25 s interval', async () => {
    const h = harness([reply(none), reply(found(1))]);
    await waitCommand([], env, h.deps);
    expect(h.sleeps).toEqual([25_000]);
  });

  it('caps a long list and strips control characters from sender labels', async () => {
    const messages = Array.from({ length: 12 }, (_, i) => ({ messageId: i + 1, from: i === 0 ? 'A\nB\u001b[31m' : 'x' }));
    const r = await waitCommand([], env, harness([reply({ now: 'x', count: 12, messages })]).deps);
    expect(r.stdout!.trim().split('\n')).toHaveLength(1);
    expect(r.stdout).toContain(', and 2 more.');
    expect(r.stdout).not.toContain('\u001b');
  });
});

describe('wait: timeout', () => {
  it('exits 3 once the timeout passes, with a final check at the deadline and no real sleeping', async () => {
    const h = harness([reply(none)]);
    const r = await waitCommand(['--interval', '10', '--timeout', '35'], env, h.deps);
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('no messages within 35s');
    expect(r.stderr).toContain('only if a reply is still expected');
    expect(h.sleeps).toEqual([10_000, 10_000, 10_000, 5_000]);
    expect(h.calls).toHaveLength(5);
  });

  it('a message arriving on the last check still wins over the timeout', async () => {
    const h = harness([reply(none), reply(found(1))]);
    expect((await waitCommand(['--interval', '10', '--timeout', '10'], env, h.deps)).exitCode).toBe(0);
  });
});

describe('wait: errors and backoff', () => {
  it('backs off 2x per consecutive failure, capped at 120 s, resets on success, and keeps waiting', async () => {
    const h = harness([
      boom(new Unreachable('down')),
      boom(new Unreachable('down')),
      boom(new Unreachable('down')),
      boom(new Unreachable('down')),
      reply(none),
      boom(new Unreachable('down')),
      reply(found(1)),
    ]);
    const r = await waitCommand(['--interval', '25'], env, h.deps);
    expect(r.exitCode).toBe(0);
    expect(h.sleeps).toEqual([50_000, 100_000, 120_000, 120_000, 25_000, 50_000]);
  });

  it('treats 429 like an unreachable service, honouring Retry-After, and keeps waiting', async () => {
    const h = harness([boom(refused(429)), boom(refused(429, 200_000)), reply(found(1))]);
    const r = await waitCommand(['--interval', '25'], env, h.deps);
    expect(r.exitCode).toBe(0);
    expect(h.sleeps).toEqual([50_000, 200_000]);
  });

  it('an unexpected reply shape is retried, not fatal', async () => {
    const h = harness([reply({ weird: true }), reply(found(1))]);
    expect((await waitCommand([], env, h.deps)).exitCode).toBe(0);
  });

  it.each([
    ['a null entry', { count: 1, messages: [null] }],
    ['an entry without an id', { count: 1, messages: [{ from: 'A' }] }],
    ['an entry with a non-string sender', { count: 1, messages: [{ messageId: 1, from: 5 }] }],
    ['a negative count', { count: -1, messages: [] }],
    ['a fractional count', { count: 1.5, messages: [] }],
    ['no messages array', { count: 1 }],
    ['null', null],
  ])('a reply with %s is a service problem: retried, never exit 2', async (_n, bad) => {
    const h = harness([reply(bad), reply(found(1))]);
    const r = await waitCommand([], env, h.deps);
    expect(r.exitCode).toBe(0);
    expect(h.sleeps).toEqual([50_000]);
  });

  it('still times out while the service stays down', async () => {
    const h = harness([boom(new Unreachable('down'))]);
    const r = await waitCommand(['--interval', '10', '--timeout', '60'], env, h.deps);
    expect(r.exitCode).toBe(3);
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBe(60_000);
  });

  it.each([408, 425])('retries %i like an unreachable service', async (status) => {
    const h = harness([boom(refused(status)), reply(found(1))]);
    expect((await waitCommand([], env, h.deps)).exitCode).toBe(0);
    expect(h.sleeps).toEqual([50_000]);
  });

  it.each([401, 403, 400, 404])('exits 4 on %i with the service message and does not retry', async (status) => {
    const h = harness([boom(refused(status))]);
    const r = await waitCommand([], env, h.deps);
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain('nope');
    expect(r.stderr).toContain('fix it');
    expect(h.calls).toHaveLength(1);
  });
});

describe('wait: config errors exit 2 without any network call', () => {
  const cases: [string, () => Promise<void> | void, string[]?][] = [
    ['no ECHO_AGENT', () => void delete env.ECHO_AGENT],
    ['an agent not in config', () => void (env.ECHO_AGENT = 'other')],
    ['no config.json', () => fs.rmSync(path.join(tmp, 'echo', 'config.json'))],
    ['no stored token', () => fs.rmSync(path.join(tmp, 'echo', 'tokens', 'orch'))],
    ['a bad --interval', () => {}, ['--interval', '1']],
    ['a non-numeric --timeout', () => {}, ['--timeout', 'soon']],
    ['an unknown flag', () => {}, ['--loud']],
  ];
  it.each(cases)('%s', async (_n, setup, args = []) => {
    await setup();
    const h = harness([reply(found())]);
    const r = await waitCommand(args, env, h.deps);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/^echo wait: /);
    expect(h.calls).toHaveLength(0);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('says ECHO_AGENT clearly', async () => {
    delete env.ECHO_AGENT;
    expect((await waitCommand([], env, harness([]).deps)).stderr).toContain('ECHO_AGENT is not set');
  });
});

describe('wait: one waiter per agent', () => {
  const lockOf = (pid: number, ppid: number, nonce = 'abc', top: number | string = ppid, harness: number | string = 50) =>
    `${pid} ${ppid} ${top} ${harness} ${nonce}\n`;
  /** 50 is the default harness: alive unless a test says otherwise. */
  const aliveIn = (...pids: number[]) => (p: number) => p === 50 || pids.includes(p);

  it('exits 5 naming the holder and its parent, with no network call, and leaves the lock alone', async () => {
    fs.writeFileSync(lockFile, lockOf(777, 555));
    const h = harness([reply(found())], { isAlive: aliveIn(777, 555) });
    const r = await waitCommand([], env, h.deps);
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toContain('PID 777');
    expect(r.stderr).toContain('started by PID 555');
    expect(r.stderr).toContain('tell the owner');
    expect(h.calls).toHaveLength(0);
    expect(fs.readFileSync(lockFile, 'utf8')).toBe(lockOf(777, 555));
  });

  it('takes over a lock whose holder is dead, and releases it on exit', async () => {
    fs.writeFileSync(lockFile, lockOf(777, 555));
    expect((await waitCommand([], env, harness([reply(found(1))]).deps)).exitCode).toBe(0);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('takes over a lock whose holder is alive but orphaned (its parent is gone)', async () => {
    fs.writeFileSync(lockFile, lockOf(777, 555));
    const h = harness([reply(found(1))], { isAlive: aliveIn(777) });
    expect((await waitCommand([], env, h.deps)).exitCode).toBe(0);
    expect(h.calls).toHaveLength(1);
  });

  it('exits 6 when the parent stays alive but the harness dies and the wrapper is re-parented', async () => {
    const h = harness([() => ((h.procs[100].ppid = 1), none), reply(found(1))]);
    const r = await waitCommand(['--interval', '5'], env, h.deps);
    expect(r.exitCode).toBe(6);
    expect(h.calls).toHaveLength(1);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('a starter takes over a holder whose parent is alive but whose harness died', async () => {
    fs.writeFileSync(lockFile, lockOf(777, 555));
    const h = harness([reply(found(1))], { isAlive: (p) => p === 777 || p === 555 });
    expect((await waitCommand([], env, h.deps)).exitCode).toBe(0);
  });

  it('a starter takes over a holder whose topmost shell was re-parented (its harness changed)', async () => {
    fs.writeFileSync(lockFile, lockOf(777, 555));
    const h = harness([reply(found(1))], { isAlive: aliveIn(777, 555), procs: table({ 555: { ppid: 1, comm: 'zsh' } }) });
    expect((await waitCommand([], env, h.deps)).exitCode).toBe(0);
  });

  it('a holder whose parent and harness are both alive and unchanged keeps the lock (exit 5)', async () => {
    fs.writeFileSync(lockFile, lockOf(777, 555));
    const h = harness([reply(found(1))], { isAlive: aliveIn(777, 555), procs: table({ 555: { ppid: 50, comm: 'zsh' } }) });
    expect((await waitCommand([], env, h.deps)).exitCode).toBe(5);
  });

  it('a holder recorded with a real init as its harness (started detached) is stale', async () => {
    fs.writeFileSync(lockFile, lockOf(777, 555, 'abc', 555, 1));
    const h = harness([reply(found(1))], { isAlive: aliveIn(777, 555, 1), procs: table({ 555: { ppid: 1, comm: 'sh' } }) });
    expect((await waitCommand([], env, h.deps)).exitCode).toBe(0);
  });

  it('a holder whose harness is PID 1 inside a container (not an init) is a live waiter', async () => {
    fs.writeFileSync(lockFile, lockOf(777, 555, 'abc', 555, 1));
    const h = harness([reply(found(1))], {
      isAlive: aliveIn(777, 555, 1),
      procs: table({ 555: { ppid: 1, comm: 'sh' }, 1: { ppid: 0, comm: '/usr/bin/node' } }),
    });
    expect((await waitCommand([], env, h.deps)).exitCode).toBe(5);
  });

  it('exits 6 at once when detached one shell deep (zsh -c "nohup sh -c ... & exit 0"): the shell is under launchd', async () => {
    const h = harness([reply(found())], { procs: table({ 100: { ppid: 1, comm: '/bin/sh' } }) });
    const r = await waitCommand([], env, h.deps);
    expect(r.exitCode).toBe(6);
    expect(r.stderr).toContain('run_in_background');
    expect(h.calls).toHaveLength(0);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('a harness that is PID 1 inside a container (not an init) is a normal start', async () => {
    let seen = '';
    const h = harness([() => ((seen = fs.readFileSync(lockFile, 'utf8')), found(1))], {
      procs: table({ 100: { ppid: 1, comm: '/bin/zsh' }, 1: { ppid: 0, comm: '/usr/bin/node' } }),
    });
    expect((await waitCommand([], env, h.deps)).exitCode).toBe(0);
    expect(seen).toMatch(/^4242 100 100 1 /);
  });

  describe('an extra subshell between the wrapper and the waiter ( node wait; true )', () => {
    const deep = () => table({ 100: { ppid: 90, comm: '/bin/zsh' }, 90: { ppid: 50, comm: '/bin/zsh' } });

    it('records the topmost shell and the harness above it', async () => {
      let seen = '';
      const h = harness([() => ((seen = fs.readFileSync(lockFile, 'utf8')), found(1))], { procs: deep() });
      await waitCommand([], env, h.deps);
      expect(seen).toMatch(/^4242 100 90 50 /);
    });

    it('exits 6 when the harness dies and the topmost shell is re-parented', async () => {
      const h = harness([() => ((h.procs[90].ppid = 1), none), reply(found(1))], { procs: deep() });
      expect((await waitCommand(['--interval', '5'], env, h.deps)).exitCode).toBe(6);
      expect(h.calls).toHaveLength(1);
    });

    it('exits 6 when the topmost shell itself dies (the middle shell is re-parented)', async () => {
      const dead = new Set<number>();
      const h = harness(
        [
          () => {
            dead.add(90);
            delete h.procs[90];
            return none;
          },
          reply(found(1)),
        ],
        { procs: deep(), isAlive: (p) => !dead.has(p) },
      );
      expect((await waitCommand(['--interval', '5'], env, h.deps)).exitCode).toBe(6);
    });

    it('a starter judges a holder of this shape the same way', async () => {
      // The holder: waiter 777 -> subshell 800 -> topmost shell 900 -> harness 50.
      fs.writeFileSync(lockFile, lockOf(777, 800, 'abc', 900, 50));
      const alive = (p: number) => [777, 800, 900, 50, 100, 90].includes(p);
      const healthy = deep();
      healthy[900] = { ppid: 50, comm: 'zsh' };
      expect((await waitCommand([], env, harness([reply(found(1))], { procs: healthy, isAlive: alive }).deps)).exitCode).toBe(5);
      const harnessDied = deep();
      harnessDied[900] = { ppid: 1, comm: 'zsh' };
      expect((await waitCommand([], env, harness([reply(found(1))], { procs: harnessDied, isAlive: alive }).deps)).exitCode).toBe(0);
    });
  });

  it('the walk up through shells is bounded, so a cycle cannot hang the start', async () => {
    const h = harness([reply(found(1))], { procs: table({ 100: { ppid: 101, comm: 'zsh' }, 101: { ppid: 100, comm: 'zsh' } }) });
    expect((await waitCommand([], env, h.deps)).exitCode).toBe(0);
  });

  it('exits 6 at once when started with parent PID 1 (detached with & or nohup): no lock, no request', async () => {
    const h = harness([reply(found())], { ppid: () => 1 });
    const r = await waitCommand([], env, h.deps);
    expect(r.exitCode).toBe(6);
    expect(r.stderr).toContain('run_in_background');
    expect(h.calls).toHaveLength(0);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('a starter takes over a live holder that was started with parent PID 1', async () => {
    fs.writeFileSync(lockFile, lockOf(777, 1));
    const h = harness([reply(found(1))], { isAlive: aliveIn(777, 1) });
    expect((await waitCommand([], env, h.deps)).exitCode).toBe(0);
  });

  it('does not watch the grandparent when the parent is not a shell (the harness started us directly)', async () => {
    let seen = '';
    const h = harness([() => ((h.procs[100].ppid = 1), (seen = fs.readFileSync(lockFile, 'utf8')), none), reply(found(1))], {
      procs: table({ 100: { ppid: 50, comm: '/usr/local/bin/claude' } }),
    });
    expect((await waitCommand(['--interval', '5'], env, h.deps)).exitCode).toBe(0);
    expect(seen).toMatch(/^4242 100 - - [0-9a-f]{12}\n$/);
  });

  it('retries ps once at start, so one hiccup does not disable the grandparent check', async () => {
    let n = 0;
    let seen = '';
    const h = harness([() => ((seen = fs.readFileSync(lockFile, 'utf8')), found(1))], { parentOf: (pid) => (n++ === 0 ? null : table()[pid]?.ppid ?? null) });
    await waitCommand([], env, h.deps);
    expect(seen).toMatch(/^4242 100 100 50 /);
  });

  it('keeps running on the parent check alone when ps never answers', async () => {
    let seen = '';
    const h = harness([() => ((seen = fs.readFileSync(lockFile, 'utf8')), found(1))], { parentOf: () => null, commOf: () => null });
    expect((await waitCommand([], env, h.deps)).exitCode).toBe(0);
    expect(seen).toMatch(/^4242 100 - - /);
  });

  it('an unwritable Echo home at release time cannot turn exit 0 or 3 into a crash', async () => {
    const realMkdir = fs.mkdirSync;
    vi.spyOn(fs, 'mkdirSync').mockImplementation(((f: string, ...rest: unknown[]) => {
      if (String(f).endsWith('.takeover')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return (realMkdir as (...a: unknown[]) => unknown)(f, ...rest);
    }) as typeof fs.mkdirSync);
    expect((await waitCommand([], env, harness([reply(found(1))]).deps)).exitCode).toBe(0);
    fs.rmSync(lockFile, { force: true }); // left behind on purpose; its PID is dead
    expect((await waitCommand(['--interval', '5', '--timeout', '5'], env, harness([reply(none)]).deps)).exitCode).toBe(3);
  });

  it('a stale takeover mutex that was replaced by a fresh one before our rename is put back, not deleted', async () => {
    fs.writeFileSync(lockFile, lockOf(777, 555));
    const mutex = lockFile + '.takeover';
    fs.mkdirSync(mutex);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(mutex, old, old);
    const realRename = fs.renameSync;
    const moves: { from: string; to: string; existedBefore: boolean }[] = [];
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: string, to: string) => {
      moves.push({ from: String(from), to: String(to), existedBefore: fs.existsSync(from) });
      realRename(from, to);
      if (moves.length === 1) fs.utimesSync(to, new Date(), new Date()); // what we moved was really a fresh mutex
      if (moves.length === 2) fs.rmSync(to, { recursive: true }); // let the starter go on
    }) as typeof fs.renameSync);
    expect((await waitCommand([], env, harness([reply(found(1))]).deps)).exitCode).toBe(0);
    expect(moves).toHaveLength(2);
    expect(moves[0].from).toBe(mutex);
    expect([moves[1].from, moves[1].to, moves[1].existedBefore]).toEqual([moves[0].to, mutex, true]);
  });

  it('uses one reading of the parent for the lock and the orphan checks', async () => {
    let n = 0;
    const h = harness([reply(found())], { ppid: () => (n++ === 0 ? 100 : 200) });
    const r = await waitCommand([], env, h.deps);
    // Read once (100) at start; the first loop check reads 200 and sees the change. A second reading at start would hide it.
    expect(r.exitCode).toBe(6);
    expect(h.calls).toHaveLength(0);
  });

  it('release happens under the takeover mutex', async () => {
    const seen: boolean[] = [];
    const realUnlink = fs.unlinkSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementation(((f: string) => {
      if (f === lockFile) seen.push(fs.existsSync(lockFile + '.takeover'));
      return realUnlink(f);
    }) as typeof fs.unlinkSync);
    expect((await waitCommand([], env, harness([reply(found(1))]).deps)).exitCode).toBe(0);
    expect(seen).toEqual([true]);
    expect(fs.existsSync(lockFile + '.takeover')).toBe(false);
  });

  it('a lock naming our own PID is never a live other waiter (a reused PID after a crash)', async () => {
    fs.writeFileSync(lockFile, lockOf(4242, 100));
    const h = harness([reply(found(1))], { isAlive: aliveIn(4242, 100) });
    expect((await waitCommand([], env, h.deps)).exitCode).toBe(0);
  });

  it('a live holder whose lock went untouched for over 15 minutes is stale (PID reuse)', async () => {
    fs.writeFileSync(lockFile, lockOf(777, 555));
    const old = new Date(Date.now() - 16 * 60_000);
    fs.utimesSync(lockFile, old, old);
    const h = harness([reply(found(1))], { isAlive: aliveIn(777, 555) });
    expect((await waitCommand([], env, h.deps)).exitCode).toBe(0);
  });

  it('takes over an unreadable lock', async () => {
    fs.writeFileSync(lockFile, 'garbage');
    expect((await waitCommand([], env, harness([reply(found(1))]).deps)).exitCode).toBe(0);
  });

  it('touches the lock on every check so a live waiter never looks stale', async () => {
    const h = harness([
      () => {
        const old = new Date(Date.now() - 60_000);
        fs.utimesSync(lockFile, old, old);
        return none;
      },
      () => {
        expect(Date.now() - fs.statSync(lockFile).mtimeMs).toBeLessThan(5_000);
        return found(1);
      },
    ]);
    expect((await waitCommand(['--interval', '5'], env, h.deps)).exitCode).toBe(0);
  });

  it('creates the lock whole: the file is written under another name and linked, never written in place', async () => {
    const writes: string[] = [];
    let linked: string | null = null;
    const realWrite = fs.writeFileSync;
    const realLink = fs.linkSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((f: string, ...rest: unknown[]) => {
      writes.push(String(f));
      return (realWrite as (...a: unknown[]) => void)(f, ...rest);
    }) as typeof fs.writeFileSync);
    vi.spyOn(fs, 'linkSync').mockImplementation(((from: string, to: string) => {
      linked = fs.readFileSync(from, 'utf8'); // complete at the moment it becomes the lock
      return realLink(from, to);
    }) as typeof fs.linkSync);
    expect((await waitCommand([], env, harness([reply(found(1))]).deps)).exitCode).toBe(0);
    expect(writes).not.toContain(lockFile);
    expect(linked).toMatch(/^4242 100 100 50 [0-9a-f]{12}\n$/);
    expect(fs.readdirSync(path.dirname(lockFile)).filter((f) => f.startsWith('wait-'))).toEqual([]);
  });

  it('a takeover mutex that a crashed starter left behind is cleared after 10 s', async () => {
    fs.writeFileSync(lockFile, lockOf(777, 555));
    fs.mkdirSync(lockFile + '.takeover');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile + '.takeover', old, old);
    expect((await waitCommand([], env, harness([reply(found(1))]).deps)).exitCode).toBe(0);
    expect(fs.readdirSync(path.dirname(lockFile)).filter((f) => f.startsWith('wait-'))).toEqual([]);
  });

  it('a stale lock replaced by a live waiter during takeover is left alone', async () => {
    fs.writeFileSync(lockFile, lockOf(777, 555));
    let n = 0;
    // First liveness check says dead; by the re-check under the mutex another waiter owns the lock.
    const isAlive = (pid: number) => {
      if (pid === 777 && n++ === 0) {
        fs.writeFileSync(lockFile, lockOf(888, 556));
        return false;
      }
      return pid === 888 || pid === 556 || pid === 50;
    };
    const r = await waitCommand([], env, harness([reply(found(1))], { isAlive }).deps);
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toContain('PID 888');
    expect(fs.readFileSync(lockFile, 'utf8')).toBe(lockOf(888, 556));
  });

  it('holds the lock while waiting and releases it on every exit path', async () => {
    let during: string | null = null;
    const peek = () => {
      during = fs.readFileSync(lockFile, 'utf8');
      return none;
    };
    expect((await waitCommand(['--interval', '5', '--timeout', '5'], env, harness([peek]).deps)).exitCode).toBe(3);
    expect(during).toMatch(/^4242 100 100 50 [0-9a-f]{12}\n$/);
    expect(fs.existsSync(lockFile)).toBe(false);
    expect((await waitCommand([], env, harness([boom(refused(401))]).deps)).exitCode).toBe(4);
    expect(fs.existsSync(lockFile)).toBe(false);
    expect((await waitCommand([], env, harness([boom(new Error('weird'))]).deps)).exitCode).toBe(2);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('release leaves a lock that another waiter with the same PID now owns', async () => {
    const h = harness([() => (fs.writeFileSync(lockFile, lockOf(4242, 100, 'other')), found(1))]);
    await waitCommand([], env, h.deps);
    expect(fs.readFileSync(lockFile, 'utf8')).toBe(lockOf(4242, 100, 'other'));
  });

  it('exits 6 when the lock was taken over or removed, without touching the new owner', async () => {
    const h = harness([() => (fs.writeFileSync(lockFile, lockOf(888, 556, 'new')), none), reply(found(1))]);
    const r = await waitCommand(['--interval', '5'], env, h.deps);
    expect(r.exitCode).toBe(6);
    expect(h.calls).toHaveLength(1);
    expect(fs.readFileSync(lockFile, 'utf8')).toBe(lockOf(888, 556, 'new'));
    const gone = harness([() => (fs.rmSync(lockFile), none), reply(found(1))]);
    expect((await waitCommand(['--interval', '5'], env, gone.deps)).exitCode).toBe(6);
  });

  it('exits 6 and releases the lock when its parent process is gone (orphaned), so a restart is not blocked', async () => {
    let parent = 100;
    const h = harness([() => ((parent = 1), none), reply(found(1))], { ppid: () => parent });
    const r = await waitCommand(['--interval', '5'], env, h.deps);
    expect(r.exitCode).toBe(6);
    expect(r.stderr).toContain('is gone');
    expect(h.calls).toHaveLength(1);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ])('%s releases the lock and exits %i', async (sig, code) => {
    const handlers: Record<string, () => void> = {};
    vi.spyOn(process, 'once').mockImplementation(((ev: string, fn: () => void) => ((handlers[ev] = fn), process)) as never);
    vi.spyOn(process, 'off').mockImplementation((() => process) as never);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const h = harness([
      () => {
        expect(fs.existsSync(lockFile)).toBe(true);
        handlers[sig]();
        expect(fs.existsSync(lockFile)).toBe(false);
        return found(1);
      },
    ]);
    await waitCommand([], env, h.deps);
    expect(exit).toHaveBeenCalledWith(code);
  });

  it('locks are per agent', async () => {
    saveConfig(env, { url: 'http://127.0.0.1:1', agents: ['orch', 'bob'], defaultAgent: 'orch' });
    await writeToken('bob', 'tok-bob', env);
    fs.writeFileSync(path.join(tmp, 'echo', 'wait-bob.lock'), lockOf(777, 555));
    const r = await waitCommand([], env, harness([reply(found(1))], { isAlive: () => true }).deps);
    expect(r.exitCode).toBe(0);
  });

  it('real liveness check: a dead PID is stale, this process is alive', async () => {
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const real = realWaitDeps();
    expect(real.isAlive(Number(dead.stdout))).toBe(false);
    expect(real.isAlive(process.pid)).toBe(true);
    expect(real.ppid()).toBe(process.ppid);
    expect(real.parentOf(process.pid)).toBe(process.ppid); // the real `ps` lookup the grandparent check relies on
    expect(real.parentOf(2 ** 22 + 12345)).toBeNull();
    fs.writeFileSync(lockFile, lockOf(Number(dead.stdout), process.pid));
    expect((await waitCommand([], env, { ...harness([reply(found(1))]).deps, isAlive: real.isAlive })).exitCode).toBe(0);
  });
});

describe('wait: the token never appears in output', () => {
  const scenarios: [string, (() => unknown)[], string[]?][] = [
    ['found', [reply(found())]],
    ['timeout', [reply(none)], ['--interval', '5', '--timeout', '5']],
    ['unreachable then timeout', [boom(new Unreachable(`down ${'x'}`))], ['--interval', '5', '--timeout', '5']],
    ['auth refused', [boom(refused(401))]],
    ['unexpected error', [boom(new Error('weird'))]],
  ];
  it.each(scenarios)('%s', async (_n, replies, args = []) => {
    const r = await waitCommand(args, env, harness(replies).deps);
    expect(everything(r)).not.toContain(TOKEN);
    expect(everything(r)).not.toContain('SECRET');
  });
  it('config errors too', async () => {
    fs.rmSync(path.join(tmp, 'echo', 'config.json'));
    expect(everything(await waitCommand([], env, harness([]).deps))).not.toContain(TOKEN);
  });
});

describe('wait: end to end through dispatch and a fake server', () => {
  let server: FakeServer;
  beforeEach(async () => {
    server = await startFakeServer();
    saveConfig(env, { url: server.url, agents: ['orch'], defaultAgent: 'orch' });
  });
  afterEach(() => server.close());

  it('posts {} to /api/v1/peek with the Bearer token and prints the summary', async () => {
    server.reply({ status: 200, body: found() });
    const out = await dispatch('wait', () => '', env, Date.now(), { args: ['--interval', '5'] });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('#41 from Carol');
    expect(server.requests).toHaveLength(1);
    const q = server.requests[0];
    expect([q.method, q.url, q.body]).toEqual(['POST', '/api/v1/peek', '{}']);
    expect(q.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(everything(out as { stdout?: string; stderr?: string })).not.toContain(TOKEN);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('a 401 from the real client path exits 4', async () => {
    server.reply({ status: 401, body: { error: { code: 'BAD_TOKEN', message: 'Bad token.', fix: 'Rotate it.' } } });
    const out = await dispatch('wait', () => '', env, Date.now(), { args: [] });
    expect(out.exitCode).toBe(4);
    expect('stderr' in out && out.stderr).toContain('Bad token.');
  });

  it('the client reads a Retry-After header into the refusal', async () => {
    server.reply({ status: 429, headers: { 'retry-after': '7' }, body: { error: { code: 'RATE', message: 'slow', fix: 'wait' } } });
    const cfg = { url: server.url, agents: ['orch'], defaultAgent: 'orch' };
    const e = (await api(cfg, 't', '/api/v1/peek', {}).catch((x) => x)) as Refused;
    expect([e.status, e.retryAfterMs]).toEqual([429, 7000]);
    server.reply({ status: 429, body: { error: { code: 'RATE', message: 'slow', fix: 'wait' } } });
    expect(((await api(cfg, 't', '/x', {}).catch((x) => x)) as Refused).retryAfterMs).toBeUndefined();
  });

  it('dispatch turns a crash into exit 2, never exit 0 (which means a message is waiting)', async () => {
    const args = ['--interval'];
    Object.defineProperty(args, 0, {
      get() {
        throw new Error('boom');
      },
    });
    const out = await dispatch('wait', () => '', env, Date.now(), { args });
    expect(out.exitCode).toBe(2);
    expect('stderr' in out && out.stderr).toContain('unexpected error');
  });

  it('a 429 is retried, not treated as an auth error', async () => {
    server.reply({ status: 429, body: { error: { code: 'RATE', message: 'slow', fix: 'wait' } } });
    const racing = dispatch('wait', () => '', env, Date.now(), { args: ['--timeout', '1', '--interval', '5'] });
    const out = await racing; // backoff is capped by the 1 s deadline, so this really sleeps about a second
    expect(out.exitCode).toBe(3);
  });
});
