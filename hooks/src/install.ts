import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { api, Refused, Unreachable } from './client';
import { echoHome, loadConfig, saveConfig } from './config';
import { writeGateCache } from './state';
import { NAME_RE, readToken, writeToken } from './token-store';

export type CommandResult = { stdout?: string; stderr?: string; exitCode: number };

const fail = (message: string): CommandResult => ({ stderr: message.endsWith('\n') ? message : message + '\n', exitCode: 1 });

// ---------------------------------------------------------------- hook entries

type Entry = { event: string; matcher?: string; arg: string; timeout?: number };
const ENTRIES: Entry[] = [
  { event: 'SessionStart', arg: 'session-start' },
  { event: 'UserPromptSubmit', arg: 'prompt' },
  { event: 'PostToolUse', matcher: '*', arg: 'post-tool' },
  { event: 'PostToolUse', matcher: 'Bash', arg: 'post-bash' },
  { event: 'PreToolUse', matcher: 'Bash', arg: 'pre-bash', timeout: 30 },
  { event: 'Stop', arg: 'stop' },
];
const BUNDLE_NAME = 'echo-hook.mjs';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isOurs = (h: unknown): boolean => isObj(h) && typeof h.command === 'string' && h.command.includes(BUNDLE_NAME);
const endsWithArg = (h: unknown, arg: string): boolean => isObj(h) && typeof h.command === 'string' && h.command.endsWith(` ${arg}`);

