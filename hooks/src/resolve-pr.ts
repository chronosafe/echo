import { execFile } from 'node:child_process';
import fs from 'node:fs';
import type { MergeInvocation } from './parse-merge';

export type PrTarget = { repo: string; pr: number };

export class CannotResolve extends Error {
  /** True only when gh itself ran and exited non-zero, so its stderr is the reason it could not find the target. */
  readonly ghRefused: boolean;
  constructor(message: string, ghRefused = false) {
    super(message);
    this.name = 'CannotResolve';
    this.ghRefused = ghRefused;
  }
}

/** The repository and PR number when the invocation already names both (a URL, or a number with -R or GH_REPO). */
export function namedTarget(inv: MergeInvocation): PrTarget | null {
  const url = inv.target ? URL_RE.exec(inv.target) : null;
  if (url) return { repo: `${url[1]}/${url[2]}`.toLowerCase(), pr: Number(url[3]) };
  const repo = inv.repoFlag ?? inv.envRepo;
  if (repo && inv.target && /^\d+$/.test(inv.target)) return { repo: repo.toLowerCase(), pr: Number(inv.target) };
  return null;
}

const URL_RE = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/;

/** Ask gh which PR this invocation means, in the invocation's own directory and repo context. */
export function resolvePr(
  inv: MergeInvocation,
  env: NodeJS.ProcessEnv,
): Promise<PrTarget & { state: 'OPEN' | 'MERGED' | 'CLOSED'; mergedAt: string | null }> {
  const args = ['pr', 'view'];
  if (inv.target) args.push(inv.target);
  if (inv.repoFlag) args.push('-R', inv.repoFlag);
  args.push('--json', 'url,state,mergedAt');
  const childEnv = inv.envRepo ? { ...env, GH_REPO: inv.envRepo } : env;
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(inv.cwd) || !fs.statSync(inv.cwd).isDirectory()) {
      reject(new CannotResolve(`directory ${inv.cwd} does not exist`));
      return;
    }
    execFile('gh', args, { cwd: inv.cwd, env: childEnv, timeout: 8_000, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        const detail = stderr.trim() || (err instanceof Error ? err.message : String(err));
        reject(new CannotResolve(detail, typeof (err as { code?: unknown }).code === 'number'));
        return;
      }
      try {
        const v = JSON.parse(stdout) as { url?: unknown; state?: unknown; mergedAt?: unknown };
        const m = typeof v.url === 'string' ? URL_RE.exec(v.url) : null;
        if (!m || (v.state !== 'OPEN' && v.state !== 'MERGED' && v.state !== 'CLOSED')) {
          throw new Error(`unexpected gh output: ${stdout.trim().slice(0, 200)}`);
        }
        resolve({
          repo: `${m[1]}/${m[2]}`.toLowerCase(),
          pr: Number(m[3]),
          state: v.state,
          mergedAt: typeof v.mergedAt === 'string' && v.mergedAt !== '' ? v.mergedAt : null,
        });
      } catch (e) {
        reject(new CannotResolve(e instanceof Error ? e.message : String(e)));
      }
    });
  });
}
