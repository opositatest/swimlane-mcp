import { toolDefinition } from '@tanstack/ai';
import { z } from 'zod';
import type { BoardContext, PersonMatch, Ref } from '../services/board-context.js';
import { type LoadedBoard, selectBoards } from '../services/boards.js';
import { INTERPRETATION_NOTE, READ_ONLY, type ToolDeps } from './deps.js';
import { taskView } from './task-view.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const inputSchema = z.object({
  person: z
    .string()
    .optional()
    .describe(
      'Whose tasks: user id, email, full name or part of the name. Omit it (or use "me") for the configured user ' +
        '(KANBANFLOW_USER). A task matches when the person is its responsible user or a collaborator.'
    ),
  boards: z
    .array(z.string())
    .optional()
    .describe('Board ids or exact names to search (see list_boards). Default: every configured board.'),
  columns: z
    .array(z.string())
    .optional()
    .describe(
      'Column ids or exact names (case-insensitive), on any of the boards. Default: every column. Limited ' +
        'columns listed here (usually "done") are loaded completely.'
    ),
  loadAllPages: z
    .boolean()
    .optional()
    .describe('Load every limited column completely, not only those in `columns` (slow on big boards).'),
  detail: z
    .enum(['summary', 'full'])
    .optional()
    .describe('"summary" (default) trims descriptions. "full" adds the complete description and the raw API object.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Maximum tasks returned (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}). Counts always cover every match.`),
});

function columnIds(ctx: BoardContext, wanted: string[] | undefined): Set<string> | undefined {
  if (!wanted) return undefined;
  const lower = wanted.map((value) => value.toLowerCase());
  return new Set(
    ctx.board.columns
      .filter((column) => wanted.includes(column.uniqueId) || lower.includes(column.name.toLowerCase()))
      .map((column) => column.uniqueId)
  );
}