function shellQuote(p: string): string {
  return `"${p.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** Returns the merged settings object without touching the file. Throws a plain Error on a shape it will not edit. */
export function mergeHooks(settings: Json, bundleAbs: string, homeAbs: string, nodeAbs: string): Json {
  const hooks = settings.hooks === undefined ? {} : settings.hooks;
  if (!isObj(hooks)) throw new Error('"hooks" is not an object');
  for (const e of ENTRIES) {
    const groups = hooks[e.event] === undefined ? [] : hooks[e.event];
    if (!Array.isArray(groups)) throw new Error(`"hooks.${e.event}" is not an array`);
    const hook: Json = {
      type: 'command',
      command: `ECHO_HOME=${shellQuote(homeAbs)} ${shellQuote(nodeAbs)} ${shellQuote(bundleAbs)} ${e.arg}`,
    };
    if (e.timeout !== undefined) hook.timeout = e.timeout;
    // Every Echo entry for this argument, wherever it is. Foreign entries never match.
    const found: { grp: Json; h: unknown }[] = [];
    for (const grp of groups) {
      if (!isObj(grp) || !Array.isArray(grp.hooks)) continue;
      for (const h of grp.hooks) if (isOurs(h) && endsWithArg(h, e.arg)) found.push({ grp, h });
    }
    const first = found[0];
    const inPlace = first !== undefined && first.grp.matcher === e.matcher;
    for (const { grp, h } of found.slice(inPlace ? 1 : 0)) {
      (grp.hooks as unknown[]).splice((grp.hooks as unknown[]).indexOf(h), 1);
    }
    if (inPlace) {
      const arr = first.grp.hooks as unknown[];
      const next = { ...(first.h as Json), ...hook };
      if (e.timeout === undefined) delete next.timeout;
      arr[arr.indexOf(first.h)] = next;
    } else {
      groups.push(e.matcher === undefined ? { hooks: [hook] } : { matcher: e.matcher, hooks: [hook] });
    }
    // Drop groups that only held Echo entries we removed.
    const emptied = new Set(found.map((f) => f.grp).filter((g) => (g.hooks as unknown[]).length === 0));
    hooks[e.event] = groups.filter((g) => !emptied.has(g as Json));
  }
  settings.hooks = hooks;
  return settings;
}

function writeAtomic(file: string, data: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** Writes through a symlink to its target and keeps the existing file's permissions; a new file is 0600. */
function writeSettings(file: string, data: string): void {
  let target = file;
  let mode = 0o600;
  if (fs.existsSync(file)) {
    target = fs.realpathSync(file);
    mode = fs.statSync(target).mode & 0o777;
  }
  writeAtomic(target, data, mode);
}

// ---------------------------------------------------------------- node path

/** Paths that change when Node is upgraded (Homebrew Cellar, nvm, fnm, Volta, asdf). */
const VERSIONED_NODE = /\/Cellar\/|\/\.nvm\/versions\/|\/fnm\/|\/\.volta\/tools\/image\/|\/\.asdf\/installs\//;

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * The path the hooks and the wrapper should use to run this same Node.
 *
 * `process.execPath` is the resolved binary, which for Homebrew is a versioned Cellar path that `brew upgrade` deletes.
 * A hook that cannot start is skipped by Claude Code, so a deleted path silently turns the merge check off. Prefer a
 * link that resolves to the same binary and survives upgrades: the first `node` on PATH that is one (non-versioned
 * first), then Homebrew's `opt/<formula>/bin/node`. Fall back to `execPath`, flagged as versioned when it looks it.
 */
export function stableNodePath(execPath: string, env: NodeJS.ProcessEnv): { path: string; versioned: boolean } {
  const real = realOrNull(execPath);
  const candidates: string[] = [];
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir && path.isAbsolute(dir)) candidates.push(path.join(dir, 'node'));
  }
  const brew = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(real ?? execPath);
  if (brew) candidates.push(`${brew[1]}/opt/${brew[2]}/bin/node`);
  const same = real ? candidates.filter((c) => isExecutable(c) && realOrNull(c) === real) : [];
  const pick = same.find((c) => !VERSIONED_NODE.test(c)) ?? same[0];
  if (pick) return { path: pick, versioned: VERSIONED_NODE.test(pick) };
  return { path: execPath, versioned: VERSIONED_NODE.test(execPath) };
}

/** The line install prints about the node it wrote. */
export function installNote(node: { path: string; versioned: boolean }): string {
  return (
    `  node:    ${node.path}\n` +
    (node.versioned
      ? `\nNote: that Node path includes a version number. After upgrading Node, run install again, or the hooks cannot start and the merge check stops running on this machine.\n`
      : '')
  );
}

// ---------------------------------------------------------------- wrapper

export function wrapperText(nodeAbs: string, homeAbs: string): string {
  const node = shellQuote(nodeAbs);
  const home = shellQuote(homeAbs);
  return `#!/bin/sh
# Launches Claude Code as an Echo orchestrator: echo-claude <agent-name> [claude arguments...]
# The token is read from the Keychain or ~/.echo/tokens and lives only in this process's environment.
# Paths were fixed when install ran; run install again after moving or upgrading Node.
set -eu
if [ "$#" -lt 1 ]; then
  echo "usage: echo-claude <agent-name> [claude arguments...]" >&2
  exit 2
fi
name=$1
shift
if [ ! -x ${node} ]; then
  echo "echo-claude: node not found (expected at "${node}"); run the Echo install again" >&2
  exit 1
fi
if ! token=$(ECHO_HOME=${home} ${node} ${shellQuote(path.join(homeAbs, BUNDLE_NAME))} token "$name"); then
  echo "echo-claude: no Echo token for $name; run: node ~/.echo/echo-hook.mjs set-token $name" >&2
  exit 1
fi
ECHO_AGENT=$name
ECHO_TOKEN=$token
export ECHO_AGENT ECHO_TOKEN
exec claude "$@"
`;
}

// ---------------------------------------------------------------- MCP headers helper

export const HELPER_NAME = 'echo-mcp-headers';

/**
 * The script Claude Code runs as the MCP server's headersHelper. It always prints a JSON object and exits 0:
 * a missing node means no identity, the same as an agent without a token.
 */
export function mcpHeadersText(nodeAbs: string, homeAbs: string): string {
  const node = shellQuote(nodeAbs);
  const home = shellQuote(homeAbs);
  return `#!/bin/sh
# Claude Code headersHelper for the Echo MCP server. Prints {"Authorization":"Bearer <token>"} for $ECHO_AGENT,
# or {} when there is no Echo identity. It never prints the token anywhere else.
# Paths were fixed when install ran; run install again after moving or upgrading Node.
bundle=${shellQuote(path.join(homeAbs, BUNDLE_NAME))}
if [ ! -x ${node} ] || [ ! -r "$bundle" ]; then
  echo '{}'
  exit 0
fi
if ! ECHO_HOME=${home} ${node} "$bundle" mcp-headers; then
  echo '{}'
fi
exit 0
`;
}

/**
 * `mcp-headers`: the headers for the Echo MCP server, for env.ECHO_AGENT only. No fallback to the default agent:
 * a session without ECHO_AGENT has no Echo identity. One readToken call, no retries (Claude Code allows 10 s).
 * Never throws and never writes anything but the JSON object.
 */
export async function mcpHeadersCommand(env: NodeJS.ProcessEnv): Promise<CommandResult> {
  let headers: Record<string, string> = {};
  try {
    const name = env.ECHO_AGENT;
    const cfg = name ? loadConfig(env) : null;
    if (name && cfg?.agents.includes(name)) {
      const token = await readToken(name, env);
      if (token) headers = { Authorization: `Bearer ${token}` };
    }
  } catch {
    headers = {};
  }
  return { stdout: JSON.stringify(headers) + '\n', exitCode: 0 };
}

/** The text of `claude mcp add-json` for this URL and helper, single-quoted for sh. */
export function mcpAddCommand(url: string, helperAbs: string): string {
  const json = JSON.stringify({ type: 'http', url: `${url}/mcp`, headersHelper: helperAbs });
  return `claude mcp add-json echo '${json.replace(/'/g, `'\\''`)}' --scope user`;
}

