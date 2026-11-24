import type { Ctx } from '../ctx';
import { EchoError, ruleError, serviceError } from '../errors';
import type { Actor } from '../types';
import { actorLabel } from '../types';
import { MAX_MESSAGE_BYTES, REQUEST_ID_PATTERN, newMessageStmts } from './messages';
import { requireMember } from './projects';

// Shared data: versioned key/value entries.
//
// Every write goes through applyWrites(). Its statements run in ONE db.batch() (one transaction). Per write op:
//   1. the guarded entry write (UPDATE .. WHERE version = ? .., or INSERT .. ON CONFLICT DO NOTHING),
//   2. the history insert, whose NOT NULL version is NULL when step 1 changed no row: that raises and rolls back the batch,
//   3. the change-log insert, guarded on changes() (the history insert just before it).
// `check` ops add a guard against data_guard before every write. A notification message goes last, guarded the same way.

export const MAX_VALUE_BYTES = 65536;
export const MAX_DEPTH = 32;
export const MAX_LIVE_KEYS = 2000;
export const MAX_OPS = 25;
export const MAX_BATCH_VALUE_BYTES = 512 * 1024;
export const MAX_NOTE_CHARS = 500;
export const DETAILS_CAP_BYTES = 256 * 1024;
export const RESPONSE_CAP_BYTES = 1024 * 1024;

const KEY_CHARS = /^[A-Za-z0-9._:/-]+$/;
const bytesOf = (s: string) => new TextEncoder().encode(s).length;

export type Entry = {
  key: string;
  version: number;
  value?: unknown;
  owner: string | null;
  updatedBy: string;
  updatedAt: string;
  note: string | null;
  deleted: boolean;
};

export type HistoryRow = {
  version: number;
  op: string;
  value?: unknown;
  owner: string | null;
  actor: string;
  at: string;
  note: string | null;
  batchId: string | null;
};

export type WriteOp =
  | { op: 'put'; key: string; value: unknown; expectedVersion: number; owner?: 'me' | null }
  | { op: 'delete'; key: string; expectedVersion: number }
  | { op: 'check'; key: string; expectedVersion: number }
  | { op: 'admin_release'; key: string; expectedVersion: number }
  | { op: 'admin_delete'; key: string; expectedVersion: number };

/** The operations an agent may send. */
export type AgentOp = Exclude<WriteOp, { op: 'admin_release' | 'admin_delete' }>;

export type WriteResult = { key: string; version: number };
export type WriteOutcome = { batchId: string | null; results: WriteResult[]; previous: Map<string, number>; duplicate?: boolean };

// ---------------------------------------------------------------- validation

export function checkKey(key: string): void {
  const bad = (why: string) =>
    ruleError(
      'BAD_KEY',
      `"${key.length > 60 ? key.slice(0, 60) + '...' : key}" is not a valid key: ${why}.`,
      'Use 1 to 200 characters from letters, digits, dot, underscore, colon, hyphen and slash, for example "rulings/cap.scope". No leading or trailing slash, no "//", and no segment that is "." or "..".',
    );
  if (key.length < 1 || key.length > 200) throw bad('it must be 1 to 200 characters');
  if (!KEY_CHARS.test(key)) throw bad('it has a character that is not allowed');
  if (key.startsWith('/') || key.endsWith('/')) throw bad('it starts or ends with a slash');
  if (key.includes('//')) throw bad('it has an empty segment ("//")');
  if (key.split('/').some((s) => s === '.' || s === '..')) throw bad('a segment is "." or ".."');
}

export function isValidKey(key: string): boolean {
  try {
    checkKey(key);
    return true;
  } catch {
    return false;
  }
}

function checkNote(note: string | undefined): void {
  if (note !== undefined && note.length > MAX_NOTE_CHARS) {
    throw ruleError('NOTE_TOO_LONG', `The note is ${note.length} characters; the limit is ${MAX_NOTE_CHARS}.`, `Shorten the note to ${MAX_NOTE_CHARS} characters or fewer.`);
  }
}

/** Nesting depth of a decoded JSON value, found without recursion and stopping once it passes the limit. */
export function depthExceeds(value: unknown, limit: number): boolean {
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length) {
    const [v, d] = stack.pop()!;
    if (typeof v !== 'object' || v === null) continue;
    if (d > limit) return true;
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, d + 1]);
  }
  return false;
}

/** True when the value holds a number JSON cannot carry (Infinity, NaN): JSON.stringify would silently write null. */
export function hasNonFinite(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return true;
    } else if (typeof v === 'object' && v !== null) {
      for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push(child);
    }
  }
  return false;
}

/** The stored text of a value, after the depth and size checks. */
export function serializeValue(value: unknown): string {
  if (depthExceeds(value, MAX_DEPTH)) {
    throw ruleError('VALUE_TOO_DEEP', `The value is nested more than ${MAX_DEPTH} levels deep.`, `Flatten it: use at most ${MAX_DEPTH} levels of arrays and objects, or split it into several keys.`);
  }
  if (hasNonFinite(value)) {
    throw ruleError('INVALID_JSON', 'The value holds a number JSON cannot represent (Infinity or NaN).', 'Use finite numbers only, or send the number as a string.');
  }
  const text = JSON.stringify(value);
  if (typeof text !== 'string') {
    throw ruleError('INVALID_JSON', 'The value is not JSON.', 'Send an object, array, string, number, boolean or null.');
  }
  const n = bytesOf(text);
  if (n > MAX_VALUE_BYTES) {
    throw ruleError('VALUE_TOO_LARGE', `The value is ${n} bytes; the limit is ${MAX_VALUE_BYTES}.`, 'Split it into several keys (for example one per evening or per ruling) or trim it.');
  }
  return text;
}

function checkRequestId(requestId: string | undefined): void {
  if (requestId !== undefined && !REQUEST_ID_PATTERN.test(requestId)) {
    throw ruleError('BAD_REQUEST_ID', 'request_id must be 1 to 64 characters from A-Z a-z 0-9 . _ : - .', 'Use a short id such as "book-evening-1", new for each distinct write.');
  }
}

async function authorize(ctx: Ctx, actor: Actor, projectId: number): Promise<void> {
  if (actor.kind === 'agent') await requireMember(ctx, actor.agentId, projectId);
}

