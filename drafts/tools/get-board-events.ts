import { toolDefinition } from '@tanstack/ai';
import { z } from 'zod';
import { type BoardContext, TASK_URL } from '../services/board-context.js';
import type { ApiEventDetail } from '../types.js';
import { READ_ONLY, type ToolDeps, loadBoardContext } from './deps.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

// In "summary", these properties keep their old/new values (ids get names).
const VALUE_PROPERTIES = new Set([
  'name',
  'columnId',
  'swimlaneId',
  'boardId',
  'color',
  'labels',
  'members',
  'responsibleUserId',
  'totalSecondsSpent',
  'totalSecondsEstimate',
  'groupingDate',
  'dates',
]);
// In "summary", these are dropped: they change on almost every drag and carry no meaning.
const NOISE_PROPERTIES = new Set(['sortOrder']);
// Any other property (description, subTasks…) is reported as changed, without the long values.

type Change = NonNullable<ApiEventDetail['changedProperties']>[number];

function valueName(property: string, value: unknown, ctx: BoardContext): unknown {
  if (typeof value === 'string') {
    if (property === 'columnId') return ctx.column(value).name;
    if (property === 'swimlaneId') return ctx.swimlane(value)?.name;
    if (property === 'color') return ctx.color(value)?.boardName ?? value;
    if (property === 'responsibleUserId') return ctx.user(value).name;
  }
  if (property === 'members' && Array.isArray(value)) {
    return value.map((member) => (typeof member === 'string' ? ctx.user(member).name : member));
  }
  return undefined;
}

function describeChange(change: Change, ctx: BoardContext, detail: 'summary' | 'full') {
  const oldName = valueName(change.property, change.oldValue, ctx);
  const newName = valueName(change.property, change.newValue, ctx);
  const names = {
    ...(oldName !== undefined && { oldValueName: oldName }),
    ...(newName !== undefined && { newValueName: newName }),
  };
  if (detail === 'full') return { ...change, ...names };
  if (!VALUE_PROPERTIES.has(change.property)) return { property: change.property, valuesOmitted: true };
  // Summary: the readable value only (the name when the id is known, otherwise the raw value).
  return {
    property: change.property,
    old: oldName ?? change.oldValue ?? null,
    new: newName ?? change.newValue ?? null,
  };
}

export function createGetBoardEventsTool(deps: ToolDeps) {
  return toolDefinition({
    name: 'get_board_events',
    description:
      'Returns the board activity log in a time range, oldest first: tasks created, moved between columns or ' +
      'swimlanes, edited, commented, etc., with user, task, column, swimlane and color names resolved. ' +
      '"summary" (default) keeps old/new values (as names) for status-like properties (column, swimlane, color, labels, ' +
      'members, time, dates), reports long text changes (description, subtasks) without their content and drops ' +
      'sortOrder changes; `meta` says exactly what was omitted. Use "full" for raw events.',
    inputSchema: z.object({
      from: z.string().optional().describe('Start, ISO 8601 UTC (e.g. 2026-09-28T00:00:00Z). At least from or to.'),
      to: z.string().optional().describe('End, ISO 8601 UTC (e.g. 2026-09-29T00:00:00Z). At least from or to.'),
      taskId: z.string().optional().describe('Only events of this task.'),
      eventTypes: z
        .array(z.string())
        .optional()
        .describe('Only these KanbanFlow event types, e.g. ["taskCreated", "taskChanged", "taskCommentCreated"].'),
      detail: z.enum(['summary', 'full']).optional().describe('"summary" (default) or "full" (raw event values).'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe(`Maximum events returned (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}), oldest first.`),
    }),
    metadata: READ_ONLY,
  }).server(async (input) => {
    if (!input.from && !input.to) throw new Error('Provide at least one of "from" or "to" (ISO 8601 UTC).');
    const detail = input.detail ?? 'summary';
    const limit = input.limit ?? DEFAULT_LIMIT;

    const [ctx, fetched, current] = await Promise.all([
      loadBoardContext(deps),
      deps.client.getEvents({ from: input.from, to: input.to }),
      deps.client.getAllTasks(),
    ]);
    // Events carry only task ids; names come from the tasks currently loaded on the board.
    const taskNames = new Map(current.cells.flatMap((cell) => cell.tasks).map((task) => [task._id, task.name]));
    const eventTypes = input.eventTypes && new Set(input.eventTypes);

    let droppedNoise = 0;
    const events = fetched.events
      .map((event) => ({
        id: event._id,
        timestamp: event.timestamp,
        user: event.userId ? ctx.user(event.userId) : null,
        changes: event.detailedEvents
          .filter((change) => !input.taskId || change.taskId === input.taskId)
          .filter((change) => !eventTypes || eventTypes.has(change.eventType))
          .map(({ changedProperties, ...change }) => {
            const kept =
              detail === 'full'
                ? changedProperties
                : changedProperties?.filter((p) => {
                    const noise = NOISE_PROPERTIES.has(p.property);
                    if (noise) droppedNoise++;
                    return !noise;
                  });
            return {
              ...change,
              ...(change.taskId && {
                taskName: taskNames.get(change.taskId) ?? null,
                taskUrl: TASK_URL(change.taskId),
              }),
              ...(kept && { changedProperties: kept.map((p) => describeChange(p, ctx, detail)) }),
            };
          })
          // A change left with nothing but dropped noise is not worth showing.
          .filter((change) => !('changedProperties' in change) || (change.changedProperties?.length ?? 0) > 0),
      }))
      .filter((event) => event.changes.length > 0);

    return {
      meta: {
        from: input.from ?? null,
        to: input.to ?? null,
        filters: { taskId: input.taskId ?? null, eventTypes: input.eventTypes ?? null },
        detail,
        complete: fetched.complete,
        ...(!fetched.complete && { howToComplete: 'The range has more events than were loaded: narrow it.' }),
        eventsLoaded: fetched.events.length,
        eventsMatched: events.length,
        eventsReturned: Math.min(events.length, limit),
        truncatedByLimit: events.length > limit,
        ...(detail === 'summary' && {
          omitted: {
            sortOrderChanges: droppedNoise,
            note: 'Long values (description, subTasks…) are marked valuesOmitted. Use detail "full" to see them.',
          },
        }),
        taskNamesNote: 'taskName is null for tasks not currently loaded on the board (e.g. old done or deleted tasks).',
        apiRequests: fetched.requests + current.requests + 2,
      },
      events: events.slice(0, limit),
    };
  });
}
