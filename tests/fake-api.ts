import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ApiTask } from '../src/types.js';

// A fake KanbanFlow API with the response shapes observed on a real board:
// cells limited to a few tasks with `nextTaskId`, `board/events` pages with `eventsLimited`.

export const board = {
  _id: 'b1',
  name: 'Test board',
  columns: [
    { uniqueId: 'c-todo', name: 'Backlog' },
    { uniqueId: 'c-doing', name: 'Doing' },
    { uniqueId: 'c-done', name: 'Done' },
  ],
  swimlanes: [{ uniqueId: 's1', name: 'Team A', description: 'Main team' }],
  colors: [
    { value: 'red', name: 'Urgent', description: 'Before anything else' },
    { value: 'blue', name: 'Waiting on others' },
  ],
};

export const users = [
  { _id: 'u1', fullName: 'Ada Lovelace', email: 'ada@example.com' },
  { _id: 'u2', fullName: 'Grace Hopper', email: 'grace@example.com' },
];

const task = (id: string, columnId: string, extra: Partial<ApiTask> = {}): ApiTask => ({
  _id: id,
  name: `Task ${id}`,
  description: '',
  color: 'yellow',
  columnId,
  swimlaneId: 's1',
  totalSecondsSpent: 0,
  totalSecondsEstimate: 0,
  ...extra,
});

export const todoTasks = [
  task('t1', 'c-todo', { color: 'red', labels: [{ name: 'Bug' }], collaborators: [{ userId: 'u1' }] }),
  task('t2', 'c-todo', { description: 'x'.repeat(400) }),
];
export const doingTasks = [task('t3', 'c-doing', { responsibleUserId: 'u2', color: 'blue' })];
export const doneTasks = [task('d1', 'c-done'), task('d2', 'c-done'), task('d3', 'c-done'), task('d4', 'c-done')];

const DONE_PAGE = 2;

// Board B: same person (Ada) with a different user id, found by email.
export const boardB = {
  _id: 'b2',
  name: 'Other team',
  columns: [
    { uniqueId: 'x-todo', name: 'To do' },
    { uniqueId: 'x-done', name: 'Done' },
  ],
  swimlanes: [],
  colors: [],
};
export const usersB = [
  { _id: 'u9', fullName: 'Ada Lovelace', email: 'ada@example.com' },
  { _id: 'u8', fullName: 'Adam Smith', email: 'adam@example.com' },
];
export const tasksB = [
  task('b-1', 'x-todo', { swimlaneId: undefined, collaborators: [{ userId: 'u9' }] }),
  task('b-2', 'x-todo', { swimlaneId: undefined, collaborators: [{ userId: 'u8' }] }),
];

export const events = Array.from({ length: 5 }, (_, i) => ({
  _id: `e${i}`,
  userId: 'u1',
  timestamp: `2026-09-28T10:0${i}:00.000Z`,
  detailedEvents: [
    {
      eventType: 'taskChanged',
      taskId: 't1',
      changedProperties: [
        { property: 'columnId', oldValue: 'c-todo', newValue: 'c-doing' },
        { property: 'sortOrder', oldValue: 1, newValue: 2 },
        { property: 'description', oldValue: 'long old text', newValue: 'long new text' },
      ],
    },
  ],
}));
const EVENTS_PAGE = 2;

export interface FakeApi {
  url: string;
  requests: string[];
  close(): Promise<void>;
}

export async function startFakeApi(): Promise<FakeApi> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push(`${url.pathname}${url.search}`);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const q = url.searchParams;
    const token = Buffer.from((req.headers.authorization ?? '').replace('Basic ', ''), 'base64')
      .toString()
      .replace('apiToken:', '');
    if (token === 'token-bad') return send(401, { errors: [{ message: 'Unauthorized' }] });
    if (token === 'token-b') {
      if (url.pathname === '/board') return send(200, boardB);
      if (url.pathname === '/users') return send(200, usersB);
      if (url.pathname === '/tasks') return send(200, [{ columnId: 'x-todo', tasks: tasksB, tasksLimited: false }]);
      return send(404, { errors: [{ message: 'Resource not found' }] });
    }

    if (url.pathname === '/board') return send(200, board);
    if (url.pathname === '/users') return send(200, users);
    if (url.pathname === '/tasks' && q.get('columnId') === 'c-done') {
      const start = doneTasks.findIndex((t) => t._id === q.get('startTaskId'));
      const page = doneTasks.slice(start, start + DONE_PAGE);
      const next = doneTasks[start + DONE_PAGE];
      return send(200, [
        { columnId: 'c-done', swimlaneId: 's1', tasks: page, tasksLimited: Boolean(next), nextTaskId: next?._id },
      ]);
    }
    if (url.pathname === '/tasks') {
      return send(200, [
        { columnId: 'c-todo', swimlaneId: 's1', tasks: todoTasks, tasksLimited: false },
        { columnId: 'c-doing', swimlaneId: 's1', tasks: doingTasks, tasksLimited: false },
        {
          columnId: 'c-done',
          swimlaneId: 's1',
          tasks: doneTasks.slice(0, DONE_PAGE),
          tasksLimited: true,
          nextTaskId: doneTasks[DONE_PAGE]?._id,
        },
      ]);
    }
    if (url.pathname === '/tasks/t1') return send(200, todoTasks[0]);
    if (url.pathname === '/tasks/t1/comments') {
      return send(200, [
        { _id: 'k1', text: 'Looks good', authorUserId: 'u2', createdTimestamp: '2026-09-28T09:00:00Z' },
      ]);
    }
    if (url.pathname === '/board/events') {
      // Like KanbanFlow: oldest first from `from` (inclusive), at most EVENTS_PAGE per page.
      const from = q.get('from') ?? '';
      const page = events.filter((e) => e.timestamp >= from).slice(0, EVENTS_PAGE);
      const more = events.filter((e) => e.timestamp >= from).length > EVENTS_PAGE;
      return send(200, { eventsLimited: more, events: page });
    }
    return send(404, { errors: [{ message: 'Resource not found' }] });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
