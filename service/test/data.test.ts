import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { EchoError } from '../src/errors';
import {
  MAX_LIVE_KEYS,
  adminDeleteEntry,
  adminReleaseOwner,
  batchWrite,
  deleteEntry,
  entryHistory,
  getEntry,
  listEntries,
  putEntry,
} from '../src/domain/data';
import { changesSince } from '../src/domain/changelog';
import { adminRevokeAgent } from '../src/domain/agents';
import { removeMember } from '../src/domain/projects';
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

async function refused(p: Promise<unknown>): Promise<EchoError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(EchoError);
    return e as EchoError;
  }
  throw new Error('expected a refusal');
}
const rows = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const nothingWritten = async () => {
  expect({ e: await rows('data_entries'), h: await rows('data_history'), c: await rows('change_log') }).toEqual({ e: 0, h: 0, c: 0 });
};

const A = () => s.aliceA;
const B = () => s.bobA;
const put = (actor: typeof s.aliceA, key: string, value: unknown, expectedVersion: number, extra: Record<string, unknown> = {}) =>
  putEntry(ctx, actor, { projectId: P, key, value, expectedVersion, ...extra });

describe('put, get, list and history', () => {
  it('creates, updates and reads back with Echo-stamped who and when', async () => {
    expect(await put(A(), 'rulings/cap.scope', { a: 1 }, 0, { note: 'first' })).toEqual({ key: 'rulings/cap.scope', version: 1, previousVersion: 0 });
    ctx.setNow('2026-11-24T10:05:00.000Z');
    expect(await put(B(), 'rulings/cap.scope', { a: 2 }, 1)).toEqual({ key: 'rulings/cap.scope', version: 2, previousVersion: 1 });
    expect(await getEntry(ctx, A(), P, 'rulings/cap.scope')).toEqual({
      key: 'rulings/cap.scope', version: 2, value: { a: 2 }, owner: null, updatedBy: 'Bob', updatedAt: '2026-11-24T10:05:00.000Z', note: null, deleted: false,
    });
    expect(await getEntry(ctx, A(), P, 'rulings/cap.scope', 1)).toMatchObject({ version: 1, value: { a: 1 }, actor: 'Alice', at: '2026-11-24T10:00:00.000Z', note: 'first', op: 'put' });
    await assertConsistent();
  });

  it('stores any JSON value as JSON.stringify of it, including null and primitives', async () => {
    for (const [i, v] of [null, 0, false, 'x', [1, [2]], { b: 1, a: 2 }].entries()) await put(A(), `v/${i}`, v, 0);
    const stored = (await env.DB.prepare(`SELECT key, value FROM data_entries ORDER BY key`).all<{ key: string; value: string }>()).results.map((r) => r.value);
    expect(stored).toEqual(['null', '0', 'false', '"x"', '[1,[2]]', '{"b":1,"a":2}']);
    expect(await getEntry(ctx, A(), P, 'v/0')).toMatchObject({ value: null });
    await assertConsistent();
  });

  it('history lists newest first with values by default and without on request', async () => {
    await put(A(), 'k', 'one', 0);
    await put(A(), 'k', 'two', 1);
    await put(A(), 'k', 'three', 2);
    const h = await entryHistory(ctx, A(), P, 'k');
    expect(h.versions.map((v) => [v.version, v.value])).toEqual([[3, 'three'], [2, 'two'], [1, 'one']]);
    expect((await entryHistory(ctx, A(), P, 'k', { includeValues: false })).versions.every((v) => !('value' in v))).toBe(true);
    const page = await entryHistory(ctx, A(), P, 'k', { limit: 2 });
    expect(page.versions.map((v) => v.version)).toEqual([3, 2]);
    expect(page.beforeVersion).toBe(2);
    expect((await entryHistory(ctx, A(), P, 'k', { limit: 2, beforeVersion: 2 })).versions.map((v) => v.version)).toEqual([1]);
    expect((await refused(entryHistory(ctx, A(), P, 'nope'))).code).toBe('DATA_NOT_FOUND');
    expect((await refused(entryHistory(ctx, A(), P, 'k', { limit: 201 }))).code).toBe('BAD_LIMIT');
  });

  it('a missing version is VERSION_NOT_FOUND and a missing key is DATA_NOT_FOUND', async () => {
    await put(A(), 'k', 1, 0);
    expect((await refused(getEntry(ctx, A(), P, 'k', 9))).code).toBe('VERSION_NOT_FOUND');
    const e = await refused(getEntry(ctx, A(), P, 'zzz'));
    expect([e.code, e.status, e.details]).toEqual(['DATA_NOT_FOUND', 404, { key: 'zzz', deleted: false, version: 0 }]);
  });

  it('lists in key order with prefix as a literal range: "_" is not a wildcard and case is exact', async () => {
    for (const k of ['a_b/1', 'axb/1', 'a_b/2', 'A_b/1', 'a_c', 'b']) await put(A(), k, 1, 0);
    const keys = async (o: Parameters<typeof listEntries>[3]) => (await listEntries(ctx, A(), P, o)).entries.map((e) => e.key);
    expect(await keys({})).toEqual(['A_b/1', 'a_b/1', 'a_b/2', 'a_c', 'axb/1', 'b']);
    expect(await keys({ prefix: 'a_b/' })).toEqual(['a_b/1', 'a_b/2']);
    expect(await keys({ prefix: 'a_b' })).toEqual(['a_b/1', 'a_b/2']);
    expect(await keys({ prefix: 'A_' })).toEqual(['A_b/1']);
    expect(await keys({ prefix: 'a%' as string }).catch((e) => e.code)).toBe('BAD_PREFIX');
    expect(await keys({ afterKey: 'a_b/2', limit: 2 })).toEqual(['a_c', 'axb/1']);
    const page = await listEntries(ctx, A(), P, { limit: 2 });
    expect([page.entries.length, page.afterKey]).toEqual([2, 'a_b/1']);
    expect((await listEntries(ctx, A(), P, {})).afterKey).toBeUndefined();
    expect((await listEntries(ctx, A(), P, {})).entries.every((e) => !('value' in e))).toBe(true);
    expect((await listEntries(ctx, A(), P, { includeValues: true, prefix: 'b' })).entries[0]).toMatchObject({ value: 1 });
  });

  it('list stops at 1 MiB and returns after_key to continue', async () => {
    const big = 'x'.repeat(60000);
    for (let i = 0; i < 20; i++) await put(A(), `big/${String(i).padStart(2, '0')}`, big, 0);
    const first = await listEntries(ctx, A(), P, { includeValues: true });
    expect(first.entries.length).toBeLessThan(20);
    expect(first.afterKey).toBe(first.entries[first.entries.length - 1]!.key);
    const second = await listEntries(ctx, A(), P, { includeValues: true, afterKey: first.afterKey });
    expect(first.entries.length + second.entries.length).toBeGreaterThanOrEqual(20 - 0);
  });

  it('refuses a caller outside the project', async () => {
    expect((await refused(putEntry(ctx, s.carolA, { projectId: P, key: 'k', value: 1, expectedVersion: 0 }))).code).toBe('NOT_MEMBER');
    expect((await refused(getEntry(ctx, s.carolA, P, 'k'))).code).toBe('NOT_MEMBER');
    await nothingWritten();
  });
});

