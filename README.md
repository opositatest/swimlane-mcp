# swimlane-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://github.com/opositatest/swimlane-mcp/blob/main/LICENSE)
[![Node ≥24](https://img.shields.io/badge/node-%3E%3D24-brightgreen?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![MCP](https://img.shields.io/badge/MCP-read--only-6b4fbb)](https://modelcontextprotocol.io)


An unofficial, **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server for [KanbanFlow](https://kanbanflow.com). It lets any MCP client (Claude Desktop, Claude Code, Cursor, VS Code, OpenCode…) list the tasks of a person — you, or anyone you name — across **all the boards you configure**. It is not tied to any board or team: each person configures their own boards.

Built on [TanStack AI](https://tanstack.com/ai) (`@tanstack/ai` + `@tanstack/ai-mcp`).

> **Not affiliated with KanbanFlow.** KanbanFlow is a trademark of its owner; this project only uses its public API.

## Design principles

1. **Transparent data, no hidden opinions.** The server returns what the KanbanFlow API returns, with ids resolved to names. It never decides what a column, color or label *means* — every team uses KanbanFlow differently. The model infers it from each board (column names, the names/descriptions the team gave each color).
2. **Honest about completeness.** Every response carries a `meta` block: filters applied, filters that matched nothing, boards that failed, columns that were only partially loaded (KanbanFlow pages big "done" columns) and how to load the rest.
3. **Any board, any team.** Nothing is tied to a specific board: configure one token per board you want to use.
4. **Read-only.** No tool can modify a board. All tools are annotated `readOnlyHint`, so hosts can run them without asking.

## Tools

| Tool | What it returns |
|------|-----------------|
| `list_boards` | The configured boards: columns (in order), swimlanes, colors with the team's names/descriptions, members, and on which boards "me" was found. |
| `list_tasks` | The tasks of one person (default: "me") on every configured board, optionally only some boards or columns. Tasks come with board, column, swimlane, color, labels and people resolved to names, plus counts per board and column. |

A person can be given by email, full name, part of the name or user id. It is matched on each board separately; the response says how it matched (`matchedBy`), which boards the person is not on, and warns when a partial name matches several people.

See [TOOLS.md](./TOOLS.md) for parameters and output format.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `KANBANFLOW_API_KEYS` | Yes* | API tokens of your boards, comma separated. KanbanFlow creates one token per board: board menu → *Settings* → *API & Webhooks*. |
| `KANBANFLOW_API_KEY` | Yes* | A single board token. Can be combined with `KANBANFLOW_API_KEYS`. |
| `KANBANFLOW_USER` | No | Who "me" is: your **email** (recommended — it is the same on every board), full name or user id. `KANBANFLOW_USER_ID` is accepted too. |
| `KANBANFLOW_BASE_URL` | No | API base URL (default `https://kanbanflow.com/api/v1`). Useful for proxies and tests. |

\* At least one token is required. If a token fails (revoked, wrong…), the other boards keep working and the response lists the failed one by its position — tokens are never shown.

## Installation

### Claude Desktop (recommended, no technical knowledge needed)

1. Download **`swimlane-mcp-….mcpb`** from the [latest release](https://github.com/opositatest/swimlane-mcp/releases/latest).
2. Double-click it and press **Install**.
3. Paste your KanbanFlow API token(s) and your KanbanFlow email in the form.

Claude Desktop runs it with its own Node.js, so nothing else has to be installed, and the token is stored encrypted by the operating system.

The extension declares **macOS, Windows and Linux (including Ubuntu)** compatibility starting with **0.0.3**. On Linux, use a client that supports `.mcpb` and provides Node.js 24+, or install Node and use the npm/stdio setup below. This does not add Linux support to a client that lacks it.

📘 Step-by-step guide in Spanish, with troubleshooting: [docs/instalar-en-claude-desktop.md](./docs/instalar-en-claude-desktop.md).

### Other clients (npx)

Other clients launch the server with `npx`. It needs **Node.js 24 or newer** on the `PATH` the client sees: GUI apps may not use your terminal's `nvm` version, so make 24+ the default (`nvm alias default 24`).

Claude Desktop can also run it this way instead of the extension, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "swimlane": {
      "command": "npx",
      "args": ["-y", "@opositatest/swimlane-mcp"],
      "env": {
        "KANBANFLOW_API_KEYS": "token_board_1,token_board_2",
        "KANBANFLOW_USER": "you@company.com"
      }
    }
  }
}
```

Pin a tested release for a team by appending its version to the package name (for example, `@opositatest/swimlane-mcp@0.0.2`).

### Claude Code

```bash
claude mcp add swimlane \
  -e KANBANFLOW_API_KEYS="token_board_1,token_board_2" \
  -e KANBANFLOW_USER="you@company.com" \
  -- npx -y @opositatest/swimlane-mcp
```

### Cursor / VS Code / OpenCode

Same `command` / `args` / `env` as above:

- Cursor: `.cursor/mcp.json` → `mcpServers`
- VS Code: `.vscode/mcp.json` → `servers` (add `"type": "stdio"`)
- OpenCode: `opencode.json` → `mcp` with `"type": "local"`, `"command": ["npx", "-y", "@opositatest/swimlane-mcp"]` and `environment`

### Without npx (global installation)

```bash
npm install -g @opositatest/swimlane-mcp@latest
claude mcp add swimlane \
  -e KANBANFLOW_API_KEYS="token_board_1,token_board_2" \
  -e KANBANFLOW_USER="you@company.com" \
  -- swimlane-mcp
```

For other clients, use `"command": "swimlane-mcp"` with no arguments; OpenCode uses `"command": ["swimlane-mcp"]`. The executable must be on the client's `PATH`. If it is not, use its absolute path.

### Troubleshooting startup

- **`Connection closed` / discovery hangs on version 0.0.1:** MCP 2026 clients can open a subscription before listing tools, which blocked the old stdio bridge. Version **0.0.2+** bundles the fix for both npm and the Desktop extension. Upgrade the global install, or use `@opositatest/swimlane-mcp@latest` in the npx arguments, then restart the MCP/client. No token change is needed.
- **`swimlane-mcp: command not found` when using npx inside this repository:** npm may resolve the same-named local project instead of the installed package. For development, run `npm run build` and configure `node` with the **absolute path** to `build/main.js`, or use the global executable. Simply running the add command elsewhere will not help if the client later starts npx inside this repository.
- **Node/PATH:** verify Node 24+ from the environment that launches the client. An absolute path to Node can avoid differences between GUI and terminal environments.
- **Already registered in Claude Code:** update the existing entry, or remove it with `claude mcp remove swimlane` before adding it again (use the same scope).

## Development

```bash
npm install
npm run dev          # builds the CLI, then opens MCP Inspector against build/main.js
npm run typecheck    # tsc --noEmit
npm run lint:check   # Biome (what CI runs)
npm test             # vitest: tools against a fake multi-board API + end-to-end stdio test
npm run build        # TypeScript modules + bundled, patched CLI → build/
npm run bundle:extension   # → dist-extension/swimlane-mcp-<version>.mcpb (Claude Desktop extension)
npm run test:package # after build + bundle:extension: installed tarball and Desktop entry point
```

`npm run dev` loads `.env` automatically (Node's `--env-file-if-exists`); copy `.env.example` to `.env` first. Use `nvm use` to pick the Node version in `.node-version`.

### Architecture

- `src/main.ts` — CLI entry (`bin`): validates the config and serves over stdio (`serveMCPStdio`)
- `src/server.ts` — `createMCPServer` with the tools; also mountable over HTTP via `server.fetch`
- `scripts/stdio-compat.mjs` — guarded build-time fix for TanStack's streaming stdio bridge, shared by the npm CLI and Desktop bundles; see [docs/stdio-compat.md](./docs/stdio-compat.md). Do not run `src/main.ts` directly to test transport compatibility.
- `src/config.ts` — environment variables, validated with Zod
- `src/services/kanbanflow-client.ts` — KanbanFlow API for one token: auth, retries, pagination, readable errors
- `src/services/boards.ts` — `BoardSet`: one client per token, every board loaded in parallel
- `src/services/board-context.ts` — resolves ids to names and finds people; never assigns meaning
- `src/tools/` — one file per tool (`toolDefinition().server()`)
- `extension/` — Claude Desktop extension: `manifest.json` (form fields, Spanish translation in `mcpb-resources/`) and icon; `scripts/bundle-extension.mjs` bundles the server into one file with esbuild and packs the `.mcpb`
- `drafts/` — single-board tools and prompts (task detail, activity log, standup…) pending adaptation to multi-board
- `docs/kanbanflow-api.md` — our verified notes on how the KanbanFlow API behaves (pagination, events, rate limits)

## Publishing (maintainers)

Releases are made from GitHub: **Actions → Create Release → Run workflow**, then choose `patch`, `minor` or `major`.

It runs [release-it](https://github.com/release-it/release-it): bumps the version, runs lint and tests, builds the Claude Desktop extension, commits and tags `vX.Y.Z`, creates the GitHub Release with the `.mcpb` attached and publishes to npm with provenance. It needs the `NPM_TOKEN` secret (an npm automation token with publish rights on `@opositatest`).

`Publish to npm` publishes an existing release again if that last step failed. CI (`ci.yml`) runs typecheck, lint, tests, build, a package-contents check, the extension build and installed-package protocol checks on Linux, Windows and macOS. `security.yml` runs `npm audit` and CodeQL every Monday.

## Security

See [SECURITY.md](./SECURITY.md) for how tokens and board data are handled and how to report a vulnerability.

License
-------

Released under the MIT License.
