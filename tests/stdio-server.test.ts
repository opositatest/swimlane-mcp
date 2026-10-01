import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FakeApi, startFakeApi } from './fake-api.js';
import { StdioClient } from './stdio-client.js';

// Exercise the exact bundled entry point shipped by npm, against the fake multi-board API.
describe.each(['2025-06-18', '2025-11-25'])('MCP %s over stdio', (protocolVersion) => {
  let api: FakeApi;
  let client: StdioClient;

  beforeAll(async () => {
    api = await startFakeApi();
    client = new StdioClient(['build/main.js'], {
      KANBANFLOW_API_KEYS: 'token-a,token-b',
      KANBANFLOW_USER: 'ada@example.com',
      KANBANFLOW_BASE_URL: api.url,
    });
    const init = await client.request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'vitest', version: '1.0.0' },
    });
    expect(init.result?.serverInfo).toMatchObject({ name: 'swimlane-mcp' });
    expect(init.result?.protocolVersion).toBe(protocolVersion);
    client.notify('notifications/initialized');
  });

  afterAll(async () => {
    client?.kill();
    await api?.close();
  });

  it('exposes the tools as read-only', async () => {
    const response = await client.request('tools/list');
    const tools = response.result?.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[];
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'get_task',
      'list_boards',
      'list_comments',
      'list_tasks',
      'search_tasks',
    ]);
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it('returns my tasks from every board as structured JSON', async () => {
    const response = await client.request('tools/call', { name: 'list_tasks', arguments: {} });
    expect(response.result?.isError).toBeFalsy();
    const content = response.result?.structuredContent as { tasks: { id: string; board: { name: string } }[] };
    expect(content.tasks.map((task) => `${task.board.name}/${task.id}`)).toEqual(['Test board/t1', 'Other team/b-1']);
  });

  it('returns one task with its comments as structured JSON', async () => {
    const response = await client.request('tools/call', { name: 'get_task', arguments: { taskId: 't1' } });
    expect(response.result?.isError).toBeFalsy();
    const content = response.result?.structuredContent as {
      task: { id: string; board: { name: string } };
      comments: { text: string }[];
    };
    expect(`${content.task.board.name}/${content.task.id}`).toBe('Test board/t1');
    expect(content.comments.map((comment) => comment.text)).toEqual(['Looks good']);
  });

  it('answers ping during a legacy session', async () => {
    expect((await client.request('ping')).result).toEqual({});
  });

  it('returns invalid tool inputs as protocol/tool errors', async () => {
    const response = await client.request('tools/call', { name: 'list_tasks', arguments: { limit: 0 } });
    expect(response.error ?? response.result?.isError).toBeTruthy();
  });
});

it('starts without configuration and reports the problem in the tool response', async () => {
  const client = new StdioClient(['build/main.js']);
  try {
    await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '1.0.0' },
    });
    client.notify('notifications/initialized');
    const response = await client.request('tools/call', { name: 'list_tasks', arguments: {} });
    expect(response.result?.isError).toBe(true);
    expect(JSON.stringify(response.result?.content)).toContain('No KanbanFlow API token is configured');
    expect(JSON.stringify(response.result?.content)).toContain('Settings > Extensions > Swimlane');
  } finally {
    client.kill();
  }
});