describe('the version rules', () => {
  it('a stale expected_version is VERSION_CONFLICT carrying the current state, and writes nothing', async () => {
    await put(A(), 'k', { n: 1 }, 0);
    await put(B(), 'k', { n: 2 }, 1, { note: 'bob was here' });
    const e = await refused(put(A(), 'k', { n: 99 }, 1));
    expect([e.code, e.status]).toEqual(['VERSION_CONFLICT', 409]);
    expect(e.details).toEqual({
      conflicts: [{ key: 'k', expected_version: 1, exists: true, version: 2, deleted: false, owner: null, updated_by: 'Bob', updated_at: '2026-11-24T10:00:00.000Z', note: 'bob was here', value: { n: 2 } }],
    });
    expect(await rows('data_history')).toBe(2);
    await assertConsistent();
  });

  it('expected_version 0 on an existing key, and n on a missing key, are conflicts', async () => {
    await put(A(), 'k', 1, 0);
    expect((await refused(put(A(), 'k', 2, 0))).code).toBe('VERSION_CONFLICT');
    const e = await refused(put(A(), 'missing', 2, 3));
    expect(e.details).toEqual({ conflicts: [{ key: 'missing', expected_version: 3, exists: false, version: 0, deleted: false }] });
    await assertConsistent();
  });

  it('delete leaves a tombstone: get is 404 with its version, 0 cannot recreate, the tombstone version can, numbering continues', async () => {
    await put(A(), 'k', 'v1', 0);
    await put(A(), 'k', 'v2', 1);
    ctx.setNow('2026-11-24T11:00:00.000Z');
    expect(await deleteEntry(ctx, A(), { projectId: P, key: 'k', expectedVersion: 2, note: 'done' })).toEqual({ key: 'k', version: 3 });
    const gone = await refused(getEntry(ctx, B(), P, 'k'));
    expect([gone.code, gone.status, gone.details]).toEqual(['DATA_NOT_FOUND', 404, { key: 'k', deleted: true, version: 3, deleted_by: 'Alice', deleted_at: '2026-11-24T11:00:00.000Z' }]);
    expect((await refused(put(B(), 'k', 'x', 0))).code).toBe('VERSION_CONFLICT');
    expect((await refused(put(B(), 'k', 'x', 2))).code).toBe('VERSION_CONFLICT');
    expect(await put(B(), 'k', 'v4', 3)).toEqual({ key: 'k', version: 4, previousVersion: 3 });
    expect(await getEntry(ctx, A(), P, 'k')).toMatchObject({ version: 4, value: 'v4', deleted: false, updatedBy: 'Bob' });
    expect((await entryHistory(ctx, A(), P, 'k')).versions.map((v) => [v.version, v.op])).toEqual([[4, 'put'], [3, 'delete'], [2, 'put'], [1, 'put']]);
    expect((await listEntries(ctx, A(), P, { includeDeleted: true })).entries).toHaveLength(1);
    await assertConsistent();
  });

  it('deleting a tombstone, or a key that never existed, is refused and writes nothing', async () => {
    await put(A(), 'k', 1, 0);
    await deleteEntry(ctx, A(), { projectId: P, key: 'k', expectedVersion: 1 });
    const before = await rows('data_history');
    const again = await refused(deleteEntry(ctx, A(), { projectId: P, key: 'k', expectedVersion: 2 }));
    expect(again.code).toBe('VERSION_CONFLICT');
    expect((again.details as any).conflicts[0]).toMatchObject({ deleted: true, version: 2 });
    expect((await refused(deleteEntry(ctx, A(), { projectId: P, key: 'never', expectedVersion: 0 }))).code).toBe('NOTHING_TO_DELETE');
    expect(await rows('data_history')).toBe(before);
    await assertConsistent();
  });

  it('a deleted list hides tombstones unless asked', async () => {
    await put(A(), 'live', 1, 0);
    await put(A(), 'dead', 1, 0);
    await deleteEntry(ctx, A(), { projectId: P, key: 'dead', expectedVersion: 1 });
    expect((await listEntries(ctx, A(), P, {})).entries.map((e) => e.key)).toEqual(['live']);
    expect((await listEntries(ctx, A(), P, { includeDeleted: true })).entries.map((e) => [e.key, e.deleted])).toEqual([['dead', true], ['live', false]]);
  });
});

