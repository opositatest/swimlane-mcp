import type { Config } from '../config.js';
import { BoardContext } from './board-context.js';
import { type KanbanflowClient, createKanbanflowClient } from './kanbanflow-client.js';

export interface LoadedBoard {
  ctx: BoardContext;
  client: KanbanflowClient;
}

export interface BoardFailure {
  /** Position of the token in the configuration (1-based). The token itself is never shown. */
  token: number;
  error: string;
}

export interface LoadedBoards {
  boards: LoadedBoard[];
  failures: BoardFailure[];
}

// Where people fix the configuration; shown in errors that reach the chat.
export const HOW_TO_FIX_CONFIG =
  'Fix it in the MCP settings: in Claude Desktop, Settings > Extensions > Swimlane for KanbanFlow > Configure; ' +
  'in other clients, the environment variables of this server in their MCP configuration.';

/** Every board configured through the API tokens. One failing token never hides the others. */
export class BoardSet {
  constructor(
    readonly clients: KanbanflowClient[],
    /** Set when the configuration is invalid: every tool call reports it instead of the server exiting. */
    private readonly configError?: string
  ) {}

  static fromConfig(config: Config): BoardSet {
    return new BoardSet(config.apiKeys.map((apiKey) => createKanbanflowClient({ apiKey, baseUrl: config.baseUrl })));
  }

  static unconfigured(error: string): BoardSet {
    return new BoardSet([], error);
  }

  /** Throws the configuration problem, if any. Tools call it before any other check. */
  assertConfigured(): void {
    if (this.configError) {
      throw new Error(`swimlane-mcp is not configured correctly: ${this.configError}\n${HOW_TO_FIX_CONFIG}`);
    }
  }

  /** Fresh board structure + members for every token, loaded in parallel. */
  async load(): Promise<LoadedBoards> {
    this.assertConfigured();
    const results = await Promise.allSettled(
      this.clients.map(async (client) => {
        const [board, users] = await Promise.all([client.getBoard(), client.getUsers()]);
        return { ctx: new BoardContext(board, users), client };
      })
    );
    const boards: LoadedBoard[] = [];
    const failures: BoardFailure[] = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') boards.push(result.value);
      else failures.push({ token: index + 1, error: String(result.reason?.message ?? result.reason) });
    });
    if (boards.length === 0) {
      throw new Error(
        `No board could be loaded:\n${failures.map((f) => `- token #${f.token}: ${f.error}`).join('\n')}\n${HOW_TO_FIX_CONFIG}`
      );
    }
    return { boards, failures };
  }
}

/** Keeps the boards whose id or name (case-insensitive) is in `wanted`; reports the ones that matched nothing. */
export function selectBoards(boards: LoadedBoard[], wanted: string[] | undefined) {
  if (!wanted || wanted.length === 0) return { selected: boards, warnings: [] as string[] };
  const warnings: string[] = [];
  const selected = new Set<LoadedBoard>();
  for (const value of wanted) {
    const needle = value.toLowerCase();
    const match = boards.filter((b) => b.ctx.board._id === value || b.ctx.board.name.toLowerCase() === needle);
    if (match.length === 0) warnings.push(`Board "${value}" is not configured; it matched nothing.`);
    for (const board of match) selected.add(board);
  }
  return { selected: [...selected], warnings };
}