// ---------------------------------------------------------------- reads

type EntryDb = {
  key: string;
  version: number;
  value?: string | null;
  owner: string | null;
  updated_by: string;
  updated_at: string;
  note: string | null;
  deleted: number;
  owner_active?: number;
  /** Set by the list query: 0 once the running size of the rows so far passes the response cap. */
  fits?: number;
};

function entryOf(r: EntryDb, withValue: boolean): Entry {
  const e: Entry = { key: r.key, version: r.version, owner: r.owner, updatedBy: r.updated_by, updatedAt: r.updated_at, note: r.note, deleted: r.deleted === 1 };
  if (withValue && r.value != null) e.value = JSON.parse(r.value);
  return e;
}

/** SQL for "this owner still counts": a member of the project who is not revoked (a lost owner is as good as released). */
const ownerActive = (o: string, project = '?1') =>
  `(${o} IS NOT NULL AND EXISTS (SELECT 1 FROM agents a JOIN project_agents pa ON pa.agent_id = a.id WHERE a.name = ${o} AND pa.project_id = ${project} AND a.revoked_at IS NULL))`;

const ENTRY_COLS = 'key, version, value, owner, updated_by, updated_at, note, deleted';

/** Entry as an object for the details of an error, or the "absent" shape. */
type State = { exists: boolean; row?: EntryDb; ownerActive: boolean };

async function readStates(ctx: Ctx, projectId: number, keys: string[]): Promise<{ states: Map<string, State>; live: number }> {
  const marks = keys.map(() => '?').join(',');
  const [rows, count] = await ctx.db.batch([
    ctx.db
      .prepare(`SELECT ${ENTRY_COLS}, ${ownerActive('e.owner', 'e.project_id')} AS owner_active FROM data_entries e WHERE e.project_id = ? AND e.key IN (${marks})`)
      .bind(projectId, ...keys),
    ctx.db.prepare(`SELECT COUNT(*) AS n FROM data_entries WHERE project_id = ? AND deleted = 0`).bind(projectId),
  ]);
  const states = new Map<string, State>();
  for (const k of keys) states.set(k, { exists: false, ownerActive: false });
  for (const r of rows!.results as EntryDb[]) states.set(r.key, { exists: true, row: r, ownerActive: r.owner_active === 1 });
  return { states, live: (count!.results[0] as { n: number }).n };
}

function notFound(key: string, row: EntryDb | undefined) {
  if (row && row.deleted === 1) {
    return ruleError(
      'DATA_NOT_FOUND',
      `"${key}" was deleted (its last version is ${row.version}).`,
      `To create it again, put it with expected_version ${row.version} (the version of the delete).`,
      404,
      { key, deleted: true, version: row.version, deleted_by: row.updated_by, deleted_at: row.updated_at },
    );
  }
  return ruleError('DATA_NOT_FOUND', `There is no entry "${key}".`, 'List the project entries to see the keys; a key that never existed is created with expected_version 0.', 404, { key, deleted: false, version: 0 });
}

/** The current entry, or one version from history. A deleted or missing key is DATA_NOT_FOUND. */
export async function getEntry(ctx: Ctx, actor: Actor, projectId: number, key: string, version?: number): Promise<Entry | HistoryRow & { key: string }> {
  await authorize(ctx, actor, projectId);
  checkKey(key);
  if (version === undefined) {
    const row = await ctx.db.prepare(`SELECT ${ENTRY_COLS} FROM data_entries WHERE project_id = ? AND key = ?`).bind(projectId, key).first<EntryDb>();
    if (!row || row.deleted === 1) throw notFound(key, row ?? undefined);
    return entryOf(row, true);
  }
  const h = await ctx.db
    .prepare(`SELECT version, op, value, owner, actor, at, note, batch_id FROM data_history WHERE project_id = ? AND key = ? AND version = ?`)
    .bind(projectId, key, version)
    .first<HistoryDb>();
  if (!h) {
    const latest = await ctx.db.prepare(`SELECT MAX(version) AS v FROM data_history WHERE project_id = ? AND key = ?`).bind(projectId, key).first<{ v: number | null }>();
    if (latest?.v == null) throw notFound(key, undefined);
    throw ruleError('VERSION_NOT_FOUND', `Version ${version} of "${key}" does not exist.`, `The latest version is ${latest.v}.`, 404, { key, latest_version: latest.v });
  }
  return { key, ...historyOf(h, true) };
}

type HistoryDb = { fits?: number; version: number; op: string; value?: string | null; owner: string | null; actor: string; at: string; note: string | null; batch_id: string | null };

function historyOf(r: HistoryDb, withValue: boolean): HistoryRow {
  const h: HistoryRow = { version: r.version, op: r.op, owner: r.owner, actor: r.actor, at: r.at, note: r.note, batchId: r.batch_id };
  if (withValue && r.value != null) h.value = JSON.parse(r.value);
  return h;
}

function checkLimit(limit: number | undefined, def: number, max: number): number {
  const n = limit ?? def;
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw ruleError('BAD_LIMIT', `A limit of ${n} is not allowed.`, `Use a whole number from 1 to ${max}.`);
  }
  return n;
}

/** The smallest string greater than every string that starts with the prefix (keys are ASCII). */
function prefixEnd(prefix: string): string | null {
  if (prefix === '') return null;
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
}

