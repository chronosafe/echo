import type { Ctx } from '../ctx';
import { ruleError } from '../errors';
import { addMinutes } from '../time';
import { changeStmt, changesSince } from './changelog';

const ADMIN = { kind: 'admin' } as const;
const BACKOFF_MIN = [1, 5, 30, 120]; // after failures 1..4; the 5th failure skips the entry
const MAX_ATTEMPTS = 5;
const DELIVERY_TIMEOUT_MS = 10_000;

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))));
}

/** https, or http only for localhost and 127.0.0.1. Also the rule for the owner's notify_url. */
export function checkWebhookUrl(url: string, what = 'webhook URL', code = 'BAD_WEBHOOK_URL'): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw ruleError(code, `The ${what} is not a valid URL.`, 'Give a full https:// URL.');
  }
  const localHttp = parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  if (parsed.protocol !== 'https:' && !localHttp) {
    throw ruleError(code, `The ${what} must be https://, or http:// only for localhost or 127.0.0.1.`, 'Give a full https:// URL.');
  }
}

/**
 * The secret is returned here and never again. The cursor starts at the project's newest change entry,
 * so only later changes are sent (the webhook.added entry itself is not).
 */
export async function addWebhook(ctx: Ctx, projectId: number, url: string): Promise<{ id: number; secret: string }> {
  checkWebhookUrl(url);
  const project = await ctx.db.prepare(`SELECT id FROM projects WHERE id = ?`).bind(projectId).first();
  if (!project) throw ruleError('NO_SUCH_PROJECT', `There is no project ${projectId}.`, 'Check the project id.', 404);

  const secret = hex(crypto.getRandomValues(new Uint8Array(32)));
  // One batch: the hook and its webhook.added entry commit together, and the cursor lands on that entry
  // (so the hook is not told about its own creation, and no other change can slip past it).
  const res = await ctx.db.batch<{ id: number }>([
    ctx.db
      .prepare(
        `INSERT INTO webhooks (project_id, url, secret, cursor_seq, created_at)
         VALUES (?,?,?, (SELECT COALESCE(MAX(seq), 0) FROM change_log WHERE project_id = ?), ?) RETURNING id`,
      )
      .bind(projectId, url, secret, projectId, ctx.now()),
    changeStmt(ctx, { projectId, actor: ADMIN, kind: 'webhook.added', data: { url } }),
    ctx.db.prepare(`UPDATE change_log SET subject_id = (SELECT MAX(id) FROM webhooks) WHERE seq = (SELECT MAX(seq) FROM change_log)`),
    ctx.db
      .prepare(`UPDATE webhooks SET cursor_seq = (SELECT MAX(seq) FROM change_log WHERE project_id = ?) WHERE id = (SELECT MAX(id) FROM webhooks)`)
      .bind(projectId),
  ]);
  return { id: res[0].results[0].id, secret };
}

export async function removeWebhook(ctx: Ctx, id: number, inProject?: number): Promise<void> {
  const w = await ctx.db
    .prepare(`SELECT project_id, url, disabled_at FROM webhooks WHERE id = ?`)
    .bind(id)
    .first<{ project_id: number; url: string; disabled_at: string | null }>();
  if (!w || (inProject !== undefined && w.project_id !== inProject)) throw ruleError('NO_SUCH_WEBHOOK', `There is no webhook ${id}.`, 'Check the webhook id.', 404);
  if (w.disabled_at) return;
  await ctx.db.batch([
    ctx.db.prepare(`UPDATE webhooks SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL`).bind(ctx.now(), id),
    changeStmt(ctx, { projectId: w.project_id, actor: ADMIN, kind: 'webhook.removed', subjectId: id, data: { url: w.url } }, { guarded: true }),
  ]);
}

type Hook = { id: number; url: string; secret: string; project_id: number; cursor_seq: number; attempts: number };

/**
 * Sends each active webhook's next change entries, one request per entry, strictly in order: an entry that
 * fails holds back everything after it until it succeeds or is skipped after its 5th failure.
 */
export async function deliverWebhooks(ctx: Ctx, fetchFn: typeof fetch = fetch, maxPerRun = 40): Promise<number> {
  const { results: hooks } = await ctx.db
    .prepare(
      `SELECT id, url, secret, project_id, cursor_seq, attempts FROM webhooks
       WHERE disabled_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY id`,
    )
    .bind(ctx.now())
    .all<Hook>();

  let budget = maxPerRun;
  for (const h of hooks) {
    let cursor = h.cursor_seq;
    let attempts = h.attempts;
    while (budget > 0) {
      const [change] = await changesSince(ctx, h.project_id, cursor, 1);
      if (!change) break;
      budget--;
      const body = JSON.stringify(change);
      let failure: string | null = null;
      try {
        const res = await fetchFn(h.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Echo-Seq': String(change.seq),
            'X-Echo-Signature': `sha256=${await sign(h.secret, body)}`,
          },
          body,
          signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        });
        if (!res.ok) failure = `HTTP ${res.status}`;
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
      }

      // Every write is conditional on the cursor not having moved, so overlapping runs cannot go backwards.
      if (failure === null) {
        const r = await ctx.db
          .prepare(`UPDATE webhooks SET cursor_seq = ?, attempts = 0, next_attempt_at = NULL, last_error = NULL WHERE id = ? AND cursor_seq = ?`)
          .bind(change.seq, h.id, cursor)
          .run();
        if (!r.meta.changes) break;
        cursor = change.seq;
        attempts = 0;
        continue;
      }
      const error = `seq ${change.seq}: ${failure}`.slice(0, 500);
      attempts += 1;
      if (attempts >= MAX_ATTEMPTS) {
        await ctx.db
          .prepare(`UPDATE webhooks SET cursor_seq = ?, attempts = 0, next_attempt_at = NULL, last_error = ? WHERE id = ? AND cursor_seq = ?`)
          .bind(change.seq, `skipped after ${MAX_ATTEMPTS} failures, ${error}`, h.id, cursor)
          .run();
      } else {
        await ctx.db
          .prepare(`UPDATE webhooks SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ? AND cursor_seq = ?`)
          .bind(attempts, addMinutes(ctx.now(), BACKOFF_MIN[attempts - 1]), error, h.id, cursor)
          .run();
      }
      break;
    }
  }
  return maxPerRun - budget;
}

export type WebhookInfo = { id: number; url: string; createdAt: string; disabledAt: string | null; lastError: string | null };

/** For the admin page: never includes the secret. */
export async function listWebhooks(ctx: Ctx, projectId: number): Promise<WebhookInfo[]> {
  const { results } = await ctx.db
    .prepare(`SELECT id, url, created_at, disabled_at, last_error FROM webhooks WHERE project_id = ? ORDER BY id`)
    .bind(projectId)
    .all<{ id: number; url: string; created_at: string; disabled_at: string | null; last_error: string | null }>();
  return results.map((r) => ({ id: r.id, url: r.url, createdAt: r.created_at, disabledAt: r.disabled_at, lastError: r.last_error }));
}
