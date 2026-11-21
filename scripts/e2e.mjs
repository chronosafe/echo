#!/usr/bin/env node
// End-to-end scenarios from spec section 11, against the real Worker under `wrangler dev --local` and the real
// hook bundle, with a fake GitHub (scripts/fake-github.mjs). Run with `npm run e2e`. Prints `PASS n name` or
// `FAIL n name: detail` per scenario and exits non-zero on any failure.
//
// Everything is local: wrangler runs with --local and --persist-to a temp directory, secrets go in through a temp
// --env-file, the GitHub App key is generated here, every hook runs with ECHO_HOME and HOME in temp directories,
// ECHO_TOKEN_STORE=file, and fake `gh`, `claude` and `security` commands first on PATH. Child processes are killed
// and temp directories removed on exit, failure or Ctrl-C (set E2E_KEEP=1 to keep the temp directory).
//
// The Worker runs on the real clock. Where a scenario needs time to pass (approval windows, escalation, deferral,
// the 10-minute status reconcile), it moves the stored timestamps back in the local D1 with
// `wrangler d1 execute --local --persist-to`; each place says which scenario does it and why. The 30-minute
// override expiry is the hook's own clock, so scenario 11 moves the hook's local state file instead.
//
// `--only 1,3` (or `--only=1,3`) runs only those scenarios, as E2E_ONLY=1,3 does.
//
// Remote mode: E2E_URL=<url> E2E_ADMIN_PASSWORD=<password> npm run e2e -- --only 1,3,6,12,13
// runs against an Echo that is already running at <url> instead of starting wrangler. The password is read from the
// environment and never printed. The run works in throwaway projects named e2e-<timestamp> (plus -approvals and
// -private), with its own agents and repositories (e2e-<timestamp>/app, ...), and afterwards releases what is still
// open, removes the repositories, revokes the agents and archives the projects. The fake GitHub then serves only the
// fake `gh` the hooks run: it gets no webhook URL, and the Worker's own GitHub calls go wherever that Worker is
// configured to send them. So remote mode skips what needs the Worker to talk to the fake GitHub (echo/hold statuses,
// webhooks), to be stopped or restarted, or the local D1 and /__scheduled; it prints each skip and why.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGithub } from './fake-github.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE = path.join(ROOT, 'service');
const HOOK_BUNDLE = path.join(ROOT, 'hooks', 'dist', 'echo-hook.mjs');
const FAKE_GITHUB = path.join(ROOT, 'scripts', 'fake-github.mjs');
const WRANGLER = path.join(path.dirname(createRequire(path.join(SERVICE, 'package.json')).resolve('wrangler/package.json')), 'bin', 'wrangler.js');
const NODE = process.execPath;

const SCENARIO_TIMEOUT_MS = 180_000;
const WAIT_MS = 20_000;
const APP_ID = '424242';

// ---------------------------------------------------------------- arguments and mode

for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--only' && i + 1 < process.argv.length) process.env.E2E_ONLY = process.argv[++i];
  else if (a.startsWith('--only=')) process.env.E2E_ONLY = a.slice('--only='.length);
  else {
    console.error(`e2e: unknown argument ${a} (the only one is --only 1,3,...)`);
    process.exit(2);
  }
}

const REMOTE_URL = (process.env.E2E_URL ?? '').trim().replace(/\/+$/, '');
const REMOTE = REMOTE_URL !== '';
if (REMOTE) {
  let ok = false;
  try {
    ok = ['http:', 'https:'].includes(new URL(REMOTE_URL).protocol);
  } catch {
    // not a URL
  }
  if (!ok) {
    console.error('e2e: E2E_URL must be the http(s) address of a running Echo, for example https://echo.example.workers.dev');
    process.exit(2);
  }
  if (!process.env.E2E_ADMIN_PASSWORD) {
    console.error('e2e: remote mode (E2E_URL) needs the admin password in E2E_ADMIN_PASSWORD; it is never printed');
    process.exit(2);
  }
}
const ADMIN_PASSWORD = REMOTE ? process.env.E2E_ADMIN_PASSWORD : crypto.randomBytes(12).toString('hex');
// Remote mode shares the server with real work, so every name it creates is its own: e2e-<timestamp>...
const RUN = `e2e-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
/** Agent names. */
const NM = REMOTE ? { A: `${RUN}-a`, B: `${RUN}-b`, C: `${RUN}-c` } : { A: 'A', B: 'B', C: 'C' };
/** Project names. */
const PN = REMOTE ? { app: RUN, approvals: `${RUN}-approvals`, private: `${RUN}-private` } : { app: 'app', approvals: 'approvals', private: 'private' };
const WEBHOOK_SECRET = crypto.randomBytes(16).toString('hex');
const MINUTE = 60_000;

const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'echo-e2e-'));
const STATE = path.join(TMP, 'd1-state');
const BIN = path.join(TMP, 'bin');
const WORK = path.join(TMP, 'work');
const ENV_FILE = path.join(TMP, 'worker.env');
const WRANGLER_ENV = {
  ...process.env,
  WRANGLER_SEND_METRICS: 'false',
  CI: '1',
  WRANGLER_LOG_PATH: path.join(TMP, 'wrangler-logs'),
};

// ---------------------------------------------------------------- processes and cleanup

const children = new Set(); // { child, group }
const servers = [];
let cleanedUp = false;

function killAll(signal) {
  for (const { child, group } of children) {
    try {
      if (group) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // already gone
    }
  }
}

function cleanupSync() {
  if (cleanedUp) return;
  cleanedUp = true;
  killAll('SIGKILL');
  if (process.env.E2E_KEEP === '1') console.error(`e2e: kept ${TMP}`);
  else fs.rmSync(TMP, { recursive: true, force: true });
}

process.on('exit', cleanupSync);
let interrupted = false;
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.on(sig, async () => {
    if (interrupted) return;
    interrupted = true;
    // SIGTERM first so wrangler can remove its own temp files; whatever is still running after 5 s is killed.
    if (REMOTE) await withTimeout(remoteCleanup(), 60_000, 'remote cleanup').catch((e) => console.error(`e2e: ${e.message}`));
    killAll('SIGTERM');
    const end = Date.now() + 5000;
    while (children.size && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    cleanupSync();
    process.exit(code);
  });
}

/** Runs a command to completion. Never throws for a non-zero exit; it does for a timeout. */
function run(cmd, args, { cwd = WORK, env, input, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const entry = { child, group: false };
    children.add(entry);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${path.basename(cmd)} ${args.join(' ').slice(0, 120)} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      children.delete(entry);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      children.delete(entry);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls until `fn` returns a truthy value; throws naming what it waited for. */
async function waitFor(fn, what, timeoutMs = WAIT_MS) {
  const end = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${last.message})` : ''}`);
    await sleep(150);
  }
}

// ---------------------------------------------------------------- assertions

function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function includes(text, part, what) {
  if (!String(text ?? '').includes(part)) {
    throw new Error(`${what}: expected to contain ${JSON.stringify(part)}, got ${JSON.stringify(String(text ?? '').slice(0, 600))}`);
  }
}
function excludes(text, part, what) {
  if (String(text ?? '').includes(part)) throw new Error(`${what}: expected not to contain ${JSON.stringify(part)}, got ${JSON.stringify(String(text).slice(0, 600))}`);
}

// ---------------------------------------------------------------- the Worker

let PORT;
let BASE;
let INSPECTOR_PORT;
let worker = null;
let workerStarts = 0;
let fake;

async function startWorker() {
  assert(!REMOTE, 'e2e bug: wrangler was about to start in remote mode');
  workerStarts++;
  const log = path.join(TMP, `wrangler-${workerStarts}.log`);
  const fd = fs.openSync(log, 'w');
  const child = spawn(
    NODE,
    [
      WRANGLER, 'dev', '--local',
      '--persist-to', STATE,
      '--env-file', ENV_FILE,
      '--ip', '127.0.0.1',
      '--port', String(PORT),
      '--inspector-port', String(INSPECTOR_PORT),
      '--test-scheduled',
      '--show-interactive-dev-session=false',
      '--var', `PUBLIC_URL:${BASE}`,
      '--var', `GITHUB_API_URL:${fake.url}`,
    ],
    { cwd: SERVICE, env: WRANGLER_ENV, stdio: ['ignore', fd, fd], detached: true },
  );
  fs.closeSync(fd);
  const entry = { child, group: true };
  children.add(entry);
  let exited = false;
  child.on('exit', () => {
    exited = true;
    children.delete(entry);
  });
  worker = { child, entry, log, exited: () => exited };
  await waitFor(
    async () => {
      if (exited) throw new Error(`wrangler dev exited:\n${tail(log)}`);
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    },
    `wrangler dev on ${BASE}`,
    90_000,
  ).catch((e) => {
    throw new Error(`${e.message}\n${tail(log)}`);
  });
}

async function stopWorker() {
  if (!worker) return;
  const w = worker;
  worker = null;
  if (!w.exited()) {
    try {
      process.kill(-w.child.pid, 'SIGTERM');
    } catch {
      // gone
    }
    await waitFor(() => w.exited(), 'wrangler dev to exit', 10_000).catch(() => {
      try {
        process.kill(-w.child.pid, 'SIGKILL');
      } catch {
        // gone
      }
    });
  }
  // workerd can outlive its parent for a moment: wait until the port refuses connections.
  await waitFor(
    async () => {
      try {
        await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) });
        return false;
      } catch {
        return true;
      }
    },
    'the Worker port to close',
    15_000,
  );
}

function tail(file, lines = 40) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

/** Runs SQL against the local D1 the dev server uses. Only for moving stored times back (see each caller). */
async function d1(sql) {
  assert(!REMOTE, 'e2e bug: a local D1 edit was reached in remote mode');
  const r = await run(NODE, [WRANGLER, 'd1', 'execute', 'echo', '--local', '--persist-to', STATE, '--json', '--command', sql], {
    cwd: SERVICE,
    env: WRANGLER_ENV,
  });
  if (r.code !== 0) throw new Error(`wrangler d1 execute failed (${r.code}): ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout);
}