describe('validation', () => {
  const badKeys = ['', '/a', 'a/', 'a//b', 'a b', 'aé', 'a/./b', 'a/../b', '.', '..', './a', 'a/..', 'x'.repeat(201), 'a?b', 'a#b', 'a%2fb', 'a\\b', 'a\nb'];
  it.each(badKeys.map((k) => [JSON.stringify(k.length > 20 ? k.slice(0, 20) + '...' : k), k]))('refuses the key %s', async (_n, key) => {
    expect((await refused(put(A(), key, 1, 0))).code).toBe('BAD_KEY');
    expect((await refused(getEntry(ctx, A(), P, key))).code).toBe('BAD_KEY');
    await nothingWritten();
  });
  it.each(['a', 'a.b', 'a_b', 'a:b', 'a-b', 'A/b/C', '1', '007', '1e3', 'x'.repeat(200), 'v1.2/a.b', 'a/.hidden', 'a/..b', 'a/b..'])('accepts the key %s', async (key) => {
    expect((await put(A(), key, 1, 0)).version).toBe(1);
    expect((await getEntry(ctx, A(), P, key)).key).toBe(key);
  });

  it('keeps the exact key in the change log although subject_id has integer affinity', async () => {
    await put(A(), '007', 1, 0);
    await put(A(), '1e3', 1, 0);
    const log = await changesSince(ctx, P, 0);
    expect(log.map((c) => (c.data as any).key)).toEqual(['007', '1e3']);
    expect(log.map((c) => c.subjectId)).toEqual([null, null]); // the key is in data.key; subject_id (an INTEGER column) stays empty
    await assertConsistent();
  });

  it('value size: 65,536 bytes passes, 65,537 does not; bytes, not characters', async () => {
    const at = (n: number) => 'x'.repeat(n - 2); // the quotes make 2 bytes
    expect((await put(A(), 'ok', at(65536), 0)).version).toBe(1);
    expect((await refused(put(A(), 'big', at(65537), 0))).code).toBe('VALUE_TOO_LARGE');
    expect((await refused(put(A(), 'wide', 'é'.repeat(32768), 0))).code).toBe('VALUE_TOO_LARGE'); // 2 bytes each
    expect((await put(A(), 'wide2', 'é'.repeat(32767), 0)).version).toBe(1);
  });

  it('nesting: 32 levels pass, 33 are refused at write, including a 65 KB [[[[ bomb', async () => {
    const nest = (n: number) => { let v: unknown = 1; for (let i = 0; i < n; i++) v = [v]; return v; };
    expect((await put(A(), 'd32', nest(31), 0)).version).toBe(1);
    expect((await put(A(), 'd32b', nest(32 - 1), 0)).version).toBe(1);
    expect((await refused(put(A(), 'd33', nest(33), 0))).code).toBe('VALUE_TOO_DEEP');
    expect((await refused(put(A(), 'bomb', nest(30000), 0))).code).toBe('VALUE_TOO_DEEP');
    let o: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) o = { a: o };
    expect((await refused(put(A(), 'obj', o, 0))).code).toBe('VALUE_TOO_DEEP');
  });

  it('refuses a value that is not JSON, a long note and a bad request_id', async () => {
    expect((await refused(put(A(), 'u', undefined, 0))).code).toBe('INVALID_JSON');
    expect((await refused(put(A(), 'n', 1, 0, { note: 'x'.repeat(501) }))).code).toBe('NOTE_TOO_LONG');
    expect((await put(A(), 'n', 1, 0, { note: 'x'.repeat(500) })).version).toBe(1);
    expect((await refused(put(A(), 'r', 1, 0, { requestId: 'has space' }))).code).toBe('BAD_REQUEST_ID');
  });

  it('the live-key limit: 2,000 pass, the 2,001st is KEY_LIMIT, a delete frees a slot, a revive at the cap is refused', async () => {
    await env.DB.exec(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${MAX_LIVE_KEYS}) INSERT INTO data_entries SELECT ${P}, 'k' || i, 1, '1', NULL, 'Alice', '2026-11-24T10:00:00.000Z', NULL, 0 FROM n`,
    );
    await env.DB.exec(
      `INSERT INTO data_history (project_id, key, version, op, value, owner, actor, at) SELECT project_id, key, 1, 'put', '1', NULL, 'Alice', '2026-11-24T10:00:00.000Z' FROM data_entries`,
    );
    await env.DB.exec(
      `INSERT INTO change_log (project_id, at, actor, kind, subject_id, data) SELECT project_id, '2026-11-24T10:00:00.000Z', 'Alice', 'data.put', key, json_object('key', key, 'version', 1, 'op', 'put', 'batch_id', NULL) FROM data_entries`,
    );
    const e = await refused(put(A(), 'one-too-many', 1, 0));
    expect([e.code, e.details]).toEqual(['KEY_LIMIT', { key: 'one-too-many', limit: MAX_LIVE_KEYS }]);
    await deleteEntry(ctx, A(), { projectId: P, key: 'k1', expectedVersion: 1 });
    expect((await put(A(), 'fits-now', 1, 0)).version).toBe(1);
    expect((await refused(put(A(), 'k1', 1, 2))).code).toBe('KEY_LIMIT'); // reviving needs a free slot too
    await assertConsistent();
  });
});

describe('values are stored as sent, or refused', () => {
  it('refuses a number JSON cannot carry instead of storing null', async () => {
    for (const v of [Infinity, -Infinity, NaN, [1, [Infinity]], { a: { b: NaN } }]) {
      expect((await refused(put(A(), 'n', v, 0))).code).toBe('INVALID_JSON');
    }
    await nothingWritten();
    expect((await put(A(), 'ok', [0, -0, 1.5, 1e21], 0)).version).toBe(1);
  });
});

describe('ownership', () => {
  it('owner "me" at creation: only the owner may change or delete; others get NOT_OWNER naming it', async () => {
    await put(A(), 'mine', 1, 0, { owner: 'me' });
    expect((await getEntry(ctx, B(), P, 'mine'))).toMatchObject({ owner: 'Alice' });
    const e = await refused(put(B(), 'mine', 2, 1));
    expect([e.code, e.status, e.details]).toEqual(['NOT_OWNER', 403, { key: 'mine', owner: 'Alice' }]);
    expect((await refused(deleteEntry(ctx, B(), { projectId: P, key: 'mine', expectedVersion: 1 }))).code).toBe('NOT_OWNER');
    expect((await put(A(), 'mine', 2, 1)).version).toBe(2);
    expect(await getEntry(ctx, B(), P, 'mine')).toMatchObject({ owner: 'Alice', value: 2 }); // omitted owner keeps it
    await assertConsistent();
  });

  it('owner "me" on an existing live key is refused; there is no hand-over', async () => {
    await put(A(), 'shared', 1, 0);
    expect((await refused(put(B(), 'shared', 2, 1, { owner: 'me' }))).code).toBe('OWNER_AT_CREATION');
    await put(A(), 'mine', 1, 0, { owner: 'me' });
    expect((await refused(put(A(), 'mine', 2, 1, { owner: 'me' }))).code).toBe('OWNER_AT_CREATION');
    expect((await refused(put(A(), 'mine', 2, 1, { owner: 'Bob' } as never))).code).toBe('BAD_OWNER'); // only "me" or null exist
    expect(await getEntry(ctx, A(), P, 'mine')).toMatchObject({ owner: 'Alice', version: 1 });
    await assertConsistent();
  });

  it('the owner releases with owner null; then anyone may write', async () => {
    await put(A(), 'k', 1, 0, { owner: 'me' });
    expect((await put(A(), 'k', 1, 1, { owner: null })).version).toBe(2);
    expect(await getEntry(ctx, B(), P, 'k')).toMatchObject({ owner: null });
    expect((await put(B(), 'k', 3, 2)).version).toBe(3);
    await assertConsistent();
  });

  it('a delete releases ownership: the key can be recreated by anyone with the tombstone version, and claimed with "me"', async () => {
    await put(A(), 'k', 1, 0, { owner: 'me' });
    await deleteEntry(ctx, A(), { projectId: P, key: 'k', expectedVersion: 1 });
    expect((await entryHistory(ctx, A(), P, 'k')).versions[0]).toMatchObject({ op: 'delete', owner: null });
    expect((await put(B(), 'k', 2, 2, { owner: 'me' })).version).toBe(3);
    expect(await getEntry(ctx, A(), P, 'k')).toMatchObject({ owner: 'Bob' });
    await assertConsistent();
  });

  it('an owner who left the project, or was revoked, counts as released (and the next write clears the owner)', async () => {
    await put(B(), 'left', 1, 0, { owner: 'me' });
    await put(B(), 'revoked', 1, 0, { owner: 'me' });
    expect((await refused(put(A(), 'left', 2, 1))).code).toBe('NOT_OWNER');
    await removeMember(ctx, { kind: 'admin' }, P, s.bob.id);
    expect((await put(A(), 'left', 2, 1)).version).toBe(2);
    expect(await getEntry(ctx, A(), P, 'left')).toMatchObject({ owner: null, value: 2 });
    await adminRevokeAgent(ctx, s.bob.id);
    expect((await put(A(), 'revoked', 2, 1)).version).toBe(2);
    expect(await getEntry(ctx, A(), P, 'revoked')).toMatchObject({ owner: null });
    await assertConsistent();
  });

  it('admin repairs at version 0 are refused up front, never as a retry error', async () => {
    expect((await refused(adminDeleteEntry(ctx, P, 'never', 0, 'x'))).code).toBe('NOTHING_TO_DELETE');
    expect((await refused(adminReleaseOwner(ctx, P, 'never', 0, 'x'))).code).toBe('NOTHING_TO_DELETE');
  });

  it('admin release keeps the value and logs admin_release; admin delete leaves a tombstone and logs admin_delete', async () => {
    await put(A(), 'r', { v: 1 }, 0, { owner: 'me' });
    await put(A(), 'd', { v: 2 }, 0, { owner: 'me' });
    await adminReleaseOwner(ctx, P, 'r', 1, 'Alice is gone');
    await adminDeleteEntry(ctx, P, 'd', 1, 'stale ruling');
    expect(await getEntry(ctx, B(), P, 'r')).toMatchObject({ owner: null, version: 2, value: { v: 1 }, updatedBy: 'admin', note: 'Alice is gone' });
    expect((await refused(getEntry(ctx, B(), P, 'd'))).details).toMatchObject({ deleted: true, version: 2, deleted_by: 'admin' });
    expect((await entryHistory(ctx, A(), P, 'r')).versions[0]).toMatchObject({ op: 'admin_release', actor: 'admin', owner: null, value: { v: 1 } });
    expect((await entryHistory(ctx, A(), P, 'd')).versions[0]).toMatchObject({ op: 'admin_delete', actor: 'admin' });
    expect((await entryHistory(ctx, A(), P, 'd')).versions[0]).not.toHaveProperty('value');
    const log = await changesSince(ctx, P, 0);
    expect(log.slice(-2).map((c) => [c.kind, c.actor, (c.data as any).op])).toEqual([['data.put', 'admin', 'admin_release'], ['data.deleted', 'admin', 'admin_delete']]);
    expect((await refused(adminReleaseOwner(ctx, P, 'r', 2, 'again'))).code).toBe('VERSION_CONFLICT'); // nothing to release
    expect((await refused(adminReleaseOwner(ctx, P, 'r', 1, 'stale'))).code).toBe('VERSION_CONFLICT');
    expect((await refused(adminDeleteEntry(ctx, P, 'r', 2, '  '))).code).toBe('REASON_REQUIRED');
    await assertConsistent();
  });
});

describe('batches', () => {
  const ops = (...o: Parameters<typeof batchWrite>[2]['ops']) => ({ projectId: P, ops: o });

  it('applies puts, deletes and checks together under one batch id', async () => {
    await put(A(), 'ruling', 'v4', 0);
    await put(A(), 'evening/mon', 'booked', 0);
    const r = await batchWrite(ctx, A(), {
      ...ops(
        { op: 'check', key: 'ruling', expectedVersion: 1 },
        { op: 'delete', key: 'evening/mon', expectedVersion: 1 },
        { op: 'put', key: 'evening/tue', value: 'booked', expectedVersion: 0 },
      ),
      note: 'move monday to tuesday',
    });
    expect(r.results).toEqual([{ key: 'ruling', version: 1 }, { key: 'evening/mon', version: 2 }, { key: 'evening/tue', version: 1 }]);
    const sizes = await batchSizes();
    expect(sizes.get(r.batchId!)).toBe(2); // the check wrote nothing
    expect(sizes.size).toBe(1);
    await assertConsistent();
  });

  it.each([
    ['first', 0],
    ['middle', 1],
    ['last', 2],
  ])('one conflicting op in the %s position changes nothing: no entry, history, change log or message', async (_n, bad) => {
    await put(A(), 'seed', 'x', 0);
    const base = { entries: await rows('data_entries'), history: await rows('data_history'), log: await rows('change_log'), msgs: await rows('messages') };
    const list: Parameters<typeof batchWrite>[2]['ops'] = [
      { op: 'put', key: 'n0', value: 0, expectedVersion: 0 },
      { op: 'put', key: 'n1', value: 1, expectedVersion: 0 },
      { op: 'put', key: 'n2', value: 2, expectedVersion: 0 },
    ];
    list[bad] = { op: 'put', key: 'seed', value: 'y', expectedVersion: 7 };
    const e = await refused(batchWrite(ctx, A(), { projectId: P, ops: list, notify: 'all' }));
    expect(e.code).toBe('VERSION_CONFLICT');
    expect((e.details as any).conflicts.map((c: any) => c.key)).toEqual(['seed']);
    expect({ entries: await rows('data_entries'), history: await rows('data_history'), log: await rows('change_log'), msgs: await rows('messages') }).toEqual(base);
    await assertConsistent();
  });

  it('lists every conflicting key in details', async () => {
    await put(A(), 'a', 1, 0);
    await put(A(), 'b', 1, 0);
    const e = await refused(batchWrite(ctx, A(), ops({ op: 'put', key: 'a', value: 2, expectedVersion: 5 }, { op: 'put', key: 'b', value: 2, expectedVersion: 5 }, { op: 'put', key: 'c', value: 2, expectedVersion: 0 })));
    expect((e.details as any).conflicts.map((c: any) => [c.key, c.version])).toEqual([['a', 1], ['b', 1]]);
  });

  it.each([
    ['first', 0],
    ['middle', 1],
    ['last', 2],
  ])('a failing check in the %s position rolls the whole batch back', async (_n, bad) => {
    await put(A(), 'seed', 'x', 0);
    const checks: Parameters<typeof batchWrite>[2]['ops'] = [
      { op: 'check', key: 'c0', expectedVersion: 0 },
      { op: 'check', key: 'seed', expectedVersion: 1 },
      { op: 'check', key: 'c2', expectedVersion: 0 },
    ];
    checks[bad] = { op: 'check', key: 'seed', expectedVersion: 9 };
    // distinct keys: the failing check reuses 'seed' only once
    const list = checks.map((c, i) => (c.key === 'seed' && i !== bad ? { ...c, key: `other${i}`, expectedVersion: 0 } : c));
    const e = await refused(batchWrite(ctx, A(), { projectId: P, ops: [...list, { op: 'put', key: 'w', value: 1, expectedVersion: 0 }] }));
    expect(e.code).toBe('VERSION_CONFLICT');
    expect(await rows('data_history')).toBe(1);
    expect(await rows('data_entries')).toBe(1);
    await assertConsistent();
  });

  it('a check is about the version only: a tombstone version passes, a stale one fails', async () => {
    await put(A(), 'k', 1, 0);
    await deleteEntry(ctx, A(), { projectId: P, key: 'k', expectedVersion: 1 });
    expect((await batchWrite(ctx, A(), ops({ op: 'check', key: 'k', expectedVersion: 2 }, { op: 'put', key: 'w', value: 1, expectedVersion: 0 }))).results[0]).toEqual({ key: 'k', version: 2 });
    expect((await refused(batchWrite(ctx, A(), ops({ op: 'check', key: 'k', expectedVersion: 0 }, { op: 'put', key: 'w2', value: 1, expectedVersion: 0 })))).code).toBe('VERSION_CONFLICT');
  });

  it('refuses 0 and 26 ops, a duplicate key, a batch with nothing to write, a delete of a never-existing key, and over 512 KiB', async () => {
    expect((await refused(batchWrite(ctx, A(), ops()))).code).toBe('BAD_OPS');
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ op: 'put' as const, key: `m${i}`, value: i, expectedVersion: 0 }));
    expect((await refused(batchWrite(ctx, A(), { projectId: P, ops: many(26) }))).code).toBe('BAD_OPS');
    expect((await batchWrite(ctx, A(), { projectId: P, ops: many(25) })).results).toHaveLength(25);
    expect((await refused(batchWrite(ctx, A(), ops({ op: 'put', key: 'd', value: 1, expectedVersion: 0 }, { op: 'delete', key: 'd', expectedVersion: 1 })))).code).toBe('DUPLICATE_KEY');
    expect((await refused(batchWrite(ctx, A(), ops({ op: 'check', key: 'm0', expectedVersion: 1 })))).code).toBe('NOTHING_TO_WRITE');
    expect((await refused(batchWrite(ctx, A(), ops({ op: 'delete', key: 'never', expectedVersion: 0 })))).code).toBe('NOTHING_TO_DELETE');
    const chunk = 'x'.repeat(60000);
    const big = Array.from({ length: 10 }, (_, i) => ({ op: 'put' as const, key: `big${i}`, value: chunk, expectedVersion: 0 }));
    expect((await refused(batchWrite(ctx, A(), { projectId: P, ops: big }))).code).toBe('BATCH_TOO_LARGE');
    expect((await batchWrite(ctx, A(), { projectId: P, ops: big.slice(0, 8) })).results).toHaveLength(8); // 8 x 60 KB < 512 KiB
    await assertConsistent();
  });

  it('a batch can create "me"-owned keys, and one NOT_OWNER key refuses the whole batch', async () => {
    await put(B(), 'bobs', 1, 0, { owner: 'me' });
    await batchWrite(ctx, A(), ops({ op: 'put', key: 'x', value: 1, expectedVersion: 0, owner: 'me' }));
    const e = await refused(batchWrite(ctx, A(), ops({ op: 'put', key: 'y', value: 1, expectedVersion: 0 }, { op: 'delete', key: 'bobs', expectedVersion: 1 })));
    expect(e.code).toBe('NOT_OWNER');
    expect(await rows('data_entries')).toBe(2);
    await assertConsistent();
  });

  it('applies the key limit across the ops of one batch, in order', async () => {
    await env.DB.exec(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${MAX_LIVE_KEYS - 1}) INSERT INTO data_entries SELECT ${P}, 'k' || i, 1, '1', NULL, 'Alice', '2026-11-24T10:00:00.000Z', NULL, 0 FROM n`,
    );
    const e = await refused(batchWrite(ctx, A(), ops({ op: 'put', key: 'p1', value: 1, expectedVersion: 0 }, { op: 'put', key: 'p2', value: 1, expectedVersion: 0 })));
    expect(e.code).toBe('KEY_LIMIT');
    expect(await rows('data_entries')).toBe(MAX_LIVE_KEYS - 1);
    // a delete earlier in the batch frees the slot the second create needs
    await env.DB.exec(`INSERT INTO data_history (project_id, key, version, op, value, actor, at) SELECT project_id, key, 1, 'put', '1', 'Alice', '2026-11-24T10:00:00.000Z' FROM data_entries`);
    const ok = await batchWrite(ctx, A(), ops({ op: 'delete', key: 'k1', expectedVersion: 1 }, { op: 'put', key: 'p1', value: 1, expectedVersion: 0 }, { op: 'put', key: 'p2', value: 1, expectedVersion: 0 }));
    expect(ok.results).toHaveLength(3);
  });
});

