import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { authenticate, touchCheckIn } from '../src/domain/agents';
import { approveMerge, mergeDecision, pendingApprovals, registerApprovals } from '../src/domain/approvals';
import { addEvent, recordMerge } from '../src/domain/calendar';
import { changeStmt } from '../src/domain/changelog';
import { runEscalations } from '../src/domain/escalation';
import { listHolds, placeHold } from '../src/domain/holds';
import { sendMessage, takeAwaitingForStop, takeForHook } from '../src/domain/messages';
import { agentProjects, findRepo, gatedRepos, setOwnerSetting } from '../src/domain/projects';
import { addWebhook, deliverWebhooks } from '../src/domain/webhooks';
import { resetInstallationTokens } from '../src/github/app';
import { runStatusJobs } from '../src/github/status';
import { fakeGithub } from './fake-github';
import { fakeNet, seedApprovals, testCtx } from './helpers';

/**
 * Every query the hook API and the cron run, checked with EXPLAIN QUERY PLAN: a table that grows with use must be
 * reached through an index (SEARCH), never read whole (SCAN). The queries are recorded from the real code paths.
 */

/** Tables whose size grows with use. projects, agents, project_agents, repos, owner_settings and webhooks stay small. */
const GROWING = [
  'messages',
  'message_recipients',
  'holds',
  'events',
  'event_approvers',
  'todos',
  'scratchpad_entries',
  'documents',
  'change_log',
  'pr_heads',
  'commit_statuses',
  'status_jobs',
];

type Rec = { path: string; sql: string; args: unknown[] };

function recording(db: D1Database, recs: Rec[], path: () => string): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const st = target.prepare(sql);
          const rec: Rec = { path: path(), sql, args: [] };
          recs.push(rec);
          const bind = st.bind.bind(st);
          st.bind = (...args: unknown[]) => {
            rec.args = args;
            return bind(...args);
          };
          return st;
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

