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
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the literal placeholder a client sends when a field is unset
    const config = loadConfig({ KANBANFLOW_API_KEYS: 'tok1', KANBANFLOW_USER: '${user_config.kanbanflow_user}' });
    expect(config.user).toBeUndefined();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the literal placeholder a client sends when a field is unset
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

describe('get_task', () => {
  const multi = { KANBANFLOW_API_KEYS: 'token-a,token-b', KANBANFLOW_USER: 'ada@example.com' };

  it('returns one task in full, with its comments and author names', async () => {
    const out = await toolsFor(multi).get_task.execute({ taskId: 't1' });
    expect(out.task).toMatchObject({
      board: { id: 'b1', name: 'Test board' },
      id: 't1',
      name: 'Task t1',
      url: 'https://kanbanflow.com/t/t1',
      column: { id: 'c-todo', name: 'Backlog' },
      color: { value: 'red', boardName: 'Urgent', boardDescription: 'Before anything else' },
      labels: ['Bug'],
      collaborators: [{ id: 'u1', name: 'Ada Lovelace' }],
      descriptionTruncated: false,
    });
    expect(out.task.raw).toMatchObject({ _id: 't1' });
    expect(out.comments).toEqual([
      { id: 'k1', author: { id: 'u2', name: 'Grace Hopper' }, createdAt: '2026-09-28T09:00:00Z', text: 'Looks good' },
    ]);
    expect(out.meta.boardsSearched).toEqual([
      { id: 'b1', name: 'Test board' },
      { id: 'b2', name: 'Other team' },
    ]);
    expect(out.meta.boardsWithoutTheTask).toBeUndefined();
  });

  it('finds a task on a later board and reports which boards did not have it', async () => {
    const out = await toolsFor(multi).get_task.execute({ taskId: 'b-1' });
    expect(out.task.board).toEqual({ id: 'b2', name: 'Other team' });
    expect(out.task.collaborators).toEqual([{ id: 'u9', name: 'Ada Lovelace' }]);
    expect(out.comments[0]).toMatchObject({
      author: { id: 'u8', name: 'Adam Smith' },
      text: '@Ada can you review this?',
    });
    expect(out.meta.boardsWithoutTheTask).toEqual([{ board: { id: 'b1', name: 'Test board' }, status: 404 }]);
  });

  it('skips the comments request when asked', async () => {
    const out = await toolsFor(multi).get_task.execute({ taskId: 't1', includeComments: false });
    expect(out.comments).toBeNull();
    expect(api.requests.some((request) => request.includes('/comments'))).toBe(false);
  });

  it('looks only on the board it is pointed at', async () => {
    const tools = toolsFor(multi);
    await expect(tools.get_task.execute({ taskId: 't1', board: 'Other team' })).rejects.toThrow(
      'is not on board "Other team"'
    );
    await expect(tools.get_task.execute({ taskId: 't1', board: 'Nope' })).rejects.toThrow('matched nothing');
  });

  it('reports a task id that exists on no board, and boards that failed to load', async () => {
    await expect(toolsFor(multi).get_task.execute({ taskId: 'ghost' })).rejects.toThrow(
      'is not on any of the 2 searched board'
    );
    await expect(
      toolsFor({ KANBANFLOW_API_KEYS: 'token-a,token-bad' }).get_task.execute({ taskId: 'ghost' })
    ).rejects.toThrow('could not be loaded');
  });
});

