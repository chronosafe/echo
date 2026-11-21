import { beforeEach, describe, expect, it } from 'vitest';
import { changesSince } from '../src/domain/changelog';
import { MAX_MESSAGE_BYTES } from '../src/domain/messages';
import { adminClearScratchpad, adminEditEntry, appendScratchpad, readScratchpad } from '../src/domain/scratchpad';
import { addTodo, adminDeleteTodo, adminEditTodo, adminClearTodoClaim, claimTodo, completeTodo, listTodos, releaseTodo } from '../src/domain/todos';
import { seed, testCtx } from './helpers';
import { mcpCall, mcpRaw } from './mcp-client';

const ctx = testCtx();
let s: Awaited<ReturnType<typeof seed>>;
let pid: number;

beforeEach(async () => {
  ctx.setNow('2026-11-18T20:00:00.000Z');
  s = await seed(ctx);
  pid = s.project.id;
});

async function refused(p: Promise<unknown>): Promise<{ code: string; message: string; fix: string }> {
  try {
    await p;
  } catch (e: any) {
    return { code: e.code, message: e.message, fix: e.fix };
  }
  throw new Error('expected a refusal');
}

async function ok(token: string, tool: string, args: unknown): Promise<any> {
  const r = await mcpCall(token, tool, args);
  if (r.isError) throw new Error(`${tool} refused: ${r.text}`);
  return JSON.parse(r.text);
}

