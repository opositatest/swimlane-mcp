import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));

describe('MCPB platform compatibility', () => {
  it.each(['darwin', 'win32', 'linux'])('allows installation on %s', (platform) => {
    expect(manifest.compatibility.platforms).toContain(platform);
  });

  it('uses the same portable Node entry point on every platform', () => {
    expect(manifest.server.type).toBe('node');
    expect(manifest.server.entry_point).toBe('server/main.js');
    expect(manifest.server.mcp_config.command).toBe('node');
    expect(manifest.server.mcp_config.args).toEqual(['${__dirname}/server/main.js']);
    expect(manifest.compatibility.runtimes.node).toBe('>=24.0.0');
  });
});
