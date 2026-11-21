import type { Ctx } from '../ctx';
import type { Block, MergeDecision } from '../domain/approvals';
import { mergeDecision, windowEdgesBetween } from '../domain/approvals';
import { changeStmt } from '../domain/changelog';
import type { Actor } from '../types';
import type { FetchFn } from './app';
import { defaultFetch, findInstallation, ghRequest, InstallationGone } from './app';

/**
 * The `echo/hold` commit status (spec 6.7). Every change that can alter a PR's merge decision adds a status job
 * in its own batch; `runStatusJobs` (the cron, plus an immediate attempt after the request) computes the
 * decision, writes it to the PR's head commit, and retries failures forever.
 *
 * Concurrency: a run claims a job by moving `next_attempt_at` to a lease time. Any enqueue in the meantime resets
 * it to "now", so when the run finishes and its lease is gone, what it wrote may be stale: it then forgets the
 * written state and leaves the job due, and the next run writes the current decision.
 */

export const STATUS_CONTEXT = 'echo/hold';
export const NOT_INSTALLED = 'GitHub App not installed on this repository';
export const STATUS_CRON_KEY = 'status_cron_at';
const RECONCILE_CHUNK = 49; // plus the timestamp statement: at most 50 per batch
export const RECONCILE_KEY = 'status_reconcile_at';
/**
 * How long a confirmed status record is trusted. An older one is checked against GitHub's newest `echo/hold` status
 * for the commit, and the status is sent only if GitHub shows something else.
 */
export const STATUS_CACHE_TTL_MS = 600_000;
/** How often every open PR is re-enqueued, so a status that drifted on GitHub is corrected without any event. */
export const RECONCILE_INTERVAL_MS = 600_000;

const MAX_DESCRIPTION = 140;
const BACKOFF_MIN = [1, 2, 5, 10]; // then 10 minutes, forever
const LEASE_MS = 2 * 60_000;
const FIRST_RUN_LOOKBACK_MS = 60 * 60_000;
const ECHO: Actor = { kind: 'system', name: 'Echo' };

const UPSERT_JOB = `INSERT INTO status_jobs (repo_id, pr_number, attempts, next_attempt_at)`;
const ON_CONFLICT_DUE = `ON CONFLICT(repo_id, pr_number) DO UPDATE SET next_attempt_at = excluded.next_attempt_at`;

// ---------------------------------------------------------------- enqueue

/** Put in the same batch as the change: makes the PR's status job due now. */
export function enqueueStatus(ctx: Ctx, repoId: number, pr: number): D1PreparedStatement {
  return enqueueWithSharers(ctx, repoId, pr);
}

/**
 * The status belongs to the PR's head commit, which other open PRs may share: enqueue them too. A run working on
 * any of them then loses its lease, so a status it computed before this change is never left standing.
 * With `unlessNextAttemptAt`, nothing is enqueued while the PR's own job still carries that value: inside a job's
 * own batch this means "only if this run no longer holds the job".
 */
function enqueueWithSharers(ctx: Ctx, repoId: number, pr: number, unlessNextAttemptAt?: string): D1PreparedStatement {
  ctx.statusQueued = true;
  const guard =
    unlessNextAttemptAt === undefined
      ? 'WHERE true'
      : 'WHERE NOT EXISTS (SELECT 1 FROM status_jobs WHERE repo_id = ?1 AND pr_number = ?2 AND next_attempt_at = ?4)';
  return ctx.db
    .prepare(
      `${UPSERT_JOB}
       SELECT repo_id, pr_number, 0, ?3 FROM (
         SELECT ?1 AS repo_id, ?2 AS pr_number
         UNION
         SELECT s.repo_id, s.pr_number FROM pr_heads me JOIN pr_heads s ON s.repo_id = me.repo_id AND s.head_sha = me.head_sha
         WHERE me.repo_id = ?1 AND me.pr_number = ?2 AND s.open = 1
       ) ${guard}
       ${ON_CONFLICT_DUE}`,
    )
    .bind(repoId, pr, ctx.now(), ...(unlessNextAttemptAt === undefined ? [] : [unlessNextAttemptAt]));
}

