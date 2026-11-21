import type { Ctx } from '../ctx';
import { ruleError, serviceError } from '../errors';
import type { Actor } from '../types';
import { actorLabel } from '../types';
import { changeStmt } from './changelog';
import { requireMember } from './projects';

export const MAX_DOCUMENT_BYTES = 1048576;
export const DOC_VERSIONS_KEPT = 50;
export const DOC_NAME = /^[A-Za-z0-9._-]{1,100}$/;

const ADMIN: Actor = { kind: 'admin' };

export type DocFormat = 'json' | 'markdown';
export type Document = {
  name: string;
  version: number;
  format: DocFormat;
  content: string;
  savedBy: string;
  createdAt: string;
};
/** What listings return: everything but the content. */
export type DocumentInfo = Omit<Document, 'content'>;

type DocDb = { name: string; version: number; format: DocFormat; content: string; saved_by: string; created_at: string };
const INFO_COLS = 'name, version, format, saved_by, created_at';

function info(r: Omit<DocDb, 'content'>): DocumentInfo {
  return { name: r.name, version: r.version, format: r.format, savedBy: r.saved_by, createdAt: r.created_at };
}

async function authorize(ctx: Ctx, actor: Actor, projectId: number): Promise<void> {
  if (actor.kind === 'agent') await requireMember(ctx, actor.agentId, projectId);
}

function checkName(name: string): void {
  if (!DOC_NAME.test(name)) {
    throw ruleError(
      'BAD_NAME',
      `"${name}" is not a valid document name.`,
      'Use 1 to 100 characters from letters, digits, dot, underscore and hyphen (no spaces or slashes), for example "design-notes.md".',
    );
  }
}

