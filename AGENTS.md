# AGENTS.md

## Quick Reference

```bash
npm run dev            # MCP Inspector (for testing)
npm run typecheck      # tsc --noEmit (src + tests)
npm run lint:check     # lint + format + imports (CI equivalent)
npm test               # vitest suite (fake local API, no real API calls)
npm run build          # TypeScript → build/
npm run bundle:extension  # Claude Desktop extension → dist-extension/*.mcpb
```

## Critical Facts

- **Read-only MCP server.** Never add tools that modify KanbanFlow data.
- **Transparency first.** The server returns data, not opinions. Do NOT add logic that assigns meaning to columns, colors or labels (keyword matching, priority tables, "done" detection). Each team defines those; the model infers them from `list_boards`. Facts (counts, name resolution) are fine; interpretations are not.
- **Report completeness.** Anything that can be partial (pagination caps, limits, filters that matched nothing) must be reported in `meta`, never silently dropped.
- **Multi-board.** One KanbanFlow token = one board. Config takes several tokens (`KANBANFLOW_API_KEYS`); every tool works across all of them via `BoardSet`. Never assume a single board, and never print tokens (refer to them by position).
- **People are matched per board** (`BoardContext.findPeople`): user ids can differ between boards; email is the stable key. Always report `matchedBy` and ambiguous matches.
- **TanStack AI.** Tools are `toolDefinition().server()` from `@tanstack/ai`; the server is `createMCPServer` from `@tanstack/ai-mcp/server`, served with `serveMCPStdio`. Do NOT import `@modelcontextprotocol/sdk`.
- **stdout is the protocol channel.** Never `console.log` (Biome `noConsoleLog` is an error). Log with `console.error`.
- **Invalid configuration never exits the process**: the server starts and every tool answers with the problem and where to fix it (`BoardSet.unconfigured`, `assertConfigured`). Tools must call `deps.boards.assertConfigured()` (or `load()`) before any other check.
- **Errors:** throw an `Error` with an actionable message; TanStack turns it into an MCP `isError` result. `kanbanflow-client.ts` already converts HTTP failures (`describeApiError`).
- **Node 24+** (`engines`, `.node-version`; CI tests 24 and 26). ES modules, `.js` extensions in imports, TypeScript strict, Node16 resolution, target ES2024, Zod v4.
- **Descriptions in English**: tool/parameter descriptions are prompts for the model.

## Architecture

- `src/main.ts` — CLI entry (`bin`): `loadConfig()` then `serveMCPStdio(createServer(config))`.
- `src/server.ts` — `createServer(config, boards?)`; a `BoardSet` can be injected in tests.
- `src/services/boards.ts` — `BoardSet` (one client per token, `load()` with per-token failures) and `selectBoards`.
- `src/config.ts` — env vars validated with Zod: `KANBANFLOW_API_KEY` / `KANBANFLOW_API_KEYS` (at least one), `KANBANFLOW_USER` (alias `KANBANFLOW_USER_ID`), `KANBANFLOW_BASE_URL`.
- `src/services/kanbanflow-client.ts` — HTTP (axios), retries, pagination:
  - `GET /tasks` returns cells with `tasksLimited` + `nextTaskId`; `getAllTasks({ expandColumnIds })` pages only the requested columns (big "done" cells can hold thousands of tasks) and reports `complete` per cell.
  - `GET /board/events` (not `/events`) returns ≤100 events oldest first + `eventsLimited`; `getEvents` pages by moving `from` to the last timestamp and de-duplicating by `_id` (used by the draft `get_board_events`).
- `src/services/board-context.ts` — `BoardContext` (one board): id → name for columns, swimlanes, users, colors; `findPeople`.
- `src/tools/*.ts` — one factory per tool, `create<Name>Tool(deps)`; `tools.ts` lists them; `task-view.ts` is the shared task shape.
- `extension/` — Claude Desktop extension (MCPB manifest v0.4): `manifest.json` (form = `user_config`, mapped to `KANBANFLOW_*` env vars), `mcpb-resources/es-ES.json` (translations; `user_config` titles cannot be translated), `icon.png`. `scripts/bundle-extension.mjs` bundles `src/main.ts` into one file with esbuild (no node_modules shipped) and runs `mcpb validate` + `mcpb pack`. Claude Desktop runs it with its built-in Node (24.x in Claude 2.16 / Electron 44).
- `drafts/` — single-board tools/prompts not compiled; adapt to `BoardSet` before moving back (see `drafts/README.md`).
- `tests/fake-api.ts` — local HTTP fake with the real response shapes; serves a different board per token (`token-a`, `token-b`, `token-bad` → 401).

## Adding a tool

1. Create `src/tools/<name>.ts` exporting `create<Name>Tool(deps: ToolDeps)` that returns `toolDefinition({ name, description, inputSchema: z.object(...), metadata: READ_ONLY }).server(...)`. Work over `deps.boards.load()` (all boards).
2. Return a plain JSON object (becomes `structuredContent`). Include a `meta` block if anything can be partial.
3. Register it in `src/tools/tools.ts`, add it to `tests/stdio-server.test.ts`, test it in `tests/tools.test.ts` against `fake-api.ts` (with more than one board), and document it in `TOOLS.md`.

## API documentation

`docs/kanbanflow-api.md` holds our own notes, verified against a real board (the official docs live inside the app: board menu → Settings → API & Webhooks). Do not copy the official documentation into the repo; add verified facts to the notes instead.

- **Rate limit:** 1000 requests/hour/board; a token can be locked after 5000/day. Keep request counts low and report them in `meta`.
