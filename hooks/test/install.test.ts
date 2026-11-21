import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig } from '../src/config';
import { dispatch, type Dispatched } from '../src/main';
import { readToken, writeToken } from '../src/token-store';
import { startFakeServer, type FakeServer } from './fake-server';
import { installNote, stableNodePath } from '../src/install';
/** The node path install picks for the shared test env. */
const NODE = (): string => stableNodePath(process.execPath, env).path;

const TOKEN = 'echo_tok_SECRET_9f3a7c1d';
const BIN = path.join(import.meta.dirname, 'fixtures/bin');
const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);

let work: string; // holds the built bundle for the whole file
let bundle: string;
let tmp: string;
let server: FakeServer;
let env: NodeJS.ProcessEnv;
let settings: string;
let home: string;
let status: number;

beforeAll(() => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'echo-bundle-')));
  bundle = path.join(work, 'echo-hook.mjs');
  const r = spawnSync(process.execPath, [path.join(import.meta.dirname, '../build.mjs'), '--out', bundle], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`build failed: ${r.stderr}`);
});
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'echo-install-')));
  status = 200;
  server = await startFakeServer();
  server.reply((req) =>
    req.url === '/api/v1/repos' && req.headers.authorization === `Bearer ${TOKEN}` && status === 200
      ? { status: 200, body: { gatedRepos: ['acme/app', 'acme/api'] } }
      : { status: status === 200 ? 401 : status, body: { error: { code: 'BAD_TOKEN', message: 'That token is not valid.', fix: 'Reissue it.' } } },
  );
  home = path.join(tmp, 'echo');
  settings = path.join(tmp, 'claude', 'settings.json');
  env = { PATH: `${BIN}:${process.env.PATH}`, ECHO_HOME: home, ECHO_TOKEN_STORE: 'file', HOME: path.join(tmp, 'home') };
});
afterEach(async () => {
  await server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const out = (r: Dispatched): { stdout: string; stderr: string; exitCode: number } => ({
  stdout: 'stdout' in r ? (r.stdout ?? '') : '',
  stderr: 'stderr' in r ? (r.stderr ?? '') : '',
  exitCode: r.exitCode,
});

async function runInstall(args: string[], stdin = TOKEN + '\n', e = env) {
  return out(await dispatch('install', () => stdin, e, T0, { args, selfPath: bundle }));
}
const baseArgs = (extra: string[] = []): string[] => ['--url', server.url, '--agent', 'orch', '--settings', settings, ...extra];
const readJson = (f: string): any => JSON.parse(fs.readFileSync(f, 'utf8'));

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : [p];
  });
}

const ECHO_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreToolUse', 'Stop'];
const ours = (cmd: string): boolean => cmd.includes('echo-hook.mjs');

