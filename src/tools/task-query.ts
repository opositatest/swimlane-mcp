import type { PersonMatch, Ref } from '../services/board-context.js';
import type { LoadedBoard, LoadedBoards } from '../services/boards.js';
import { selectBoards } from '../services/boards.js';
import type { ApiTask } from '../types.js';
import type { ToolDeps } from './deps.js';

export interface IncompleteCell {
  board: Ref;
  column: Ref;
  swimlane: Ref | null;
  loadedTasks: number;
}

export interface CollectedBoard {
  board: LoadedBoard;
  tasks: ApiTask[];
  incompleteCells: IncompleteCell[];
  requests: number;
}

export interface CollectedTasks {
  loaded: LoadedBoards;
  selected: LoadedBoard[];
  warnings: string[];
  personMatches: { board: LoadedBoard; match?: PersonMatch }[];
  boardsWherePersonIsNotMember: Ref[];
  boards: CollectedBoard[];
  apiRequests: number;
}

/**
 * Loads the tasks of every board once, matching the person and the columns per board,
 * and keeps everything the caller must not hide: failed boards, partially loaded cells
 * (usually "done"), ambiguous names, boards where the person is missing and columns
 * that exist nowhere.
 *
 * `person` is optional: without it every task is collected.
 */
export async function collectTasks(
  deps: ToolDeps,
  options: { person?: string; boards?: string[]; columns?: string[]; loadAllPages?: boolean }
): Promise<CollectedTasks> {
  const loaded = await deps.boards.load();
  const { selected, warnings } = selectBoards(loaded.boards, options.boards);

  const personMatches = selected.map((board) => ({
    board,
    match: options.person ? board.ctx.findPeople(options.person) : undefined,
  }));
  for (const { board, match } of personMatches) {
    if (match && match.users.length > 1) {
      warnings.push(
        `"${options.person}" matched ${match.users.length} members on board "${board.ctx.board.name}" ` +
          `(${match.users.map((user) => user.name).join(', ')}); tasks of all of them are included. Be more specific if needed.`
      );
    }
  }
  // With a person, only the boards where they are a member are searched.
  const withPerson = personMatches.filter(({ match }) => (match?.users.length ?? 0) > 0);
  const boardsWherePersonIsNotMember = options.person
    ? personMatches.filter(({ match }) => (match?.users.length ?? 0) === 0).map(({ board }) => board.ctx.ref)
    : [];
  if (options.person && selected.length > 0 && withPerson.length === 0) {
    warnings.push(`"${options.person}" is not a member of any searched board.`);
  }
  const targets = options.person ? withPerson : selected.map((board) => ({ board, match: undefined }));

  // Columns are resolved per board; warn only when a column exists on none of them.
  const perBoardColumns = new Map<LoadedBoard, Set<string> | undefined>();
  for (const { board } of targets) {
    perBoardColumns.set(board, options.columns ? board.ctx.columnIds(options.columns) : undefined);
  }
  for (const column of options.columns ?? []) {
    const exists = targets.some(({ board }) => board.ctx.columnIds([column]).size > 0);
    if (!exists && targets.length > 0) warnings.push(`Column "${column}" exists on none of the searched boards.`);
  }

  const boards = await Promise.all(
    targets.map(async ({ board, match }) => {
      const wantedColumns = perBoardColumns.get(board);
      const fetched = await board.client.getAllTasks({
        expandColumnIds: options.loadAllPages ? 'all' : wantedColumns,
      });
      const ids = new Set((match?.users ?? []).map((user) => user.id));
      const cells = fetched.cells.filter((cell) => !wantedColumns || wantedColumns.has(cell.columnId));
      const tasks = cells
        .flatMap((cell) => cell.tasks)
        .filter((task) => !options.person || [...board.ctx.peopleIds(task)].some((id) => ids.has(id)))
        .sort((a, b) => board.ctx.columnIndex(a.columnId) - board.ctx.columnIndex(b.columnId));
      const incompleteCells = cells
        .filter((cell) => !cell.complete)
        .map((cell) => ({
          board: board.ctx.ref,
          column: board.ctx.column(cell.columnId),
          swimlane: board.ctx.swimlane(cell.swimlaneId) ?? null,
          loadedTasks: cell.tasks.length,
        }));
      return { board, tasks, incompleteCells, requests: fetched.requests };
    })
  );

  return {
    loaded,
    selected,
    warnings,
    personMatches,
    boardsWherePersonIsNotMember,
    boards,
    apiRequests: loaded.boards.length * 2 + boards.reduce((sum, board) => sum + 1 + board.requests, 0),
  };
}
