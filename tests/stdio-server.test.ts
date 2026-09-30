import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FakeApi, startFakeApi } from './fake-api.js';

// Test end-to-end: arranca el servidor real por stdio y le habla JSON-RPC
// igual que un host MCP (Claude Desktop), contra una API de KanbanFlow falsa en localhost.

type JsonRpcResponse = { id: number; result?: Record<string, unknown>; error?: { message: string } };

let api: FakeApi;
let child: ChildProcessWithoutNullStreams;
let nextId = 1;
const pending = new Map<number, (response: JsonRpcResponse) => void>();

function request(method: string, params: Record<string, unknown> = {}): Promise<JsonRpcResponse> {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}

beforeAll(async () => {
  api = await startFakeApi();

  child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    env: {
      PATH: process.env.PATH ?? '',
      KANBANFLOW_API_KEYS: 'token-a,token-b',
      KANBANFLOW_USER: 'ada@example.com',
      KANBANFLOW_BASE_URL: api.url,
    },
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as JsonRpcResponse;
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });

  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '1.0.0' },
  });
  expect(init.result?.serverInfo).toMatchObject({ name: 'swimlane-mcp' });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
}, 30_000);

afterAll(async () => {
  child?.kill();
  await api?.close();
});

describe('servidor MCP por stdio', () => {
  it('expone las tools como solo lectura', async () => {
    const response = await request('tools/list');
    const tools = response.result?.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[];

    expect(tools.map((tool) => tool.name).sort()).toEqual(['list_boards', 'list_tasks']);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('devuelve mis tareas de todos los tableros como JSON estructurado', async () => {
    const response = await request('tools/call', { name: 'list_tasks', arguments: {} });

    expect(response.result?.isError).toBeFalsy();
    const content = response.result?.structuredContent as { tasks: { id: string; board: { name: string } }[] };
    expect(content.tasks.map((task) => `${task.board.name}/${task.id}`)).toEqual(['Test board/t1', 'Other team/b-1']);
  });

  it('devuelve los errores de la tool como isError con un mensaje útil', async () => {
    const response = await request('tools/call', { name: 'list_tasks', arguments: { limit: 0 } });
    expect(response.error ?? response.result?.isError).toBeTruthy();
  });
});

describe('servidor MCP por stdio sin configurar', () => {
  it('arranca igualmente y explica el problema en la respuesta de la tool', async () => {
    const unconfigured = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      env: { PATH: process.env.PATH ?? '' },
    });
    const lines = createInterface({ input: unconfigured.stdout });
    const responses = new Map<number, JsonRpcResponse>();
    const waitFor = (id: number) =>
      new Promise<JsonRpcResponse>((resolve) => {
        lines.on('line', (line) => {
          const message = JSON.parse(line) as JsonRpcResponse;
          responses.set(message.id, message);
          if (message.id === id) resolve(message);
        });
      });
    const send = (id: number, method: string, params: Record<string, unknown> = {}) => {
      const answer = waitFor(id);
      unconfigured.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return answer;
    };

    await send(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '1.0.0' },
    });
    unconfigured.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const response = await send(2, 'tools/call', { name: 'list_tasks', arguments: {} });
    unconfigured.kill();

    expect(response.result?.isError).toBe(true);
    const text = JSON.stringify(response.result?.content);
    expect(text).toContain('No KanbanFlow API token is configured');
    expect(text).toContain('Settings > Extensions > Swimlane');
  }, 30_000);
});