describe('install settings merge', () => {
  it('install merges hooks without disturbing existing settings and is idempotent', async () => {
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    const foreignPre = { matcher: 'Bash', hooks: [{ type: 'command', command: 'other-tool check' }] };
    const oldOurs = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "/old/place/echo-hook.mjs" pre-bash', timeout: 5 }] };
    const foreignStop = { hooks: [{ type: 'command', command: 'say done' }] };
    const original = {
      model: 'opus',
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: { PreToolUse: [foreignPre, oldOurs], Stop: [foreignStop], Notification: [{ hooks: [{ type: 'command', command: 'ping' }] }] },
      zzUnknown: { keep: true },
    };
    fs.writeFileSync(settings, JSON.stringify(original, null, 2));

    const r = await runInstall(baseArgs());
    expect(r.exitCode).toBe(0);
    const first = fs.readFileSync(settings, 'utf8');
    const s = JSON.parse(first);

    expect(Object.keys(s)).toEqual(['model', 'permissions', 'hooks', 'zzUnknown']);
    expect(s.model).toBe('opus');
    expect(s.permissions).toEqual(original.permissions);
    expect(s.zzUnknown).toEqual({ keep: true });
    expect(s.hooks.Notification).toEqual(original.hooks.Notification);

    // Foreign entries untouched and in place; the old echo entry replaced at its own index.
    expect(s.hooks.PreToolUse[0]).toEqual(foreignPre);
    expect(s.hooks.PreToolUse).toHaveLength(2);
    const abs = path.join(home, 'echo-hook.mjs');
    const cmd = (arg: string): string => `ECHO_HOME="${home}" "${NODE()}" "${abs}" ${arg}`;
    expect(s.hooks.PreToolUse[1]).toEqual({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: cmd('pre-bash'), timeout: 30 }],
    });
    expect(s.hooks.Stop[0]).toEqual(foreignStop);
    expect(s.hooks.Stop[1]).toEqual({ hooks: [{ type: 'command', command: cmd('stop') }] });

    const all = Object.entries(s.hooks).flatMap(([ev, groups]: [string, any]) =>
      groups.flatMap((g: any) => g.hooks.filter((h: any) => ours(h.command)).map((h: any) => ({ ev, matcher: g.matcher, cmd: h.command, timeout: h.timeout }))),
    );
    expect(all.map((x) => `${x.ev}|${x.matcher ?? ''}|${x.cmd.split(' ').pop()}`).sort()).toEqual(
      [
        'PostToolUse|*|post-tool',
        'PostToolUse|Bash|post-bash',
        'PreToolUse|Bash|pre-bash',
        'SessionStart||session-start',
        'Stop||stop',
        'UserPromptSubmit||prompt',
      ].sort(),
    );
    expect(all.every((x) => x.cmd.startsWith(`ECHO_HOME="${home}" "${NODE()}" "${abs}" `))).toBe(true);
    expect(all.filter((x) => x.timeout !== undefined)).toEqual([expect.objectContaining({ ev: 'PreToolUse', timeout: 30 })]);
    for (const ev of ECHO_EVENTS) expect(s.hooks[ev]).toBeDefined();

    // Second run changes nothing, byte for byte.
    expect((await runInstall(baseArgs())).exitCode).toBe(0);
    expect(fs.readFileSync(settings, 'utf8')).toBe(first);
  });

  it('install creates the settings file and its parent directory when missing', async () => {
    expect((await runInstall(baseArgs())).exitCode).toBe(0);
    expect(Object.keys(readJson(settings).hooks).sort()).toEqual([...ECHO_EVENTS].sort());
  });

  it('install aborts with no changes when the settings file is not valid JSON, and names the file', async () => {
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, '{ "hooks": ');
    const r = await runInstall(baseArgs());
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(settings);
    expect(fs.readFileSync(settings, 'utf8')).toBe('{ "hooks": ');
    expect(fs.existsSync(home)).toBe(false);
    expect(server.requests).toHaveLength(0);
  });
});

