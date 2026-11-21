import * as format from './format';
import { install, mcpHeadersCommand, setTokenCommand, tokenCommand, type CommandResult } from './install';
import { readInput } from './input';
import { waitCommand } from './wait';
import { postBash } from './merge-post';
import { postTool, promptSubmit, sessionStart, stop } from './messages';
import { deny, noteOverrideSeen, preBash, type HookOutput } from './merge-pre';

const VERSION = '0.1.0';
export type Dispatched = HookOutput | CommandResult;
export type DispatchOptions = { args?: string[]; selfPath?: string };

/**
 * Never throws. pre-bash fails closed; every other event prints nothing.
 */
export async function dispatch(
  event: string | undefined,
  stdin: () => string,
  env: NodeJS.ProcessEnv,
  nowMs: number = Date.now(),
  opts: DispatchOptions = {},
): Promise<Dispatched> {
  if (event === 'version') return { stdout: VERSION + '\n', exitCode: 0 };
  if (event === 'mcp-headers') return await mcpHeadersCommand(env);
  if (event === 'wait') {
    try {
      return await waitCommand(opts.args ?? [], env);
    } catch (e) {
      // Exit 0 means "a message is waiting", so a crash must never look like that.
      return { stderr: `echo wait: unexpected error: ${e instanceof Error ? e.message : 'unknown'}\n`, exitCode: 2 };
    }
  }
  if (event === 'install' || event === 'token' || event === 'set-token') {
    try {
      const args = opts.args ?? [];
      if (event === 'install') return await install(args, stdin, env, opts.selfPath);
      if (event === 'token') return await tokenCommand(args, env);
      return await setTokenCommand(args, stdin, env);
    } catch (e) {
      return { stderr: `${event} failed: ${e instanceof Error ? e.message : String(e)}\n`, exitCode: 1 };
    }
  }
  try {
    try {
      noteOverrideSeen(env, nowMs);
    } catch {
      /* best effort */
    }
    if (event === 'pre-bash') return await preBash(readInput(stdin()), env, nowMs);
    if (event === 'post-bash') return await postBash(readInput(stdin()), env);
    if (event === 'session-start') return await sessionStart(readInput(stdin()), env);
    if (event === 'prompt') return await promptSubmit(readInput(stdin()), env);
    if (event === 'post-tool') return await postTool(readInput(stdin()), env, nowMs);
    if (event === 'stop') return await stop(readInput(stdin()), env);
    return { exitCode: 0 };
  } catch (e) {
    if (event === 'pre-bash') return deny(format.hookError(e instanceof Error ? e.message : String(e)));
    return { exitCode: 0 };
  }
}
