// Till Inbox only reacts to its own buttons and its amount form. Slack resends a delivery it thinks
// timed out; the work for the first one is already running, so a retry is acknowledged and dropped.

/** Why this Slack delivery should be acknowledged without handling, or null to handle it. */
export function duplicateReason(request: Request): string | null {
  return request.headers.get('x-slack-retry-num') ? 'slack retry' : null;
}
