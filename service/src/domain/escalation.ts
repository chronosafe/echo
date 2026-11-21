import type { Ctx } from '../ctx';
import { changeStmt } from './changelog';
import { getOwnerSetting } from './projects';

const ECHO = { kind: 'system', name: 'Echo' } as const;
const BODY_CHARS = 300;
const NOTIFY_TIMEOUT_MS = 10_000;

type Due = {
  message_id: number;
  agent_id: number;
  project_id: number;
  project_name: string;
  sender_label: string;
  body: string;
  created_at: string;
  recipient: string;
  last_checked_in_at: string | null;
};

/** `2026-11-18T20:00:00.000Z` becomes `2026-11-18 20:00:00`. */
const utcText = (iso: string) => iso.replace('T', ' ').replace(/(\.\d+)?Z$/, '');

/** Header values must be ASCII: anything else is sent as an RFC 2047 encoded word, which ntfy decodes. */
function headerSafe(text: string): string {
  const clean = text.replace(/[\r\n\x00-\x1f\x7f]+/g, ' ');
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  const bytes = new TextEncoder().encode(clean);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(bin)}?=`;
}

/** The one place that POSTs to the owner's notify_url (ntfy-style headers); escalation and the admin test button both use it. */
export function postNotice(
  fetchFn: typeof fetch,
  url: string,
  n: { title: string; priority?: string; click?: string; body: string },
): Promise<Response> {
  return fetchFn(url, {
    method: 'POST',
    headers: { Title: headerSafe(n.title), Priority: n.priority ?? 'default', ...(n.click ? { Click: n.click } : {}) },
    body: n.body,
    signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
  });
}

/**
 * Tells the owner about each requires-ack recipient row that is past its escalate_at and still unanswered.
 * Approval requests whose event has merged or been cancelled no longer matter and are skipped.
 * A row is marked escalated only after the POST succeeds; two overlapping runs can both POST before either
 * marks it (the guarded UPDATE keeps the log to one entry).
 */
export async function runEscalations(ctx: Ctx, fetchFn: typeof fetch = fetch, max = 20): Promise<number> {
  const url = await getOwnerSetting(ctx, 'notify_url');
  if (!url) return 0;
  const now = ctx.now();
  const { results } = await ctx.db
    .prepare(
      `SELECT m.id AS message_id, r.agent_id, m.project_id, p.name AS project_name, m.sender_label, m.body, m.created_at,
              a.name AS recipient, a.last_checked_in_at
       FROM message_recipients r
       JOIN messages m ON m.id = r.message_id
       JOIN agents a ON a.id = r.agent_id
       JOIN projects p ON p.id = m.project_id
       LEFT JOIN events e ON m.kind = 'approval_request' AND e.id = m.ref_id
       WHERE m.escalate_at <= ?1 AND r.acked_at IS NULL AND r.escalated_at IS NULL
         AND m.withdrawn_at IS NULL
         AND (r.deferred_until IS NULL OR r.deferred_until <= ?1)
         AND (m.kind <> 'approval_request' OR (e.id IS NOT NULL AND e.merged_at IS NULL AND e.cancelled_at IS NULL))
       ORDER BY m.escalate_at, m.id, r.agent_id
       LIMIT ?2`,
    )
    .bind(now, max)
    .all<Due>();

  let sent = 0;
  for (const d of results) {
    const text =
      `${d.recipient} has not answered ${d.sender_label}'s message in ${d.project_name} ` +
      `(sent ${utcText(d.created_at)} UTC; last check-in ${d.last_checked_in_at ? `${utcText(d.last_checked_in_at)} UTC` : 'never'}):\n` +
      Array.from(d.body).slice(0, BODY_CHARS).join('');
    try {
      const res = await postNotice(fetchFn, url, {
        title: `Echo: unanswered message for ${d.recipient}`,
        priority: 'high',
        click: `${ctx.env.PUBLIC_URL}/admin/p/${d.project_id}`,
        body: text,
      });
      if (!res.ok) {
        console.error('escalation notice rejected; will retry', d.message_id, d.recipient, res.status);
        // The endpoint is struggling (5xx, 429): stop and retry next run. Any other 4xx is about this row; move on.
        if (res.status >= 500 || res.status === 429) break;
        continue;
      }
    } catch (e) {
      console.error('escalation notice failed; will retry', d.message_id, d.recipient, e instanceof Error ? e.message : e);
      break; // thrown error or timeout: the endpoint is unreachable, so try again next run
    }
    await ctx.db.batch([
      ctx.db
        .prepare(`UPDATE message_recipients SET escalated_at = ? WHERE message_id = ? AND agent_id = ? AND escalated_at IS NULL`)
        .bind(ctx.now(), d.message_id, d.agent_id),
      changeStmt(
        ctx,
        { projectId: d.project_id, actor: ECHO, kind: 'message.escalated', subjectId: d.message_id, data: { recipient: d.recipient } },
        { guarded: true },
      ),
    ]);
    sent++;
  }
  return sent;
}
