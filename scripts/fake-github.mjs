// A stand-alone fake of the GitHub REST API and of the `gh` CLI, for the end-to-end run (scripts/e2e.mjs).
//
// Server: `startFakeGithub(opts)` listens on 127.0.0.1 and answers the routes the Worker uses (the same ones as
// service/test/fake-github.ts), checking the GitHub App's RS256 JWT and the installation token, plus the routes
// the fake `gh` uses. `PUT /repos/:o/:r/pulls/:n/merge` (POST is accepted too) stands in for GitHub's required
// check: it answers 405 while the newest `echo/hold` status on the PR's head commit is missing or not `success`.
// Pull request changes (opened, a new commit, merged) are sent to the Worker as signed `pull_request` webhooks.
//
// CLI: `node fake-github.mjs gh <args>` behaves like the few `gh` commands Echo's hooks and the scenarios run
// (`pr view`, `pr merge`, `api`), against the server named by FAKE_GITHUB_URL. A one-line `gh` shell script on
// PATH runs it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const USER_TOKEN = 'fake-gh-user-token';
const INSTALLATION_ID = 1;

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const ghTime = (ms = Date.now()) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
const newSha = () => crypto.randomBytes(20).toString('hex');

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/**
 * `requireHold: false` turns the required-check stand-in off (merges need no echo/hold status). The e2e remote mode
 * uses it: there the Worker's statuses go to the GitHub it is configured for, never to this fake.
 *
 * @param {{ appId: string, publicKeyPem: string, webhookSecret: string, webhookUrl?: string, requireHold?: boolean }} opts
 */