/** Every open PR Echo knows of in one repository or in all of a project's repositories, plus their pending jobs. */
export function enqueueOpenPrs(ctx: Ctx, scope: { repoId: number } | { projectId: number }): D1PreparedStatement[] {
  ctx.statusQueued = true;
  const now = ctx.now();
  const [where, id] =
    'repoId' in scope ? ['ph.repo_id = ?', scope.repoId] : ['ph.repo_id IN (SELECT id FROM repos WHERE project_id = ?)', scope.projectId];
  return [
    ctx.db
      .prepare(`${UPSERT_JOB} SELECT ph.repo_id, ph.pr_number, 0, ? FROM pr_heads ph WHERE ph.open = 1 AND ${where} ${ON_CONFLICT_DUE}`)
      .bind(now, id),
    ctx.db
      .prepare(`UPDATE status_jobs SET next_attempt_at = ? WHERE ${where.replace(/ph\./g, '')} AND next_attempt_at > ?`)
      .bind(now, id, now),
  ];
}

// ---------------------------------------------------------------- describe

function clip(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
}

function blockText(b: Block, room: number): string {
  switch (b.kind) {
    case 'hold': {
      const head = `Blocked: ${b.hold.kind} hold by ${b.hold.placedBy} (`;
      const reasonRoom = room - [...head].length - 1;
      const reason = b.hold.reason.replace(/\s+/g, ' ').trim();
      return reasonRoom > 1 ? `${head}${clip(reason, reasonRoom)})` : clip(`${head}${reason})`, room);
    }
    case 'approval_missing':
      return clip(
        b.missing.length
          ? `Waiting for approval from ${b.missing.join(', ')}`
          : `No approvers asked for the ${hhmm(b.startsAt)} slot: move the event to send requests`,
        room,
      );
    case 'outside_window': {
      const w = Math.round((Date.parse(b.windowEnd) - Date.parse(b.startsAt)) / 60_000);
      return clip(`Outside approved slot (${hhmm(b.startsAt)} ±${Number.isFinite(w) ? w : '?'}m)`, room);
    }
    case 'no_slot':
      return clip('No approved merge slot', room);
  }
}

/** The status for a decision, its description within GitHub's 140 characters. */
export function describe(decision: MergeDecision): { state: 'success' | 'failure'; description: string } {
  if (decision.allowed) return { state: 'success', description: 'Clear: no holds' };
  const [first, ...rest] = decision.blocks;
  if (!first) return { state: 'failure', description: 'Blocked' };
  const more = rest.length ? ` +${rest.length} more` : '';
  return { state: 'failure', description: blockText(first, MAX_DESCRIPTION - more.length) + more };
}

// ---------------------------------------------------------------- run

type JobRow = {
  repo_id: number;
  pr_number: number;
  attempts: number;
  full_name: string;
  project_id: number;
  installation_id: number | null;
};
type HeadRow = { head_sha: string; open: number };

