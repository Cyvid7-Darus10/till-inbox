import { z } from 'zod';

/**
 * What Till Inbox needs from an inbound email provider. Resend is the one built in (resend.ts);
 * another provider is one more file that implements this interface.
 */

export const authResultSchema = z.enum(['pass', 'fail', 'none', 'unknown']);
export type AuthResult = z.infer<typeof authResultSchema>;

/** An email as the rest of the code sees it. Everything here came from the provider, not the model. */
export const inboundEmailSchema = z.object({
  /** The provider's id for this email. */
  id: z.string().min(1).max(100),
  /** The Message-ID header, for threading the reply. */
  messageId: z.string().max(300).nullable(),
  receivedAt: z.iso.datetime({ offset: true }),
  from: z.object({ address: z.email(), name: z.string().max(120).nullable() }),
  subject: z.string().max(300),
  /** Plain text, already cut to the model's limit. */
  text: z.string(),
  /** True when the text was cut. */
  clipped: z.boolean(),
  /** Sender checks the provider ran. A spoofed From address usually fails DMARC. */
  auth: z.object({ spf: authResultSchema, dkim: authResultSchema, dmarc: authResultSchema }),
});

export type InboundEmail = z.infer<typeof inboundEmailSchema>;

export interface WebhookRequest {
  headers: Headers;
  rawBody: string;
}

export type WebhookDelivery =
  /** A new email arrived. `deliveryId` identifies this delivery, `emailId` the email itself. */
  | { kind: 'email'; deliveryId: string; emailId: string }
  /** A verified event Till Inbox doesn't act on. */
  | { kind: 'ignored'; deliveryId: string; eventType: string }
  | { kind: 'rejected'; reason: string };

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  inReplyTo: string | null;
}

export interface EmailProvider {
  readonly name: string;
  /** Verifies the signature and reads the event. Never trusts anything unsigned. */
  readWebhook(request: WebhookRequest, nowMs: number): WebhookDelivery;
  /** Fetches the full email for a delivery. */
  fetchEmail(emailId: string): Promise<InboundEmail>;
  /** Sends a reply. Only called after an admin presses "Send reply". */
  sendEmail(email: OutboundEmail): Promise<{ id: string }>;
}

/** Splits `Mia Tran <mia@example.com>` into a name and an address. */
export function parseAddress(value: string): { address: string; name: string | null } | null {
  const angled = value.match(/^\s*"?([^"<]*?)"?\s*<([^<>\s]+@[^<>\s]+)>\s*$/);
  const bare = value.match(/^\s*([^<>\s]+@[^<>\s]+)\s*$/);
  const address = (angled?.[2] ?? bare?.[1] ?? '').toLowerCase();
  if (!z.email().safeParse(address).success) return null;
  const name = angled?.[1]?.trim() || null;
  return { address, name: name ? name.slice(0, 120) : null };
}

/** Rough HTML to text, for emails that have no text part. The result only ever goes to the model. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}
