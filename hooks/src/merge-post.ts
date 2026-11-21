import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { api, Refused } from './client';
import { loadConfig } from './config';
import * as format from './format';
import type { HookInput } from './input';
import type { HookOutput } from './merge-pre';
import { parseMerge } from './parse-merge';
import { resolvePr } from './resolve-pr';
import { drainReports, queueReport, takePendingMerge, type Report } from './state';
import { mergeCheckToken } from './token-store';

function gh(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, env, timeout: 10_000, encoding: 'utf8' }, (err) => (err ? reject(err) : resolve()));
  });
}

/** Best effort: sends each report, putting the ones that fail back on the queue. */
async function sendReports(reports: Report[], env: NodeJS.ProcessEnv): Promise<void> {
  if (reports.length === 0) return;
  const cfg = loadConfig(env);
  const token = cfg ? await mergeCheckToken(cfg, env) : null;
  for (const r of reports) {
    try {
      if (!cfg || !token || typeof r.path !== 'string') throw new Error('cannot send');
      await api(cfg, token, r.path, r.body);
    } catch (e) {
      // Echo answered and said no: retrying can never help, so drop it. Only an outage keeps the report.
      if (!(e instanceof Refused)) queueReport(r, env);
    }
  }
}

export async function postBash(input: HookInput, env: NodeJS.ProcessEnv): Promise<HookOutput> {
  await sendReports(drainReports(env), env);
  const command = input.tool_input?.command;
  if (input.tool_name !== 'Bash' || typeof command !== 'string' || !input.tool_use_id) return { exitCode: 0 };
  const parsed = parseMerge(command, input.cwd);
  if (parsed.kind !== 'merge' || parsed.inv.disableAuto) return { exitCode: 0 };
  const target = takePendingMerge(input.tool_use_id, env);
  if (!target) return { exitCode: 0 };

  const cwd = fs.existsSync(input.cwd) ? input.cwd : os.tmpdir();
  let view;
  try {
    view = await resolvePr(
      { target: String(target.pr), repoFlag: target.repo, envRepo: null, cwd, auto: false, admin: false, disableAuto: false },
      env,
    );
  } catch {
    return { exitCode: 0 };
  }
  if (view.state === 'MERGED' && view.mergedAt) {
    await sendReports([{ path: '/api/v1/merge-report', body: { repo: target.repo, pr: target.pr, mergedAt: view.mergedAt } }], env);
    return { exitCode: 0 };
  }
  if (view.state === 'OPEN') {
    try {
      await gh(['pr', 'merge', String(target.pr), '-R', target.repo, '--disable-auto'], cwd, env);
    } catch {
      /* the agent is told below either way */
    }
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: format.queuedDisabled(target) },
      }),
      exitCode: 0,
    };
  }
  return { exitCode: 0 };
}