export function createListTasksTool(deps: ToolDeps) {
  return toolDefinition({
    name: 'list_tasks',
    description:
      'Lists the tasks of one person across every configured KanbanFlow board (or the boards you choose), ' +
      'optionally only in some columns. By default the person is the configured user ("me"). Returns how the ' +
      'person was matched on each board, the tasks with board, column, swimlane, color, labels and people resolved ' +
      'to names, counts per board and column, and a `meta` block that reports boards where the person is not a ' +
      'member, filters that matched nothing and columns that were only partially loaded. The server does not ' +
      'rank or classify tasks.',
    inputSchema,
    metadata: READ_ONLY,
  }).server(async (input) => {
    deps.boards.assertConfigured();
    const requested = input.person && input.person.toLowerCase() !== 'me' ? input.person : undefined;
    const person = requested ?? deps.config.user;
    if (!person) {
      throw new Error(
        'No person given and "me" is not configured. Ask the user who they are and pass `person` ' +
          '(list_boards shows the members), or have them add their KanbanFlow email in the settings ' +
          '(Claude Desktop: Settings > Extensions > Swimlane for KanbanFlow > Configure; other clients: KANBANFLOW_USER).'
      );
    }

    const loaded = await deps.boards.load();
    const { selected, warnings } = selectBoards(loaded.boards, input.boards);

    // Who the person is on each board, matched on every board separately.
    const matches = selected.map((board) => ({ board, match: board.ctx.findPeople(person) }));
    for (const { board, match } of matches) {
      if (match.users.length > 1) {
        warnings.push(
          `"${person}" matched ${match.users.length} members on board "${board.ctx.board.name}" ` +
            `(${match.users.map((u) => u.name).join(', ')}); tasks of all of them are included. Be more specific if needed.`
        );
      }
    }
    const withPerson = matches.filter(({ match }) => match.users.length > 0);
    if (withPerson.length === 0) warnings.push(`"${person}" is not a member of any searched board.`);

    // Columns are resolved per board; warn only when a column exists on none of them.
    const perBoardColumns = new Map<LoadedBoard, Set<string> | undefined>();
    for (const { board } of withPerson) perBoardColumns.set(board, columnIds(board.ctx, input.columns));
    for (const column of input.columns ?? []) {
      const exists = withPerson.some(({ board }) => (columnIds(board.ctx, [column])?.size ?? 0) > 0);
      if (!exists && withPerson.length > 0) warnings.push(`Column "${column}" exists on none of the searched boards.`);
    }

    const results = await Promise.all(
      withPerson.map(async ({ board, match }) => {
        const wantedColumns = perBoardColumns.get(board);
        const fetched = await board.client.getAllTasks({
          expandColumnIds: input.loadAllPages ? 'all' : wantedColumns,
        });
        const ids = new Set(match.users.map((u) => u.id));
        const cells = fetched.cells.filter((cell) => !wantedColumns || wantedColumns.has(cell.columnId));
        const tasks = cells
          .flatMap((cell) => cell.tasks)
          .filter((task) => [...board.ctx.peopleIds(task)].some((id) => ids.has(id)))
          .sort((a, b) => board.ctx.columnIndex(a.columnId) - board.ctx.columnIndex(b.columnId));
        const incompleteCells = cells
          .filter((cell) => !cell.complete)
          .map((cell) => ({
            board: board.ctx.ref,
            column: board.ctx.column(cell.columnId),
            swimlane: board.ctx.swimlane(cell.swimlaneId) ?? null,
            loadedTasks: cell.tasks.length,
          }));
        return { board, tasks, incompleteCells, requests: fetched.requests };
      })
    );

    const matched = results.flatMap(({ board, tasks }) => tasks.map((task) => ({ board, task })));
    const incompleteCells = results.flatMap((r) => r.incompleteCells);
    const limit = input.limit ?? DEFAULT_LIMIT;
    const detail = input.detail ?? 'summary';

    const byColumn = new Map<string, { board: Ref; column: Ref; count: number }>();
    for (const { board, task } of matched) {
      const key = `${board.ctx.board._id}/${task.columnId}`;
      const entry = byColumn.get(key) ?? { board: board.ctx.ref, column: board.ctx.column(task.columnId), count: 0 };
      entry.count++;
      byColumn.set(key, entry);
    }

    return {
      person: {
        requested: person,
        source: requested ? 'argument' : 'KANBANFLOW_USER',
        matches: matches.map(({ board, match }): { board: Ref } & PersonMatch => ({ board: board.ctx.ref, ...match })),
      },
      meta: {
        fetchedAt: new Date().toISOString(),
        filters: input,
        warnings,
        boardsSearched: selected.map(({ ctx }) => ctx.ref),
        boardsWherePersonIsNotMember: matches
          .filter(({ match }) => match.users.length === 0)
          .map(({ board }) => board.ctx.ref),
        failedBoards: loaded.failures,
        complete: incompleteCells.length === 0 && loaded.failures.length === 0,
        incompleteCells,
        ...(incompleteCells.length > 0 && {
          howToComplete:
            "These columns have more tasks in KanbanFlow than were loaded, so some of this person's tasks may be " +
            'missing there. Pass the column in `columns` (or loadAllPages: true) to load it completely.',
        }),
        tasksMatched: matched.length,
        tasksReturned: Math.min(matched.length, limit),
        truncatedByLimit: matched.length > limit,
        apiRequests: loaded.boards.length * 2 + results.reduce((sum, r) => sum + 1 + r.requests, 0),
        note: INTERPRETATION_NOTE,
      },
      counts: {
        byBoard: results.map(({ board, tasks }) => ({ board: board.ctx.ref, count: tasks.length })),
        byColumn: [...byColumn.values()],
      },
      tasks: matched.slice(0, limit).map(({ board, task }) => ({
        board: board.ctx.ref,
        ...taskView(task, board.ctx, detail),
      })),
    };
  });
}
