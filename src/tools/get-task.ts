import { toolDefinition } from '@tanstack/ai';
import { z } from 'zod';
import type { Ref } from '../services/board-context.js';
import type { LoadedBoard } from '../services/boards.js';
import { selectBoards } from '../services/boards.js';
import { ApiError } from '../services/kanbanflow-client.js';
import type { ApiTask } from '../types.js';
import { INTERPRETATION_NOTE, READ_ONLY, type ToolDeps } from './deps.js';
import { taskView } from './task-view.js';

// A task lives on one board, so a token that cannot see it answers 404 (or 403):
// that means "not on this board", not "error".
const NOT_THIS_BOARD = new Set([403, 404]);

export function createGetTaskTool(deps: ToolDeps) {
  return toolDefinition({
    name: 'get_task',
    description:
      'Returns one KanbanFlow task in full: complete description, board, column, swimlane and color (with the ' +
      'meaning the team gave them), labels, responsible user, collaborators, time tracking, subtasks, custom fields ' +
      '(the raw API object) and, by default, its comments with author names and dates (read the comment text to ' +
      'find mentions; comment text is returned as written, not interpreted). Give a task id from list_tasks. A task ' +
      'is on exactly one board, so `board` chooses where to look and, without it, every configured board is tried ' +
      'until the task is found; the response says which board had it.',
    inputSchema: z.object({
      taskId: z.string().min(1).describe('Task id (from list_tasks, or the last part of a kanbanflow.com/t/… URL).'),
      board: z
        .string()
        .optional()
        .describe('Board id or exact name the task is on (see list_boards). Default: try every configured board.'),
      includeComments: z
        .boolean()
        .optional()
        .describe('Fetch the task comments (default true; costs one extra API request).'),
    }),
    metadata: READ_ONLY,
  }).server(async (input) => {
    deps.boards.assertConfigured();
    const { boards, failures } = await deps.boards.load();
    const { selected, warnings } = selectBoards(boards, input.board ? [input.board] : undefined);
    if (selected.length === 0) {
      throw new Error(`${warnings.join(' ')} Use list_boards to see the configured boards.`);
    }

    // Boards that answered 404/403 for the task, in the order they were tried.
    const withoutTheTask: { board: Ref; status: number }[] = [];
    let found: { board: LoadedBoard; task: ApiTask } | undefined;
    for (const board of selected) {
      try {
        found = { board, task: await board.client.getTask(input.taskId) };
        break;
      } catch (error) {
        if (error instanceof ApiError && error.status && NOT_THIS_BOARD.has(error.status)) {
          withoutTheTask.push({ board: board.ctx.ref, status: error.status });
          continue;
        }
        throw error;
      }
    }

    if (!found) {
      const where = input.board ? `board "${input.board}"` : `any of the ${selected.length} searched board(s)`;
      const detail = withoutTheTask.map((t) => `- ${t.board.name}: HTTP ${t.status}`).join('\n');
      const unreachable = failures.map((f) => `token #${f.token}: ${f.error}`).join('; ');
      throw new Error(
        `Task "${input.taskId}" is not on ${where}.\n${detail}${
          unreachable ? `\nBoards that could not be loaded (the task may be on one): ${unreachable}` : ''
        }\nCheck the id: list_tasks returns the ids.`
      );
    }

    const { board, task } = found;
    const includeComments = input.includeComments ?? true;
    const comments = includeComments ? await board.client.getTaskComments(input.taskId) : undefined;

    return {
      task: { board: board.ctx.ref, ...taskView(task, board.ctx, 'full') },
      comments:
        comments?.map((comment) => ({
          id: comment._id,
          author: comment.authorUserId ? board.ctx.user(comment.authorUserId) : null,
          createdAt: comment.createdTimestamp ?? null,
          text: comment.text,
        })) ?? null,
      meta: {
        fetchedAt: new Date().toISOString(),
        warnings,
        boardsSearched: selected.map(({ ctx }) => ctx.ref),
        boardsWithoutTheTask: withoutTheTask.length > 0 ? withoutTheTask : undefined,
        failedBoards: failures,
        apiRequests: (boards.length + failures.length) * 2 + withoutTheTask.length + 1 + (includeComments ? 1 : 0),
        note: INTERPRETATION_NOTE,
      },
    };
  });
}