describe('retries with request_id', () => {
  it('the same request returns the first result and writes nothing again', async () => {
    const first = await put(A(), 'k', 'v', 0, { requestId: 'r1' });
    const again = await put(A(), 'k', 'v', 0, { requestId: 'r1' });
    expect(again).toEqual({ ...first, duplicate: true });
    expect(await rows('data_history')).toBe(1);
    expect(await rows('change_log')).toBe(1);
    const d = await deleteEntry(ctx, A(), { projectId: P, key: 'k', expectedVersion: 1, requestId: 'r2' });
    expect(await deleteEntry(ctx, A(), { projectId: P, key: 'k', expectedVersion: 1, requestId: 'r2' })).toEqual({ ...d, duplicate: true });
    await assertConsistent();
  });

  it('a retried batch returns the first batch result, with its ops in order', async () => {
    const o = [{ op: 'put' as const, key: 'a', value: 1, expectedVersion: 0 }, { op: 'put' as const, key: 'b', value: 1, expectedVersion: 0 }];
    const first = await batchWrite(ctx, A(), { projectId: P, ops: o, requestId: 'b1' });
    const again = await batchWrite(ctx, A(), { projectId: P, ops: o, requestId: 'b1' });
    expect(again).toEqual({ ...first, duplicate: true });
    expect(await rows('data_history')).toBe(2);
  });

  it('the same request_id for a different write is REQUEST_ID_REUSED; another agent may use the same id', async () => {
    await put(A(), 'k', 1, 0, { requestId: 'r' });
    expect((await refused(put(A(), 'other', 1, 0, { requestId: 'r' }))).code).toBe('REQUEST_ID_REUSED');
    expect((await refused(put(A(), 'k', 1, 1, { requestId: 'r' }))).code).toBe('REQUEST_ID_REUSED'); // same key, new content/version
    expect((await put(B(), 'bobs', 1, 0, { requestId: 'r' })).version).toBe(1);
    await assertConsistent();
  });

  it('two different writes that share a request_id do not break an honest retry of either', async () => {
    await put(A(), 'a', 1, 0, { requestId: 'same' });
    await put(A(), 'b', 1, 0, { requestId: 'same' }).catch(() => undefined); // refused as REQUEST_ID_REUSED; simulate the race by writing the row directly
    await env.DB.prepare(`INSERT INTO data_entries (project_id, key, version, value, updated_by, updated_at) VALUES (?,?,?,?,?,?)`).bind(P, 'b', 1, '1', 'Alice', '2026-11-24T10:00:00.000Z').run();
    await env.DB.prepare(`INSERT INTO data_history (project_id, key, version, op, value, actor, at, request_id) VALUES (?,?,?,?,?,?,?,?)`).bind(P, 'b', 1, 'put', '1', 'Alice', '2026-11-24T10:00:00.000Z', 'same').run();
    expect(await put(A(), 'a', 1, 0, { requestId: 'same' })).toMatchObject({ key: 'a', version: 1, duplicate: true });
    expect(await put(A(), 'b', 1, 0, { requestId: 'same' })).toMatchObject({ key: 'b', version: 1, duplicate: true });
  });

  it('a retry that asks for a different owner is not a duplicate of the original', async () => {
    await put(A(), 'k', 1, 0, { owner: 'me', requestId: 'o1' });
    expect((await refused(put(A(), 'k', 1, 0, { owner: null, requestId: 'o1' }))).code).toBe('REQUEST_ID_REUSED');
    expect((await put(A(), 'k', 1, 0, { owner: 'me', requestId: 'o1' })).duplicate).toBe(true);
    // a create has no owner unless it asks for one, so omitting it is not the same request as owner "me"
    expect((await refused(put(A(), 'k', 1, 0, { requestId: 'o1' }))).code).toBe('REQUEST_ID_REUSED');
    await put(A(), 'plain', 1, 0, { requestId: 'o2' });
    expect((await put(A(), 'plain', 1, 0, { requestId: 'o2' })).duplicate).toBe(true);
    expect((await refused(put(A(), 'plain', 1, 0, { owner: 'me', requestId: 'o2' }))).code).toBe('REQUEST_ID_REUSED');
    // an update without owner means "keep": nothing to compare
    await put(A(), 'plain', 2, 1, { requestId: 'o3' });
    expect((await put(A(), 'plain', 2, 1, { requestId: 'o3' })).duplicate).toBe(true);
  });

  it('a revive asked for without owner must match the original revive, which had none', async () => {
    await put(A(), 'r', 1, 0);
    await deleteEntry(ctx, A(), { projectId: P, key: 'r', expectedVersion: 1 });
    await put(A(), 'r', 2, 2, { owner: 'me', requestId: 'rv' });
    expect((await refused(put(A(), 'r', 2, 2, { requestId: 'rv' }))).code).toBe('REQUEST_ID_REUSED');
    expect((await put(A(), 'r', 2, 2, { owner: 'me', requestId: 'rv' })).duplicate).toBe(true);
  });

  it('a single write retried through the batch tool returns a null batch id, not a crash', async () => {
    await put(A(), 'k', 1, 0, { requestId: 'sb' });
    const r = await batchWrite(ctx, A(), { projectId: P, requestId: 'sb', ops: [{ op: 'put', key: 'k', value: 1, expectedVersion: 0 }] });
    expect(r).toMatchObject({ batchId: null, duplicate: true, results: [{ key: 'k', version: 1 }] });
  });

  it('two different writes by one agent under one request_id cannot both commit', async () => {
    const res = await Promise.allSettled([
      put(A(), 'a', 1, 0, { requestId: 'same' }),
      put(A(), 'b', 1, 0, { requestId: 'same' }),
      batchWrite(ctx, A(), { projectId: P, requestId: 'same', ops: [{ op: 'put', key: 'c', value: 1, expectedVersion: 0 }] }),
    ]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of res) if (r.status === 'rejected') expect((r.reason as EchoError).code).toBe('REQUEST_ID_REUSED');
    expect(await rows('data_entries')).toBe(1);
    expect(await rows('data_history')).toBe(1);
    expect(await rows('data_requests')).toBe(1);
    await assertConsistent();
  });

  it('a failed write does not use up its request_id', async () => {
    await put(A(), 'k', 1, 0);
    await refused(put(A(), 'k', 2, 0, { requestId: 'again' })); // conflict: nothing written
    expect(await rows('data_requests')).toBe(0);
    expect((await put(A(), 'k', 2, 1, { requestId: 'again' })).version).toBe(2);
    expect(await rows('data_requests')).toBe(1);
  });

  it('another agent may use the same request_id', async () => {
    await put(A(), 'a', 1, 0, { requestId: 'shared-id' });
    expect((await put(B(), 'b', 1, 0, { requestId: 'shared-id' })).version).toBe(1);
    expect(await rows('data_requests')).toBe(2);
  });

  it('a smaller request under the id of a batch is not accepted as its retry', async () => {
    await batchWrite(ctx, A(), { projectId: P, requestId: 'b2', ops: [{ op: 'put', key: 'a', value: 1, expectedVersion: 0 }, { op: 'put', key: 'b', value: 1, expectedVersion: 0 }] });
    expect((await refused(put(A(), 'a', 1, 0, { requestId: 'b2' }))).code).toBe('REQUEST_ID_REUSED');
    expect((await refused(batchWrite(ctx, A(), { projectId: P, requestId: 'b2', ops: [{ op: 'put', key: 'a', value: 1, expectedVersion: 0 }, { op: 'put', key: 'b', value: 1, expectedVersion: 0 }, { op: 'put', key: 'c', value: 1, expectedVersion: 0 }] }))).code).toBe('REQUEST_ID_REUSED');
    expect((await batchWrite(ctx, A(), { projectId: P, requestId: 'b2', ops: [{ op: 'put', key: 'b', value: 1, expectedVersion: 0 }, { op: 'put', key: 'a', value: 1, expectedVersion: 0 }] })).duplicate).toBe(true);
  });

  it('history of a key that never existed is not found, with or without before_version', async () => {
    expect((await refused(entryHistory(ctx, A(), P, 'ghost'))).code).toBe('DATA_NOT_FOUND');
    expect((await refused(entryHistory(ctx, A(), P, 'ghost', { beforeVersion: 5 }))).code).toBe('DATA_NOT_FOUND');
    await put(A(), 'real', 1, 0);
    expect((await entryHistory(ctx, A(), P, 'real', { beforeVersion: 1 })).versions).toEqual([]);
  });

  it('without a request_id a retried success is a plain conflict, as the spec says', async () => {
    await put(A(), 'k', 1, 0);
    expect((await refused(put(A(), 'k', 1, 0))).code).toBe('VERSION_CONFLICT');
  });
});

