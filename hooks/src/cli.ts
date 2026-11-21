import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as format from './format';
import { dispatch } from './main';
import { deny } from './merge-pre';

// Bundle entry point. Runs unconditionally: an entry-point guard comparing paths fails open through symlinks.
const event = process.argv[2];
try {
  const out = await dispatch(event, () => fs.readFileSync(0, 'utf8'), process.env, Date.now(), {
    args: process.argv.slice(3),
    selfPath: fs.realpathSync(fileURLToPath(import.meta.url)),
  });
  if ('stderr' in out && out.stderr) process.stderr.write(out.stderr);
  if (out.stdout) process.stdout.write(out.stdout);
  process.exitCode = out.exitCode;
} catch (e) {
  // dispatch never throws by design; this is the last line of defence. pre-bash fails closed, every other event prints nothing.
  if (event === 'pre-bash') process.stdout.write(deny(format.hookError(e instanceof Error ? e.message : String(e))).stdout ?? '');
  // For wait, exit 0 means "a message is waiting", so a crash is a setup error instead.
  process.exitCode = event === 'wait' ? 2 : 0;
}
