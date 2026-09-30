# Drafts

Tools and prompts written for the single-board version. They are **not compiled or registered**.
Adapt each one to multi-board (`BoardSet`, see `src/services/boards.ts`) before moving it back to `src/`.

- `tools/get-board.ts` → replaced by `list_boards`
- `tools/get-users.ts`
- `tools/get-task.ts`
- `tools/get-board-events.ts` (uses `GET /board/events`, paged by `from`)
- `prompts/prompts.ts` (`daily_standup`, `prioritize_tasks`, `sprint_review`, `my_tasks`)
