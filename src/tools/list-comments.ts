import { toolDefinition } from '@tanstack/ai';
import { z } from 'zod';
import { TASK_URL } from '../services/board-context.js';
import { type LoadedBoard, selectBoards } from '../services/boards.js';
import type { ApiComment } from '../types.js';
import { INTERPRETATION_NOTE, READ_ONLY, type ToolDeps } from './deps.js';
import { taskView } from './task-view.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const DEFAULT_MAX_TASKS = 25;
const MAX_MAX_TASKS = 100;
const DEFAULT_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;
const COMMENT_EVENT = 'taskCommentCreated';

/** Comments can come without a timestamp; those are kept but counted in `meta`. */
function timestampOf(comment: ApiComment): number | undefined {
  if (!comment.createdTimestamp) return undefined;
  const parsed = Date.parse(comment.createdTimestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whole-word, case-insensitive search: "Ada" matches "@Ada" but not "Adam".
 * Boundaries are checked with Unicode letters/digits so accented names work.
 */
function containsWord(text: string, needle: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

/** The strings looked for in a comment: the full name and, when there is one, the first name. */
function needlesFor(name: string): string[] {
  const trimmed = name.trim();
  if (!trimmed) return [];
  const parts = trimmed.split(/\s+/);
  return parts.length > 1 ? [trimmed, parts[0]] : [trimmed];
}

const inputSchema = z.object({
  person: z
    .string()
    .optional()
    .describe(
      'Only comments that mention this person (user id, email, full name or part of the name). Use "me" for the ' +
        'configured user. KanbanFlow has no structured mention field, so a comment counts as a mention when its ' +
        "text contains one of the person's names on that board as a whole word (case-insensitive, so '@Ada' " +
        "matches 'Ada Lovelace'): the full name and the first name are looked for. `person.textSearched` says " +
        'which names were used. Omit it to list comments regardless of mentions.'
    ),
  text: z
    .string()
    .optional()
    .describe('Only comments whose text contains this, case-insensitive (use it for a handle or an exact phrase).'),
  boards: z
    .array(z.string())
    .optional()
    .describe('Board ids or exact names to search (see list_boards). Default: every configured board.'),
  from: z
    .string()
    .optional()
    .describe(`Start of the window, ISO 8601 UTC (default: ${DEFAULT_WINDOW_DAYS} days before "to").`),
  to: z.string().optional().describe('End of the window, ISO 8601 UTC (default: now).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Maximum comments returned, newest first (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
  maxTasks: z
    .number()
    .int()
    .min(1)
    .max(MAX_MAX_TASKS)
    .optional()
    .describe(
      `Maximum tasks whose comments are read (default ${DEFAULT_MAX_TASKS}, max ${MAX_MAX_TASKS}); the most recently commented tasks are read first. Each one costs one API request.`
    ),
});

export function createListCommentsTool(deps: ToolDeps) {
  return toolDefinition({
    name: 'list_comments',
    description:
      'Searches the comments of every configured KanbanFlow board and returns the most recent ones, newest first, ' +
      'with author, board and task (name, column, url) resolved. Comments are found through the board activity ' +
      'log (`taskCommentCreated`), so only tasks commented inside the requested window are looked at. Pass ' +
      '`person` to find comments that mention someone: KanbanFlow keeps no structured mention field, so a mention ' +
      "is the person's full name (or first name) inside the comment text, matched as a whole word and " +
      'case-insensitively (`person.textSearched` says which names were used); use `text` for a handle or exact ' +
      'phrase. The comment text is returned verbatim. `meta` ' +
      'reports the window (default: last 30 days), whether the activity log was read completely, how many tasks ' +
      'and API requests it took, and everything that was left out.',
    inputSchema,
    metadata: READ_ONLY,
  }).server(async (input) => {
    deps.boards.assertConfigured();
    const now = new Date();
    const to = input.to ?? now.toISOString();
    const from = input.from ?? new Date(now.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS).toISOString();
    const limit = input.limit ?? DEFAULT_LIMIT;
    const maxTasks = input.maxTasks ?? DEFAULT_MAX_TASKS;

    // `person` is a mention filter; "me" means the configured user.
    let personRef: string | undefined;
    if (input.person !== undefined) {
      personRef = input.person.toLowerCase() === 'me' ? deps.config.user : input.person;
      if (!personRef) {
        throw new Error(
          'No configured user to interpret "me" as. Pass a person (id, email or name; list_boards shows the ' +
            'members), or set your KanbanFlow email in the MCP settings (KANBANFLOW_USER).'
        );
      }
    }

    const loaded = await deps.boards.load();
    const { selected, warnings } = selectBoards(loaded.boards, input.boards);

    // Who the person is on each board, and which name strings to look for in the comment text.
    const matches = selected.map((board) => ({
      board,
      match: personRef ? board.ctx.findPeople(personRef) : undefined,
    }));
    const needlesByBoard = new Map<LoadedBoard, string[]>();
    for (const { board, match } of matches) {
      if (!personRef) continue;
      if (match && match.users.length > 0) {
        if (match.users.length > 1) {
          warnings.push(
            `"${personRef}" matched ${match.users.length} members on board "${board.ctx.board.name}" ` +
              `(${match.users.map((user) => user.name).join(', ')}); comments mentioning any of them are included.`
          );
        }
        const needles = [...new Set(match.users.flatMap((user) => needlesFor(user.name)))];
        needlesByBoard.set(board, needles.length > 0 ? needles : [personRef]);
      } else {
        needlesByBoard.set(board, [personRef]);
      }
    }
    const boardsWherePersonIsNotMember = personRef
      ? matches.filter(({ match }) => (match?.users.length ?? 0) === 0).map(({ board }) => board.ctx.ref)
      : [];
    if (personRef && selected.length > 0 && boardsWherePersonIsNotMember.length === selected.length) {
      warnings.push(
        `"${personRef}" is not a member of any searched board; its comments are looked for as the text "${personRef}".`
      );
    }

    const perBoardEvents = await Promise.all(
      selected.map(async (board) => ({ board, fetched: await board.client.getEvents({ from, to }) }))
    );

    // Events are oldest first, so a later comment event overwrites an earlier one for the same task.
    const candidatesByTask = new Map<string, { board: LoadedBoard; taskId: string; at: string }>();
    let commentEvents = 0;
    for (const { board, fetched } of perBoardEvents) {
      for (const event of fetched.events) {
        for (const detail of event.detailedEvents) {
          if (detail.eventType !== COMMENT_EVENT || !detail.taskId) continue;
          commentEvents++;
          candidatesByTask.set(`${board.ctx.board._id}/${detail.taskId}`, {
            board,
            taskId: detail.taskId,
            at: event.timestamp,
          });
        }
      }
    }
    const candidates = [...candidatesByTask.values()].sort((a, b) => b.at.localeCompare(a.at));
    const scanned = candidates.slice(0, maxTasks);

    // One comment request per task; a task that cannot be read is reported, not thrown away.
    const perTask = await Promise.all(
      scanned.map(async (candidate) => {
        try {
          return {
            candidate,
            comments: await candidate.board.client.getTaskComments(candidate.taskId),
            error: undefined,
          };
        } catch (error) {
          return { candidate, comments: [] as ApiComment[], error: String((error as Error)?.message ?? error) };
        }
      })
    );

    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    const textNeedle = input.text?.toLowerCase();
    const matched: { board: LoadedBoard; taskId: string; comment: ApiComment }[] = [];
    let commentsWithoutDate = 0;
    for (const { candidate, comments } of perTask) {
      const needles = needlesByBoard.get(candidate.board);
      for (const comment of comments) {
        const at = timestampOf(comment);
        if (at === undefined) commentsWithoutDate++;
        else if (at < fromMs || at > toMs) continue;
        const text = comment.text ?? '';
        if (textNeedle && !text.toLowerCase().includes(textNeedle)) continue;
        if (needles && !needles.some((needle) => containsWord(text, needle))) continue;
        matched.push({ board: candidate.board, taskId: candidate.taskId, comment });
      }
    }
    const timeOf = (comment: ApiComment) => timestampOf(comment) ?? Number.NEGATIVE_INFINITY;
    matched.sort((a, b) => timeOf(b.comment) - timeOf(a.comment) || 0);

    const keyOf = (item: { board: LoadedBoard; taskId: string }) => `${item.board.ctx.board._id}/${item.taskId}`;
    const returned = matched.slice(0, limit);
    const taskRefs = new Map<string, { board: LoadedBoard; taskId: string }>();
    for (const item of returned) taskRefs.set(keyOf(item), { board: item.board, taskId: item.taskId });

    const taskViews = new Map<string, ReturnType<typeof taskView> | null>();
    await Promise.all(
      [...taskRefs.entries()].map(async ([key, { board, taskId }]) => {
        try {
          taskViews.set(key, taskView(await board.client.getTask(taskId), board.ctx, 'summary'));
        } catch {
          taskViews.set(key, null);
        }
      })
    );

    const eventsComplete = perBoardEvents.every(({ fetched }) => fetched.complete);
    const eventsLoaded = perBoardEvents.reduce((sum, { fetched }) => sum + fetched.events.length, 0);
    const eventsRequests = perBoardEvents.reduce((sum, { fetched }) => sum + fetched.requests, 0);
    const tasksWithErrors = perTask
      .filter((task) => task.error)
      .map((task) => ({ board: task.candidate.board.ctx.ref, taskId: task.candidate.taskId, error: task.error }));

    return {
      person: personRef
        ? {
            requested: input.person,
            resolved: personRef,
            source: input.person?.toLowerCase() === 'me' ? 'me (KANBANFLOW_USER)' : 'argument',
            matches: matches.map(({ board, match }) => ({ board: board.ctx.ref, ...(match ?? { users: [] }) })),
            textSearched: [...needlesByBoard.entries()].map(([board, needles]) => ({ board: board.ctx.ref, needles })),
            note: 'KanbanFlow has no structured mention field: a comment counts as a mention when its text contains one of these names as a whole word (case-insensitive).',
          }
        : null,
      meta: {
        fetchedAt: now.toISOString(),
        range: { from, to, fromDefaulted: input.from === undefined, toDefaulted: input.to === undefined },
        filters: {
          person: input.person ?? null,
          text: input.text ?? null,
          boards: input.boards ?? null,
          limit,
          maxTasks,
        },
        warnings,
        boardsSearched: selected.map(({ ctx }) => ctx.ref),
        boardsWherePersonIsNotMember,
        failedBoards: loaded.failures,
        events: { loaded: eventsLoaded, complete: eventsComplete, commentEvents },
        ...(!eventsComplete && {
          eventsIncomplete:
            'The window had more activity than was read, so the newest comments may be missing. Narrow "from"/"to".',
        }),
        tasksWithCommentEvents: candidates.length,
        tasksScanned: scanned.length,
        tasksTruncatedByMaxTasks: candidates.length > scanned.length,
        ...(tasksWithErrors.length > 0 && { tasksWithErrors }),
        commentsMatched: matched.length,
        commentsReturned: returned.length,
        truncatedByLimit: matched.length > limit,
        commentsWithoutDate,
        apiRequests:
          (loaded.boards.length + loaded.failures.length) * 2 + eventsRequests + scanned.length + taskRefs.size,
        note: INTERPRETATION_NOTE,
      },
      comments: returned.map((item) => {
        const key = keyOf(item);
        return {
          id: item.comment._id,
          createdAt: item.comment.createdTimestamp ?? null,
          author: item.comment.authorUserId ? item.board.ctx.user(item.comment.authorUserId) : null,
          board: item.board.ctx.ref,
          task: taskViews.get(key) ?? { id: item.taskId, name: null, url: TASK_URL(item.taskId) },
          text: item.comment.text,
        };
      }),
    };
  });
}
