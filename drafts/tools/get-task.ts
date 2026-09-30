import { toolDefinition } from '@tanstack/ai';
import { z } from 'zod';
import { READ_ONLY, type ToolDeps, loadBoardContext } from './deps.js';
import { taskView } from './task-view.js';

export function createGetTaskTool(deps: ToolDeps) {
  return toolDefinition({
    name: 'get_task',
    description:
      'Returns one KanbanFlow task in full: complete description, people, labels, color (with the board meaning), ' +
      'time tracking, subtasks, custom fields, the raw API object and, by default, its comments with author names.',
    inputSchema: z.object({
      taskId: z.string().min(1).describe('Task id (from list_tasks, or the last part of a kanbanflow.com/t/… URL).'),
      includeComments: z.boolean().optional().describe('Include the task comments (default true).'),
    }),
    metadata: READ_ONLY,
  }).server(async ({ taskId, includeComments = true }) => {
    // The task first, so an unknown id is reported as such and not as a comments error.
    const [ctx, task] = await Promise.all([loadBoardContext(deps), deps.client.getTask(taskId)]);
    const comments = includeComments ? await deps.client.getTaskComments(taskId) : undefined;

    return {
      task: taskView(task, ctx, 'full'),
      comments:
        comments?.map((comment) => ({
          id: comment._id,
          author: comment.authorUserId ? ctx.user(comment.authorUserId) : null,
          createdAt: comment.createdTimestamp ?? null,
          text: comment.text,
        })) ?? null,
    };
  });
}