describe('scratchpad', () => {
  it('two simultaneous appends are both kept, in id order, stamped by the server', async () => {
    await Promise.all([appendScratchpad(ctx, s.aliceA, pid, 'one'), appendScratchpad(ctx, s.bobA, pid, 'two')]);
    const e = await readScratchpad(ctx, s.aliceA, pid, {});
    expect(e.map((x) => x.body).sort()).toEqual(['one', 'two']);
    expect(e[0].id).toBeLessThan(e[1].id);
    expect(e.every((x) => x.createdAt === ctx.now())).toBe(true);
    expect(e.map((x) => x.author).sort()).toEqual(['Alice', 'Bob']);
  });

  it('entry times never go backwards in id order, even when a later-stamped append commits first', async () => {
    // On Cloudflare two requests stamp their time and then commit in either order; simulate the later stamp
    // committing first. Each project's times stay in id order; another project's later entry does not move them.
    ctx.setNow('2026-11-18T20:00:01.000Z');
    const first = await appendScratchpad(ctx, s.aliceA, pid, 'stamped later, committed first');
    ctx.setNow('2026-11-18T20:00:09.000Z');
    await appendScratchpad(ctx, s.carolA, s.other.id, 'elsewhere, much later');
    ctx.setNow('2026-11-18T20:00:00.500Z');
    const second = await appendScratchpad(ctx, s.bobA, pid, 'stamped earlier, committed second');
    expect(second.id).toBeGreaterThan(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    ctx.setNow('2026-11-18T20:00:02.000Z');
    const third = await appendScratchpad(ctx, s.aliceA, pid, 'normal');
    expect(third.createdAt).toBe('2026-11-18T20:00:02.000Z');
  });

  it('refuses an entry over the limit naming both sizes, and accepts one exactly at it', async () => {
    await appendScratchpad(ctx, s.aliceA, pid, 'x'.repeat(MAX_MESSAGE_BYTES));
    const r = await refused(appendScratchpad(ctx, s.aliceA, pid, 'é'.repeat(MAX_MESSAGE_BYTES / 2 + 1)));
    expect(r.code).toBe('ENTRY_TOO_LARGE');
    expect(r.fix).toContain(String(MAX_MESSAGE_BYTES + 2));
    expect(r.fix).toContain(String(MAX_MESSAGE_BYTES));
    expect(await readScratchpad(ctx, s.aliceA, pid, {})).toHaveLength(1);
  });

  it('reads in id order with afterId exclusive and a bounded limit', async () => {
    for (let i = 1; i <= 5; i++) await appendScratchpad(ctx, s.aliceA, pid, `e${i}`);
    const all = await readScratchpad(ctx, s.bobA, pid, {});
    expect(all.map((x) => x.body)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    const page = await readScratchpad(ctx, s.bobA, pid, { afterId: all[1].id, limit: 2 });
    expect(page.map((x) => x.body)).toEqual(['e3', 'e4']);
    expect(await readScratchpad(ctx, s.bobA, pid, { limit: 500 })).toHaveLength(5);
    expect((await refused(readScratchpad(ctx, s.bobA, pid, { limit: 0 }))).code).toBe('BAD_LIMIT');
    expect((await refused(readScratchpad(ctx, s.bobA, pid, { limit: 501 }))).code).toBe('BAD_LIMIT');
  });

  it('refuses non-members for append and read', async () => {
    expect((await refused(appendScratchpad(ctx, s.carolA, pid, 'hi'))).code).toBe('NOT_MEMBER');
    expect((await refused(readScratchpad(ctx, s.carolA, pid, {}))).code).toBe('NOT_MEMBER');
  });

  it('the owner can edit an entry and clear the pad, and both are logged', async () => {
    const e = await appendScratchpad(ctx, s.aliceA, pid, 'draft');
    ctx.setNow('2026-11-18T20:05:00.000Z');
    await adminEditEntry(ctx, e.id, 'fixed');
    const [after] = await readScratchpad(ctx, s.aliceA, pid, {});
    expect(after.body).toBe('fixed');
    expect(after.editedAt).toBe('2026-11-18T20:05:00.000Z');
    expect((await refused(adminEditEntry(ctx, 9999, 'x'))).code).toBe('NO_SUCH_ENTRY');
    await adminClearScratchpad(ctx, pid);
    expect(await readScratchpad(ctx, s.aliceA, pid, {})).toEqual([]);
    const kinds = (await changesSince(ctx, pid, 0)).map((c) => c.kind);
    expect(kinds).toEqual(['scratchpad.appended', 'scratchpad.edited', 'scratchpad.cleared']);
  });

  it('each scratchpad.appended entry names the entry it appended', async () => {
    const a = await appendScratchpad(ctx, s.aliceA, pid, 'one');
    await appendScratchpad(ctx, s.carolA, s.other.id, 'elsewhere');
    const b = await appendScratchpad(ctx, s.bobA, pid, 'two');
    const appended = (await changesSince(ctx, pid, 0)).filter((c) => c.kind === 'scratchpad.appended');
    expect(appended.map((c) => [c.actor, c.subjectId])).toEqual([
      ['Alice', a.id],
      ['Bob', b.id],
    ]);
  });

  it('the MCP tool list has no scratchpad edit or delete tool', async () => {
    const { json } = await mcpRaw(s.alice.token, 'tools/list', {});
    const names: string[] = json.result.tools.map((t: { name: string }) => t.name);
    expect(names.filter((n) => n.includes('scratchpad')).sort()).toEqual(['echo_scratchpad_append', 'echo_scratchpad_read']);
    expect(names.some((n) => /scratch/.test(n) && /(edit|delete|clear|remove|update)/.test(n))).toBe(false);
  });

  it('appends and reads over MCP, refusing a project the agent is not in', async () => {
    await ok(s.alice.token, 'echo_scratchpad_append', { project: 'core', body: 'hello' });
    const r = await ok(s.bob.token, 'echo_scratchpad_read', { project: 'core' });
    expect(r.entries.map((x: any) => [x.author, x.body])).toEqual([['Alice', 'hello']]);
    const bad = await mcpCall(s.carol.token, 'echo_scratchpad_read', { project: 'core' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('NOT_MEMBER');
  });
});

describe('to-dos', () => {
  it('claiming a claimed to-do names the current claimer', async () => {
    const t = await addTodo(ctx, s.aliceA, pid, 'write docs');
    await claimTodo(ctx, s.aliceA, t.id);
    const r = await refused(claimTodo(ctx, s.bobA, t.id));
    expect(r.code).toBe('ALREADY_CLAIMED');
    expect(r.message).toContain('Alice');
    const [row] = await listTodos(ctx, s.bobA, pid, {});
    expect(row.claimedBy).toBe('Alice');
  });

  it('two simultaneous claims: exactly one wins', async () => {
    const t = await addTodo(ctx, s.aliceA, pid, 'race');
    const res = await Promise.allSettled([claimTodo(ctx, s.aliceA, t.id), claimTodo(ctx, s.bobA, t.id)]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason.code).toBe('ALREADY_CLAIMED');
    const claims = (await changesSince(ctx, pid, 0)).filter((c) => c.kind === 'todo.claimed');
    expect(claims).toHaveLength(1);
  });

  it('adds with who and when, lists open by default and done on request', async () => {
    const a = await addTodo(ctx, s.aliceA, pid, 'a');
    const b = await addTodo(ctx, s.bobA, pid, 'b');
    expect(a).toMatchObject({ title: 'a', addedBy: 'Alice', createdAt: ctx.now(), claimedBy: null, doneAt: null });
    ctx.setNow('2026-11-18T21:00:00.000Z');
    await completeTodo(ctx, s.bobA, a.id);
    expect((await listTodos(ctx, s.aliceA, pid, {})).map((t) => t.id)).toEqual([b.id]);
    const all = await listTodos(ctx, s.aliceA, pid, { includeDone: true });
    expect(all.map((t) => t.id)).toEqual([a.id, b.id]);
    expect(all[0].doneAt).toBe('2026-11-18T21:00:00.000Z');
  });

  it('completing records who did it, any member may, and a done to-do cannot be claimed or completed again', async () => {
    const t = await addTodo(ctx, s.aliceA, pid, 'ship');
    await claimTodo(ctx, s.aliceA, t.id);
    await completeTodo(ctx, s.bobA, t.id);
    const done = (await changesSince(ctx, pid, 0)).find((c) => c.kind === 'todo.completed')!;
    expect(done.actor).toBe('Bob');
    expect((await refused(claimTodo(ctx, s.bobA, t.id))).code).toBe('TODO_DONE');
    expect((await refused(completeTodo(ctx, s.aliceA, t.id))).code).toBe('TODO_DONE');
  });

  it('refuses non-members and unknown ids, and rejects an empty title', async () => {
    const t = await addTodo(ctx, s.aliceA, pid, 'x');
    expect((await refused(addTodo(ctx, s.carolA, pid, 'y'))).code).toBe('NOT_MEMBER');
    expect((await refused(listTodos(ctx, s.carolA, pid, {}))).code).toBe('NOT_MEMBER');
    expect((await refused(claimTodo(ctx, s.carolA, t.id))).code).toBe('NOT_MEMBER');
    expect((await refused(completeTodo(ctx, s.carolA, t.id))).code).toBe('NOT_MEMBER');
    expect((await refused(claimTodo(ctx, s.aliceA, 9999))).code).toBe('NO_SUCH_TODO');
    expect((await refused(addTodo(ctx, s.aliceA, pid, '  '))).code).toBe('BAD_TITLE');
  });

  it('to-do titles are capped at 8,192 bytes, when added and when the owner edits one', async () => {
    const max = 'é'.repeat(MAX_MESSAGE_BYTES / 2);
    const t = await addTodo(ctx, s.aliceA, pid, max);
    expect(t.title).toBe(max);
    const tooLong = refused(addTodo(ctx, s.aliceA, pid, max + 'x'));
    expect(await tooLong).toMatchObject({ code: 'TITLE_TOO_LARGE', message: expect.stringContaining('8193 bytes') });
    expect((await tooLong).fix).toContain('document');
    expect((await refused(adminEditTodo(ctx, t.id, max + 'x'))).code).toBe('TITLE_TOO_LARGE');
    expect((await listTodos(ctx, s.aliceA, pid, {})).map((x) => x.title)).toEqual([max]);
  });

  it('the owner can edit and delete a to-do, both logged', async () => {
    const t = await addTodo(ctx, s.aliceA, pid, 'old');
    await adminEditTodo(ctx, t.id, 'new');
    expect((await listTodos(ctx, s.aliceA, pid, {}))[0].title).toBe('new');
    await adminDeleteTodo(ctx, t.id);
    expect(await listTodos(ctx, s.aliceA, pid, { includeDone: true })).toEqual([]);
    expect((await refused(adminDeleteTodo(ctx, t.id))).code).toBe('NO_SUCH_TODO');
    expect((await changesSince(ctx, pid, 0)).map((c) => [c.kind, c.actor])).toEqual([
      ['todo.added', 'Alice'],
      ['todo.edited', 'admin'],
      ['todo.deleted', 'admin'],
    ]);
  });

  it('works over MCP: add, list, claim, complete, and a second claim is refused naming the claimer', async () => {
    const added = await ok(s.alice.token, 'echo_todo_add', { project: 'core', title: 'review' });
    await ok(s.alice.token, 'echo_todo_claim', { todo_id: added.todo_id });
    const dup = await mcpCall(s.bob.token, 'echo_todo_claim', { todo_id: added.todo_id });
    expect(dup.isError).toBe(true);
    expect(dup.text).toContain('ALREADY_CLAIMED');
    expect(dup.text).toContain('Alice');
    const list = await ok(s.bob.token, 'echo_todo_list', { project: 'core' });
    expect(list.todos[0]).toMatchObject({ title: 'review', claimed_by: 'Alice', added_by: 'Alice' });
    await ok(s.bob.token, 'echo_todo_complete', { todo_id: added.todo_id });
    expect((await ok(s.bob.token, 'echo_todo_list', { project: 'core' })).todos).toEqual([]);
    expect((await ok(s.bob.token, 'echo_todo_list', { project: 'core', include_done: true })).todos).toHaveLength(1);
    const bad = await mcpCall(s.alice.token, 'echo_todo_add', { project: 'core', title: 'x', extra: 1 });
    expect(bad.text).toContain('BAD_REQUEST');
  });

  it('the claimer releases a to-do; it is unclaimed, logged, and another agent can claim it', async () => {
    const t = await addTodo(ctx, s.aliceA, pid, 'handover');
    await claimTodo(ctx, s.bobA, t.id);
    const r = await releaseTodo(ctx, s.bobA, t.id);
    expect(r).toMatchObject({ claimedBy: null, claimedAt: null });
    const rel = (await changesSince(ctx, pid, 0)).filter((c) => c.kind === 'todo.released');
    expect(rel.map((c) => [c.actor, c.subjectId])).toEqual([['Bob', t.id]]);
    expect((await claimTodo(ctx, s.aliceA, t.id)).claimedBy).toBe('Alice');
  });

  it('a non-claimer cannot release: NOT_CLAIMER names the claimer, nothing changes or is logged', async () => {
    const t = await addTodo(ctx, s.aliceA, pid, 'mine');
    await claimTodo(ctx, s.aliceA, t.id);
    const r = await refused(releaseTodo(ctx, s.bobA, t.id));
    expect(r.code).toBe('NOT_CLAIMER');
    expect(r.message).toContain('Alice');
    expect((await listTodos(ctx, s.bobA, pid, {}))[0].claimedBy).toBe('Alice');
    expect((await changesSince(ctx, pid, 0)).filter((c) => c.kind === 'todo.released')).toEqual([]);
  });

  it('releasing an unclaimed to-do gives TODO_NOT_CLAIMED and a done one TODO_DONE; nothing is logged', async () => {
    const open = await addTodo(ctx, s.aliceA, pid, 'open');
    expect((await refused(releaseTodo(ctx, s.aliceA, open.id))).code).toBe('TODO_NOT_CLAIMED');
    expect(await listTodos(ctx, s.aliceA, pid, {})).toEqual([open]);
    const done = await addTodo(ctx, s.aliceA, pid, 'done');
    await claimTodo(ctx, s.aliceA, done.id);
    await completeTodo(ctx, s.aliceA, done.id);
    const doneRow = (await listTodos(ctx, s.aliceA, pid, { includeDone: true })).find((x) => x.id === done.id)!;
    expect((await refused(releaseTodo(ctx, s.aliceA, done.id))).code).toBe('TODO_DONE');
    expect((await listTodos(ctx, s.aliceA, pid, { includeDone: true })).find((x) => x.id === done.id)).toEqual(doneRow);
    expect(doneRow.claimedBy).toBe('Alice');
    expect((await changesSince(ctx, pid, 0)).filter((c) => c.kind === 'todo.released')).toEqual([]);
  });

  it('release by a non-member is NOT_MEMBER, and an unknown to-do is NO_SUCH_TODO', async () => {
    const t = await addTodo(ctx, s.aliceA, pid, 'x');
    await claimTodo(ctx, s.aliceA, t.id);
    expect((await refused(releaseTodo(ctx, s.carolA, t.id))).code).toBe('NOT_MEMBER');
    expect((await refused(releaseTodo(ctx, s.aliceA, 9999))).code).toBe('NO_SUCH_TODO');
  });

  it('admin clears a claim, logged with actor admin and the old claimer; unclaimed or done is refused', async () => {
    const t = await addTodo(ctx, s.aliceA, pid, 'stuck');
    expect((await refused(adminClearTodoClaim(ctx, t.id))).code).toBe('TODO_NOT_CLAIMED');
    expect((await changesSince(ctx, pid, 0)).filter((c) => c.kind === 'todo.released')).toEqual([]);
    await claimTodo(ctx, s.bobA, t.id);
    await adminClearTodoClaim(ctx, t.id);
    expect((await listTodos(ctx, s.aliceA, pid, {}))[0].claimedBy).toBeNull();
    const rel = (await changesSince(ctx, pid, 0)).find((c) => c.kind === 'todo.released')!;
    expect(rel.actor).toBe('admin');
    expect(rel.data).toEqual({ claimedBy: 'Bob' });
    await claimTodo(ctx, s.bobA, t.id);
    await completeTodo(ctx, s.bobA, t.id);
    expect((await refused(adminClearTodoClaim(ctx, t.id))).code).toBe('TODO_DONE');
    expect((await changesSince(ctx, pid, 0)).filter((c) => c.kind === 'todo.released')).toHaveLength(1);
    expect((await listTodos(ctx, s.aliceA, pid, { includeDone: true }))[0].claimedBy).toBe('Bob');
  });

  it('admin clear-claim and edit refuse a to-do of another project (404) and change nothing', async () => {
    const t = await addTodo(ctx, s.carolA, s.other.id, 'theirs');
    await claimTodo(ctx, s.carolA, t.id);
    expect((await refused(adminClearTodoClaim(ctx, t.id, pid))).code).toBe('NO_SUCH_TODO');
    expect((await refused(adminEditTodo(ctx, t.id, 'x', pid))).code).toBe('NO_SUCH_TODO');
    expect((await refused(adminDeleteTodo(ctx, t.id, pid))).code).toBe('NO_SUCH_TODO');
    expect((await listTodos(ctx, s.carolA, s.other.id, {}))[0]).toMatchObject({ title: 'theirs', claimedBy: 'Carol' });
    expect((await changesSince(ctx, s.other.id, 0)).map((c) => c.kind)).not.toContain('todo.released');
  });

  it('works over MCP: echo_todo_release by the claimer, refused for others', async () => {
    const added = await ok(s.alice.token, 'echo_todo_add', { project: 'core', title: 'swap' });
    await ok(s.bob.token, 'echo_todo_claim', { todo_id: added.todo_id });
    const no = await mcpCall(s.alice.token, 'echo_todo_release', { todo_id: added.todo_id });
    expect(no.isError).toBe(true);
    expect(no.text).toContain('NOT_CLAIMER');
    expect(no.text).toContain('Bob');
    const rel = await ok(s.bob.token, 'echo_todo_release', { todo_id: added.todo_id });
    expect(rel).toMatchObject({ id: added.todo_id, claimed_by: null });
    expect((await ok(s.alice.token, 'echo_todo_claim', { todo_id: added.todo_id })).claimed_by).toBe('Alice');
    const dup = await mcpCall(s.bob.token, 'echo_todo_claim', { todo_id: added.todo_id });
    expect(dup.text).toMatch(/release/i);
  });
});
