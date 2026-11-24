import { env } from 'cloudflare:test';
import { expect } from 'vitest';

type Row = Record<string, any>;
const all = async (sql: string, ...b: unknown[]): Promise<Row[]> => (await env.DB.prepare(sql).bind(...b).all<Row>()).results;

/**
 * The invariants every shared-data test ends with. They make "history plus the change log reproduce every state"
 * and "a failed write leaves no trace" checkable after any sequence of writes, however concurrent.
 */
export async function assertConsistent(label = ''): Promise<void> {
  const at = (m: string) => `${label ? label + ': ' : ''}${m}`;
  const entries = await all(`SELECT * FROM data_entries`);
  const history = await all(`SELECT * FROM data_history ORDER BY project_id, key, version`);
  const log = (await all(`SELECT seq, kind, subject_id, data FROM change_log WHERE kind IN ('data.put', 'data.deleted') ORDER BY seq`)).map((r) => ({ seq: r.seq as number, kind: r.kind as string, d: JSON.parse(r.data) }));

  expect(await all(`SELECT * FROM data_guard`), at('data_guard is empty')).toEqual([]);

  const byKey = new Map<string, Row[]>();
  for (const h of history) {
    const k = `${h.project_id}\u0000${h.key}`;
    byKey.set(k, [...(byKey.get(k) ?? []), h]);
  }
  expect(byKey.size, at('every history key has an entry and the other way round')).toBe(entries.length);
  for (const e of entries) {
    const hs = byKey.get(`${e.project_id}\u0000${e.key}`);
    expect(hs, at(`history of ${e.key}`)).toBeDefined();
    expect(hs!.map((h) => h.version), at(`${e.key}: versions are contiguous from 1`)).toEqual(hs!.map((_h, i) => i + 1));
    const last = hs![hs!.length - 1]!;
    expect(e.version, at(`${e.key}: entry version is the last history version`)).toBe(last.version);
    expect(e.value, at(`${e.key}: entry value is the last history value`)).toBe(last.value);
    expect(e.owner, at(`${e.key}: entry owner is the last history owner`)).toBe(last.owner);
    expect(e.updated_by, at(`${e.key}: updated_by is the last actor`)).toBe(last.actor);
    expect(e.updated_at).toBe(last.at);
    expect(e.deleted === 1, at(`${e.key}: tombstone iff the last op deleted`)).toBe(last.op === 'delete' || last.op === 'admin_delete');
  }

  // One change-log row per history row, on (key, version), with the right kind and batch id.
  expect(log.length, at('one change-log row per history row')).toBe(history.length);
  const logged = new Map(log.map((l) => [`${l.d.key}@${l.d.version}`, l]));
  expect(logged.size, at('change-log rows are unique per key@version')).toBe(log.length);
  for (const h of history) {
    const l = logged.get(`${h.key}@${h.version}`);
    expect(l, at(`change-log row for ${h.key}@${h.version}`)).toBeDefined();
    expect(l!.kind).toBe(h.op === 'delete' || h.op === 'admin_delete' ? 'data.deleted' : 'data.put');
    expect(l!.d.batch_id).toBe(h.batch_id);
    expect(l!.d.op).toBe(h.op);
  }

  // A batch is all or nothing: every row of a batch id is in history, and the log agrees (checked 1:1 above), so a
  // half-applied batch would show as a batch with fewer rows than its ops. Callers that know the size pass it.
  // Every notification names key@version pairs that exist.
  for (const m of await all(`SELECT body FROM messages WHERE body LIKE 'Shared data%'`)) {
    for (const [, k, v] of (m.body as string).matchAll(/^(?:Shared data )?(\S+)@v(\d+) \(/gm)) {
      expect(logged.has(`${k}@${v}`), at(`a notification names ${k}@v${v}, which was never written`)).toBe(true);
    }
  }
}

export async function batchSizes(): Promise<Map<string, number>> {
  const rows = await all(`SELECT batch_id, COUNT(*) AS n FROM data_history WHERE batch_id IS NOT NULL GROUP BY batch_id`);
  return new Map(rows.map((r) => [r.batch_id as string, r.n as number]));
}
