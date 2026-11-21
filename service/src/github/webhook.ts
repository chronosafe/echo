import type { Ctx } from '../ctx';
import { recordMerge } from '../domain/calendar';
import type { RepoRow } from '../domain/projects';
import { findRepo } from '../domain/projects';
import { errorJson, ruleError } from '../errors';
import type { Actor } from '../types';
import type { FetchFn } from './app';
import { enqueueOpenPrs, enqueueStatus, githubTime, storeHeadStmts } from './status';

const GITHUB: Actor = { kind: 'system', name: 'github' };
const HEAD_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review']);

type RepoRef = { full_name?: unknown };
type Payload = {
  action?: unknown;
  number?: unknown;
  installation?: { id?: unknown };
  repository?: RepoRef;
  repositories?: RepoRef[];
  repositories_added?: RepoRef[];
  repositories_removed?: RepoRef[];
  pull_request?: { number?: unknown; merged?: unknown; merged_at?: unknown; updated_at?: unknown; head?: { sha?: unknown } };
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ignored = (why: string) => json({ ok: true, ignored: why });

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * X-Hub-Signature-256 is `sha256=` + hex HMAC-SHA256 of the raw body under the webhook secret. Checked with
 * crypto.subtle.verify, which compares in constant time. No secret configured means nothing verifies.
 */
async function signatureValid(secret: string | undefined, header: string | null, body: Uint8Array): Promise<boolean> {
  if (!secret || !header) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, hexBytes(m[1]), body);
}

/** A registered repository by GitHub's name for it, in whatever case GitHub sends. */
async function registered(ctx: Ctx, ref: RepoRef | undefined): Promise<RepoRow | null> {
  if (typeof ref?.full_name !== 'string') return null;
  try {
    return await findRepo(ctx, ref.full_name);
  } catch {
    return null; // not a name Echo could have registered
  }
}

async function onPullRequest(ctx: Ctx, p: Payload): Promise<Response> {
  const repo = await registered(ctx, p.repository);
  if (!repo) return ignored('repository not registered');
  const pr = p.pull_request?.number ?? p.number;
  const action = typeof p.action === 'string' ? p.action : '';
  if (typeof pr !== 'number' || !Number.isInteger(pr) || pr < 1) return ignored('no pull request number');
  const sha = p.pull_request?.head?.sha;
  const now = ctx.now();
  const stmts: D1PreparedStatement[] = [];

  const installationId = p.installation?.id;
  if (typeof installationId === 'number' && installationId !== repo.installation_id) {
    stmts.push(ctx.db.prepare(`UPDATE repos SET installation_id = ? WHERE id = ?`).bind(installationId, repo.id));
  }
  // Deliveries can arrive late or twice: pull_request.updated_at orders them, and an older one leaves the stored
  // head alone. The status job still confirms against GitHub before anything that would allow a merge.
  const ghUpdatedAt = githubTime(p.pull_request?.updated_at);
  const store = (open: boolean) => storeHeadStmts(ctx, { repoId: repo.id, pr, sha: sha as string, open, ghUpdatedAt });

  if (HEAD_ACTIONS.has(action)) {
    if (typeof sha !== 'string' || !sha) return ignored('no head commit');
    // A new head has no echo/hold status until the job writes one, computed for that commit.
    stmts.push(...store(true), enqueueStatus(ctx, repo.id, pr));
  } else if (action === 'closed') {
    stmts.push(
      ...(typeof sha === 'string' && sha
        ? store(false)
        : [
            ctx.db
              .prepare(
                `UPDATE pr_heads SET open = 0, updated_at = ? WHERE repo_id = ? AND pr_number = ?
                   AND (? IS NULL OR gh_updated_at IS NULL OR ? >= gh_updated_at)`,
              )
              .bind(now, repo.id, pr, ghUpdatedAt, ghUpdatedAt),
          ]),
    );
  }
  if (stmts.length) await ctx.db.batch(stmts);

  if (action === 'closed' && p.pull_request?.merged === true) {
    const mergedAt = p.pull_request.merged_at;
    if (typeof mergedAt !== 'string') return ignored('merged without a merge time');
    // Idempotent: a merge the hook (or an earlier delivery) already recorded is returned, not recorded again.
    await recordMerge(ctx, GITHUB, { repo: repo.full_name, pr, mergedAt, source: 'github' });
  }
  return json({ ok: true });
}

/**
 * Points registered repositories at an installation and makes their status work due at once. Clearing
 * prs_listed_at makes the next cron run list the repository's open PRs, so PRs opened while the App was not
 * installed (whose webhooks never came) get a status too.
 */
async function attach(ctx: Ctx, installationId: number, refs: RepoRef[] | undefined): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  for (const ref of refs ?? []) {
    const repo = await registered(ctx, ref);
    if (!repo) continue;
    stmts.push(
      ctx.db.prepare(`UPDATE repos SET installation_id = ?, prs_listed_at = NULL WHERE id = ?`).bind(installationId, repo.id),
      ...enqueueOpenPrs(ctx, { repoId: repo.id }),
    );
  }
  if (stmts.length) await ctx.db.batch(stmts);
}

async function detach(ctx: Ctx, installationId: number, refs: RepoRef[] | undefined): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  for (const ref of refs ?? []) {
    const repo = await registered(ctx, ref);
    if (repo) stmts.push(ctx.db.prepare(`UPDATE repos SET installation_id = NULL WHERE id = ? AND installation_id = ?`).bind(repo.id, installationId));
  }
  if (stmts.length) await ctx.db.batch(stmts);
}

async function onInstallation(ctx: Ctx, event: string, p: Payload): Promise<Response> {
  const id = p.installation?.id;
  if (typeof id !== 'number') return ignored('no installation id');
  const action = typeof p.action === 'string' ? p.action : '';
  if (event === 'installation') {
    if (action === 'deleted' || action === 'suspend') {
      await ctx.db.prepare(`UPDATE repos SET installation_id = NULL WHERE installation_id = ?`).bind(id).run();
    } else if (action === 'created' || action === 'unsuspend' || action === 'new_permissions_accepted') {
      await attach(ctx, id, p.repositories);
    }
  } else {
    await attach(ctx, id, p.repositories_added);
    await detach(ctx, id, p.repositories_removed);
  }
  return json({ ok: true });
}

/**
 * The GitHub App's webhook. A delivery whose signature does not verify gets a 401 and changes nothing.
 * `fetchFn` is accepted like the other GitHub entry points; the receiver itself makes no GitHub calls.
 */
export async function handleGithubWebhook(ctx: Ctx, request: Request, _fetchFn?: FetchFn): Promise<Response> {
  const body = new Uint8Array(await request.arrayBuffer());
  if (!(await signatureValid(ctx.env.GITHUB_WEBHOOK_SECRET, request.headers.get('x-hub-signature-256'), body))) {
    return json(
      errorJson(ruleError('BAD_SIGNATURE', 'The webhook signature did not verify.', 'Check that the App webhook secret matches GITHUB_WEBHOOK_SECRET.', 401)),
      401,
    );
  }
  let payload: Payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(body)) as Payload;
  } catch {
    return json(errorJson(ruleError('BAD_REQUEST', 'The webhook body is not valid JSON.', 'Send the payload as JSON.')), 400);
  }
  if (!payload || typeof payload !== 'object') return ignored('empty payload');
  const event = request.headers.get('x-github-event') ?? '';
  if (event === 'pull_request') return onPullRequest(ctx, payload);
  if (event === 'installation' || event === 'installation_repositories') return onInstallation(ctx, event, payload);
  return ignored(`event ${event || '(none)'} not handled`);
}
