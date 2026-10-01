import { toolDefinition } from '@tanstack/ai';
import { z } from 'zod';
import type { PersonMatch, Ref } from '../services/board-context.js';
import type { ApiTask } from '../types.js';
import { INTERPRETATION_NOTE, READ_ONLY, type ToolDeps } from './deps.js';
import { collectTasks } from './task-query.js';
import { taskView } from './task-view.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const FIELDS = ['name', 'description', 'labels', 'customFields', 'subTasks'] as const;
type Field = (typeof FIELDS)[number];

/** The text of one task field, to be searched case-insensitively. */
function fieldText(task: ApiTask, field: Field): string {
  if (field === 'name') return task.name ?? '';
  if (field === 'description') return task.description ?? '';
  if (field === 'labels') return (task.labels ?? []).map((label) => label.name).join(' ');
  if (field === 'subTasks') return (task.subTasks ?? []).map((subTask) => subTask.name).join(' ');
  // Custom fields are not typed: they carry `{ customFieldId, value }` and names are not always available.
  if (!Array.isArray(task.customFields)) return '';
  return task.customFields
    .map((entry) => (entry as { value?: unknown })?.value)
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value))
    .join(' ');
}

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'Text to find in the tasks, case-insensitive and as a substring. It is split into words; by default every ' +
        'word has to appear somewhere in the searched fields (AND).'
    ),
  fields: z
    .array(z.enum(FIELDS))
    .nonempty()
    .optional()
    .describe(
      'Where to look (default ["name", "description"]). "labels" searches the label names, "customFields" the ' +
        'custom field values (names are not in the API) and "subTasks" the subtask names.'
    ),
  person: z
    .string()
    .optional()
    .describe(
      'Only tasks of this person (responsible user or any collaborator): id, email, full name or part of the ' +
        'name. "me" uses the configured user. Default: everybody.'
    ),
  boards: z
    .array(z.string())
    .optional()
    .describe('Board ids or exact names to search (see list_boards). Default: every configured board.'),
  columns: z
    .array(z.string())
    .optional()
    .describe(
      'Column ids or exact names (case-insensitive). Default: every column. Limited columns listed here ' +
        '(usually "done") are loaded completely.'
    ),
  loadAllPages: z.boolean().optional().describe('Load every limited column completely (slow on big boards).'),
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

export function createSearchTasksTool(deps: ToolDeps) {
  return toolDefinition({
    name: 'search_tasks',
    description:
      'Finds tasks whose text contains a query, across every configured KanbanFlow board and column (or the ' +
      'boards and columns you choose). The query is split into words and, by default, all of them must appear ' +
      'somewhere in the fields you pick (`fields`, default name and description; labels, custom field values and ' +
      'subtask names are available too). Each task says in `matchedFields` which fields contained part of the ' +
      'query. KanbanFlow has no search endpoint, so tasks are loaded and filtered here: the counts cover only ' +
      'what was loaded, and `meta` reports failed boards and columns that came partially loaded (typically "done") ' +
      'with how to load them completely. Read-only. To search comments or mentions, use list_comments instead.',
    inputSchema,
    metadata: READ_ONLY,
  }).server(async (input) => {
    deps.boards.assertConfigured();
    const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) throw new Error('The query needs at least one word to search for.');

    // `person` is optional here: without it every task is searched. "me" means the configured user.
    const requested = input.person && input.person.toLowerCase() !== 'me' ? input.person : undefined;
    const person = input.person !== undefined ? (requested ?? deps.config.user) : undefined;
    if (input.person !== undefined && !person) {
      throw new Error(
        'No configured user to interpret "me" as. Pass a person (id, email or name; list_boards shows the ' +
          'members), or set your KanbanFlow email in the MCP settings (KANBANFLOW_USER).'
      );
    }

    const collected = await collectTasks(deps, {
      person,
      boards: input.boards,
      columns: input.columns,
      loadAllPages: input.loadAllPages,
    });
    const fields = input.fields ?? ['name', 'description'];
    const limit = input.limit ?? DEFAULT_LIMIT;
    const detail = input.detail ?? 'summary';

    const matches = collected.boards.flatMap(({ board, tasks }) =>
      tasks.flatMap((task) => {
        const perField = fields.map((field) => ({ field, text: fieldText(task, field).toLowerCase() }));
        const combined = perField.map((entry) => entry.text).join('\n');
        if (!terms.every((term) => combined.includes(term))) return [];
        return [
          {
            board,
            task,
            matchedFields: perField
              .filter((entry) => terms.some((term) => entry.text.includes(term)))
              .map((entry) => entry.field),
          },
        ];
      })
    );
    const incompleteCells = collected.boards.flatMap((board) => board.incompleteCells);

    return {
      query: { text: input.query, terms, fields },
      person: person
        ? {
            requested: input.person,
            resolved: person,
            source: requested ? 'argument' : 'KANBANFLOW_USER',
            matches: collected.personMatches.map(({ board, match }): { board: Ref } & PersonMatch => ({
              board: board.ctx.ref,
              ...(match ?? { users: [] }),
            })),
          }
        : null,
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
            'These columns have more tasks in KanbanFlow than were loaded, so matches may be missing there. Pass ' +
            'the column in `columns` (or loadAllPages: true) to load it completely.',
        }),
        tasksMatched: matches.length,
        tasksReturned: Math.min(matches.length, limit),
        truncatedByLimit: matches.length > limit,
        apiRequests: collected.apiRequests,
        note: INTERPRETATION_NOTE,
      },
      tasks: matches.slice(0, limit).map(({ board, task, matchedFields }) => ({
        board: board.ctx.ref,
        ...taskView(task, board.ctx, detail),
        matchedFields,
      })),
    };
  });
}