// ---------------------------------------------------------------- argument parsing

function parseFlags(args: string[], valued: string[], bare: string[]): Record<string, string | true> | string {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (bare.includes(a)) out[a] = true;
    else if (valued.includes(a)) {
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) return `${a} needs a value`;
      out[a] = v;
    } else return `unknown argument: ${a}`;
  }
  return out;
}

const USAGE = 'usage: node echo-hook.mjs install --url <url> --agent <name> [--default] [--settings <path>]   (token on stdin)\n';

function readSecret(stdin: () => string): string {
  try {
    return stdin().trim();
  } catch {
    return '';
  }
}

const TOKEN_RE = /^[\x21-\x7e]+$/;
const BAD_TOKEN = 'the token must be a single line of printable characters';

/** Last line of defence: no secret ever leaves in an error message. */
const redact = (text: string, secret: string): string => (secret ? text.split(secret).join('[token]') : text);

/** Verifies a token with GET /repos. Returns the gated list, or a failure result. */
async function verify(url: string, token: string): Promise<{ repos: string[] } | CommandResult> {
  try {
    const r = (await api({ url, agents: [], defaultAgent: '' }, token, '/api/v1/repos')) as { gatedRepos?: unknown };
    if (!Array.isArray(r?.gatedRepos)) return fail(`Echo at ${url} answered, but not with a repository list. Is the URL right?`);
    return { repos: r.gatedRepos.filter((x): x is string => typeof x === 'string') };
  } catch (e) {
    if (e instanceof Refused) return fail(`Echo refused the token (${e.code}): ${e.message} ${e.fix}`);
    if (e instanceof Unreachable) return fail(`${e.message}. Nothing was changed.`);
    throw e;
  }
}

// ---------------------------------------------------------------- install

