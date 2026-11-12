import type { Payments } from '../flow/ports';
import { expiryFrom, linkArgs } from '../requests/link-params';
import { chooseAccount, createOrReuse, linkStatus } from './payment-links';
import { type AirwallexCaller, connectUrl, isConnected, openAirwallex } from './session';

/** The real Payments port: Airwallex through Vercel Connect, as the admin who pressed the button. */

export interface AirwallexSettings {
  accountId: string | undefined;
  linkExpiryDays: number;
  /** Where the Airwallex sign-in returns to. */
  callbackUrl: () => string;
}

async function asAdmin<T>(slackUserId: string, work: (airwallex: AirwallexCaller) => Promise<T>): Promise<T> {
  const airwallex = await openAirwallex(slackUserId);
  try {
    return await work(airwallex);
  } finally {
    await airwallex.close();
  }
}

export function airwallexPayments(settings: AirwallexSettings): Payments {
  return {
    isConnected,
    connectUrl: (slackUserId) => connectUrl(slackUserId, settings.callbackUrl()),
    create: (slackUserId, pending, now) =>
      asAdmin(slackUserId, async (airwallex) => {
        const account = await chooseAccount(airwallex, settings.accountId);
        if (!account.ok) return { ok: false as const, problem: account.problem };
        const expiresAt = expiryFrom(now, settings.linkExpiryDays);
        const result = await createOrReuse(airwallex, linkArgs(pending, account.accountId, expiresAt), new Date(pending.receivedAt));
        return { ...result, accountId: account.accountId, expiresAt };
      }),
    status: (slackUserId, created) =>
      asAdmin(slackUserId, (airwallex) => linkStatus(airwallex, created.link.accountId, created.link.id, created.link.createdAt)),
  };
}
