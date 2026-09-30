import { z } from 'zod';

export const DEFAULT_BASE_URL = 'https://kanbanflow.com/api/v1';

// A value a client left unset: empty, or a placeholder it did not substitute
// (e.g. Claude Desktop extensions pass `${user_config.x}` for an empty optional field).
const isUnset = (value: string | undefined) => !value || !value.trim() || /^\$\{[^}]*\}$/.test(value.trim());

const optionalText = z
  .string()
  .optional()
  .transform((value) => (isUnset(value) ? undefined : value?.trim()));

const configSchema = z.object({
  KANBANFLOW_API_KEY: optionalText,
  KANBANFLOW_API_KEYS: optionalText,
  KANBANFLOW_USER: optionalText,
  KANBANFLOW_USER_ID: optionalText,
  KANBANFLOW_BASE_URL: optionalText,
});

const WHERE_TO_GET_A_TOKEN = 'Each token is created per board in KanbanFlow: board menu > Settings > API & Webhooks.';

export interface Config {
  /** One API token per board. KanbanFlow tokens always belong to exactly one board. */
  apiKeys: string[];
  /** Who "me" is: a KanbanFlow user id, email or full name. Email works best across boards. */
  user?: string;
  baseUrl: string;
}

/**
 * Splits pasted tokens however they came: commas, semicolons, spaces or new lines,
 * with or without quotes or brackets (e.g. `"a", "b"` or `["a","b"]`).
 */
export function parseApiKeys(...values: (string | undefined)[]): string[] {
  const keys = values.flatMap((value) => (value ?? '').replace(/[[\]"'`]/g, ' ').split(/[\s,;]+/)).filter(Boolean);
  const invalid = keys.findIndex((key) => !/^[A-Za-z0-9_-]+$/.test(key));
  if (invalid !== -1) {
    throw new Error(
      `API token #${invalid + 1} contains characters a KanbanFlow token cannot have. Copy it again from KanbanFlow. ${WHERE_TO_GET_A_TOKEN}`
    );
  }
  return [...new Set(keys)];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const data = configSchema.parse(env);
  const apiKeys = parseApiKeys(data.KANBANFLOW_API_KEY, data.KANBANFLOW_API_KEYS);
  if (apiKeys.length === 0) {
    throw new Error(`No KanbanFlow API token is configured. ${WHERE_TO_GET_A_TOKEN}`);
  }

  const baseUrl = data.KANBANFLOW_BASE_URL ?? DEFAULT_BASE_URL;
  if (!z.url().safeParse(baseUrl).success) {
    throw new Error(`KANBANFLOW_BASE_URL is not a valid URL: "${baseUrl}".`);
  }

  return {
    apiKeys,
    // KANBANFLOW_USER_ID is the name used by earlier versions.
    user: data.KANBANFLOW_USER ?? data.KANBANFLOW_USER_ID,
    baseUrl,
  };
}
