import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type FakeApi, startFakeApi } from './fake-api.js';
import { MODERN_META, StdioClient } from './stdio-client.js';

let api: FakeApi;
const clients: StdioClient[] = [];
const metaParams = (params: Record<string, unknown> = {}) => ({ ...params, _meta: MODERN_META });

function startClient(): StdioClient {
  const client = new StdioClient(['build/main.js'], {
    KANBANFLOW_API_KEYS: 'token-a,token-b',
    KANBANFLOW_USER: 'ada@example.com',
    KANBANFLOW_BASE_URL: api.url,
  });
  clients.push(client);
  return client;
}

beforeAll(async () => {
  api = await startFakeApi();
});
afterEach(() => {
  for (const client of clients.splice(0)) client.kill();
});
afterAll(async () => {
  await api.close();
});

describe('MCP 2026 subscriptions over stdio', () => {
  it('acknowledges a subscription before it ends and answers tools/list and tools/call', async () => {
    const client = startClient();
    const subscription = client.send('subscriptions/listen', metaParams({ notifications: { toolsListChanged: true } }));
    // Send the next request immediately, exactly as a client does during discovery.
    const listing = client.send('tools/list', metaParams());
    const ack = await client.waitFor((message) => message.method === 'notifications/subscriptions/acknowledged');
    expect(ack.params).toMatchObject({
      notifications: { toolsListChanged: true },
      _meta: { 'io.modelcontextprotocol/subscriptionId': subscription },
    });
    const response = await client.waitFor((message) => message.id === listing);
    const tools = response.result?.tools as { name: string; annotations: { readOnlyHint: boolean } }[];
    expect(tools.map((tool) => tool.name).sort()).toEqual(['list_boards', 'list_tasks']);
    expect(tools.every((tool) => tool.annotations.readOnlyHint)).toBe(true);
    expect(client.messages.some((message) => message.id === subscription)).toBe(false);

    const tasks = await client.request('tools/call', metaParams({ name: 'list_tasks', arguments: {} }));
    expect(tasks.result?.isError).toBeFalsy();
    const content = tasks.result?.structuredContent as { tasks: { id: string }[] };
    expect(content.tasks.map((task) => task.id)).toEqual(['t1', 'b-1']);
  });

  it('rejects unsupported methods while a subscription is open', async () => {
    const client = startClient();
    client.send('subscriptions/listen', metaParams({ notifications: { toolsListChanged: true } }));
    const unsupported = await client.request('not/a/method', metaParams());
    expect(unsupported.error?.code).toBe(-32601);
    expect((await client.request('tools/list', metaParams())).result?.tools).toBeDefined();
  });

  it('rejects malformed subscriptions without blocking later requests', async () => {
    const client = startClient();
    const invalid = await client.request('subscriptions/listen', metaParams());
    expect(invalid.error?.code).toBe(-32602);
    expect((await client.request('tools/list', metaParams())).result?.tools).toBeDefined();
  });

  it('closes an empty subscription and continues serving tools', async () => {
    const client = startClient();
    const closed = await client.request('subscriptions/listen', metaParams({ notifications: {} }));
    expect(closed.result?.resultType).toBe('complete');
    expect((await client.request('tools/list', metaParams())).result?.tools).toBeDefined();
  });

  it('exits on stdin EOF even with an active subscription', async () => {
    const client = startClient();
    client.send('subscriptions/listen', metaParams({ notifications: { toolsListChanged: true } }));
    await client.waitFor((message) => message.method === 'notifications/subscriptions/acknowledged');
    client.child.stdin.end();
    expect(await client.exited).toBe(0);
  });
});
