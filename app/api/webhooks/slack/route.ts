import { after } from 'next/server';
import { log } from '@/lib/log';
import { bot, registerHandlers } from '@/lib/slack/bot';
import { duplicateReason } from '@/lib/slack/events';

// Creating a link runs after the response; give it room to finish.
export const maxDuration = 120;

let registered = false;

/** Slack button clicks and the amount form, forwarded and verified by Vercel Connect. */
export async function POST(request: Request): Promise<Response> {
  const skipped = duplicateReason(request);
  if (skipped) {
    log.info('skipped slack event', { reason: skipped });
    return new Response(null, { status: 200 });
  }
  if (!registered) {
    registerHandlers();
    registered = true;
  }
  // Slack wants an answer within 3 seconds; the work continues after the response.
  return bot().webhooks.slack(request, { waitUntil: (task) => after(() => task) });
}
