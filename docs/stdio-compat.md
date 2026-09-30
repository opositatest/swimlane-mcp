# TanStack stdio compatibility fix

## Failure reproduced

`@tanstack/ai-mcp@0.6.0` forwards stdio messages to `server.fetch`. Its bridge queues JSON-RPC requests serially and reads POST responses with `response.text()` before sending any messages back.

MCP 2026 (`2026-07-28`) clients can send `subscriptions/listen` with `toolsListChanged: true` before `tools/list`. The subscription returns an SSE stream that deliberately stays open. Reading its complete body never finishes: neither the acknowledgement nor the queued discovery request reaches the client. This is independent of Node versions and KanbanFlow credentials.

There is also a separate npm resolution issue when npx runs inside a project named `@opositatest/swimlane-mcp`: npm can choose the local project without a corresponding executable link. The package itself contains a valid bin. Use the global executable or the absolute built entry path for development; changing transport code does not fix npm's resolution rules.

## Distribution strategy

We keep TanStack's `createMCPServer`, `toolDefinition().server()` and `serveMCPStdio`; no second protocol implementation or direct SDK import is introduced in application code.

`scripts/stdio-compat.mjs` transforms only TanStack's stdio module while esbuild bundles it:

1. Subscription requests run outside the serial request queue.
2. SSE responses are decoded incrementally and forwarded through TanStack's existing stdio transport. The reader accepts fragmented UTF-8, LF/CRLF framing, multiline data and heartbeat comments.
3. An active request's abort controller is tracked by JSON-RPC id. `notifications/cancelled` aborts its stream; other subscriptions remain open. Buffered events are not forwarded after cancellation.
4. Readers are cancelled and locks released on shutdown or failure. Malformed SSE produces a protocol error rather than leaving the next request blocked.

The upstream version is pinned and its original module's SHA-256 is checked before transformation. Unexpected dependency/source changes fail the build instead of silently dropping the fix. Nothing modifies `node_modules` and nothing needs to run on consumer installation.

Both `build/main.js` (npm) and `dist-extension/stage/server/main.js` (Desktop) include the correction and bundled dependencies. Ordinary compiled service modules remain available under `build/`. The CLI still reads its version from the package's `package.json`.

**Always test the bundled CLI.** Direct `tsx src/main.ts` executes the uncorrected upstream module. `npm run dev` and `npm test` build and use the corrected entry point.

## Verification and release gates

- `npm test`: tools against the fake API; stdio sessions for MCP 2025-06-18 and 2025-11-25; MCP 2026 subscriptions followed immediately by discovery and tool calls; malformed/empty subscriptions; unsupported requests; stdin EOF.
- The independent SSE fixture tests fragmented CRLF/UTF-8, multiline data, incremental notifications, cancellation isolation, malformed SSE and shutdown with multiple open subscriptions.
- After `npm run build` and `npm run bundle:extension`, `npm run test:package` packs and installs the tarball into a temporary consumer project with `--ignore-scripts --omit=dev`. It verifies npm executable resolution outside this repository, the npm bundle in a separate directory without node_modules, and the Desktop entry point. All three use the fake multi-board API and all three protocol versions. No real API calls or credentials are used.
- CI runs those gates on Linux/macOS/Windows with Node 24 and Linux with Node 26. The release workflow repeats the artifact gates after bumping the version, before creating the release.

## Removing the compatibility fix

When an upstream release fixes this bridge, review its streaming, concurrency, cancellation and shutdown behavior. Upgrade the pinned dependency, remove the plugin from **both** build scripts and remove the obsolete transformation. Keep the protocol, stream fixture and artifact regressions, and validate the published package with real clients before declaring compatibility.
