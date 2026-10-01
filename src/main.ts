#!/usr/bin/env node
import { serveMCPStdio } from '@tanstack/ai-mcp/server/stdio';
import { DEFAULT_BASE_URL, loadConfig } from './config.js';
import { createServer } from './server.js';
import { BoardSet } from './services/boards.js';

// --- VERSIÓN DE NODE ---
// Solo avisa: salir aquí dejaría al host con un "server disconnected" sin explicación.
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 24) {
  console.error(
    `swimlane-mcp: requires Node.js 24 or newer (running ${process.version}). Update Node if something fails.`
  );
}

// --- CONFIGURACIÓN ---
// Con una configuración inválida el servidor arranca igualmente y cada tool devuelve el
// error en el chat: un proceso que termina solo se ve como "server disconnected".
let server: ReturnType<typeof createServer>;
try {
  server = createServer(loadConfig());
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`swimlane-mcp: invalid configuration: ${message}`);
  server = createServer({ apiKeys: [], baseUrl: DEFAULT_BASE_URL }, BoardSet.unconfigured(message));
}

// --- CONEXIÓN DEL SERVIDOR ---
// stdout solo transporta mensajes del protocolo: los logs van a stderr.
// Both distributed builds apply scripts/stdio-compat.mjs to this adapter.
// Use npm run dev / npm test (the bundled entry), not raw tsx, to test the transport.
serveMCPStdio(server);
console.error('swimlane-mcp: listening on stdio.');