export async function listEntries(
  ctx: Ctx,
  actor: Actor,
  projectId: number,
  o: { prefix?: string; includeValues?: boolean; includeDeleted?: boolean; limit?: number; afterKey?: string },
): Promise<{ entries: Entry[]; afterKey?: string }> {
  await authorize(ctx, actor, projectId);
  const limit = checkLimit(o.limit, 200, 500);
  const prefix = o.prefix ?? '';
  if (prefix.length > 200 || (prefix !== '' && !KEY_CHARS.test(prefix))) {
    throw ruleError('BAD_PREFIX', 'The prefix is not made of key characters.', 'Use letters, digits, dot, underscore, colon, hyphen and slash, at most 200 characters.');
  }
  const hi = prefixEnd(prefix);
  // The value is read only for rows whose running size still fits the response cap (and only when asked for), so a
  // page of 500 entries of 64 KiB never loads 32 MB into the Worker. 400 bytes stand for the metadata of a row.
  const { results } = await ctx.db
    .prepare(
      `WITH page AS (
         SELECT key, version, owner, updated_by, updated_at, note, deleted, LENGTH(CAST(value AS BLOB)) AS bytes FROM data_entries
         WHERE project_id = ?1 AND key >= ?2 AND (?3 IS NULL OR key < ?3) AND key > ?4 AND (?5 = 1 OR deleted = 0)
         ORDER BY key LIMIT ?6),
       sized AS (SELECT *, SUM(COALESCE(bytes, 0) + 400) OVER (ORDER BY key ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS acc FROM page)
       SELECT key, version, owner, updated_by, updated_at, note, deleted,
         CASE WHEN ?7 = 1 AND acc <= ?8 THEN (SELECT value FROM data_entries e WHERE e.project_id = ?1 AND e.key = sized.key) END AS value,
         CASE WHEN ?7 = 0 OR acc <= ?8 THEN 1 ELSE 0 END AS fits
       FROM sized ORDER BY key`,
    )
    .bind(projectId, prefix, hi, o.afterKey ?? '', o.includeDeleted ? 1 : 0, limit + 1, o.includeValues ? 1 : 0, RESPONSE_CAP_BYTES)
    .all<EntryDb>();
  const entries: Entry[] = [];
  let size = 0;
  let more = results.length > limit;
  for (const r of results.slice(0, limit)) {
    if (r.fits === 0 && entries.length > 0) {
      more = true;
      break;
    }
    const e = entryOf(r, o.includeValues === true);
    const n = bytesOf(JSON.stringify(e));
    if (entries.length > 0 && size + n > RESPONSE_CAP_BYTES) {
      more = true;
      break;
    }
    size += n;
    entries.push(e);
  }
  return more && entries.length > 0 ? { entries, afterKey: entries[entries.length - 1]!.key } : { entries };
}

export async function entryHistory(
  ctx: Ctx,
  actor: Actor,
  projectId: number,
  key: string,
  o: { limit?: number; beforeVersion?: number; includeValues?: boolean } = {},
): Promise<{ versions: HistoryRow[]; beforeVersion?: number }> {
  await authorize(ctx, actor, projectId);
  checkKey(key);
  const limit = checkLimit(o.limit, 50, 200);
  const withValues = o.includeValues !== false;
  const { results } = await ctx.db
    .prepare(
      `WITH page AS (
         SELECT version, op, owner, actor, at, note, batch_id, LENGTH(CAST(value AS BLOB)) AS bytes FROM data_history
         WHERE project_id = ?1 AND key = ?2 AND version < ?3 ORDER BY version DESC LIMIT ?4),
       sized AS (SELECT *, SUM(COALESCE(bytes, 0) + 400) OVER (ORDER BY version DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS acc FROM page)
       SELECT version, op, owner, actor, at, note, batch_id,
         CASE WHEN ?5 = 1 AND acc <= ?6 THEN (SELECT value FROM data_history h WHERE h.project_id = ?1 AND h.key = ?2 AND h.version = sized.version) END AS value,
         CASE WHEN ?5 = 0 OR acc <= ?6 THEN 1 ELSE 0 END AS fits
       FROM sized ORDER BY version DESC`,
    )
    .bind(projectId, key, o.beforeVersion ?? 2 ** 53 - 1, limit + 1, withValues ? 1 : 0, RESPONSE_CAP_BYTES)
    .all<HistoryDb>();
  if (results.length === 0 && (o.beforeVersion === undefined || !(await ctx.db.prepare(`SELECT 1 AS x FROM data_entries WHERE project_id = ? AND key = ?`).bind(projectId, key).first()))) throw notFound(key, undefined);
  const versions: HistoryRow[] = [];
  let size = 0;
  let more = results.length > limit;
  for (const r of results.slice(0, limit)) {
    if (r.fits === 0 && versions.length > 0) {
      more = true;
      break;
    }
    const h = historyOf(r, withValues);
    const n = bytesOf(JSON.stringify(h));
    if (versions.length > 0 && size + n > RESPONSE_CAP_BYTES) {
      more = true;
      break;
    }
    size += n;
    versions.push(h);
  }
  return more && versions.length > 0 ? { versions, beforeVersion: versions[versions.length - 1]!.version } : { versions };
}

// ---------------------------------------------------------------- failures

type Failure =
  | { kind: 'conflict'; op: WriteOp; why: 'version' | 'deleted' | 'not_owned' }
  | { kind: 'not_owner'; op: WriteOp; owner: string }
  | { kind: 'owner_at_creation'; op: WriteOp }
  | { kind: 'key_limit'; op: WriteOp };

/**
 * Judges every op against the states read, in batch order (so the live-key count moves as earlier ops of the same
 * batch would move it). Mirrors the SQL guards; the SQL decides, this explains.
 */
function failures(ops: WriteOp[], states: Map<string, State>, live: number, actor: Actor): Failure[] {
  const out: Failure[] = [];
  const me = actor.kind === 'agent' ? actor.name : 'admin';
  let count = live;
  for (const op of ops) {
    const s = states.get(op.key)!;
    const version = s.row?.version ?? 0;
    const isDeleted = s.row?.deleted === 1;
    if (op.expectedVersion !== version) {
      out.push({ kind: 'conflict', op, why: 'version' });
      continue;
    }
    if (op.op === 'check') continue;
    if (op.op === 'put' && version === 0) {
      if (count >= MAX_LIVE_KEYS) out.push({ kind: 'key_limit', op });
      else count += 1;
      continue;
    }
    if (op.op === 'delete' || op.op === 'admin_delete') {
      if (isDeleted) {
        out.push({ kind: 'conflict', op, why: 'deleted' });
        continue;
      }
    }
    if (op.op === 'admin_release' && (isDeleted || s.row?.owner == null)) {
      out.push({ kind: 'conflict', op, why: 'not_owned' });
      continue;
    }
    const owner = s.row?.owner ?? null;
    if (actor.kind === 'agent' && !isDeleted && owner !== null && owner !== me && s.ownerActive) {
      out.push({ kind: 'not_owner', op, owner });
      continue;
    }
    if (op.op === 'put' && op.owner === 'me' && !isDeleted) {
      out.push({ kind: 'owner_at_creation', op });
      continue;
    }
    if (op.op === 'put' && isDeleted) {
      if (count >= MAX_LIVE_KEYS) out.push({ kind: 'key_limit', op });
      else count += 1;
      continue;
    }
    if (op.op === 'delete' || op.op === 'admin_delete') count -= 1;
  }
  return out;
}