describe('list_comments', () => {
  const multi = { KANBANFLOW_API_KEYS: 'token-a,token-b', KANBANFLOW_USER: 'ada@example.com' };
  const day = { from: '2026-09-28T00:00:00Z', to: '2026-09-29T00:00:00Z' };

  it('finds the newest comments that mention a person, across boards', async () => {
    const out = await toolsFor(multi).list_comments.execute({ person: 'me', ...day });
    // kb1 (11:00) then k2 (10:06); k1 does not mention Ada, k3 is outside the window, kb2 does not mention Ada.
    expect(out.comments.map((comment: { id: string }) => comment.id)).toEqual(['kb1', 'k2']);
    expect(out.comments[0]).toMatchObject({
      text: '@Ada can you review this?',
      author: { id: 'u8', name: 'Adam Smith' },
      board: { id: 'b2', name: 'Other team' },
      task: { id: 'b-1', name: 'Task b-1', column: { name: 'To do' } },
    });
    expect(out.comments[1].task).toMatchObject({ id: 't2', column: { name: 'Backlog' } });
    expect(out.person).toMatchObject({ resolved: 'ada@example.com', source: 'me (KANBANFLOW_USER)' });
    expect(out.person.textSearched).toEqual([
      { board: { id: 'b1', name: 'Test board' }, needles: ['Ada Lovelace', 'Ada'] },
      { board: { id: 'b2', name: 'Other team' }, needles: ['Ada Lovelace', 'Ada'] },
    ]);
    expect(out.meta.commentsMatched).toBe(2);
    expect(out.meta.events.complete).toBe(true);
    expect(out.meta.events.commentEvents).toBe(4);
    expect(out.meta.tasksScanned).toBe(4);
  });

  it('returns every comment in the window when no person is given', async () => {
    const out = await toolsFor(multi).list_comments.execute({ ...day });
    expect(out.person).toBeNull();
    expect(out.comments.map((comment: { id: string }) => comment.id)).toEqual(['kb2', 'kb1', 'k2', 'k1']);
  });

  it('filters by text and by board, and honors the limit', async () => {
    const tools = toolsFor(multi);
    const byText = await tools.list_comments.execute({ text: '@ada', ...day });
    expect(byText.comments.map((comment: { id: string }) => comment.id)).toEqual(['kb1', 'k2']);

    const byBoard = await tools.list_comments.execute({ boards: ['Other team'], ...day });
    expect(byBoard.comments.map((comment: { id: string }) => comment.id)).toEqual(['kb2', 'kb1']);
    expect(byBoard.meta.boardsSearched).toEqual([{ id: 'b2', name: 'Other team' }]);

    const limited = await tools.list_comments.execute({ person: 'ada', limit: 1, ...day });
    expect(limited.comments.map((comment: { id: string }) => comment.id)).toEqual(['kb1']);
    expect(limited.meta.truncatedByLimit).toBe(true);
  });

  it('says when the newest tasks were not read (maxTasks) and when the person is not a member', async () => {
    const tools = toolsFor(multi);
    // Only the most recently commented task is read: b-2 (11:05), whose comment does not mention Ada.
    const out = await tools.list_comments.execute({ person: 'ada', maxTasks: 1, ...day });
    expect(out.comments).toEqual([]);
    expect(out.meta.tasksWithCommentEvents).toBe(4);
    expect(out.meta.tasksScanned).toBe(1);
    expect(out.meta.tasksTruncatedByMaxTasks).toBe(true);

    const stranger = await tools.list_comments.execute({ person: 'Nobody', ...day });
    expect(stranger.comments).toEqual([]);
    expect(stranger.meta.boardsWherePersonIsNotMember).toHaveLength(2);
    expect(stranger.meta.warnings.join(' ')).toContain('is not a member of any searched board');
  });

  it('needs a configured user to resolve "me"', async () => {
    await expect(
      toolsFor({ KANBANFLOW_API_KEYS: 'token-a' }).list_comments.execute({ person: 'me', ...day })
    ).rejects.toThrow('KANBANFLOW_USER');
  });
});

