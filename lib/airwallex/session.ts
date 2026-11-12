import { randomUUID } from 'node:crypto';
import { createMCPClient } from '@ai-sdk/mcp';
import { getConnectorMetadata, getTokenResponse, startAuthorization, UserAuthorizationRequiredError } from '@vercel/connect';
import { connectAuthProvider } from '@vercel/connect/ai-sdk';
import { config } from '../config';
import { ALLOWED_TOOLS, checkServerUrl, SCOPES } from './tool-policy';

/**
 * Opens the Airwallex MCP server as one admin, through Vercel Connect. The project holds no
 * Airwallex key: each approving admin signs in once, and Vercel Connect keeps their login.
 */

export interface AirwallexCaller {
  /** Calls one allowed tool by name and returns the parsed JSON it answered with. */
  call: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
  close: () => Promise<void>;
}

type Login = { type: 'user'; id: string };

/** Each admin uses their own Airwallex login, keyed by their Slack user id. */
export const loginFor = (slackUserId: string): Login => ({ type: 'user', id: slackUserId });

const tokenParams = (login: Login) => ({ subject: login, scopes: [...SCOPES] });

// Looked up once per instance.
let serverUrl: string | undefined;

async function resolveServerUrl(): Promise<string> {
  if (serverUrl) return serverUrl;
  const { airwallexConnector, allowLiveAirwallex } = config();
  const meta = await getConnectorMetadata(airwallexConnector);
  const vendorUrl = meta.vendor?.serverUrl;
  const url = meta.clientUrl ?? (typeof vendorUrl === 'string' ? vendorUrl : undefined);
  if (!url) throw new Error(`failed to open Airwallex: connector ${airwallexConnector} has no server url`);
  checkServerUrl(url, allowLiveAirwallex);
  serverUrl = url;
  return url;
}

/** True when this admin already granted Till Inbox the payment link scopes. */
export async function isConnected(slackUserId: string): Promise<boolean> {
  try {
    await getTokenResponse(config().airwallexConnector, tokenParams(loginFor(slackUserId)));
    return true;
  } catch (error: unknown) {
    if (error instanceof UserAuthorizationRequiredError) return false;
    throw new Error('failed to check an Airwallex login', { cause: error });
  }
}

/** A sign-in link for an admin who hasn't connected Airwallex yet. */
export async function connectUrl(slackUserId: string, callbackUrl: string): Promise<string> {
  const { url } = await startAuthorization(config().airwallexConnector, tokenParams(loginFor(slackUserId)), { callbackUrl });
  return url;
}

/** Airwallex wraps raw API JSON in <api_response_…> tags inside a text part. */
const API_RESPONSE = /<api_response_[a-f0-9]+>\s*([\s\S]*?)\s*<\/api_response_[a-f0-9]+>/;

interface ToolResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
}

/** Extracts the JSON payload from an Airwallex MCP tool result. Throws if the call failed. */
export function parseApiResponse(toolName: string, result: unknown): unknown {
  const { isError, content = [] } = (result ?? {}) as ToolResult;
  const text = content.map((part) => part.text ?? '').join('\n');
  const match = text.match(API_RESPONSE);
  // The response text can hold customer data, so it stays out of the error (and the logs).
  if (isError || !match) throw new Error(`Airwallex ${toolName} failed${isError ? '' : ': no api response in the result'}`);
  try {
    return JSON.parse(match[1]);
  } catch {
    throw new Error(`Airwallex ${toolName} returned unreadable JSON`);
  }
}

export async function openAirwallex(slackUserId: string): Promise<AirwallexCaller> {
  const login = loginFor(slackUserId);
  const client = await createMCPClient({
    transport: {
      type: 'http',
      url: await resolveServerUrl(),
      authProvider: connectAuthProvider(config().airwallexConnector, tokenParams(login), { consent: 'eager' }),
    },
  });
  const listed = await client.listTools();
  const tools = client.toolsFromDefinitions({ ...listed, tools: listed.tools.filter((tool) => ALLOWED_TOOLS.includes(tool.name)) });
  const call = async (toolName: string, args: Record<string, unknown>): Promise<unknown> => {
    const tool = tools[toolName];
    if (!tool?.execute) throw new Error(`Airwallex tool ${toolName} is not available to this login`);
    const result = await tool.execute(args, { toolCallId: randomUUID(), messages: [] });
    return parseApiResponse(toolName, result);
  };
  return { call, close: () => client.close() };
}