describe('fix round 1', () => {
  const fakeSecurity = (): NodeJS.ProcessEnv => {
    const bin = path.join(tmp, 'secbin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'security'), '#!/bin/sh\necho "boom $*" >&2\nexit 1\n', { mode: 0o755 });
    return { ...env, PATH: `${bin}:${env.PATH}`, ECHO_TOKEN_STORE: 'keychain' };
  };

  it('a Keychain write failure never prints the token, in install or set-token', async () => {
    const e = fakeSecurity();
    const r = await runInstall(baseArgs(), TOKEN + '\n', e);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('could not store the token in the macOS Keychain (security exited 1)');
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
    saveConfig(e, { url: server.url, agents: ['orch'], defaultAgent: 'orch' });
    const t = out(await dispatch('set-token', () => TOKEN, e, T0, { args: ['orch'] }));
    expect(t.exitCode).toBe(1);
    expect(t.stdout + t.stderr).not.toContain(TOKEN);
  });

  it.each(['tok\nextra', 'tok extra', 'tok\u0007x'])('a token with control characters or spaces is refused (%j)', async (bad) => {
    const r = await runInstall(baseArgs(), bad);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('the token must be a single line of printable characters');
    expect(r.stdout + r.stderr).not.toContain('extra');
    expect(server.requests).toHaveLength(0);
    expect(fs.existsSync(home)).toBe(false);
    saveConfig(env, { url: server.url, agents: ['orch'], defaultAgent: 'orch' });
    const t = out(await dispatch('set-token', () => bad, env, T0, { args: ['orch'] }));
    expect(t.stderr).toContain('single line of printable characters');
    expect(server.requests).toHaveLength(0);
  });

  it('a symlinked settings file stays a symlink and its target is updated', async () => {
    const real = path.join(tmp, 'dotfiles', 'settings.json');
    fs.mkdirSync(path.dirname(real));
    fs.writeFileSync(real, JSON.stringify({ model: 'x' }));
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.symlinkSync(real, settings);
    expect((await runInstall(baseArgs())).exitCode).toBe(0);
    expect(fs.lstatSync(settings).isSymbolicLink()).toBe(true);
    expect(readJson(real).model).toBe('x');
    expect(readJson(real).hooks.Stop).toHaveLength(1);
    expect(fs.readdirSync(path.dirname(real))).toEqual(['settings.json']);
  });

  it('an existing 0600 settings file stays 0600 and a new one is created 0600', async () => {
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, '{}', { mode: 0o600 });
    fs.chmodSync(settings, 0o600);
    await runInstall(baseArgs());
    expect(fs.statSync(settings).mode & 0o777).toBe(0o600);
    fs.rmSync(settings);
    await runInstall(baseArgs());
    expect(fs.statSync(settings).mode & 0o777).toBe(0o600);
  });

  it('stableNodePath prefers a PATH link to the running node over its versioned real path', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'echo-node-')));
    try {
      const cellar = path.join(root, 'Cellar/node/24.2.0/bin');
      fs.mkdirSync(cellar, { recursive: true });
      const real = path.join(cellar, 'node');
      fs.writeFileSync(real, '#!/bin/sh\n', { mode: 0o755 });
      const bin = path.join(root, 'bin');
      fs.mkdirSync(bin);
      fs.symlinkSync('../Cellar/node/24.2.0/bin/node', path.join(bin, 'node'));
      const other = path.join(root, 'other');
      fs.mkdirSync(other);
      fs.writeFileSync(path.join(other, 'node'), '#!/bin/sh\n', { mode: 0o755 }); // a different node: never chosen

      expect(stableNodePath(real, { PATH: `${other}:${bin}` })).toEqual({ path: path.join(bin, 'node'), versioned: false });
      // Not on PATH: Homebrew's opt link, if it points at the same binary.
      fs.mkdirSync(path.join(root, 'opt/node/bin'), { recursive: true });
      fs.symlinkSync('../../../Cellar/node/24.2.0/bin/node', path.join(root, 'opt/node/bin/node'));
      expect(stableNodePath(real, { PATH: other })).toEqual({ path: path.join(root, 'opt/node/bin/node'), versioned: false });
      // Nothing stable: the real path, flagged as versioned.
      fs.rmSync(path.join(root, 'opt'), { recursive: true });
      expect(stableNodePath(real, { PATH: other })).toEqual({ path: real, versioned: true });
      expect(stableNodePath(real, {})).toEqual({ path: real, versioned: true });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('install writes the PATH link to node into the hooks and wrapper, and warns when only a versioned path exists', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-node-'));
    try {
      const bin = path.join(root, 'bin');
      fs.mkdirSync(bin);
      fs.symlinkSync(process.execPath, path.join(bin, 'node'));
      const r = await runInstall(baseArgs(), TOKEN + '\n', { ...env, PATH: `${bin}:/usr/bin:/bin` });
      expect(r.exitCode).toBe(0);
      const cmds = Object.values(readJson(settings).hooks).flatMap((g: any) => g.flatMap((x: any) => x.hooks.map((h: any) => h.command)));
      for (const c of cmds) expect(c).toContain(` "${path.join(bin, 'node')}" `);
      expect(fs.readFileSync(path.join(home, 'echo-claude'), 'utf8')).toContain(`"${path.join(bin, 'node')}"`);
      expect(r.stdout).toContain(`node:    ${path.join(bin, 'node')}`);
      expect(r.stdout).not.toContain('includes a version');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    expect(installNote({ path: '/x/Cellar/node/24.2.0/bin/node', versioned: true })).toContain('includes a version');
  });

  it('install prints the versioned-Node warning when the running node is a Cellar path and no stable link exists', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'echo-node-')));
    const realExec = process.execPath;
    try {
      const cellar = path.join(root, 'Cellar/node/24.2.0/bin');
      fs.mkdirSync(cellar, { recursive: true });
      const real = path.join(cellar, 'node');
      fs.writeFileSync(real, '#!/bin/sh\n', { mode: 0o755 });
      const other = path.join(root, 'other'); // a different node on PATH: not a stable link to the running one
      fs.mkdirSync(other);
      fs.writeFileSync(path.join(other, 'node'), '#!/bin/sh\n', { mode: 0o755 });
      Object.defineProperty(process, 'execPath', { value: real, configurable: true, writable: true });
      const r = await runInstall(baseArgs(), TOKEN + '\n', { ...env, PATH: `${other}:/usr/bin:/bin` });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(`node:    ${real}`);
      expect(r.stdout).toContain('Note: that Node path includes a version number. After upgrading Node, run install again');
      const cmds = Object.values(readJson(settings).hooks).flatMap((g: any) => g.flatMap((x: any) => x.hooks.map((h: any) => h.command)));
      for (const c of cmds) expect(c).toContain(` "${real}" `);
    } finally {
      Object.defineProperty(process, 'execPath', { value: realExec, configurable: true, writable: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('hook commands and the wrapper carry the absolute node path and ECHO_HOME', async () => {
    await runInstall(baseArgs());
    const cmds = Object.values(readJson(settings).hooks).flatMap((g: any) => g.flatMap((x: any) => x.hooks.map((h: any) => h.command)));
    expect(cmds).toHaveLength(6);
    for (const c of cmds) expect(c).toMatch(new RegExp(`^ECHO_HOME="${home}" "${NODE()}" "${path.join(home, 'echo-hook.mjs')}" `));
    const w = fs.readFileSync(path.join(home, 'echo-claude'), 'utf8');
    expect(w).toContain(`"${NODE()}"`);
    expect(w).toContain(`ECHO_HOME="${home}"`);
    expect(w).not.toContain('dirname');
  });

  it('the wrapper works when symlinked onto another path and with CDPATH set, and names a missing node', async () => {
    const fakeBin = path.join(tmp, 'fb');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\necho launched\n', { mode: 0o755 });
    await runInstall(baseArgs());
    await writeToken('orch', TOKEN, env);
    const link = path.join(fakeBin, 'echo-claude');
    fs.symlinkSync(path.join(home, 'echo-claude'), link);
    const r = spawnSync('/bin/sh', [link, 'orch'], { env: { PATH: `${fakeBin}:/usr/bin:/bin`, CDPATH: tmp, ECHO_TOKEN_STORE: 'file', HOME: env.HOME }, encoding: 'utf8' });
    expect(r.stdout).toBe('launched\n');
    const w = path.join(home, 'echo-claude');
    fs.writeFileSync(w, fs.readFileSync(w, 'utf8').split(NODE()).join('/nonexistent/node'));
    const m = spawnSync('/bin/sh', [w, 'orch'], { env: { PATH: `${fakeBin}:/usr/bin:/bin` }, encoding: 'utf8' });
    expect(m.status).toBe(1);
    expect(m.stderr).toContain('node not found');
    expect(m.stderr).not.toContain('no Echo token');
  });

  it('collapses duplicate Echo entries to one and moves a misplaced one to the right matcher', async () => {
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    const foreign = { hooks: [{ type: 'command', command: 'other' }] };
    const e = (c: string) => ({ type: 'command', command: `node "/x/echo-hook.mjs" ${c}` });
    fs.writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [e('pre-bash')] }, foreign, { matcher: '*', hooks: [e('pre-bash')] }, { matcher: 'Bash', hooks: [e('pre-bash')] }],
          Stop: [{ matcher: '*', hooks: [e('stop'), { type: 'command', command: 'keepme' }] }],
        },
      }),
    );
    await runInstall(baseArgs());
    const s = readJson(settings);
    const pre = s.hooks.PreToolUse;
    expect(pre).toHaveLength(2);
    expect(pre[0].matcher).toBe('Bash');
    expect(pre[0].hooks).toHaveLength(1);
    expect(pre[0].hooks[0].timeout).toBe(30);
    expect(pre[1]).toEqual(foreign);
    expect(s.hooks.Stop).toEqual([
      { matcher: '*', hooks: [{ type: 'command', command: 'keepme' }] },
      { hooks: [expect.objectContaining({ command: expect.stringContaining(' stop') })] },
    ]);
    const echoPre = JSON.stringify(s).split('pre-bash').length - 1;
    expect(echoPre).toBe(1);
  });

  it('with no --settings it uses HOME/.claude/settings.json, or CLAUDE_CONFIG_DIR when set', async () => {
    const args = ['--url', server.url, '--agent', 'orch'];
    expect((await runInstall(args)).exitCode).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'home', '.claude', 'settings.json'))).toBe(true);
    const cfg = path.join(tmp, 'cfgdir');
    expect((await runInstall(args, TOKEN, { ...env, CLAUDE_CONFIG_DIR: cfg })).exitCode).toBe(0);
    expect(fs.existsSync(path.join(cfg, 'settings.json'))).toBe(true);
  });

  it.each([
    ['refused', 401],
    ['unreachable', 503],
  ])('re-install with a %s token leaves an existing install byte-identical', async (_n, st) => {
    expect((await runInstall(baseArgs())).exitCode).toBe(0);
    const snap = (): Record<string, string> => Object.fromEntries(walk(tmp).map((f) => [f, fs.readFileSync(f, 'utf8')]));
    const before = snap();
    status = st;
    const r = await runInstall(baseArgs(['--default']));
    expect(r.exitCode).toBe(1);
    expect(snap()).toEqual(before);
  });
});

