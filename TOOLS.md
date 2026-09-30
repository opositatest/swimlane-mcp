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
