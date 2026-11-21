import type { EchoConfig } from './config';

/** Network error, timeout or 5xx: Echo could not answer. */
export class Unreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Unreachable';
  }
}

/** 4xx: Echo answered and said no. code and fix come from the service's error body. */
export class Refused extends Error {
  constructor(
    public code: string,
    message: string,
    public fix: string,
    public status: number,
    /** Milliseconds from a Retry-After header, when the service sent a usable one. */
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'Refused';
  }
}

export async function api(
  cfg: EchoConfig,
  token: string,
  path: string,
  body?: unknown,
  timeoutMs = 5000,
): Promise<unknown> {
  const url = cfg.url.replace(/\/+$/, '') + path;
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    throw new Unreachable(`Echo is unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status >= 500) throw new Unreachable(`Echo answered ${res.status}`);
  if (res.status >= 400) {
    let code = `HTTP_${res.status}`;
    let message = `Echo refused the request (${res.status}).`;
    let fix = 'Check the request and try again.';
    try {
      const e = (JSON.parse(text) as { error?: { code?: unknown; message?: unknown; fix?: unknown } }).error;
      if (typeof e?.code === 'string') code = e.code;
      if (typeof e?.message === 'string') message = e.message;
      if (typeof e?.fix === 'string') fix = e.fix;
    } catch {
      /* keep defaults */
    }
    const ra = Number(res.headers.get('retry-after'));
    throw new Refused(code, message, fix, res.status, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
  }
  if (res.status < 200 || res.status >= 300) throw new Unreachable(`Echo answered ${res.status}`);
  try {
    return text === '' ? null : JSON.parse(text);
  } catch {
    throw new Unreachable('Echo returned a response that is not JSON');
  }
}
