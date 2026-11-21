export type FakePull = { head: string; state: string; mergedAt: string | null };
export type FakeStatus = { repo: string; sha: string; state: string; description: string };

/**
 * A stand-in for the GitHub REST API. Pass `fetch` to domain code as `fetchFn`, with
 * `ctx.env.GITHUB_API_URL` set to any base URL (the host is ignored; only the path matters).
 * `pulls` keys are lowercase `owner/name#N`.
 */
export function fakeGithub() {
  const statuses: FakeStatus[] = [];
  const pulls = new Map<string, FakePull>();
  /** Every request, as `METHOD /path?query`. */
  const requests: string[] = [];
  let failures = 0;
  const routeFailures: { pattern: RegExp; n: number }[] = [];

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetchImpl: typeof fetch = async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();
    requests.push(`${method} ${path}${url.search}`);

    if (failures > 0) {
      failures--;
      return json({ message: 'fake github failure' }, 500);
    }
    const rf = routeFailures.find((f) => f.n > 0 && f.pattern.test(`${method} ${path}`));
    if (rf) {
      rf.n--;
      return json({ message: 'fake github failure' }, 500);
    }

    let m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/statuses\/([^/]+)$/);
    if (m && method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { state?: string; description?: string };
      statuses.push({
        repo: `${m[1]}/${m[2]}`.toLowerCase(),
        sha: m[3],
        state: body.state ?? '',
        description: body.description ?? '',
      });
      return json({ id: statuses.length }, 201);
    }

    // The statuses on a commit, newest first (Echo only writes the echo/hold context).
    m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/commits\/([^/]+)\/statuses$/);
    if (m && method === 'GET') {
      const repo = `${m[1]}/${m[2]}`.toLowerCase();
      const sha = m[3];
      const list = statuses
        .map((x, i) => ({ ...x, id: i + 1 }))
        .filter((x) => x.repo === repo && x.sha === sha)
        .reverse()
        .slice(0, Number(url.searchParams.get('per_page') ?? 30))
        .map((x) => ({ id: x.id, state: x.state, description: x.description, context: 'echo/hold' }));
      return json(list);
    }

    // A repository's pulls (one page), in key order.
    m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls$/);
    if (m && method === 'GET') {
      const repo = `${m[1]}/${m[2]}`.toLowerCase();
      const state = url.searchParams.get('state') ?? 'open';
      const list = [...pulls.entries()]
        .filter(([k, p]) => k.startsWith(`${repo}#`) && (state === 'all' || p.state === state))
        .map(([k, p]) => ({ number: Number(k.slice(repo.length + 1)), state: p.state, head: { sha: p.head } }))
        .slice(0, Number(url.searchParams.get('per_page') ?? 30));
      return json(list);
    }

    m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/);
    if (m && method === 'GET') {
      const key = `${m[1]}/${m[2]}#${m[3]}`.toLowerCase();
      const pr = pulls.get(key);
      if (!pr) return json({ message: 'Not Found' }, 404);
      return json({
        number: Number(m[3]),
        state: pr.state,
        merged: pr.mergedAt !== null,
        merged_at: pr.mergedAt,
        head: { sha: pr.head },
      });
    }

    m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/installation$/);
    if (m && method === 'GET') return json({ id: 1 });

    m = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (m && method === 'POST') {
      return json({ token: 'fake-installation-token', expires_at: '2099-01-01T00:00:00Z' }, 201);
    }

    return json({ message: 'Not Found' }, 404);
  };

  return {
    fetch: fetchImpl,
    statuses,
    pulls,
    requests,
    /** Make the next `n` requests answer 500. */
    fail(n: number) {
      failures = n;
    },
    /** Make the next `n` requests whose `METHOD /path` matches answer 500. */
    failRoute(pattern: RegExp, n: number) {
      routeFailures.push({ pattern, n });
    },
  };
}
