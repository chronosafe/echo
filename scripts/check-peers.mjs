// Fails if an installed package does not satisfy the peer range that the installed `agents` declares.
//
// Why this exists: the repo's .npmrc sets legacy-peer-deps=true. A fresh `npm install` (no lockfile)
// crashes in npm 11.3's peer resolver ("Cannot read properties of null (reading 'edgesOut')") when
// `agents` and its many optional peers are resolved. That setting also stops npm from enforcing
// peer ranges, so this script does it for the packages Echo depends on (the MCP server and zod).
// Remove both the .npmrc and this check once npm can install without the workaround.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import semver from 'semver';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readPkg = (name) => JSON.parse(readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));

const agents = readPkg('agents');
const failures = [];
for (const name of ['@modelcontextprotocol/server', 'zod']) {
  const range = agents.peerDependencies?.[name];
  if (!range) {
    failures.push(`agents@${agents.version} declares no peer range for ${name}; update scripts/check-peers.mjs`);
    continue;
  }
  const installed = readPkg(name).version;
  if (!semver.satisfies(installed, range)) {
    failures.push(`${name}@${installed} does not satisfy agents@${agents.version} peer range "${range}"`);
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`peer check ok (agents@${agents.version})`);
