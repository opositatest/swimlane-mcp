# Tools reference

Every tool returns JSON (as MCP `structuredContent` and as text). Nothing is pre-formatted or interpreted: the model decides how to present it and what it means.

Shared shapes:

- **Ref**: `{ id, name }` — a board, column, swimlane or user. Ids not found on the board get a name like `(column not on this board: <id>)`.
- **Color**: `{ value, boardName?, boardDescription? }` — `value` is KanbanFlow's color (`red`, `blue`…); the rest is what the team wrote on that board.
- **Task (summary)**: `board, id, name, url, column, swimlane, color, labels, responsible, collaborators, timeEstimateHours, timeSpentHours, subTasks {total, finished}, groupingDate, description, descriptionTruncated`. `full` detail adds the complete description and `raw` (the untouched API object, including custom fields).

## `list_boards`

No parameters. Returns:

- `boards`: `[{ id, name, columns [{id, name, index}], swimlanes, colors [{value, name, description}], members [{id, name, email, isMe}] }]`
- `me`: `{ configured, foundOn: [{ board, users, matchedBy }] }`, or `null` without `KANBANFLOW_USER`
- `failedBoards`: `[{ token: <position>, error }]`

## `list_tasks`

| Parameter | Type | Description |
|-----------|------|-------------|
| `person` | string | Email, full name, part of the name or user id. Omit it (or `"me"`) for `KANBANFLOW_USER`. Matches the task's responsible user or any collaborator. |
| `boards` | string[] | Board ids or exact names. Default: every configured board. |
| `columns` | string[] | Column ids or exact names, on any board. Default: every column. |
| `loadAllPages` | boolean | Load every limited column completely (slow on big boards). |
| `detail` | `summary` \| `full` | Default `summary`. |
| `limit` | number | Tasks returned, default 50, max 500. Counts always cover every match. |

Returns:

- `person`: `{ requested, source: "argument" | "KANBANFLOW_USER", matches: [{ board, users, matchedBy }] }`. `matchedBy` is `id`, `email`, `full name` or `partial name` (only used when nothing matches exactly).
- `meta`:
  - `filters`, `warnings` (boards/columns that matched nothing, ambiguous names, person on no board)
  - `boardsSearched`, `boardsWherePersonIsNotMember`, `failedBoards`
  - `complete`, `incompleteCells`, `howToComplete` — KanbanFlow returns only the first tasks of large cells (typically "done"); a column is loaded completely when it is in `columns` (or with `loadAllPages`)
  - `tasksMatched`, `tasksReturned`, `truncatedByLimit`, `apiRequests`, `fetchedAt`
- `counts`: `byBoard`, `byColumn` (board + column) over all matched tasks.
- `tasks`: ordered by board, then column order.

## `search_tasks`

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Text to find, case-insensitive and as a substring. Split into words; by default **every word** must appear somewhere in the searched fields (AND). |
| `fields` | string[] | Where to look. Default `["name", "description"]`; also `labels` (label names), `customFields` (custom field values; names are not in the API) and `subTasks` (subtask names). |
| `person` | string | Only tasks of this person (responsible or collaborator); `"me"` uses `KANBANFLOW_USER`. Default: everybody. |
| `boards` | string[] | Board ids or exact names. Default: every configured board. |
| `columns` | string[] | Column ids or exact names, on any board. Default: every column. Limited columns listed here are loaded completely. |
| `loadAllPages` | boolean | Load every limited column completely (slow on big boards). |
| `detail` | `summary` \| `full` | Default `summary`. |
| `limit` | number | Tasks returned, default 50, max 500. Counts always cover every match. |

Returns:

- `query`: `{ text, terms, fields }` — the words actually searched and the fields used.
- `person`: `null` without a `person` filter, otherwise the same shape as `list_tasks`.
- `meta`: like `list_tasks` (`filters`, `warnings`, `boardsSearched`, `boardsWherePersonIsNotMember`, `failedBoards`, `complete`, `incompleteCells`, `howToComplete`, `tasksMatched`, `tasksReturned`, `truncatedByLimit`, `apiRequests`, `fetchedAt`) — note that a partial column can hide matches, which is why it is always reported.
- `tasks`: the summary/full task shape plus `matchedFields`, ordered by board then column order.

KanbanFlow has no search endpoint: tasks are loaded with `GET /tasks` and filtered here, so the search covers what was loaded (one request per board; more when a limited column is expanded). A task matches when every query word is in the selected fields combined; `matchedFields` lists the fields that contained at least one word (it is not per word). To search comment text or mentions, use `list_comments`.

## `get_task`

| Parameter | Type | Description |
|-----------|------|-------------|
| `taskId` | string | Task id (from `list_tasks`, or the last part of a `kanbanflow.com/t/…` URL). |
| `board` | string | Board id or exact name the task is on (see `list_boards`). Default: try every configured board. |
| `includeComments` | boolean | Fetch the comments (default `true`; one extra API request). |

Returns:

- `task`: the `full` task shape (complete description + `raw`) plus `board`.
- `comments`: `[{ id, author: Ref | null, createdAt, text }]`, or `null` with `includeComments: false`. The text is verbatim, so mentions are inside it; the server does not parse or interpret it.
- `meta`: `fetchedAt`, `warnings`, `boardsSearched`, `boardsWithoutTheTask` (`[{ board, status }]`, only for boards that answered 404/403), `failedBoards`, `apiRequests`.

A task lives on exactly one board. Without `board`, the boards are tried in token order until one has the task, so the request count grows with the boards tried; `meta` says which boards did not have it.

## `list_comments`