function isConflict(e: unknown): boolean {
  const text = e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? '')}` : String(e);
  return /UNIQUE constraint failed|PRIMARY KEY/i.test(text);
}

/**
 * Saves a new version. The next version number is computed inside the INSERT so the primary key
 * arbitrates between concurrent saves; on a key conflict the whole batch rolls back and is tried once more.
 * Retention runs in the same batch, keyed off the highest version present, which is the one just inserted.
 */
export async function saveDocument(
  ctx: Ctx,
  actor: Actor,
  d: { projectId: number; name: string; format: DocFormat; content: string },
): Promise<{ name: string; version: number }> {
  await authorize(ctx, actor, d.projectId);
  checkName(d.name);
  const size = new TextEncoder().encode(d.content).length;
  if (size > MAX_DOCUMENT_BYTES) {
    throw ruleError(
      'DOCUMENT_TOO_LARGE',
      'The document is too large.',
      `Your document is ${size} bytes; the limit is ${MAX_DOCUMENT_BYTES} bytes. Split it into several documents, or trim it.`,
    );
  }
  if (d.format === 'json') {
    try {
      JSON.parse(d.content);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      throw ruleError('INVALID_JSON', `The content is not valid JSON: ${why}`, 'Fix the JSON and save again, or save it with format "markdown" if it is not JSON.');
    }
  }

  const attempt = async (): Promise<number> => {
    const [ins] = await ctx.db.batch([
      ctx.db
        .prepare(
          `INSERT INTO documents (project_id, name, version, format, content, saved_by, created_at)
           SELECT ?, ?, COALESCE(MAX(version), 0) + 1, ?, ?, ?, ? FROM documents WHERE project_id = ? AND name = ?
           HAVING COALESCE(MAX(CASE WHEN format <> ? THEN 1 END), 0) = 0
           RETURNING version`,
        )
        .bind(d.projectId, d.name, d.format, d.content, actorLabel(actor), ctx.now(), d.projectId, d.name, d.format),
      changeStmt(ctx, { projectId: d.projectId, actor, kind: 'document.saved', subjectId: d.name }, { guarded: true }),
      ctx.db
        .prepare(
          `DELETE FROM documents WHERE project_id = ? AND name = ?
           AND version <= (SELECT MAX(version) FROM documents WHERE project_id = ? AND name = ?) - ?`,
        )
        .bind(d.projectId, d.name, d.projectId, d.name, DOC_VERSIONS_KEPT),
    ]);
    const row = ins.results[0] as { version: number } | undefined;
    if (!row) {
      throw ruleError(
        'FORMAT_CHANGED',
        `"${d.name}" already exists in a different format.`,
        `Save it as ${d.format === 'json' ? 'markdown' : 'json'} again, or use a new document name for the ${d.format} version.`,
      );
    }
    return row.version;
  };

  let version: number;
  try {
    version = await attempt();
  } catch (e) {
    if (!isConflict(e)) throw e;
    try {
      version = await attempt();
    } catch (e2) {
      if (!isConflict(e2)) throw e2;
      throw serviceError('DOCUMENT_SAVE_CONFLICT', `Echo could not save "${d.name}" because other saves kept colliding.`);
    }
  }
  return { name: d.name, version };
}

async function exists(ctx: Ctx, projectId: number, name: string): Promise<boolean> {
  return (await ctx.db.prepare(`SELECT 1 AS x FROM documents WHERE project_id = ? AND name = ? LIMIT 1`).bind(projectId, name).first()) !== null;
}

function notFound(name: string) {
  return ruleError('DOCUMENT_NOT_FOUND', `There is no document named "${name}".`, 'List the project documents to see the names.', 404);
}

/** The latest version, or the given one. */
export async function getDocument(ctx: Ctx, actor: Actor, projectId: number, name: string, version?: number): Promise<Document> {
  await authorize(ctx, actor, projectId);
  const row =
    version === undefined
      ? await ctx.db
          .prepare(`SELECT ${INFO_COLS}, content FROM documents WHERE project_id = ? AND name = ? ORDER BY version DESC LIMIT 1`)
          .bind(projectId, name)
          .first<DocDb>()
      : await ctx.db
          .prepare(`SELECT ${INFO_COLS}, content FROM documents WHERE project_id = ? AND name = ? AND version = ?`)
          .bind(projectId, name, version)
          .first<DocDb>();
  if (!row) {
    if (!(await exists(ctx, projectId, name))) throw notFound(name);
    throw ruleError(
      'VERSION_NOT_FOUND',
      `Version ${version} of "${name}" does not exist.`,
      `Only the last ${DOC_VERSIONS_KEPT} versions are kept. List the versions to see which are available.`,
      404,
    );
  }
  return { ...info(row), content: row.content };
}

/** Latest version of each document, without content. */
export async function listDocuments(ctx: Ctx, actor: Actor, projectId: number): Promise<DocumentInfo[]> {
  await authorize(ctx, actor, projectId);
  const { results } = await ctx.db
    .prepare(
      `SELECT ${INFO_COLS} FROM documents d WHERE project_id = ?
       AND version = (SELECT MAX(version) FROM documents WHERE project_id = d.project_id AND name = d.name)
       ORDER BY name`,
    )
    .bind(projectId)
    .all<Omit<DocDb, 'content'>>();
  return results.map(info);
}

export async function listVersions(ctx: Ctx, actor: Actor, projectId: number, name: string): Promise<DocumentInfo[]> {
  await authorize(ctx, actor, projectId);
  const { results } = await ctx.db
    .prepare(`SELECT ${INFO_COLS} FROM documents WHERE project_id = ? AND name = ? ORDER BY version`)
    .bind(projectId, name)
    .all<Omit<DocDb, 'content'>>();
  if (results.length === 0) throw notFound(name);
  return results.map(info);
}

/** Removes every version of a document. Agents cannot do this. */
export async function adminDeleteDocument(ctx: Ctx, projectId: number, name: string): Promise<void> {
  if (!(await exists(ctx, projectId, name))) throw notFound(name);
  await ctx.db.batch([
    ctx.db.prepare(`DELETE FROM documents WHERE project_id = ? AND name = ?`).bind(projectId, name),
    changeStmt(ctx, { projectId, actor: ADMIN, kind: 'document.deleted', subjectId: name }, { guarded: true }),
  ]);
}
