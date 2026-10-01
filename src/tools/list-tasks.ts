import { toolDefinition } from '@tanstack/ai';
import { z } from 'zod';
import type { PersonMatch, Ref } from '../services/board-context.js';
import { INTERPRETATION_NOTE, READ_ONLY, type ToolDeps } from './deps.js';
import { collectTasks } from './task-query.js';
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

    const collected = await collectTasks(deps, {
      person,
      boards: input.boards,
      columns: input.columns,
      loadAllPages: input.loadAllPages,
    });

    const matched = collected.boards.flatMap(({ board, tasks }) => tasks.map((task) => ({ board, task })));
    const incompleteCells = collected.boards.flatMap((board) => board.incompleteCells);
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
        matches: collected.personMatches.map(({ board, match }): { board: Ref } & PersonMatch => ({
          board: board.ctx.ref,
          ...(match ?? { users: [] }),
        })),
      },
      meta: {
        fetchedAt: new Date().toISOString(),
        filters: input,
        warnings: collected.warnings,
        boardsSearched: collected.selected.map(({ ctx }) => ctx.ref),
        boardsWherePersonIsNotMember: collected.boardsWherePersonIsNotMember,
        failedBoards: collected.loaded.failures,
        complete: incompleteCells.length === 0 && collected.loaded.failures.length === 0,
        incompleteCells,
        ...(incompleteCells.length > 0 && {
          howToComplete:
            "These columns have more tasks in KanbanFlow than were loaded, so some of this person's tasks may be " +
            'missing there. Pass the column in `columns` (or loadAllPages: true) to load it completely.',
        }),
        tasksMatched: matched.length,
        tasksReturned: Math.min(matched.length, limit),
        truncatedByLimit: matched.length > limit,
        apiRequests: collected.apiRequests,
        note: INTERPRETATION_NOTE,
      },
      counts: {
        byBoard: collected.boards.map(({ board, tasks }) => ({ board: board.ctx.ref, count: tasks.length })),
        byColumn: [...byColumn.values()],
      },
      tasks: matched.slice(0, limit).map(({ board, task }) => ({
        board: board.ctx.ref,
        ...taskView(task, board.ctx, detail),
      })),
    };
  });
}
