import { createHash } from 'node:crypto';

// Structured logs, one JSON line each: timestamp, level, request_id, message, then context.
// Email bodies, addresses, names, tokens and amounts never belong in a log line. As a safety net,
// any context key that names one of them is replaced with "[redacted]".

type Level = 'info' | 'warn' | 'error';

export type LogContext = Record<string, unknown> & { requestId?: string };

const REDACTED_KEYS = /email|address|body|text|html|subject|name|token|secret|password|amount|reply/i;

const MAX_MESSAGE_LENGTH = 300;

function describe(value: unknown): unknown {
  if (!(value instanceof Error)) return value;
  // AI SDK errors (names start with AI_) can quote the model's output, which holds email content.
  if (value.name.startsWith('AI_')) return { name: value.name };
  return { name: value.name, message: value.message.slice(0, MAX_MESSAGE_LENGTH), cause: describe(value.cause) };
}

/** Builds one log line. Exported for tests. */
export function formatLine(level: Level, message: string, context: LogContext = {}, now: Date = new Date()): string {
  const { requestId, ...rest } = context;
  const fields = Object.fromEntries(
    Object.entries(rest).map(([key, value]) => [key, REDACTED_KEYS.test(key) ? '[redacted]' : describe(value)]),
  );
  return JSON.stringify({ timestamp: now.toISOString(), level, request_id: requestId ?? null, message, ...fields });
}

function write(level: Level, message: string, context?: LogContext): void {
  const line = formatLine(level, message, context);
  if (level === 'error') console.error(line);
  else console.info(line);
}

/** Hex characters kept from a user tag: enough to tell admins apart in the logs. */
const USER_TAG_LENGTH = 8;

/**
 * A short tag for a Slack user, for logs: the first 8 hex characters of SHA-256 over the secret and
 * the id. The same person gets the same tag, but the id itself never reaches a log line.
 */
export const userTag = (slackUserId: string, secret: string): string =>
  createHash('sha256').update(`${secret}\n${slackUserId}`).digest('hex').slice(0, USER_TAG_LENGTH);

export const log = {
  info: (message: string, context?: LogContext) => write('info', message, context),
  warn: (message: string, context?: LogContext) => write('warn', message, context),
  error: (message: string, context?: LogContext) => write('error', message, context),
};
