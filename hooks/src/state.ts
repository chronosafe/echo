import fs from 'node:fs';
import path from 'node:path';
import { echoHome } from './config';
import type { PrTarget } from './resolve-pr';

export type Report = Record<string, unknown>;
export type OverrideState = { firstSeenMs: number; usedAtMs: number | null };

// One JSON file per concern under ${ECHO_HOME:-~/.echo}/state/, each written via temp file + rename.
// Read-modify-write is not locked: hooks of one agent run one after another, and a lost
// update only costs a repeated poll or a repeated message display.

function file(env: NodeJS.ProcessEnv, name: string): string {
  return path.join(echoHome(env), 'state', `${name}.json`);
}

function read<T>(env: NodeJS.ProcessEnv, name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file(env, name), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function write(env: NodeJS.ProcessEnv, name: string, value: unknown): void {
  const f = file(env, name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, f);
}

export function readGateCache(env: NodeJS.ProcessEnv = process.env): { repos: string[]; fetchedAtMs: number } | null {
  const v = read<{ repos?: string[]; fetchedAtMs?: number } | null>(env, 'gate-cache', null);
  return v && Array.isArray(v.repos) && typeof v.fetchedAtMs === 'number'
    ? { repos: v.repos, fetchedAtMs: v.fetchedAtMs }
    : null;
}
export function writeGateCache(repos: string[], env: NodeJS.ProcessEnv = process.env): void {
  write(env, 'gate-cache', { repos, fetchedAtMs: Date.now() });
}

export function lastPoll(agent: string, env: NodeJS.ProcessEnv = process.env): number {
  return read<Record<string, number>>(env, 'last-poll', {})[agent] ?? 0;
}
export function setLastPoll(agent: string, ms: number, env: NodeJS.ProcessEnv = process.env): void {
  write(env, 'last-poll', { ...read<Record<string, number>>(env, 'last-poll', {}), [agent]: ms });
}

export function savePendingMerge(toolUseId: string, target: PrTarget, env: NodeJS.ProcessEnv = process.env): void {
  write(env, 'pending-merges', { ...read<Record<string, PrTarget>>(env, 'pending-merges', {}), [toolUseId]: target });
}
export function takePendingMerge(toolUseId: string, env: NodeJS.ProcessEnv = process.env): PrTarget | null {
  const all = read<Record<string, PrTarget>>(env, 'pending-merges', {});
  const t = all[toolUseId];
  if (!t) return null;
  delete all[toolUseId];
  write(env, 'pending-merges', all);
  return t;
}

export function stopShown(sessionId: string, env: NodeJS.ProcessEnv = process.env): Set<number> {
  return new Set(read<Record<string, number[]>>(env, 'stop-shown', {})[sessionId] ?? []);
}
export function addStopShown(sessionId: string, ids: number[], env: NodeJS.ProcessEnv = process.env): void {
  const all = read<Record<string, number[]>>(env, 'stop-shown', {});
  write(env, 'stop-shown', { ...all, [sessionId]: [...new Set([...(all[sessionId] ?? []), ...ids])] });
}

export function overrideState(key: string, env: NodeJS.ProcessEnv = process.env): OverrideState | null {
  return read<Record<string, OverrideState>>(env, 'override', {})[key] ?? null;
}
export function setOverrideState(key: string, s: OverrideState, env: NodeJS.ProcessEnv = process.env): void {
  write(env, 'override', { ...read<Record<string, OverrideState>>(env, 'override', {}), [key]: s });
}

export function queueReport(r: Report, env: NodeJS.ProcessEnv = process.env): void {
  write(env, 'reports', [...read<Report[]>(env, 'reports', []), r]);
}
/** Returns the queued reports and clears the queue. */
export function drainReports(env: NodeJS.ProcessEnv = process.env): Report[] {
  const all = read<Report[]>(env, 'reports', []);
  if (all.length > 0) write(env, 'reports', []);
  return all;
}
