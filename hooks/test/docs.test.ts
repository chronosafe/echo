import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const setup = fs.readFileSync(path.resolve(__dirname, '../../docs/setup.md'), 'utf8');
const install = setup.slice(setup.indexOf('## Install on a machine'), setup.indexOf('## Rotate a token'));

describe('docs/setup.md', () => {
  it('the per-machine install section tells the owner to allow Echo tools in Claude Code permissions, and why', () => {
    expect(install).toContain('"permissions": {"allow": ["mcp__echo__*"]}');
    expect(install).toContain('/permissions');
    expect(install).toContain('echo_ack_message');
    expect(install).toMatch(/auto mode/i);
  });
});
