import { toolDefinition } from '@tanstack/ai';
import { z } from 'zod';
import { type Ref, secondsToHours, TASK_URL } from '../services/board-context.js';
import { type LoadedBoard, selectBoards } from '../services/boards.js';
import { ApiError } from '../services/kanbanflow-client.js';
import type { ApiTask, ApiTimeEntry } from '../types.js';
import { INTERPRETATION_NOTE, READ_ONLY, type ToolDeps } from './deps.js';

const DEFAULT_WINDOW_DAYS = 2;
const DAY_MS = 86_400_000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_MAX_TASKS = 50;
const MAX_MAX_TASKS = 100;
// A task lives on one board, so the other tokens answer 404 (or 403): "not on this board", not "error".
const NOT_THIS_BOARD = new Set([403, 404]);
// The property KanbanFlow changes in `taskChanged` when time is tracked, used to find the tasks of a window.
const TIME_PROPERTY = 'totalSecondsSpent';
// The activity log answers 100 events per request, oldest first. Time windows are short, so this tool can afford
// paging further than the comment search (which caps at 10) before declaring the range partial.
const MAX_EVENT_PAGES = 25;

/**
 * Duration of an entry in seconds, or null when the stopwatch is still running or the dates are unusable.
 * A stopwatch entry split in parts is several rows with the same `entryId`; each part is added on its own.
 */
function entrySeconds(entry: ApiTimeEntry): number | null {
  const start = entry.startTimestamp ? Date.parse(entry.startTimestamp) : Number.NaN;
  const end = entry.endTimestamp ? Date.parse(entry.endTimestamp) : Number.NaN;
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}

const startMs = (entry: ApiTimeEntry) => (entry.startTimestamp ? Date.parse(entry.startTimestamp) : Number.NaN);

/** A task to read time entries from; `board` is unset when an explicit id was not found in the task index. */
interface Candidate {
  board?: LoadedBoard;
  taskId: string;
  /** Timestamp of the change that made it a candidate, newest first in the events path. */
  at?: string;
}