let pem: string;
beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  let s = '';
  for (const b of der) s += String.fromCharCode(b);
  pem = `-----BEGIN PRIVATE KEY-----\n${btoa(s).match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
});

const KEYWORDS = new Set(['where', 'set', 'on', 'join', 'left', 'inner', 'cross', 'values', 'select', 'order', 'group', 'limit', 'returning', 'using', 'default', 'as']);

/** Alias (and plain name) to table, for every table named after FROM, JOIN, UPDATE or INTO in the SQL. */
function aliases(sql: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of sql.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?/gi)) {
    map.set(m[1], m[1]);
    if (m[2] && !KEYWORDS.has(m[2].toLowerCase())) map.set(m[2], m[1]);
  }
  return map;
}

/** The growing tables a statement reads whole: SQLite's plan says `SCAN <alias or table>` for each. */
async function scans(sql: string, args: unknown[]): Promise<string[]> {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...args)
    .all<{ detail: string }>();
  const names = aliases(sql);
  return results
    .map((r) => /^SCAN (\w+)/.exec(r.detail)?.[1])
    .map((name) => (name === undefined ? undefined : names.get(name) ?? name))
    .filter((t): t is string => t !== undefined && GROWING.includes(t));
}

async function recordPaths(): Promise<Rec[]> {
  const base = testCtx();
  const recs: Rec[] = [];
  let path = 'seed';
  const ctx = Object.assign(base, {
    env: { ...env, GITHUB_API_URL: 'https://gh.test', GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: pem },
  });
  registerApprovals();
  resetInstallationTokens();
  const s = await seedApprovals(ctx);
  await ctx.db.prepare(`UPDATE repos SET installation_id = 77 WHERE id = ?`).bind(s.repo.id).run();
  // Data on every growing table the paths touch.
  await sendMessage(ctx, s.aliceA, { projectId: s.project.id, to: 'Bob', body: 'hi', requiresAck: true, escalateAfterMin: 1 });
  await sendMessage(ctx, s.aliceA, { projectId: s.project.id, to: 'Bob', body: 'plain', requiresAck: false });
  await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 709, reason: 'finding' });
  const ev = await addEvent(ctx, s.bobA, { projectId: s.project.id, title: 'm', startsAt: '2026-11-18T20:10:00Z', kind: 'merge', repo: 'acme/app', pr: 710 });
  await approveMerge(ctx, s.alice.id, ev.id);
  await addWebhook(ctx, s.project.id, 'https://hooks.test/echo');
  await setOwnerSetting(ctx, 'notify_url', 'https://notify.test/topic');
  const gh = fakeGithub();
  gh.pulls.set('acme/app#709', { head: 'abc', state: 'open', mergedAt: null });
  gh.pulls.set('acme/app#710', { head: 'def', state: 'open', mergedAt: null });
  gh.pulls.set('acme/app#711', { head: 'ghi', state: 'open', mergedAt: null });

  ctx.db = recording(env.DB, recs, () => path);
  const bob = s.bob;
  // The hook API (src/api/hooks.ts): orient, poll, stop-check, merge-check, merge-report, override-report, repos.
  path = 'hook: authenticate';
  await authenticate(ctx, `Bearer ${bob.token}`);
  path = 'hook: orient';
  await agentProjects(ctx, bob.id);
  await takeForHook(ctx, bob.id);
  await listHolds(ctx, bob.id, { state: 'open' });
  await pendingApprovals(ctx, s.alice.id);
  await touchCheckIn(ctx, bob.id);
  await gatedRepos(ctx);
  path = 'setup';
  await sendMessage(ctx, s.aliceA, { projectId: s.project.id, to: 'Bob', body: 'again', requiresAck: false });
  path = 'hook: poll';
  await takeForHook(ctx, bob.id);
  path = 'hook: stop-check';
  await takeAwaitingForStop(ctx, bob.id);
  path = 'hook: merge-check';
  await mergeDecision(ctx, 'acme/app', 709);
  await mergeDecision(ctx, 'acme/app', 710);
  const found = (await findRepo(ctx, 'acme/app'))!;
  await ctx.db.batch([changeStmt(ctx, { projectId: found.project_id, actor: s.bobA, kind: 'merge.refused', subjectId: 709, data: { repo: 'acme/app' } })]);
  path = 'hook: merge-report';
  await recordMerge(ctx, s.bobA, { repo: 'acme/app', pr: 710, mergedAt: '2026-11-18T20:05:00Z', source: 'hook' });
  // The cron (src/index.ts scheduled): status jobs, escalations, outgoing webhooks.
  ctx.setNow('2026-11-18T20:30:00.000Z');
  path = 'cron: status';
  await runStatusJobs(ctx, gh.fetch);
  path = 'cron: escalation';
  await runEscalations(ctx, fakeNet().fetch);
  path = 'cron: webhooks';
  await deliverWebhooks(ctx, fakeNet().fetch);
  // The failure paths: GitHub down (status backoff), receivers down (webhook backoff).
  path = 'setup';
  await placeHold(ctx, s.aliceA, { repo: 'acme/app', pr: 711, reason: 'second' });
  ctx.setNow('2026-11-18T20:45:00.000Z');
  gh.fail(1000);
  path = 'cron: status (GitHub failing)';
  await runStatusJobs(ctx, gh.fetch);
  path = 'cron: webhooks (receiver failing)';
  await deliverWebhooks(ctx, fakeNet(() => 500).fetch);
  path = 'hook: override-report';
  await findRepo(ctx, 'acme/app');
  return recs;
}

describe('query plans on the hook API and cron paths', () => {
  it('the poll delivery update and its delivery-log insert read no table whole', async () => {
    const recs = await recordPaths();
    const deliverUpdate = recs.filter((r) => /UPDATE message_recipients SET delivered_at/.test(r.sql));
    const deliveryLog = recs.filter((r) => /'message\.delivered'/.test(r.sql));
    expect(deliverUpdate.length).toBeGreaterThan(0);
    expect(deliveryLog.length).toBeGreaterThan(0);
    for (const r of [...deliverUpdate, ...deliveryLog]) expect(await scans(r.sql, r.args)).toEqual([]);
  });

  it('every hook API and cron query reaches growing tables through an index, apart from the listed exceptions', async () => {
    const recs = await recordPaths();
    const perPath = new Map<string, number>();
    for (const r of recs) perPath.set(r.path, (perPath.get(r.path) ?? 0) + 1);
    // Every path ran queries through the recorder.
    expect([...perPath.keys()].filter((k) => k !== 'setup').sort()).toEqual([
      'cron: escalation',
      'cron: status',
      'cron: status (GitHub failing)',
      'cron: webhooks',
      'cron: webhooks (receiver failing)',
      'hook: authenticate',
      'hook: merge-check',
      'hook: merge-report',
      'hook: orient',
      'hook: override-report',
      'hook: poll',
      'hook: stop-check',
    ]);
    const found = new Map<string, Set<string>>();
    const seen = new Set<string>();
    for (const r of recs) {
      if (r.path === 'setup' || seen.has(r.sql)) continue;
      seen.add(r.sql);
      for (const t of await scans(r.sql, r.args)) {
        const key = `${r.path} | ${t} | ${r.sql.replace(/\s+/g, ' ').trim().slice(0, 90)}`;
        found.set(key, new Set());
      }
    }
    expect([...found.keys()].sort()).toEqual([]);
  });
});
