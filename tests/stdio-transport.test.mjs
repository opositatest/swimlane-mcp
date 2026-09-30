import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { patchStdio, stdioCompatPlugin } from '../scripts/stdio-compat.mjs';
import { MODERN_META, StdioClient } from './stdio-client.ts';

const directory = mkdtempSync(join(tmpdir(), 'swimlane-stdio-test-'));
const entry = join(directory, 'stdio-fixture.mjs');
const clients = [];
const params = (data = {}) => ({ ...data, _meta: MODERN_META });
const startClient = () => {
  const client = new StdioClient([entry]);
  clients.push(client);
  return client;
};

beforeAll(async () => {
  await build({
    entryPoints: ['tests/fixtures/stdio-transport.ts'],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    plugins: [stdioCompatPlugin],
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
});
afterEach(() => {
  for (const client of clients.splice(0)) client.kill();
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('TanStack stdio compatibility fix', () => {
  it('fails closed when upstream changes instead of silently shipping an unpatched adapter', () => {
    expect(() => patchStdio('different upstream source')).toThrow('Review/remove the compatibility fix');
  });

  it('parses fragmented CRLF, multiline data, heartbeats and UTF-8 without waiting for EOF', async () => {
    const client = startClient();
    const id = client.send('subscriptions/listen', params());
    await client.waitFor((message) => message.method === 'notifications/subscriptions/acknowledged');
    await client.request('test/notify', params());
    const note = await client.waitFor((message) => message.method === 'notifications/tools/list_changed');
    expect(note.params).toEqual({ id, text: 'café 🏊' });
  });

  it('cancels only the requested stream and keeps other subscriptions and requests working', async () => {
    const client = startClient();
    const first = client.send('subscriptions/listen', params());
    const second = client.send('subscriptions/listen', params());
    await client.waitFor((message) => message.params?.id === first);
    await client.waitFor((message) => message.params?.id === second);
    expect((await client.request('test/state', params())).result?.active).toBe(2);
    client.notify('notifications/cancelled', { requestId: first });
    const state = await client.request('test/state', params());
    expect(state.result).toEqual({ active: 1, cancelled: 1 });
    await client.request('test/notify', params());
    await client.waitFor(
      (message) => message.method === 'notifications/tools/list_changed' && message.params?.id === second
    );
    expect(
      client.messages.some(
        (message) => message.method === 'notifications/tools/list_changed' && message.params?.id === first
      )
    ).toBe(false);
  });

  it('returns a protocol error for malformed SSE and still answers the next request', async () => {
    const client = startClient();
    expect((await client.request('test/bad-sse', params())).error?.code).toBe(-32603);
    expect((await client.request('test/state', params())).result).toBeDefined();
  });

  it('aborts readers and exits on stdin EOF with several subscriptions open', async () => {
    const client = startClient();
    client.send('subscriptions/listen', params());
    client.send('subscriptions/listen', params());
    expect((await client.request('test/state', params())).result?.active).toBe(2);
    client.child.stdin.end();
    expect(await client.exited).toBe(0);
  });
});
