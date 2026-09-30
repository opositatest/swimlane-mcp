import type { ApiBoard, ApiTask, ApiUser } from '../types.js';

export const TASK_URL = (taskId: string) => `https://kanbanflow.com/t/${taskId}`;

export interface Ref {
  id: string;
  name: string;
}

export interface ColorRef {
  /** KanbanFlow color value, e.g. "red". */
  value: string;
  /** Name/description the team gave this color on the board, if any. */
  boardName?: string;
  boardDescription?: string;
}

export interface PersonMatch {
  users: Ref[];
  /** How the reference matched, so the model can judge how reliable it is. */
  matchedBy?: 'id' | 'email' | 'full name' | 'partial name';
}

/**
 * One board's structure + members, used to turn ids into names.
 * It never assigns meaning to a column, color or label: that is the model's job.
 */
export class BoardContext {
  constructor(
    readonly board: ApiBoard,
    readonly users: ApiUser[]
  ) {}

  get ref(): Ref {
    return { id: this.board._id, name: this.board.name };
  }

  column(id: string): Ref {
    const column = this.board.columns.find((c) => c.uniqueId === id);
    return { id, name: column?.name ?? `(column not on this board: ${id})` };
  }

  columnIndex(id: string): number {
    const index = this.board.columns.findIndex((c) => c.uniqueId === id);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  }

  swimlane(id: string | undefined): Ref | undefined {
    if (!id) return undefined;
    const swimlane = this.board.swimlanes?.find((s) => s.uniqueId === id);
    return { id, name: swimlane?.name ?? `(swimlane not on this board: ${id})` };
  }

  user(id: string): Ref {
    const user = this.users.find((u) => u._id === id);
    return { id, name: user?.fullName ?? `(user not on this board: ${id})` };
  }

  color(value: string | undefined): ColorRef | undefined {
    if (!value || value === 'none') return undefined;
    const boardColor = this.board.colors?.find((c) => c.value === value);
    return { value, boardName: boardColor?.name || undefined, boardDescription: boardColor?.description || undefined };
  }

  /**
   * Finds board members by id, email or full name; only if nothing matches exactly,
   * by part of the name. Every match is returned so nothing is silently dropped.
   */
  findPeople(reference: string): PersonMatch {
    const trimmed = reference.trim();
    const needle = trimmed.toLowerCase();
    const toRef = (u: ApiUser): Ref => ({ id: u._id, name: u.fullName });
    const tries: [NonNullable<PersonMatch['matchedBy']>, (u: ApiUser) => boolean][] = [
      ['id', (u) => u._id === trimmed],
      ['email', (u) => u.email?.toLowerCase() === needle],
      ['full name', (u) => u.fullName.toLowerCase() === needle],
      ['partial name', (u) => u.fullName.toLowerCase().includes(needle)],
    ];
    for (const [matchedBy, test] of tries) {
      const users = this.users.filter(test);
      if (users.length > 0) return { users: users.map(toRef), matchedBy };
    }
    return { users: [] };
  }

  /** People on a task: the responsible user (if the board uses it) plus collaborators. */
  people(task: ApiTask): { responsible?: Ref; collaborators: Ref[] } {
    return {
      responsible: task.responsibleUserId ? this.user(task.responsibleUserId) : undefined,
      collaborators: (task.collaborators ?? []).map((c) => this.user(c.userId)),
    };
  }

  /** Ids of everyone on a task, without duplicates. */
  peopleIds(task: ApiTask): Set<string> {
    const ids = [task.responsibleUserId, ...(task.collaborators ?? []).map((c) => c.userId)];
    return new Set(ids.filter((id): id is string => Boolean(id)));
  }
}

export const secondsToHours = (seconds: number | undefined) => Math.round(((seconds ?? 0) / 3600) * 100) / 100;