describe('list and history read values only for rows that fit the response', () => {
  /** A ctx whose queries report how many bytes of rows D1 handed back. */
  function measuring() {
    const sizes: number[] = [];
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            const st = target.prepare(sql);
            const bind = st.bind.bind(st);
            st.bind = (...a: unknown[]) => {
              const b = bind(...a);
              const all = b.all.bind(b);
              b.all = (async () => {
                const r = await all();
                sizes.push(JSON.stringify(r.results).length);
                return r;
              }) as typeof b.all;
              return b;
            };
            return st;
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    return { ctx: { ...ctx, db } as typeof ctx, sizes };
  }

  it('a list with values returns about a megabyte from D1, not every value', async () => {
    const chunk = 'x'.repeat(60000);
    for (let i = 0; i < 40; i++) await put(A(), `big/${String(i).padStart(2, '0')}`, chunk, 0);
    const m = measuring();
    const r = await listEntries(m.ctx, A(), P, { includeValues: true, limit: 500 });
    expect(r.entries.length).toBeGreaterThan(5);
    expect(r.entries.length).toBeLessThan(40);
    expect(r.afterKey).toBe(r.entries[r.entries.length - 1]!.key);
    expect(Math.max(...m.sizes), `D1 returned ${Math.max(...m.sizes)} bytes`).toBeLessThan(1.2 * 1024 * 1024);
    // paging on from after_key reaches every key exactly once
    const seen: string[] = r.entries.map((e) => e.key);
    let after = r.afterKey;
    while (after) {
      const next = await listEntries(ctx, A(), P, { includeValues: true, afterKey: after });
      seen.push(...next.entries.map((e) => e.key));
      after = next.afterKey;
    }
    expect(seen).toEqual(Array.from({ length: 40 }, (_, i) => `big/${String(i).padStart(2, '0')}`));
  });

  it('a list without values never reads them at all', async () => {
    const chunk = 'x'.repeat(60000);
    for (let i = 0; i < 20; i++) await put(A(), `k${i}`, chunk, 0);
    const m = measuring();
    const r = await listEntries(m.ctx, A(), P, {});
    expect(r.entries).toHaveLength(20);
    expect(Math.max(...m.sizes), `D1 returned ${Math.max(...m.sizes)} bytes`).toBeLessThan(20000);
  });

  it('history with values is cut at the response cap the same way, and pages on from before_version', async () => {
    const chunk = 'y'.repeat(60000);
    await put(A(), 'h', chunk, 0);
    for (let i = 1; i < 40; i++) await put(A(), 'h', chunk + i, i);
    const m = measuring();
    const h = await entryHistory(m.ctx, A(), P, 'h', { limit: 200 });
    expect(h.versions.length).toBeGreaterThan(5);
    expect(h.versions.length).toBeLessThan(40);
    expect(Math.max(...m.sizes), `D1 returned ${Math.max(...m.sizes)} bytes`).toBeLessThan(1.2 * 1024 * 1024);
    const got = h.versions.map((v) => v.version);
    let before = h.beforeVersion;
    while (before) {
      const next = await entryHistory(ctx, A(), P, 'h', { limit: 200, beforeVersion: before });
      got.push(...next.versions.map((v) => v.version));
      before = next.beforeVersion;
    }
    expect(got).toEqual(Array.from({ length: 40 }, (_, i) => 40 - i));
    const lean = measuring();
    await entryHistory(lean.ctx, A(), P, 'h', { limit: 200, includeValues: false });
    expect(Math.max(...lean.sizes)).toBeLessThan(40000);
  });
});

