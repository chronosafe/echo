import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { saveConfig } from '../src/config';
import { dispatch, type Dispatched } from '../src/main';
import { mcpAddCommand, mcpHeadersText } from '../src/install';
import { writeToken } from '../src/token-store';
import { startFakeServer, type FakeServer } from './fake-server';

const TOKEN = 'echo_tok_SECRET_9f3a7c1d';
const OTHER = 'echo_tok_OTHER_55aa';
let tmp: string;
let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'echo-mcph-')));
  home = path.join(tmp, 'echo');
  env = { PATH: process.env.PATH, ECHO_HOME: home, ECHO_TOKEN_STORE: 'file', HOME: path.join(tmp, 'home') };
  saveConfig(env, { url: 'http://x.example', agents: ['orch', 'other'], defaultAgent: 'other' });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const run = async (e: NodeJS.ProcessEnv) => {
  const r: Dispatched = await dispatch('mcp-headers', () => '', e);
  return { stdout: 'stdout' in r ? (r.stdout ?? '') : '', stderr: 'stderr' in r ? (r.stderr ?? '') : '', exitCode: r.exitCode };
};

describe('mcp-headers subcommand', () => {
  it('prints the bearer header for ECHO_AGENT when it is configured and has a token', async () => {
    await writeToken('orch', TOKEN, env);
    const r = await run({ ...env, ECHO_AGENT: 'orch' });
    expect(r).toEqual({ stdout: JSON.stringify({ Authorization: `Bearer ${TOKEN}` }) + '\n', stderr: '', exitCode: 0 });
  });

  it('prints {} with no ECHO_AGENT and never falls back to defaultAgent', async () => {
    await writeToken('other', OTHER, env);
    const r = await run(env);
    expect(r).toEqual({ stdout: '{}\n', stderr: '', exitCode: 0 });
  });

  it('prints {} for an agent not in config.agents, even with a stored token or ECHO_TOKEN', async () => {
    await writeToken('stranger', TOKEN, env);
    expect((await run({ ...env, ECHO_AGENT: 'stranger' })).stdout).toBe('{}\n');
    expect((await run({ ...env, ECHO_AGENT: 'stranger', ECHO_TOKEN: TOKEN })).stdout).toBe('{}\n');
  });

  it('prints {} when the agent has no token', async () => {
    const r = await run({ ...env, ECHO_AGENT: 'orch' });
    expect(r).toEqual({ stdout: '{}\n', stderr: '', exitCode: 0 });
  });

  it('prints {} when there is no config, and for an invalid name', async () => {
    fs.rmSync(path.join(home, 'config.json'));
    expect((await run({ ...env, ECHO_AGENT: 'orch', ECHO_TOKEN: TOKEN })).stdout).toBe('{}\n');
    saveConfig(env, { url: 'http://x.example', agents: ['../x'], defaultAgent: '../x' });
    expect((await run({ ...env, ECHO_AGENT: '../x' })).stdout).toBe('{}\n');
  });

  it('prefers ECHO_TOKEN over the stored token (wrapper launches)', async () => {
    await writeToken('orch', OTHER, env);
    const r = await run({ ...env, ECHO_AGENT: 'orch', ECHO_TOKEN: TOKEN });
    expect(JSON.parse(r.stdout)).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it('escapes through JSON.stringify and keeps the token off stderr', async () => {
    await writeToken('orch', 'a"b\\c', env);
    const r = await run({ ...env, ECHO_AGENT: 'orch' });
    expect(JSON.parse(r.stdout)).toEqual({ Authorization: 'Bearer a"b\\c' });
    expect(r.stderr).toBe('');
  });
});

describe('mcpAddCommand quoting', () => {
  it('round-trips a path with a space and a single quote through sh', () => {
    const helper = "/tmp/it's a dir/echo-mcp-headers";
    const cmd = mcpAddCommand('https://e.example', helper).replace(/^claude mcp add-json echo /, 'printf %s ').replace(/ --scope user$/, '');
    const r = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' });
    expect(JSON.parse(r.stdout)).toEqual({ type: 'http', url: 'https://e.example/mcp', headersHelper: helper });
  });
});

describe('installed echo-mcp-headers script', () => {
  let work: string;
  let bundle: string;
  let server: FakeServer;
  beforeAll(() => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'echo-mcph-bundle-')));
    bundle = path.join(work, 'echo-hook.mjs');
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, '../build.mjs'), '--out', bundle], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`build failed: ${r.stderr}`);
  });
  afterAll(() => fs.rmSync(work, { recursive: true, force: true }));
  beforeEach(async () => {
    server = await startFakeServer();
    server.reply(() => ({ status: 200, body: { gatedRepos: [] } }));
  });
  afterEach(() => server.close());

  // The Echo home is "<tmp>/echo home": a path with a space.
  async function installSpaced() {
    const h = path.join(tmp, 'echo home');
    const e = { PATH: process.env.PATH, ECHO_HOME: h, ECHO_TOKEN_STORE: 'file', HOME: path.join(tmp, 'home') };
    const r = await dispatch('install', () => TOKEN + '\n', e, Date.now(), {
      args: ['--url', server.url, '--agent', 'orch', '--settings', path.join(tmp, 'settings.json')],
      selfPath: bundle,
    });
    expect(r.exitCode).toBe(0);
    return { h, e };
  }
  const exec = (h: string, e: NodeJS.ProcessEnv) => spawnSync('/bin/sh', [path.join(h, 'echo-mcp-headers')], { env: e, encoding: 'utf8' });

  it('works from a home whose path contains a space, and prints {} without ECHO_AGENT', async () => {
    const { h, e } = await installSpaced();
    const ok = exec(h, { ...e, ECHO_AGENT: 'orch' });
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(ok.stderr).toBe('');
    expect(exec(h, e).stdout).toBe('{}\n');
    expect(exec(h, { ...e, ECHO_AGENT: 'nobody' }).stdout).toBe('{}\n');
  });

  it('prints {} and exits 0 when the config is corrupt, the bundle is gone, or node is gone', async () => {
    const { h, e } = await installSpaced();
    const asAgent = { ...e, ECHO_AGENT: 'orch' };
    fs.writeFileSync(path.join(h, 'config.json'), '{not json');
    expect(exec(h, asAgent)).toMatchObject({ status: 0, stdout: '{}\n' });
    fs.rmSync(path.join(h, 'echo-hook.mjs'));
    expect(exec(h, asAgent)).toMatchObject({ status: 0, stdout: '{}\n' });
    fs.writeFileSync(path.join(h, 'echo-mcp-headers'), mcpHeadersText('/nonexistent/node', h), { mode: 0o755 });
    expect(exec(h, asAgent)).toMatchObject({ status: 0, stdout: '{}\n' });
  });

  it('prints {} and exits 0 when node runs but the bundle fails', async () => {
    const { h, e } = await installSpaced();
    fs.writeFileSync(path.join(h, 'echo-hook.mjs'), 'throw new Error("boom");\n');
    const r = exec(h, { ...e, ECHO_AGENT: 'orch' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('{}\n');
  });
});
