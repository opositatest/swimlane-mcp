import { toolDefinition } from '@tanstack/ai';
import { z } from 'zod';
import { INTERPRETATION_NOTE, READ_ONLY, type ToolDeps, loadBoardContext } from './deps.js';

export function createGetBoardTool(deps: ToolDeps) {
  return toolDefinition({
    name: 'get_board',
    description:
      'Returns the KanbanFlow board this API token belongs to: columns in board order, swimlanes, the colors with the ' +
      'names/descriptions the team gave them, the team context configured for this server, and who "me" is. ' +
      'Call this first to learn how the team uses the board before interpreting any task.',
    inputSchema: z.object({}),
    metadata: READ_ONLY,
  }).server(async () => {
    const ctx = await loadBoardContext(deps);
    const { board } = ctx;
    return {
      board: { id: board._id, name: board.name },
      columns: board.columns.map((column, index) => ({ id: column.uniqueId, name: column.name, index })),
      swimlanes: (board.swimlanes ?? []).map((swimlane, index) => ({
        id: swimlane.uniqueId,
        name: swimlane.name,
        description:
          typeof swimlane.description === 'string' && swimlane.description ? swimlane.description : undefined,
        index,
      })),
      colors: (board.colors ?? []).map((color) => ({
        value: color.value,
        name: color.name || undefined,
        description: color.description || undefined,
      })),
      teamContext: deps.config.teamContext ?? null,
      me: ctx.configuredUser() ?? null,
      note: INTERPRETATION_NOTE,
    };
  });
}
