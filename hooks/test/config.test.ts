import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, Refused, Unreachable } from '../src/client';
import { loadConfig, saveConfig, type EchoConfig } from '../src/config';
import { readInput, type HookInput } from '../src/input';
import { mergeCheckToken, messageIdentity, readToken, writeToken } from '../src/token-store';
import { startFakeServer, type FakeServer } from './fake-server';

const BIN = path.join(import.meta.dirname, 'fixtures/bin');
let tmp: string;
let log: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'echo-cfg-')));
  log = path.join(tmp, 'fake.log');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const cfg: EchoConfig = { url: 'http://127.0.0.1:1', agents: ['alice', 'bob'], defaultAgent: 'alice' };
const input = (over: Partial<HookInput> = {}): HookInput => ({ hook_event_name: 'PostToolUse', session_id: 's', cwd: '/w', ...over });
function fileEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ECHO_HOME: path.join(tmp, 'home'), ECHO_TOKEN_STORE: 'file', PATH: process.env.PATH, ...extra };
}
function keychainEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ECHO_HOME: path.join(tmp, 'home'), ECHO_TOKEN_STORE: 'keychain', PATH: `${BIN}:${process.env.PATH}`, FAKE_LOG: log, ...extra };
}

describe('input and config', () => {
  it('readInput parses hook JSON and rejects garbage', () => {
    expect(readInput('{"hook_event_name":"Stop","session_id":"s","cwd":"/w"}').hook_event_name).toBe('Stop');
    expect(() => readInput('nope')).toThrow();
    expect(() => readInput('{"cwd":"/w"}')).toThrow();
  });

  it('loadConfig reads ECHO_HOME/config.json, returns null when missing or malformed', () => {
    const env = fileEnv();
    expect(loadConfig(env)).toBeNull();
    saveConfig(env, cfg);
    expect(loadConfig(env)).toEqual(cfg);
    fs.writeFileSync(path.join(env.ECHO_HOME!, 'config.json'), '{"url":1}');
    expect(loadConfig(env)).toBeNull();
    fs.writeFileSync(path.join(env.ECHO_HOME!, 'config.json'), 'garbage');
    expect(loadConfig(env)).toBeNull();
  });

  it('config.json never contains a token after install-style writes', async () => {
    const env = fileEnv();
    saveConfig(env, cfg);
    await writeToken('alice', 'sekret-token-value', env);
    const raw = fs.readFileSync(path.join(env.ECHO_HOME!, 'config.json'), 'utf8');
    expect(raw).not.toContain('sekret-token-value');
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['agents', 'defaultAgent', 'url']);
    expect(fs.readFileSync(path.join(env.ECHO_HOME!, 'tokens', 'alice'), 'utf8').trim()).toBe('sekret-token-value');
  });
});

