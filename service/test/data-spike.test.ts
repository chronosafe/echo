import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

/**
 * Kept as a regression test: the all-or-nothing mechanism of the shared data store, in raw SQL.
 * If one of these fails, the design does not hold.
 */

const P = 1;
const T = '2026-11-24T10:00:00.000Z';
const db = () => env.DB;

const createStmts = (key: string, value = '1') => [
  db()
    .prepare(
      `INSERT INTO data_entries (project_id, key, version, value, owner, updated_by, updated_at, note, deleted)
       SELECT ?1, ?2, 1, ?3, NULL, 'Alice', ?4, NULL, 0
       WHERE (SELECT COUNT(*) FROM data_entries WHERE project_id = ?1 AND deleted = 0) < 2000
       ON CONFLICT (project_id, key) DO NOTHING`,
    )
    .bind(P, key, value, T),
  history(key, 'put'),
  logStmt(key, 'data.put'),
];

const updateStmts = (key: string, expected: number, value = '2') => [
  db()
    .prepare(
      `UPDATE data_entries SET version = version + 1, value = ?3, updated_by = 'Bob', updated_at = ?4, deleted = 0
       WHERE project_id = ?1 AND key = ?2 AND version = ?5`,
    )
    .bind(P, key, value, T, expected),
  history(key, 'put'),
  logStmt(key, 'data.put'),
];

const history = (key: string, op: string) =>
  db()
    .prepare(
      `INSERT INTO data_history (project_id, key, version, op, value, owner, actor, at, note, batch_id, request_id)
       SELECT ?1, ?2,
         CASE WHEN changes() > 0 THEN (SELECT version FROM data_entries WHERE project_id = ?1 AND key = ?2) END,
         ?3, (SELECT value FROM data_entries WHERE project_id = ?1 AND key = ?2),
         (SELECT owner FROM data_entries WHERE project_id = ?1 AND key = ?2), 'Alice', ?4, NULL, NULL, NULL
       RETURNING key, version`,
    )
    .bind(P, key, op, T);

const logStmt = (key: string, kind: string) =>
  db()
    .prepare(
      `INSERT INTO change_log (project_id, at, actor, kind, subject_id, data)
       SELECT ?1, ?2, 'Alice', ?3, ?4, json_object('key', ?4, 'version', e.version)
       FROM data_entries e WHERE e.project_id = ?1 AND e.key = ?4 AND changes() > 0`,
    )
    .bind(P, T, kind, key);

const checkStmts = (key: string, expected: number) => [
  db()
    .prepare(
      `INSERT INTO data_guard (ok)
       SELECT CASE WHEN (SELECT COALESCE(MAX(version), 0) FROM data_entries WHERE project_id = ?1 AND key = ?2) = ?3 THEN 1 END`,
    )
    .bind(P, key, expected),
  db().prepare(`DELETE FROM data_guard`),
];