function stateDetails(key: string, expected: number, s: State, withValue: boolean) {
  const r = s.row;
  if (!r) return { key, expected_version: expected, exists: false, version: 0, deleted: false };
  return {
    key,
    expected_version: expected,
    exists: true,
    version: r.version,
    deleted: r.deleted === 1,
    owner: r.owner,
    updated_by: r.updated_by,
    updated_at: r.updated_at,
    note: r.note,
    ...(withValue && r.value != null ? { value: JSON.parse(r.value) as unknown } : {}),
  };
}

function failureError(fs: Failure[], states: Map<string, State>): EchoError {
  const conflicts = fs.filter((f) => f.kind === 'conflict');
  if (conflicts.length > 0) {
    // Entries keep their value while the whole stays under the cap, reserving room for the lean form of every later
    // entry; the rest keep their metadata and drop the value.
    const lean = conflicts.map((f) => ({ ...stateDetails(f.op.key, f.op.expectedVersion, states.get(f.op.key)!, false), value_omitted: true }));
    const leanSize = lean.map((l) => bytesOf(JSON.stringify(l)) + 1);
    let reserve = leanSize.reduce((a, b) => a + b, 0);
    let size = '{"conflicts":[]}'.length;
    const list = conflicts.map((f, i) => {
      reserve -= leanSize[i]!;
      const full = stateDetails(f.op.key, f.op.expectedVersion, states.get(f.op.key)!, true);
      const n = bytesOf(JSON.stringify(full)) + 1;
      if (size + n + reserve <= DETAILS_CAP_BYTES) {
        size += n;
        return full;
      }
      size += leanSize[i]!;
      return lean[i]!;
    });
    const keys = conflicts.map((f) => f.op.key).join(', ');
    const single = conflicts[0]!;
    if (conflicts.length === 1 && single.why === 'deleted') {
      return ruleError('VERSION_CONFLICT', `"${keys}" is already deleted; nothing was written.`, 'Read the entry (echo_data_get) and decide again; to create it anew, put it with the tombstone version.', 409, { conflicts: list });
    }
    if (conflicts.length === 1 && single.why === 'not_owned') {
      return ruleError('VERSION_CONFLICT', `"${keys}" has no owner to release; nothing was written.`, 'Reload the page to see the entry as it is now.', 409, { conflicts: list });
    }
    return ruleError(
      'VERSION_CONFLICT',
      `${conflicts.length === 1 ? `"${keys}" is not at the version you expected` : `These keys are not at the versions you expected: ${keys}`}. Nothing was written.`,
      'Do not retry unchanged. Read the current state in the error details (or echo_data_get), merge your change with it, and put again with the current version.',
      409,
      { conflicts: list },
    );
  }
  const f = fs[0]!;
  if (f.kind === 'not_owner') {
    return ruleError('NOT_OWNER', `"${f.op.key}" is owned by ${f.owner}; nothing was written.`, `Ask ${f.owner} to change it or to release it (a put with owner null), then write it.`, 403, { key: f.op.key, owner: f.owner });
  }
  if (f.kind === 'owner_at_creation') {
    return ruleError('OWNER_AT_CREATION', `owner "me" can be set only when an entry is created; "${f.op.key}" exists.`, 'Leave owner out to keep it as it is, or use owner null to release it.', 400, { key: f.op.key });
  }
  return ruleError('KEY_LIMIT', `The project already has ${MAX_LIVE_KEYS} live keys; "${f.op.key}" was not created.`, 'Delete entries that are done, then create the key.', 409, { key: f.op.key, limit: MAX_LIVE_KEYS });
}

// ---------------------------------------------------------------- writes

type Notify = 'all' | string[] | undefined;

export type WriteRequest = {
  projectId: number;
  ops: WriteOp[];
  note?: string;
  notify?: Notify;
  requestId?: string;
  /** A batch id for history rows; null for a single put or delete. */
  batchId: string | null;
};

const MODE: Record<string, number> = { keep: 0, me: 1, release: 2 };