export async function startFakeGithub(opts) {
  /** key `owner/name#n` (lowercase) -> { repo, number, head, state, mergedAt, updatedAt } */
  const pulls = new Map();
  /** every status POST, in order: { repo, sha, context, state, description, at } */
  const statuses = [];
  /** every webhook delivery attempt: { event, action, pr, ok, status, error } */
  const deliveries = [];
  const installationTokens = new Set();
  const pending = new Set();
  let webhookUrl = opts.webhookUrl ?? null;

  const key = (repo, n) => `${repo.toLowerCase()}#${n}`;

  function jwtOk(auth) {
    const m = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(auth ?? '');
    if (!m) return false;
    try {
      const header = b64urlJson(m[1]);
      const payload = b64urlJson(m[2]);
      const valid = crypto.verify('RSA-SHA256', Buffer.from(`${m[1]}.${m[2]}`), opts.publicKeyPem, Buffer.from(m[3], 'base64url'));
      const now = Math.floor(Date.now() / 1000);
      return valid && header.alg === 'RS256' && payload.iss === opts.appId && payload.exp > now && payload.iat <= now + 60;
    } catch {
      return false;
    }
  }
  const installationOk = (auth) => installationTokens.has((auth ?? '').replace(/^(Bearer|token) /, ''));
  const userOk = (auth) => (auth ?? '').replace(/^(Bearer|token) /, '') === USER_TOKEN;

  /** The newest echo/hold status written for a commit, or null. */
  function latestHold(repo, sha) {
    for (let i = statuses.length - 1; i >= 0; i--) {
      const s = statuses[i];
      if (s.repo === repo.toLowerCase() && s.sha === sha && s.context === 'echo/hold') return s;
    }
    return null;
  }

  function payloadFor(pr, action) {
    const [owner, name] = pr.repo.split('/');
    return {
      action,
      number: pr.number,
      installation: { id: INSTALLATION_ID },
      repository: { full_name: `${owner}/${name}`, name, owner: { login: owner } },
      pull_request: {
        number: pr.number,
        state: pr.state,
        merged: pr.mergedAt !== null,
        merged_at: pr.mergedAt,
        updated_at: pr.updatedAt,
        head: { sha: pr.head },
      },
    };
  }

  /** Sends a signed pull_request webhook; never throws (a stopped Worker is a failed delivery, as on GitHub). */
  function deliver(pr, action) {
    const record = { event: 'pull_request', action, repo: pr.repo, pr: pr.number, ok: false, status: 0, error: null };
    deliveries.push(record);
    if (!webhookUrl) {
      record.error = 'no webhook URL';
      return Promise.resolve(record);
    }
    const body = JSON.stringify(payloadFor(pr, action));
    const sig = 'sha256=' + crypto.createHmac('sha256', opts.webhookSecret).update(body).digest('hex');
    const p = fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': crypto.randomUUID(),
        'x-hub-signature-256': sig,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    })
      .then(async (res) => {
        record.status = res.status;
        record.ok = res.ok;
        if (!res.ok) record.error = (await res.text()).slice(0, 300);
        return record;
      })
      .catch((e) => {
        record.error = e instanceof Error ? e.message : String(e);
        return record;
      })
      .finally(() => pending.delete(p));
    pending.add(p);
    return p;
  }

  function touch(pr) {
    // GitHub's updated_at has one-second resolution; keep it strictly increasing so the Worker can order deliveries.
    const now = Date.now();
    const prev = Date.parse(pr.updatedAt ?? '') || 0;
    pr.updatedAt = ghTime(Math.max(now, prev + 1000));
  }

  /** Merges a PR the way GitHub does when a required check is configured. Returns [status, body]. */
  function merge(repo, n) {
    const pr = pulls.get(key(repo, n));
    if (!pr) return [404, { message: 'Not Found' }];
    if (pr.mergedAt) return [405, { message: 'Pull Request is not mergeable: already merged' }];
    if (pr.state !== 'open') return [405, { message: 'Pull Request is not mergeable: closed' }];
    const hold = opts.requireHold === false ? { state: 'success' } : latestHold(repo, pr.head);
    if (!hold) return [405, { message: 'Repository rule violations found\n\nRequired status check "echo/hold" is expected.' }];
    if (hold.state !== 'success') {
      return [405, { message: `Repository rule violations found\n\nRequired status check "echo/hold" is ${hold.state === 'pending' ? 'expected' : 'failing'}.` }];
    }
    pr.state = 'closed';
    pr.mergedAt = ghTime();
    touch(pr);
    deliver(pr, 'closed');
    return [200, { sha: newSha(), merged: true, message: 'Pull Request successfully merged' }];
  }

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8');
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return {};
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://fake');
      const path = url.pathname.replace(/^\/api\/v3/, '');
      const method = (req.method ?? 'GET').toUpperCase();
      const auth = req.headers.authorization;
      let m;

      if ((m = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/)) && method === 'POST') {
        if (!jwtOk(auth)) return json(res, 401, { message: 'A JSON web token could not be decoded' });
        if (Number(m[1]) !== INSTALLATION_ID) return json(res, 404, { message: 'Not Found' });
        const token = 'ghs_' + crypto.randomBytes(16).toString('hex');
        installationTokens.add(token);
        return json(res, 201, { token, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      }
      if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/installation$/)) && method === 'GET') {
        if (!jwtOk(auth)) return json(res, 401, { message: 'A JSON web token could not be decoded' });
        return json(res, 200, { id: INSTALLATION_ID });
      }
      if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/statuses\/([0-9a-f]+)$/)) && method === 'POST') {
        if (!installationOk(auth)) return json(res, 401, { message: 'Bad credentials' });
        const body = await readBody(req);
        statuses.push({
          repo: `${m[1]}/${m[2]}`.toLowerCase(),
          sha: m[3],
          context: body.context ?? 'default',
          state: body.state ?? '',
          description: body.description ?? '',
          at: new Date().toISOString(),
        });
        return json(res, 201, { id: statuses.length, state: body.state, context: body.context });
      }
      if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/commits\/([0-9a-f]+)\/statuses$/)) && method === 'GET') {
        if (!installationOk(auth) && !userOk(auth)) return json(res, 401, { message: 'Bad credentials' });
        const repo = `${m[1]}/${m[2]}`.toLowerCase();
        const perPage = Math.min(100, Number(url.searchParams.get('per_page') ?? 30) || 30);
        const list = statuses
          .map((s, i) => ({ ...s, id: i + 1 }))
          .filter((s) => s.repo === repo && s.sha === m[3])
          .reverse() // newest first, as GitHub lists them
          .slice(0, perPage)
          .map((s) => ({ id: s.id, state: s.state, description: s.description, context: s.context, created_at: s.at }));
        return json(res, 200, list);
      }
      if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls$/)) && method === 'GET') {
        if (!installationOk(auth) && !userOk(auth)) return json(res, 401, { message: 'Bad credentials' });
        const repo = `${m[1]}/${m[2]}`.toLowerCase();
        const state = url.searchParams.get('state') ?? 'open';
        const perPage = Math.min(100, Number(url.searchParams.get('per_page') ?? 30) || 30);
        const list = [...pulls.values()]
          .filter((p) => p.repo === repo && (state === 'all' || p.state === state))
          .sort((a, b) => b.number - a.number) // GitHub's default: newest first
          .slice(0, perPage)
          .map((p) => ({ number: p.number, state: p.state, updated_at: p.updatedAt, head: { sha: p.head } }));
        return json(res, 200, list);
      }
      if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/)) && method === 'GET') {
        if (!installationOk(auth) && !userOk(auth)) return json(res, 401, { message: 'Bad credentials' });
        const pr = pulls.get(key(`${m[1]}/${m[2]}`, m[3]));
        if (!pr) return json(res, 404, { message: 'Not Found' });
        return json(res, 200, {
          number: pr.number,
          html_url: `https://github.com/${pr.repo}/pull/${pr.number}`,
          state: pr.state,
          merged: pr.mergedAt !== null,
          merged_at: pr.mergedAt,
          updated_at: pr.updatedAt,
          head: { sha: pr.head },
        });
      }
      if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/)) && (method === 'PUT' || method === 'POST')) {
        if (!installationOk(auth) && !userOk(auth)) return json(res, 401, { message: 'Bad credentials' });
        const [status, body] = merge(`${m[1]}/${m[2]}`, Number(m[3]));
        return json(res, status, body);
      }
      return json(res, 404, { message: 'Not Found' });
    } catch (e) {
      return json(res, 500, { message: `fake github error: ${e instanceof Error ? e.message : String(e)}` });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;

  return {
    url: `http://127.0.0.1:${port}`,
    pulls,
    statuses,
    deliveries,
    latestHold,
    setWebhookUrl(u) {
      webhookUrl = u;
    },
    pr(repo, n) {
      return pulls.get(key(repo, n)) ?? null;
    },
    /** Opens a PR with a new head commit and delivers `opened`. */
    async openPr(repo, n) {
      const pr = { repo: repo.toLowerCase(), number: n, head: newSha(), state: 'open', mergedAt: null, updatedAt: null };
      touch(pr);
      pulls.set(key(repo, n), pr);
      return { pr, delivery: await deliver(pr, 'opened') };
    },
    /** Pushes a new commit to an open PR and delivers `synchronize`. */
    async push(repo, n) {
      const pr = pulls.get(key(repo, n));
      if (!pr || pr.state !== 'open') throw new Error(`fake github: ${key(repo, n)} is not open`);
      pr.head = newSha();
      touch(pr);
      return { pr, delivery: await deliver(pr, 'synchronize') };
    },
    /** Waits for every webhook delivery in flight. */
    async settle() {
      while (pending.size) await Promise.all([...pending]);
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

// ---------------------------------------------------------------- the fake gh CLI

function fail(message) {
  process.stderr.write(message.endsWith('\n') ? message : message + '\n');
  process.exit(1);
}

/** Splits gh-style arguments into positionals and flags (`-R x`, `--repo x`, `--repo=x`, `--json x`, bare flags). */
function parseArgs(args, valued) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) flags[a.slice(0, eq)] = a.slice(eq + 1);
    else if (valued.includes(a)) flags[a] = args[++i];
    else if (a.startsWith('-')) flags[a] = true;
    else pos.push(a);
  }
  return { pos, flags };
}

