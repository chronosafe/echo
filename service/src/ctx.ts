import type { Env } from './env';

/**
 * `statusQueued` is set when a GitHub status job is added to a batch during this request, so the request
 * handler can make an immediate first attempt once that work has committed (see github/status.ts).
 */
export type Ctx = { db: D1Database; now: () => string; env: Env; statusQueued?: boolean };

export function makeCtx(env: Env): Ctx {
  return { db: env.DB, now: () => new Date().toISOString(), env };
}
