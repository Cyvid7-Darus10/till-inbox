/**
 * What Till Inbox may do in Airwallex: the scopes an approving admin grants, and the only tools the
 * code calls. No model ever sees an Airwallex tool; the code calls these three by name.
 */

/** Request exactly this list every time: Vercel Connect matches a saved login by its scopes. */
export const SCOPES = ['r:awx_action:payment_links_view', 'w:awx_action:payment_links_edit'] as const;

/** Airwallex Developer MCP tool names, checked against the sandbox server on 2026-11-12. */
export const TOOL = {
  listAccounts: 'list_auth_org_accounts',
  createLink: 'create_payment_link',
  listLinks: 'list_payment_links',
} as const;

export const ALLOWED_TOOLS: readonly string[] = Object.values(TOOL);

/** The sandbox server. Anything else is refused unless TILL_ALLOW_LIVE_AIRWALLEX is true. */
export const SANDBOX_HOST = 'mcp.sandbox.airwallex.com';

export function checkServerUrl(url: string, allowLive: boolean): void {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    throw new Error('failed to open Airwallex: the connector has an invalid server url');
  }
  if (host !== SANDBOX_HOST && !allowLive) {
    throw new Error(`failed to open Airwallex: ${host} is not the sandbox. Set TILL_ALLOW_LIVE_AIRWALLEX=true to allow it.`);
  }
}