describe('audit completeness', () => {
  it('a scripted sequence: history plus the change log reproduce every state', async () => {
    const states: Record<string, unknown>[] = [];
    const snap = async () => states.push(Object.fromEntries((await env.DB.prepare(`SELECT key, version, value, owner, deleted FROM data_entries ORDER BY key`).all<any>()).results.map((r) => [r.key, [r.version, r.value, r.owner, r.deleted]])));
    await put(A(), 'a', { n: 1 }, 0, { owner: 'me', note: 'one' }); await snap();
    await put(A(), 'a', { n: 2 }, 1); await snap();
    await put(B(), 'b', 'x', 0); await snap();
    await refused(put(B(), 'a', 'no', 2)); await snap(); // NOT_OWNER: no change
    await refused(put(A(), 'a', 'no', 1)); await snap(); // conflict: no change
    await deleteEntry(ctx, B(), { projectId: P, key: 'b', expectedVersion: 1 }); await snap();
    await put(A(), 'b', 'y', 2); await snap();
    await batchWrite(ctx, A(), { projectId: P, ops: [{ op: 'put', key: 'a', value: 3, expectedVersion: 2, owner: null }, { op: 'delete', key: 'b', expectedVersion: 3 }] }); await snap();
    await adminDeleteEntry(ctx, P, 'a', 3, 'cleanup'); await snap();
    // replay history into a map and compare with the table
    const replay = new Map<string, any>();
    for (const h of (await env.DB.prepare(`SELECT * FROM data_history ORDER BY at, rowid`).all<any>()).results) {
      replay.set(h.key, [h.version, h.value, h.owner, h.op === 'delete' || h.op === 'admin_delete' ? 1 : 0]);
    }
    expect(Object.fromEntries(replay)).toEqual(states[states.length - 1]);
    // failures changed nothing between their snapshots
    expect(states[3]).toEqual(states[2]);
    expect(states[4]).toEqual(states[2]);
    // the log carries the same story, in order
    const log = await changesSince(ctx, P, 0);
    expect(log.map((c) => [c.kind, (c.data as any).key, (c.data as any).version])).toEqual([
      ['data.put', 'a', 1], ['data.put', 'a', 2], ['data.put', 'b', 1], ['data.deleted', 'b', 2], ['data.put', 'b', 3], ['data.put', 'a', 3], ['data.deleted', 'b', 4], ['data.deleted', 'a', 4],
    ]);
    expect(log.every((c) => typeof c.seq === 'number' && c.at === '2026-11-24T10:00:00.000Z')).toBe(true);
    await assertConsistent();
  });

  it('every kind of refusal leaves no history, change-log, message or entry row', async () => {
    await put(B(), 'bobs', 1, 0, { owner: 'me' });
    const base = [await rows('data_entries'), await rows('data_history'), await rows('change_log'), await rows('messages')];
    const attempts: (() => Promise<unknown>)[] = [
      () => put(A(), 'bobs', 2, 1), // NOT_OWNER
      () => put(A(), 'bobs', 2, 9), // conflict
      () => put(A(), 'bad key', 1, 0),
      () => put(A(), 'k', 'x'.repeat(70000), 0),
      () => put(A(), 'k', 1, 0, { notify: ['Nobody'] }),
      () => put(A(), 'k', 1, 0, { notify: ['Alice'] }),
      () => put(s.carolA, 'k', 1, 0),
      () => batchWrite(ctx, A(), { projectId: P, ops: [{ op: 'put', key: 'x', value: 1, expectedVersion: 0 }, { op: 'put', key: 'bobs', value: 1, expectedVersion: 5 }], notify: 'all' }),
    ];
    for (const run of attempts) await refused(run());
    expect([await rows('data_entries'), await rows('data_history'), await rows('change_log'), await rows('messages')]).toEqual(base);
    await assertConsistent();
  });
});