describe('list_time_entries', () => {
  const multi = { KANBANFLOW_API_KEYS: 'token-a,token-b', KANBANFLOW_USER: 'ada@example.com' };
  const day = { from: '2026-09-28T00:00:00Z', to: '2026-09-29T00:00:00Z' };

  it('breaks the time of the window down by entry, person and day', async () => {
    const out = await toolsFor(multi).list_time_entries.execute({ ...day });

    // Candidates come from the activity log (`totalSecondsSpent` changes): b-1 (11:50), t3 (10:07), t1 (10:04).
    expect(out.entries.map((entry: { id: string }) => entry.id)).toEqual(['te2', 'teb2', 'teb1', 'te1', 'te1', 'te4']);
    expect(out.entries[0]).toMatchObject({
      type: 'manual',
      board: { id: 'b1', name: 'Test board' },
      task: { id: 't1', name: 'Task t1', column: { name: 'Backlog' }, swimlane: { name: 'Team A' } },
      person: { id: 'u2', name: 'Grace Hopper' },
      start: '2026-09-28T12:00:00Z',
      end: '2026-09-28T13:30:00Z',
      seconds: 5400,
      hours: 1.5,
    });
    // A stopwatch split in parts: two rows sharing `entryId`, each with its own partIndex.
    expect(
      out.entries
        .filter((entry: { id: string }) => entry.id === 'te1')
        .map((entry: { partIndex: number }) => entry.partIndex)
    ).toEqual([1, 0]);
    // The running stopwatch has no end: it is returned, counted, and not given a duration.
    expect(out.entries.at(-1)).toMatchObject({
      id: 'te4',
      end: null,
      seconds: null,
      hours: null,
      person: { name: 'Grace Hopper' },
    });

    expect(out.person).toBeNull();
    expect(out.totals).toMatchObject({ entries: 6, seconds: 15300, hours: 4.25 });
    expect(out.totals.byDay).toEqual([{ date: '2026-09-28', entries: 6, seconds: 15300, hours: 4.25 }]);
    expect(out.totals.byBoard).toEqual([
      { board: { id: 'b1', name: 'Test board' }, entries: 4, seconds: 10800, hours: 3 },
      { board: { id: 'b2', name: 'Other team' }, entries: 2, seconds: 4500, hours: 1.25 },
    ]);
    expect(out.totals.byPerson).toEqual([
      {
        board: { id: 'b1', name: 'Test board' },
        person: { id: 'u1', name: 'Ada Lovelace' },
        entries: 2,
        seconds: 5400,
        hours: 1.5,
      },
      {
        board: { id: 'b1', name: 'Test board' },
        person: { id: 'u2', name: 'Grace Hopper' },
        entries: 2,
        seconds: 5400,
        hours: 1.5,
      },
      {
        board: { id: 'b2', name: 'Other team' },
        person: { id: 'u9', name: 'Ada Lovelace' },
        entries: 1,
        seconds: 2700,
        hours: 0.75,
      },
      {
        board: { id: 'b2', name: 'Other team' },
        person: {
          id: '825d35a91fa62346f8a4ad4a7210e3a9',
          name: '(user not on this board: 825d35a91fa62346f8a4ad4a7210e3a9)',
        },
        entries: 1,
        seconds: 1800,
        hours: 0.5,
      },
    ]);

    expect(out.meta.events).toEqual({ loaded: 11, complete: true, timeChanges: 3 });
    expect(out.meta.tasksWithTimeChanges).toBe(3);
    expect(out.meta.tasksScanned).toBe(3);
    expect(out.meta.entriesMatched).toBe(6);
    expect(out.meta.entriesOutsideWindow).toBe(1);
    expect(out.meta.entriesWithoutEnd).toBe(1);
    expect(out.meta.whereEntrySumDiffers).toEqual([]);
    expect(out.meta.range.windowRule).toContain('startTimestamp');
    expect(out.meta.apiRequests).toBe(18);
  });

  it('filters by person per board, where the same person has different user ids', async () => {
    const out = await toolsFor(multi).list_time_entries.execute({ person: 'me', ...day });
    expect(out.entries.map((entry: { id: string }) => entry.id)).toEqual(['teb1', 'te1', 'te1']);
    expect(out.totals.seconds).toBe(8100);
    expect(out.person).toMatchObject({
      resolved: 'ada@example.com',
      source: 'me (KANBANFLOW_USER)',
      matches: [
        { board: { id: 'b1' }, users: [{ id: 'u1', name: 'Ada Lovelace' }], matchedBy: 'email' },
        { board: { id: 'b2' }, users: [{ id: 'u9', name: 'Ada Lovelace' }], matchedBy: 'email' },
      ],
    });
    expect(out.meta.boardsWherePersonIsNotMember).toEqual([]);
  });

  it('reads explicit tasks without touching the activity log, and reports ids it could not read', async () => {
    const out = await toolsFor(multi).list_time_entries.execute({ taskIds: ['t1', 't2', 'ghost'], ...day });
    expect(api.requests.some((request) => request.includes('/board/events'))).toBe(false);
    expect(out.entries.map((entry: { id: string }) => entry.id)).toEqual(['te2', 'te1', 'te1', 'te5']);
    expect(out.meta.events).toBeNull();
    expect(out.meta.entriesWithoutUser).toBe(1);
    expect(out.entries.at(-1)).toMatchObject({ id: 'te5', person: null, seconds: 1800 });
    expect(out.meta.tasksWithErrors).toEqual([{ taskId: 'ghost', error: expect.stringContaining('HTTP 404') }]);
    expect(out.meta.tasksWithoutName).toEqual(['ghost']);
  });

  it('says what it left out: window, limit and task cap', async () => {
    const tools = toolsFor(multi);
    const capped = await tools.list_time_entries.execute({ maxTasks: 1, ...day });
    expect(capped.meta.tasksWithTimeChanges).toBe(3);
    expect(capped.meta.tasksTruncatedByMaxTasks).toBe(true);
    expect(capped.meta.howToComplete).toContain('maxTasks');
    expect(capped.meta.howEntriesAreFound).toContain('taskIds');

    const limited = await tools.list_time_entries.execute({ limit: 1, ...day });
    expect(limited.entries).toHaveLength(1);
    expect(limited.meta.truncatedByLimit).toBe(true);
    expect(limited.meta.limitNote).toContain('taskIds');
    expect(limited.meta.entriesMatched).toBe(6);

    const defaulted = await tools.list_time_entries.execute({});
    expect(defaulted.meta.range.fromDefaulted).toBe(true);
    expect(defaulted.meta.range.toDefaulted).toBe(true);
  });

  it('rejects an unusable window and needs a configured user for "me"', async () => {
    const tools = toolsFor(multi);
    await expect(tools.list_time_entries.execute({ from: 'yesterday' })).rejects.toThrow('ISO 8601');
    await expect(
      tools.list_time_entries.execute({ from: '2026-09-29T00:00:00Z', to: '2026-09-28T00:00:00Z' })
    ).rejects.toThrow('is after "to"');
    await expect(
      toolsFor({ KANBANFLOW_API_KEYS: 'token-a' }).list_time_entries.execute({ person: 'me' })
    ).rejects.toThrow('KANBANFLOW_USER');
  });
});

