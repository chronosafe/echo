import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env } from '../env';

export const COOKIE = 'echo_admin';
export const SESSION_MS = 12 * 60 * 60 * 1000;

export type AdminVars = { nonce: string };
export type AdminEnv = { Bindings: Env; Variables: AdminVars };

const enc = new TextEncoder();

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Constant-time string comparison: both sides are HMAC-ed with the secret, and the fixed-length digests compared. */
export async function safeEqual(secret: string, a: string, b: string): Promise<boolean> {
  return bytesEqual(await hmac(secret, a), await hmac(secret, b));
}

export async function passwordOk(env: Env, given: string): Promise<boolean> {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) return false; // not configured: nobody gets in
  return safeEqual(env.SESSION_SECRET, given, env.ADMIN_PASSWORD);
}

export async function makeSession(env: Env, nowIso: string): Promise<string> {
  const expiry = String(Date.parse(nowIso) + SESSION_MS);
  return `${expiry}.${hex(await hmac(env.SESSION_SECRET, expiry))}`;
}

export async function sessionValid(env: Env, cookie: string | undefined, nowIso: string): Promise<boolean> {
  if (!cookie || !env.SESSION_SECRET) return false;
  const dot = cookie.indexOf('.');
  if (dot < 1) return false;
  const expiry = cookie.slice(0, dot);
  if (!/^\d{1,16}$/.test(expiry)) return false;
  const expected = hex(await hmac(env.SESSION_SECRET, expiry));
  const sigOk = await safeEqual(env.SESSION_SECRET, cookie.slice(dot + 1), expected);
  return sigOk && Number(expiry) > Date.parse(nowIso);
}

/** A POST must carry an Origin equal to the request's own; a missing Origin is refused too. */
export function originOk(c: Context): boolean {
  const origin = c.req.header('origin');
  return !!origin && origin === new URL(c.req.url).origin;
}

export function randomNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const csp = (nonce: string) =>
  `default-src 'self'; style-src 'unsafe-inline'; script-src 'self' 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'`;

/**
 * Every admin POST needs a same-origin Origin (login included). Everything except the login page and POST /login
 * also needs a valid session: GETs redirect to the login page, POSTs get 403.
 */
export function requireAdmin(now: () => string): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname.replace(/\/+$/, '');
    const isLogin = path === '/admin/login';
    const post = c.req.method === 'POST';
    if (post && !originOk(c)) return c.text('Forbidden: bad Origin.', 403);
    if (isLogin) return next();
    if (!(await sessionValid(c.env, getCookie(c, COOKIE), now()))) {
      return post ? c.text('Forbidden: not logged in.', 403) : c.redirect('/admin/login', 303);
    }
    return next();
  };
}
