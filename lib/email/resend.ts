import { z } from 'zod';
import { clipText } from './guard';
import {
  type AuthResult,
  authResultSchema,
  type EmailProvider,
  htmlToText,
  type InboundEmail,
  inboundEmailSchema,
  type OutboundEmail,
  parseAddress,
  type WebhookDelivery,
  type WebhookRequest,
} from './provider';
import { verifySignature } from './signature';

/**
 * Resend inbound email. Resend signs each webhook (Svix scheme) and sends metadata only, so the
 * email itself is fetched from the Received Emails API with the API key.
 * Docs: https://resend.com/docs/dashboard/receiving/introduction
 */

const API = 'https://api.resend.com';
const RECEIVED_EVENT = 'email.received';
const REQUEST_TIMEOUT_MS = 10_000;

const webhookSchema = z.object({
  type: z.string().max(100),
  data: z.object({ email_id: z.string().min(1).max(100).optional() }).passthrough(),
});

// Resend's documented fields. `authentication` is null on older emails; its exact shape is not
// pinned down in the docs, so anything unexpected reads as "unknown".
const receivedEmailSchema = z.object({
  id: z.string(),
  created_at: z.string(),
  from: z.string(),
  subject: z.string().nullable().optional(),
  message_id: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  html: z.string().nullable().optional(),
  authentication: z.record(z.string(), z.unknown()).nullable().optional(),
});

function authResult(value: unknown): AuthResult {
  const raw = typeof value === 'string' ? value : (value as { result?: unknown } | null)?.result;
  const parsed = authResultSchema.safeParse(typeof raw === 'string' ? raw.toLowerCase() : undefined);
  return parsed.success ? parsed.data : 'unknown';
}

/** Resend timestamps can come as `2026-11-12 08:30:00.123+00`; normalize to ISO 8601. */
function isoDate(value: string): string {
  const time = Date.parse(value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  if (Number.isNaN(time)) throw new Error('failed to read the received email: bad created_at');
  return new Date(time).toISOString();
}

/** Turns Resend's received-email JSON into the provider-neutral DTO. Exported for tests. */
export function toInboundEmail(json: unknown): InboundEmail {
  const email = receivedEmailSchema.parse(json);
  const from = parseAddress(email.from);
  if (!from) throw new Error('failed to read the received email: no valid From address');
  const body = email.text?.trim() || htmlToText(email.html ?? '');
  const { text, clipped } = clipText(body);
  return inboundEmailSchema.parse({
    id: email.id,
    messageId: email.message_id ?? null,
    receivedAt: isoDate(email.created_at),
    from,
    subject: (email.subject ?? '').slice(0, 300),
    text,
    clipped,
    auth: {
      spf: authResult(email.authentication?.spf),
      dkim: authResult(email.authentication?.dkim),
      dmarc: authResult(email.authentication?.dmarc),
    },
  });
}

/** Reads a verified Resend webhook. Exported for tests. */
export function readResendWebhook(secret: string, request: WebhookRequest, nowMs: number): WebhookDelivery {
  const check = verifySignature(
    secret,
    {
      id: request.headers.get('svix-id'),
      timestamp: request.headers.get('svix-timestamp'),
      signature: request.headers.get('svix-signature'),
    },
    request.rawBody,
    Math.floor(nowMs / 1000),
  );
  if (!check.ok) return { kind: 'rejected', reason: check.reason };
  let json: unknown;
  try {
    json = JSON.parse(request.rawBody);
  } catch {
    return { kind: 'rejected', reason: 'not-json' };
  }
  const event = webhookSchema.safeParse(json);
  if (!event.success) return { kind: 'rejected', reason: 'unexpected-shape' };
  if (event.data.type !== RECEIVED_EVENT) return { kind: 'ignored', deliveryId: check.id, eventType: event.data.type };
  const emailId = event.data.data.email_id;
  if (!emailId) return { kind: 'rejected', reason: 'no-email-id' };
  return { kind: 'email', deliveryId: check.id, emailId };
}

async function call(apiKey: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...init.headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // The response body can quote the email, so only the status goes into the error.
  if (!response.ok) throw new Error(`Resend ${init.method ?? 'GET'} ${path.split('/').slice(0, 3).join('/')} failed: ${response.status}`);
  return response.json();
}

export function resendProvider(apiKey: string, webhookSecret: string, replyFrom?: string): EmailProvider {
  return {
    name: 'resend',
    readWebhook: (request, nowMs) => readResendWebhook(webhookSecret, request, nowMs),
    fetchEmail: async (emailId) => toInboundEmail(await call(apiKey, `/emails/receiving/${encodeURIComponent(emailId)}`)),
    sendEmail: async (email: OutboundEmail) => {
      if (!replyFrom) throw new Error('failed to send a reply: TILL_REPLY_FROM is not set');
      const headers = email.inReplyTo ? { 'In-Reply-To': email.inReplyTo, References: email.inReplyTo } : undefined;
      const sent = z.object({ id: z.string() }).parse(
        await call(apiKey, '/emails', {
          method: 'POST',
          body: JSON.stringify({ from: replyFrom, to: [email.to], subject: email.subject, text: email.text, headers }),
        }),
      );
      return { id: sent.id };
    },
  };
}