describe('search_tasks', () => {
  const multi = { KANBANFLOW_API_KEYS: 'token-a,token-b' };

  it('finds tasks by text across boards and says which fields matched', async () => {
    const out = await toolsFor(multi).search_tasks.execute({ query: 'task t3' });
    expect(out.tasks.map((t: { id: string }) => t.id)).toEqual(['t3']);
    expect(out.tasks[0]).toMatchObject({
      board: { id: 'b1', name: 'Test board' },
      column: { name: 'Doing' },
      matchedFields: ['name'],
    });
    expect(out.query).toEqual({ text: 'task t3', terms: ['task', 't3'], fields: ['name', 'description'] });
  });

  it('searches labels only when asked, and does not care about case', async () => {
    const tools = toolsFor(multi);
    expect((await tools.search_tasks.execute({ query: 'BUG' })).tasks).toEqual([]);
    const labels = await tools.search_tasks.execute({ query: 'BUG', fields: ['labels'] });
    expect(labels.tasks.map((t: { id: string }) => t.id)).toEqual(['t1']);
    expect(labels.tasks[0].matchedFields).toEqual(['labels']);
  });

  it('searches descriptions and needs every word (AND)', async () => {
    const tools = toolsFor(multi);
    expect((await tools.search_tasks.execute({ query: 'xxxx' })).tasks.map((t: { id: string }) => t.id)).toEqual([
      't2',
    ]);
    expect((await tools.search_tasks.execute({ query: 'task xxxx' })).tasks.map((t: { id: string }) => t.id)).toEqual([
      't2',
    ]);
    expect((await tools.search_tasks.execute({ query: 'task zzz' })).tasks).toEqual([]);
  });

  it('searches only what was loaded and reports partially loaded columns', async () => {
    const out = await toolsFor(multi).search_tasks.execute({ query: 'Task' });
    // Board A: t1, t2, t3 and only 2 of the 4 done tasks; board B: b-1, b-2.
    expect(out.tasks.map((t: { id: string }) => t.id)).toEqual(['t1', 't2', 't3', 'd1', 'd2', 'b-1', 'b-2']);
    expect(out.meta.complete).toBe(false);
    expect(out.meta.incompleteCells).toEqual([
      {
        board: { id: 'b1', name: 'Test board' },
        column: { id: 'c-done', name: 'Done' },
        swimlane: { id: 's1', name: 'Team A' },
        loadedTasks: 2,
      },
    ]);
    expect(out.meta.howToComplete).toContain('loadAllPages');
  });

  it('loads a limited column completely when it is named', async () => {
    const out = await toolsFor(multi).search_tasks.execute({ query: 'Task', columns: ['Done'] });
    expect(out.tasks.map((t: { id: string }) => t.id)).toEqual(['d1', 'd2', 'd3', 'd4']);
    expect(out.meta.complete).toBe(true);
    expect(out.meta.incompleteCells).toEqual([]);
  });

  it('can restrict the search to a person', async () => {
    const out = await toolsFor({ ...multi, KANBANFLOW_USER: 'ada@example.com' }).search_tasks.execute({
      query: 'Task',
      person: 'grace',
    });
    expect(out.tasks.map((t: { id: string }) => t.id)).toEqual(['t3']);
    expect(out.person).toMatchObject({ resolved: 'grace', source: 'argument' });
    expect(out.meta.boardsWherePersonIsNotMember).toEqual([{ id: 'b2', name: 'Other team' }]);
  });

  it('rejects a query with no words and needs a configured user for "me"', async () => {
    await expect(toolsFor(multi).search_tasks.execute({ query: '   ' })).rejects.toThrow('at least one word');
    await expect(
      toolsFor({ KANBANFLOW_API_KEYS: 'token-a' }).search_tasks.execute({ query: 'x', person: 'me' })
    ).rejects.toThrow('KANBANFLOW_USER');
  });
});
