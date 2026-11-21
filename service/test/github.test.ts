import { createExecutionContext, createScheduledController, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { approveMerge, mergeDecision, registerApprovals } from '../src/domain/approvals';
import type { MergeDecision } from '../src/domain/approvals';
import { addEvent, recordMerge } from '../src/domain/calendar';
import { changesSince } from '../src/domain/changelog';
import type { HoldView } from '../src/domain/holds';
import { placeHold, releaseHold } from '../src/domain/holds';
import { registerRepo, updateProjectSettings } from '../src/domain/projects';
import { appJwt, installationToken, resetInstallationTokens } from '../src/github/app';
import { describe as describeDecision, enqueueStatus, RECONCILE_INTERVAL_MS, runStatusJobs, STATUS_CACHE_TTL_MS, STATUS_CONTEXT } from '../src/github/status';
import { handleGithubWebhook } from '../src/github/webhook';
import worker from '../src/index';
import { fakeGithub } from './fake-github';
import { seed, testCtx } from './helpers';

const SECRET = 'test-webhook-secret';
const INSTALLATION = 77;
let pem: string;
let publicKey: CryptoKey;

function b64(bytes: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const der = b64((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
  publicKey = pair.publicKey;
});

const base = testCtx();
const ctx = Object.assign(base, { env: { ...env } });
let gh: ReturnType<typeof fakeGithub>;
let s: Awaited<ReturnType<typeof seed>>;

async function setup() {
  ctx.setNow('2026-11-18T20:00:00.000Z');
  ctx.env = { ...env, GITHUB_API_URL: 'https://gh.test', GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY: pem, GITHUB_WEBHOOK_SECRET: SECRET };
  gh = fakeGithub();
  resetInstallationTokens();
  registerApprovals(); // other test files clear the calendar hooks
  s = await seed(ctx);
  await ctx.db.prepare(`UPDATE repos SET installation_id = ? WHERE id = ?`).bind(INSTALLATION, s.repo.id).run();
}

beforeEach(() => setup());

async function hmacHex(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Delivers a signed webhook. For pull_request events the fake GitHub is first brought to the state the payload
 * describes (as GitHub would be), unless `sync: false` models a late or replayed delivery.
 */
async function deliver(event: string, payload: any, opts: { secret?: string; signature?: string | null; sync?: boolean } = {}) {
  if (event === 'pull_request' && opts.sync !== false && payload?.pull_request) {
    gh.pulls.set(`${String(payload.repository.full_name).toLowerCase()}#${payload.pull_request.number}`, {
      head: payload.pull_request.head.sha,
      state: payload.pull_request.state,
      mergedAt: payload.pull_request.merged_at,
    });
  }
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'x-github-event': event, 'content-type': 'application/json' };
  const sig = opts.signature === undefined ? `sha256=${await hmacHex(body, opts.secret ?? SECRET)}` : opts.signature;
  if (sig !== null) headers['x-hub-signature-256'] = sig;
  return handleGithubWebhook(ctx, new Request('https://echo.test/github/webhook', { method: 'POST', headers, body }), gh.fetch);
}

function pr(
  action: string,
  o: { repo?: string; number?: number; head?: string; merged?: boolean; mergedAt?: string | null; installation?: number; updatedAt?: string } = {},
) {
  const number = o.number ?? 709;
  return {
    action,
    number,
    pull_request: {
      number,
      state: action === 'closed' ? 'closed' : 'open',
      merged: o.merged ?? false,
      merged_at: o.mergedAt ?? null,
      ...(o.updatedAt ? { updated_at: o.updatedAt } : {}),
      head: { sha: o.head ?? 'abc' },
    },
    repository: { full_name: o.repo ?? 'acme/app' },
    installation: { id: o.installation ?? INSTALLATION },
  };
}

const job = (n = 709) =>
  ctx.db
    .prepare(`SELECT attempts, next_attempt_at, last_error FROM status_jobs WHERE repo_id = ? AND pr_number = ?`)
    .bind(s.repo.id, n)
    .first<{ attempts: number; next_attempt_at: string; last_error: string | null }>();
const head = (n = 709) =>
  ctx.db
    .prepare(`SELECT head_sha, open FROM pr_heads WHERE repo_id = ? AND pr_number = ?`)
    .bind(s.repo.id, n)
    .first<{ head_sha: string; open: number }>();
/** What Echo recorded as GitHub's confirmed echo/hold status for a commit. */
const shown = (sha: string) =>
  ctx.db
    .prepare(`SELECT state, description FROM commit_statuses WHERE repo_id = ? AND sha = ?`)
    .bind(s.repo.id, sha)
    .first<{ state: string | null; description: string | null }>();
const repoRow = () =>
  ctx.db
    .prepare(`SELECT installation_id, last_status_ok, last_status_error, last_status_at FROM repos WHERE id = ?`)
    .bind(s.repo.id)
    .first<{ installation_id: number | null; last_status_ok: number | null; last_status_error: string | null; last_status_at: string | null }>();
const count = async (sql: string) => (await ctx.db.prepare(sql).first<{ n: number }>())!.n;
/** Keeps the reconcile's PR listing out of a test about the job path: every repository listed, reconcile not due. */
const listingDone = () =>
  ctx.db.batch([
    ctx.db.prepare(`UPDATE repos SET prs_listed_at = '2026-11-18T19:59:00.000Z'`),
    ctx.db.prepare(`INSERT INTO owner_settings (key, value) VALUES ('status_reconcile_at', '2099-01-01T00:00:00.000Z') ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  ]);
const at = (iso: string, plusMin: number) => new Date(Date.parse(iso) + plusMin * 60_000).toISOString();

describe('echo/hold status', () => {
  it('placing a blocking hold sets failure on the head; releasing sets success', async () => {
    gh.pulls.set('acme/app#709', { head: 'abc', state: 'open', mergedAt: null });
    const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 709, reason: 'finding' });
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses.at(-1)).toMatchObject({ repo: 'acme/app', sha: 'abc', state: 'failure', description: expect.stringContaining('Alice') });
    await releaseHold(ctx, s.alice.id, h.id, 'ok');
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'abc', state: 'success' });
    expect(gh.statuses).toHaveLength(2);
    expect(await job()).toBeNull();
    expect(await repoRow()).toMatchObject({ last_status_ok: 1, last_status_error: null, last_status_at: '2026-11-18T20:00:00.000Z' });
    expect((await changesSince(ctx, s.project.id, 0)).filter((c) => c.kind === 'github.status')).toHaveLength(2);
  });

  it('writes the echo/hold context with a link to the project admin page', async () => {
    const seen: { context?: string; target_url?: string }[] = [];
    const spy: typeof fetch = async (input, init) => {
      const req = new Request(input as RequestInfo, init);
      if (/\/statuses\//.test(new URL(req.url).pathname)) seen.push(await req.clone().json());
      return gh.fetch(req);
    };
    gh.pulls.set('acme/app#709', { head: 'abc', state: 'open', mergedAt: null });
    await ctx.db.batch([enqueueStatus(ctx, s.repo.id, 709)]);
    await runStatusJobs(ctx, spy);
    expect(STATUS_CONTEXT).toBe('echo/hold');
    expect(seen).toEqual([expect.objectContaining({ context: 'echo/hold', target_url: `${ctx.env.PUBLIC_URL}/admin/p/${s.project.id}` })]);
  });

  it('a synchronize event with a new head gets a status for the new sha', async () => {
    expect((await deliver('pull_request', pr('opened', { head: 'abc' }))).status).toBe(200);
    await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 709, reason: 'finding' });
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses).toEqual([expect.objectContaining({ sha: 'abc', state: 'failure' })]);

    expect((await deliver('pull_request', pr('synchronize', { head: 'def' }))).status).toBe(200);
    expect(await head()).toMatchObject({ head_sha: 'def', open: 1 });
    // Until the job runs, the new commit has no echo/hold status at all (GitHub refuses the merge).
    expect(gh.statuses.filter((x) => x.sha === 'def')).toHaveLength(0);
    expect(await job()).not.toBeNull();
    await runStatusJobs(ctx, gh.fetch);
    // Recomputed for the new sha, not copied from the old one: the hold still blocks it.
    expect(gh.statuses.at(-1)).toMatchObject({ repo: 'acme/app', sha: 'def', state: 'failure', description: expect.stringContaining('Alice') });
    expect(await shown('def')).toMatchObject({ state: 'failure' });
    expect(await shown('abc')).toMatchObject({ state: 'failure' }); // the old commit keeps its own record
  });

  it('a webhook with a bad signature is refused with 401', async () => {
    const tries = [
      await deliver('pull_request', pr('opened'), { secret: 'wrong-secret' }),
      await deliver('pull_request', pr('opened'), { signature: null }),
      await deliver('pull_request', pr('opened'), { signature: 'sha256=' + '0'.repeat(64) }),
      await deliver('pull_request', pr('opened'), { signature: 'sha1=abcdef' }),
      await deliver('pull_request', pr('opened'), { signature: 'sha256=zz' }),
    ];
    for (const res of tries) {
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ ok: false, error: { kind: 'rule', code: 'BAD_SIGNATURE' } });
    }
    // A body altered after signing is refused too.
    const body = JSON.stringify(pr('opened'));
    const sig = `sha256=${await hmacHex(body, SECRET)}`;
    const tampered = new Request('https://echo.test/github/webhook', {
      method: 'POST',
      headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': sig },
      body: body.replace('"abc"', '"evil"'),
    });
    expect((await handleGithubWebhook(ctx, tampered, gh.fetch)).status).toBe(401);
    // No side effects.
    expect(await count(`SELECT COUNT(*) AS n FROM pr_heads`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM status_jobs`)).toBe(0);
    expect(gh.statuses).toHaveLength(0);
    // With no secret configured, every delivery is refused.
    ctx.env = { ...ctx.env, GITHUB_WEBHOOK_SECRET: undefined };
    expect((await deliver('pull_request', pr('opened'))).status).toBe(401);
    expect(await count(`SELECT COUNT(*) AS n FROM pr_heads`)).toBe(0);
  });

  it('the /github/webhook route refuses an unsigned delivery', async () => {
    const res = await SELF.fetch('https://echo.test/github/webhook', {
      method: 'POST',
      headers: { 'x-github-event': 'pull_request', 'content-type': 'application/json' },
      body: JSON.stringify(pr('opened')),
    });
    expect(res.status).toBe(401);
    expect(await count(`SELECT COUNT(*) AS n FROM pr_heads`)).toBe(0);
  });

  it('GitHub failures are retried with backoff and the job survives', async () => {
    await deliver('pull_request', pr('opened', { head: 'abc' }));
    gh.fail(1000);
    const t0 = '2026-11-18T20:00:00.000Z';
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses).toHaveLength(0);
    expect(await job()).toMatchObject({ attempts: 1, next_attempt_at: at(t0, 1), last_error: expect.stringContaining('500') });
    expect(await repoRow()).toMatchObject({ last_status_ok: 0, last_status_error: expect.stringContaining('500') });

    // Not due yet: nothing happens.
    ctx.setNow(at(t0, 0.5));
    await runStatusJobs(ctx, gh.fetch);
    expect((await job())!.attempts).toBe(1);

    // 1, 2, 5, 10 and then 10 minutes, forever.
    let now = at(t0, 1);
    for (const [attempts, delay] of [[2, 2], [3, 5], [4, 10], [5, 10], [6, 10]] as const) {
      ctx.setNow(now);
      await runStatusJobs(ctx, gh.fetch);
      expect(await job()).toMatchObject({ attempts, next_attempt_at: at(now, delay) });
      now = at(now, delay);
    }

    gh.fail(0);
    ctx.setNow(now);
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses).toEqual([expect.objectContaining({ sha: 'abc', state: 'success', description: 'Clear: no holds' })]);
    expect(await job()).toBeNull();
    expect(await repoRow()).toMatchObject({ last_status_ok: 1, last_status_error: null });
  });

  it('an approval window opening flips the status to success without any other event', async () => {
    await ctx.db.prepare(`UPDATE projects SET approvals_required = 1 WHERE id = ?`).bind(s.project.id).run();
    gh.pulls.set('acme/app#709', { head: 'abc', state: 'open', mergedAt: null });
    const ev = await addEvent(ctx, s.bobA, { projectId: s.project.id, title: 'merge', startsAt: '2026-11-18T21:00:00Z', kind: 'merge', repo: 'acme/app', pr: 709 });
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses).toEqual([expect.objectContaining({ sha: 'abc', state: 'failure', description: 'Outside approved slot (21:00Z ±30m)' })]);

    await approveMerge(ctx, s.alice.id, ev.id);
    expect(await job()).not.toBeNull(); // the approval enqueued a recheck
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses).toHaveLength(1); // still outside the window: same state, nothing written

    // Pin the reconcile off so the window edges are what get exercised.
    await ctx.db.prepare(`INSERT INTO owner_settings (key, value) VALUES ('status_reconcile_at', '2099-01-01T00:00:00.000Z') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
    // A TTL-stale record may still be re-sent; what matters an identical status (the record is older than the TTL); what matters
    // is that nothing flips before the window edges.
    const states = () => gh.statuses.map((x) => x.state);
    ctx.setNow('2026-11-18T20:29:59.999Z');
    await runStatusJobs(ctx, gh.fetch);
    expect(states().every((x) => x === 'failure')).toBe(true);

    // The window opens at exactly 20:30:00.000; the next cron run flips it with nothing else happening.
    ctx.setNow('2026-11-18T20:30:00.000Z');
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'abc', state: 'success' });
    const successes = states().filter((x) => x === 'success').length;
    expect(successes).toBe(1);

    // Still allowed at exactly 21:30:00.000 (inclusive end) ...
    ctx.setNow('2026-11-18T21:30:00.000Z');
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'abc', state: 'success' });
    // ... and refused on the first run after it.
    ctx.setNow('2026-11-18T21:30:00.001Z');
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'abc', state: 'failure', description: 'Outside approved slot (21:00Z ±30m)' });
  });

  it('pull_request closed+merged records the merge once, even if the hook already reported it', async () => {
    await deliver('pull_request', pr('opened'));
    await recordMerge(ctx, s.bobA, { repo: 'acme/app', pr: 709, mergedAt: '2026-11-18T20:10:00Z', source: 'hook' });
    const closed = pr('closed', { repo: 'Acme/App', merged: true, mergedAt: '2026-11-18T20:10:00Z' });
    expect((await deliver('pull_request', closed)).status).toBe(200);
    expect((await deliver('pull_request', closed)).status).toBe(200); // GitHub redelivers
    const rows = await ctx.db
      .prepare(`SELECT merged_at, merged_by FROM events WHERE repo_id = ? AND pr_number = 709 AND merged_at IS NOT NULL`)
      .bind(s.repo.id)
      .all<{ merged_at: string; merged_by: string }>();
    expect(rows.results).toEqual([{ merged_at: '2026-11-18T20:10:00.000Z', merged_by: 'Bob' }]);
    expect((await changesSince(ctx, s.project.id, 0)).filter((c) => c.kind === 'merge.recorded')).toHaveLength(1);
    expect(await head()).toMatchObject({ open: 0 });

    // GitHub first, then the hook: one row, recorded by github, with GitHub's merge time.
    await deliver('pull_request', pr('closed', { number: 710, merged: true, mergedAt: '2026-11-18T20:20:00Z' }));
    const again = await recordMerge(ctx, s.bobA, { repo: 'acme/app', pr: 710, mergedAt: '2026-11-18T20:20:00Z', source: 'hook' });
    expect(again).toMatchObject({ mergedBy: 'github', mergedAt: '2026-11-18T20:20:00.000Z' });
    expect(await count(`SELECT COUNT(*) AS n FROM events WHERE pr_number = 710`)).toBe(1);
  });

  it('a closed PR that was not merged records nothing and its job is deleted without writing', async () => {
    await deliver('pull_request', pr('opened'));
    await deliver('pull_request', pr('closed'));
    expect(await head()).toMatchObject({ open: 0 });
    await ctx.db.batch([enqueueStatus(ctx, s.repo.id, 709)]);
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses).toHaveLength(0);
    expect(await job()).toBeNull();
    expect(await count(`SELECT COUNT(*) AS n FROM events`)).toBe(0);

    // A PR Echo has never seen is looked up on GitHub; a closed one is skipped the same way.
    gh.pulls.set('acme/app#800', { head: 'fff', state: 'closed', mergedAt: null });
    await ctx.db.batch([enqueueStatus(ctx, s.repo.id, 800)]);
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses).toHaveLength(0);
    expect(await job(800)).toBeNull();
    expect(await head(800)).toMatchObject({ head_sha: 'fff', open: 0 });
  });

  it('payload repository names in mixed case match the registered repository', async () => {
    await ctx.db.prepare(`UPDATE repos SET installation_id = NULL`).run();
    const inst = await deliver('installation', { action: 'created', installation: { id: 555 }, repositories: [{ full_name: 'ACME/App' }, { full_name: 'Someone/Else' }] });
    expect(inst.status).toBe(200);
    expect((await repoRow())!.installation_id).toBe(555);

    expect((await deliver('pull_request', pr('opened', { repo: 'Acme/APP', head: 'MixedSha1', installation: 555 }))).status).toBe(200);
    expect(await head()).toMatchObject({ head_sha: 'MixedSha1', open: 1 });
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses).toEqual([expect.objectContaining({ repo: 'acme/app', sha: 'MixedSha1', state: 'success' })]);

    // An unregistered repository is acknowledged and ignored.
    const other = await deliver('pull_request', pr('opened', { repo: 'Someone/Else', number: 1 }));
    expect(other.status).toBe(200);
    expect(await count(`SELECT COUNT(*) AS n FROM pr_heads`)).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM status_jobs`)).toBe(0);

    // installation_repositories removed/added, again in GitHub's case.
    await deliver('installation_repositories', { action: 'removed', installation: { id: 555 }, repositories_removed: [{ full_name: 'Acme/App' }], repositories_added: [] });
    expect((await repoRow())!.installation_id).toBeNull();
    await deliver('installation_repositories', { action: 'added', installation: { id: 556 }, repositories_added: [{ full_name: 'acme/APP' }], repositories_removed: [] });
    expect((await repoRow())!.installation_id).toBe(556);
    await deliver('installation', { action: 'deleted', installation: { id: 556 }, repositories: [{ full_name: 'Acme/App' }] });
    expect((await repoRow())!.installation_id).toBeNull();
  });

  it('an unchanged state and sha does not write a duplicate status', async () => {
    await deliver('pull_request', pr('opened', { head: 'abc' }));
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses).toHaveLength(1);
    await deliver('pull_request', pr('ready_for_review', { head: 'abc' }));
    await ctx.db.batch([enqueueStatus(ctx, s.repo.id, 709)]);
    expect(await job()).not.toBeNull();
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses).toHaveLength(1);
    expect(await job()).toBeNull();
    // A reopened PR with the same head and state is not rewritten either.
    await deliver('pull_request', pr('reopened', { head: 'abc' }));
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses).toHaveLength(1);
  });

  it('a repository without the App installed records why and backs off; installing it resumes the job', async () => {
    await ctx.db.prepare(`UPDATE repos SET installation_id = NULL`).run();
    await listingDone();
    const requests: string[] = [];
    const notInstalled: typeof fetch = async (input, init) => {
      const req = new Request(input as RequestInfo, init);
      requests.push(`${req.method} ${new URL(req.url).pathname}`);
      if (/\/installation$/.test(new URL(req.url).pathname)) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      return gh.fetch(req);
    };
    await deliver('pull_request', { ...pr('opened'), installation: undefined });
    await runStatusJobs(ctx, notInstalled);
    expect(gh.statuses).toHaveLength(0);
    expect(requests).toEqual(['GET /repos/acme/app/installation']);
    expect(await repoRow()).toMatchObject({ installation_id: null, last_status_ok: 0, last_status_error: 'GitHub App not installed on this repository' });
    expect(await job()).toMatchObject({ attempts: 1, next_attempt_at: at('2026-11-18T20:00:00.000Z', 1), last_error: 'GitHub App not installed on this repository' });

    ctx.setNow('2026-11-18T20:00:30.000Z');
    await deliver('installation_repositories', { action: 'added', installation: { id: 91 }, repositories_added: [{ full_name: 'Acme/App' }], repositories_removed: [] });
    expect((await repoRow())!.installation_id).toBe(91);
    expect((await job())!.next_attempt_at).toBe('2026-11-18T20:00:30.000Z'); // due again at once, not after the backoff
    await runStatusJobs(ctx, notInstalled);
    expect(gh.statuses).toEqual([expect.objectContaining({ sha: 'abc', state: 'success' })]);
    expect(await repoRow()).toMatchObject({ last_status_ok: 1, last_status_error: null });
  });

  it('a repository registered after the App was installed finds its installation', async () => {
    await ctx.db.prepare(`UPDATE repos SET installation_id = NULL`).run();
    gh.pulls.set('acme/app#709', { head: 'abc', state: 'open', mergedAt: null });
    await ctx.db.batch([enqueueStatus(ctx, s.repo.id, 709)]);
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses).toEqual([expect.objectContaining({ sha: 'abc', state: 'success' })]);
    expect((await repoRow())!.installation_id).toBe(1); // the fake's installation id
  });

  it('a change that lands while a status is being written keeps the job, so the newer state follows', async () => {
    await deliver('pull_request', pr('opened', { head: 'abc' }));
    let raced = false;
    const racing: typeof fetch = async (input, init) => {
      const req = new Request(input as RequestInfo, init);
      if (!raced && /\/statuses\//.test(new URL(req.url).pathname)) {
        raced = true;
        await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 709, reason: 'landed mid-write' });
      }
      return gh.fetch(req);
    };
    await runStatusJobs(ctx, racing);
    expect(gh.statuses).toEqual([expect.objectContaining({ state: 'success' })]); // computed before the hold
    expect(await job()).not.toBeNull();
    await runStatusJobs(ctx, racing);
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'abc', state: 'failure', description: expect.stringContaining('landed mid-write') });
    expect(await job()).toBeNull();
  });

  it('two overlapping runs never leave a stale status on GitHub', async () => {
    await deliver('pull_request', pr('opened', { head: 'abc' }));
    let writes = 0;
    let bPosted!: () => void;
    const bPostedP = new Promise<void>((r) => (bPosted = r));
    let aDone!: () => void;
    const aDoneP = new Promise<void>((r) => (aDone = r));
    let runB: Promise<void> = Promise.resolve();
    const interleave: typeof fetch = async (input, init) => {
      const req = new Request(input as RequestInfo, init);
      if (!/\/statuses\//.test(new URL(req.url).pathname)) return gh.fetch(req);
      writes++;
      if (writes === 1) {
        // Run A computed success; a hold lands and run B takes the job before A's write reaches GitHub.
        await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 709, reason: 'late finding' });
        ctx.setNow('2026-11-18T20:00:00.001Z');
        runB = runStatusJobs(ctx, interleave);
        await bPostedP;
        return gh.fetch(req); // A's stale success lands after B's failure
      }
      if (writes === 2) {
        const res = await gh.fetch(req);
        bPosted();
        await aDoneP; // B records its result only after A has finished
        return res;
      }
      return gh.fetch(req);
    };
    await runStatusJobs(ctx, interleave); // A
    aDone();
    await runB;
    expect(gh.statuses.map((x) => x.state)).toEqual(['failure', 'success']); // GitHub now shows the stale one
    expect(await job()).not.toBeNull();
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'abc', state: 'failure', description: expect.stringContaining('late finding') });
    expect(await job()).toBeNull();
  });

  it('turning approvals on for a project rechecks its open PRs', async () => {
    await deliver('pull_request', pr('opened', { head: 'abc' }));
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses.at(-1)).toMatchObject({ state: 'success' });
    await updateProjectSettings(ctx, s.project.id, { approvalsRequired: true });
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'abc', state: 'failure', description: 'No approved merge slot' });
  });

  it('runs at most `max` jobs per call', async () => {
    await listingDone();
    for (const n of [1, 2, 3]) await deliver('pull_request', pr('opened', { number: n, head: `h${n}` }));
    await runStatusJobs(ctx, gh.fetch, 2);
    expect(gh.statuses).toHaveLength(2);
    await runStatusJobs(ctx, gh.fetch, 2);
    expect(gh.statuses).toHaveLength(3);
  });

  it('a hold placed over MCP gets its status written straight after the response, without the cron', async () => {
    gh.pulls.set('acme/app#709', { head: 'abc', state: 'open', mergedAt: null });
    // The immediate attempt uses the global fetch: route it to the fake so nothing leaves the test.
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => gh.fetch(input, init));
    try {
      const exec = createExecutionContext();
      const res = await worker.fetch(
        new Request('https://echo.test/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${s.alice.token}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo_place_hold', arguments: { repo: 'acme/app', pr: 709, reason: 'via mcp' } } }),
        }),
        ctx.env,
        exec,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('via mcp'); // the wrapped stream still carries the whole reply
      await waitOnExecutionContext(exec);
      expect(gh.statuses).toEqual([expect.objectContaining({ sha: 'abc', state: 'failure', description: expect.stringContaining('via mcp') })]);
      expect(await job()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('without the GitHub App, the cron keeps jobs queued, makes no GitHub request, and clears their errors', async () => {
    await deliver('pull_request', pr('opened', { head: 'abc' }));
    await ctx.db
      .prepare(`UPDATE status_jobs SET attempts = 57, next_attempt_at = ?, last_error = 'GITHUB_APP_ID is not set.' WHERE repo_id = ?`)
      .bind(at('2026-11-18T20:00:00.000Z', 10), s.repo.id)
      .run();
    await ctx.db.prepare(`UPDATE repos SET last_status_ok = 0, last_status_error = 'GITHUB_APP_ID is not set.' WHERE id = ?`).bind(s.repo.id).run();
    ctx.env = { ...ctx.env, GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined };
    let calls = 0;
    await runStatusJobs(ctx, (input, init) => (calls++, gh.fetch(input, init)));
    expect(calls).toBe(0);
    // Kept, with no error and due now, so it runs on the first cron once the App is configured.
    expect(await job()).toMatchObject({ attempts: 0, next_attempt_at: ctx.now(), last_error: null });
    expect(await repoRow()).toMatchObject({ last_status_error: null });

    ctx.env = { ...ctx.env, GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY: pem };
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses).toEqual([expect.objectContaining({ sha: 'abc', state: 'success' })]);
    expect(await job()).toBeNull();
  });

  it('the scheduled handler runs the status jobs', async () => {
    const execCtx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ scheduledTime: Date.parse('2026-11-18T20:00:00Z'), cron: '* * * * *' }), env, execCtx);
    await waitOnExecutionContext(execCtx);
    expect(await count(`SELECT COUNT(*) AS n FROM owner_settings WHERE key = 'status_cron_at' AND value IS NOT NULL`)).toBe(1);
  });
});

