import axios, { AxiosError } from 'axios';
import type { ApiBoard, ApiComment, ApiEvent, ApiEventPage, ApiTask, ApiTaskCell, ApiUser } from '../types.js';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_CELL = 20;
const MAX_EVENT_PAGES = 10;

export interface TaskCell {
  columnId: string;
  swimlaneId?: string;
  tasks: ApiTask[];
  /** False when KanbanFlow has more tasks in this cell than were fetched. */
  complete: boolean;
}

export interface GetAllTasksOptions {
  /**
   * Columns whose limited cells are paged until complete. KanbanFlow only returns the
   * first tasks of big (usually date-grouped "done") cells; paging all of them can mean
   * thousands of tasks, so it only happens on request.
   */
  expandColumnIds?: ReadonlySet<string> | 'all';
}

export interface FetchedTasks {
  cells: TaskCell[];
  /** Number of API requests made, reported to the model for transparency. */
  requests: number;
}

export interface FetchedEvents {
  events: ApiEvent[];
  /** False when the range has more events than MAX_EVENT_PAGES pages. */
  complete: boolean;
  requests: number;
}

export interface KanbanflowClient {
  getBoard(): Promise<ApiBoard>;
  getUsers(): Promise<ApiUser[]>;
  getAllTasks(options?: GetAllTasksOptions): Promise<FetchedTasks>;
  getTask(taskId: string): Promise<ApiTask>;
  getTaskComments(taskId: string): Promise<ApiComment[]>;
  getEvents(params: { from?: string; to?: string }): Promise<FetchedEvents>;
}

/**
 * An HTTP failure from KanbanFlow, with the status code kept so callers can react to it
 * (e.g. 404 means "this board does not have that task", used to locate a task across boards).
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Turns an HTTP failure into a message the model (and the user) can act on. */
export function describeApiError(error: unknown): string {
  if (!(error instanceof AxiosError)) {
    return error instanceof Error ? error.message : String(error);
  }
  const status = error.response?.status;
  const path = error.config?.url ?? '';
  if (status === 401) {
    return 'KanbanFlow rejected the API token (HTTP 401): it is wrong or was revoked. Create a new one in the board (board menu > Settings > API & Webhooks).';
  }
  if (status === 403) return `The API token has no access to "${path}" (HTTP 403).`;
  if (status === 404) return `Not found in KanbanFlow: "${path}" (HTTP 404). Check the id.`;
  if (status === 429) return 'KanbanFlow rate limit reached (HTTP 429). Wait a moment and retry.';
  if (status) {
    const details = error.response?.data ? ` ${JSON.stringify(error.response.data)}` : '';
    return `KanbanFlow answered HTTP ${status} for "${path}".${details}`;
  }
  return `Could not reach KanbanFlow (${error.code ?? error.message}). Check the network connection.`;
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof AxiosError)) return false;
  if (!error.response) return true;
  return error.response.status >= 500 || error.response.status === 429;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createKanbanflowClient(config: { apiKey: string; baseUrl: string }): KanbanflowClient {
  const http = axios.create({
    baseURL: config.baseUrl,
    timeout: REQUEST_TIMEOUT_MS,
    auth: { username: 'apiToken', password: config.apiKey },
  });

  async function get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await http.get<T>(path, { params });
        return response.data;
      } catch (error) {
        if (!isRetryable(error) || attempt >= MAX_RETRIES) {
          throw new ApiError(describeApiError(error), error instanceof AxiosError ? error.response?.status : undefined);
        }
        await delay(RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }

  // Follows `tasksLimited` / `nextTaskId` for one cell until it is complete.
  async function fetchRestOfCell(
    cell: ApiTaskCell
  ): Promise<{ tasks: ApiTask[]; complete: boolean; requests: number }> {
    const tasks = [...cell.tasks];
    let nextTaskId = cell.nextTaskId;
    let limited = cell.tasksLimited === true;
    let requests = 0;

    while (limited && nextTaskId && requests < MAX_PAGES_PER_CELL) {
      const params: Record<string, string | number> = {
        columnId: cell.columnId,
        startTaskId: nextTaskId,
        limit: PAGE_SIZE,
      };
      if (cell.swimlaneId) params.swimlaneId = cell.swimlaneId;
      const page = await get<ApiTaskCell | ApiTaskCell[]>('tasks', params);
      requests++;
      const pageCell = Array.isArray(page) ? page[0] : page;
      if (!pageCell) break;
      tasks.push(...pageCell.tasks);
      limited = pageCell.tasksLimited === true;
      nextTaskId = pageCell.nextTaskId;
    }

    return { tasks, complete: !limited, requests };
  }

  return {
    getBoard: () => get<ApiBoard>('board'),
    getUsers: () => get<ApiUser[]>('users'),
    getTask: (taskId) => get<ApiTask>(`tasks/${encodeURIComponent(taskId)}`),
    getTaskComments: (taskId) => get<ApiComment[]>(`tasks/${encodeURIComponent(taskId)}/comments`),
    // `board/events` returns at most 100 events, oldest first, plus `eventsLimited`.
    // The next page starts at the last timestamp; events already seen are skipped.
    async getEvents({ from, to }) {
      const events: ApiEvent[] = [];
      const seen = new Set<string>();
      let cursor = from;
      let limited = true;
      let requests = 0;
      while (limited && requests < MAX_EVENT_PAGES) {
        const params: Record<string, string> = {};
        if (cursor) params.from = cursor;
        if (to) params.to = to;
        const page = await get<ApiEventPage>('board/events', params);
        requests++;
        const fresh = page.events.filter((event) => !seen.has(event._id));
        for (const event of fresh) seen.add(event._id);
        events.push(...fresh);
        limited = page.eventsLimited === true && fresh.length > 0;
        cursor = page.events.at(-1)?.timestamp ?? cursor;
      }
      return { events, complete: !limited, requests };
    },
    async getAllTasks({ expandColumnIds } = {}) {
      const firstPage = await get<ApiTaskCell[]>('tasks');
      const shouldExpand = (cell: ApiTaskCell) =>
        expandColumnIds === 'all' || (expandColumnIds?.has(cell.columnId) ?? false);
      const results = await Promise.all(
        firstPage.map((cell) =>
          shouldExpand(cell)
            ? fetchRestOfCell(cell)
            : Promise.resolve({ tasks: cell.tasks, complete: cell.tasksLimited !== true, requests: 0 })
        )
      );
      return {
        cells: firstPage.map((cell, index) => ({
          columnId: cell.columnId,
          swimlaneId: cell.swimlaneId,
          tasks: results[index]?.tasks ?? [],
          complete: results[index]?.complete ?? false,
        })),
        requests: 1 + results.reduce((sum, result) => sum + result.requests, 0),
      };
    },
  };
}
