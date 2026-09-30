import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Config, loadConfig } from '../src/config.js';
import { BoardSet } from '../src/services/boards.js';
import { createTools } from '../src/tools/tools.js';
import { type FakeApi, startFakeApi } from './fake-api.js';

let api: FakeApi;
// biome-ignore lint/suspicious/noExplicitAny: tool outputs are plain JSON, checked field by field
type Tool = { execute: (input: any) => Promise<any> };

function toolsFor(env: Record<string, string>): Record<string, Tool> {
  const config: Config = loadConfig({ KANBANFLOW_BASE_URL: api.url, ...env });
  const tools = createTools({ boards: BoardSet.fromConfig(config), config });
  return Object.fromEntries(tools.map((tool) => [tool.name, tool as unknown as Tool]));
}

const ids = (tasks: { id: string }[]) => tasks.map((t) => t.id);

beforeAll(async () => {
  api = await startFakeApi();
});
afterAll(() => api.close());
beforeEach(() => {
  api.requests.length = 0;
});

describe('config', () => {
  it('accepts one token, several tokens and the old KANBANFLOW_USER_ID name', () => {
    const config = loadConfig({
      KANBANFLOW_API_KEY: 'a',
      KANBANFLOW_API_KEYS: 'b, c\nb',
      KANBANFLOW_USER_ID: 'u1',
    });
    expect(config.apiKeys).toEqual(['a', 'b', 'c']);
    expect(config.user).toBe('u1');
  });

  it('fails with a clear message without any token', () => {
    expect(() => loadConfig({})).toThrow('No KanbanFlow API token is configured');
  });

  it('accepts tokens pasted with quotes, brackets, spaces or new lines', () => {
    const pasted = ' "tokA1", \'tokB2\'\n tokC3 ; ["tokD4"] ';
    expect(loadConfig({ KANBANFLOW_API_KEYS: pasted }).apiKeys).toEqual(['tokA1', 'tokB2', 'tokC3', 'tokD4']);
  });

  it('rejects a token with impossible characters, naming its position', () => {
    expect(() => loadConfig({ KANBANFLOW_API_KEYS: 'good1,bad#2' })).toThrow('API token #2');
  });

  it('treats optional fields a client left unsubstituted as not set', () => {
    const config = loadConfig({ KANBANFLOW_API_KEYS: 'tok1', KANBANFLOW_USER: '${user_config.kanbanflow_user}' });
    expect(config.user).toBeUndefined();
    expect(() => loadConfig({ KANBANFLOW_API_KEYS: '${user_config.kanbanflow_api_keys}' })).toThrow(
      'No KanbanFlow API token is configured'
    );
  });
});

describe('list_boards', () => {
  it('lists every configured board, where "me" is, and tokens that failed', async () => {
    const tools = toolsFor({ KANBANFLOW_API_KEYS: 'token-a,token-b,token-bad', KANBANFLOW_USER: 'ada@example.com' });
    const out = await tools.list_boards.execute({});

    expect(out.boards.map((b: { name: string }) => b.name)).toEqual(['Test board', 'Other team']);
    expect(out.me.foundOn).toEqual([
      { board: { id: 'b1', name: 'Test board' }, users: [{ id: 'u1', name: 'Ada Lovelace' }], matchedBy: 'email' },
      { board: { id: 'b2', name: 'Other team' }, users: [{ id: 'u9', name: 'Ada Lovelace' }], matchedBy: 'email' },
    ]);
    expect(out.boards[0].colors[0]).toEqual({ value: 'red', name: 'Urgent', description: 'Before anything else' });
    expect(out.failedBoards).toEqual([{ token: 3, error: expect.stringContaining('HTTP 401') }]);
    expect(JSON.stringify(out)).not.toContain('token-bad');
  });
});

describe('list_tasks', () => {
  const multi = { KANBANFLOW_API_KEYS: 'token-a,token-b', KANBANFLOW_USER: 'ada@example.com' };

  it('returns "my" tasks from every board, matching the person on each board', async () => {
    const out = await toolsFor(multi).list_tasks.execute({});
    expect(ids(out.tasks)).toEqual(['t1', 'b-1']);
    expect(out.tasks[1].board).toEqual({ id: 'b2', name: 'Other team' });
    expect(out.person.source).toBe('KANBANFLOW_USER');
    expect(out.counts.byBoard.map((b: { count: number }) => b.count)).toEqual([1, 1]);
  });

  it('finds another person by (partial) name and says how it matched', async () => {
    const out = await toolsFor(multi).list_tasks.execute({ person: 'grace' });
    expect(ids(out.tasks)).toEqual(['t3']);
    expect(out.person.matches[0]).toMatchObject({ matchedBy: 'partial name' });
    expect(out.meta.boardsWherePersonIsNotMember).toEqual([{ id: 'b2', name: 'Other team' }]);
  });

  it('matches the responsible user as well as collaborators', async () => {
    const out = await toolsFor(multi).list_tasks.execute({ person: 'Grace Hopper' });
    expect(out.tasks[0].responsible).toEqual({ id: 'u2', name: 'Grace Hopper' });
  });

  it('warns when a partial name matches several people', async () => {
    const out = await toolsFor(multi).list_tasks.execute({ person: 'ada', boards: ['Other team'] });
    expect(ids(out.tasks)).toEqual(['b-1', 'b-2']);
    expect(out.meta.warnings[0]).toContain('matched 2 members on board "Other team"');
  });

  it('restricts to boards and columns, and reports what matched nothing', async () => {
    const out = await toolsFor(multi).list_tasks.execute({ boards: ['Test board', 'Nope'], columns: ['In QA'] });
    expect(out.tasks).toEqual([]);
    expect(out.meta.warnings).toEqual(
      expect.arrayContaining([
        'Board "Nope" is not configured; it matched nothing.',
        'Column "In QA" exists on none of the searched boards.',
      ])
    );
  });

  it('reports partially loaded columns and loads them when asked', async () => {
    const tools = toolsFor({ KANBANFLOW_API_KEY: 'token-a' });
    const partial = await tools.list_tasks.execute({ person: 'Task owner nobody' });
    expect(partial.meta.warnings).toContain('"Task owner nobody" is not a member of any searched board.');

    const first = await tools.list_tasks.execute({ person: 'ada@example.com' });
    expect(first.meta.complete).toBe(false);
    expect(first.meta.incompleteCells[0]).toMatchObject({ column: { name: 'Done' }, loadedTasks: 2 });

    const done = await tools.list_tasks.execute({ person: 'ada@example.com', columns: ['done'] });
    expect(done.meta.complete).toBe(true);
    expect(api.requests.some((r) => r.includes('startTaskId=d3'))).toBe(true);
  });

  it('asks for a person when none is given and none is configured', async () => {
    await expect(toolsFor({ KANBANFLOW_API_KEY: 'token-a' }).list_tasks.execute({})).rejects.toThrow(
      '"me" is not configured'
    );
  });

  it('keeps working when one of the tokens fails', async () => {
    const out = await toolsFor({ ...multi, KANBANFLOW_API_KEYS: 'token-a,token-bad' }).list_tasks.execute({});
    expect(ids(out.tasks)).toEqual(['t1']);
    expect(out.meta.complete).toBe(false);
    expect(out.meta.failedBoards).toEqual([{ token: 2, error: expect.stringContaining('HTTP 401') }]);
  });
});
