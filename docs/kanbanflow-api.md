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
| `GET /board/events` | Activity log. **`GET /events` returns 404.** |

Also answering with data: `GET /tasks/{id}/subtasks`, `/labels`, `/relations` (`relatedTaskId`, `relatedTaskName`, `relatedTaskBoardId`, `relationType`), `/attachments`, `/time-entries` (`entryId`, `userId`, `startTimestamp`, `endTimestamp`, `type`).

`GET /customfields` returned **404** on the board we tested, so custom field names may not be available; tasks still carry `customFields [{ customFieldId, value }]`.

## Task fields seen

`_id, name, description, color, columnId, swimlaneId, responsibleUserId, totalSecondsSpent, totalSecondsEstimate, collaborators [{userId}], labels [{name, pinned}], subTasks [{name, finished, userId?}], dates [{targetColumnId, status, dateType, dueTimestamp, dueTimestampLocal}], customFields, groupingDate`.

Fields are omitted when empty (a task without labels has no `labels` key). `color` is a KanbanFlow color value (`red`, `blue`…); what it means is defined per board in `colors`.

## Pagination of `GET /tasks`

- Each cell: `{ columnId, columnName, swimlaneId, swimlaneName, tasksLimited, nextTaskId?, tasks }`.
- Large cells (typically a date-grouped "Done" column) come **limited to 20 tasks** with `tasksLimited: true` and `nextTaskId`.
- Next page: `GET /tasks?columnId=…&swimlaneId=…&startTaskId=<nextTaskId>&limit=100`. It answers with an array holding one cell, with the same `tasksLimited` / `nextTaskId`.
- On a board with years of history, one "Done" cell held more than 2000 tasks, so paging everything can take dozens of requests.

## Pagination of `GET /board/events`

- Needs `from` and/or `to` (ISO 8601 UTC).
- Response: `{ eventsLimited, events: [{ _id, userId, timestamp, detailedEvents: [{ eventType, taskId, changedProperties: [{ property, oldValue, newValue }] }] }] }`.
- At most 100 events, **oldest first**. `limit` is accepted; `startEventId` is ignored.
- Next page: repeat with `from` = timestamp of the last event and skip `_id`s already seen.
- Event types seen: `taskCreated`, `taskChanged`, `taskCommentCreated`, `taskAttachmentCreated`, `taskCustomFieldChanged`, `taskRelationCreated`, `taskRelationDeleted`.
- `changedProperties` seen: `columnId`, `swimlaneId`, `boardId` (task moved from another board), `sortOrder` (almost every drag), `color`, `labels`, `members`, `description`, `subTasks`, `dates`, `groupingDate`, `totalSecondsSpent`, `hasComments`, `hasRelations`, `hasAttachments`.
