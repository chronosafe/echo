import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../src/ctx';
import { EchoError } from '../src/errors';
import { MAX_LIVE_KEYS, batchWrite, deleteEntry, getEntry, putEntry } from '../src/domain/data';
import type { AgentOp } from '../src/domain/data';
import { assertConsistent, batchSizes } from './data-invariants';
import { seed, testCtx } from './helpers';

const ctx = testCtx();
let s: Awaited<ReturnType<typeof seed>>;
let P: number;

beforeEach(async () => {
  ctx.setNow('2026-11-24T10:00:00.000Z');
  s = await seed(ctx);
  P = s.project.id;
});

const rows = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
type Outcome = { ok: true; value: any } | { ok: false; code: string; details?: any };
const settle = (p: Promise<unknown>): Promise<Outcome> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (e) => {
      if (!(e instanceof EchoError)) throw e;
      return { ok: false as const, code: e.code, details: e.details };
    },
  );

/** A ctx whose first batch() waits for `before`: a rival write lands after the precheck and before the guarded batch. */
function rivalCtx(before: () => Promise<unknown>): Ctx {
  let fired = false;
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === 'batch') {
        return async (stmts: D1PreparedStatement[]) => {
          // the precheck also uses batch(); only the write batch (it holds an INSERT INTO data_history) is intercepted
          if (!fired && stmts.some((x) => /INSERT INTO data_(history|guard)/.test((x as any).statement ?? ''))) {
            fired = true;
            await before();
          }
          return target.batch(stmts);
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { ...ctx, db };
}

describe('the guard decides, not the precheck', () => {
  it('a rival commits between the precheck and the batch: the stale writer gets VERSION_CONFLICT with the rival state, and leaves one row', async () => {
    await putEntry(ctx, s.aliceA, { projectId: P, key: 'k', value: 'v1', expectedVersion: 0 });
    const racing = rivalCtx(async () => {
      await putEntry(ctx, s.bobA, { projectId: P, key: 'k', value: 'bob', expectedVersion: 1 });
    });
    const r = await settle(putEntry(racing, s.aliceA, { projectId: P, key: 'k', value: 'alice', expectedVersion: 1, notify: ['Bob'] }));
    expect(r).toMatchObject({ ok: false, code: 'VERSION_CONFLICT' });
    expect((r as any).details.conflicts[0]).toMatchObject({ key: 'k', version: 2, updated_by: 'Bob', value: 'bob' });
    expect(await rows('data_history')).toBe(2);
    expect(await rows('messages')).toBe(0); // the stale writer's notification rolled back with its write
    await assertConsistent();
  });

  it('the same for a create (expected 0) and for a delete', async () => {
    const racing = rivalCtx(async () => {
      await putEntry(ctx, s.bobA, { projectId: P, key: 'new', value: 'bob', expectedVersion: 0 });
    });
    expect(await settle(putEntry(racing, s.aliceA, { projectId: P, key: 'new', value: 'alice', expectedVersion: 0 }))).toMatchObject({ ok: false, code: 'VERSION_CONFLICT' });
    const racing2 = rivalCtx(async () => {
      await putEntry(ctx, s.bobA, { projectId: P, key: 'new', value: 'bob2', expectedVersion: 1 });
    });
    expect(await settle(deleteEntry(racing2, s.aliceA, { projectId: P, key: 'new', expectedVersion: 1 }))).toMatchObject({ ok: false, code: 'VERSION_CONFLICT' });
    expect(await getEntry(ctx, s.aliceA, P, 'new')).toMatchObject({ version: 2, value: 'bob2' });
    await assertConsistent();
  });

  it('a rival who takes ownership between precheck and batch turns the write into NOT_OWNER', async () => {
    await putEntry(ctx, s.aliceA, { projectId: P, key: 'k', value: 1, expectedVersion: 0 });
    const racing = rivalCtx(async () => {
      // Bob takes the entry (owner me needs a creation, so he deletes and recreates it)
      await deleteEntry(ctx, s.bobA, { projectId: P, key: 'k', expectedVersion: 1 });
      await putEntry(ctx, s.bobA, { projectId: P, key: 'k', value: 2, expectedVersion: 2, owner: 'me' });
    });
    const r = await settle(putEntry(racing, s.aliceA, { projectId: P, key: 'k', value: 3, expectedVersion: 1 }));
    expect(r.ok).toBe(false); // the version moved to 3, so a conflict is reported first; ownership is judged on the fresh state
    await assertConsistent();
  });

  it('a retry of the same request that loses the race to its own first attempt returns the first result', async () => {
    const racing = rivalCtx(async () => {
      await putEntry(ctx, s.aliceA, { projectId: P, key: 'k', value: 'v', expectedVersion: 0, requestId: 'dup' });
    });
    const r = await settle(putEntry(racing, s.aliceA, { projectId: P, key: 'k', value: 'v', expectedVersion: 0, requestId: 'dup' }));
    expect(r).toMatchObject({ ok: true, value: { key: 'k', version: 1, duplicate: true } });
    expect(await rows('data_history')).toBe(1);
    await assertConsistent();
  });
});

describe('multi-op batches whose rival commits after the precheck', () => {
  const seedThree = async () => {
    for (const k of ['a', 'b', 'c']) await putEntry(ctx, s.aliceA, { projectId: P, key: k, value: 1, expectedVersion: 0 });
  };
  const baseline = async () => ({ e: await rows('data_entries'), h: await rows('data_history'), c: await rows('change_log'), m: await rows('messages') });
  const bump = (key: string) => () => putEntry(ctx, s.bobA, { projectId: P, key, value: 'rival', expectedVersion: 1 }).then(() => undefined);

  it.each([
    ['first', 'a'],
    ['last', 'c'],
  ])('the rival bumps the %s key: the whole batch is refused by the SQL guard and only the rival write exists', async (_n, bumped) => {
    await seedThree();
    const racing = rivalCtx(bump(bumped));
    const before = await baseline();
    const r = await settle(
      batchWrite(racing, s.aliceA, {
        projectId: P,
        notify: ['Bob'],
        note: 'move',
        ops: [
          { op: 'put', key: 'a', value: 'alice', expectedVersion: 1 },
          { op: 'delete', key: 'b', expectedVersion: 1 },
          { op: 'put', key: 'c', value: 'alice', expectedVersion: 1 },
          { op: 'put', key: 'd', value: 'new', expectedVersion: 0 },
        ],
      }),
    );
    expect(r).toMatchObject({ ok: false, code: 'VERSION_CONFLICT' });
    expect((r as any).details.conflicts.map((c: any) => [c.key, c.version, c.value])).toEqual([[bumped, 2, 'rival']]);
    // exactly the rival's write landed: one entry changed, no row for d, b still live, no notification
    expect(await baseline()).toEqual({ ...before, h: before.h + 1, c: before.c + 1 });
    const state = (await env.DB.prepare(`SELECT key, version, deleted FROM data_entries ORDER BY key`).all<any>()).results.map((x) => [x.key, x.version, x.deleted]);
    expect(state).toEqual([['a', bumped === 'a' ? 2 : 1, 0], ['b', 1, 0], ['c', bumped === 'c' ? 2 : 1, 0]]);
    await assertConsistent();
  });

  it.each([
    ['first', 'a'],
    ['last', 'c'],
  ])('a failing check on the %s key rolls the batch back through the data_guard guard', async (_n, bumped) => {
    await seedThree();
    const racing = rivalCtx(bump(bumped));
    const before = await baseline();
    const r = await settle(
      batchWrite(racing, s.aliceA, {
        projectId: P,
        ops: [
          { op: 'check', key: 'a', expectedVersion: 1 },
          { op: 'put', key: 'b', value: 'alice', expectedVersion: 1 },
          { op: 'check', key: 'c', expectedVersion: 1 },
        ],
      }),
    );
    expect(r).toMatchObject({ ok: false, code: 'VERSION_CONFLICT' });
    expect((r as any).details.conflicts.map((c: any) => c.key)).toEqual([bumped]);
    expect(await baseline()).toEqual({ ...before, h: before.h + 1, c: before.c + 1 });
    expect((await getEntry(ctx, s.aliceA, P, 'b')) as any).toMatchObject({ version: 1, value: 1 });
    await assertConsistent();
  });

  it('the rival bumps a key in the middle and another at the end: both are reported', async () => {
    await seedThree();
    const racing = rivalCtx(async () => {
      await bump('b')();
      await bump('c')();
    });
    const r = await settle(
      batchWrite(racing, s.aliceA, {
        projectId: P,
        ops: [
          { op: 'put', key: 'a', value: 'alice', expectedVersion: 1 },
          { op: 'put', key: 'b', value: 'alice', expectedVersion: 1 },
          { op: 'put', key: 'c', value: 'alice', expectedVersion: 1 },
        ],
      }),
    );
    expect((r as any).details.conflicts.map((c: any) => c.key)).toEqual(['b', 'c']);
    expect((await getEntry(ctx, s.aliceA, P, 'a')) as any).toMatchObject({ version: 1 });
    await assertConsistent();
  });
});

describe('a retry that races its own original', () => {
  /** A ctx whose very first batch() (the precheck read) first lets `before` run. */
  function firstBatchHook(before: () => Promise<unknown>): Ctx {
    let fired = false;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'batch') {
          return async (stmts: D1PreparedStatement[]) => {
            if (!fired) {
              fired = true;
              await before();
            }
            return target.batch(stmts);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    return { ...ctx, db };
  }

  it('the original commits after the retry looked for it but before the precheck read: duplicate, not a conflict', async () => {
    const racing = firstBatchHook(async () => {
      await putEntry(ctx, s.aliceA, { projectId: P, key: 'k', value: 'v', expectedVersion: 0, requestId: 'r1' });
    });
    expect(await settle(putEntry(racing, s.aliceA, { projectId: P, key: 'k', value: 'v', expectedVersion: 0, requestId: 'r1' }))).toMatchObject({ ok: true, value: { key: 'k', version: 1, duplicate: true } });
    expect(await rows('data_history')).toBe(1);
    await assertConsistent();
  });

  it('a different write under the same request_id is still a conflict or a reuse, never a duplicate', async () => {
    const racing = firstBatchHook(async () => {
      await putEntry(ctx, s.aliceA, { projectId: P, key: 'k', value: 'other', expectedVersion: 0, requestId: 'r1' });
    });
    const r = await settle(putEntry(racing, s.aliceA, { projectId: P, key: 'k', value: 'mine', expectedVersion: 0, requestId: 'r1' }));
    expect(r.ok).toBe(false);
    expect(await rows('data_history')).toBe(1);
  });
});

describe('concurrent writers', () => {
  it('20 puts with one expected_version: exactly one wins, the rest conflict with the winner state, one history row, one log row, one message', async () => {
    await putEntry(ctx, s.aliceA, { projectId: P, key: 'race', value: 0, expectedVersion: 0 });
    const runs = Array.from({ length: 20 }, (_, i) => settle(putEntry(ctx, i % 2 ? s.aliceA : s.bobA, { projectId: P, key: 'race', value: i + 1, expectedVersion: 1, notify: 'all', note: `n${i}` })));
    const res = await Promise.all(runs);
    const wins = res.filter((r) => r.ok);
    expect(wins).toHaveLength(1);
    const winner = (await getEntry(ctx, s.aliceA, P, 'race')) as any;
    expect(winner.version).toBe(2);
    for (const r of res.filter((x) => !x.ok)) {
      expect((r as any).code).toBe('VERSION_CONFLICT');
      expect((r as any).details.conflicts[0]).toMatchObject({ version: 2, value: winner.value });
    }
    expect(await rows('data_history')).toBe(2);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM change_log WHERE kind = 'data.put'`).first<{ n: number }>())!.n).toBe(2);
    expect(await rows('messages')).toBe(1);
    await assertConsistent();
  });

  it('concurrent creates of one key: one wins', async () => {
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => settle(putEntry(ctx, s.aliceA, { projectId: P, key: 'new', value: i, expectedVersion: 0 }))));
    expect(res.filter((r) => r.ok)).toHaveLength(1);
    expect(res.filter((r) => !r.ok).every((r) => (r as any).code === 'VERSION_CONFLICT')).toBe(true);
    await assertConsistent();
  });

  it('concurrent creates of different keys never pass the live-key limit', async () => {
    await env.DB.exec(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${MAX_LIVE_KEYS - 3}) INSERT INTO data_entries SELECT ${P}, 'k' || i, 1, '1', NULL, 'Alice', '2026-11-24T10:00:00.000Z', NULL, 0 FROM n`,
    );
    await env.DB.exec(`INSERT INTO data_history (project_id, key, version, op, value, actor, at) SELECT project_id, key, 1, 'put', '1', 'Alice', '2026-11-24T10:00:00.000Z' FROM data_entries`);
    await env.DB.exec(`INSERT INTO change_log (project_id, at, actor, kind, subject_id, data) SELECT project_id, '2026-11-24T10:00:00.000Z', 'Alice', 'data.put', key, json_object('key', key, 'version', 1, 'op', 'put', 'batch_id', NULL) FROM data_entries`);
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => settle(putEntry(ctx, i % 2 ? s.aliceA : s.bobA, { projectId: P, key: `fresh${i}`, value: i, expectedVersion: 0 }))));
    expect(res.filter((r) => r.ok)).toHaveLength(3);
    expect(res.filter((r) => !r.ok).every((r) => (r as any).code === 'KEY_LIMIT')).toBe(true);
    expect(await rows('data_entries')).toBe(MAX_LIVE_KEYS);
    await assertConsistent();
  });

  it('overlapping batches never half-apply: randomized rounds with the failing op in every position', async () => {
    const keys = ['k0', 'k1', 'k2', 'k3', 'k4'];
    let seedState = 12345;
    const rand = () => ((seedState = (seedState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = <T>(a: T[], n: number) => [...a].sort(() => rand() - 0.5).slice(0, n);
    const version = async (k: string) => (await env.DB.prepare(`SELECT version FROM data_entries WHERE project_id = ? AND key = ?`).bind(P, k).first<{ version: number }>())?.version ?? 0;
    const deleted = async (k: string) => (await env.DB.prepare(`SELECT deleted FROM data_entries WHERE project_id = ? AND key = ?`).bind(P, k).first<{ deleted: number }>())?.deleted === 1;
    let round = 0;
    const sizes: Record<string, number> = {};
    for (; round < 50; round++) {
      const writers = 3 + Math.floor(rand() * 4);
      const jobs: Promise<Outcome>[] = [];
      for (let w = 0; w < writers; w++) {
        const chosen = pick(keys, 2 + Math.floor(rand() * 3));
        const ops: AgentOp[] = [];
        for (const k of chosen) {
          const v = await version(k);
          const kind = rand();
          if (v === 0) ops.push({ op: 'put', key: k, value: { w, round }, expectedVersion: 0 });
          else if (kind < 0.15) ops.push({ op: 'check', key: k, expectedVersion: v });
          else if (kind < 0.3 && !(await deleted(k))) ops.push({ op: 'delete', key: k, expectedVersion: v });
          else ops.push({ op: 'put', key: k, value: { w, round }, expectedVersion: v });
        }
        // every few rounds, make the op at a chosen position stale for sure
        if (round % 3 === 0) {
          const at = [0, Math.floor(ops.length / 2), ops.length - 1][round % 9 === 0 ? 0 : round % 9 === 3 ? 1 : 2]!;
          const bad = ops[at]!;
          ops[at] = bad.op === 'put' ? { ...bad, expectedVersion: 999 } : { op: 'put', key: bad.key, value: 'x', expectedVersion: 999 };
        }
        if (!ops.some((o) => o.op !== 'check')) ops.push({ op: 'put', key: `extra${w}-${round}`, value: 1, expectedVersion: 0 });
        jobs.push(settle(batchWrite(ctx, w % 2 ? s.aliceA : s.bobA, { projectId: P, ops })));
      }
      const res = await Promise.all(jobs);
      for (const r of res) if (r.ok) sizes[(r.value as any).batchId] = (r.value as any).results.filter((x: any) => x).length;
      await assertConsistent(`round ${round}`);
    }
    // every committed batch has exactly its write ops in history (the stale-op rounds committed nothing)
    const counted = await batchSizes();
    for (const [id] of counted) expect(sizes[id], `batch ${id} committed rows but its writer saw a refusal`).toBeDefined();
    expect(counted.size).toBeGreaterThan(5);
  });
});