export async function install(
  args: string[],
  stdin: () => string,
  env: NodeJS.ProcessEnv,
  selfPath: string | undefined,
): Promise<CommandResult> {
  const f = parseFlags(args, ['--url', '--agent', '--settings'], ['--default']);
  if (typeof f === 'string') return fail(`${f}\n${USAGE}`);
  const rawUrl = f['--url'];
  const agent = f['--agent'];
  if (typeof rawUrl !== 'string' || typeof agent !== 'string') return fail(`--url and --agent are required.\n${USAGE}`);
  if (!NAME_RE.test(agent)) return fail(`Invalid agent name "${agent}": use letters, digits, ".", "_" and "-", starting with a letter or digit.`);
  let url: string;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocol');
    url = rawUrl.replace(/\/+$/, '');
  } catch {
    return fail(`"${rawUrl}" is not an http(s) URL.`);
  }
  if (!selfPath) return fail('Cannot find the bundle to copy; run install from the built echo-hook.mjs.');

  const token = readSecret(stdin);
  if (token === '') return fail('No token on stdin. Pipe it in, for example: pbpaste | node echo-hook.mjs install ...');
  if (!TOKEN_RE.test(token)) return fail(BAD_TOKEN);

  const home = path.resolve(echoHome(env));
  const bundleDest = path.join(home, BUNDLE_NAME);
  const node = stableNodePath(process.execPath, env);
  const settingsPath = path.resolve(typeof f['--settings'] === 'string' ? f['--settings'] : path.join(env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME ?? os.homedir(), '.claude'), 'settings.json'));

  // Everything that can refuse happens before the first write.
  let settings: Json = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const v: unknown = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (!isObj(v)) throw new Error('not a JSON object');
      settings = v;
    } catch (e) {
      return fail(`${settingsPath} is not valid JSON (${e instanceof Error ? e.message : String(e)}). Fix or move it, then run install again. Nothing was changed.`);
    }
  }
  try {
    mergeHooks(settings, bundleDest, home, node.path);
  } catch (e) {
    return fail(`${settingsPath} has an unexpected shape: ${e instanceof Error ? e.message : String(e)}. Nothing was changed.`);
  }
  let bundleBytes: Buffer;
  try {
    bundleBytes = fs.readFileSync(selfPath);
  } catch (e) {
    return fail(`Cannot read the bundle ${selfPath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Step 2: verify. A failure here leaves nothing behind.
  const v = await verify(url, token);
  if ('exitCode' in v) return v;

  // Steps 3 to 8, in order.
  writeGateCache(v.repos, env);
  try {
    await writeToken(agent, token, env);
  } catch (e) {
    return fail(redact(e instanceof Error ? e.message : String(e), token));
  }
  let same = false;
  try {
    same = fs.realpathSync(selfPath) === fs.realpathSync(bundleDest);
  } catch {
    /* destination does not exist yet */
  }
  if (!same) writeAtomic(bundleDest, bundleBytes.toString('utf8'), 0o755);
  const existing = loadConfig(env);
  const agents = existing?.agents ?? [];
  saveConfig(env, {
    url,
    agents: agents.includes(agent) ? agents : [...agents, agent],
    defaultAgent: f['--default'] === true || !existing?.defaultAgent ? agent : existing.defaultAgent,
  });
  const wrapper = path.join(home, 'echo-claude');
  writeAtomic(wrapper, wrapperText(node.path, home), 0o755);
  const helper = path.join(home, HELPER_NAME);
  writeAtomic(helper, mcpHeadersText(node.path, home), 0o755);
  writeSettings(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  return {
    stdout:
      `Echo is installed for "${agent}".\n` +
      `  hooks:   ${settingsPath}\n` +
      `  bundle:  ${bundleDest}\n` +
      installNote(node) +
      `  gated repositories: ${v.repos.length === 0 ? '(none yet)' : v.repos.join(', ')}\n\n` +
      `Connect the MCP tools once. No token is stored: Claude Code runs ${helper} on every connect.\n\n` +
      `  claude mcp remove echo -s user      (only if an echo server already exists)\n` +
      `  ${mcpAddCommand(url, helper)}\n\n` +
      `Then launch the orchestrator with:\n\n  ${wrapper} ${agent}\n\n` +
      `A launcher that cannot use echo-claude sets ECHO_AGENT=${agent} in that session's settings env instead.\n`,
    exitCode: 0,
  };
}

// ---------------------------------------------------------------- token, set-token

export async function tokenCommand(args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult> {
  const name = args[0];
  if (!name) return { stderr: 'usage: node echo-hook.mjs token <name>\n', exitCode: 1 };
  const t = await readToken(name, env);
  if (!t) return { exitCode: 1 };
  return { stdout: t + '\n', exitCode: 0 };
}

export async function setTokenCommand(args: string[], stdin: () => string, env: NodeJS.ProcessEnv): Promise<CommandResult> {
  const name = args[0];
  if (!name) return fail('usage: node echo-hook.mjs set-token <name>   (token on stdin)');
  if (!NAME_RE.test(name)) return fail(`Invalid agent name "${name}".`);
  const cfg = loadConfig(env);
  if (!cfg) return fail(`No Echo config at ${path.join(echoHome(env), 'config.json')}. Run install first.`);
  const token = readSecret(stdin);
  if (token === '') return fail('No token on stdin.');
  if (!TOKEN_RE.test(token)) return fail(BAD_TOKEN);
  const v = await verify(cfg.url, token);
  if ('exitCode' in v) return v;
  try {
    await writeToken(name, token, env);
  } catch (e) {
    return fail(redact(e instanceof Error ? e.message : String(e), token));
  }
  return { stdout: `Stored a new token for "${name}".\n`, exitCode: 0 };
}