describe('notifications', () => {
  const messages = async () => (await env.DB.prepare(`SELECT id, sender_label, body, requires_ack, kind FROM messages ORDER BY id`).all<any>()).results;
  const recipients = async (id: number) => (await env.DB.prepare(`SELECT a.name FROM message_recipients r JOIN agents a ON a.id = r.agent_id WHERE r.message_id = ? ORDER BY a.name`).bind(id).all<{ name: string }>()).results.map((r) => r.name);

  it('writes the message in the same batch, with key@version, to the named agents', async () => {
    await put(A(), 'rulings/cap', { v: 1 }, 0, { note: 'the owner said so', notify: ['Bob'] });
    const m = await messages();
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ sender_label: 'Alice', body: 'Shared data rulings/cap@v1 (put) by Alice: the owner said so', requires_ack: 0, kind: 'plain' });
    expect(await recipients(m[0].id)).toEqual(['Bob']);
    await assertConsistent();
  });

  it('"all" reaches everyone but the writer; no notify, no message', async () => {
    await put(A(), 'quiet', 1, 0);
    expect(await messages()).toHaveLength(0);
    await put(A(), 'loud', 1, 0, { notify: 'all' });
    expect(await recipients((await messages())[0].id)).toEqual(['Bob']);
  });

  it('the text names the committed version for create, update, delete, revive and a mixed batch', async () => {
    await put(A(), 'k', 1, 0, { notify: 'all' });
    await put(A(), 'k', 2, 1, { notify: 'all' });
    await deleteEntry(ctx, A(), { projectId: P, key: 'k', expectedVersion: 2, notify: 'all' });
    await put(A(), 'k', 4, 3, { notify: 'all' });
    await batchWrite(ctx, A(), { projectId: P, notify: ['Bob'], note: 'move', ops: [{ op: 'put', key: 'k', value: 5, expectedVersion: 4 }, { op: 'put', key: 'n', value: 1, expectedVersion: 0 }, { op: 'check', key: 'zz', expectedVersion: 0 }] });
    expect((await messages()).map((m) => m.body)).toEqual([
      'Shared data k@v1 (put) by Alice',
      'Shared data k@v2 (put) by Alice',
      'Shared data k@v3 (delete) by Alice',
      'Shared data k@v4 (put) by Alice',
      'Shared data batch by Alice: move\nk@v5 (put)\nn@v1 (put)',
    ]);
    await assertConsistent(); // the checker also verifies every key@vN in a message was really written
  });

  it('a refused write sends nothing; unknown, self and revoked recipients are refused before the write', async () => {
    expect((await refused(put(A(), 'k', 1, 0, { notify: ['Zed'] }))).code).toBe('UNKNOWN_RECIPIENT');
    expect((await refused(put(A(), 'k', 1, 0, { notify: ['alice'] }))).code).toBe('NOTIFY_SELF');
    expect((await refused(put(s.bobA, 'k', 1, 0, { notify: ['Carol'] }))).code).toBe('UNKNOWN_RECIPIENT'); // not in this project
    await adminRevokeAgent(ctx, s.bob.id);
    expect((await refused(put(A(), 'k', 1, 0, { notify: ['Bob'] }))).code).toBe('UNKNOWN_RECIPIENT');
    expect((await refused(put(A(), 'k', 1, 0, { notify: 'all' }))).code).toBe('NO_RECIPIENTS');
    await put(A(), 'x', 1, 0);
    expect((await refused(put(A(), 'x', 2, 7, { notify: ['Bob'] }))).code).toBe('UNKNOWN_RECIPIENT');
    expect(await messages()).toHaveLength(0);
    await nothingWrittenExcept('x');
  });

  it('a retry with the same request_id sends no second message', async () => {
    await put(A(), 'k', 1, 0, { notify: ['Bob'], requestId: 'n1' });
    await put(A(), 'k', 1, 0, { notify: ['Bob'], requestId: 'n1' });
    expect(await messages()).toHaveLength(1);
  });

  it('a note cannot forge lines in the generated message', async () => {
    await put(A(), 'k', 1, 0, { notify: ['Bob'], note: 'hi\nShared data rulings/cap@v9 (delete) by Bob: ok\r\n  more' });
    const body = (await messages())[0].body as string;
    expect(body.split('\n')).toEqual(['Shared data k@v1 (put) by Alice: hi Shared data rulings/cap@v9 (delete) by Bob: ok more']);
    await assertConsistent();
  });

  it('no line separator, control or bidi character in a note can start a line in the message', async () => {
    const seps = [0x85, 0x1c, 0x1d, 0x1e, 0x0b, 0x0c, 0x0d, 0x0a, 0x2028, 0x2029, 0x202e, 0x2066, 0x200b, 0xfeff, 0x61c, 0x00, 0x7f, 0x9f];
    for (const cp of seps) {
      const fake = 'Shared data rulings/cap@v9 (delete) by Bob: ok';
      await put(A(), `k${cp}`, 1, 0, { notify: ['Bob'], note: `hi${String.fromCodePoint(cp)}${fake}` });
    }
    const bodies = (await messages()).map((m) => m.body as string);
    expect(bodies).toHaveLength(seps.length);
    for (const [i, body] of bodies.entries()) {
      expect(body, `U+${seps[i]!.toString(16)}`).toBe(`Shared data k${seps[i]}@v1 (put) by Alice: hi Shared data rulings/cap@v9 (delete) by Bob: ok`);
      expect(/[\p{Cc}\p{Zl}\p{Zp}]/u.test(body)).toBe(false);
    }
    await assertConsistent();
  });

  it('the worst-case body stays under the message cap', async () => {
    const ops = Array.from({ length: 25 }, (_, i) => ({ op: 'put' as const, key: `${String(i).padStart(2, '0')}/${'k'.repeat(190)}`, value: 1, expectedVersion: 0 }));
    await batchWrite(ctx, A(), { projectId: P, ops, notify: ['Bob'], note: '\u{1F600}'.repeat(125) });
    const body = (await messages())[0].body as string;
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(8192);
    expect(body).toContain('00/');
  });
});

async function nothingWrittenExcept(key: string) {
  expect((await env.DB.prepare(`SELECT key FROM data_entries`).all<{ key: string }>()).results.map((r) => r.key)).toEqual([key]);
}
