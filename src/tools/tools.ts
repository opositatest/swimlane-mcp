import type { ToolDeps } from './deps.js';
import { createGetTaskTool } from './get-task.js';
import { createListBoardsTool } from './list-boards.js';
import { createListCommentsTool } from './list-comments.js';
import { createListTasksTool } from './list-tasks.js';
import { createSearchTasksTool } from './search-tasks.js';

// Lista de todas las herramientas disponibles (todas de solo lectura).
export function createTools(deps: ToolDeps) {
  return [
    createListBoardsTool(deps),
    createListTasksTool(deps),
    createGetTaskTool(deps),
    createListCommentsTool(deps),
    createSearchTasksTool(deps),
  ];
}
