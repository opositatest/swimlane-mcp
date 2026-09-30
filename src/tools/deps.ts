import type { Config } from '../config.js';
import type { BoardSet } from '../services/boards.js';

export interface ToolDeps {
  boards: BoardSet;
  config: Config;
}

// Every tool is read-only: hosts can run them without asking for confirmation.
export const READ_ONLY = {
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const INTERPRETATION_NOTE =
  'This server does not interpret boards. Column, swimlane, color and label meanings are defined by each team: ' +
  'infer them from their names and the color names/descriptions (list_boards), and state your assumptions.';
