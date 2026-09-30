// KanbanFlow API shapes. Only the fields this server reads are typed; every
// other field the API returns is kept (index signature) and passed through.

export interface ApiUser {
  _id: string;
  fullName: string;
  email?: string;
  [key: string]: unknown;
}

export interface ApiLabel {
  name: string;
  pinned?: boolean;
}

export interface ApiTask {
  _id: string;
  name: string;
  description?: string;
  color?: string;
  columnId: string;
  swimlaneId?: string;
  responsibleUserId?: string;
  totalSecondsSpent?: number;
  totalSecondsEstimate?: number;
  collaborators?: { userId: string }[];
  labels?: ApiLabel[];
  subTasks?: { name: string; finished?: boolean; userId?: string }[];
  dates?: unknown[];
  [key: string]: unknown;
}

export interface ApiTaskCell {
  columnId: string;
  columnName?: string;
  swimlaneId?: string;
  swimlaneName?: string;
  tasksLimited?: boolean;
  nextTaskId?: string;
  tasks: ApiTask[];
}

export interface ApiBoard {
  _id: string;
  name: string;
  columns: { uniqueId: string; name: string; [key: string]: unknown }[];
  swimlanes?: { uniqueId: string; name: string; [key: string]: unknown }[];
  colors?: { name?: string; value: string; description?: string }[];
  [key: string]: unknown;
}

export interface ApiComment {
  _id: string;
  text: string;
  authorUserId?: string;
  createdTimestamp?: string;
  [key: string]: unknown;
}

export interface ApiEventDetail {
  eventType: string;
  taskId?: string;
  changedProperties?: { property: string; oldValue?: unknown; newValue?: unknown }[];
  [key: string]: unknown;
}

export interface ApiEvent {
  _id: string;
  userId?: string;
  timestamp: string;
  detailedEvents: ApiEventDetail[];
}

export interface ApiEventPage {
  eventsLimited?: boolean;
  events: ApiEvent[];
}