function writeStmts(ctx: Ctx, actor: Actor, req: WriteRequest, op: WriteOp, texts: Map<string, string>, now: string): D1PreparedStatement[] {
  const p = req.projectId;
  const name = actorLabel(actor);
  const note = req.note ?? null;
  const live = op.op === 'put' ? 'data.put' : op.op === 'admin_release' ? 'data.put' : 'data.deleted';
  let write: D1PreparedStatement;
  const mayWrite = `(owner IS NULL OR owner = ?3 OR NOT ${ownerActive('data_entries.owner')})`;
  if (op.op === 'put' && op.expectedVersion === 0) {
    write = ctx.db
      .prepare(
        `INSERT INTO data_entries (project_id, key, version, value, owner, updated_by, updated_at, note, deleted)
         SELECT ?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, 0
         WHERE (SELECT COUNT(*) FROM data_entries WHERE project_id = ?1 AND deleted = 0) < ${MAX_LIVE_KEYS}
         ON CONFLICT (project_id, key) DO NOTHING`,
      )
      .bind(p, op.key, texts.get(op.key), op.owner === 'me' ? name : null, name, now, note);
  } else if (op.op === 'put') {
    const mode = op.owner === 'me' ? MODE.me : op.owner === null ? MODE.release : MODE.keep;
    write = ctx.db
      .prepare(
        `UPDATE data_entries SET
           version = version + 1, value = ?3,
           owner = CASE ?4 WHEN 0 THEN (CASE WHEN ${ownerActive('data_entries.owner')} THEN owner END) WHEN 1 THEN ?5 ELSE NULL END,
           updated_by = ?5, updated_at = ?6, note = ?7, deleted = 0
         WHERE project_id = ?1 AND key = ?2 AND version = ?8
           AND (owner IS NULL OR owner = ?5 OR NOT ${ownerActive('data_entries.owner')})
           AND (?4 <> 1 OR deleted = 1)
           AND (deleted = 0 OR (SELECT COUNT(*) FROM data_entries WHERE project_id = ?1 AND deleted = 0) < ${MAX_LIVE_KEYS})`,
      )
      .bind(p, op.key, texts.get(op.key), mode, name, now, note, op.expectedVersion);
  } else if (op.op === 'delete') {
    write = ctx.db
      .prepare(
        `UPDATE data_entries SET version = version + 1, value = NULL, owner = NULL, deleted = 1, updated_by = ?3, updated_at = ?4, note = ?5
         WHERE project_id = ?1 AND key = ?2 AND version = ?6 AND deleted = 0 AND ${mayWrite}`,
      )
      .bind(p, op.key, name, now, note, op.expectedVersion);
  } else if (op.op === 'admin_delete') {
    write = ctx.db
      .prepare(
        `UPDATE data_entries SET version = version + 1, value = NULL, owner = NULL, deleted = 1, updated_by = ?3, updated_at = ?4, note = ?5
         WHERE project_id = ?1 AND key = ?2 AND version = ?6 AND deleted = 0`,
      )
      .bind(p, op.key, name, now, note, op.expectedVersion);
  } else {
    write = ctx.db
      .prepare(
        `UPDATE data_entries SET version = version + 1, owner = NULL, updated_by = ?3, updated_at = ?4, note = ?5
         WHERE project_id = ?1 AND key = ?2 AND version = ?6 AND deleted = 0 AND owner IS NOT NULL`,
      )
      .bind(p, op.key, name, now, note, op.expectedVersion);
  }
  const history = ctx.db
    .prepare(
      `INSERT INTO data_history (project_id, key, version, op, value, owner, actor, at, note, batch_id, request_id)
       SELECT ?1, ?2,
         CASE WHEN changes() > 0 THEN (SELECT version FROM data_entries WHERE project_id = ?1 AND key = ?2) END,
         ?3, (SELECT value FROM data_entries WHERE project_id = ?1 AND key = ?2),
         (SELECT owner FROM data_entries WHERE project_id = ?1 AND key = ?2), ?4, ?5, ?6, ?7, ?8
       RETURNING key, version`,
    )
    .bind(p, op.key, op.op, name, now, note, req.batchId, req.requestId ?? null);
  const log = ctx.db
    .prepare(
      `INSERT INTO change_log (project_id, at, actor, kind, subject_id, data)
       SELECT ?1, ?2, ?3, ?4, NULL, json_object('key', ?5, 'version', e.version, 'op', ?6, 'batch_id', ?7)
       FROM data_entries e WHERE e.project_id = ?1 AND e.key = ?5 AND changes() > 0`,
    )
    .bind(p, now, name, live, op.key, op.op, req.batchId);
  return [write, history, log];
}

function checkStmts(ctx: Ctx, projectId: number, op: WriteOp): D1PreparedStatement[] {
  return [
    ctx.db
      .prepare(
        `INSERT INTO data_guard (ok)
         SELECT CASE WHEN (SELECT COALESCE(MAX(version), 0) FROM data_entries WHERE project_id = ?1 AND key = ?2) = ?3 THEN 1 END`,
      )
      .bind(projectId, op.key, op.expectedVersion),
    ctx.db.prepare(`DELETE FROM data_guard`),
  ];
}

/** The version a write op will have when it commits: the guards allow it at exactly this one. */
const predicted = (op: WriteOp) => (op.op === 'put' && op.expectedVersion === 0 ? 1 : op.expectedVersion + 1);

/** Everything that can start a new line or hide text in a note: whitespace, control characters, line and paragraph
 *  separators (U+0085, U+001C-001E and U+2028/9 included), and bidi and zero-width characters. */
const SEP_RANGES: [number, number][] = [[0xad, 0xad], [0x61c, 0x61c], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb]];
const NOTE_SEPARATORS = new RegExp('[\\s\\p{Cc}\\p{Zl}\\p{Zp}' + SEP_RANGES.map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join('') + ']+', 'gu');

function notifyBody(actor: Actor, req: WriteRequest): string {
  const writes = req.ops.filter((o) => o.op !== 'check');
  const who = actorLabel(actor);
  const note = req.note?.replace(NOTE_SEPARATORS, ' ').trim();
  const line = (o: WriteOp) => `${o.key}@v${predicted(o)} (${o.op === 'put' ? 'put' : 'delete'})`;
  const build = (note: string | undefined) =>
    writes.length === 1 && req.batchId === null
      ? `Shared data ${line(writes[0]!)} by ${who}${note ? `: ${note}` : ''}`
      : `Shared data batch by ${who}${note ? `: ${note}` : ''}\n${writes.map(line).join('\n')}`;
  const full = build(note);
  return bytesOf(full) <= MAX_MESSAGE_BYTES ? full : build(undefined);
}

async function notifyRecipients(ctx: Ctx, actor: Actor, projectId: number, notify: Notify): Promise<number[]> {
  if (notify === undefined || actor.kind !== 'agent') return [];
  const { results: members } = await ctx.db
    .prepare(
      `SELECT a.id, a.name FROM agents a JOIN project_agents pa ON pa.agent_id = a.id
       WHERE pa.project_id = ? AND a.revoked_at IS NULL ORDER BY a.name`,
    )
    .bind(projectId)
    .all<{ id: number; name: string }>();
  if (notify === 'all') {
    const others = members.filter((m) => m.id !== actor.agentId);
    if (!others.length) throw ruleError('NO_RECIPIENTS', 'There is nobody else in this project to notify.', 'Leave notify out, or ask the owner to add agents to the project.');
    return others.map((m) => m.id);
  }
  const ids: number[] = [];
  for (const name of notify) {
    const hit = members.find((m) => m.name.toLowerCase() === name.trim().toLowerCase());
    if (!hit) {
      throw ruleError(
        'UNKNOWN_RECIPIENT',
        `"${name}" is not an agent in this project.`,
        `Notify one of: ${members.filter((m) => m.id !== actor.agentId).map((m) => m.name).join(', ') || '(nobody else)'}, or "all". Nothing was written.`,
        404,
      );
    }
    if (hit.id === actor.agentId) {
      throw ruleError('NOTIFY_SELF', 'You cannot notify yourself.', 'Leave yourself out of notify. Nothing was written.');
    }
    if (!ids.includes(hit.id)) ids.push(hit.id);
  }
  return ids;
}

