# KanbanFlow API: implementation notes

Our own notes on how the KanbanFlow API behaves, written while building this server and **verified against a real board**. They are not a copy of the official documentation, which lives inside the app (board menu → Settings → API & Webhooks → Show documentation). Check the official docs for anything not listed here.

## Basics

- Base URL: `https://kanbanflow.com/api/v1`
- Auth: HTTP Basic, user `apiToken`, password = the board's API token.
- **One token = one board.** A token only sees the board it was created on; several boards need several tokens.

## Rate limits

- Documented: 1000 requests per hour per board; more than 5000 in a day can get the token locked.
- Every response carries the quota:

  ```
  x-ratelimit-limit: 1000
  x-ratelimit-remaining: 996
  x-ratelimit-reset: 1790697600   (Unix seconds)
  ```

## Endpoints used by this server

| Endpoint | Notes |
|----------|-------|
| `GET /board` | `_id`, `name`, `columns [{uniqueId, name}]` (board order), `swimlanes [{uniqueId, name, description?}]`, `colors [{value, name?, description?}]`. |
| `GET /users` | `[{ _id, fullName, email }]`. |
| `GET /tasks` | All tasks, as an array of cells (one per column × swimlane). See pagination below. |
| `GET /tasks/{id}` | One task. |
| `GET /tasks/{id}/comments` | `[{ _id, text, authorUserId, createdTimestamp }]`. |
| `GET /tasks/{id}/time-entries` | Every time entry of the task (see *Time entries* below). |
| `GET /board/events` | Activity log. **`GET /events` returns 404.** |

Also answering with data: `GET /tasks/{id}/subtasks`, `/labels`, `/relations` (`relatedTaskId`, `relatedTaskName`, `relatedTaskBoardId`, `relationType`), `/attachments` and `/time-entries` (see below).

`GET /customfields` returned **404** on the board we tested, so custom field names may not be available; tasks still carry `customFields [{ customFieldId, value }]`.

## Task fields seen

`_id, name, description, color, columnId, swimlaneId, responsibleUserId, totalSecondsSpent, totalSecondsEstimate, collaborators [{userId}], labels [{name, pinned}], subTasks [{name, finished, userId?}], dates [{targetColumnId, status, dateType, dueTimestamp, dueTimestampLocal}], customFields, groupingDate`.

Fields are omitted when empty (a task without labels has no `labels` key). `color` is a KanbanFlow color value (`red`, `blue`…); what it means is defined per board in `colors`.

## Pagination of `GET /tasks`

- Each cell: `{ columnId, columnName, swimlaneId, swimlaneName, tasksLimited, nextTaskId?, tasks }`.
- Large cells (typically a date-grouped "Done" column) come **limited to 20 tasks** with `tasksLimited: true` and `nextTaskId`.
- Next page: `GET /tasks?columnId=…&swimlaneId=…&startTaskId=<nextTaskId>&limit=100`. It answers with an array holding one cell, with the same `tasksLimited` / `nextTaskId`.
- On a board with years of history, one "Done" cell held more than 2000 tasks, so paging everything can take dozens of requests.

## Time entries

Verified against a real board:

- **Only the hyphenated task path exists:** `GET /tasks/{id}/time-entries` answers 200; `/tasks/{id}/timeentries`, the board-level `/timeentries`, `/manualtimeentries` and `/stopwatchentries` all answer **404**, even though the API documentation inside the app lists a board-level `GET /timeentries` with `from`/`to`/`limit`/`userId`.
- Response: a flat array with every entry ever tracked on the task, oldest first:

  ```
  { entryId, type, userId, taskId, startTimestamp, endTimestamp, partIndex? }
  ```

  `type` seen: `stopwatch`, `manual`. `partIndex` is only present on stopwatch entries.
- **Query parameters are ignored:** `limit`, `from`, `startEntryId` change nothing, so the endpoint returns everything and there is no pagination (one task held 60 entries).
- **A stopwatch entry can be split in several rows** that share `entryId` and differ in `partIndex` (one task had `partIndex` 0–3). Each row is a separate interval; they add up, they are not duplicates. The parts of one `entryId` can land on **different tasks** (the same session appears with several `taskId`), so `entryId` alone does not identify a row: `entryId` + `partIndex` + `taskId` does.
- **The sum of the entry durations of a task equals its `totalSecondsSpent`** exactly on every task checked (12 tasks, 222 stopwatch + 25 manual entries). So this endpoint is the source for "who worked, when and how long", while `totalSecondsSpent` is only the accumulated total.
- **`userId` is not always a board member:** some entries carry a 32-character id (an integration, or a user `/users` does not list). Resolve it if possible and report it as unknown otherwise; never drop the entry.
- An entry still running has no `endTimestamp` (none seen yet, but the field is optional in the shape).
- To find the tasks of a window, `GET /board/events` marks them: a `taskChanged` detail with `totalSecondsSpent` in `changedProperties` (17 of those in two days on the board we tested; ~100 in a single day on a busy board). It gives the task and the user, but not the entry. The client reads the log oldest-first and stops after a page budget (10 pages / 1000 events for the comment search, 25 / 2500 for `list_time_entries`), so on a busy window the newest events are lost and `meta.events.complete` is `false`. One of our boards produced ~500 events per day, so even a two-day window can hit the budget.

## Pagination of `GET /board/events`

- Needs `from` and/or `to` (ISO 8601 UTC).
- Response: `{ eventsLimited, events: [{ _id, userId, timestamp, detailedEvents: [{ eventType, taskId, changedProperties: [{ property, oldValue, newValue }] }] }] }`.
- At most 100 events, **oldest first**. `limit` is accepted; `startEventId` is ignored.
- Next page: repeat with `from` = timestamp of the last event and skip `_id`s already seen.
- Event types seen: `taskCreated`, `taskChanged`, `taskCommentCreated`, `taskAttachmentCreated`, `taskCustomFieldChanged`, `taskRelationCreated`, `taskRelationDeleted`.
- `changedProperties` seen: `columnId`, `swimlaneId`, `boardId` (task moved from another board), `sortOrder` (almost every drag), `color`, `labels`, `members`, `description`, `subTasks`, `dates`, `groupingDate`, `totalSecondsSpent`, `hasComments`, `hasRelations`, `hasAttachments`.
- On the boards we tested, a `taskCommentCreated` detail carries `taskId` but **not** the comment: the text still has to be read with `GET /tasks/{id}/comments`. (The webhook payloads documented in the API docs are richer — they include `taskComment`, `taskName` and `userFullName` — but we have not seen those fields on `GET /board/events`.)

## Comments and mentions

- `GET /tasks/{id}/comments` returns `text`, `authorUserId` and `createdTimestamp`; there is **no mention field**: a mention is the person's name inside `text`, so finding mentions is a text search (case-insensitive) over the comment text.
- The webhook docs also list `taskCommentChanged` and `taskCommentDeleted`; we have only seen `taskCommentCreated` on `GET /board/events`.
