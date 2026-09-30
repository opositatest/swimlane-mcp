import { type BoardContext, TASK_URL, secondsToHours } from '../services/board-context.js';
import type { ApiTask } from '../types.js';

const DESCRIPTION_PREVIEW_CHARS = 150;

export type Detail = 'summary' | 'full';

/**
 * A task as the model sees it: the API fields with ids resolved to names.
 * `summary` trims the description (and says so); `full` also includes the raw API object.
 */
export function taskView(task: ApiTask, ctx: BoardContext, detail: Detail) {
  const description = task.description ?? '';
  const truncated = detail === 'summary' && description.length > DESCRIPTION_PREVIEW_CHARS;
  const { responsible, collaborators } = ctx.people(task);
  const subTasks = task.subTasks ?? [];

  return {
    id: task._id,
    name: task.name,
    url: TASK_URL(task._id),
    column: ctx.column(task.columnId),
    swimlane: ctx.swimlane(task.swimlaneId) ?? null,
    color: ctx.color(task.color) ?? null,
    labels: (task.labels ?? []).map((label) => label.name),
    responsible: responsible ?? null,
    collaborators,
    timeEstimateHours: secondsToHours(task.totalSecondsEstimate),
    timeSpentHours: secondsToHours(task.totalSecondsSpent),
    subTasks:
      subTasks.length > 0 ? { total: subTasks.length, finished: subTasks.filter((s) => s.finished).length } : null,
    groupingDate: typeof task.groupingDate === 'string' ? task.groupingDate : null,
    description: truncated ? `${description.slice(0, DESCRIPTION_PREVIEW_CHARS)}…` : description,
    descriptionTruncated: truncated,
    ...(detail === 'full' ? { raw: task } : {}),
  };
}