describe('echo/hold status stays current', () => {
  const statusPost = (req: Request) => req.method === 'POST' && /\/statuses\//.test(new URL(req.url).pathname);

  it('a write GitHub applied but Echo never confirmed is not mistaken for the current state', async () => {
    await deliver('pull_request', pr('opened', { head: 'abc' }));
    const h1 = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 709, reason: 'finding' });
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses.at(-1)).toMatchObject({ state: 'failure' }); // confirmed failure
    await releaseHold(ctx, s.alice.id, h1.id, 'ok');
    // GitHub applies the success, then the answer is lost (502).
    const ambiguous: typeof fetch = async (input, init) => {
      const req = new Request(input as RequestInfo, init);
      if (statusPost(req)) {
        await gh.fetch(req);
        return new Response('{"message":"bad gateway"}', { status: 502 });
      }
      return gh.fetch(req);
    };
    await runStatusJobs(ctx, ambiguous);
    expect(gh.statuses.at(-1)).toMatchObject({ state: 'success' });
    expect((await shown('abc'))!.state).toBeNull(); // unknown, not the stale "failure"
    // The same hold again: the decision equals the last confirmed one, but GitHub shows success, so it is written.
    await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 709, reason: 'finding' });
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'abc', state: 'failure', description: 'Blocked: blocking hold by Alice (finding)' });
    expect(await shown('abc')).toMatchObject({ state: 'failure', description: 'Blocked: blocking hold by Alice (finding)' });
  });

  it('an older synchronize delivered after a newer one does not roll the head back', async () => {
    await deliver('pull_request', pr('synchronize', { head: 'new', updatedAt: '2026-11-18T19:50:00Z' }));
    const late = await deliver('pull_request', pr('synchronize', { head: 'old', updatedAt: '2026-11-18T19:40:00Z' }), { sync: false });
    expect(late.status).toBe(200);
    expect(await head()).toMatchObject({ head_sha: 'new', open: 1 });
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses.map((x) => [x.sha, x.state])).toEqual([['new', 'success']]);
  });

  it('a closed delivered after a newer reopened leaves the PR open and its status written', async () => {
    await deliver('pull_request', pr('reopened', { head: 'abc', updatedAt: '2026-11-18T19:50:00Z' }));
    await deliver('pull_request', pr('closed', { head: 'abc', updatedAt: '2026-11-18T19:40:00Z' }), { sync: false });
    expect(await head()).toMatchObject({ open: 1 });
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses).toEqual([expect.objectContaining({ sha: 'abc', state: 'success' })]);
  });

  it('without timestamps, a stale head is corrected from GitHub before a success is written', async () => {
    gh.pulls.set('acme/app#709', { head: 'new', state: 'open', mergedAt: null });
    await deliver('pull_request', pr('synchronize', { head: 'old' }), { sync: false }); // replayed, no updated_at
    expect((await head())!.head_sha).toBe('old');
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses.map((x) => [x.sha, x.state])).toEqual([['new', 'success']]);
    expect(await head()).toMatchObject({ head_sha: 'new' });
    expect(await shown('new')).toMatchObject({ state: 'success' });
    expect(await shown('old')).toBeNull();
  });

  it('without timestamps, a PR wrongly stored as closed is confirmed open and keeps its job', async () => {
    gh.pulls.set('acme/app#709', { head: 'abc', state: 'open', mergedAt: null });
    await deliver('pull_request', pr('closed', { head: 'abc' }), { sync: false });
    expect((await head())!.open).toBe(0);
    await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 709, reason: 'finding' });
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses).toEqual([expect.objectContaining({ sha: 'abc', state: 'failure' })]);
    expect(await head()).toMatchObject({ open: 1 });
  });

  it('a commit that heads two open PRs fails if either may not merge', async () => {
    // A (#1) has a hold and its failure is on S; then B (#2) opens on the same commit.
    await deliver('pull_request', pr('opened', { number: 1, head: 'S' }));
    await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 1, reason: 'hold on A' });
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses).toEqual([expect.objectContaining({ sha: 'S', state: 'failure' })]);
    await deliver('pull_request', pr('opened', { number: 2, head: 'S' }));
    await runStatusJobs(ctx, gh.fetch);
    // B's own decision is clear, but the commit stays failed for A: GitHub already shows that, so nothing is rewritten.
    expect(gh.statuses).toEqual([expect.objectContaining({ sha: 'S', state: 'failure', description: expect.stringContaining('hold on A') })]);
    expect(await shown('S')).toMatchObject({ state: 'failure', description: expect.stringContaining('hold on A') });

    // B moves to its own commit: A is still blocked on S; B's new head is clear.
    await deliver('pull_request', pr('synchronize', { number: 2, head: 'T' }));
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'T', state: 'success' });
    expect(gh.statuses.filter((x) => x.sha === 'S').at(-1)).toMatchObject({ state: 'failure' });
  });

  it("a clear PR's job writes failure for its commit when another PR on it is blocked", async () => {
    // B (#1, clear) and A (#2) share S, which shows success. A hold lands on A.
    await deliver('pull_request', pr('opened', { number: 1, head: 'S' }));
    await deliver('pull_request', pr('opened', { number: 2, head: 'S' }));
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses).toEqual([expect.objectContaining({ sha: 'S', state: 'success' })]);
    await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 2, reason: 'hold on A' });
    expect(await job(1)).not.toBeNull(); // the hold on A also queued B, which shares A's head
    await runStatusJobs(ctx, gh.fetch, 1); // only B's job (#1 sorts first)
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'S', state: 'failure', description: 'Blocked: blocking hold by Alice (hold on A)' });
    expect(await job(1)).toBeNull();
  });

  it('a blocked PR that closes and reopens on a commit shared with a clear PR gets failure again', async () => {
    await deliver('pull_request', pr('opened', { number: 1, head: 'S' }));
    await deliver('pull_request', pr('opened', { number: 2, head: 'S' }));
    await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 2, reason: 'blocked' });
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'S', state: 'failure' });
    await deliver('pull_request', pr('closed', { number: 2, head: 'S' }));
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'S', state: 'success' }); // #1 alone on S, and clear
    await deliver('pull_request', pr('reopened', { number: 2, head: 'S' }));
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'S', state: 'failure', description: 'Blocked: blocking hold by Alice (blocked)' });
    expect(await job(1)).toBeNull();
    expect(await job(2)).toBeNull();
  });

  it('a blocked PR that moves S to T and back to S gets failure on S again', async () => {
    await deliver('pull_request', pr('opened', { number: 1, head: 'S' }));
    await deliver('pull_request', pr('opened', { number: 2, head: 'S' }));
    await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 2, reason: 'blocked' });
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'S', state: 'failure' });
    await deliver('pull_request', pr('synchronize', { number: 2, head: 'T' }));
    // Only #1's job runs before #2 comes back: #1 is alone on S and clear, so S flips to success.
    await runStatusJobs(ctx, gh.fetch, 1);
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'S', state: 'success' });
    await deliver('pull_request', pr('synchronize', { number: 2, head: 'S' }));
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'S', state: 'failure', description: 'Blocked: blocking hold by Alice (blocked)' });
    expect(await shown('S')).toMatchObject({ state: 'failure' });
  });

  it('a success computed for one PR loses to a hold placed meanwhile on another PR on the same commit', async () => {
    // #1 and #2 share S, which shows failure for a hold on #1. The hold is released; run X takes #1's job and
    // computes success. While X's write is in flight, a hold lands on #2 and run Y writes failure for S. X's
    // success then reaches GitHub after Y's failure.
    await deliver('pull_request', pr('opened', { number: 1, head: 'S' }));
    await deliver('pull_request', pr('opened', { number: 2, head: 'S' }));
    const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 1, reason: 'first' });
    await runStatusJobs(ctx, gh.fetch);
    await releaseHold(ctx, s.alice.id, h.id, 'fixed');
    let raced = false;
    let runY: Promise<void> = Promise.resolve();
    const interleave: typeof fetch = async (input, init) => {
      const req = new Request(input as RequestInfo, init);
      if (!raced && statusPost(req)) {
        raced = true;
        await placeHold(ctx, s.bobA, { repo: 'acme/app', pr: 2, reason: 'late hold on #2' });
        ctx.setNow('2026-11-18T20:00:00.001Z');
        runY = runStatusJobs(ctx, gh.fetch);
        await runY; // Y writes failure for S and finishes before X's write lands
      }
      return gh.fetch(req);
    };
    await runStatusJobs(ctx, interleave, 1); // X: #1's job only
    await runY;
    expect(gh.statuses.slice(-2).map((x) => x.state)).toEqual(['failure', 'success']); // GitHub shows the stale success
    expect(await job(1)).not.toBeNull(); // X lost its lease: the hold on #2 also queued #1
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'S', state: 'failure', description: 'Blocked: blocking hold by Bob (late hold on #2)' });
    expect(await shown('S')).toMatchObject({ state: 'failure' });
  });

  it('a stale success that GitHub applied although its POST failed is corrected by a later run', async () => {
    // As the race above, but X's write reaches GitHub after Y's failure and X itself sees a 502.
    await deliver('pull_request', pr('opened', { number: 1, head: 'S' }));
    await deliver('pull_request', pr('opened', { number: 2, head: 'S' }));
    const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 1, reason: 'first' });
    await runStatusJobs(ctx, gh.fetch);
    await releaseHold(ctx, s.alice.id, h.id, 'fixed');
    let raced = false;
    const interleave: typeof fetch = async (input, init) => {
      const req = new Request(input as RequestInfo, init);
      if (!raced && statusPost(req)) {
        raced = true;
        await placeHold(ctx, s.bobA, { repo: 'acme/app', pr: 2, reason: 'late hold on #2' });
        ctx.setNow('2026-11-18T20:00:00.001Z');
        await runStatusJobs(ctx, gh.fetch); // Y: writes failure for S and deletes both jobs
        await gh.fetch(req); // X's success is applied after Y's failure ...
        return new Response('{"message":"bad gateway"}', { status: 502 }); // ... but X sees an error
      }
      return gh.fetch(req);
    };
    await runStatusJobs(ctx, interleave, 1); // X: #1's job only
    expect(gh.statuses.slice(-2).map((x) => x.state)).toEqual(['failure', 'success']); // GitHub shows the stale success
    expect((await shown('S'))!.state).toBeNull(); // unknown, not Y's failure
    expect(await job(1)).not.toBeNull(); // requeued: Y had deleted it
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'S', state: 'failure', description: 'Blocked: blocking hold by Bob (late hold on #2)' });
  });

  it('a lost lease is recorded in the same batch as the write, so a failing follow-up cannot leave a stale record', async () => {
    // X (#1) writes success; Y (#1 again, after a hold on #2) lands failure at GitHub first but records it after
    // X has finished. Every database call X makes after its own batch fails.
    await deliver('pull_request', pr('opened', { number: 1, head: 'S' }));
    await deliver('pull_request', pr('opened', { number: 2, head: 'S' }));
    const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 1, reason: 'first' });
    await runStatusJobs(ctx, gh.fetch);
    await releaseHold(ctx, s.alice.id, h.id, 'fixed');

    let yPosted!: () => void;
    const yPostedP = new Promise<void>((r) => (yPosted = r));
    let xDone!: () => void;
    const xDoneP = new Promise<void>((r) => (xDone = r));
    const real = ctx.db;
    let mainBatchNext = false;
    let broken = false;
    const xDb = {
      prepare(sql: string) {
        if (broken) throw new Error('D1 unavailable');
        if (/DELETE FROM status_jobs WHERE repo_id = \? AND pr_number = \? AND next_attempt_at = \?/.test(sql)) mainBatchNext = true;
        return real.prepare(sql);
      },
      async batch(stmts: D1PreparedStatement[]) {
        if (broken) throw new Error('D1 unavailable');
        const r = await real.batch(stmts);
        if (mainBatchNext) {
          broken = true; // nothing after X's own batch reaches the database
          xDone();
        }
        return r;
      },
    } as unknown as D1Database;
    const xCtx = { ...ctx, db: xDb };

    let writes = 0;
    let runY: Promise<void> = Promise.resolve();
    const interleave: typeof fetch = async (input, init) => {
      const req = new Request(input as RequestInfo, init);
      if (!statusPost(req)) return gh.fetch(req);
      writes++;
      if (writes === 1) {
        await placeHold(ctx, s.bobA, { repo: 'acme/app', pr: 2, reason: 'late hold on #2' });
        ctx.setNow('2026-11-18T20:00:00.001Z');
        runY = runStatusJobs(ctx, interleave); // Y takes #1's requeued job
        await yPostedP;
        return gh.fetch(req); // X's stale success lands after Y's failure
      }
      if (writes === 2) {
        const res = await gh.fetch(req);
        yPosted();
        await xDoneP; // Y records its write only after X's batch
        return res;
      }
      return gh.fetch(req);
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runStatusJobs(xCtx, interleave, 1);
      await runY;
    } finally {
      err.mockRestore();
    }
    const states = gh.statuses.map((x) => x.state);
    const stale = states.lastIndexOf('success');
    expect(states[stale - 1]).toBe('failure'); // Y's failure reached GitHub before X's stale success
    // Echo either corrected GitHub already, or does not record the commit as showing the current decision.
    if (states.at(-1) === 'success') expect((await shown('S'))?.state ?? null).not.toBe('failure');
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'S', state: 'failure', description: 'Blocked: blocking hold by Bob (late hold on #2)' });
    expect(await shown('S')).toMatchObject({ state: 'failure' });
  });

  it('a failing status POST still backs off when nothing else changed', async () => {
    await deliver('pull_request', pr('opened', { head: 'abc' }));
    const postsFail: typeof fetch = async (input, init) => {
      const req = new Request(input as RequestInfo, init);
      return statusPost(req) ? new Response('{"message":"bad gateway"}', { status: 502 }) : gh.fetch(req);
    };
    await runStatusJobs(ctx, postsFail);
    expect(await job()).toMatchObject({ attempts: 1, next_attempt_at: at('2026-11-18T20:00:00.000Z', 1) });
    expect((await shown('abc'))!.state).toBeNull();
    ctx.setNow(at('2026-11-18T20:00:00.000Z', 1));
    await runStatusJobs(ctx, postsFail);
    expect(await job()).toMatchObject({ attempts: 2, next_attempt_at: at('2026-11-18T20:00:00.000Z', 3) });
  });

  it('a run that dies after GitHub applied its write leaves the commit recorded as unknown', async () => {
    await deliver('pull_request', pr('opened', { head: 'abc' }));
    const h = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 709, reason: 'finding' });
    await runStatusJobs(ctx, gh.fetch);
    expect(await shown('abc')).toMatchObject({ state: 'failure' });
    await releaseHold(ctx, s.alice.id, h.id, 'ok');
    // X's success is applied by GitHub, and then X never hears back (the isolate is gone): no catch, no batch.
    let applied!: () => void;
    const appliedP = new Promise<void>((r) => (applied = r));
    let unblock!: () => void;
    const hang = new Promise<void>((r) => (unblock = r));
    const dies: typeof fetch = async (input, init) => {
      const req = new Request(input as RequestInfo, init);
      if (!statusPost(req)) return gh.fetch(req);
      await gh.fetch(req);
      applied();
      await hang;
      throw new Error('cancelled');
    };
    const x = runStatusJobs(ctx, dies);
    await appliedP;
    expect(gh.statuses.at(-1)).toMatchObject({ state: 'success' });
    expect((await shown('abc'))!.state).toBeNull(); // not the stale "failure"
    // The same hold again: the decision equals the last confirmed one, but GitHub shows success, so it is written.
    ctx.setNow('2026-11-18T20:00:00.001Z');
    await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 709, reason: 'finding' });
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'abc', state: 'failure', description: 'Blocked: blocking hold by Alice (finding)' });
    unblock();
    await x;
  });

  it('when the PR holding a shared commit closes, the commit is rechecked for the other PR', async () => {
    await deliver('pull_request', pr('opened', { number: 1, head: 'S' }));
    await deliver('pull_request', pr('opened', { number: 2, head: 'S' }));
    await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 1, reason: 'hold on A' });
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'S', state: 'failure' });
    await deliver('pull_request', pr('closed', { number: 1, head: 'S' }));
    expect(await job(2)).not.toBeNull(); // the close enqueued the PR still on S
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'S', state: 'success' });
  });

  it('a stale installation id is cleared on a 404 from the token exchange and found again', async () => {
    gh.pulls.set('acme/app#709', { head: 'abc', state: 'open', mergedAt: null });
    const uninstalled: typeof fetch = async (input, init) => {
      const req = new Request(input as RequestInfo, init);
      if (new URL(req.url).pathname === `/app/installations/${INSTALLATION}/access_tokens`) return new Response('{"message":"Not Found"}', { status: 404 });
      return gh.fetch(req);
    };
    await listingDone();
    await ctx.db.batch([enqueueStatus(ctx, s.repo.id, 709)]);
    await runStatusJobs(ctx, uninstalled);
    expect(gh.statuses).toHaveLength(0);
    expect(await repoRow()).toMatchObject({ installation_id: null, last_status_ok: 0 });
    expect(await job()).toMatchObject({ attempts: 1 });
    ctx.setNow(at('2026-11-18T20:00:00.000Z', 1));
    await runStatusJobs(ctx, uninstalled);
    expect((await repoRow())!.installation_id).toBe(1); // rediscovered: the fake's installation
    expect(gh.statuses).toEqual([expect.objectContaining({ sha: 'abc', state: 'success' })]);
  });

  it('a change to the description alone is written', async () => {
    await deliver('pull_request', pr('opened', { head: 'abc' }));
    const a = await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 709, reason: 'first' });
    await runStatusJobs(ctx, gh.fetch);
    await placeHold(ctx, s.bobA, { repo: 'acme/app', pr: 709, reason: 'second' });
    await runStatusJobs(ctx, gh.fetch);
    await releaseHold(ctx, s.alice.id, a.id, 'fixed');
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses.map((x) => [x.state, x.description])).toEqual([
      ['failure', 'Blocked: blocking hold by Alice (first)'],
      ['failure', 'Blocked: blocking hold by Alice (first) +1 more'],
      ['failure', 'Blocked: blocking hold by Bob (second)'],
    ]);
    expect((await shown('abc'))!.description).toBe('Blocked: blocking hold by Bob (second)');
  });

  it('a failure while enqueueing window edges does not stop the due jobs', async () => {
    await deliver('pull_request', pr('opened', { head: 'abc' }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const real = ctx.db;
    const broken = {
      ...ctx,
      db: {
        prepare(sql: string) {
          if (/owner_settings/.test(sql)) throw new Error('D1 hiccup');
          return real.prepare(sql);
        },
        batch: (st: D1PreparedStatement[]) => real.batch(st),
      } as unknown as D1Database,
    };
    try {
      await runStatusJobs(broken, gh.fetch);
      expect(err).toHaveBeenCalledWith('enqueueing approval-window edges failed', expect.any(Error));
    } finally {
      err.mockRestore();
    }
    expect(gh.statuses).toEqual([expect.objectContaining({ sha: 'abc', state: 'success' })]);
  });

  it('every GitHub request carries a timeout signal', async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const recording: typeof fetch = async (input, init) => {
      signals.push(init?.signal);
      return gh.fetch(input, init);
    };
    await deliver('pull_request', pr('opened', { head: 'abc' }));
    await runStatusJobs(ctx, recording);
    expect(gh.statuses).toHaveLength(1);
    expect(signals.length).toBeGreaterThanOrEqual(3); // token, PR confirmation, status
    for (const sig of signals) expect(sig).toBeInstanceOf(AbortSignal);
  });
});