describe('token store', () => {
  it('readToken prefers ECHO_TOKEN for the marked agent, then the Keychain via security', async () => {
    const e = keychainEnv({ ECHO_AGENT: 'alice', ECHO_TOKEN: 'from-env', FAKE_SECURITY_STDOUT: 'from-keychain' });
    expect(await readToken('alice', e)).toBe('from-env');
    expect(fs.existsSync(log)).toBe(false);
    // another agent's name does not use ECHO_TOKEN
    expect(await readToken('bob', e)).toBe('from-keychain');
    const logged = fs.readFileSync(log, 'utf8');
    expect(logged).toContain('--- security');
    expect(logged.split('\n').filter((l) => l.startsWith('arg: '))).toEqual([
      'arg: find-generic-password', 'arg: -s', 'arg: echo', 'arg: -a', 'arg: bob', 'arg: -w',
    ]);
    // no ECHO_TOKEN at all
    expect(await readToken('alice', keychainEnv({ ECHO_AGENT: 'alice', FAKE_SECURITY_STDOUT: 'kc2' }))).toBe('kc2');
  });

  it('readToken returns null when security fails or prints nothing', async () => {
    expect(await readToken('bob', keychainEnv({ FAKE_SECURITY_EXIT: '44' }))).toBeNull();
    expect(await readToken('bob', keychainEnv())).toBeNull();
  });

  it('readToken reads ~/.echo/tokens/<name> with the file store and trims the newline', async () => {
    const env = fileEnv();
    expect(await readToken('bob', env)).toBeNull();
    fs.mkdirSync(path.join(env.ECHO_HOME!, 'tokens'), { recursive: true });
    fs.writeFileSync(path.join(env.ECHO_HOME!, 'tokens', 'bob'), 'file-token\n');
    expect(await readToken('bob', env)).toBe('file-token');
  });

  it('readToken refuses names that could escape the tokens directory', async () => {
    expect(await readToken('../config.json', fileEnv())).toBeNull();
  });

  it('writeToken (file store) writes mode 0600 and refuses a path inside a git work tree', async () => {
    const env = fileEnv();
    await writeToken('alice', 't1', env);
    const file = path.join(env.ECHO_HOME!, 'tokens', 'alice');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8').trim()).toBe('t1');
    // overwrite keeps 0600
    await writeToken('alice', 't2', env);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8').trim()).toBe('t2');

    // .git as a directory
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const inRepo = fileEnv({ ECHO_HOME: path.join(repo, 'sub', '.echo') });
    await expect(writeToken('alice', 'x', inRepo)).rejects.toThrow(/git work tree/);
    expect(fs.existsSync(path.join(repo, 'sub', '.echo', 'tokens', 'alice'))).toBe(false);

    // .git as a file (worktree or submodule)
    const wt = path.join(tmp, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /elsewhere');
    await expect(writeToken('alice', 'x', fileEnv({ ECHO_HOME: path.join(wt, '.echo') }))).rejects.toThrow(/git work tree/);
  });

  it('writeToken on the Keychain store calls security add-generic-password -U', async () => {
    await writeToken('alice', 'tok', keychainEnv());
    const args = fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('arg: '));
    expect(args).toEqual([
      'arg: add-generic-password', 'arg: -U', 'arg: -s', 'arg: echo', 'arg: -a', 'arg: alice', 'arg: -w', 'arg: tok',
    ]);
    await expect(writeToken('alice', 'tok', keychainEnv({ FAKE_SECURITY_EXIT: '1' }))).rejects.toThrow();
  });

  it('messageIdentity is null inside a subagent, without ECHO_AGENT, or with no token found', async () => {
    const withToken = fileEnv({ ECHO_AGENT: 'alice', ECHO_TOKEN: 'tok' });
    expect(await messageIdentity(cfg, withToken, input())).toEqual({ name: 'alice', token: 'tok' });
    // subagent
    expect(await messageIdentity(cfg, withToken, input({ agent_id: 'sub-1' }))).toBeNull();
    // no ECHO_AGENT
    expect(await messageIdentity(cfg, fileEnv({ ECHO_TOKEN: 'tok' }), input())).toBeNull();
    // agent not in config
    expect(await messageIdentity(cfg, fileEnv({ ECHO_AGENT: 'mallory', ECHO_TOKEN: 'tok' }), input())).toBeNull();
    // no token anywhere
    expect(await messageIdentity(cfg, fileEnv({ ECHO_AGENT: 'alice' }), input())).toBeNull();
  });

  it('mergeCheckToken uses the ECHO_AGENT token, else the default agent token', async () => {
    const env = fileEnv();
    fs.mkdirSync(path.join(env.ECHO_HOME!, 'tokens'), { recursive: true });
    fs.writeFileSync(path.join(env.ECHO_HOME!, 'tokens', 'alice'), 'alice-tok');
    fs.writeFileSync(path.join(env.ECHO_HOME!, 'tokens', 'bob'), 'bob-tok');
    expect(await mergeCheckToken(cfg, env)).toBe('alice-tok');
    expect(await mergeCheckToken(cfg, { ...env, ECHO_AGENT: 'bob' })).toBe('bob-tok');
    expect(await mergeCheckToken(cfg, { ...env, ECHO_AGENT: 'bob', ECHO_TOKEN: 'env-tok' })).toBe('env-tok');
    expect(await mergeCheckToken({ ...cfg, defaultAgent: 'zed' }, env)).toBeNull();
  });
});

describe('api', () => {
  let server: FakeServer;
  beforeEach(async () => {
    server = await startFakeServer();
  });
  afterEach(() => server.close());

  it('sends a bearer token and JSON, returns parsed JSON on 2xx', async () => {
    server.reply({ status: 200, body: { ok: true, n: 1 } });
    const c = { ...cfg, url: server.url + '/' };
    expect(await api(c, 'tok', '/api/v1/ping')).toEqual({ ok: true, n: 1 });
    expect(await api(c, 'tok', '/api/v1/thing', { a: 1 })).toEqual({ ok: true, n: 1 });
    const [get, post] = server.requests;
    expect(get).toMatchObject({ method: 'GET', url: '/api/v1/ping' });
    expect(get.headers.authorization).toBe('Bearer tok');
    expect(post).toMatchObject({ method: 'POST', url: '/api/v1/thing' });
    expect(post.headers['content-type']).toBe('application/json');
    expect(JSON.parse(post.body)).toEqual({ a: 1 });
  });

  it('api classifies a refused connection and a 503 as Unreachable, a 403 as Refused', async () => {
    // refused connection: a port nothing listens on
    const dead = await startFakeServer();
    const deadUrl = dead.url;
    await dead.close();
    await expect(api({ ...cfg, url: deadUrl }, 't', '/x')).rejects.toBeInstanceOf(Unreachable);

    const c = { ...cfg, url: server.url };
    server.reply({ status: 503, body: { ok: false, error: { kind: 'service', code: 'DB_DOWN', message: 'm', fix: 'f' } } });
    await expect(api(c, 't', '/x')).rejects.toBeInstanceOf(Unreachable);

    server.reply({ status: 403, body: { ok: false, error: { kind: 'rule', code: 'HOLD_ACTIVE', message: 'blocked', fix: 'ask the owner' } } });
    const err = await api(c, 't', '/x').catch((e) => e);
    expect(err).toBeInstanceOf(Refused);
    expect(err).toMatchObject({ code: 'HOLD_ACTIVE', fix: 'ask the owner', status: 403, message: 'blocked' });
    expect(err).not.toBeInstanceOf(Unreachable);
  });

  it('a 4xx with an unreadable body is still Refused; a timeout is Unreachable', async () => {
    const c = { ...cfg, url: server.url };
    server.reply({ status: 401 });
    const err = await api(c, 't', '/x').catch((e) => e);
    expect(err).toBeInstanceOf(Refused);
    expect((err as Refused).code).toBe('HTTP_401');
    server.reply({ status: 200, body: {}, delayMs: 300 });
    await expect(api(c, 't', '/x', undefined, 50)).rejects.toBeInstanceOf(Unreachable);
  });
});
