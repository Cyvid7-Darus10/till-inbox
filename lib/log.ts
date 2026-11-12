// Structured logs, one JSON line each: timestamp, level, request_id, message, then context.
// Email bodies, addresses, names, tokens and amounts never belong in a log line. As a safety net,
// any context key that names one of them is replaced with "[redacted]".

type Level = 'info' | 'warn' | 'error';

export type LogContext = Record<string, unknown> & { requestId?: string };

const REDACTED_KEYS = /email|address|body|text|html|subject|name|token|secret|password|amount|reply/i;

function describe(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, cause: describe(value.cause) };
  return value;
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

export const log = {
  info: (message: string, context?: LogContext) => write('info', message, context),
  warn: (message: string, context?: LogContext) => write('warn', message, context),
  error: (message: string, context?: LogContext) => write('error', message, context),
};