describe('echo/hold status bounded staleness', () => {
  const T0 = '2026-11-18T20:00:00.000Z';
  const prRow = (n: number, sha: string, open = 1) =>
    ctx.db
      .prepare(`INSERT INTO pr_heads (repo_id, pr_number, head_sha, open, updated_at) VALUES (?,?,?,?,?)`)
      .bind(s.repo.id, n, sha, open, T0);
  const reconcileAt = () =>
    ctx.db.prepare(`SELECT value FROM owner_settings WHERE key = 'status_reconcile_at'`).first<{ value: string }>();

  it('the intervals are ten minutes', () => {
    expect(STATUS_CACHE_TTL_MS).toBe(600_000);
    expect(RECONCILE_INTERVAL_MS).toBe(600_000);
  });

  const statusLog = async () => (await changesSince(ctx, s.project.id, 0)).filter((c) => c.kind === 'github.status');
  const cacheRow = (sha: string) =>
    ctx.db
      .prepare(`SELECT state, description, updated_at FROM commit_statuses WHERE repo_id = ? AND sha = ?`)
      .bind(s.repo.id, sha)
      .first<{ state: string | null; description: string | null; updated_at: string }>();
  const statusGets = () => gh.requests.filter((r) => /^GET \/repos\/acme\/app\/commits\/abc\/statuses/.test(r));

  it('a cached status older than 10 minutes is checked against GitHub and refreshed, not sent again', async () => {
    gh.pulls.set('acme/app#709', { head: 'abc', state: 'open', mergedAt: null });
    await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 709, reason: 'finding' });
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses).toHaveLength(1);
    // Exactly at the TTL the record is still trusted: GitHub is not even asked.
    ctx.setNow(at(T0, 10));
    await ctx.db.batch([enqueueStatus(ctx, s.repo.id, 709)]);
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses).toHaveLength(1);
    expect(statusGets()).toHaveLength(0);
    // One millisecond later it is unknown: GitHub is asked, shows the same status, and nothing is sent.
    const stale = new Date(Date.parse(T0) + STATUS_CACHE_TTL_MS + 1).toISOString();
    ctx.setNow(stale);
    await ctx.db.batch([enqueueStatus(ctx, s.repo.id, 709)]);
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses).toHaveLength(1);
    expect(statusGets()).toEqual([expect.stringContaining('per_page=100')]);
    // The record is refreshed, so a check within the TTL trusts it again.
    expect(await cacheRow('abc')).toMatchObject({ state: 'failure', updated_at: stale });
    expect(await job()).toBeNull();
    ctx.setNow(at(T0, 15));
    await ctx.db.batch([enqueueStatus(ctx, s.repo.id, 709)]);
    await runStatusJobs(ctx, gh.fetch);
    expect(statusGets()).toHaveLength(1);
    expect(await statusLog()).toHaveLength(1);
  });

  it('many reconcile runs on an unchanged PR send one status and log it once (GitHub keeps at most 1000 per commit)', async () => {
    await deliver('pull_request', pr('opened', { head: 'abc' }));
    for (let i = 0; i <= 12; i++) {
      // Every run is past both the reconcile interval and the cache TTL.
      ctx.setNow(new Date(Date.parse(T0) + i * (RECONCILE_INTERVAL_MS + 1)).toISOString());
      await runStatusJobs(ctx, gh.fetch);
    }
    expect(gh.statuses).toEqual([expect.objectContaining({ sha: 'abc', state: 'success' })]);
    expect(await statusLog()).toHaveLength(1);
    expect(statusGets().length).toBeGreaterThanOrEqual(12);
    expect(await job()).toBeNull();
  });

  it('a stale record is sent again when GitHub shows a different state or description', async () => {
    gh.pulls.set('acme/app#709', { head: 'abc', state: 'open', mergedAt: null });
    await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 709, reason: 'finding' });
    await runStatusJobs(ctx, gh.fetch);
    const desired = gh.statuses[0];
    // GitHub drifted to a different description (same state); Echo's record is stale.
    gh.statuses.push({ ...desired, description: 'something else' });
    ctx.setNow(at(T0, 11));
    await ctx.db.batch([enqueueStatus(ctx, s.repo.id, 709)]);
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses).toHaveLength(3);
    expect(gh.statuses.at(-1)).toEqual(desired);
    expect(await statusLog()).toHaveLength(2);
    // A different state is sent again too.
    gh.statuses.push({ ...desired, state: 'success', description: 'Clear: no holds' });
    ctx.setNow(at(T0, 22));
    await ctx.db.batch([enqueueStatus(ctx, s.repo.id, 709)]);
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses).toHaveLength(5);
    expect(gh.statuses.at(-1)).toEqual(desired);
    expect(await cacheRow('abc')).toMatchObject({ state: 'failure', updated_at: at(T0, 22) });
  });

  it('a stale record is sent again when GitHub shows no echo/hold status for the commit', async () => {
    gh.pulls.set('acme/app#709', { head: 'abc', state: 'open', mergedAt: null });
    await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 709, reason: 'finding' });
    await runStatusJobs(ctx, gh.fetch);
    gh.statuses.length = 0;
    ctx.setNow(at(T0, 11));
    await ctx.db.batch([enqueueStatus(ctx, s.repo.id, 709)]);
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses).toEqual([expect.objectContaining({ sha: 'abc', state: 'failure' })]);
  });

  it("a failed read of GitHub's statuses backs off like any failure and never records success by assumption", async () => {
    gh.pulls.set('acme/app#709', { head: 'abc', state: 'open', mergedAt: null });
    await ctx.db.batch([prRow(709, 'abc')]);
    await runStatusJobs(ctx, gh.fetch); // success written and confirmed
    expect(gh.statuses).toEqual([expect.objectContaining({ state: 'success' })]);
    // A late failure lands on GitHub; Echo's record still says success, and goes stale.
    gh.statuses.push({ repo: 'acme/app', sha: 'abc', state: 'failure', description: 'Blocked: old' });
    const t1 = at(T0, 11);
    ctx.setNow(t1);
    gh.failRoute(/^GET \/repos\/acme\/app\/commits\/abc\/statuses$/, 1);
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses).toHaveLength(2); // nothing sent
    expect(await job()).toMatchObject({ attempts: 1, next_attempt_at: at(t1, 1), last_error: expect.stringContaining('500') });
    expect(await repoRow()).toMatchObject({ last_status_ok: 0 });
    // The stale record was not refreshed as if GitHub had confirmed success.
    expect(await cacheRow('abc')).toMatchObject({ state: 'success', updated_at: T0 });
    expect(await statusLog()).toHaveLength(1);
    // The retry reads GitHub, sees the failure, and corrects it.
    ctx.setNow(at(t1, 1));
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses).toHaveLength(3);
    expect(gh.statuses.at(-1)).toMatchObject({ state: 'success' });
    expect(await job()).toBeNull();
  });

  it('a new decision on a PR idle past the TTL is sent at once, without first reading GitHub (a failing read cannot delay it)', async () => {
    gh.pulls.set('acme/app#709', { head: 'abc', state: 'open', mergedAt: null });
    await ctx.db.batch([prRow(709, 'abc')]);
    await runStatusJobs(ctx, gh.fetch); // success written and confirmed at T0
    expect(gh.statuses).toEqual([expect.objectContaining({ state: 'success' })]);
    // The PR sits idle past the TTL; then a hold is placed while GitHub's statuses read is failing.
    const t1 = at(T0, 30);
    ctx.setNow(t1);
    gh.failRoute(/^GET \/repos\/acme\/app\/commits\/abc\/statuses$/, 5);
    await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 709, reason: 'finding' });
    await runStatusJobs(ctx, gh.fetch);
    // Echo's own last-confirmed state (success) already differs from the decision (failure): send it.
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'abc', state: 'failure' });
    expect(statusGets()).toHaveLength(0);
    expect(await cacheRow('abc')).toMatchObject({ state: 'failure', updated_at: t1 });
    expect(await job()).toBeNull();
  });

  it('the cron re-enqueues every open PR every 10 minutes and not more often', async () => {
    await ctx.db.batch([prRow(1, 'a1'), prRow(2, 'a2'), prRow(3, 'a3', 0)]);
    const queued = () => count(`SELECT COUNT(*) AS n FROM status_jobs`);
    const reconcileRuns = async (ms: number) => {
      ctx.setNow(at(T0, ms));
      await ctx.db.prepare(`DELETE FROM status_jobs`).run(); // observe fresh enqueues only
      // No GitHub pulls are registered, so jobs fail and back off; that still leaves the rows to count.
      const before = await reconcileAt();
      await runStatusJobs(ctx, gh.fetch);
      return { before, after: await reconcileAt() };
    };
    const first = await reconcileRuns(0);
    expect(first.before).toBeNull();
    expect(first.after!.value).toBe(T0);
    expect(await queued()).toBe(2); // the two open PRs, not the closed one
    const none = await reconcileRuns(5);
    expect(none.after!.value).toBe(T0);
    expect(await queued()).toBe(0);
    const again = await reconcileRuns(10);
    expect(again.after!.value).toBe(at(T0, 10));
    expect(await queued()).toBe(2);
  });

  it('a stale success left on GitHub is corrected within one reconcile interval with no other event', async () => {
    gh.pulls.set('acme/app#709', { head: 'abc', state: 'open', mergedAt: null });
    await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 709, reason: 'finding' });
    await runStatusJobs(ctx, gh.fetch); // writes failure; the reconcile clock starts
    expect(gh.statuses).toHaveLength(1);
    // GitHub now shows an older success (a write that landed late), Echo's record says failure, and no job is queued.
    gh.statuses.push({ repo: 'acme/app', sha: 'abc', state: 'success', description: 'Clear: no holds' });
    await ctx.db.prepare(`DELETE FROM status_jobs`).run();
    expect((await shown('abc'))!.state).toBe('failure');
    ctx.setNow(new Date(Date.parse(T0) + RECONCILE_INTERVAL_MS + 1).toISOString());
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'abc', state: 'failure' });
    expect(gh.statuses).toHaveLength(3);
  });

  /** The real clock moves on while a run works: every read is one millisecond later. */
  const ticking = (startIso: string) => {
    let t = Date.parse(startIso);
    return { ...ctx, now: () => new Date(t++).toISOString() };
  };

  it('the jobs a reconcile enqueues run in the same cron run, though the clock moved on meanwhile', async () => {
    // Found by e2e scenario 5: a commit pushed while Echo was down had to wait one extra cron run for its status.
    gh.pulls.set('acme/app#709', { head: 'abc', state: 'open', mergedAt: null });
    await ctx.db.batch([prRow(709, 'abc')]);
    await runStatusJobs(ticking(T0), gh.fetch);
    expect(gh.statuses).toEqual([expect.objectContaining({ sha: 'abc', state: 'success' })]);
    expect(await job()).toBeNull();
  });

  it('the jobs an approval-window edge enqueues run in the same cron run, though the clock moved on meanwhile', async () => {
    await ctx.db.prepare(`UPDATE projects SET approvals_required = 1 WHERE id = ?`).bind(s.project.id).run();
    gh.pulls.set('acme/app#709', { head: 'abc', state: 'open', mergedAt: null });
    const ev = await addEvent(ctx, s.bobA, { projectId: s.project.id, title: 'merge', startsAt: '2026-11-18T21:00:00Z', kind: 'merge', repo: 'acme/app', pr: 709 });
    await approveMerge(ctx, s.alice.id, ev.id);
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'abc', state: 'failure' });
    await ctx.db.prepare(`INSERT INTO owner_settings (key, value) VALUES ('status_reconcile_at', '2099-01-01T00:00:00.000Z') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
    ctx.setNow('2026-11-18T20:30:00.000Z');
    await runStatusJobs(ticking('2026-11-18T20:30:00.000Z'), gh.fetch);
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'abc', state: 'success' });
  });

  it('a reconcile failure does not stop due jobs', async () => {
    await deliver('pull_request', pr('opened', { head: 'abc' }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const real = ctx.db;
    const broken = {
      ...ctx,
      db: {
        prepare(sql: string) {
          if (/pr_heads ph JOIN repos/.test(sql)) throw new Error('D1 hiccup');
          return real.prepare(sql);
        },
        batch: (st: D1PreparedStatement[]) => real.batch(st),
      } as unknown as D1Database,
    };
    try {
      await runStatusJobs(broken, gh.fetch);
      expect(err).toHaveBeenCalledWith('reconciling open PRs failed', expect.any(Error));
    } finally {
      err.mockRestore();
    }
    expect(gh.statuses).toEqual([expect.objectContaining({ sha: 'abc', state: 'success' })]);
    expect(await reconcileAt()).toBeNull(); // not recorded, so the next run tries again
  });
});

describe('open PRs Echo never heard of', () => {
  const OWNER = { kind: 'admin' } as const;
  const listCalls = (repo: string) => gh.requests.filter((r) => r.startsWith(`GET /repos/${repo}/pulls?`));
  const headOf = (repoId: number, n: number) =>
    ctx.db.prepare(`SELECT head_sha, open FROM pr_heads WHERE repo_id = ? AND pr_number = ?`).bind(repoId, n).first<{ head_sha: string; open: number }>();

  it('a PR that exists only on GitHub gets a status after one cron run, matching the merge check', async () => {
    await ctx.db.prepare(`UPDATE projects SET approvals_required = 1 WHERE id = ?`).bind(s.project.id).run();
    gh.pulls.set('acme/app#709', { head: 'abc', state: 'open', mergedAt: null }); // opened before registration
    expect(await headOf(s.repo.id, 709)).toBeNull();
    await runStatusJobs(ctx, gh.fetch);
    expect(listCalls('acme/app')).toEqual(['GET /repos/acme/app/pulls?state=open&per_page=100']);
    expect(await headOf(s.repo.id, 709)).toEqual({ head_sha: 'abc', open: 1 });
    const decision = await mergeDecision(ctx, 'acme/app', 709);
    expect(decision).toMatchObject({ gated: true, allowed: false });
    expect(gh.statuses).toEqual([expect.objectContaining({ sha: 'abc', ...describeDecision(decision) })]);

    // Once approvals are off the same PR is clear in both.
    await updateProjectSettings(ctx, s.project.id, { approvalsRequired: false });
    await runStatusJobs(ctx, gh.fetch);
    expect(await mergeDecision(ctx, 'acme/app', 709)).toMatchObject({ allowed: true });
    expect(gh.statuses.at(-1)).toMatchObject({ sha: 'abc', state: 'success' });
  });

  it('a lost opened webhook is repaired at the next reconcile', async () => {
    await runStatusJobs(ctx, gh.fetch); // the first run lists acme/app (nothing open yet) and starts the reconcile clock
    gh.pulls.set('acme/app#710', { head: 'def', state: 'open', mergedAt: null }); // its opened delivery never arrives
    ctx.setNow(at('2026-11-18T20:00:00.000Z', 5));
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses).toHaveLength(0); // listed once per reconcile interval, not every run
    ctx.setNow(new Date(Date.parse('2026-11-18T20:00:00.000Z') + RECONCILE_INTERVAL_MS).toISOString());
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.statuses).toEqual([expect.objectContaining({ sha: 'def', state: 'success' })]);
    expect(listCalls('acme/app')).toHaveLength(2);
  });

  it('a repository registered after the App was installed is listed by the next cron run', async () => {
    await runStatusJobs(ctx, gh.fetch); // reconcile clock starts; nothing due afterwards for 10 minutes
    const fresh = await registerRepo(ctx, OWNER, s.project.id, 'acme/new');
    gh.pulls.set('acme/new#5', { head: 'fff', state: 'open', mergedAt: null });
    ctx.setNow(at('2026-11-18T20:00:00.000Z', 1));
    await runStatusJobs(ctx, gh.fetch);
    expect(gh.requests).toContain('GET /repos/acme/new/installation');
    expect(await headOf(fresh.id, 5)).toEqual({ head_sha: 'fff', open: 1 });
    expect(gh.statuses).toEqual([expect.objectContaining({ repo: 'acme/new', sha: 'fff', state: 'success' })]);
  });

  it('an installation attaching to a repository makes the next cron run list it', async () => {
    await ctx.db.prepare(`UPDATE repos SET installation_id = NULL WHERE id = ?`).bind(s.repo.id).run();
    await runStatusJobs(ctx, gh.fetch); // lists acme/app once (finding its installation)
    expect(listCalls('acme/app')).toHaveLength(1);
    gh.pulls.set('acme/app#711', { head: 'eee', state: 'open', mergedAt: null });
    expect((await deliver('installation', { action: 'created', installation: { id: INSTALLATION }, repositories: [{ full_name: 'acme/app' }] })).status).toBe(200);
    ctx.setNow(at('2026-11-18T20:00:00.000Z', 1));
    await runStatusJobs(ctx, gh.fetch);
    expect(listCalls('acme/app')).toHaveLength(2);
    expect(gh.statuses).toEqual([expect.objectContaining({ sha: 'eee', state: 'success' })]);
  });

  it('a PR stored on an older head or as closed is corrected from the list', async () => {
    await ctx.db
      .prepare(`INSERT INTO pr_heads (repo_id, pr_number, head_sha, open, updated_at) VALUES (?,?,?,?,?), (?,?,?,?,?)`)
      .bind(s.repo.id, 1, 'old', 1, '2026-11-18T19:00:00.000Z', s.repo.id, 2, 'two', 0, '2026-11-18T19:00:00.000Z')
      .run();
    gh.pulls.set('acme/app#1', { head: 'new', state: 'open', mergedAt: null });
    gh.pulls.set('acme/app#2', { head: 'two', state: 'open', mergedAt: null });
    await runStatusJobs(ctx, gh.fetch);
    expect(await headOf(s.repo.id, 1)).toEqual({ head_sha: 'new', open: 1 });
    expect(await headOf(s.repo.id, 2)).toEqual({ head_sha: 'two', open: 1 });
  });

  it('list calls count against the per-run budget, and the repositories not listed wait for the next run', async () => {
    const more = [await registerRepo(ctx, OWNER, s.project.id, 'acme/b'), await registerRepo(ctx, OWNER, s.project.id, 'acme/c')];
    await ctx.db.prepare(`UPDATE repos SET installation_id = ?`).bind(INSTALLATION).run();
    for (const r of ['acme/app', 'acme/b', 'acme/c']) gh.pulls.set(`${r}#1`, { head: `${r.slice(5)}1`, state: 'open', mergedAt: null });
    await runStatusJobs(ctx, gh.fetch, 4); // half the budget lists two repositories, the rest runs two jobs
    const listed = gh.requests.filter((r) => /^GET \/repos\/[^/]+\/[^/]+\/pulls\?/.test(r));
    expect(listed).toHaveLength(2);
    expect(gh.statuses).toHaveLength(2);
    ctx.setNow(at('2026-11-18T20:00:00.000Z', 1));
    await runStatusJobs(ctx, gh.fetch, 4);
    expect(gh.requests.filter((r) => /^GET \/repos\/[^/]+\/[^/]+\/pulls\?/.test(r))).toHaveLength(3);
    expect(new Set(gh.statuses.map((x) => x.repo))).toEqual(new Set(['acme/app', 'acme/b', 'acme/c']));
    expect(more).toHaveLength(2);
  });

  it('a 404 on the token exchange while listing clears the installation id, and the next run finds it again', async () => {
    gh.pulls.set('acme/app#709', { head: 'abc', state: 'open', mergedAt: null });
    const uninstalled: typeof fetch = async (input, init) => {
      const req = new Request(input as RequestInfo, init);
      if (new URL(req.url).pathname === `/app/installations/${INSTALLATION}/access_tokens`) return new Response('{"message":"Not Found"}', { status: 404 });
      return gh.fetch(req);
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runStatusJobs(ctx, uninstalled);
    } finally {
      err.mockRestore();
    }
    expect((await repoRow())!.installation_id).toBeNull();
    ctx.setNow(at('2026-11-18T20:00:00.000Z', 1));
    await runStatusJobs(ctx, uninstalled);
    expect((await repoRow())!.installation_id).toBe(1);
    expect(gh.statuses).toEqual([expect.objectContaining({ sha: 'abc', state: 'success' })]);
  });

  it('a failed list is logged and does not stop the due jobs or the other repositories', async () => {
    await registerRepo(ctx, OWNER, s.project.id, 'acme/b');
    await ctx.db.prepare(`UPDATE repos SET installation_id = ?`).bind(INSTALLATION).run();
    gh.pulls.set('acme/b#3', { head: 'b3', state: 'open', mergedAt: null });
    gh.failRoute(/^GET \/repos\/acme\/app\/pulls$/, 1);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runStatusJobs(ctx, gh.fetch);
      expect(err).toHaveBeenCalledWith(expect.stringContaining('listing open PRs of acme/app failed'), expect.any(Error));
    } finally {
      err.mockRestore();
    }
    expect(gh.statuses).toEqual([expect.objectContaining({ repo: 'acme/b', sha: 'b3' })]);
  });
});