const inputSchema = z.object({
  from: z
    .string()
    .optional()
    .describe(
      `Start of the window, ISO 8601 UTC (default: ${DEFAULT_WINDOW_DAYS} days before "to", which covers a local ` +
        '"today" in any time zone). The server does not decide what "today" or "this week" is: pass the window the ' +
        'user means, in their time zone. An entry is included when its start falls inside the window.'
    ),
  to: z.string().optional().describe('End of the window, ISO 8601 UTC (default: now).'),
  person: z
    .string()
    .optional()
    .describe(
      'Only entries tracked by this person (user id, email, full name or part of the name). Use "me" for the ' +
        'configured user. Entries are attributed by the `userId` KanbanFlow records on each entry, which may be an ' +
        'integration id that is not a board member (then it is returned without a name). Omit it for everybody.'
    ),
  boards: z
    .array(z.string())
    .optional()
    .describe('Board ids or exact names to search (see list_boards). Default: every configured board.'),
  taskIds: z
    .array(z.string())
    .optional()
    .describe(
      'Read only these tasks (ids from list_tasks, search_tasks or get_task) instead of scanning the activity log ' +
        'for the window. Cheaper and exact when you already know the tasks; also the way to reach entries older ' +
        'than the activity log keeps.'
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(
      `Maximum entries returned, newest first (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}). Totals always cover every match.`
    ),
  maxTasks: z
    .number()
    .int()
    .min(1)
    .max(MAX_MAX_TASKS)
    .optional()
    .describe(
      `Maximum tasks whose time entries are read (default ${DEFAULT_MAX_TASKS}, max ${MAX_MAX_TASKS}), most ` +
        'recently changed first. Each task costs one API request.'
    ),
});

export function createListTimeEntriesTool(deps: ToolDeps) {
  return toolDefinition({
    name: 'list_time_entries',
    description:
      'Returns the time entries of KanbanFlow boards: every tracked interval with who tracked it, when it started ' +
      'and ended, how long it lasted and on which task. This is the only tool that breaks time down by day and by ' +
      'person; `timeSpentHours` in the other tools is the accumulated total of a task. Entries are found through ' +
      'the board activity log (`totalSecondsSpent` changes) unless you pass `taskIds`, and then read task by task. ' +
      'Totals are sums of entry durations, reported per person/board and per UTC day; two people working on the ' +
      'same task at the same time add up twice, so they are not elapsed time. `meta` reports the window, whether ' +
      'the activity log was read completely, entries that fell outside the window or have no end, and every API ' +
      'request made. The server does not interpret the board.',
    inputSchema,
    metadata: READ_ONLY,
  }).server(async (input) => {
    deps.boards.assertConfigured();
    const now = new Date();
    const to = input.to ?? now.toISOString();
    const from = input.from ?? new Date(now.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS).toISOString();
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
      throw new Error(
        `"from" and "to" must be ISO 8601 dates with a time zone (for example 2026-10-01T00:00:00Z; for a local ` +
          `day use its UTC equivalent). Received from="${from}", to="${to}".`
      );
    }
    if (fromMs > toMs) throw new Error(`"from" (${from}) is after "to" (${to}).`);

    // `person` filters the entries by the user KanbanFlow recorded on them; "me" means the configured user.
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

    const personMatches = selected.map((board) => ({
      board,
      match: personRef ? board.ctx.findPeople(personRef) : undefined,
    }));
    const personIdsByBoard = new Map<LoadedBoard, Set<string>>();
    for (const { board, match } of personMatches) {
      if (!personRef) continue;
      const users = match?.users ?? [];
      if (users.length > 1) {
        warnings.push(
          `"${personRef}" matched ${users.length} members on board "${board.ctx.board.name}" ` +
            `(${users.map((user) => user.name).join(', ')}); entries of all of them are included.`
        );
      }
      personIdsByBoard.set(board, new Set(users.map((user) => user.id)));
    }
    const boardsWherePersonIsNotMember = personRef
      ? personMatches.filter(({ match }) => (match?.users.length ?? 0) === 0).map(({ board }) => board.ctx.ref)
      : [];
    if (personRef && selected.length > 0 && boardsWherePersonIsNotMember.length === selected.length) {
      warnings.push(`"${personRef}" is not a member of any searched board; no entry can be attributed to them.`);
    }

    // One `/tasks` request per board gives the task names of the entries (and the owner of an explicit id).
    // Limited cells stay limited, so a task inside one may have no name here; that is reported, not hidden.
    const perBoardIndex = await Promise.all(
      selected.map(async (board) => {
        const fetched = await board.client.getAllTasks();
        const index = new Map<string, ApiTask>();
        for (const cell of fetched.cells) {
          for (const task of cell.tasks) index.set(task._id, task);
        }
        return {
          board,
          index,
          incompleteCells: fetched.cells.filter((cell) => !cell.complete).length,
          requests: fetched.requests,
        };
      })
    );
    const indexByBoard = new Map(perBoardIndex.map((entry) => [entry.board, entry.index] as const));

    const explicitTaskIds = [...new Set(input.taskIds ?? [])];
    const candidates: Candidate[] = [];
    let eventsMeta: { loaded: number; complete: boolean; timeChanges: number } | null = null;
    let eventsRequests = 0;

    if (explicitTaskIds.length > 0) {
      for (const taskId of explicitTaskIds) {
        const owners = selected.filter((board) => indexByBoard.get(board)?.has(taskId));
        // An id inside a limited cell is not in the index, so the owner is found by asking board by board.
        candidates.push(owners.length === 1 ? { board: owners[0], taskId } : { taskId });
      }
    } else {
      // The activity log is the only way to find the tasks of a window; a time change is a `totalSecondsSpent` change.
      const perBoardEvents = await Promise.all(
        selected.map(async (board) => ({
          board,
          fetched: await board.client.getEvents({ from, to, maxPages: MAX_EVENT_PAGES }),
        }))
      );
      const seen = new Set<string>();
      let timeChanges = 0;
      for (const { board, fetched } of perBoardEvents) {
        for (const event of fetched.events) {
          for (const detail of event.detailedEvents) {
            if (!detail.taskId) continue;
            if (!(detail.changedProperties ?? []).some((property) => property.property === TIME_PROPERTY)) continue;
            timeChanges++;
            const key = `${board.ctx.board._id}/${detail.taskId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            candidates.push({ board, taskId: detail.taskId, at: event.timestamp });
          }
        }
      }
      candidates.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
      eventsMeta = {
        loaded: perBoardEvents.reduce((sum, entry) => sum + entry.fetched.events.length, 0),
        complete: perBoardEvents.every((entry) => entry.fetched.complete),
        timeChanges,
      };
      eventsRequests = perBoardEvents.reduce((sum, entry) => sum + entry.fetched.requests, 0);
    }

    const maxTasks = input.maxTasks ?? DEFAULT_MAX_TASKS;
    const scanned = candidates.slice(0, maxTasks);

    // One request per task; a task that cannot be read is reported, not thrown away.
    let entryRequests = 0;
    const perTask = await Promise.all(
      scanned.map(
        async (
          candidate
        ): Promise<{ candidate: Candidate; board?: LoadedBoard; entries: ApiTimeEntry[]; error?: string }> => {
          try {
            if (candidate.board) {
              const entries = await candidate.board.client.getTaskTimeEntries(candidate.taskId);
              entryRequests++;
              return { candidate, board: candidate.board, entries };
            }
            let lastError: unknown;
            for (const board of selected) {
              try {
                const entries = await board.client.getTaskTimeEntries(candidate.taskId);
                entryRequests++;
                return { candidate, board, entries };
              } catch (error) {
                if (error instanceof ApiError && error.status && NOT_THIS_BOARD.has(error.status)) {
                  entryRequests++;
                  lastError = error;
                  continue;
                }
                throw error;
              }
            }
            throw lastError ?? new Error(`Task "${candidate.taskId}" is not on any searched board.`);
          } catch (error) {
            return { candidate, entries: [], error: String((error as Error)?.message ?? error) };
          }
        }
      )
    );

    const matched: { board: LoadedBoard; taskId: string; entry: ApiTimeEntry }[] = [];
    let entriesOutsideWindow = 0;
    let entriesWithoutDate = 0;
    let entriesWithoutEnd = 0;
    let entriesWithoutUser = 0;
    const whereEntrySumDiffers: {
      board: Ref | null;
      taskId: string;
      entriesSeconds: number;
      taskTotalSeconds: number;
    }[] = [];

    for (const { candidate, board, entries } of perTask) {
      if (!board) continue;
      const personIds = personIdsByBoard.get(board);
      let allSeconds = 0;
      let complete = true;
      for (const entry of entries) {
        const seconds = entrySeconds(entry);
        if (seconds === null) complete = false;
        else allSeconds += seconds;
        if (seconds === null || !entry.endTimestamp) entriesWithoutEnd++;
        if (!entry.userId) entriesWithoutUser++;
        const at = startMs(entry);
        if (Number.isNaN(at)) {
          entriesWithoutDate++;
          continue;
        }
        if (at < fromMs || at > toMs) {
          entriesOutsideWindow++;
          continue;
        }
        if (personRef && (!entry.userId || !personIds?.has(entry.userId))) continue;
        matched.push({ board, taskId: candidate.taskId, entry });
      }
      // The sum of every entry of the task can be compared with its accumulated total: a difference means
      // something was not returned, which must reach the model instead of being averaged away.
      const taskTotal = indexByBoard.get(board)?.get(candidate.taskId)?.totalSecondsSpent;
      if (complete && typeof taskTotal === 'number' && taskTotal !== allSeconds) {
        whereEntrySumDiffers.push({
          board: board.ctx.ref,
          taskId: candidate.taskId,
          entriesSeconds: allSeconds,
          taskTotalSeconds: taskTotal,
        });
      }
    }

    matched.sort((a, b) => startMs(b.entry) - startMs(a.entry));

    const round2 = (seconds: number) => Math.round((seconds / 3600) * 100) / 100;
    const byPerson: { board: Ref; person: Ref; entries: number; seconds: number; hours: number }[] = [];
    const byDay = new Map<string, { date: string; entries: number; seconds: number; hours: number }>();
    const byBoard = new Map<string, { board: Ref; entries: number; seconds: number; hours: number }>();
    const personBuckets = new Map<string, (typeof byPerson)[number]>();
    let totalSeconds = 0;
    let entriesWithoutDuration = 0;

    for (const { board, entry } of matched) {
      const seconds = entrySeconds(entry);
      if (seconds === null) entriesWithoutDuration++;
      totalSeconds += seconds ?? 0;

      const boardRef = board.ctx.ref;
      const boardBucket = byBoard.get(boardRef.id) ?? { board: boardRef, entries: 0, seconds: 0, hours: 0 };
      boardBucket.entries++;
      boardBucket.seconds += seconds ?? 0;
      byBoard.set(boardRef.id, boardBucket);

      const at = startMs(entry);
      const date = new Date(at).toISOString().slice(0, 10);
      const dayBucket = byDay.get(date) ?? { date, entries: 0, seconds: 0, hours: 0 };
      dayBucket.entries++;
      dayBucket.seconds += seconds ?? 0;
      byDay.set(date, dayBucket);

      if (entry.userId) {
        const key = `${boardRef.id}/${entry.userId}`;
        const bucket = personBuckets.get(key) ?? {
          board: boardRef,
          person: board.ctx.user(entry.userId),
          entries: 0,
          seconds: 0,
          hours: 0,
        };
        bucket.entries++;
        bucket.seconds += seconds ?? 0;
        personBuckets.set(key, bucket);
      }
    }
    for (const bucket of byBoard.values()) bucket.hours = round2(bucket.seconds);
    for (const bucket of byDay.values()) bucket.hours = round2(bucket.seconds);
    for (const bucket of personBuckets.values()) {
      bucket.hours = round2(bucket.seconds);
      byPerson.push(bucket);
    }
    byPerson.sort((a, b) => b.seconds - a.seconds || a.person.name.localeCompare(b.person.name));

    const limit = input.limit ?? DEFAULT_LIMIT;
    const returned = matched.slice(0, limit);
    const taskRef = (board: LoadedBoard | undefined, taskId: string) => {
      const task = board ? indexByBoard.get(board)?.get(taskId) : undefined;
      if (!task || !board) return { id: taskId, name: null, url: TASK_URL(taskId), column: null, swimlane: null };
      return {
        id: taskId,
        name: task.name,
        url: TASK_URL(taskId),
        column: board.ctx.column(task.columnId),
        swimlane: board.ctx.swimlane(task.swimlaneId) ?? null,
      };
    };

    const tasksWithoutName = scanned
      .filter((candidate) => !(candidate.board && indexByBoard.get(candidate.board)?.has(candidate.taskId)))
      .map((candidate) => candidate.taskId);
    const tasksWithErrors = perTask
      .filter((task) => task.error && !task.board)
      .map((task) => ({ taskId: task.candidate.taskId, error: task.error }));
    const eventsComplete = eventsMeta?.complete ?? true;

    return {
      person: personRef
        ? {
            requested: input.person,
            resolved: personRef,
            source: input.person?.toLowerCase() === 'me' ? 'me (KANBANFLOW_USER)' : 'argument',
            matches: personMatches.map(({ board, match }) => ({ board: board.ctx.ref, ...(match ?? { users: [] }) })),
            note: 'Entries are attributed by the `userId` KanbanFlow stores on each time entry, which is not always a board member (integrations answer with an id that has no name).',
          }
        : null,
      meta: {
        fetchedAt: now.toISOString(),
        range: {
          from,
          to,
          fromDefaulted: input.from === undefined,
          toDefaulted: input.to === undefined,
          windowRule:
            'An entry is included when its startTimestamp falls inside [from, to]; an interval that began before "from" is counted in entriesOutsideWindow instead of being clipped.',
        },
        filters: {
          person: input.person ?? null,
          boards: input.boards ?? null,
          taskIds: explicitTaskIds.length > 0 ? explicitTaskIds : null,
          limit,
          maxTasks,
        },
        warnings,
        boardsSearched: selected.map(({ ctx }) => ctx.ref),
        boardsWherePersonIsNotMember,
        failedBoards: loaded.failures,
        events: eventsMeta,
        ...(eventsMeta &&
          !eventsComplete && {
            eventsIncomplete:
              'The window had more activity than the activity log was read, so tasks worked on inside it may be ' +
              'missing. Narrow "from"/"to" or pass "taskIds".',
          }),
        ...(explicitTaskIds.length === 0 && {
          howEntriesAreFound:
            'Tasks were taken from the activity log entries that changed `totalSecondsSpent` in the window, so a ' +
            'task whose time was tracked without such an event would not appear. Use `taskIds` to be exact.',
        }),
        tasksWithTimeChanges: candidates.length,
        tasksScanned: scanned.length,
        tasksTruncatedByMaxTasks: candidates.length > scanned.length,
        ...(candidates.length > scanned.length && {
          howToComplete:
            `Only the ${scanned.length} most recently changed tasks of ${candidates.length} were read, so the ` +
            `totals cover part of the window. Raise "maxTasks" (up to ${MAX_MAX_TASKS}) or narrow "from"/"to".`,
        }),
        ...(tasksWithoutName.length > 0 && {
          tasksWithoutName,
          tasksWithoutNameNote:
            'Names are read from the tasks returned by KanbanFlow for each board; these tasks were not in that ' +
            'list (usually they live in a cell KanbanFlow pages, such as a big "done" column), so only the id is shown.',
        }),
        ...(tasksWithErrors.length > 0 && { tasksWithErrors }),
        taskIndexIncompleteBoards: perBoardIndex
          .filter((entry) => entry.incompleteCells > 0)
          .map((entry) => entry.board.ctx.ref),
        entriesMatched: matched.length,
        entriesReturned: returned.length,
        truncatedByLimit: matched.length > limit,
        ...(matched.length > limit && {
          limitNote:
            `${matched.length - limit} of the ${matched.length} matching entries are not in "entries"; the totals ` +
            `cover all of them. Raise "limit" (up to ${MAX_LIMIT}) or pass "taskIds" to read one task completely.`,
        }),
        entriesOutsideWindow,
        entriesWithoutDate,
        entriesWithoutEnd,
        entriesWithoutDuration,
        entriesWithoutUser,
        whereEntrySumDiffers,
        apiRequests:
          (loaded.boards.length + loaded.failures.length) * 2 +
          perBoardIndex.reduce((sum, entry) => sum + entry.requests, 0) +
          eventsRequests +
          entryRequests,
        totalsNote:
          'Totals are the sum of entry durations, not elapsed time: entries of two people overlapping on the same task add up twice, and a running stopwatch has no duration until it stops.',
        note: INTERPRETATION_NOTE,
      },
      totals: {
        entries: matched.length,
        seconds: totalSeconds,
        hours: round2(totalSeconds),
        byPerson,
        byDay: [...byDay.values()].sort((a, b) => b.date.localeCompare(a.date)),
        byBoard: [...byBoard.values()],
      },
      entries: returned.map(({ board, taskId, entry }) => {
        const seconds = entrySeconds(entry);
        return {
          id: entry.entryId,
          ...(entry.partIndex === undefined ? {} : { partIndex: entry.partIndex }),
          type: entry.type ?? null,
          board: board.ctx.ref,
          task: taskRef(board, taskId),
          person: entry.userId ? board.ctx.user(entry.userId) : null,
          start: entry.startTimestamp ?? null,
          end: entry.endTimestamp ?? null,
          seconds,
          hours: seconds === null ? null : secondsToHours(seconds),
        };
      }),
    };
  });
}
