import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as state from '../src/state';

let tmp: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-state-'));
  env = { ECHO_HOME: tmp };
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('state', () => {
  it('gate cache round-trips and is null before the first write', () => {
    expect(state.readGateCache(env)).toBeNull();
    state.writeGateCache(['a/b', 'c/d'], env);
    expect(state.readGateCache(env)?.repos).toEqual(['a/b', 'c/d']);
    expect(typeof state.readGateCache(env)?.fetchedAtMs).toBe('number');
  });

  it('last poll is per agent', () => {
    expect(state.lastPoll('a', env)).toBe(0);
    state.setLastPoll('a', 100, env);
    state.setLastPoll('b', 200, env);
    expect(state.lastPoll('a', env)).toBe(100);
    expect(state.lastPoll('b', env)).toBe(200);
  });

  it('pending merge is taken exactly once', () => {
    state.savePendingMerge('tu1', { repo: 'a/b', pr: 5 }, env);
    expect(state.takePendingMerge('tu1', env)).toEqual({ repo: 'a/b', pr: 5 });
    expect(state.takePendingMerge('tu1', env)).toBeNull();
  });

  it('stop-shown ids accumulate per session', () => {
    expect(state.stopShown('s', env).size).toBe(0);
    state.addStopShown('s', [1, 2], env);
    state.addStopShown('s', [2, 3], env);
    expect([...state.stopShown('s', env)].sort()).toEqual([1, 2, 3]);
    expect(state.stopShown('other', env).size).toBe(0);
  });

  it('override state round-trips', () => {
    expect(state.overrideState('k', env)).toBeNull();
    state.setOverrideState('k', { firstSeenMs: 1, usedAtMs: null }, env);
    expect(state.overrideState('k', env)).toEqual({ firstSeenMs: 1, usedAtMs: null });
  });

  it('drainReports returns the queue in order and clears it', () => {
    state.queueReport({ a: 1 }, env);
    state.queueReport({ a: 2 }, env);
    expect(state.drainReports(env)).toEqual([{ a: 1 }, { a: 2 }]);
    expect(state.drainReports(env)).toEqual([]);
  });

  it('writes go through rename: no temp files are left behind and a corrupt file reads as empty', () => {
    state.setLastPoll('a', 1, env);
    const dir = path.join(tmp, 'state');
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
    fs.writeFileSync(path.join(dir, 'last-poll.json'), '{broken');
    expect(state.lastPoll('a', env)).toBe(0);
  });
});