async function cron() {
  assert(!REMOTE, 'e2e bug: /__scheduled was reached in remote mode');
  const res = await fetch(`${BASE}/__scheduled?cron=*+*+*+*+*`, { signal: AbortSignal.timeout(30_000) });
  assert(res.ok, `/__scheduled answered ${res.status}`);
  await res.text();
}

const iso = (ms) => new Date(ms).toISOString();
const sqlText = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ---------------------------------------------------------------- admin (the owner)

const admin = {
  cookie: null,
  async request(method, p, form) {
    const res = await fetch(BASE + p, {
      method,
      redirect: 'manual',
      headers: {
        ...(this.cookie ? { cookie: `echo_admin=${this.cookie}` } : {}),
        ...(method === 'POST' ? { origin: BASE, 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    return { status: res.status, location: res.headers.get('location'), setCookie: res.headers.get('set-cookie'), text: await res.text() };
  },
  async login() {
    const r = await this.request('POST', '/admin/login', { password: ADMIN_PASSWORD });
    const m = /echo_admin=([^;]+)/.exec(r.setCookie ?? '');
    assert(r.status === 303 && m, `admin login failed: ${r.status}`);
    this.cookie = m[1];
  },
  /** An admin action that must succeed with a redirect. */
  async act(p, form = {}) {
    const r = await this.request('POST', p, form);
    if (r.status !== 303) throw new Error(`admin POST ${p} answered ${r.status}: ${banner(r.text)}`);
    return r;
  },
  async get(p) {
    const r = await this.request('GET', p);
    assert(r.status === 200, `admin GET ${p} answered ${r.status}`);
    return r.text;
  },
  async createProject(name) {
    const r = await this.act('/admin/projects', { name });
    const m = /\/admin\/p\/(\d+)$/.exec(r.location ?? '');
    assert(m, `no project id in ${r.location}`);
    return Number(m[1]);
  },
  /** Creates an agent in a project; its token is shown once, on the response page. */
  async createAgent(projectId, name) {
    const r = await this.request('POST', `/admin/p/${projectId}/agents`, { name });
    const m = /<code>(echo_[A-Za-z0-9_-]+)<\/code>/.exec(r.text);
    assert(r.status === 200 && m, `creating agent ${name} failed: ${r.status} ${banner(r.text)}`);
    return { name, token: m[1], id: await this.agentId(projectId, name) };
  },
  async agentId(projectId, name) {
    const page = await this.get(`/admin/p/${projectId}/agents`);
    const m = new RegExp(`<tr><td>${name}(?: <span[^>]*>[^<]*</span>)?</td>[\\s\\S]*?/agents/(\\d+)/reissue`).exec(page);
    assert(m, `agent ${name} is not listed in project ${projectId}`);
    return Number(m[1]);
  },
  async assign(projectId, agent) {
    await this.act(`/admin/p/${projectId}/agents/assign`, { agent: String(agent.id) });
  },
};

function banner(html) {
  const m = /<div class="banner[^"]*">([\s\S]*?)<\/div>/.exec(html ?? '');
  return (m ? m[1] : String(html ?? '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

// ---------------------------------------------------------------- MCP and the hook API

let rpcId = 1;

async function mcpRaw(token, method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json = null;
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean);
    json = data.length ? JSON.parse(data[data.length - 1]) : null;
  } else if (text) {
    json = JSON.parse(text);
  }
  return { status: res.status, json };
}

async function tool(agent, name, args = {}) {
  const { status, json } = await mcpRaw(agent.token, 'tools/call', { name, arguments: args });
  if (!json?.result) return { status, isError: true, text: `HTTP ${status} ${JSON.stringify(json)}` };
  return { status, isError: json.result.isError === true, text: json.result.content.map((c) => c.text).join('\n') };
}

/** A tool call that must succeed; returns its parsed JSON result. */
async function call(agent, name, args = {}) {
  const r = await tool(agent, name, args);
  if (r.isError) throw new Error(`${agent.name} ${name} failed: ${r.text}`);
  return JSON.parse(r.text);
}

/** A tool call that must be refused; returns the refusal text. */
async function refused(agent, name, args = {}) {
  const r = await tool(agent, name, args);
  if (!r.isError) throw new Error(`${agent.name} ${name} was expected to be refused, but returned ${r.text.slice(0, 300)}`);
  return r.text;
}

async function hookApi(token, method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

/** Every change in a project, in order. */
async function changes(agent, project) {
  const out = [];
  let since = 0;
  for (;;) {
    const r = await call(agent, 'echo_changes_since', { project, since_seq: since, limit: 500 });
    out.push(...r.changes);
    if (r.changes.length < 500) return out;
    since = r.next_seq;
  }
}

/** Acknowledges everything the agent still has to acknowledge, so a scenario starts from a clean inbox. */
async function drainInbox(agent) {
  for (const m of await call(agent, 'echo_inbox')) {
    if (m.requiresAck && !m.acknowledged) await call(agent, 'echo_ack_message', { message_id: m.messageId, note: 'e2e: clearing the inbox' });
  }
}

// ---------------------------------------------------------------- machines, sessions and hooks

/** One orchestrator machine: its own HOME and ECHO_HOME, with the hooks installed by the real installer. */
function machine(name) {
  const home = path.join(TMP, `${name}-home`);
  const echoHome = path.join(home, '.echo');
  fs.mkdirSync(home, { recursive: true });
  return {
    name,
    home,
    echoHome,
    settings: path.join(home, '.claude', 'settings.json'),
    env: {
      PATH: `${BIN}:${process.env.PATH}`,
      HOME: home,
      ECHO_HOME: echoHome,
      ECHO_TOKEN_STORE: 'file',
      FAKE_GITHUB_URL: fake.url,
      LANG: 'C',
    },
    wrapperEnv: new Map(),
  };
}

async function install(m, agent) {
  const r = await run(NODE, [HOOK_BUNDLE, 'install', '--url', BASE, '--agent', agent.name, '--settings', m.settings], {
    env: m.env,
    input: agent.token + '\n',
  });
  assert(r.code === 0, `install for ${agent.name} failed: ${r.stderr}`);
  includes(r.stdout, `Echo is installed for "${agent.name}"`, 'install output');
  const settingsText = fs.readFileSync(m.settings, 'utf8');
  excludes(settingsText, agent.token, 'settings.json');
  excludes(fs.readFileSync(path.join(m.echoHome, 'config.json'), 'utf8'), agent.token, 'config.json');
  assert((fs.statSync(path.join(m.echoHome, 'tokens', agent.name)).mode & 0o777) === 0o600, 'token file is not 0600');
}

/** What the launch wrapper puts in the orchestrator's environment (a fake `claude` prints it). */
async function wrapperEnv(m, agentName) {
  if (!m.wrapperEnv.has(agentName)) {
    const r = await run(path.join(m.echoHome, 'echo-claude'), [agentName], { env: m.env });
    assert(r.code === 0, `echo-claude ${agentName} failed: ${r.stderr}`);
    const v = JSON.parse(r.stdout);
    assert(v.ECHO_AGENT === agentName && v.ECHO_TOKEN, `echo-claude did not set ECHO_AGENT/ECHO_TOKEN for ${agentName}`);
    m.wrapperEnv.set(agentName, { ECHO_AGENT: v.ECHO_AGENT, ECHO_TOKEN: v.ECHO_TOKEN });
  }
  return m.wrapperEnv.get(agentName);
}

/**
 * A Claude Code session on a machine. `orchestrator` launches it through echo-claude (ECHO_AGENT and ECHO_TOKEN
 * set); without it the session is a separate subagent session. `agentId` makes it a subagent started with the
 * Agent tool inside the orchestrator's session (the hook input carries agent_id). `override` sets
 * ECHO_MERGE_OVERRIDE in the environment Claude Code was launched from.
 */
async function session(m, { orchestrator, agentId, override } = {}) {
  return {
    m,
    id: crypto.randomUUID(),
    agentId,
    env: {
      ...m.env,
      ...(orchestrator ? await wrapperEnv(m, orchestrator) : {}),
      ...(override ? { ECHO_MERGE_OVERRIDE: override } : {}),
    },
  };
}

/** The command Claude Code would run for a hook, read from the installed settings.json. */
function hookCommand(m, arg) {
  const settings = JSON.parse(fs.readFileSync(m.settings, 'utf8'));
  for (const groups of Object.values(settings.hooks ?? {})) {
    for (const g of groups) for (const h of g.hooks ?? []) if (typeof h.command === 'string' && h.command.endsWith(` ${arg}`)) return h.command;
  }
  throw new Error(`no ${arg} hook in ${m.settings}`);
}

const EVENTS = {
  'session-start': 'SessionStart',
  prompt: 'UserPromptSubmit',
  'post-tool': 'PostToolUse',
  'post-bash': 'PostToolUse',
  'pre-bash': 'PreToolUse',
  stop: 'Stop',
};

/** Runs one hook the way Claude Code does: the settings command under sh, the event JSON on stdin. */
async function hook(s, arg, extra = {}) {
  const input = {
    session_id: s.id,
    transcript_path: path.join(s.m.home, 'transcript.jsonl'),
    cwd: WORK,
    permission_mode: 'default',
    hook_event_name: EVENTS[arg],
    ...(s.agentId ? { agent_id: s.agentId, agent_type: 'general-purpose' } : {}),
    ...extra,
  };
  const r = await run('/bin/sh', ['-c', hookCommand(s.m, arg)], { env: s.env, input: JSON.stringify(input), timeoutMs: 45_000 });
  assert(r.code === 0, `${arg} hook exited ${r.code}: ${r.stderr}`);
  let json = null;
  try {
    json = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  } catch {
    // plain text output
  }
  return { stdout: r.stdout, json };
}

const sessionStart = (s, source = 'startup') => hook(s, 'session-start', { source });
const prompt = (s) => hook(s, 'prompt', { prompt: 'Carry on.' });
const stopHook = (s) => hook(s, 'stop', { stop_hook_active: false });

/**
 * A Bash tool call: the PreToolUse hook, then (if allowed) the command itself, then the PostToolUse Bash hook when
 * it succeeded (Claude Code sends a failed command to PostToolUseFailure, where Echo has no hook).
 */
async function bash(s, command) {
  const toolUseId = `toolu_${crypto.randomBytes(8).toString('hex')}`;
  const toolInput = { command, description: 'e2e' };
  const pre = await hook(s, 'pre-bash', { tool_name: 'Bash', tool_input: toolInput, tool_use_id: toolUseId });
  const out = pre.json?.hookSpecificOutput;
  if (pre.stdout.trim() && !pre.json) throw new Error(`pre-bash printed something that is not JSON: ${pre.stdout}`);
  if (out?.permissionDecision === 'deny') return { denied: true, reason: out.permissionDecisionReason };
  const r = await run('/bin/sh', ['-c', command], { env: s.env });
  if (r.code === 0) {
    await hook(s, 'post-bash', {
      tool_name: 'Bash',
      tool_input: toolInput,
      tool_use_id: toolUseId,
      tool_response: { stdout: r.stdout, stderr: r.stderr, interrupted: false, isImage: false },
    });
  }
  return { denied: false, code: r.code, stdout: r.stdout, stderr: r.stderr, context: out?.additionalContext ?? null };
}

/** A command run with no Echo hook in front of it: a merge from the website, the API, or a machine without Echo. */
async function direct(s, command) {
  return { denied: false, ...(await run('/bin/sh', ['-c', command], { env: s.env })) };
}

const mergeCmd = (repo, n) => `gh pr merge ${n} -R ${repo} --squash`;

function expectRefused(r, what, ...parts) {
  assert(r.denied, `${what}: expected the hook to refuse the merge, but it ran (exit ${r.code}): ${r.stderr || r.stdout}`);
  for (const p of parts) includes(r.reason, p, `${what} refusal`);
}

async function expectMerged(r, repo, n, what) {
  skipRemote("GitHub's required echo/hold check on the merge (the fake GitHub lets every merge the hook allows through)", NO_FAKE_GITHUB);
  assert(!r.denied, `${what}: the hook refused the merge: ${r.reason}`);
  assert(r.code === 0, `${what}: gh pr merge failed (exit ${r.code}): ${r.stderr}`);
  assert(fake.pr(repo, n)?.mergedAt, `${what}: GitHub does not show ${repo}#${n} merged`);
  await fake.settle(); // GitHub's own closed event
}

// ---------------------------------------------------------------- GitHub helpers

// ---------------------------------------------------------------- what remote mode skips

const NO_FAKE_GITHUB =
  "the Worker's GitHub calls do not reach this run's fake GitHub in remote mode (no webhooks to the Worker, no echo/hold statuses to wait for)";
const remoteSkips = []; // { scenario, what, why }
let currentScenario = 0;

/** In remote mode, notes that `what` is skipped in the current scenario and why, and returns true. Locally, false. */
function skipRemote(what, why) {
  if (!REMOTE) return false;
  if (!remoteSkips.some((s) => s.scenario === currentScenario && s.what === what)) remoteSkips.push({ scenario: currentScenario, what, why });
  return true;
}

/**
 * Opens a PR on the fake GitHub (which tells the Worker) and waits for Echo's first echo/hold status on it. In remote
 * mode the PR exists only for the fake `gh` the hooks run.
 */
async function openPr(repo, n, state) {
  const { delivery } = await fake.openPr(repo, n);
  if (skipRemote('echo/hold statuses and the webhooks behind them', NO_FAKE_GITHUB)) return;
  assert(delivery.ok, `the opened webhook for ${repo}#${n} failed: ${delivery.status} ${delivery.error}`);
  await waitStatus(repo, n, state);
}

/** Waits until the newest echo/hold status on the PR's current head commit is `state`. */
async function waitStatus(repo, n, state, descriptionPart) {
  if (skipRemote('echo/hold statuses and the webhooks behind them', NO_FAKE_GITHUB)) return null;
  return waitFor(
    () => {
      const pr = fake.pr(repo, n);
      const s = pr && fake.latestHold(repo, pr.head);
      return s && s.state === state && (!descriptionPart || s.description.includes(descriptionPart)) ? s : null;
    },
    `echo/hold ${state}${descriptionPart ? ` (${descriptionPart})` : ''} on ${repo}#${n}`,
  );
}

const headStatus = (repo, n) => fake.latestHold(repo, fake.pr(repo, n).head);

// ---------------------------------------------------------------- notification listener (scenario 10)

const notices = [];

async function startNotifyListener() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      notices.push({ path: req.url, title: req.headers.title, priority: req.headers.priority, click: req.headers.click, body });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/echo-owner`;
}

// ---------------------------------------------------------------- the world

const OWNER = REMOTE ? RUN : 'acme';
const REPO = `${OWNER}/app`; // project "app": approvals off
const REPO_APPROVALS = `${OWNER}/approvals`; // project "approvals": approvals required, ±30 minutes
const REPO_PRIVATE = `${OWNER}/private`; // project "private": A only

const P = {}; // project ids
const AG = {}; // agents A, B, C
const M = {}; // machines
let bSession; // B's orchestrator session
let aSession; // A's orchestrator session

/** Local mode: writes the Worker's secrets, applies the migrations to a temp D1 and starts `wrangler dev --local`. */
async function startLocalWorker(privateKey) {
  PORT = await freePort();
  INSPECTOR_PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  fake.setWebhookUrl(`${BASE}/github/webhook`);

  // The Worker's secrets. The PEM goes on one line: the Worker strips the armour and all whitespace.
  const pemOneLine = privateKey.replace(/\n/g, '');
  fs.writeFileSync(
    ENV_FILE,
    [
      `ADMIN_PASSWORD="${ADMIN_PASSWORD}"`,
      `SESSION_SECRET="${crypto.randomBytes(24).toString('hex')}"`,
      `GITHUB_APP_ID="${APP_ID}"`,
      `GITHUB_APP_PRIVATE_KEY="${pemOneLine}"`,
      `GITHUB_WEBHOOK_SECRET="${WEBHOOK_SECRET}"`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );

  const mig = await run(NODE, [WRANGLER, 'd1', 'migrations', 'apply', 'echo', '--local', '--persist-to', STATE], { cwd: SERVICE, env: WRANGLER_ENV });
  assert(mig.code === 0, `applying migrations failed: ${mig.stderr || mig.stdout}`);
  await startWorker();
}

async function setup() {
  fs.mkdirSync(BIN, { recursive: true });
  fs.mkdirSync(WORK, { recursive: true });
  const q = (s) => `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
  fs.writeFileSync(path.join(BIN, 'gh'), `#!/bin/sh\nexec ${q(NODE)} ${q(FAKE_GITHUB)} gh "$@"\n`, { mode: 0o755 });
  // The launch wrapper ends in `exec claude`: this one reports the environment it was given.
  fs.writeFileSync(
    path.join(BIN, 'claude'),
    `#!/bin/sh\nexec ${q(NODE)} -e 'process.stdout.write(JSON.stringify({ECHO_AGENT: process.env.ECHO_AGENT, ECHO_TOKEN: process.env.ECHO_TOKEN}))'\n`,
    { mode: 0o755 },
  );
  // ECHO_TOKEN_STORE=file keeps the hooks off the Keychain; this makes any attempt fail loudly instead.
  fs.writeFileSync(path.join(BIN, 'security'), `#!/bin/sh\necho "e2e: the Keychain must not be used" >&2\nexit 1\n`, { mode: 0o755 });

  const build = await run('npm', ['run', 'build', '-w', 'hooks'], { cwd: ROOT, env: process.env });
  assert(build.code === 0, `building the hook bundle failed: ${build.stderr}`);

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  // Remote mode: the Worker's echo/hold statuses never reach this fake, so it does not stand in for GitHub's required
  // check either; merges then pass or fail on the hook alone (GitHub's side is Task 20 step 4, on the real GitHub).
  fake = await startFakeGithub({ appId: APP_ID, publicKeyPem: publicKey, webhookSecret: WEBHOOK_SECRET, requireHold: !REMOTE });
  servers.push({ close: (cb) => fake.close().then(cb) });

  if (REMOTE) {
    // The Echo at E2E_URL is already running. The fake GitHub gets no webhook URL: it only answers the fake `gh`.
    BASE = REMOTE_URL;
  } else {
    await startLocalWorker(privateKey);
  }

  // The owner seeds everything through the admin page.
  await admin.login();
  P.app = await admin.createProject(PN.app);
  P.approvals = await admin.createProject(PN.approvals);
  P.private = await admin.createProject(PN.private);
  AG.A = await admin.createAgent(P.app, NM.A);
  AG.B = await admin.createAgent(P.app, NM.B);
  await admin.assign(P.approvals, AG.A);
  await admin.assign(P.approvals, AG.B);
  await admin.assign(P.private, AG.A);
  await admin.act(`/admin/p/${P.approvals}/settings`, { approvals: 'on', window: '30' });
  await admin.act(`/admin/p/${P.app}/repos`, { repo: REPO });
  await admin.act(`/admin/p/${P.approvals}/repos`, { repo: REPO_APPROVALS });
  await admin.act(`/admin/p/${P.private}/repos`, { repo: REPO_PRIVATE });

  // Each orchestrator has its own machine; the installer checks the token and caches the gated repositories.
  M.A = machine('a');
  M.B = machine('b');
  await install(M.A, AG.A);
  await install(M.B, AG.B);
  aSession = await session(M.A, { orchestrator: NM.A });
  bSession = await session(M.B, { orchestrator: NM.B });
}

// ---------------------------------------------------------------- scenarios

const scenarios = [];
/** `remoteSkip` says why the whole scenario cannot run in remote mode. */
const scenario = (n, name, fn, remoteSkip = null) => scenarios.push({ n, name, fn, remoteSkip });

scenario(1, 'The incident, replayed', async () => {
  const { A, B } = AG;
  await openPr(REPO, 1, 'success');
  const hold = await call(A, 'echo_place_hold', { repo: REPO, pr: 1, reason: 'Drops the session cookie on login; fix pending' });
  assert(hold.kind === 'blocking', `hold kind is ${hold.kind}`);
  await waitStatus(REPO, 1, 'failure');

  // B has not looked at anything (no hook has run in its session yet in this scenario).
  let r = await bash(bSession, mergeCmd(REPO, 1));
  expectRefused(r, 'first attempt', 'Blocking hold', `by ${NM.A}`, 'Drops the session cookie on login');

  await call(B, 'echo_ack_hold', { hold_id: hold.id, note: 'Seen; I will wait for your fix' });
  const aSees = await prompt(aSession);
  includes(aSees.stdout, `${NM.B} acknowledged blocking hold ${hold.id}`, "A's prompt hook");
  includes(aSees.stdout, 'Seen; I will wait for your fix', "A's prompt hook");

  r = await bash(bSession, mergeCmd(REPO, 1));
  expectRefused(r, 'attempt after acknowledging', 'Blocking hold', `by ${NM.A}`);
  assert(!fake.pr(REPO, 1).mergedAt, 'the PR merged while the hold was open');

  await call(A, 'echo_release_hold', { hold_id: hold.id, note: 'Fixed in the latest commit' });
  await waitStatus(REPO, 1, 'success');
  r = await bash(bSession, mergeCmd(REPO, 1));
  await expectMerged(r, REPO, 1, 'merge after release');
});

scenario(2, 'Advisory hold', async () => {
  const { A, B } = AG;
  await openPr(REPO, 2, 'success');
  const hold = await call(A, 'echo_place_hold', { repo: REPO, pr: 2, reason: 'Check the new env var is set in prod', kind: 'advisory' });
  await waitStatus(REPO, 2, 'failure');
  let r = await bash(bSession, mergeCmd(REPO, 2));
  expectRefused(r, 'attempt with the advisory hold open', 'Advisory hold', `by ${NM.A}`, 'Check the new env var');

  await call(B, 'echo_ack_hold', { hold_id: hold.id, note: 'Env var is set in prod' });
  await waitStatus(REPO, 2, 'success');
  r = await bash(bSession, mergeCmd(REPO, 2));
  await expectMerged(r, REPO, 2, 'merge after acknowledging');
});

scenario(3, 'Approval required', async () => {
  const { A, B } = AG;
  await openPr(REPO_APPROVALS, 3, 'failure');
  let r = await bash(bSession, mergeCmd(REPO_APPROVALS, 3));
  expectRefused(r, 'unscheduled merge', 'No approved merge slot');

  const slot = iso(Date.now() + 5 * MINUTE);
  const event = await call(B, 'echo_calendar_add', { project: PN.approvals, title: 'Merge #3', starts_at: slot, kind: 'merge', repo: REPO_APPROVALS, pr: 3 });
  const aSees = await prompt(aSession);
  includes(aSees.stdout, `APPROVAL REQUESTED: ${NM.B} plans to merge ${REPO_APPROVALS}#3`, "A's prompt hook");
  assert((await call(A, 'echo_pending_approvals')).some((p) => p.eventId === event.id), "the request is not in A's pending approvals");

  r = await bash(bSession, mergeCmd(REPO_APPROVALS, 3));
  expectRefused(r, 'merge before approval', `Waiting for approval from ${NM.A}`);

  await call(A, 'echo_approve_merge', { event_id: event.id });
  await waitStatus(REPO_APPROVALS, 3, 'success');

  // B updates its branch after the approval: the approval belongs to the PR and its slot, not to a commit.
  const oldHead = fake.pr(REPO_APPROVALS, 3).head;
  const { delivery } = await fake.push(REPO_APPROVALS, 3);
  if (!skipRemote('echo/hold statuses and the webhooks behind them', NO_FAKE_GITHUB)) assert(delivery.ok, `synchronize webhook failed: ${delivery.error}`);
  assert(fake.pr(REPO_APPROVALS, 3).head !== oldHead, 'the head did not change');
  await waitStatus(REPO_APPROVALS, 3, 'success');
  r = await bash(bSession, mergeCmd(REPO_APPROVALS, 3));
  await expectMerged(r, REPO_APPROVALS, 3, 'merge inside the window after a new commit');

  if (
    skipRemote(
      'PR #30: a merge 31 minutes after its approved slot, the window-closed status, and rescheduling',
      'the slot and its approval move 31 minutes back in the local D1, and the status cron runs through /__scheduled; neither exists remotely',
    )
  ) {
    return;
  }
  // A second PR, approved, attempted more than 30 minutes after its slot.
  await openPr(REPO_APPROVALS, 30, 'failure');
  const late = await call(B, 'echo_calendar_add', {
    project: PN.approvals, title: 'Merge #30', starts_at: iso(Date.now() + 5 * MINUTE), kind: 'merge', repo: REPO_APPROVALS, pr: 30,
  });
  await call(A, 'echo_approve_merge', { event_id: late.id });
  await waitStatus(REPO_APPROVALS, 30, 'success');
  // Scenario 3 needs the slot to be 31 minutes in the past. The Worker's clock is real, so the slot (and the
  // approval given for it) move back instead, and the status cron's last-run mark moves to before the window's
  // close, as it would be after 31 real minutes, so the next cron run sees the window close.
  const past = iso(Date.now() - 31 * MINUTE);
  await d1(
    `UPDATE events SET starts_at = ${sqlText(past)} WHERE id = ${late.id};
     UPDATE event_approvers SET approved_for_starts_at = ${sqlText(past)} WHERE event_id = ${late.id} AND response = 'approved';
     UPDATE owner_settings SET value = ${sqlText(iso(Date.now() - 2 * MINUTE))} WHERE key = 'status_cron_at';`,
  );
  r = await bash(bSession, mergeCmd(REPO_APPROVALS, 30));
  expectRefused(r, 'merge 31 minutes after the slot', 'Outside the approved window', 'Reschedule');
  await cron();
  await waitStatus(REPO_APPROVALS, 30, 'failure', 'Outside approved slot');

  // Rescheduling sends a new request; the old approval does not carry over.
  await call(B, 'echo_calendar_update', { event_id: late.id, starts_at: iso(Date.now() + 5 * MINUTE) });
  r = await bash(bSession, mergeCmd(REPO_APPROVALS, 30));
  expectRefused(r, 'merge after rescheduling, before approval', `Waiting for approval from ${NM.A}`);
  assert((await call(A, 'echo_pending_approvals')).some((p) => p.eventId === late.id), 'no new approval request after rescheduling');
  await call(A, 'echo_approve_merge', { event_id: late.id });
  await waitStatus(REPO_APPROVALS, 30, 'success');
  r = await bash(bSession, mergeCmd(REPO_APPROVALS, 30));
  await expectMerged(r, REPO_APPROVALS, 30, 'merge after rescheduling and approval');
});

scenario(4, 'Objection', async () => {
  const { A, B } = AG;
  await openPr(REPO_APPROVALS, 4, 'failure');
  const event = await call(B, 'echo_calendar_add', {
    project: PN.approvals, title: 'Merge #4', starts_at: iso(Date.now() + 5 * MINUTE), kind: 'merge', repo: REPO_APPROVALS, pr: 4,
  });
  const hold = await call(A, 'echo_object_merge', { event_id: event.id, reason: 'The migration is not reversible' });
  assert(hold.kind === 'blocking' && hold.placedBy === NM.A && hold.state === 'open', `objection hold: ${JSON.stringify(hold)}`);
  const holds = await call(B, 'echo_list_holds', { project: PN.approvals });
  assert(holds.some((h) => h.id === hold.id && h.kind === 'blocking' && h.reason.includes('The migration is not reversible')), 'the objection is not listed as a blocking hold');
  await waitStatus(REPO_APPROVALS, 4, 'failure', `blocking hold by ${NM.A}`);

  let r = await bash(bSession, mergeCmd(REPO_APPROVALS, 4));
  expectRefused(r, 'merge with the objection open', `Blocking hold ${hold.id} by ${NM.A}`, 'The migration is not reversible');

  await call(A, 'echo_release_hold', { hold_id: hold.id, note: 'Made the migration reversible' });
  // The objection no longer blocks. In an approvals project the merge still needs A's approval (spec 6.6).
  r = await bash(bSession, mergeCmd(REPO_APPROVALS, 4));
  expectRefused(r, 'merge after the objection was released, before approval', `Waiting for approval from ${NM.A}`);
  excludes(r.reason, 'The migration is not reversible', 'refusal after release');
  await call(A, 'echo_approve_merge', { event_id: event.id });
  await waitStatus(REPO_APPROVALS, 4, 'success');
  r = await bash(bSession, mergeCmd(REPO_APPROVALS, 4));
  await expectMerged(r, REPO_APPROVALS, 4, 'merge after release and approval');
});

scenario(5, 'GitHub enforcement', async () => {
  const { A } = AG;
  const ghApiMerge = (n) => `gh api -X PUT repos/${REPO}/pulls/${n}/merge`;
  await openPr(REPO, 5, 'success');
  const hold = await call(A, 'echo_place_hold', { repo: REPO, pr: 5, reason: 'Wait for the security review' });
  const failing = await waitStatus(REPO, 5, 'failure');
  includes(failing.description, `blocking hold by ${NM.A}`, 'echo/hold description');

  // The hook refuses a gh api merge itself, since it cannot check one.
  let r = await bash(bSession, ghApiMerge(5));
  assert(r.denied, `gh api merge through the hook: expected the hook to refuse it, but it ran (exit ${r.code})`);
  // A merge that never passes the hook (the website, the API from a machine without Echo) is refused by GitHub's
  // required echo/hold check.
  r = await direct(bSession, ghApiMerge(5));
  assert(r.code !== 0, `gh api merge with the hold open: expected GitHub to refuse it, got exit ${r.code}`);
  includes(r.stderr, 'Required status check "echo/hold" is failing', 'GitHub refusal');
  assert(!fake.pr(REPO, 5).mergedAt, 'merged past a failing echo/hold');

  await call(A, 'echo_release_hold', { hold_id: hold.id, note: 'Security review passed' });
  await waitStatus(REPO, 5, 'success');
  r = await direct(bSession, ghApiMerge(5));
  assert(r.code === 0 && fake.pr(REPO, 5).mergedAt, `gh api merge after release failed: ${r.stderr}`);
  await fake.settle();

  // A commit pushed while Echo is down has no echo/hold status, so GitHub refuses the merge on every path.
  await openPr(REPO, 50, 'success');
  await stopWorker();
  try {
    const { delivery } = await fake.push(REPO, 50);
    assert(!delivery.ok, 'the synchronize webhook reached a stopped Worker');
    assert(headStatus(REPO, 50) === null, 'the new commit already has an echo/hold status');
    r = await direct(bSession, ghApiMerge(50));
    assert(r.code !== 0, 'GitHub merged a commit with no echo/hold status while Echo was down');
    includes(r.stderr, 'Required status check "echo/hold" is expected', 'GitHub refusal while Echo is down');
  } finally {
    await startWorker();
  }
  // Echo is back, but nothing has told it about the commit yet: still unmergeable.
  r = await direct(bSession, ghApiMerge(50));
  assert(r.code !== 0 && !fake.pr(REPO, 50).mergedAt, 'merged before Echo set a status on the new commit');
  // Scenario 5: the lost webhook is made good by the periodic reconcile (every 10 minutes). Its last-run mark
  // moves back 11 minutes so the next cron run is due to reconcile, as it would be after that time had passed.
  await d1(`UPDATE owner_settings SET value = ${sqlText(iso(Date.now() - 11 * MINUTE))} WHERE key = 'status_reconcile_at'`);
  await cron();
  await waitStatus(REPO, 50, 'success');
  r = await direct(bSession, ghApiMerge(50));
  assert(r.code === 0 && fake.pr(REPO, 50).mergedAt, `gh api merge after Echo set the status failed: ${r.stderr}`);
  await fake.settle();
}, "every check is GitHub refusing a merge on the echo/hold status the Worker sends to the fake GitHub; it also stops the Worker and moves the reconcile mark in the local D1");

scenario(6, 'Too long', async () => {
  const { A } = AG;
  const text = await refused(A, 'echo_send_message', { project: PN.app, to: NM.B, body: 'x'.repeat(8193) });
  includes(text, 'MESSAGE_TOO_LARGE', 'refusal');
  includes(text, 'the limit is 8192', 'refusal');
  includes(text, 'echo_doc_save', 'refusal');
  includes(text, 'document', 'refusal');
  const ok = await call(A, 'echo_send_message', { project: PN.app, to: NM.B, body: 'The details are in the document deploy-plan.' });
  assert(Number.isInteger(ok.message_id) && ok.recipients.includes(NM.B), `short message: ${JSON.stringify(ok)}`);
});

function clockOf(orientation) {
  const m = /Echo's clock: (\S+) \(UTC\)/.exec(orientation);
  assert(m, `no service time in the orientation: ${orientation.slice(0, 300)}`);
  const skew = Math.abs(Date.parse(m[1]) - Date.now());
  assert(skew < MINUTE, `the service time ${m[1]} is ${skew} ms from now`);
  return m[1];
}

let restartMessageId = null;

scenario(7, 'Restart', async () => {
  const { A, B } = AG;
  await drainInbox(B);
  // B is not running: no hook runs while A sends.
  const sent = await call(A, 'echo_send_message', { project: PN.app, to: NM.B, body: 'Rebase PR 7 onto main before the release.', requires_ack: true });
  restartMessageId = sent.message_id;
  const fresh = await session(M.B, { orchestrator: NM.B });
  const out = (await sessionStart(fresh, 'startup')).stdout;
  includes(out, `You are ${NM.B} in Echo`, 'orientation');
  includes(out, `Projects: ${PN.app}, ${PN.approvals}.`, 'orientation');
  clockOf(out);
  includes(out, `(message ${sent.message_id}, needs acknowledgment)`, 'orientation');
  includes(out, 'Rebase PR 7 onto main before the release.', 'orientation');
  bSession = fresh; // B's current session from here on
});

scenario(8, 'Compaction', async () => {
  assert(restartMessageId, 'scenario 7 did not leave a message to acknowledge');
  const out = (await sessionStart(bSession, 'compact')).stdout;
  includes(out, `You are ${NM.B} in Echo`, 'orientation after compaction');
  includes(out, `Projects: ${PN.app}, ${PN.approvals}.`, 'orientation after compaction');
  clockOf(out);
  includes(out, 'Awaiting your acknowledgment:', 'orientation after compaction');
  includes(out, `(message ${restartMessageId}, needs acknowledgment)`, 'orientation after compaction');
  includes(out, 'Rebase PR 7 onto main before the release.', 'orientation after compaction');
  await call(AG.B, 'echo_ack_message', { message_id: restartMessageId, note: 'Rebased' });
});

scenario(9, 'Defer and stop', async () => {
  const { A, B } = AG;
  await drainInbox(B);
  const s = await session(M.B, { orchestrator: NM.B });
  const sent = await call(A, 'echo_send_message', { project: PN.app, to: NM.B, body: 'Confirm the deploy finished.', requires_ack: true });
  includes((await prompt(s)).stdout, 'Confirm the deploy finished.', "B's prompt hook");
  await call(B, 'echo_defer_message', { message_id: sent.message_id, for_minutes: 10, reason: 'The deploy is still running' });

  const st = await stopHook(s);
  assert(!st.stdout.trim(), `Stop was blocked by a deferred message: ${st.stdout}`);
  const [status] = await call(A, 'echo_message_status', { message_id: sent.message_id });
  const rec = status.recipients.find((x) => x.name === NM.B);
  assert(rec.deferredUntil && rec.deferReason === 'The deploy is still running' && !rec.acknowledged, `A's view: ${JSON.stringify(rec)}`);
  assert(Math.abs(Date.parse(rec.deferredUntil) - (Date.now() + 10 * MINUTE)) < MINUTE, `deferred until ${rec.deferredUntil}`);

  excludes((await prompt(s)).stdout, 'Confirm the deploy finished.', 'prompt hook while deferred');
  if (!skipRemote('the deferred message shown again once its 10 minutes have run out', "the deferral's end moves back in the local D1")) {
    // Scenario 9: the 10 minutes pass by moving the deferral's end back to just before now.
    await d1(`UPDATE message_recipients SET deferred_until = ${sqlText(iso(Date.now() - 1000))} WHERE message_id = ${sent.message_id} AND agent_id = ${B.id}`);
    const again = (await prompt(s)).stdout;
    includes(again, 'Confirm the deploy finished.', 'prompt hook after the deferral ran out');
  }
  await call(B, 'echo_ack_message', { message_id: sent.message_id, note: 'Deploy finished' });

  const second = await call(A, 'echo_send_message', { project: PN.app, to: NM.B, body: 'Please review the release notes.', requires_ack: true });
  const first = await stopHook(s);
  assert(first.json?.decision === 'block', `the first Stop was not blocked: ${first.stdout}`);
  includes(first.json.reason, 'Please review the release notes.', 'Stop reason');
  includes(first.json.reason, `message ${second.message_id}`, 'Stop reason');
  const secondStop = await stopHook(s);
  assert(!secondStop.stdout.trim(), `the second Stop in the same session was blocked again: ${secondStop.stdout}`);
  await call(B, 'echo_ack_message', { message_id: second.message_id, note: 'Reviewed' });
});

scenario(10, 'Escalation', async () => {
  const { A, B } = AG;
  await drainInbox(B);
  const url = await startNotifyListener();
  await admin.act('/admin/settings/notify-url', { url });
  const marker = `escalate-${crypto.randomBytes(4).toString('hex')}`;
  const sent = await call(A, 'echo_send_message', {
    project: PN.app, to: NM.B, body: `Approve the hotfix ${marker}`, requires_ack: true, escalate_after_minutes: 5,
  });
  const [st] = await call(A, 'echo_message_status', { message_id: sent.message_id });
  assert(Math.abs(Date.parse(st.escalateAt) - (Date.now() + 5 * MINUTE)) < MINUTE, `escalateAt ${st.escalateAt}`);
  // Scenario 10: the 5 minutes pass by moving the message's escalation time back to just before now.
  await d1(`UPDATE messages SET escalate_at = ${sqlText(iso(Date.now() - 1000))} WHERE id = ${sent.message_id}`);
  await cron();
  await waitFor(() => notices.some((n) => n.body.includes(marker)), 'the escalation notification');

  // A later message escalated by a later cron run shows that run finished, and it did not notify again.
  const marker2 = `escalate-${crypto.randomBytes(4).toString('hex')}`;
  const later = await call(A, 'echo_send_message', {
    project: PN.app, to: NM.B, body: `Second ${marker2}`, requires_ack: true, escalate_after_minutes: 5,
  });
  await d1(`UPDATE messages SET escalate_at = ${sqlText(iso(Date.now() - 1000))} WHERE id = ${later.message_id}`); // as above
  await cron();
  await waitFor(() => notices.some((n) => n.body.includes(marker2)), 'the second escalation notification');
  await waitFor(async () => (await changes(A, PN.app)).filter((c) => c.kind === 'message.escalated' && c.subject_id === later.message_id).length === 1, 'the second escalation log entry');

  const ours = notices.filter((n) => n.body.includes(marker));
  assert(ours.length === 1, `expected exactly one notification, got ${ours.length}`);
  includes(ours[0].title, `unanswered message for ${NM.B}`, 'notification title');
  includes(ours[0].body, `${NM.B} has not answered ${NM.A}`, 'notification body');
  includes(ours[0].click, `/admin/p/${P.app}`, 'notification link');
  const logged = (await changes(A, PN.app)).filter((c) => c.kind === 'message.escalated' && c.subject_id === sent.message_id);
  assert(logged.length === 1 && logged[0].data?.recipient === NM.B, `escalation log entries: ${JSON.stringify(logged)}`);
  const [after] = await call(A, 'echo_message_status', { message_id: sent.message_id });
  assert(after.recipients.find((x) => x.name === NM.B).escalated, 'the message is not marked escalated');
  await drainInbox(B);
}, "it moves escalation times back in the local D1, runs the cron through /__scheduled, needs the Worker to reach a listener on this machine, and would change the owner's notify_url");

scenario(11, 'Service down', async () => {
  const { A } = AG;
  await openPr(REPO, 110, 'success');
  await openPr(REPO, 111, 'success');
  const overrideSession = await session(M.B, { orchestrator: NM.B, override: `${REPO}#110` });
  const expiringSession = await session(M.B, { orchestrator: NM.B, override: `${REPO}#111` });
  await stopWorker();
  try {
    let r = await bash(bSession, mergeCmd(REPO, 110));
    expectRefused(r, 'merge while Echo is down', 'the Echo service could not be reached', 'ECHO_MERGE_OVERRIDE');

    r = await bash(overrideSession, mergeCmd(REPO, 110));
    assert(!r.denied, `the override was refused: ${r.reason}`);
    includes(r.context, 'emergency override', 'override note to the agent');
    await expectMerged(r, REPO, 110, 'merge with the override');

    r = await bash(overrideSession, mergeCmd(REPO, 110));
    expectRefused(r, 'second use of the override', 'already used once');

    await prompt(expiringSession); // the hook first sees this override now
    // Scenario 11: 30 minutes must pass after the hook first saw the override. That clock is the hook's own, kept
    // in its state file, so the first-seen time moves back 31 minutes there.
    const stateFile = path.join(M.B.echoHome, 'state', 'override.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert(state[`${REPO}#111`]?.usedAtMs === null, `override state: ${JSON.stringify(state)}`);
    state[`${REPO}#111`].firstSeenMs = Date.now() - 31 * MINUTE;
    fs.writeFileSync(stateFile, JSON.stringify(state));
    r = await bash(expiringSession, mergeCmd(REPO, 111));
    expectRefused(r, 'override 31 minutes after it was first seen', 'expired');
  } finally {
    if (!worker) await startWorker();
  }
  // Back up: the next Bash call sends the reports the hooks queued during the outage.
  const r = await bash(bSession, 'true');
  assert(!r.denied && r.code === 0, 'a plain command failed');
  const log = await changes(A, PN.app);
  const used = log.filter((c) => c.kind === 'override.used' && c.data?.pr === 110);
  assert(used.length === 1 && used[0].actor === NM.B, `override log entries: ${JSON.stringify(used)}`);
  assert(!log.some((c) => c.kind === 'override.used' && c.data?.pr === 111), 'the expired override was logged as used');
  assert(log.some((c) => c.kind === 'merge.recorded' && c.data?.pr === 110), 'the override merge was not recorded');
}, "it stops the Worker to make Echo unreachable");

scenario(12, 'Admin force', async () => {
  const { A } = AG;
  await openPr(REPO, 12, 'success');
  const hold = await call(A, 'echo_place_hold', { repo: REPO, pr: 12, reason: 'Hold for the incident review' });
  await waitStatus(REPO, 12, 'failure');
  let r = await bash(bSession, mergeCmd(REPO, 12));
  expectRefused(r, 'merge with the hold open', 'Blocking hold');
  await admin.act(`/admin/holds/${hold.id}/release`, { note: 'Released by the owner after the review' });
  await waitStatus(REPO, 12, 'success');
  r = await bash(bSession, mergeCmd(REPO, 12));
  await expectMerged(r, REPO, 12, 'merge after the owner released the hold');
  const released = (await changes(A, PN.app)).filter((c) => c.kind === 'hold.released' && c.subject_id === hold.id);
  assert(released.length === 1 && released[0].actor === 'admin', `release log entries: ${JSON.stringify(released)}`);
  const [h] = (await call(A, 'echo_list_holds', { project: PN.app, state: 'all' })).filter((x) => x.id === hold.id);
  assert(h.state === 'released' && h.released.by === 'admin', `hold after release: ${JSON.stringify(h)}`);
});

scenario(13, 'Unscheduled merge', async () => {
  const { A } = AG;
  await openPr(REPO, 13, 'success');
  const r = await bash(bSession, mergeCmd(REPO, 13));
  await expectMerged(r, REPO, 13, 'unscheduled merge');
  const mergedAt = fake.pr(REPO, 13).mergedAt;
  // Both the hook and GitHub's closed event reported it; it is recorded once, with GitHub's time.
  await waitFor(async () => (await changes(A, PN.app)).some((c) => c.kind === 'merge.recorded' && c.data?.pr === 13), 'the merge record');
  const day = mergedAt.slice(0, 10);
  const html = await admin.get(`/admin/p/${P.app}/schedule?from=${day}T00:00:00Z&to=${iso(Date.parse(`${day}T00:00:00Z`) + 24 * 60 * MINUTE)}`);
  const rows = [...html.matchAll(/<tr[^>]*>(?:(?!<\/tr>)[\s\S])*?<\/tr>/g)].map((m) => m[0]).filter((row) => row.includes(`${REPO}#13<`));
  assert(rows.length === 1, `expected one schedule row for ${REPO}#13, got ${rows.length}`);
  includes(rows[0], '>merged</span></td>', 'schedule row'); // the status cell's badge
  includes(rows[0], `datetime="${new Date(mergedAt).toISOString()}"`, 'schedule row time (GitHub merge time)');
  const recorded = (await changes(A, PN.app)).filter((c) => c.kind === 'merge.recorded' && c.data?.pr === 13);
  assert(recorded.length === 1, `merge.recorded entries: ${recorded.length}`);
});

scenario(14, 'Scratchpad', async () => {
  const { A, B } = AG;
  const tag = crypto.randomBytes(3).toString('hex');
  for (let i = 1; i <= 5; i++) {
    // Both agents append at the same moment.
    await Promise.all([
      call(A, 'echo_scratchpad_append', { project: PN.app, body: `${tag} A-${i}` }),
      call(B, 'echo_scratchpad_append', { project: PN.app, body: `${tag} B-${i}` }),
    ]);
  }
  const { entries } = await call(A, 'echo_scratchpad_read', { project: PN.app, limit: 500 });
  const ours = entries.filter((e) => e.body.startsWith(`${tag} `));
  assert(ours.length === 10, `expected 10 entries, found ${ours.length}`);
  for (let i = 1; i < ours.length; i++) {
    assert(ours[i].id > ours[i - 1].id, 'entries are not in id order');
    assert(ours[i].created_at >= ours[i - 1].created_at, 'entry times go backwards');
  }
  for (const who of ['A', 'B']) {
    const mine = ours.filter((e) => e.author === NM[who]).map((e) => e.body);
    assert(JSON.stringify(mine) === JSON.stringify([1, 2, 3, 4, 5].map((i) => `${tag} ${who}-${i}`)), `${who}'s entries: ${JSON.stringify(mine)}`);
  }
  // Agents can only append.
  await refused(B, 'echo_scratchpad_append', { project: PN.app, body: 'x', id: ours[0].id });
});

scenario(15, 'Persistence', async () => {
  const { A, B } = AG;
  await call(A, 'echo_todo_add', { project: PN.app, title: 'Rotate the staging keys' });
  await call(B, 'echo_doc_save', { project: PN.app, name: 'release-plan', format: 'markdown', content: '# Release plan\n\nShip on Friday.' });
  await openPr(REPO, 15, 'success');
  const hold = await call(A, 'echo_place_hold', { repo: REPO, pr: 15, reason: 'Freeze until the restart check' });
  await waitStatus(REPO, 15, 'failure');
  const wide = { from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' };
  const snapshot = async () => ({
    holds: await call(A, 'echo_list_holds', { state: 'all' }),
    sent: await call(A, 'echo_message_status'),
    calendarApp: await call(A, 'echo_calendar_list', { project: PN.app, ...wide }),
    calendarApprovals: await call(A, 'echo_calendar_list', { project: PN.approvals, ...wide }),
    scratchpad: await call(A, 'echo_scratchpad_read', { project: PN.app, limit: 500 }),
    todos: await call(A, 'echo_todo_list', { project: PN.app, include_done: true }),
    doc: await call(A, 'echo_doc_get', { project: PN.app, name: 'release-plan' }),
    whoB: (await call(B, 'echo_whoami')).projects,
  });
  const before = await snapshot();
  const changesBefore = { [PN.app]: await changes(A, PN.app), [PN.approvals]: await changes(A, PN.approvals) };
  for (const k of ['holds', 'sent', 'calendarApp', 'calendarApprovals']) assert(before[k].length > 0, `nothing to compare in ${k}`);
  assert(before.todos.todos.length > 0 && before.scratchpad.entries.length > 0 && changesBefore.app.length > 0, 'nothing to compare in to-dos, scratchpad or log');

  await stopWorker();
  await startWorker();

  const after = await snapshot();
  for (const k of Object.keys(before)) {
    assert(JSON.stringify(after[k]) === JSON.stringify(before[k]), `${k} changed across the restart`);
  }
  for (const p of [PN.app, PN.approvals]) {
    const now = await changes(A, p);
    assert(JSON.stringify(now.slice(0, changesBefore[p].length)) === JSON.stringify(changesBefore[p]), `the ${p} change log changed across the restart`);
  }
  // The owner's session still works, and the hooks still enforce a hold placed before the restart.
  includes(await admin.get(`/admin/p/${P.app}`), 'Open holds', 'admin page after restart');
  const out = (await sessionStart(bSession, 'resume')).stdout;
  includes(out, `You are ${NM.B} in Echo`, 'orientation after restart');
  const r = await bash(bSession, mergeCmd(REPO, 15));
  expectRefused(r, 'merge after the restart', `Blocking hold ${hold.id} by ${NM.A}`, 'Freeze until the restart check');
  await call(A, 'echo_release_hold', { hold_id: hold.id, note: 'Restart check done' });
  await waitStatus(REPO, 15, 'success');
}, "it restarts the Worker");

scenario(16, 'Access', async () => {
  const { A, B } = AG;
  AG.C = await admin.createAgent(P.app, NM.C);
  const { C } = AG;
  M.C = machine('c');
  await install(M.C, C);
  assert((await call(C, 'echo_whoami')).name === NM.C, 'C cannot use its token before revocation');
  await openPr(REPO, 16, 'success');

  await admin.act(`/admin/p/${P.app}/agents/${C.id}/revoke`, { confirm: 'yes' });

  const whoami = await mcpRaw(C.token, 'tools/call', { name: 'echo_whoami', arguments: {} });
  assert(whoami.status === 401 && whoami.json?.error?.code === 'BAD_TOKEN', `MCP with a revoked token: ${whoami.status} ${JSON.stringify(whoami.json)}`);
  for (const [method, p, body] of [
    ['POST', '/api/v1/orient', {}],
    ['POST', '/api/v1/poll', {}],
    ['POST', '/api/v1/stop-check', {}],
    ['POST', '/api/v1/merge-check', { repo: REPO, pr: 16, flags: { auto: false, admin: false } }],
    ['POST', '/api/v1/merge-report', { repo: REPO, pr: 16, mergedAt: new Date().toISOString() }],
    ['POST', '/api/v1/override-report', { repo: REPO, pr: 16, reason: 'x' }],
    ['GET', '/api/v1/repos', undefined],
  ]) {
    const res = await hookApi(C.token, method, p, body);
    assert(res.status === 401 && res.json?.error?.code === 'BAD_TOKEN', `${method} ${p} with a revoked token: ${res.status} ${JSON.stringify(res.json)}`);
  }
  const cSession = await session(M.C, { orchestrator: NM.C });
  const r = await bash(cSession, mergeCmd(REPO, 16));
  expectRefused(r, "merge check with C's revoked token", 'The token is missing, wrong or revoked.');
  includes((await sessionStart(cSession)).stdout, 'The token is missing, wrong or revoked.', "C's session start");
  assert(!fake.pr(REPO, 16).mergedAt, 'merged with a revoked token');

  // B is not in project "private"; A is.
  await call(A, 'echo_scratchpad_append', { project: PN.private, body: 'A private note' });
  for (const [name, args] of [
    ['echo_scratchpad_read', { project: PN.private }],
    ['echo_scratchpad_append', { project: PN.private, body: 'B was here' }],
    ['echo_send_message', { project: PN.private, to: NM.A, body: 'hello' }],
    ['echo_todo_add', { project: PN.private, title: 'x' }],
    ['echo_todo_list', { project: PN.private }],
    ['echo_doc_save', { project: PN.private, name: 'x', format: 'markdown', content: 'x' }],
    ['echo_doc_list', { project: PN.private }],
    ['echo_list_holds', { project: PN.private }],
    ['echo_inbox', { project: PN.private }],
    ['echo_changes_since', { project: PN.private, since_seq: 0 }],
    ['echo_calendar_list', { project: PN.private, from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' }],
    ['echo_calendar_add', { project: PN.private, title: 'x', starts_at: iso(Date.now() + MINUTE) }],
    ['echo_place_hold', { repo: REPO_PRIVATE, pr: 1, reason: 'x' }],
  ]) {
    const text = await refused(B, name, args);
    includes(text, 'NOT_MEMBER', `${name} on project "private"`);
  }
  const { entries } = await call(A, 'echo_scratchpad_read', { project: PN.private });
  assert(entries.length === 1 && entries[0].author === NM.A, `private scratchpad: ${JSON.stringify(entries)}`);
});

scenario(17, 'Subagents', async () => {
  const { A, B } = AG;
  await drainInbox(B);
  await openPr(REPO, 17, 'success');
  const hold = await call(A, 'echo_place_hold', { repo: REPO, pr: 17, reason: 'Do not ship until the cache fix lands' });
  const note = await call(A, 'echo_send_message', { project: PN.app, to: NM.B, body: 'For B only: the cache fix is in review.', requires_ack: true });
  await waitStatus(REPO, 17, 'failure');

  // A subagent started with the Agent tool inside B's session: same environment, hook input carries agent_id.
  const inSession = { ...(await session(M.B, { orchestrator: NM.B })), agentId: 'a1b2c3d4' };
  // A subagent that is a separate Claude Code session: no ECHO_AGENT or ECHO_TOKEN; the machine's default token.
  const separate = await session(M.B);
  for (const [label, s] of [['in-session subagent', inSession], ['separate subagent session', separate]]) {
    const r = await bash(s, mergeCmd(REPO, 17));
    expectRefused(r, label, 'Blocking hold', 'Do not ship until the cache fix lands', 'If you are a subagent, do not merge: report this to your orchestrator.');
    for (const [arg, out] of [
      ['session-start', await sessionStart(s)],
      ['prompt', await prompt(s)],
      ['post-tool', await hook(s, 'post-tool', { tool_name: 'Read', tool_input: { file_path: '/x' }, tool_use_id: 'toolu_x', tool_response: {} })],
      ['stop', await stopHook(s)],
    ]) {
      assert(!out.stdout.trim(), `${label}: the ${arg} hook printed ${out.stdout.slice(0, 200)}`);
    }
  }
  const undelivered = async () => {
    const [st] = await call(A, 'echo_message_status', { message_id: note.message_id });
    return st.recipients.find((x) => x.name === NM.B);
  };
  const before = await undelivered();
  assert(!before.delivered && !before.acknowledged, `the orchestrator's message was delivered to a subagent: ${JSON.stringify(before)}`);
  const [holdMsg] = (await call(A, 'echo_list_holds', { project: PN.app })).filter((h) => h.id === hold.id);
  assert(holdMsg.message.delivered === 0, `the hold message was delivered to a subagent: ${JSON.stringify(holdMsg.message)}`);

  // The orchestrator's own session sees them.
  const own = (await prompt(bSession)).stdout;
  includes(own, 'For B only: the cache fix is in review.', "B's own prompt hook");
  includes(own, 'Do not ship until the cache fix lands', "B's own prompt hook");
  assert((await undelivered()).delivered, 'the message is not delivered after B saw it');
  await call(A, 'echo_release_hold', { hold_id: hold.id, note: 'Cache fix landed' });
  await drainInbox(B);
});

scenario(18, 'Times', async () => {
  const { A, B } = AG;
  const stamp = '2020-01-01T00:00:00Z';
  for (const [name, args, field] of [
    ['echo_send_message', { project: PN.app, to: NM.B, body: 'hi', sent_at: stamp }, 'sent_at'],
    ['echo_place_hold', { repo: REPO, pr: 18, reason: 'x', placed_at: stamp }, 'placed_at'],
    ['echo_ack_message', { message_id: 1, note: 'x', acked_at: stamp }, 'acked_at'],
    ['echo_defer_message', { message_id: 1, for_minutes: 5, reason: 'x', until: stamp }, 'until'],
    ['echo_todo_add', { project: PN.app, title: 'x', created_at: stamp }, 'created_at'],
    ['echo_scratchpad_append', { project: PN.app, body: 'x', created_at: stamp }, 'created_at'],
    ['echo_doc_save', { project: PN.app, name: 'n', format: 'markdown', content: 'x', created_at: stamp }, 'created_at'],
    ['echo_calendar_add', { project: PN.app, title: 'x', starts_at: iso(Date.now() + MINUTE), created_at: stamp }, 'created_at'],
  ]) {
    const text = await refused(A, name, args);
    includes(text, 'Refused (rule BAD_REQUEST)', `${name} with ${field}`);
    includes(text, `unexpected field "${field}"`, `${name} with ${field}`);
  }
  for (const [p, body] of [
    ['/api/v1/poll', { now: stamp }],
    ['/api/v1/orient', { at: stamp }],
    ['/api/v1/merge-check', { repo: REPO, pr: 18, flags: { auto: false, admin: false }, at: stamp }],
  ]) {
    const res = await hookApi(B.token, 'POST', p, body);
    assert(res.status === 400 && res.json?.error?.code === 'BAD_REQUEST' && res.json.error.kind === 'rule', `${p} with a timestamp: ${res.status} ${JSON.stringify(res.json)}`);
  }
  // Times Echo stamps are its own.
  const sent = await call(A, 'echo_send_message', { project: PN.app, to: NM.B, body: 'Stamped by Echo' });
  const [st] = await call(A, 'echo_message_status', { message_id: sent.message_id });
  assert(Math.abs(Date.parse(st.sentAt) - Date.now()) < MINUTE, `sentAt ${st.sentAt}`);

  // A scheduled time is the one time an agent gives, and it must carry a zone.
  const noZone = await refused(A, 'echo_calendar_add', { project: PN.app, title: 'Standup', starts_at: '2026-12-01T21:00:00' });
  includes(noZone, 'Refused (rule', 'calendar without a zone');
  includes(noZone.toLowerCase(), 'zone', 'calendar without a zone');
  const ev = await call(A, 'echo_calendar_add', { project: PN.app, title: 'Standup', starts_at: '2026-12-01T21:00:00-06:00' });
  assert(ev.startsAt.startsWith('2026-12-02T03:00:00') && ev.enteredAs === '2026-12-01T21:00:00-06:00', `stored ${ev.startsAt} / ${ev.enteredAs}`);
  await call(A, 'echo_calendar_cancel', { event_id: ev.id });
  await drainInbox(B);
});

// ---------------------------------------------------------------- main

function withTimeout(p, ms, what) {
  let timer;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000} s`)), ms);
    }),
  ]);
}

async function main() {
  const started = Date.now();
  if (REMOTE) console.log(`e2e: remote mode against ${REMOTE_URL}, in projects ${PN.app}, ${PN.approvals} and ${PN.private}`);
  try {
    await withTimeout(setup(), 240_000, 'setup');
  } catch (e) {
    console.log(`FAIL 0 setup: ${e instanceof Error ? e.message : String(e)}`);
    if (worker) console.error(tail(worker.log));
    return 1;
  }
  let failed = 0;
  let skipped = 0;
  // E2E_ONLY=5,12 (or --only 5,12) runs only those scenarios. Scenario 8 needs 7, and 15 compares the state 1 to 14 left.
  const only = (process.env.E2E_ONLY ?? '').split(',').map(Number).filter(Boolean);
  const chosen = only.length ? scenarios.filter((s) => only.includes(s.n)) : scenarios;
  for (const s of chosen) {
    currentScenario = s.n;
    if (REMOTE && s.remoteSkip) {
      skipped++;
      console.log(`SKIP ${s.n} ${s.name}: ${s.remoteSkip}`);
      continue;
    }
    try {
      // A scenario that stopped the Worker and failed before restarting it must not take the rest down too.
      if (!REMOTE && !worker) await startWorker();
      await withTimeout(s.fn(), SCENARIO_TIMEOUT_MS, `scenario ${s.n}`);
      console.log(`PASS ${s.n} ${s.name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${s.n} ${s.name}: ${(e instanceof Error ? e.message : String(e)).replace(/\s*\n\s*/g, ' | ')}`);
    }
  }
  const ran = chosen.length - skipped;
  console.log(
    `\n${ran - failed}/${ran} scenarios passed in ${Math.round((Date.now() - started) / 1000)} s${skipped ? `; ${skipped} skipped in remote mode` : ''}`,
  );
  if (REMOTE) {
    console.log('\nSkipped in remote mode, and why:');
    for (const s of chosen.filter((x) => x.remoteSkip)) console.log(`- scenario ${s.n} (${s.name}), all of it: ${s.remoteSkip}`);
    for (const k of remoteSkips) console.log(`- scenario ${k.scenario} (${scenarios.find((x) => x.n === k.scenario)?.name}): ${k.what}: ${k.why}`);
    if (!chosen.some((x) => x.remoteSkip) && !remoteSkips.length) console.log('- nothing');
  }
  if (failed && worker) console.error(`\nLast lines of the Worker log:\n${tail(worker.log)}`);
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------- remote cleanup

let remoteCleanupStarted = false;

/**
 * Remote mode: leaves nothing behind. Open holds are released and open merge events cancelled (a repository with
 * either cannot be removed), then the repositories are removed, the agents revoked and the projects archived; the
 * archived projects are then deleted, and the revoked agents after them (an agent with history cannot be deleted).
 * Returns the steps that failed.
 */
async function remoteCleanup() {
  if (remoteCleanupStarted || !admin.cookie) return [];
  remoteCleanupStarted = true;
  const problems = [];
  const done = { holds: 0, events: 0, repos: 0, agents: [], projects: [], deletedProjects: [], deletedAgents: [] };
  const step = async (what, fn) => {
    try {
      await fn();
    } catch (e) {
      problems.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  for (const key of ['app', 'approvals', 'private']) {
    const pid = P[key];
    if (!pid) continue;
    if (AG.A) {
      await step(`releasing the open holds in ${PN[key]}`, async () => {
        for (const h of await call(AG.A, 'echo_list_holds', { project: PN[key] })) {
          await admin.act(`/admin/holds/${h.id}/release`, { note: 'e2e cleanup' });
          done.holds++;
        }
      });
      await step(`cancelling the open merge events in ${PN[key]}`, async () => {
        for (const e of await call(AG.A, 'echo_calendar_list', { project: PN[key], from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' })) {
          if (e.kind !== 'merge' || e.mergedAt || e.cancelled) continue;
          await admin.act(`/admin/p/${pid}/events/${e.id}/cancel`);
          done.events++;
        }
      });
    }
    await step(`removing the repositories of ${PN[key]}`, async () => {
      const page = await admin.get(`/admin/p/${pid}/repos`);
      for (const m of page.matchAll(new RegExp(`/admin/p/${pid}/repos/(\\d+)/remove`, 'g'))) {
        await admin.act(`/admin/p/${pid}/repos/${m[1]}/remove`, { confirm: 'yes' });
        done.repos++;
      }
    });
  }
  for (const k of ['A', 'B', 'C']) {
    if (!AG[k] || !P.app) continue;
    await step(`revoking ${NM[k]}`, async () => {
      await admin.act(`/admin/p/${P.app}/agents/${AG[k].id}/revoke`, { confirm: 'yes' });
      done.agents.push(NM[k]);
    });
  }
  for (const key of ['app', 'approvals', 'private']) {
    if (!P[key]) continue;
    await step(`archiving ${PN[key]}`, async () => {
      await admin.act(`/admin/p/${P[key]}/archive`, { confirm: 'yes' });
      done.projects.push(PN[key]);
    });
  }
  // Archived projects first (deleting one removes the agents' memberships and history), then the revoked agents.
  for (const key of ['app', 'approvals', 'private']) {
    if (!P[key] || !done.projects.includes(PN[key])) continue;
    await step(`deleting ${PN[key]}`, async () => {
      await admin.act(`/admin/p/${P[key]}/delete`, { confirm: 'yes' });
      done.deletedProjects.push(PN[key]);
    });
  }
  // An agent with a surviving project still has history, so those deletes would only fail again: skip them.
  const projectsLeft = ['app', 'approvals', 'private'].filter((key) => P[key]).length - done.deletedProjects.length;
  if (projectsLeft > 0) problems.push(`skipped deleting the agents: ${projectsLeft} project(s) were not deleted, so the agents still have history`);
  for (const k of ['A', 'B', 'C']) {
    if (projectsLeft > 0 || !AG[k] || !done.agents.includes(NM[k])) continue;
    await step(`deleting ${NM[k]}`, async () => {
      await admin.act(`/admin/agents/${AG[k].id}/delete`, { confirm: 'yes' });
      done.deletedAgents.push(NM[k]);
    });
  }
  console.log(
    `\nRemote cleanup: released ${done.holds} holds, cancelled ${done.events} merge events, removed ${done.repos} repositories, ` +
      `revoked ${done.agents.join(', ') || 'no agents'}, archived ${done.projects.join(', ') || 'no projects'}, ` +
      `deleted ${done.deletedProjects.join(', ') || 'no projects'} and ${done.deletedAgents.join(', ') || 'no agents'}.`,
  );
  for (const p of problems) console.log(`CLEANUP FAILED ${p}`);
  return problems;
}

let code = await main();
if (REMOTE) {
  // remoteCleanup prints its own failed steps; only a timeout is printed here.
  const problems = await withTimeout(remoteCleanup(), 120_000, 'remote cleanup').catch((e) => {
    console.log(`CLEANUP FAILED ${e.message}`);
    return [e.message];
  });
  if (problems.length) code = 1;
}
await stopWorker().catch(() => {});
await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r()))));
cleanupSync();
process.exit(code);