describe('describe()', () => {
  const hold = (o: Partial<HoldView>): HoldView => ({
    id: 1,
    repo: 'acme/app',
    pr: 709,
    kind: 'blocking',
    reason: 'finding',
    placedBy: 'Alice',
    placedAt: '2026-11-18T20:00:00.000Z',
    acknowledged: null,
    state: 'open',
    released: null,
    blocksMerge: true,
    message: { delivered: 0, acknowledged: 0, recipients: 0 },
    ...o,
  });
  const d = (blocks: MergeDecision['blocks'], eventId: number | null = null): MergeDecision => ({ gated: true, allowed: blocks.length === 0, blocks, eventId });

  it('names the reason in at most 140 characters', () => {
    expect(describeDecision(d([]))).toEqual({ state: 'success', description: 'Clear: no holds' });
    expect(describeDecision(d([{ kind: 'hold', hold: hold({}) }]))).toEqual({ state: 'failure', description: 'Blocked: blocking hold by Alice (finding)' });
    expect(describeDecision(d([{ kind: 'hold', hold: hold({ kind: 'advisory', placedBy: 'Bob', reason: 'see doc' }) }])).description).toBe(
      'Blocked: advisory hold by Bob (see doc)',
    );
    expect(describeDecision(d([{ kind: 'no_slot' }]))).toEqual({ state: 'failure', description: 'No approved merge slot' });
    expect(describeDecision(d([{ kind: 'approval_missing', eventId: 3, startsAt: '2026-11-18T21:00:00.000Z', missing: ['Alice', 'Bob'] }]))).toEqual({
      state: 'failure',
      description: 'Waiting for approval from Alice, Bob',
    });
    // An event with no approval requests (approvals turned on after it was added): what to do, not an empty list.
    expect(describeDecision(d([{ kind: 'approval_missing', eventId: 3, startsAt: '2026-11-18T21:00:00.000Z', missing: [] }]))).toEqual({
      state: 'failure',
      description: 'No approvers asked for the 21:00Z slot: move the event to send requests',
    });
    expect(
      describeDecision(
        d([{ kind: 'outside_window', eventId: 3, startsAt: '2026-11-18T21:00:00.000Z', windowStart: '2026-11-18T20:30:00.000Z', windowEnd: '2026-11-18T21:30:00.000Z' }]),
      ).description,
    ).toBe('Outside approved slot (21:00Z ±30m)');
    expect(describeDecision(d([], 3)).state).toBe('success');

    const long = describeDecision(d([{ kind: 'hold', hold: hold({ reason: 'x'.repeat(500) }) }, { kind: 'no_slot' }]));
    expect([...long.description].length).toBeLessThanOrEqual(140);
    expect(long.description).toMatch(/^Blocked: blocking hold by Alice \(x+…\) \+1 more$/);
    const names = Array.from({ length: 40 }, (_, i) => `Approver${i}`);
    expect([...describeDecision(d([{ kind: 'approval_missing', eventId: 3, startsAt: '2026-11-18T21:00:00.000Z', missing: names }])).description].length).toBeLessThanOrEqual(140);
  });
});