const PR_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

/** The repository and number the way gh works them out: a URL target, then -R/--repo, then GH_REPO. */
function target(pos, flags) {
  const t = pos[0];
  const u = t ? PR_URL.exec(t) : null;
  if (u) return { repo: `${u[1]}/${u[2]}`, n: Number(u[3]) };
  const repo = flags['-R'] ?? flags['--repo'] ?? process.env.GH_REPO;
  if (!repo) fail('fake gh: no repository: pass -R owner/name, set GH_REPO, or give a PR URL (the fake reads no git remotes)');
  if (!t || !/^\d+$/.test(t)) fail(`fake gh: no pull requests found for "${t ?? '(current branch)'}" (the fake needs a PR number or URL)`);
  return { repo, n: Number(t) };
}

async function request(method, path) {
  const base = process.env.FAKE_GITHUB_URL;
  if (!base) fail('fake gh: FAKE_GITHUB_URL is not set');
  let res;
  try {
    res = await fetch(base + path, { method, headers: { authorization: `token ${USER_TOKEN}`, accept: 'application/json' } });
  } catch (e) {
    fail(`fake gh: error connecting to the fake GitHub: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text };
  }
  return { status: res.status, body };
}

async function gh(args) {
  const [cmd, sub, ...rest] = args;
  if (cmd === 'pr' && sub === 'view') {
    const { pos, flags } = parseArgs(rest, ['-R', '--repo', '--json']);
    const { repo, n } = target(pos, flags);
    const { status, body } = await request('GET', `/repos/${repo}/pulls/${n}`);
    if (status === 404) fail(`GraphQL: Could not resolve to a PullRequest with the number of ${n}. (repository.pullRequest)`);
    if (status !== 200) fail(`HTTP ${status}: ${body.message ?? ''}`);
    const view = {
      url: body.html_url,
      number: body.number,
      state: body.merged ? 'MERGED' : body.state === 'open' ? 'OPEN' : 'CLOSED',
      mergedAt: body.merged_at ?? null,
      headRefOid: body.head?.sha,
    };
    const fields = typeof flags['--json'] === 'string' ? flags['--json'].split(',') : Object.keys(view);
    process.stdout.write(JSON.stringify(Object.fromEntries(fields.map((f) => [f, view[f] ?? null]))) + '\n');
    return;
  }
  if (cmd === 'pr' && sub === 'merge') {
    const { pos, flags } = parseArgs(rest, ['-R', '--repo', '-t', '--subject', '-b', '--body', '--match-head-commit']);
    const { repo, n } = target(pos, flags);
    if (flags['--disable-auto']) {
      process.stdout.write(`✓ Auto-merge disabled for pull request ${repo}#${n}\n`);
      return;
    }
    if (flags['--auto']) fail('fake gh: --auto is not supported by the fake');
    const { status, body } = await request('PUT', `/repos/${repo}/pulls/${n}/merge`);
    if (status !== 200) fail(`X Pull request ${repo}#${n} is not mergeable: ${body.message ?? `HTTP ${status}`}`);
    process.stdout.write(`✓ Merged pull request ${repo}#${n}\n`);
    return;
  }
  if (cmd === 'api') {
    const { pos, flags } = parseArgs([sub, ...rest].filter((a) => a !== undefined), ['-X', '--method']);
    const method = String(flags['-X'] ?? flags['--method'] ?? 'GET').toUpperCase();
    const path = '/' + String(pos[0] ?? '').replace(/^\//, '');
    const { status, body } = await request(method, path);
    process.stdout.write(JSON.stringify(body) + '\n');
    if (status < 200 || status >= 300) fail(`gh: ${body.message ?? ''} (HTTP ${status})`);
    return;
  }
  fail(`fake gh: unsupported command: gh ${args.join(' ')}`);
}

const isMain = (() => {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain && process.argv[2] === 'gh') {
  await gh(process.argv.slice(3));
}
