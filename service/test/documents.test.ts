import { beforeEach, describe, expect, it } from 'vitest';
import { changesSince } from '../src/domain/changelog';
import {
  adminDeleteDocument,
  DOC_VERSIONS_KEPT,
  getDocument,
  listDocuments,
  listVersions,
  MAX_DOCUMENT_BYTES,
  saveDocument,
} from '../src/domain/documents';
import { appendScratchpad } from '../src/domain/scratchpad';
import { seed, testCtx } from './helpers';
import { mcpCall } from './mcp-client';

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

const save = (name: string, content: string, format: 'json' | 'markdown' = 'markdown', actor = s.aliceA) =>
  saveDocument(ctx, actor, { projectId: pid, name, format, content });

async function ok(token: string, tool: string, args: unknown): Promise<any> {
  const r = await mcpCall(token, tool, args);
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.text);
}

describe('documents', () => {
  it('saving an existing name creates version 2 and keeps version 1', async () => {
    expect(await save('plan.md', 'first')).toEqual({ name: 'plan.md', version: 1 });
    ctx.setNow('2026-11-18T21:00:00.000Z');
    expect(await save('plan.md', 'second', 'markdown', s.bobA)).toEqual({ name: 'plan.md', version: 2 });
    const v1 = await getDocument(ctx, s.aliceA, pid, 'plan.md', 1);
    expect(v1.content).toBe('first');
    expect(v1.savedBy).toBe('Alice');
    const latest = await getDocument(ctx, s.aliceA, pid, 'plan.md');
    expect([latest.version, latest.content, latest.savedBy, latest.createdAt]).toEqual([2, 'second', 'Bob', '2026-11-18T21:00:00.000Z']);
    const vs = await listVersions(ctx, s.aliceA, pid, 'plan.md');
    expect(vs.map((v) => v.version)).toEqual([1, 2]);
    expect(vs[0]).not.toHaveProperty('content');
  });

  it('the 51st save deletes version 1 and keeps 2..51', async () => {
    expect(DOC_VERSIONS_KEPT).toBe(50);
    for (let i = 1; i <= 51; i++) await save('rolling', `v${i}`);
    const vs = await listVersions(ctx, s.aliceA, pid, 'rolling');
    expect(vs.map((v) => v.version)).toEqual(Array.from({ length: 50 }, (_, i) => i + 2));
    const gone = await refused(getDocument(ctx, s.aliceA, pid, 'rolling', 1));
    expect(gone.code).toBe('VERSION_NOT_FOUND');
    expect((await getDocument(ctx, s.aliceA, pid, 'rolling')).version).toBe(51);
    // another document is untouched by this one's retention
    await save('other', 'x');
    expect((await listVersions(ctx, s.aliceA, pid, 'other')).map((v) => v.version)).toEqual([1]);
  });

  it('a document of exactly 1048576 bytes saves; 1048577 is refused naming both sizes', async () => {
    expect(MAX_DOCUMENT_BYTES).toBe(1048576);
    expect(await save('big', 'x'.repeat(1048576))).toEqual({ name: 'big', version: 1 });
    const r = await refused(save('big', 'x'.repeat(1048577)));
    expect(r.code).toBe('DOCUMENT_TOO_LARGE');
    expect(r.fix).toContain('1048577');
    expect(r.fix).toContain('1048576');
    expect((await listVersions(ctx, s.aliceA, pid, 'big')).map((v) => v.version)).toEqual([1]);
    expect((await getDocument(ctx, s.aliceA, pid, 'big')).content).toHaveLength(1048576);
    // size is UTF-8 bytes, not characters: 524288 two-byte characters is exactly the limit, one more byte is over
    expect(await save('big2', 'é'.repeat(524288))).toEqual({ name: 'big2', version: 1 });
    expect((await refused(save('big2', 'é'.repeat(524288) + 'x'))).code).toBe('DOCUMENT_TOO_LARGE');
  });

  it('invalid JSON is refused with the parser message; valid JSON is stored exactly as given', async () => {
    const r = await refused(save('cfg.json', '{"a": 1,}', 'json'));
    expect(r.code).toBe('INVALID_JSON');
    let parserMsg = '';
    try {
      JSON.parse('{"a": 1,}');
    } catch (e: any) {
      parserMsg = e.message;
    }
    expect(parserMsg).not.toBe('');
    expect(r.message + r.fix).toContain(parserMsg);
    await expect(listVersions(ctx, s.aliceA, pid, 'cfg.json')).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
    const raw = '{ "a":1,\n  "b" : [1, 2] }';
    await save('cfg.json', raw, 'json');
    expect((await getDocument(ctx, s.aliceA, pid, 'cfg.json')).content).toBe(raw);
  });

  it('refuses bad names and a change of format between versions', async () => {
    for (const bad of ['', 'a b', 'a/b', '../x', 'x'.repeat(101)]) {
      expect((await refused(save(bad, 'x'))).code).toBe('BAD_NAME');
    }
    expect(await save('x'.repeat(100), 'ok')).toMatchObject({ version: 1 });
    await save('fmt', '# hi', 'markdown');
    const r = await refused(save('fmt', '{}', 'json'));
    expect(r.code).toBe('FORMAT_CHANGED');
    expect((await listVersions(ctx, s.aliceA, pid, 'fmt')).map((v) => v.version)).toEqual([1]);
    const saved = (await changesSince(ctx, pid, 0)).filter((c) => c.kind === 'document.saved' && c.subjectId === 'fmt');
    expect(saved).toHaveLength(1);
  });

  /** A ctx whose db.batch throws `failures` times (with the given error) before behaving normally. */
  function flakyCtx(failures: number, error: Error) {
    let calls = 0;
    const db = new Proxy(ctx.db, {
      get(target, prop) {
        if (prop === 'batch') {
          return (stmts: D1PreparedStatement[]) => {
            calls++;
            if (calls <= failures) return Promise.reject(error);
            return target.batch(stmts);
          };
        }
        const v = (target as any)[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    return { ctx: { ...ctx, db } as typeof ctx, calls: () => calls };
  }
  const UNIQUE = 'UNIQUE constraint failed: documents.project_id, documents.name, documents.version';

  it('a real primary-key conflict from D1 is recognised as a conflict', async () => {
    await save('dup', 'x');
    let text = '';
    try {
      await ctx.db
        .prepare(`INSERT INTO documents (project_id, name, version, format, content, saved_by, created_at) VALUES (?,?,?,?,?,?,?)`)
        .bind(pid, 'dup', 1, 'markdown', 'y', 'Alice', ctx.now())
        .run();
    } catch (e: any) {
      text = `${e.message} ${e.cause ?? ''}`;
    }
    expect(text).toMatch(/UNIQUE constraint failed|PRIMARY KEY/i);
  });

  it('a primary-key conflict on the first attempt is retried once and succeeds', async () => {
    const f = flakyCtx(1, new Error(UNIQUE));
    const r = await saveDocument(f.ctx, s.aliceA, { projectId: pid, name: 'retry', format: 'markdown', content: 'x' });
    expect(r).toEqual({ name: 'retry', version: 1 });
    expect(f.calls()).toBe(2);
    expect((await getDocument(ctx, s.aliceA, pid, 'retry')).content).toBe('x');
  });

  it('two conflicts in a row are refused as the service error DOCUMENT_SAVE_CONFLICT, saving nothing', async () => {
    const f = flakyCtx(2, new Error(UNIQUE));
    const e: any = await saveDocument(f.ctx, s.aliceA, { projectId: pid, name: 'lost', format: 'markdown', content: 'x' }).catch((x) => x);
    expect([e.kind, e.code]).toEqual(['service', 'DOCUMENT_SAVE_CONFLICT']);
    expect(f.calls()).toBe(2);
    expect((await refused(getDocument(ctx, s.aliceA, pid, 'lost'))).code).toBe('DOCUMENT_NOT_FOUND');
  });

  it('other database errors (CHECK, FOREIGN KEY) are not retried', async () => {
    const f = flakyCtx(1, new Error('CHECK constraint failed: format IN (json, markdown)'));
    await expect(saveDocument(f.ctx, s.aliceA, { projectId: pid, name: 'chk', format: 'markdown', content: 'x' })).rejects.toThrow(/CHECK/);
    expect(f.calls()).toBe(1);
  });

  it('two simultaneous saves of the same name get distinct versions 1 and 2', async () => {
    const res = await Promise.all([save('race', 'from alice'), save('race', 'from bob', 'markdown', s.bobA)]);
    expect(res.map((r) => r.version).sort()).toEqual([1, 2]);
    const vs = await listVersions(ctx, s.aliceA, pid, 'race');
    expect(vs.map((v) => v.version)).toEqual([1, 2]);
    const content = ['from alice', 'from bob'];
    for (let i = 0; i < 2; i++) expect((await getDocument(ctx, s.aliceA, pid, 'race', res[i].version)).content).toBe(content[i]);
    const saved = (await changesSince(ctx, pid, 0)).filter((c) => c.kind === 'document.saved');
    expect(saved).toHaveLength(2);
  });

  it('lists documents without content; unknown names are DOCUMENT_NOT_FOUND', async () => {
    await save('a', 'one');
    await save('a', 'two');
    await save('b.json', '{}', 'json', s.bobA);
    const list = await listDocuments(ctx, s.aliceA, pid);
    expect(list.map((d) => [d.name, d.format, d.version, d.savedBy])).toEqual([
      ['a', 'markdown', 2, 'Alice'],
      ['b.json', 'json', 1, 'Bob'],
    ]);
    expect(list.every((d) => !('content' in d) && d.createdAt === ctx.now())).toBe(true);
    expect((await refused(getDocument(ctx, s.aliceA, pid, 'nope'))).code).toBe('DOCUMENT_NOT_FOUND');
    expect((await refused(getDocument(ctx, s.aliceA, pid, 'a', 9))).code).toBe('VERSION_NOT_FOUND');
  });

  it('only members can use documents', async () => {
    await save('secret', 'x');
    expect((await refused(getDocument(ctx, s.carolA, pid, 'secret'))).code).toBe('NOT_MEMBER');
    expect((await refused(save('n', 'x', 'markdown', s.carolA))).code).toBe('NOT_MEMBER');
    expect((await refused(listDocuments(ctx, s.carolA, pid))).code).toBe('NOT_MEMBER');
  });

  it('admin delete removes every version and records document.deleted', async () => {
    await save('gone', 'a');
    await save('gone', 'b');
    await adminDeleteDocument(ctx, pid, 'gone');
    expect(await listDocuments(ctx, s.aliceA, pid)).toEqual([]);
    expect((await refused(getDocument(ctx, s.aliceA, pid, 'gone'))).code).toBe('DOCUMENT_NOT_FOUND');
    expect((await refused(adminDeleteDocument(ctx, pid, 'gone'))).code).toBe('DOCUMENT_NOT_FOUND');
    const kinds = (await changesSince(ctx, pid, 0)).map((c) => c.kind);
    expect(kinds).toEqual(['document.saved', 'document.saved', 'document.deleted']);
  });

  it('records document.saved with the saver and the document name', async () => {
    await save('n', 'x', 'markdown', s.bobA);
    const [c] = await changesSince(ctx, pid, 0);
    expect([c.kind, c.actor, c.subjectId]).toEqual(['document.saved', 'Bob', 'n']);
  });
});

describe('document and changes tools over MCP', () => {
  it('saves, gets (latest and by version), lists and lists versions', async () => {
    expect(await ok(s.alice.token, 'echo_doc_save', { project: 'core', name: 'spec.md', format: 'markdown', content: 'v1' })).toEqual({
      name: 'spec.md',
      version: 1,
    });
    await ok(s.bob.token, 'echo_doc_save', { project: 'core', name: 'spec.md', format: 'markdown', content: 'v2' });
    const latest = await ok(s.alice.token, 'echo_doc_get', { project: 'core', name: 'spec.md' });
    expect([latest.version, latest.content, latest.saved_by]).toEqual([2, 'v2', 'Bob']);
    const old = await ok(s.alice.token, 'echo_doc_get', { project: 'core', name: 'spec.md', version: 1 });
    expect([old.version, old.content, old.format]).toEqual([1, 'v1', 'markdown']);
    const list = await ok(s.bob.token, 'echo_doc_list', { project: 'core' });
    expect(list.documents).toEqual([{ name: 'spec.md', format: 'markdown', version: 2, saved_by: 'Bob', created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/) }]);
    const vs = await ok(s.bob.token, 'echo_doc_versions', { project: 'core', name: 'spec.md' });
    expect(vs.versions.map((v: any) => [v.version, v.saved_by])).toEqual([[1, 'Alice'], [2, 'Bob']]);
    const bad = await mcpCall(s.carol.token, 'echo_doc_get', { project: 'core', name: 'spec.md' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('NOT_MEMBER');
    const nf = await mcpCall(s.alice.token, 'echo_doc_get', { project: 'core', name: 'nope' });
    expect(nf.text).toContain('DOCUMENT_NOT_FOUND');
  });

  it('changes_since returns entries after since_seq for that project only, with next_seq', async () => {
    await appendScratchpad(ctx, s.carolA, s.other.id, 'elsewhere');
    await save('d', 'x');
    await appendScratchpad(ctx, s.bobA, pid, 'note');
    const all = await ok(s.alice.token, 'echo_changes_since', { project: 'core', since_seq: 0 });
    expect(all.changes.map((c: any) => [c.kind, c.actor])).toEqual([['document.saved', 'Alice'], ['scratchpad.appended', 'Bob']]);
    expect(all.next_seq).toBe(all.changes[1].seq);
    const rest = await ok(s.alice.token, 'echo_changes_since', { project: 'core', since_seq: all.changes[0].seq });
    expect(rest.changes.map((c: any) => c.kind)).toEqual(['scratchpad.appended']);
    const none = await ok(s.alice.token, 'echo_changes_since', { project: 'core', since_seq: all.next_seq });
    expect(none).toEqual({ changes: [], next_seq: all.next_seq });
    const page = await ok(s.alice.token, 'echo_changes_since', { project: 'core', since_seq: 0, limit: 1 });
    expect(page.changes).toHaveLength(1);
    expect(page.next_seq).toBe(page.changes[0].seq);
    const tooBig = await mcpCall(s.alice.token, 'echo_changes_since', { project: 'core', since_seq: 0, limit: 501 });
    expect(tooBig.isError).toBe(true);
    expect(tooBig.text).toContain('BAD_LIMIT');
    const notMine = await mcpCall(s.carol.token, 'echo_changes_since', { project: 'core', since_seq: 0 });
    expect(notMine.text).toContain('NOT_MEMBER');
  });
});
