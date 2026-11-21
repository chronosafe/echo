import { createExecutionContext, env, SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { errorJson, ruleError } from '../src/errors';
import worker from '../src/index';
import { parseZonedTime } from '../src/time';
import { seed, seedApprovals, testCtx } from './helpers';
import { fakeGithub } from './fake-github';

describe('foundation', () => {
  it('stores a 1.5 MB string through a bound parameter', async () => {
    const big = 'x'.repeat(1_500_000);
    await env.DB.prepare(`INSERT INTO documents VALUES (1,'big',1,'markdown',?,'t','2026-01-01T00:00:00Z')`).bind(big).run();
    expect((await env.DB.prepare(`SELECT length(content) n FROM documents`).first<{ n: number }>())?.n).toBe(1_500_000);
  });
  it('errorJson maps unknown errors to a service error', () => {
    expect(errorJson(new Error('boom')).error).toMatchObject({ kind: 'service', code: 'INTERNAL' });
    expect(errorJson(ruleError('X', 'm', 'f')).error).toEqual({ kind: 'rule', code: 'X', message: 'm', fix: 'f' });
  });
  it('parseZonedTime converts offsets to UTC and refuses zoneless times', () => {
    expect(parseZonedTime('2026-11-18T21:00:00-06:00')).toEqual({ utc: '2026-11-19T03:00:00.000Z', enteredAs: '2026-11-18T21:00:00-06:00' });
    expect(() => parseZonedTime('2026-11-18T21:00:00')).toThrow(expect.objectContaining({ code: 'TIME_NEEDS_ZONE' }));
    expect(() => parseZonedTime('garbage Z')).toThrow(expect.objectContaining({ code: 'BAD_TIME' }));
  });
  it('parseZonedTime accepts only ISO-8601 with an uppercase Z or a numeric offset', () => {
    expect(parseZonedTime('2026-11-18T21:00Z').utc).toBe('2026-11-18T21:00:00.000Z');
    expect(parseZonedTime('2026-11-18T21:00:30.250+05:30').utc).toBe('2026-11-18T15:30:30.250Z');
    expect(() => parseZonedTime('2026-11-18T21:00:00z')).toThrow(expect.objectContaining({ code: 'BAD_TIME' }));
    expect(() => parseZonedTime('Nov 18 2026 21:00 -06:00')).toThrow(expect.objectContaining({ code: 'BAD_TIME' }));
    expect(() => parseZonedTime('2026-11-18 21:00:00Z')).toThrow(expect.objectContaining({ code: 'BAD_TIME' }));
    expect(() => parseZonedTime('2026-11-18T21:00')).toThrow(expect.objectContaining({ code: 'TIME_NEEDS_ZONE' }));
    expect(() => parseZonedTime('2026-11-18T25:00:00Z')).toThrow(expect.objectContaining({ code: 'BAD_TIME' }));
  });
  it('an unexpected error is logged (without the request body or token) and answered as a service error', async () => {
    const broken = {
      prepare() {
        throw new Error('D1 is on fire');
      },
    } as unknown as D1Database;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await worker.fetch(
        new Request('https://echo.test/api/v1/poll?x=1', {
          method: 'POST',
          headers: { authorization: 'Bearer echo_secret-token-value', 'content-type': 'application/json' },
          body: JSON.stringify({ secretField: 'body-secret' }),
        }),
        { ...env, DB: broken },
        createExecutionContext(),
      );
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ ok: false, error: { kind: 'service', code: 'INTERNAL' } });
      expect(err).toHaveBeenCalledTimes(1);
      const logged = err.mock.calls[0].map((a) => (a instanceof Error ? `${a.message} ${a.stack ?? ''}` : String(a))).join(' ');
      expect(logged).toContain('D1 is on fire');
      expect(logged).toContain('POST /api/v1/poll');
      expect(logged).not.toContain('secret-token-value');
      expect(logged).not.toContain('body-secret');
      expect(logged).not.toContain('x=1');

      // A rule or service error the code raised on purpose is the caller's answer, not a fault: not logged.
      err.mockClear();
      const refused = await worker.fetch(new Request('https://echo.test/api/v1/poll', { method: 'POST' }), env, createExecutionContext());
      expect(refused.status).toBe(401);
      expect(err).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });
  it('the Worker has observability (logs) enabled', async () => {
    const config = (await import('../wrangler.jsonc?raw')).default;
    expect(config).toMatch(/"observability":\s*\{\s*"enabled":\s*true\s*\}/);
  });
  it('GET /health returns ok and the server time', async () => {
    expect(await (await SELF.fetch('https://echo.test/health')).json()).toMatchObject({ ok: true, now: expect.any(String) });
  });
});

describe('test helpers', () => {
  it('testCtx has a movable clock', () => {
    const ctx = testCtx();
    expect(ctx.now()).toBe('2026-11-18T20:00:00.000Z');
    ctx.setNow('2026-11-18T21:00:00.000Z');
    expect(ctx.now()).toBe('2026-11-18T21:00:00.000Z');
  });
  it('seed creates projects, agents and the repo', async () => {
    const ctx = testCtx();
    const s = await seed(ctx);
    expect(s.alice.token).toMatch(/^echo_[A-Za-z0-9_-]{43}$/);
    expect(s.aliceA).toEqual({ kind: 'agent', agentId: s.alice.id, name: 'Alice' });
    const members = await ctx.db
      .prepare(`SELECT a.name n FROM project_agents pa JOIN agents a ON a.id=pa.agent_id WHERE pa.project_id=? ORDER BY a.name`)
      .bind(s.project.id).all<{ n: string }>();
    expect(members.results.map((r) => r.n)).toEqual(['Alice', 'Bob']);
    const repo = await ctx.db.prepare(`SELECT * FROM repos WHERE id=?`).bind(s.repo.id).first<any>();
    expect(repo).toMatchObject({ full_name: 'acme/app', project_id: s.project.id, installation_id: null });
    expect(s.project.approvals_required).toBe(0);
  });
  it('seedApprovals turns approvals on', async () => {
    const s = await seedApprovals(testCtx());
    expect(s.project.approvals_required).toBe(1);
  });
});

describe('fake github', () => {
  it('serves pulls and records statuses, and can fail', async () => {
    const gh = fakeGithub();
    gh.pulls.set('acme/app#709', { head: 'abc', state: 'open', mergedAt: null });
    const ok = await gh.fetch('https://gh.test/repos/Acme/App/pulls/709');
    expect(await ok.json()).toMatchObject({ number: 709, state: 'open', head: { sha: 'abc' }, merged_at: null });
    expect((await gh.fetch('https://gh.test/repos/acme/app/pulls/1')).status).toBe(404);
    const post = await gh.fetch('https://gh.test/repos/Acme/App/statuses/abc', {
      method: 'POST',
      body: JSON.stringify({ state: 'success', description: 'ok', context: 'echo/hold' }),
    });
    expect(post.status).toBe(201);
    expect(gh.statuses).toEqual([{ repo: 'acme/app', sha: 'abc', state: 'success', description: 'ok' }]);
    gh.fail(1);
    expect((await gh.fetch('https://gh.test/repos/acme/app/statuses/abc', { method: 'POST', body: '{}' })).status).toBe(500);
    expect((await gh.fetch('https://gh.test/repos/acme/app/installation')).status).toBe(200);
    const tok = await gh.fetch('https://gh.test/app/installations/7/access_tokens', { method: 'POST' });
    expect(tok.status).toBe(201);
  });
});