class NotInstalled extends Error {
  constructor() {
    super(NOT_INSTALLED);
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

/** A GitHub timestamp as stored (UTC ISO with milliseconds), or null when absent or unreadable. */
export function githubTime(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? iso(t) : null;
}

/**
 * Statements that store a PR's head as GitHub reported it. When the PR moves off its stored head or closes, the
 * other open PRs on that old head are enqueued first: their combined status on that commit may change.
 * `ghUpdatedAt` (pull_request.updated_at) orders deliveries: an older one than the stored one changes nothing.
 * Without it (an API read, which is current), the row is overwritten.
 */
export function storeHeadStmts(
  ctx: Ctx,
  h: { repoId: number; pr: number; sha: string; open: boolean; ghUpdatedAt: string | null; fromApi?: boolean },
): D1PreparedStatement[] {
  const now = ctx.now();
  const newer = h.fromApi ? '' : `WHERE excluded.gh_updated_at IS NULL OR pr_heads.gh_updated_at IS NULL OR excluded.gh_updated_at >= pr_heads.gh_updated_at`;
  const newerMe = h.fromApi ? '' : `AND (? IS NULL OR me.gh_updated_at IS NULL OR ? >= me.gh_updated_at)`;
  ctx.statusQueued = true;
  return [
    ctx.db
      .prepare(
        `${UPSERT_JOB} SELECT s.repo_id, s.pr_number, 0, ? FROM pr_heads s JOIN pr_heads me ON me.repo_id = s.repo_id AND me.head_sha = s.head_sha
         WHERE me.repo_id = ? AND me.pr_number = ? AND s.pr_number <> me.pr_number AND s.open = 1
           AND (me.head_sha <> ? OR (me.open = 1 AND ? = 0)) ${newerMe}
         ${ON_CONFLICT_DUE}`,
      )
      .bind(now, h.repoId, h.pr, h.sha, h.open ? 1 : 0, ...(h.fromApi ? [] : [h.ghUpdatedAt, h.ghUpdatedAt])),
    ctx.db
      .prepare(
        `INSERT INTO pr_heads (repo_id, pr_number, head_sha, open, gh_updated_at, updated_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(repo_id, pr_number) DO UPDATE SET head_sha = excluded.head_sha, open = excluded.open,
           gh_updated_at = COALESCE(excluded.gh_updated_at, pr_heads.gh_updated_at), updated_at = excluded.updated_at
         ${newer}`,
      )
      .bind(h.repoId, h.pr, h.sha, h.open ? 1 : 0, h.ghUpdatedAt, now),
  ];
}

/**
 * Enqueues the PRs whose approval window opened or closed since the last run. windowEdgesBetween is half-open,
 * [from, to); the range runs to now + 1 ms so a window opening at exactly now is included. A window that closes
 * at exactly now is still open (the end is inclusive); it falls in the next run's range too, which flips it.
 */
async function enqueueWindowEdges(ctx: Ctx, now: string): Promise<void> {
  const last = await ctx.db
    .prepare(`SELECT value FROM owner_settings WHERE key = ?`)
    .bind(STATUS_CRON_KEY)
    .first<{ value: string | null }>();
  const nowMs = Date.parse(now);
  const lastMs = last?.value ? Date.parse(last.value) : NaN;
  const fromMs = Number.isFinite(lastMs) ? Math.min(lastMs, nowMs) : nowMs - FIRST_RUN_LOOKBACK_MS;
  const edges = await windowEdgesBetween(ctx, iso(fromMs), iso(nowMs + 1));
  await ctx.db.batch([
    ...edges.map((e) => enqueueStatus(ctx, e.repoId, e.pr)),
    // Only ever forward, so overlapping runs cannot leave a gap.
    ctx.db
      .prepare(
        `INSERT INTO owner_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = CASE WHEN value IS NULL OR excluded.value > value THEN excluded.value ELSE value END`,
      )
      .bind(STATUS_CRON_KEY, now),
  ]);
}

/**
 * Runs `stmts` in batches of RECONCILE_CHUNK with `last` added to the final one, so `last` (a stamp) commits only
 * once everything before it has.
 */
async function batchInChunks(ctx: Ctx, stmts: D1PreparedStatement[], last: D1PreparedStatement): Promise<void> {
  for (let i = 0; i < stmts.length; i += RECONCILE_CHUNK) {
    const chunk = stmts.slice(i, i + RECONCILE_CHUNK);
    if (i + RECONCILE_CHUNK >= stmts.length) chunk.push(last);
    await ctx.db.batch(chunk);
  }
  if (!stmts.length) await ctx.db.batch([last]);
}

type ListedPull = { number?: unknown; state?: unknown; updated_at?: unknown; head?: { sha?: unknown } };

/**
 * Finds the open PRs Echo has no record of: open before their repository was registered, or whose `opened` delivery
 * was lost (or stored on an older head, or as closed). Lists `GET /repos/{r}/pulls?state=open&per_page=100`, the
 * first page only (100 open PRs; a repository with more has its later ones found by their own webhooks), and stores
 * and enqueues the PRs that are missing or differ.
 *
 * Every run lists the repositories never listed: newly registered ones (the column starts NULL) and those whose
 * installation just attached (attach clears it). When the reconcile is due, every installed repository is listed too.
 * Oldest-listed first, and at most `budget` GitHub requests per run, so the rest wait for the next run. A repository
 * without a known installation is looked up first (one request). Returns how many GitHub requests it made.
 */
async function listOpenPulls(ctx: Ctx, fetchFn: FetchFn, due: boolean, budget: number): Promise<number> {
  if (budget <= 0 || !githubAppConfigured(ctx)) return 0;
  const { results } = await ctx.db
    .prepare(
      `SELECT id, full_name, installation_id, prs_listed_at FROM repos
       WHERE prs_listed_at IS NULL OR (?1 = 1 AND installation_id IS NOT NULL)
       ORDER BY prs_listed_at IS NOT NULL, prs_listed_at, id LIMIT ?2`,
    )
    .bind(due ? 1 : 0, budget)
    .all<{ id: number; full_name: string; installation_id: number | null; prs_listed_at: string | null }>();
  let calls = 0;
  for (const repo of results) {
    if (calls >= budget) break;
    // Guarded by the value read, so an installation attaching meanwhile (which clears it) is listed again.
    const stamp = ctx.db
      .prepare(`UPDATE repos SET prs_listed_at = ? WHERE id = ? AND prs_listed_at IS ?`)
      .bind(ctx.now(), repo.id, repo.prs_listed_at);
    let inst = repo.installation_id;
    try {
      if (inst === null) {
        calls++;
        inst = await findInstallation(ctx.env, repo.full_name, fetchFn);
        if (inst === null) {
          await stamp.run(); // not installed: looked up again when an installation attaches
          continue;
        }
        await ctx.db.prepare(`UPDATE repos SET installation_id = ? WHERE id = ? AND installation_id IS NULL`).bind(inst, repo.id).run();
        if (calls >= budget) break; // listed next run, with the installation now known
      }
      calls++;
      const list = await ghRequest(ctx.env, inst, 'GET', `/repos/${repo.full_name}/pulls?state=open&per_page=100`, undefined, fetchFn);
      if (!Array.isArray(list)) throw new Error(`GitHub returned no pull request list for ${repo.full_name}.`);
      const open = (list as ListedPull[]).flatMap((p) =>
        Number.isInteger(p?.number) && (p.number as number) > 0 && p.state === 'open' && typeof p.head?.sha === 'string' && p.head.sha
          ? [{ pr: p.number as number, sha: p.head.sha, ghUpdatedAt: githubTime(p.updated_at) }]
          : [],
      );
      const { results: known } = await ctx.db
        .prepare(`SELECT pr_number, head_sha, open FROM pr_heads WHERE repo_id = ? AND pr_number IN (SELECT value FROM json_each(?))`)
        .bind(repo.id, JSON.stringify(open.map((p) => p.pr)))
        .all<{ pr_number: number; head_sha: string; open: number }>();
      const byPr = new Map(known.map((k) => [k.pr_number, k]));
      const stmts = open
        .filter((p) => {
          const k = byPr.get(p.pr);
          return !k || k.head_sha !== p.sha || !k.open;
        })
        // Ordered against webhook deliveries by updated_at, like a delivery: a newer stored head is kept.
        .flatMap((p) => [...storeHeadStmts(ctx, { repoId: repo.id, pr: p.pr, sha: p.sha, open: true, ghUpdatedAt: p.ghUpdatedAt }), enqueueStatus(ctx, repo.id, p.pr)]);
      await batchInChunks(ctx, stmts, stamp);
    } catch (e) {
      // The App was uninstalled: forget the id, and look it up again next run.
      if (e instanceof InstallationGone && inst !== null) {
        await ctx.db
          .prepare(`UPDATE repos SET installation_id = NULL, prs_listed_at = NULL WHERE id = ? AND installation_id = ?`)
          .bind(repo.id, inst)
          .run();
      }
      console.error(`listing open PRs of ${repo.full_name} failed`, e);
    }
  }
  return calls;
}

/**
 * Bounds how long GitHub and Echo's record of it can disagree: lists open PRs Echo has no record of (above), and
 * every RECONCILE_INTERVAL_MS enqueues every open PR of a registered repository. The new time is stored in the same
 * batch as the last enqueues, so a failure leaves it unmoved and the next run tries again. Returns how many PRs it
 * enqueued (0 when not yet due) and how many GitHub requests its listing made (at most `listBudget`).
 */
export async function reconcileOpenPrs(ctx: Ctx, fetchFn: FetchFn = defaultFetch, listBudget = 15): Promise<{ enqueued: number; githubCalls: number }> {
  const now = ctx.now();
  const last = await ctx.db.prepare(`SELECT value FROM owner_settings WHERE key = ?`).bind(RECONCILE_KEY).first<{ value: string | null }>();
  const lastMs = last?.value ? Date.parse(last.value) : NaN;
  const due = !(Number.isFinite(lastMs) && Date.parse(now) - lastMs < RECONCILE_INTERVAL_MS);
  const githubCalls = await listOpenPulls(ctx, fetchFn, due, listBudget);
  if (!due) return { enqueued: 0, githubCalls };
  const stampStmt = ctx.db
    .prepare(`INSERT INTO owner_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(RECONCILE_KEY, now);
  const { results } = await ctx.db
    .prepare(`SELECT ph.repo_id, ph.pr_number FROM pr_heads ph JOIN repos r ON r.id = ph.repo_id WHERE ph.open = 1`)
    .all<{ repo_id: number; pr_number: number }>();
  // Chunks keep each D1 batch small; the time goes in with the last chunk, so a failure leaves it unmoved.
  await batchInChunks(
    ctx,
    results.map((r) => enqueueStatus(ctx, r.repo_id, r.pr_number)),
    stampStmt,
  );
  return { enqueued: results.length, githubCalls };
}

async function loadHead(ctx: Ctx, repoId: number, pr: number): Promise<HeadRow | null> {
  return ctx.db
    .prepare(`SELECT head_sha, open FROM pr_heads WHERE repo_id = ? AND pr_number = ?`)
    .bind(repoId, pr)
    .first<HeadRow>();
}

/** Reads the PR from GitHub and stores its head and state; GitHub's answer is current, so it overwrites. */
async function confirmHead(ctx: Ctx, job: JobRow, installationId: number, fetchFn: FetchFn): Promise<HeadRow> {
  const pull = (await ghRequest(ctx.env, installationId, 'GET', `/repos/${job.full_name}/pulls/${job.pr_number}`, undefined, fetchFn)) as {
    state?: string;
    updated_at?: string;
    head?: { sha?: string };
  } | null;
  const sha = pull?.head?.sha;
  if (typeof sha !== 'string' || !sha) throw new Error(`GitHub returned no head commit for ${job.full_name}#${job.pr_number}.`);
  await ctx.db.batch(
    storeHeadStmts(ctx, { repoId: job.repo_id, pr: job.pr_number, sha, open: pull?.state === 'open', ghUpdatedAt: githubTime(pull?.updated_at), fromApi: true }),
  );
  const head = await loadHead(ctx, job.repo_id, job.pr_number);
  if (!head) throw new Error(`The head of ${job.full_name}#${job.pr_number} could not be stored.`);
  return head;
}

/**
 * A status belongs to a commit, and one commit can be the head of several open PRs. The state written is the AND
 * over all of them: failure if any may not merge, described by the first failing one (this job's PR first).
 */
async function commitStatus(ctx: Ctx, job: JobRow, sha: string): Promise<{ state: 'success' | 'failure'; description: string }> {
  const { results } = await ctx.db
    .prepare(`SELECT pr_number FROM pr_heads WHERE repo_id = ? AND head_sha = ? AND open = 1 ORDER BY pr_number`)
    .bind(job.repo_id, sha)
    .all<{ pr_number: number }>();
  const prs = results.map((r) => r.pr_number);
  if (!prs.includes(job.pr_number)) prs.push(job.pr_number);
  prs.sort((a, b) => a - b); // the same order in every sharer's job, so they agree on the description
  let clear: { state: 'success' | 'failure'; description: string } | null = null;
  for (const pr of prs) {
    const d = describe(await mergeDecision(ctx, job.full_name, pr));
    if (d.state === 'failure') return d;
    clear ??= d;
  }
  return clear!;
}

/** What GitHub was last confirmed to show for the commit; state NULL while a write is unconfirmed. */
async function shownStatus(ctx: Ctx, repoId: number, sha: string): Promise<{ state: string | null; description: string | null; updated_at: string } | null> {
  return ctx.db
    .prepare(`SELECT state, description, updated_at FROM commit_statuses WHERE repo_id = ? AND sha = ?`)
    .bind(repoId, sha)
    .first<{ state: string | null; description: string | null; updated_at: string }>();
}

/**
 * Records what GitHub now shows for the commit, but only while this run still holds its job (`lease`): a run that
 * lost its lease may have written a stale value after a newer one, so the commit is recorded as unknown (NULL)
 * instead, in the same statement, so no later call is needed to undo it.
 */
function confirmShownStmt(ctx: Ctx, repoId: number, pr: number, lease: string, sha: string, shown: { state: string; description: string }): D1PreparedStatement {
  const held = `EXISTS (SELECT 1 FROM status_jobs WHERE repo_id = ?1 AND pr_number = ?6 AND next_attempt_at = ?7)`;
  return ctx.db
    .prepare(
      `INSERT INTO commit_statuses (repo_id, sha, state, description, updated_at)
       VALUES (?1, ?2, CASE WHEN ${held} THEN ?3 END, CASE WHEN ${held} THEN ?4 END, ?5)
       ON CONFLICT(repo_id, sha) DO UPDATE SET state = excluded.state, description = excluded.description, updated_at = excluded.updated_at`,
    )
    .bind(repoId, sha, shown.state, shown.description, ctx.now(), pr, lease);
}

/**
 * The newest `echo/hold` status GitHub shows for a commit, or null when it shows none on the first page (GitHub
 * lists a commit's statuses newest first; 100 is the most one page holds). Read instead of re-sending an unchanged
 * status: GitHub keeps at most 1000 statuses per commit and context and refuses any more with a 422.
 */
async function githubShownStatus(ctx: Ctx, job: JobRow, installationId: number, sha: string, fetchFn: FetchFn): Promise<{ state: string; description: string } | null> {
  const list = await ghRequest(ctx.env, installationId, 'GET', `/repos/${job.full_name}/commits/${sha}/statuses?per_page=100`, undefined, fetchFn);
  if (!Array.isArray(list)) throw new Error(`GitHub returned no status list for ${job.full_name}@${sha}.`);
  const hit = (list as { context?: unknown; state?: unknown; description?: unknown }[]).find((x) => x?.context === STATUS_CONTEXT);
  if (!hit) return null;
  return { state: String(hit.state ?? ''), description: typeof hit.description === 'string' ? hit.description : '' };
}

function setShownStmt(ctx: Ctx, repoId: number, sha: string, shown: { state: string; description: string } | null): D1PreparedStatement {
  return ctx.db
    .prepare(
      `INSERT INTO commit_statuses (repo_id, sha, state, description, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(repo_id, sha) DO UPDATE SET state = excluded.state, description = excluded.description, updated_at = excluded.updated_at`,
    )
    .bind(repoId, sha, shown?.state ?? null, shown?.description ?? null, ctx.now());
}

async function runJob(ctx: Ctx, job: JobRow, fetchFn: FetchFn): Promise<void> {
  const key = [job.repo_id, job.pr_number] as const;
  const lease = iso(Date.parse(ctx.now()) + LEASE_MS);
  const claim = await ctx.db
    .prepare(`UPDATE status_jobs SET next_attempt_at = ? WHERE repo_id = ? AND pr_number = ? AND next_attempt_at <= ?`)
    .bind(lease, ...key, ctx.now())
    .run();
  if (!claim.meta.changes) return; // another run has it, or it is no longer due
  const deleteJob = () =>
    ctx.db.prepare(`DELETE FROM status_jobs WHERE repo_id = ? AND pr_number = ? AND next_attempt_at = ?`).bind(...key, lease);

  let installationId = job.installation_id;
  let attemptedSha: string | null = null; // set once a status POST has been sent: GitHub may have applied it
  try {
    if (installationId === null) {
      // Covers a repository registered after the App was installed, when no installation event will come.
      installationId = await findInstallation(ctx.env, job.full_name, fetchFn);
      if (installationId === null) throw new NotInstalled();
      await ctx.db.prepare(`UPDATE repos SET installation_id = ? WHERE id = ? AND installation_id IS NULL`).bind(installationId, job.repo_id).run();
    }
    const inst = installationId;

    // Webhook deliveries can arrive late or out of order, so the stored head is only a hint. Anything that would
    // let a merge through (a success, or dropping the job as closed) is first confirmed against GitHub. Writing
    // failure needs no confirmation: failing a commit that is no longer the head is harmless.
    let confirmed = false;
    let head = await loadHead(ctx, ...key);
    if (!head || !head.open) {
      head = await confirmHead(ctx, job, inst, fetchFn);
      confirmed = true;
    }
    if (!head.open) {
      await deleteJob().run();
      return;
    }
    let status = await commitStatus(ctx, job, head.head_sha);
    if (status.state === 'success' && !confirmed) {
      const before = head.head_sha;
      head = await confirmHead(ctx, job, inst, fetchFn);
      if (!head.open) {
        await deleteJob().run();
        return;
      }
      if (head.head_sha !== before) status = await commitStatus(ctx, job, head.head_sha);
    }

    const { state, description } = status;
    const sha = head.head_sha;
    const shown = await shownStatus(ctx, job.repo_id, sha);
    const same = (x: { state: string | null; description: string | null } | null) => x !== null && x.state === state && x.description === description;
    let write: boolean;
    let verified = false; // GitHub was read and already shows this status: refresh the record, send nothing
    if (shown === null) {
      write = true; // never written for this commit
    } else if (shown.state !== null && Date.parse(ctx.now()) - Date.parse(shown.updated_at) <= STATUS_CACHE_TTL_MS) {
      write = !same(shown);
    } else if (shown.state !== null && !same(shown)) {
      // Older than the TTL, but the decision has changed since Echo last confirmed a status: send it now. Reading
      // GitHub first would add nothing (the new status differs from the last one Echo sent) and, if the read
      // failed, would leave GitHub showing the old status, possibly success, through the backoff.
      write = true;
    } else {
      // Older than the TTL and unchanged, or unknown since an unconfirmed write: GitHub may have drifted, so ask it rather than
      // send the same status again (an unchanged re-send every interval would reach GitHub's 1000-per-commit limit).
      // A failed read throws to the backoff below, with nothing recorded.
      write = !same(await githubShownStatus(ctx, job, inst, sha, fetchFn));
      verified = !write;
    }
    if (write) {
      // Until GitHub confirms, nothing is known about this commit's status: a write that lands but is never
      // recorded (an error after GitHub applied it, a failed batch, a cancelled run) must not leave a stale
      // record that would make a later, different decision look already written.
      await setShownStmt(ctx, job.repo_id, sha, null).run();
      attemptedSha = sha;
      await ghRequest(
        ctx.env,
        inst,
        'POST',
        `/repos/${job.full_name}/statuses/${sha}`,
        { state, description, context: STATUS_CONTEXT, target_url: `${ctx.env.PUBLIC_URL}/admin/p/${job.project_id}` },
        fetchFn,
      );
    }
    // One batch: the record, the lease-loss requeue and the delete commit together or not at all.
    await ctx.db.batch([
      // The record is set only while this run holds its lease, whether GitHub confirmed a write or a read.
      ...(write || verified ? [confirmShownStmt(ctx, ...key, lease, sha, { state, description })] : []),
      // Lost the lease (enqueued again, or taken over, while this run worked): requeue this PR and its sharers so
      // the next run rewrites the current decision. Before the delete, which removes the lease row it tests.
      enqueueWithSharers(ctx, ...key, lease),
      ctx.db
        .prepare(`UPDATE repos SET last_status_ok = 1, last_status_error = NULL, last_status_at = ? WHERE id = ?`)
        .bind(ctx.now(), job.repo_id),
      ...(write
        ? [
            changeStmt(ctx, {
              projectId: job.project_id,
              actor: ECHO,
              kind: 'github.status',
              subjectId: job.pr_number,
              data: { repo: job.full_name, pr: job.pr_number, sha, state, description },
            }),
          ]
        : []),
      deleteJob(),
    ]);
  } catch (e) {
    const message = e instanceof NotInstalled ? NOT_INSTALLED : clip(e instanceof Error ? e.message : String(e), 500);
    const attempts = job.attempts + 1;
    const retryAt = iso(Date.parse(ctx.now()) + BACKOFF_MIN[Math.min(attempts, BACKOFF_MIN.length) - 1] * 60_000);
    await ctx.db.batch([
      // A job enqueued again meanwhile stays due now rather than waiting out the backoff.
      ctx.db
        .prepare(
          `UPDATE status_jobs SET attempts = attempts + 1, last_error = ?,
             next_attempt_at = CASE WHEN next_attempt_at = ? THEN ? ELSE next_attempt_at END
           WHERE repo_id = ? AND pr_number = ?`,
        )
        .bind(message, lease, retryAt, ...key),
      ctx.db
        .prepare(`UPDATE repos SET last_status_ok = 0, last_status_error = ?, last_status_at = ? WHERE id = ?`)
        .bind(message, ctx.now(), job.repo_id),
      // The App was uninstalled (or reinstalled under a new id): forget the stale id so the next attempt looks it up.
      ...(e instanceof InstallationGone && installationId !== null
        ? [ctx.db.prepare(`UPDATE repos SET installation_id = NULL WHERE id = ? AND installation_id = ?`).bind(job.repo_id, installationId)]
        : []),
      // A status POST that failed may still have been applied, possibly after a newer write by another run: the
      // commit's status is unknown. If this run lost the job meanwhile, nothing else may be left to correct it, so
      // requeue the PR and its sharers; if it still holds the job, the backoff above already retries it.
      ...(attemptedSha !== null
        ? [setShownStmt(ctx, job.repo_id, attemptedSha, null), enqueueWithSharers(ctx, ...key, retryAt)]
        : []),
    ]);
  }
}

/**
 * Runs up to `max` due status jobs, after enqueueing the PRs whose approval window opened or closed since the
 * last run. A job that cannot be completed backs off 1, 2, 5, 10 and then 10 minutes, forever.
 */
export async function runStatusJobs(ctx: Ctx, fetchFn: FetchFn = defaultFetch, max = 30): Promise<void> {
  const now = ctx.now();
  try {
    await enqueueWindowEdges(ctx, now);
  } catch (e) {
    // The due jobs still run; the edges are picked up next time (status_cron_at did not move).
    console.error('enqueueing approval-window edges failed', e);
  }
  if (!githubAppConfigured(ctx)) {
    // Nothing can be written without the App. Keep the jobs queued, due now and without errors, so the first run
    // after the App is configured writes them all; until then no write fails, so none is reported as failed.
    // Guarded by the WHERE clauses, so the cron writes nothing once they are cleared.
    await ctx.db.batch([
      ctx.db
        .prepare(`UPDATE status_jobs SET attempts = 0, next_attempt_at = ?, last_error = NULL WHERE attempts > 0 OR last_error IS NOT NULL`)
        .bind(now),
      ctx.db.prepare(`UPDATE repos SET last_status_error = NULL WHERE last_status_error IS NOT NULL`),
    ]);
    return;
  }
  // `max` is the run's budget of GitHub work: listing open PRs may use up to half of it, and each request it made
  // is one job fewer this run.
  let listCalls = 0;
  try {
    listCalls = (await reconcileOpenPrs(ctx, fetchFn, Math.floor(max / 2))).githubCalls;
  } catch (e) {
    console.error('reconciling open PRs failed', e);
  }
  // Due as of now, read after the enqueues above: they stamp their jobs with the clock as it is then, which on a
  // real clock is later than the start of this run, and they must run in this run.
  const { results } = await ctx.db
    .prepare(
      `SELECT j.repo_id, j.pr_number, j.attempts, r.full_name, r.project_id, r.installation_id
       FROM status_jobs j JOIN repos r ON r.id = j.repo_id
       WHERE j.next_attempt_at <= ? ORDER BY j.next_attempt_at, j.repo_id, j.pr_number LIMIT ?`,
    )
    .bind(ctx.now(), Math.max(0, max - listCalls))
    .all<JobRow>();
  for (const job of results) {
    try {
      await runJob(ctx, job, fetchFn);
    } catch (e) {
      // Recording the failure failed too (D1 trouble): the lease runs out and a later run retries.
      console.error(`status job ${job.full_name}#${job.pr_number} failed`, e);
    }
  }
}

/** Whether the GitHub App is configured; without it there is nothing an immediate attempt could do. */
export function githubAppConfigured(ctx: Ctx): boolean {
  return Boolean(ctx.env.GITHUB_APP_ID && ctx.env.GITHUB_APP_PRIVATE_KEY);
}

/**
 * The immediate first attempt after a request: once `after` settles (the request's work has committed), runs
 * the status jobs if the request enqueued any. The cron covers anything this misses.
 */
export function kickStatusJobs(ctx: Ctx, waitUntil: (p: Promise<unknown>) => void, after: Promise<unknown> = Promise.resolve()): void {
  if (!githubAppConfigured(ctx)) return;
  waitUntil(
    after
      .catch(() => {})
      .then(async () => {
        if (!ctx.statusQueued) return;
        ctx.statusQueued = false;
        await runStatusJobs(ctx);
      })
      .catch((e) => console.error('immediate status run failed', e)),
  );
}
