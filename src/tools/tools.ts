import type { ToolDeps } from './deps.js';
import { createListBoardsTool } from './list-boards.js';
import { createListTasksTool } from './list-tasks.js';

// Lista de todas las herramientas disponibles (todas de solo lectura).
// Pendientes de adaptar a multi-board: ver drafts/README.md
export function createTools(deps: ToolDeps) {
  return [createListBoardsTool(deps), createListTasksTool(deps)];
}
