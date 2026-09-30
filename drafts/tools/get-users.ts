import { toolDefinition } from '@tanstack/ai';
import { z } from 'zod';
import { READ_ONLY, type ToolDeps, loadBoardContext } from './deps.js';

export function createGetUsersTool(deps: ToolDeps) {
  return toolDefinition({
    name: 'get_users',
    description:
      'Lists the members of the KanbanFlow board (id, full name, email) and marks which one is configured as "me" ' +
      '(KANBANFLOW_USER). Use it to resolve people mentioned by the user.',
    inputSchema: z.object({}),
    metadata: READ_ONLY,
  }).server(async () => {
    const ctx = await loadBoardContext(deps);
    const me = ctx.configuredUser();
    return {
      users: ctx.users.map((user) => ({
        id: user._id,
        name: user.fullName,
        email: user.email ?? null,
        isMe: me?.match?.id === user._id,
      })),
      me: me ?? null,
    };
  });
}
