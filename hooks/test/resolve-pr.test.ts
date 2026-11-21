import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CannotResolve, resolvePr } from '../src/resolve-pr';
import type { MergeInvocation } from '../src/parse-merge';

const BIN = path.join(import.meta.dirname, 'fixtures/bin');
let tmp: string;
let log: string;

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: `${BIN}:${process.env.PATH}`, FAKE_LOG: log, ...extra };
}
function inv(over: Partial<MergeInvocation> = {}): MergeInvocation {
  return { target: '5', repoFlag: null, envRepo: null, cwd: tmp, auto: false, admin: false, disableAuto: false, ...over };
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'echo-resolve-')));
  log = path.join(tmp, 'fake.log');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('resolvePr', () => {
  it('resolves repo and number from the PR url, lowercased, passing -R through', async () => {
    const e = env({
      FAKE_GH_STDOUT: JSON.stringify({ url: 'https://github.com/Acme/App/pull/42', state: 'OPEN', mergedAt: null }),
    });
    const r = await resolvePr(inv({ repoFlag: 'Acme/App' }), e);
    expect(r).toEqual({ repo: 'acme/app', pr: 42, state: 'OPEN', mergedAt: null });
    const logged = fs.readFileSync(log, 'utf8');
    expect(logged).toContain(`cwd: ${tmp}`);
    expect(logged.split('\n').filter((l) => l.startsWith('arg: '))).toEqual([
      'arg: pr', 'arg: view', 'arg: 5', 'arg: -R', 'arg: Acme/App', 'arg: --json', 'arg: url,state,mergedAt',
    ]);
  });

  it('omits the target when there is none, sets GH_REPO from envRepo, and reports a merged PR', async () => {
    const e = env({
      FAKE_GH_STDOUT: JSON.stringify({ url: 'https://github.com/o/r/pull/7', state: 'MERGED', mergedAt: '2026-11-19T01:02:03Z' }),
    });
    const r = await resolvePr(inv({ target: null, envRepo: 'o/r' }), e);
    expect(r).toEqual({ repo: 'o/r', pr: 7, state: 'MERGED', mergedAt: '2026-11-19T01:02:03Z' });
    const logged = fs.readFileSync(log, 'utf8');
    expect(logged).toContain('GH_REPO: o/r');
    expect(logged).not.toContain('arg: 5');
  });

  it('throws CannotResolve with gh stderr when gh fails', async () => {
    const e = env({ FAKE_GH_EXIT: '1', FAKE_GH_STDERR: 'no pull requests found for branch "x"' });
    const p = resolvePr(inv({ target: null }), e);
    await expect(p).rejects.toBeInstanceOf(CannotResolve);
    await expect(p).rejects.toThrow('no pull requests found for branch "x"');
  });

  it('throws CannotResolve when gh prints something that is not a PR url', async () => {
    const e = env({ FAKE_GH_STDOUT: JSON.stringify({ url: 'https://example.com/x', state: 'OPEN', mergedAt: null }) });
    await expect(resolvePr(inv(), e)).rejects.toBeInstanceOf(CannotResolve);
    await expect(resolvePr(inv(), env({ FAKE_GH_STDOUT: 'not json' }))).rejects.toBeInstanceOf(CannotResolve);
  });

  it('throws CannotResolve naming the directory when inv.cwd does not exist', async () => {
    const missing = path.join(tmp, 'nope');
    const p = resolvePr(inv({ cwd: missing }), env());
    await expect(p).rejects.toBeInstanceOf(CannotResolve);
    await expect(p).rejects.toThrow(`directory ${missing} does not exist`);
  });

  it('throws CannotResolve when gh is not installed', async () => {
    await expect(resolvePr(inv(), { PATH: '/nonexistent' })).rejects.toBeInstanceOf(CannotResolve);
  });
});