const count = async (table: string) => (await db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const counts = async () => ({ e: await count('data_entries'), h: await count('data_history'), c: await count('change_log'), g: await count('data_guard') });

describe('shared data: the aborting-history mechanism (spike)', () => {
  it('commits entry, history and change-log together, and RETURNING reaches the batch result', async () => {
    const res = await db().batch([...createStmts('a/b', '{"x":1}'), ...updateStmts('a/b', 1, '{"x":2}')]);
    expect(res[1]!.results).toEqual([{ key: 'a/b', version: 1 }]);
    expect(res[4]!.results).toEqual([{ key: 'a/b', version: 2 }]);
    expect(await counts()).toEqual({ e: 1, h: 2, c: 2, g: 0 });
    const log = await db().prepare(`SELECT data FROM change_log ORDER BY seq`).all<{ data: string }>();
    expect(log.results.map((r) => JSON.parse(r.data))).toEqual([{ key: 'a/b', version: 1 }, { key: 'a/b', version: 2 }]);
  });

  it.each([
    ['first', 0],
    ['middle', 1],
    ['last', 2],
  ])('a failing guard in the %s op rolls back every op, including the earlier ones', async (_name, badAt) => {
    await db().batch(createStmts('seed'));
    const before = await counts();
    const ops = [createStmts('n0'), createStmts('n1'), createStmts('n2')];
    ops[badAt] = updateStmts('seed', 99); // stale expected version: the UPDATE changes no row
    let err: unknown;
    try {
      await db().batch(ops.flat());
    } catch (e) {
      err = e;
    }
    expect(err, 'the batch must throw').toBeDefined();
    const text = `${(err as Error).message} ${String((err as { cause?: unknown }).cause ?? '')}`;
    expect(text).toMatch(/NOT NULL constraint failed: data_history\.version/);
    expect(await counts()).toEqual(before); // nothing from the other two ops survived
    expect((await db().prepare(`SELECT key FROM data_entries ORDER BY key`).all<{ key: string }>()).results.map((r) => r.key)).toEqual(['seed']);
  });

  it('a create over any existing row, live or tombstone, changes nothing and aborts', async () => {
    await db().batch(createStmts('k'));
    await expect(db().batch(createStmts('k'))).rejects.toThrow(/NOT NULL constraint failed: data_history\.version/);
    await db().prepare(`UPDATE data_entries SET version = 2, value = NULL, deleted = 1 WHERE key = 'k'`).run();
    await expect(db().batch(createStmts('k'))).rejects.toThrow(/NOT NULL constraint failed: data_history\.version/);
    expect(await count('data_history')).toBe(1);
  });

  it('the live-key cap sits in the creating INSERT: the 2,001st create aborts, concurrent or not', async () => {
    await db().exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
      INSERT INTO data_entries SELECT ${P}, 'k' || i, 1, '1', NULL, 'Alice', '${T}', NULL, 0 FROM n`.replace(/\n\s*/g, ' '));
    expect(await count('data_entries')).toBe(2000);
    await expect(db().batch(createStmts('one-too-many'))).rejects.toThrow(/NOT NULL constraint failed: data_history\.version/);
    const results = await Promise.allSettled([db().batch(createStmts('r1')), db().batch(createStmts('r2'))]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(await count('data_entries')).toBe(2000);
  });

  it.each([
    ['first', 0],
    ['middle', 1],
    ['last', 2],
  ])('a failing check in the %s position rolls the batch back; a passing check writes nothing', async (_name, badAt) => {
    await db().batch(createStmts('seed'));
    const before = await counts();
    // All checks are emitted before every write (plan section 1); the failing one moves through the check list.
    const checks = [checkStmts('seed', 1), checkStmts('seed', 1), checkStmts('seed', 1)];
    checks[badAt] = checkStmts('seed', 7);
    await expect(db().batch([...checks.flat(), ...createStmts('w1'), ...createStmts('w2')])).rejects.toThrow(/NOT NULL constraint failed: data_guard\.ok/);
    expect(await counts()).toEqual(before);
    // all checks pass (including "never existed" = 0): the writes commit and the scratch table is empty again
    await db().batch([...checkStmts('seed', 1), ...checkStmts('absent', 0), ...createStmts('w1')]);
    expect(await counts()).toEqual({ ...before, e: before.e + 1, h: before.h + 1, c: before.c + 1 });
  });

  it('a guarded second batch: concurrent same-version updates, exactly one wins and history stays contiguous', async () => {
    await db().batch(createStmts('race'));
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => db().batch(updateStmts('race', 1, String(i + 10)))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const h = await db().prepare(`SELECT version FROM data_history WHERE key = 'race' ORDER BY version`).all<{ version: number }>();
    expect(h.results.map((r) => r.version)).toEqual([1, 2]);
    expect(await count('change_log')).toBe(2);
  });

  it('a 25-op batch of 64 KiB values runs as one batch', async () => {
    const big = JSON.stringify('x'.repeat(65536 - 2));
    expect(new TextEncoder().encode(big).length).toBe(65536);
    const stmts = Array.from({ length: 25 }, (_, i) => createStmts(`big/${i}`, big)).flat();
    const res = await db().batch(stmts);
    expect(res).toHaveLength(75);
    expect(await count('data_entries')).toBe(25);
    expect(await count('data_history')).toBe(25);
  });
});
