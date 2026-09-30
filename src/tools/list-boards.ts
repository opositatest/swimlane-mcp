import { toolDefinition } from '@tanstack/ai';
import { z } from 'zod';
import { INTERPRETATION_NOTE, READ_ONLY, type ToolDeps } from './deps.js';

export function createListBoardsTool(deps: ToolDeps) {
  return toolDefinition({
    name: 'list_boards',
    description:
      'Lists the KanbanFlow boards this server has access to (one per configured API token): columns in board ' +
      'order, swimlanes, colors with the names/descriptions the team gave them, and members. Shows on which boards ' +
      'the configured user ("me") was found. Use it to learn the boards and to find people by name.',
    inputSchema: z.object({}),
    metadata: READ_ONLY,
  }).server(async () => {
    const { boards, failures } = await deps.boards.load();
    const me = deps.config.user;

    return {
      me: me
        ? {
            configured: me,
            foundOn: boards
              .map(({ ctx }) => ({ board: ctx.ref, ...ctx.findPeople(me) }))
              .filter((match) => match.users.length > 0),
          }
        : null,
      boards: boards.map(({ ctx }) => {
        const meIds = new Set(me ? ctx.findPeople(me).users.map((u) => u.id) : []);
        return {
          id: ctx.board._id,
          name: ctx.board.name,
          columns: ctx.board.columns.map((column, index) => ({ id: column.uniqueId, name: column.name, index })),
          swimlanes: (ctx.board.swimlanes ?? []).map((swimlane, index) => ({
            id: swimlane.uniqueId,
            name: swimlane.name,
            description:
              typeof swimlane.description === 'string' && swimlane.description ? swimlane.description : undefined,
            index,
          })),
          colors: (ctx.board.colors ?? []).map((color) => ({
            value: color.value,
            name: color.name || undefined,
            description: color.description || undefined,
          })),
          members: ctx.users.map((user) => ({
            id: user._id,
            name: user.fullName,
            email: user.email ?? null,
            isMe: meIds.has(user._id),
          })),
        };
      }),
      failedBoards: failures,
      note: INTERPRETATION_NOTE,
    };
  });
}
