import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { echoHome, type EchoConfig } from './config';
import type { HookInput } from './input';

const SERVICE = 'echo';
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Keychain on macOS, 0600 files elsewhere. ECHO_TOKEN_STORE=file forces files (tests);
 * ECHO_TOKEN_STORE=keychain forces `security` on any platform (tests).
 */
function useKeychain(env: NodeJS.ProcessEnv): boolean {
  if (env.ECHO_TOKEN_STORE === 'file') return false;
  if (env.ECHO_TOKEN_STORE === 'keychain') return true;
  return process.platform === 'darwin';
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env, timeout: 3000, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function tokenFile(name: string, env: NodeJS.ProcessEnv): string {
  return path.join(echoHome(env), 'tokens', name);
}

export async function readToken(name: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (!NAME_RE.test(name)) return null;
  if (env.ECHO_AGENT === name && env.ECHO_TOKEN) return env.ECHO_TOKEN;
  try {
    const raw = useKeychain(env)
      ? await run('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w'], env)
      : fs.readFileSync(tokenFile(name, env), 'utf8');
    const t = raw.trim();
    return t === '' ? null : t;
  } catch {
    return null;
  }
}

function insideGitWorkTree(dir: string): boolean {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

/**
 * Known limit: on macOS the token is passed to `security add-generic-password -w <token>`,
 * so it is briefly visible in `ps` argv to other processes of the same user.
 */
export async function writeToken(name: string, token: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!NAME_RE.test(name)) throw new Error(`invalid agent name: ${name}`);
  if (useKeychain(env)) {
    try {
      await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', name, '-w', token], env);
    } catch (e) {
      // Never pass the original error on: its message contains the argv, and so the token.
      const code = (e as { code?: unknown }).code;
      throw new Error(`could not store the token in the macOS Keychain (security exited ${typeof code === 'number' ? code : 'abnormally'})`);
    }
    return;
  }
  const file = tokenFile(name, env);
  const dir = path.dirname(file);
  if (insideGitWorkTree(dir)) {
    throw new Error(`refusing to write a token inside a git work tree: ${file}`);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, token + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export async function messageIdentity(
  cfg: EchoConfig,
  env: NodeJS.ProcessEnv,
  input: HookInput,
): Promise<{ name: string; token: string } | null> {
  const name = env.ECHO_AGENT;
  if (!name || !cfg.agents.includes(name) || input.agent_id) return null;
  const token = await readToken(name, env);
  return token ? { name, token } : null;
}

export async function mergeCheckToken(cfg: EchoConfig, env: NodeJS.ProcessEnv): Promise<string | null> {
  return readToken(env.ECHO_AGENT || cfg.defaultAgent, env);
}
