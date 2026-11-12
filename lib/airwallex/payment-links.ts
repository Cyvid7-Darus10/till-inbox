import { z } from 'zod';
import type { PaymentLinkArgs } from '../requests/link-params';
import type { AirwallexCaller } from './session';
import { TOOL } from './tool-policy';

/**
 * Payment links in Airwallex, called by code with exact values. Airwallex's create call has no
 * idempotency key, so before creating, Till Inbox looks for a link that already carries this
 * request's reference and reuses it. After creating, it reads the answer back and compares it with
 * what was approved.
 */

const LOOKBACK_MS = 10 * 60 * 1000;
const PAGE_SIZE = 50;
const MAX_PAGES = 4;
const AMOUNT_TOLERANCE = 0.005;

export const paymentLinkSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  status: z.string(),
  active: z.boolean().optional(),
  amount: z.number().optional(),
  currency: z.string().optional(),
  reference: z.string().nullable().optional(),
  expires_at: z.string().nullable().optional(),
  created_at: z.string(),
});

export type PaymentLink = z.infer<typeof paymentLinkSchema>;

const linkListSchema = z.object({ items: z.array(paymentLinkSchema.passthrough()), has_more: z.boolean().optional() });
const accountListSchema = z.object({ items: z.array(z.object({ account_id: z.string(), name: z.string().optional() })) });

/** Airwallex answers with `+0000` offsets; the list filter wants `Z`. */
export const toIso = (value: string): string => {
  const time = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  if (Number.isNaN(time)) throw new Error('failed to read an Airwallex timestamp');
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');
};

export type AccountChoice = { ok: true; accountId: string } | { ok: false; problem: string };

/** Picks the account for payment links: the configured one if this login can see it, or the only one. */
export async function chooseAccount(airwallex: AirwallexCaller, configured: string | undefined): Promise<AccountChoice> {
  const { items } = accountListSchema.parse(await airwallex.call(TOOL.listAccounts, { page_size: 100 }));
  if (configured) {
    return items.some((item) => item.account_id === configured)
      ? { ok: true, accountId: configured }
      : { ok: false, problem: 'Your Airwallex login cannot reach the account in TILL_AIRWALLEX_ACCOUNT_ID.' };
  }
  if (items.length === 1) return { ok: true, accountId: items[0].account_id };
  const names = items.map((item) => item.name ?? 'unnamed').join(', ');
  return {
    ok: false,
    problem: `Your Airwallex login can reach ${items.length} accounts (${names}). Set TILL_AIRWALLEX_ACCOUNT_ID to one.`,
  };
}

async function* recentLinks(airwallex: AirwallexCaller, accountId: string, since: Date): AsyncGenerator<PaymentLink> {
  const from = new Date(since.getTime() - LOOKBACK_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { items, has_more } = linkListSchema.parse(
      await airwallex.call(TOOL.listLinks, { account_id: accountId, from_created_at: from, page_num: page, page_size: PAGE_SIZE }),
    );
    yield* items;
    if (!has_more) return;
  }
}

/** A link already made for this reference since `since`, if any. */
export async function findByReference(
  airwallex: AirwallexCaller,
  accountId: string,
  reference: string,
  since: Date,
): Promise<PaymentLink | null> {
  for await (const link of recentLinks(airwallex, accountId, since)) if (link.reference === reference) return link;
  return null;
}

/** Lists every way a link differs from what was approved. Empty means it matches. */
export function findMismatches(link: PaymentLink, args: PaymentLinkArgs): string[] {
  const problems: string[] = [];
  if (link.currency !== undefined && link.currency !== args.currency)
    problems.push(`currency is ${link.currency}, approved ${args.currency}`);
  if (link.amount !== undefined && Math.abs(link.amount - args.amount) > AMOUNT_TOLERANCE) {
    problems.push(`amount is ${link.amount}, approved ${args.amount}`);
  }
  if (link.reference && link.reference !== args.reference) problems.push('it carries another reference');
  if (!link.url.startsWith('https://')) problems.push('its address is not https');
  return problems;
}

export type LinkResult = { ok: true; link: PaymentLink; reused: boolean } | { ok: false; problem: string };

/** Creates the approved link, or returns the one already made for this request. */
/** `since` is when the email arrived: no link for this request can be older. */
export async function createOrReuse(airwallex: AirwallexCaller, args: PaymentLinkArgs, since: Date): Promise<LinkResult> {
  const existing = await findByReference(airwallex, args.account_id, args.reference, since);
  const link = existing ?? paymentLinkSchema.parse(await airwallex.call(TOOL.createLink, { ...args }));
  const problems = findMismatches(link, args);
  if (problems.length > 0) {
    return { ok: false, problem: `The link Airwallex returned doesn't match the approval (${problems.join('; ')}). Don't send it.` };
  }
  return { ok: true, link, reused: existing !== null };
}

export interface LinkStatus {
  status: string;
  active: boolean | null;
  expiresAt: string | null;
}

/** Looks a link up by id, starting from when it was created. Null if Airwallex no longer lists it. */
export async function linkStatus(
  airwallex: AirwallexCaller,
  accountId: string,
  linkId: string,
  createdAt: string,
): Promise<LinkStatus | null> {
  for await (const link of recentLinks(airwallex, accountId, new Date(toIso(createdAt)))) {
    if (link.id === linkId) return { status: link.status, active: link.active ?? null, expiresAt: link.expires_at ?? null };
  }
  return null;
}
