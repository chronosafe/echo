// Bundles the hook CLI into one dependency-free file: node hooks/build.mjs [--out <file>]
import { buildSync } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const i = process.argv.indexOf('--out');
const outfile = i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(here, 'dist', 'echo-hook.mjs');

buildSync({
  entryPoints: [path.join(here, 'src', 'cli.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'warning',
});