/** Rows an earlier attempt with the same request_id wrote, as the retry's answer; a different request is refused. */
async function priorAttempt(ctx: Ctx, actor: Actor, req: WriteRequest, texts: Map<string, string>): Promise<WriteOutcome | null> {
  if (req.requestId === undefined) return null;
  const { results } = await ctx.db
    .prepare(`SELECT h.key, h.version, h.op, h.value, h.owner, h.batch_id,
              (SELECT p.op FROM data_history p WHERE p.project_id = h.project_id AND p.key = h.key AND p.version = h.version - 1) AS prev_op
       FROM data_history h WHERE h.project_id = ? AND h.actor = ? AND h.request_id = ?`)
    .bind(req.projectId, actorLabel(actor), req.requestId)
    .all<{ key: string; version: number; op: string; value: string | null; owner: string | null; batch_id: string | null; prev_op: string | null }>();
  if (results.length === 0) return null;
  const writes = req.ops.filter((o) => o.op !== 'check');
  const byKey = new Map(results.map((r) => [r.key, r]));
  // The same request: the rows of one write (a whole batch, or a single put or delete) are exactly its ops, each written from
  // the version it expected with the value it sent. Other rows that merely share the request_id belong to other writes.
  // The owner the retry asks for. A create or a revive without owner means "no owner", so it must match; on an update,
  // omitting owner means "keep", which history cannot check.
  const ownerAsked = (o: WriteOp & { op: 'put' }, r: { owner: string | null; version: number; prev_op: string | null }) => {
    const creation = r.version === 1 || r.prev_op === 'delete' || r.prev_op === 'admin_delete';
    if (o.owner === undefined) return !creation || r.owner === null;
    return r.owner === (o.owner === 'me' ? actorLabel(actor) : null);
  };
  const first = byKey.get(writes[0]!.key);
  const group = first === undefined ? [] : first.batch_id === null ? [first] : results.filter((r) => r.batch_id === first.batch_id);
  const same =
    first !== undefined &&
    group.length === writes.length &&
    writes.every((o) => {
      const r = group.find((g) => g.key === o.key);
      return r !== undefined && r.op === o.op && r.version - 1 === o.expectedVersion && (o.op !== 'put' || (r.value === texts.get(o.key) && ownerAsked(o, r)));
    });
  if (!same) {
    throw ruleError(
      'REQUEST_ID_REUSED',
      `request_id "${req.requestId}" was already used for a different write; nothing was written.`,
      'To retry that write, send exactly the same operations with the same request_id. For a new write, use a new request_id.',
      409,
    );
  }
  const previous = new Map(results.map((r) => [r.key, r.version - 1]));
  return {
    batchId: first!.batch_id,
    results: req.ops.map((o) => ({ key: o.key, version: o.op === 'check' ? o.expectedVersion : byKey.get(o.key)!.version })),
    previous,
    duplicate: true,
  };
}