describe('install ordering and verification', () => {
  it.each([
    ['refused', 401],
    ['unreachable', 503],
  ])('install aborts without changes when the token is %s', async (_n, st) => {
    status = st;
    const r = await runInstall(baseArgs());
    expect(r.exitCode).toBe(1);
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(fs.existsSync(home)).toBe(false);
    expect(fs.existsSync(settings)).toBe(false);
    expect(fs.existsSync(path.dirname(settings))).toBe(false);
  });

  it('install aborts without changes when the server is down', async () => {
    const r = await runInstall(['--url', 'http://127.0.0.1:1', '--agent', 'orch', '--settings', settings]);
    expect(r.exitCode).toBe(1);
    expect(fs.existsSync(home)).toBe(false);
    expect(fs.existsSync(settings)).toBe(false);
  });

  it('install writes gate cache, token, bundle copy, config and wrapper, trimming the token read from stdin', async () => {
    const r = await runInstall(baseArgs(), `  ${TOKEN} \r\n\n`);
    expect(r.exitCode).toBe(0);
    expect(server.requests.map((q) => `${q.method} ${q.url}`)).toEqual(['GET /api/v1/repos']);
    expect(server.requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(readJson(path.join(home, 'state', 'gate-cache.json')).repos).toEqual(['acme/app', 'acme/api']);
    expect(await readToken('orch', env)).toBe(TOKEN);
    expect(fs.readFileSync(path.join(home, 'echo-hook.mjs'), 'utf8')).toBe(fs.readFileSync(bundle, 'utf8'));
    expect(loadConfig(env)).toEqual({ url: server.url, agents: ['orch'], defaultAgent: 'orch' });
    expect(fs.statSync(path.join(home, 'echo-claude')).mode & 0o777).toBe(0o755);
    const helper = path.join(home, 'echo-mcp-headers');
    expect(fs.statSync(helper).mode & 0o777).toBe(0o755);
    const text = fs.readFileSync(helper, 'utf8');
    expect(text).toContain(`"${NODE()}"`);
    expect(text).toContain(`ECHO_HOME="${home}"`);
    expect(text).toContain(`bundle="${path.join(home, 'echo-hook.mjs')}"`);
    expect(text).toContain('"$bundle" mcp-headers');
    expect(text).not.toContain(TOKEN);
  });

  it('install refuses an empty token and a bad agent name without changes', async () => {
    const empty = await runInstall(baseArgs(), '  \n');
    expect(empty.exitCode).toBe(1);
    expect(empty.stderr).toMatch(/token/i);
    const bad = await runInstall(['--url', server.url, '--agent', '../evil', '--settings', settings]);
    expect(bad.exitCode).toBe(1);
    expect(fs.existsSync(home)).toBe(false);
    expect(server.requests).toHaveLength(0);
  });

  it('install requires --url and --agent', async () => {
    expect((await runInstall(['--agent', 'orch', '--settings', settings])).exitCode).toBe(1);
    expect((await runInstall(['--url', server.url, '--settings', settings])).exitCode).toBe(1);
    expect(fs.existsSync(home)).toBe(false);
  });
});

describe('install config', () => {
  it('sets defaultAgent only when none exists, unless --default is given', async () => {
    saveConfig(env, { url: 'http://old.example', agents: ['first'], defaultAgent: 'first' });
    await runInstall(baseArgs());
    expect(loadConfig(env)).toEqual({ url: server.url, agents: ['first', 'orch'], defaultAgent: 'first' });
    await runInstall(baseArgs(['--default']));
    expect(loadConfig(env)).toEqual({ url: server.url, agents: ['first', 'orch'], defaultAgent: 'orch' });
  });
});

describe('install and secrets', () => {
  it('no file written by install contains the token (file store excepted)', async () => {
    expect((await runInstall(baseArgs())).exitCode).toBe(0);
    const files = walk(tmp);
    expect(files.length).toBeGreaterThan(5);
    const tokenFile = path.join(home, 'tokens', 'orch');
    for (const f of files) {
      if (f === tokenFile) continue;
      expect(fs.readFileSync(f, 'utf8'), f).not.toContain(TOKEN);
    }
    expect(fs.readFileSync(tokenFile, 'utf8').trim()).toBe(TOKEN);
  });

  it('the printed MCP command uses headersHelper and add-json, with no token', async () => {
    const r = await runInstall(baseArgs());
    const helper = path.join(home, 'echo-mcp-headers');
    expect(r.stdout).not.toContain(TOKEN);
    expect(r.stdout).not.toContain('ECHO_TOKEN');
    expect(r.stdout).toContain('claude mcp remove echo -s user      (only if an echo server already exists)');
    const line = r.stdout.split('\n').find((l) => l.includes('claude mcp add-json'))!;
    expect(line).toContain('headersHelper');
    expect(line).toContain('--scope user');
    const json = /add-json echo '(.*)' --scope user$/.exec(line)![1];
    expect(JSON.parse(json)).toEqual({ type: 'http', url: `${server.url}/mcp`, headersHelper: helper });
    expect(r.stdout).toContain(`${path.join(home, 'echo-claude')} orch`);
    expect(r.stdout).toContain('sets ECHO_AGENT=orch in that session');
    expect(r.stderr).not.toContain(TOKEN);
  });

  it('a refused token is not echoed anywhere in the output', async () => {
    status = 401;
    const r = await runInstall(baseArgs());
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });
});

describe('token and set-token', () => {
  it('token prints only the token and a newline, and exits 1 when there is none', async () => {
    await writeToken('orch', TOKEN, env);
    expect(out(await dispatch('token', () => '', env, T0, { args: ['orch'] }))).toEqual({ stdout: TOKEN + '\n', stderr: '', exitCode: 0 });
    const none = out(await dispatch('token', () => '', env, T0, { args: ['ghost'] }));
    expect(none.exitCode).toBe(1);
    expect(none.stdout).toBe('');
    expect(out(await dispatch('token', () => '', env, T0, { args: [] })).exitCode).toBe(1);
  });

  it('set-token verifies the token against the server and stores it', async () => {
    saveConfig(env, { url: server.url, agents: ['orch'], defaultAgent: 'orch' });
    const r = out(await dispatch('set-token', () => TOKEN + '\n', env, T0, { args: ['orch'] }));
    expect(r.exitCode).toBe(0);
    expect(await readToken('orch', env)).toBe(TOKEN);
    expect(server.requests[0].url).toBe('/api/v1/repos');
  });

  it('set-token does not store a refused token and keeps the old one', async () => {
    saveConfig(env, { url: server.url, agents: ['orch'], defaultAgent: 'orch' });
    await writeToken('orch', 'old-token', env);
    const r = out(await dispatch('set-token', () => 'wrong-token\n', env, T0, { args: ['orch'] }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('BAD_TOKEN');
    expect(r.stderr).not.toContain('wrong-token');
    expect(await readToken('orch', env)).toBe('old-token');
  });

  it('set-token refuses an empty token, and refuses when there is no config to name the server', async () => {
    saveConfig(env, { url: server.url, agents: ['orch'], defaultAgent: 'orch' });
    expect(out(await dispatch('set-token', () => '\n', env, T0, { args: ['orch'] })).exitCode).toBe(1);
    fs.rmSync(path.join(home, 'config.json'));
    expect(out(await dispatch('set-token', () => TOKEN, env, T0, { args: ['orch'] })).exitCode).toBe(1);
  });
});

describe('echo-claude wrapper', () => {
  let fakeBin: string;
  beforeEach(async () => {
    fakeBin = path.join(tmp, 'fakebin');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, 'claude'),
      '#!/bin/sh\necho "ECHO_AGENT=${ECHO_AGENT-unset}"\nif [ -n "${ECHO_TOKEN-}" ]; then echo "token=set"; else echo "token=unset"; fi\nfor a in "$@"; do echo "arg:$a"; done\n',
      { mode: 0o755 },
    );
    expect((await runInstall(baseArgs())).exitCode).toBe(0);
  });
  const wrap = (args: string[]) =>
    spawnSync('/bin/sh', [path.join(home, 'echo-claude'), ...args], {
      env: { ...env, PATH: `${fakeBin}:${process.env.PATH}` },
      encoding: 'utf8',
    });

  it('exports ECHO_AGENT and ECHO_TOKEN and runs claude with the remaining arguments', () => {
    const r = wrap(['orch', '--resume', 'a b']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('ECHO_AGENT=orch\ntoken=set\narg:--resume\narg:a b\n');
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });

  it('prints usage and exits 2 with no name', () => {
    const r = wrap([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage/i);
    expect(r.stdout).toBe('');
  });

  it('exits 1 with the set-token hint and does not launch claude when there is no token', () => {
    const r = wrap(['ghost']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('echo-claude: no Echo token for ghost; run: node ~/.echo/echo-hook.mjs set-token ghost');
    expect(r.stdout).toBe('');
  });

  it('is a POSIX sh script with set -eu', () => {
    const t = fs.readFileSync(path.join(home, 'echo-claude'), 'utf8');
    expect(t.startsWith('#!/bin/sh\n')).toBe(true);
    expect(t).toContain('set -eu');
    expect(t).toContain('exec claude "$@"');
  });
});

describe('bundle', () => {
  it('the bundle runs with no node_modules present, through a symlinked path too', () => {
    const real = path.join(tmp, 'isolated');
    fs.mkdirSync(real);
    fs.copyFileSync(bundle, path.join(real, 'echo-hook.mjs'));
    expect(fs.existsSync(path.join(real, 'node_modules'))).toBe(false);
    const link = path.join(tmp, 'link');
    fs.symlinkSync(real, link);
    const input = JSON.stringify({
      hook_event_name: 'PreToolUse', session_id: 's', cwd: tmp, tool_name: 'Bash', tool_use_id: 't',
      tool_input: { command: "bash -c 'gh pr merge 5'" },
    });
    const pkg = readJson(path.join(import.meta.dirname, '../package.json'));
    for (const dir of [real, link]) {
      const v = spawnSync(process.execPath, [path.join(dir, 'echo-hook.mjs'), 'version'], { cwd: real, env, encoding: 'utf8' });
      expect(v.stdout).toBe(pkg.version + '\n');
      const p = spawnSync(process.execPath, [path.join(dir, 'echo-hook.mjs'), 'pre-bash'], { cwd: real, input, env, encoding: 'utf8' });
      expect(p.status).toBe(0);
      expect(JSON.parse(p.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    }
  });

  it('the bundle installs end to end as a subprocess, reading the token from stdin and not argv', async () => {
    // Async spawn: the fake server lives in this process and must keep serving.
    const child = spawn(process.execPath, [bundle, 'install', ...baseArgs()], { env });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d));
    child.stdin.end(TOKEN + '\n');
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    const r = { status: code, stdout };
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('headersHelper');
    expect(fs.existsSync(path.join(home, 'echo-hook.mjs'))).toBe(true);
    expect(readJson(settings).hooks.Stop).toHaveLength(1);
  });

  it('the built bundle imports nothing outside node: builtins', () => {
    const text = fs.readFileSync(bundle, 'utf8');
    const specs = [...text.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.filter((s) => !s.startsWith('node:'))).toEqual([]);
  });
});
