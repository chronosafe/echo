import type { Env } from '../env';

/** GitHub App credentials and REST calls. Every request goes to `env.GITHUB_API_URL`, never a fixed host. */

export type FetchFn = typeof fetch;

/** A non-2xx answer from GitHub. `status` 0 means the request itself failed. */
export class GithubError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GithubError';
  }
}

/** The token exchange answered 404: the installation id is stale (the App was uninstalled or reinstalled). */
export class InstallationGone extends GithubError {
  constructor(message: string) {
    super(404, message);
    this.name = 'InstallationGone';
  }
}

const USER_AGENT = 'echo-hold-app';
const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

/** Global fetch, called unbound-safe (Workers refuses `fetch` detached from the global). */
export const defaultFetch: FetchFn = (input, init) => fetch(input, init);

function apiBase(env: Env): string {
  return (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  let s = '';
  for (const b of bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(pem: string): Promise<CryptoKey> {
  let key = keyCache.get(pem);
  if (!key) {
    if (/BEGIN RSA PRIVATE KEY/.test(pem)) {
      throw new Error(
        'GITHUB_APP_PRIVATE_KEY is a PKCS#1 key; convert it to PKCS#8 with `openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-pkcs8.pem`.',
      );
    }
    const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
    const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
    key = crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    key.catch(() => keyCache.delete(pem));
    keyCache.set(pem, key);
  }
  return key;
}

/** The App's own JWT: RS256 over { iat: now − 60, exp: now + 540, iss: GITHUB_APP_ID }. */
export async function appJwt(env: Env, nowSec: number): Promise<string> {
  if (!env.GITHUB_APP_ID) throw new Error('GITHUB_APP_ID is not set.');
  if (!env.GITHUB_APP_PRIVATE_KEY) throw new Error('GITHUB_APP_PRIVATE_KEY is not set.');
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = b64url(enc.encode(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: env.GITHUB_APP_ID })));
  const key = await importKey(env.GITHUB_APP_PRIVATE_KEY);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(sig)}`;
}

async function call(env: Env, auth: string, method: string, path: string, body: unknown, fetchFn: FetchFn): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(`${apiBase(env)}${path}`, {
      method,
      headers: {
        authorization: auth,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': USER_AGENT,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // A hung request would hold the job's lease and delay every job after it in the run.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new GithubError(0, `GitHub could not be reached for ${method} ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 200);
    try {
      detail = (JSON.parse(text) as { message?: string }).message ?? detail;
    } catch {
      // not JSON: keep the text
    }
    throw new GithubError(res.status, `GitHub answered ${res.status} for ${method} ${path}: ${detail}`);
  }
  return text ? JSON.parse(text) : null;
}

/** A request made as the App itself (not an installation). */
export async function appRequest(env: Env, method: string, path: string, fetchFn: FetchFn = defaultFetch): Promise<unknown> {
  return call(env, `Bearer ${await appJwt(env, Math.floor(Date.now() / 1000))}`, method, path, undefined, fetchFn);
}

const tokens = new Map<string, { token: string; refreshAt: number }>();

/** For tests: forget every cached installation token. */
export function resetInstallationTokens(): void {
  tokens.clear();
}

const tokenKey = (env: Env, installationId: number) => `${apiBase(env)}|${env.GITHUB_APP_ID}|${installationId}`;

/** An installation access token, cached per isolate until 5 minutes before it expires. */
export async function installationToken(env: Env, installationId: number, fetchFn: FetchFn = defaultFetch): Promise<string> {
  const key = tokenKey(env, installationId);
  const cached = tokens.get(key);
  if (cached && Date.now() < cached.refreshAt) return cached.token;
  let res: { token?: string; expires_at?: string } | null;
  try {
    res = (await appRequest(env, 'POST', `/app/installations/${installationId}/access_tokens`, fetchFn)) as typeof res;
  } catch (e) {
    if (e instanceof GithubError && e.status === 404) throw new InstallationGone(e.message);
    throw e;
  }
  if (!res?.token) throw new GithubError(0, `GitHub returned no token for installation ${installationId}.`);
  const expires = Date.parse(res.expires_at ?? '');
  // Without a readable expiry, assume GitHub's usual hour.
  const refreshAt = (Number.isFinite(expires) ? expires : Date.now() + 3_600_000) - TOKEN_REFRESH_MARGIN_MS;
  tokens.set(key, { token: res.token, refreshAt });
  return res.token;
}

/** A REST call as the installation. A 401 drops the cached token so the next call fetches a fresh one. */
export async function ghRequest(
  env: Env,
  installationId: number,
  method: string,
  path: string,
  body?: unknown,
  fetchFn: FetchFn = defaultFetch,
): Promise<unknown> {
  const token = await installationToken(env, installationId, fetchFn);
  try {
    return await call(env, `Bearer ${token}`, method, path, body, fetchFn);
  } catch (e) {
    if (e instanceof GithubError && e.status === 401) tokens.delete(tokenKey(env, installationId));
    throw e;
  }
}

/** The App's installation id on a repository, or null when the App is not installed there. */
export async function findInstallation(env: Env, fullName: string, fetchFn: FetchFn = defaultFetch): Promise<number | null> {
  try {
    const res = (await appRequest(env, 'GET', `/repos/${fullName}/installation`, fetchFn)) as { id?: number } | null;
    return typeof res?.id === 'number' ? res.id : null;
  } catch (e) {
    if (e instanceof GithubError && e.status === 404) return null;
    throw e;
  }
}