function isGuardAbort(e: unknown): boolean {
  const text = e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? '')}` : String(e);
  return /NOT NULL constraint failed: data_(history\.version|guard\.ok)|UNIQUE constraint failed: data_requests/.test(text);
}

/** The single write path: validates, applies every op in one batch, or applies nothing and says why. */
async function applyWrites(ctx: Ctx, actor: Actor, req: WriteRequest): Promise<WriteOutcome> {
  await authorize(ctx, actor, req.projectId);
  checkNote(req.note);
  checkRequestId(req.requestId);
  const { ops } = req;
  if (ops.length < 1 || ops.length > MAX_OPS) {
    throw ruleError('BAD_OPS', `A batch takes 1 to ${MAX_OPS} operations; this one has ${ops.length}.`, `Send at most ${MAX_OPS} operations; split a larger change into several batches (only one batch is atomic).`);
  }
  const seen = new Set<string>();
  const texts = new Map<string, string>();
  let valueBytes = 0;
  for (const op of ops) {
    checkKey(op.key);
    if (seen.has(op.key)) {
      throw ruleError('DUPLICATE_KEY', `The key "${op.key}" appears twice in the batch.`, 'Use each key once per batch: combine the two operations into one.');
    }
    seen.add(op.key);
    if (op.op === 'put') {
      if (op.owner !== undefined && op.owner !== null && op.owner !== 'me') {
        throw ruleError('BAD_OWNER', 'owner can only be "me" (at creation) or null (to release).', 'There is no hand-over: release the entry (owner null) and let the other agent write it.');
      }
      const t = serializeValue(op.value);
      texts.set(op.key, t);
      valueBytes += bytesOf(t);
    }
    if ((op.op === 'delete' || op.op === 'admin_delete' || op.op === 'admin_release') && op.expectedVersion === 0) {
      throw ruleError('NOTHING_TO_DELETE', `"${op.key}" has never existed, so there is nothing to delete.`, 'Delete a key with the version you read; read it first with echo_data_get.');
    }
  }
  if (valueBytes > MAX_BATCH_VALUE_BYTES) {
    throw ruleError('BATCH_TOO_LARGE', `The values in this batch add up to ${valueBytes} bytes; the limit is ${MAX_BATCH_VALUE_BYTES}.`, 'Split the batch into smaller ones.');
  }
  if (!ops.some((o) => o.op !== 'check')) {
    throw ruleError('NOTHING_TO_WRITE', 'The batch has only check operations, so it writes nothing.', 'Add at least one put or delete, or use echo_data_get to look at versions.');
  }

  const prior = await priorAttempt(ctx, actor, req, texts);
  if (prior) return prior;
  const recipients = await notifyRecipients(ctx, actor, req.projectId, req.notify);

  const keys = ops.map((o) => o.key);
  // Precheck (advisory): the same judgment the guards make, so the common refusal never attempts a write.
  {
    const { states, live } = await readStates(ctx, req.projectId, keys);
    const fs = failures(ops, states, live, actor);
    if (fs.length > 0) {
      // The original attempt may have committed after the first look: then this is its retry, not a conflict.
      const raced = await priorAttempt(ctx, actor, req, texts);
      if (raced) return raced;
      throw failureError(fs, states);
    }
  }

  const now = ctx.now();
  const stmts: D1PreparedStatement[] = [];
  for (const op of ops) if (op.op === 'check') stmts.push(...checkStmts(ctx, req.projectId, op));
  // One row per request_id, inside the batch: a second, different write under the same id aborts on its primary key.
  if (req.requestId !== undefined) {
    stmts.push(ctx.db.prepare(`INSERT INTO data_requests (project_id, actor, request_id) VALUES (?, ?, ?)`).bind(req.projectId, actorLabel(actor), req.requestId));
  }
  const returning: number[] = [];
  for (const op of ops) {
    if (op.op === 'check') continue;
    const s = writeStmts(ctx, actor, req, op, texts, now);
    returning.push(stmts.length + 1);
    stmts.push(...s);
  }
  if (recipients.length > 0 && actor.kind === 'agent') {
    stmts.push(
      ...newMessageStmts(
        ctx,
        actor,
        {
          projectId: req.projectId,
          senderAgentId: actor.agentId,
          label: actor.name,
          body: notifyBody(actor, req),
          requiresAck: false,
          escalateAt: null,
          kind: 'plain',
          refId: null,
          recipientIds: recipients,
        },
        true,
      ),
    );
  }

  let res: D1Result[];
  try {
    res = await ctx.db.batch(stmts);
  } catch (e) {
    if (!isGuardAbort(e)) throw e;
    // Nothing was written. Say why, from the state as it is now (versions only grow, so a conflict cannot heal).
    const again = await priorAttempt(ctx, actor, req, texts);
    if (again) return again;
    const { states, live } = await readStates(ctx, req.projectId, keys);
    const fs = failures(ops, states, live, actor);
    if (fs.length > 0) throw failureError(fs, states);
    throw serviceError('DATA_RETRY', 'Echo could not apply the write because the data changed underneath it.');
  }
  const versions = new Map<string, number>();
  for (const i of returning) {
    const row = res[i]!.results[0] as { key: string; version: number } | undefined;
    if (row) versions.set(row.key, row.version);
  }
  return {
    batchId: req.batchId,
    results: ops.map((o) => ({ key: o.key, version: o.op === 'check' ? o.expectedVersion : versions.get(o.key)! })),
    previous: new Map(ops.filter((o) => o.op !== 'check').map((o) => [o.key, versions.get(o.key)! - 1])),
  };
}

// ---------------------------------------------------------------- the public write API

type Common = { projectId: number; note?: string; notify?: Notify; requestId?: string };

export async function putEntry(
  ctx: Ctx,
  actor: Actor,
  p: Common & { key: string; value: unknown; expectedVersion: number; owner?: 'me' | null },
): Promise<{ key: string; version: number; previousVersion: number; duplicate?: boolean }> {
  const r = await applyWrites(ctx, actor, {
    projectId: p.projectId,
    ops: [{ op: 'put', key: p.key, value: p.value, expectedVersion: p.expectedVersion, owner: p.owner }],
    note: p.note,
    notify: p.notify,
    requestId: p.requestId,
    batchId: null,
  });
  const w = r.results[0]!;
  return { key: w.key, version: w.version, previousVersion: r.previous.get(w.key) ?? w.version - 1, ...(r.duplicate ? { duplicate: true } : {}) };
}

export async function deleteEntry(
  ctx: Ctx,
  actor: Actor,
  p: Common & { key: string; expectedVersion: number },
): Promise<{ key: string; version: number; duplicate?: boolean }> {
  const r = await applyWrites(ctx, actor, {
    projectId: p.projectId,
    ops: [{ op: 'delete', key: p.key, expectedVersion: p.expectedVersion }],
    note: p.note,
    notify: p.notify,
    requestId: p.requestId,
    batchId: null,
  });
  const w = r.results[0]!;
  return { key: w.key, version: w.version, ...(r.duplicate ? { duplicate: true } : {}) };
}

export async function batchWrite(
  ctx: Ctx,
  actor: Actor,
  p: Common & { ops: AgentOp[] },
): Promise<{ batchId: string | null; results: WriteResult[]; duplicate?: boolean }> {
  const r = await applyWrites(ctx, actor, { projectId: p.projectId, ops: p.ops, note: p.note, notify: p.notify, requestId: p.requestId, batchId: crypto.randomUUID() });
  return { batchId: r.batchId, results: r.results, ...(r.duplicate ? { duplicate: true } : {}) };
}

const ADMIN: Actor = { kind: 'admin' };

function needReason(reason: string): string {
  const r = reason.trim();
  if (!r) throw ruleError('REASON_REQUIRED', 'A reason is required.', 'Say why, in a few words; it is recorded in the entry history.');
  return r;
}

/** Admin repair: removes the owner, keeping the value. Written to history as admin_release. */
export async function adminReleaseOwner(ctx: Ctx, projectId: number, key: string, expectedVersion: number, reason: string): Promise<void> {
  await applyWrites(ctx, ADMIN, { projectId, ops: [{ op: 'admin_release', key, expectedVersion }], note: needReason(reason), batchId: null });
}

/** Admin repair: deletes the entry (a tombstone). Written to history as admin_delete. */
export async function adminDeleteEntry(ctx: Ctx, projectId: number, key: string, expectedVersion: number, reason: string): Promise<void> {
  await applyWrites(ctx, ADMIN, { projectId, ops: [{ op: 'admin_delete', key, expectedVersion }], note: needReason(reason), batchId: null });
}

// ---------------------------------------------------------------- admin reads (no actor; the admin routes are behind requireAdmin)

export const ADMIN_PAGE_KEYS = 500;
export const ADMIN_PAGE_VERSIONS = 50;

export type AdminListRow = { key: string; version: number; owner: string | null; updatedBy: string; updatedAt: string; note: string | null; deleted: boolean; preview: string; previewCut: boolean };
export type AdminList = {
  rows: AdminListRow[];
  /** Set when more keys follow: pass it as `after`. */
  next?: string;
  live: number;
  historyBytes: number;
  historyRows: number;
};

/** The list page's data. The value is read only as its first 400 characters: 2,000 entries of 64 KiB must not be loaded. */
export async function adminList(ctx: Ctx, projectId: number, o: { prefix?: string; deleted?: boolean; after?: string }): Promise<AdminList> {
  const prefix = o.prefix ?? '';
  const valid = prefix === '' || (prefix.length <= 200 && KEY_CHARS.test(prefix));
  const hi = valid ? prefixEnd(prefix) : null;
  const [rows, live, hist] = await ctx.db.batch([
    ctx.db
      .prepare(
        `SELECT key, version, substr(value, 1, 400) AS head, length(CAST(value AS BLOB)) AS bytes, owner, updated_by, updated_at, note, deleted FROM data_entries
         WHERE project_id = ?1 AND key >= ?2 AND (?3 IS NULL OR key < ?3) AND key > ?4 AND (?5 = 1 OR deleted = 0)
         ORDER BY key LIMIT ?6`,
      )
      .bind(projectId, valid ? prefix : '￿', hi, o.after ?? '', o.deleted ? 1 : 0, ADMIN_PAGE_KEYS + 1),
    ctx.db.prepare(`SELECT COUNT(*) AS n FROM data_entries WHERE project_id = ? AND deleted = 0`).bind(projectId),
    ctx.db.prepare(`SELECT COALESCE(SUM(LENGTH(CAST(value AS BLOB))), 0) AS bytes, COUNT(*) AS n FROM data_history WHERE project_id = ?`).bind(projectId),
  ]);
  const raw = rows!.results as { key: string; version: number; head: string | null; bytes: number | null; owner: string | null; updated_by: string; updated_at: string; note: string | null; deleted: number }[];
  const page = raw.slice(0, ADMIN_PAGE_KEYS).map((r) => {
    const flat = (r.head ?? '').replace(/\s+/g, ' ').trim();
    const cut = flat.length > 200 || (r.bytes ?? 0) > 400;
    return {
      key: r.key,
      version: r.version,
      owner: r.owner,
      updatedBy: r.updated_by,
      updatedAt: r.updated_at,
      note: r.note,
      deleted: r.deleted === 1,
      preview: flat.slice(0, 200),
      previewCut: cut,
    };
  });
  const h = hist!.results[0] as { bytes: number; n: number };
  return {
    rows: page,
    ...(raw.length > ADMIN_PAGE_KEYS ? { next: page[page.length - 1]!.key } : {}),
    live: (live!.results[0] as { n: number }).n,
    historyBytes: h.bytes,
    historyRows: h.n,
  };
}

export type AdminEntryView = {
  key: string;
  entry: { version: number; valueText: string | null; owner: string | null; updatedBy: string; updatedAt: string; note: string | null; deleted: boolean };
  /** Newest first, no values. */
  history: { version: number; op: string; actor: string; at: string; note: string | null; batchId: string | null; owner: string | null }[];
  older?: number;
};

export async function adminEntry(ctx: Ctx, projectId: number, key: string, before?: number): Promise<AdminEntryView> {
  checkKey(key);
  const [e, h] = await ctx.db.batch([
    ctx.db.prepare(`SELECT ${ENTRY_COLS} FROM data_entries WHERE project_id = ? AND key = ?`).bind(projectId, key),
    ctx.db
      .prepare(
        `SELECT version, op, actor, at, note, batch_id, owner FROM data_history WHERE project_id = ?1 AND key = ?2 AND version < ?3 ORDER BY version DESC LIMIT ?4`,
      )
      .bind(projectId, key, before ?? 2 ** 53 - 1, ADMIN_PAGE_VERSIONS + 1),
  ]);
  const row = e!.results[0] as EntryDb | undefined;
  if (!row) throw notFound(key, undefined);
  const hist = h!.results as { version: number; op: string; actor: string; at: string; note: string | null; batch_id: string | null; owner: string | null }[];
  const page = hist.slice(0, ADMIN_PAGE_VERSIONS);
  return {
    key,
    entry: { version: row.version, valueText: row.value ?? null, owner: row.owner, updatedBy: row.updated_by, updatedAt: row.updated_at, note: row.note, deleted: row.deleted === 1 },
    history: page.map((r) => ({ version: r.version, op: r.op, actor: r.actor, at: r.at, note: r.note, batchId: r.batch_id, owner: r.owner })),
    ...(hist.length > ADMIN_PAGE_VERSIONS ? { older: page[page.length - 1]!.version } : {}),
  };
}

export type AdminVersionView = {
  key: string;
  version: number;
  op: string;
  actor: string;
  at: string;
  note: string | null;
  owner: string | null;
  batchId: string | null;
  valueText: string | null;
  /** The previous version's stored value text; null when there is none or it was a delete. */
  prevText: string | null;
  prevVersion: number | null;
  latest: number;
};

export async function adminVersion(ctx: Ctx, projectId: number, key: string, version: number): Promise<AdminVersionView> {
  checkKey(key);
  const [cur, prev, latest] = await ctx.db.batch([
    ctx.db.prepare(`SELECT version, op, value, owner, actor, at, note, batch_id FROM data_history WHERE project_id = ? AND key = ? AND version = ?`).bind(projectId, key, version),
    ctx.db.prepare(`SELECT version, value FROM data_history WHERE project_id = ? AND key = ? AND version = ?`).bind(projectId, key, version - 1),
    ctx.db.prepare(`SELECT MAX(version) AS v FROM data_history WHERE project_id = ? AND key = ?`).bind(projectId, key),
  ]);
  const c = cur!.results[0] as HistoryDb | undefined;
  const l = (latest!.results[0] as { v: number | null }).v;
  if (!c) {
    if (l === null) throw notFound(key, undefined);
    throw ruleError('VERSION_NOT_FOUND', `Version ${version} of "${key}" does not exist.`, `The latest version is ${l}.`, 404);
  }
  const p = prev!.results[0] as { version: number; value: string | null } | undefined;
  return {
    key,
    version: c.version,
    op: c.op,
    actor: c.actor,
    at: c.at,
    note: c.note,
    owner: c.owner,
    batchId: c.batch_id,
    valueText: c.value ?? null,
    prevText: p?.value ?? null,
    prevVersion: p?.version ?? null,
    latest: l!,
  };
}
