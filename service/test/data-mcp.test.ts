import { beforeEach, describe, expect, it } from 'vitest';
import { seed, testCtx } from './helpers';
import { mcpCall, mcpRaw } from './mcp-client';
import { assertConsistent } from './data-invariants';

const ctx = testCtx();
let s: Awaited<ReturnType<typeof seed>>;

beforeEach(async () => {
  ctx.setNow(new Date().toISOString());
  s = await seed(ctx);
});

async function ok(token: string, tool: string, args: unknown): Promise<any> {
  const r = await mcpCall(token, tool, args);
  if (r.isError) throw new Error(`${tool} refused: ${r.text}`);
  return JSON.parse(r.text);
}
const put = (token: string, key: string, value: unknown, expected_version: number, extra: Record<string, unknown> = {}) =>
  mcpCall(token, 'echo_data_put', { project: 'core', key, value, expected_version, ...extra });

describe('data tools: schemas', () => {
  it('tools/list advertises strict, closed schemas with the loop spelled out', async () => {
    const { json } = await mcpRaw(s.alice.token, 'tools/list', {});
    const by = Object.fromEntries((json.result.tools as any[]).map((t) => [t.name, t]));
    for (const n of ['echo_data_get', 'echo_data_list', 'echo_data_put', 'echo_data_delete', 'echo_data_batch', 'echo_data_history']) {
      expect(by[n].inputSchema.additionalProperties, n).toBe(false);
      expect(by[n].inputSchema.required, n).toContain('project');
    }
    expect(by.echo_data_put.inputSchema.required).toEqual(expect.arrayContaining(['key', 'value', 'expected_version']));
    expect(by.echo_data_delete.inputSchema.required).toEqual(expect.arrayContaining(['key', 'expected_version']));
    expect(Object.keys(by.echo_data_put.inputSchema.properties).sort()).toEqual(['expected_version', 'key', 'note', 'notify', 'owner', 'project', 'request_id', 'value']);
    expect(Object.keys(by.echo_data_list.inputSchema.properties).sort()).toEqual(['after_key', 'include_deleted', 'include_values', 'limit', 'prefix', 'project']);
    expect(JSON.stringify(Object.entries(by).filter(([n]) => n.startsWith('echo_data_')))).not.toMatch(/updated_since|requires_ack/);
    for (const n of ['echo_data_get', 'echo_data_put', 'echo_data_delete', 'echo_data_batch']) {
      expect(by[n].description, n).toMatch(/VERSION_CONFLICT/);
      expect(by[n].description, n).toMatch(/Never retry a conflict unchanged/);
    }
    expect(by.echo_data_put.description).toMatch(/there is no hand-over/);
    expect(by.echo_data_batch.description).toMatch(/check/);
    // every batch operation is closed too
    const variants = JSON.stringify(by.echo_data_batch.inputSchema.properties.ops);
    expect(variants).toMatch(/"op"/);
    expect((variants.match(/"additionalProperties":false/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it.each([
    ['an extra field', 'echo_data_put', { project: 'core', key: 'k', value: 1, expected_version: 0, surprise: 1 }],
    ['updated_since', 'echo_data_list', { project: 'core', updated_since: '2026-01-01T00:00:00Z' }],
    ['requires_ack', 'echo_data_put', { project: 'core', key: 'k', value: 1, expected_version: 0, requires_ack: true }],
    ['a missing expected_version', 'echo_data_put', { project: 'core', key: 'k', value: 1 }],
    ['a negative expected_version', 'echo_data_put', { project: 'core', key: 'k', value: 1, expected_version: -1 }],
    ['a string expected_version', 'echo_data_put', { project: 'core', key: 'k', value: 1, expected_version: '0' }],
    ['a fractional expected_version', 'echo_data_put', { project: 'core', key: 'k', value: 1, expected_version: 0.5 }],
    ['a missing value', 'echo_data_put', { project: 'core', key: 'k', expected_version: 0 }],
    ['a hand-over owner', 'echo_data_put', { project: 'core', key: 'k', value: 1, expected_version: 0, owner: 'Bob' }],
    ['a long note', 'echo_data_put', { project: 'core', key: 'k', value: 1, expected_version: 0, note: 'x'.repeat(501) }],
    ['a bad request_id', 'echo_data_put', { project: 'core', key: 'k', value: 1, expected_version: 0, request_id: 'a b' }],
    ['notify as a bare name', 'echo_data_put', { project: 'core', key: 'k', value: 1, expected_version: 0, notify: 'Bob' }],
    ['an empty notify list', 'echo_data_put', { project: 'core', key: 'k', value: 1, expected_version: 0, notify: [] }],
    ['no project', 'echo_data_get', { key: 'k' }],
    ['version 0 on get', 'echo_data_get', { project: 'core', key: 'k', version: 0 }],
    ['an empty ops list', 'echo_data_batch', { project: 'core', ops: [] }],
    ['26 ops', 'echo_data_batch', { project: 'core', ops: Array.from({ length: 26 }, (_, i) => ({ op: 'put', key: `k${i}`, value: 1, expected_version: 0 })) }],
    ['an unknown op', 'echo_data_batch', { project: 'core', ops: [{ op: 'upsert', key: 'k', value: 1, expected_version: 0 }] }],
    ['an extra field in an op', 'echo_data_batch', { project: 'core', ops: [{ op: 'delete', key: 'k', expected_version: 1, value: 1 }] }],
    ['owner on a check', 'echo_data_batch', { project: 'core', ops: [{ op: 'check', key: 'k', expected_version: 1, owner: 'me' }] }],
    ['a put op without value', 'echo_data_batch', { project: 'core', ops: [{ op: 'put', key: 'k', expected_version: 0 }] }],
  ])('refuses %s as BAD_REQUEST and writes nothing', async (_n, tool, args) => {
    const r = await mcpCall(s.alice.token, tool, args);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Refused \(rule BAD_REQUEST\)/);
    expect((await mcpCall(s.alice.token, 'echo_data_list', { project: 'core', include_deleted: true })).text).toBe('{"entries":[]}');
  });
});

describe('data tools: behavior', () => {
  it('put, get, list, history and delete round-trip with snake_case fields', async () => {
    expect(await ok(s.alice.token, 'echo_data_put', { project: 'core', key: 'rulings/cap', value: { cap: 3 }, expected_version: 0, note: 'owner, verbatim', owner: 'me' })).toEqual({ key: 'rulings/cap', version: 1, previous_version: 0 });
    expect(await ok(s.bob.token, 'echo_data_get', { project: 'core', key: 'rulings/cap' })).toMatchObject({
      key: 'rulings/cap', version: 1, value: { cap: 3 }, owner: 'Alice', updated_by: 'Alice', note: 'owner, verbatim', deleted: false, updated_at: expect.stringMatching(/Z$/),
    });
    const bad = await put(s.bob.token, 'rulings/cap', { cap: 4 }, 1);
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/^Refused \(rule NOT_OWNER\)/);
    expect(bad.text).toMatch(/\nDetails: \{"key":"rulings\/cap","owner":"Alice"\}$/);
    await ok(s.alice.token, 'echo_data_put', { project: 'core', key: 'rulings/cap', value: { cap: 5 }, expected_version: 1 });
    expect(await ok(s.bob.token, 'echo_data_list', { project: 'core', prefix: 'rulings/', include_values: true })).toMatchObject({ entries: [{ key: 'rulings/cap', version: 2, value: { cap: 5 } }] });
    const h = await ok(s.bob.token, 'echo_data_history', { project: 'core', key: 'rulings/cap', include_values: false });
    expect(h.versions.map((v: any) => [v.version, v.op, v.actor])).toEqual([[2, 'put', 'Alice'], [1, 'put', 'Alice']]);
    expect(h.versions[0]).not.toHaveProperty('value');
    expect(await ok(s.alice.token, 'echo_data_delete', { project: 'core', key: 'rulings/cap', expected_version: 2 })).toEqual({ key: 'rulings/cap', version: 3 });
    const gone = await mcpCall(s.bob.token, 'echo_data_get', { project: 'core', key: 'rulings/cap' });
    expect(gone.text).toMatch(/^Refused \(rule DATA_NOT_FOUND\)/);
    expect(gone.text).toMatch(/"version":3/);
    expect(await ok(s.bob.token, 'echo_data_get', { project: 'core', key: 'rulings/cap', version: 1 })).toMatchObject({ version: 1, op: 'put', value: { cap: 3 }, actor: 'Alice' });
    await assertConsistent();
  });

  it('VERSION_CONFLICT carries the current state in Details', async () => {
    await ok(s.alice.token, 'echo_data_put', { project: 'core', key: 'k', value: 'a', expected_version: 0 });
    await ok(s.bob.token, 'echo_data_put', { project: 'core', key: 'k', value: 'b', expected_version: 1, note: 'bob' });
    const r = await put(s.alice.token, 'k', 'c', 1);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Refused \(rule VERSION_CONFLICT\)/);
    const details = JSON.parse(r.text.split('\nDetails: ')[1]!);
    expect(details.conflicts[0]).toMatchObject({ key: 'k', expected_version: 1, version: 2, value: 'b', updated_by: 'Bob', note: 'bob', deleted: false });
  });

  it('batch with a check; a conflict in a batch names every key; retries return the first result', async () => {
    await ok(s.alice.token, 'echo_data_put', { project: 'core', key: 'ruling', value: 'v', expected_version: 0 });
    const args = { project: 'core', note: 'book', request_id: 'bk-1', ops: [{ op: 'check', key: 'ruling', expected_version: 1 }, { op: 'put', key: 'evening/2026-11-26', value: { by: 'Alice' }, expected_version: 0 }] };
    const first = await ok(s.alice.token, 'echo_data_batch', args);
    expect(first).toMatchObject({ batch_id: expect.any(String), results: [{ key: 'ruling', version: 1 }, { key: 'evening/2026-11-26', version: 1 }] });
    expect(await ok(s.alice.token, 'echo_data_batch', args)).toEqual({ ...first, duplicate: true });
    const clash = await mcpCall(s.bob.token, 'echo_data_batch', { project: 'core', ops: [{ op: 'put', key: 'ruling', value: 1, expected_version: 9 }, { op: 'put', key: 'evening/2026-11-26', value: 1, expected_version: 0 }] });
    expect(clash.text).toMatch(/^Refused \(rule VERSION_CONFLICT\)/);
    expect(JSON.parse(clash.text.split('\nDetails: ')[1]!).conflicts.map((c: any) => c.key)).toEqual(['ruling', 'evening/2026-11-26']);
    await assertConsistent();
  });

  it('notify writes a message the recipient can read in the inbox', async () => {
    await ok(s.alice.token, 'echo_data_put', { project: 'core', key: 'rulings/x', value: 1, expected_version: 0, note: 'act on this', notify: ['Bob'] });
    const inbox = await ok(s.bob.token, 'echo_inbox', { project: 'core' });
    expect(JSON.stringify(inbox)).toContain('Shared data rulings/x@v1 (put) by Alice: act on this');
  });

  it('echo_changes_since shows data changes with the exact key in data', async () => {
    await ok(s.alice.token, 'echo_data_put', { project: 'core', key: '007', value: 1, expected_version: 0 });
    await ok(s.alice.token, 'echo_data_delete', { project: 'core', key: '007', expected_version: 1 });
    const c = await ok(s.bob.token, 'echo_changes_since', { project: 'core', since_seq: 0 });
    expect(c.changes.map((x: any) => [x.kind, x.data.key, x.data.version])).toEqual([['data.put', '007', 1], ['data.deleted', '007', 2]]);
  });

  it('refuses a project the caller is not in, and a bad key with the fix', async () => {
    const other = await mcpCall(s.carol.token, 'echo_data_get', { project: 'core', key: 'k' });
    expect(other.text).toMatch(/^Refused \(rule NOT_MEMBER\)/);
    const bad = await put(s.alice.token, 'a/../b', 1, 0);
    expect(bad.text).toMatch(/^Refused \(rule BAD_KEY\)/);
    expect(bad.text).toMatch(/What to do: .*"\.\."/);
    const big = await put(s.alice.token, 'big', 'x'.repeat(70000), 0);
    expect(big.text).toMatch(/^Refused \(rule VALUE_TOO_LARGE\)/);
  });

  it('the details of a many-key conflict stay under 256 KiB, later entries marked value_omitted', async () => {
    const chunk = 'x'.repeat(60000);
    const ops = Array.from({ length: 8 }, (_, i) => ({ op: 'put', key: `big${i}`, value: chunk, expected_version: 0 }));
    await ok(s.alice.token, 'echo_data_batch', { project: 'core', ops });
    const r = await mcpCall(s.bob.token, 'echo_data_batch', { project: 'core', ops: ops.map((o) => ({ ...o, value: 'bob' })) });
    const details = JSON.parse(r.text.split('\nDetails: ')[1]!);
    expect(new TextEncoder().encode(JSON.stringify(details)).length).toBeLessThanOrEqual(256 * 1024);
    const omitted = details.conflicts.filter((c: any) => c.value_omitted);
    expect(omitted.length).toBeGreaterThan(0);
    expect(omitted.every((c: any) => !('value' in c) && c.version === 1)).toBe(true);
    expect(details.conflicts.length).toBe(8);
  });
});

describe('data tools: values arrive as sent', () => {
  it('keeps a "__proto__" key instead of silently dropping it', async () => {
    const r = await mcpCall(s.alice.token, 'echo_data_put', JSON.parse('{"project":"core","key":"p","value":{"__proto__":{"a":1},"b":2},"expected_version":0}'));
    expect(r.isError).toBeFalsy();
    const got = await ok(s.bob.token, 'echo_data_get', { project: 'core', key: 'p' });
    expect(Object.getOwnPropertyNames(got.value).sort()).toEqual(['__proto__', 'b']);
    expect(JSON.stringify(got.value)).toBe('{"__proto__":{"a":1},"b":2}');
  });

  it('refuses very deep values as VALUE_TOO_DEEP, never as an internal error', async () => {
    for (const depth of [33, 1000, 5000]) {
      const body = `{"project":"core","key":"d","value":${'['.repeat(depth)}1${']'.repeat(depth)},"expected_version":0}`;
      const r = await mcpCall(s.alice.token, 'echo_data_put', JSON.parse(body));
      expect(r.text, String(depth)).toMatch(/^Refused \(rule VALUE_TOO_DEEP\)/);
    }
    expect((await mcpCall(s.alice.token, 'echo_data_list', { project: 'core' })).text).toBe('{"entries":[]}');
  });

  it('the details cap holds even when full entries nearly fill it', async () => {
    const mk = (n: number) => 'x'.repeat(n);
    const ops = [
      ...Array.from({ length: 4 }, (_, i) => ({ op: 'put', key: `big${i}`, value: mk(65250), expected_version: 0 })),
      ...Array.from({ length: 21 }, (_, i) => ({ op: 'put', key: `small${String(i).padStart(2, '0')}`, value: 1, expected_version: 0 })),
    ];
    await ok(s.alice.token, 'echo_data_batch', { project: 'core', ops: ops.slice(0, 4) });
    await ok(s.alice.token, 'echo_data_batch', { project: 'core', ops: ops.slice(4) });
    const r = await mcpCall(s.bob.token, 'echo_data_batch', { project: 'core', ops: ops.map((o) => ({ ...o, value: 'bob' })) });
    const details = JSON.parse(r.text.split('\nDetails: ')[1]!);
    expect(details.conflicts).toHaveLength(25);
    const n = new TextEncoder().encode(JSON.stringify(details)).length;
    expect(n, `details were ${n} bytes`).toBeLessThanOrEqual(256 * 1024);
  });
});

