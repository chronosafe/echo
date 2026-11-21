import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Holds no tokens. Tokens live in the Keychain or ~/.echo/tokens (see token-store.ts). */
export type EchoConfig = { url: string; agents: string[]; defaultAgent: string };

export function echoHome(env: NodeJS.ProcessEnv): string {
  return env.ECHO_HOME || path.join(os.homedir(), '.echo');
}

export function loadConfig(env: NodeJS.ProcessEnv): EchoConfig | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(echoHome(env), 'config.json'), 'utf8')) as Record<string, unknown>;
    if (
      typeof v.url === 'string' &&
      typeof v.defaultAgent === 'string' &&
      Array.isArray(v.agents) &&
      v.agents.every((a) => typeof a === 'string')
    ) {
      return { url: v.url, agents: v.agents as string[], defaultAgent: v.defaultAgent };
    }
    return null;
  } catch {
    return null;
  }
}

/** Writes exactly the three config fields, so a stray token property can never be persisted. */
export function saveConfig(env: NodeJS.ProcessEnv, cfg: EchoConfig): void {
  const dir = echoHome(env);
  fs.mkdirSync(dir, { recursive: true });
  const body = { url: cfg.url, agents: cfg.agents, defaultAgent: cfg.defaultAgent };
  const file = path.join(dir, 'config.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
