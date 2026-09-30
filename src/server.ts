import { createRequire } from 'node:module';
import { createMCPServer } from '@tanstack/ai-mcp/server';
import type { Config } from './config.js';
import { BoardSet } from './services/boards.js';
import { createTools } from './tools/tools.js';

// La versión sale de package.json para que el host vea la misma que npm
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

// --- DEFINICIÓN DEL SERVIDOR MCP (TanStack AI) ---
// `boards` se puede inyectar en tests. El resultado sirve para stdio (serveMCPStdio)
// o para HTTP (`server.fetch`).
export function createServer(config: Config, boards: BoardSet = BoardSet.fromConfig(config)) {
  return createMCPServer({
    name: 'swimlane-mcp',
    version,
    tools: createTools({ boards, config }),
  });
}