| Parameter | Type | Description |
|-----------|------|-------------|
| `person` | string | Only comments that mention this person (id, email, full name or part of the name); `"me"` uses `KANBANFLOW_USER`. Omit it to list comments regardless of mentions. |
| `text` | string | Only comments whose text contains this, case-insensitive (a handle or an exact phrase). |
| `boards` | string[] | Board ids or exact names. Default: every configured board. |
| `from` / `to` | string | Window, ISO 8601 UTC. Default: the last 30 days, up to now. |
| `limit` | number | Comments returned, newest first. Default 20, max 200. |
| `maxTasks` | number | Tasks whose comments are read, most recently commented first. Default 25, max 100; one API request each. |

Returns:

- `person`: `null` without a `person` filter, otherwise `{ requested, resolved, source, matches, textSearched, note }`. **There is no structured mention field in KanbanFlow**, so a comment counts as a mention when its text contains one of the person's names on that board as a whole word (case-insensitive): the full name and the first name are looked for, so `@Ada` matches `Ada Lovelace` but `Adam` does not match `Ada`. `textSearched` lists the exact strings used per board; when the person is not a member of a board, the raw reference is used as the only string.
- `meta`: the window (and whether it was defaulted), filters, `warnings`, `boardsSearched`, `boardsWherePersonIsNotMember`, `failedBoards`, `events {loaded, complete, commentEvents}`, `tasksWithCommentEvents`, `tasksScanned`, `tasksTruncatedByMaxTasks`, `tasksWithErrors`, `commentsMatched`, `commentsReturned`, `truncatedByLimit`, `commentsWithoutDate`, `apiRequests`, `fetchedAt`.
- `comments`: `[{ id, createdAt, author: Ref | null, board: Ref, task (summary shape, or `{id, name: null, url}` if it could not be read), text }]`, newest first. Text is verbatim.

How it works and its limits: comments are found through the board activity log (`GET /board/events`, `taskCommentCreated`), so only tasks commented inside the window are looked at; the comments of those tasks are then read one request each. The activity log pages oldest-first and the client reads at most 1000 events, so on a very busy window `meta.events.complete` is `false` and the newest comments may be missing — narrow `from`/`to`. A board with years of history cannot be searched for an arbitrary old mention this way: use a window that covers it.

## `list_time_entries`

| Parameter | Type | Description |
|-----------|------|-------------|
| `from` / `to` | string | Window, ISO 8601 UTC. Default: the last 2 days ending now (covers a local "today" in any time zone). The server does **not** decide what "today" is: pass the window the user means (for a local day, its UTC equivalent). |
| `person` | string | Only entries tracked by this person (id, email, full name or part of the name); `"me"` uses `KANBANFLOW_USER`. Omit it for everybody. |
| `boards` | string[] | Board ids or exact names. Default: every configured board. |
| `taskIds` | string[] | Read only these tasks (ids from `list_tasks`, `search_tasks`, `get_task`) instead of scanning the activity log. Cheaper and exact, and the only way to reach entries older than the log keeps. |
| `limit` | number | Entries returned, newest first. Default 100, max 500. Totals always cover every match. |
| `maxTasks` | number | Tasks whose entries are read, most recently changed first. Default 50, max 100; one API request each. |

Returns:

- `person`: `null` without a `person` filter, otherwise the same shape as `list_comments`, plus a note that an entry is attributed by the `userId` KanbanFlow stores on it.
- `meta`:
  - `range` (`from`, `to`, whether each was defaulted, and `windowRule`), `filters`
  - `warnings`, `boardsSearched`, `boardsWherePersonIsNotMember`, `failedBoards`
  - `events` (`{ loaded, complete, timeChanges }`, or `null` with `taskIds`) and `howEntriesAreFound`
  - `tasksWithTimeChanges`, `tasksScanned`, `tasksTruncatedByMaxTasks`, `howToComplete` (when tasks were capped, with how to read the rest), `tasksWithoutName`, `tasksWithErrors`, `taskIndexIncompleteBoards`
  - `entriesMatched`, `entriesReturned`, `truncatedByLimit`, `limitNote` (how many matching entries the list left out), `entriesOutsideWindow`, `entriesWithoutDate`, `entriesWithoutEnd`, `entriesWithoutDuration`, `entriesWithoutUser`
  - `whereEntrySumDiffers` — `[{ board, taskId, entriesSeconds, taskTotalSeconds }]` for tasks where the sum of their entries does not match their accumulated total (a sign that something was not returned)
  - `apiRequests`, `totalsNote`, `note`
- `totals`: `{ entries, seconds, hours, byPerson (board + person), byDay (UTC date), byBoard }` over **every** match, not only the returned ones. These are sums of entry durations: two people overlapping on the same task add up twice, so they are not elapsed time.
- `entries`: `[{ id, partIndex?, type, board, task, person, start, end, seconds, hours }]`, newest first. `task` is `{ id, name, url, column, swimlane }`; `name` is `null` when the task was not in the (possibly paginated) task list of its board. `end`, `seconds` and `hours` are `null` while a stopwatch is still running. `id` is `entryId`, the id of the stopwatch session or manual entry: a session can be split in parts (`partIndex`) and its parts can even land on different tasks, so `id` alone does not identify a row; `id` + `partIndex` + `task.id` does.

How it works and its limits: `GET /tasks/{id}/time-entries` is the only time endpoint that exists (the board-level `/timeentries` of the documentation answers 404) and it ignores query parameters, so every entry of a task is returned in one request; the window is applied here. Entries are attributed to whoever KanbanFlow recorded on them, which can be an integration id that is not a board member (returned without a name). Without `taskIds`, the tasks of the window come from the activity log entries that changed `totalSecondsSpent`: the log is read oldest-first and, on a busy board, that budget (25 pages, 2500 events per board) can run out before the newest events, which `meta.events.complete` reports. A task whose time changed with no such event would not appear either; `taskIds` avoids both problems.