describe('GitHub App credentials', () => {
  it('appJwt is an RS256 token for the App, backdated a minute and valid for nine', async () => {
    const jwt = await appJwt(ctx.env, 1_800_000_000);
    const [h, p, sig] = jwt.split('.');
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(h)))).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(p)))).toEqual({ iat: 1_800_000_000 - 60, exp: 1_800_000_000 + 540, iss: '12345' });
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, b64urlDecode(sig), new TextEncoder().encode(`${h}.${p}`));
    expect(ok).toBe(true);
  });

  it('an installation token is fetched once and reused until close to expiry', async () => {
    const calls: string[] = [];
    const counting: typeof fetch = async (input, init) => {
      const req = new Request(input as RequestInfo, init);
      calls.push(`${req.method} ${new URL(req.url).pathname} ${req.headers.get('authorization')?.split(' ')[0]}`);
      return gh.fetch(req);
    };
    expect(await installationToken(ctx.env, 42, counting)).toBe('fake-installation-token');
    expect(await installationToken(ctx.env, 42, counting)).toBe('fake-installation-token');
    expect(calls).toEqual(['POST /app/installations/42/access_tokens Bearer']);
  });

  it('a missing or non-PKCS#8 private key is a clear error', async () => {
    await expect(appJwt({ ...ctx.env, GITHUB_APP_PRIVATE_KEY: undefined }, 1)).rejects.toThrow(/GITHUB_APP_PRIVATE_KEY/);
    await expect(appJwt({ ...ctx.env, GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----' }, 1)).rejects.toThrow(/pkcs8/i);
  });
});
