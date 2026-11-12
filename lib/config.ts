import { z } from 'zod';
import { MAX_APPROVAL_CARDS } from './requests/pending';
import { SLACK_USER_ID } from './slack/user-id';

/**
 * Every setting Till Inbox uses, validated once at startup. The server refuses to start if one is
 * missing or invalid, and the error names the variable.
 *
 * Two values are secrets, both from the email provider: RESEND_API_KEY and RESEND_WEBHOOK_SECRET.
 * Slack and Airwallex need none: Vercel Connect holds those logins.
 */

const commaList = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const schema = z
  .object({
    /** Slack user ids who approve payment links. Each gets the approval card in a DM. */
    adminSlackIds: z
      .string({ error: 'required (comma-separated Slack user ids)' })
      .transform(commaList)
      .pipe(
        z
          .array(z.string().regex(SLACK_USER_ID, 'not a Slack user id'))
          .min(1, 'needs at least one Slack user id')
          .max(MAX_APPROVAL_CARDS, `at most ${MAX_APPROVAL_CARDS} admins (one approval card each)`),
      ),
    /** Vercel Connect connector for the Slack app. */
    slackConnector: z.string().min(1).default('slack/till-inbox'),
    /** Vercel Connect connector for the Airwallex Developer MCP server (sandbox). */
    airwallexConnector: z.string().min(1).default('airwallex/till-sandbox'),
    /** Which Airwallex account gets the payment links. Optional when the login can see only one. */
    airwallexAccountId: z
      .string()
      .regex(/^acct_[\w-]{6,40}$/, 'not an Airwallex account id (acct_...)')
      .optional(),
    /** Off by default: Till Inbox refuses any Airwallex MCP server that is not the sandbox. */
    allowLiveAirwallex: flag,
    /** Signs the reply and appears in the model's instructions. */
    companyName: z.string().min(1).max(80).default('our team'),
    /** Model, through Vercel AI Gateway. */
    model: z.string().min(1).default('openai/gpt-5'),
    modelReasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).default('low'),
    /** How long a new payment link stays payable. */
    linkExpiryDays: z.coerce.number().int().min(1).max(90).default(7),
    /** Largest amount a link may ask for. Anything above needs a smaller amount first. */
    maxAmount: z.coerce.number().positive().max(1_000_000).default(10_000),
    /** Resend API key, used to read the received email (and to send the reply, if turned on). Secret. */
    resendApiKey: z.string({ error: 'required (a Resend API key, re_...)' }).regex(/^re_\w{8,}$/, 'not a Resend API key (re_...)'),
    /** Signing secret of the Resend webhook. Secret. */
    resendWebhookSecret: z
      .string({ error: 'required (the Resend webhook signing secret, whsec_...)' })
      .regex(/^whsec_[A-Za-z0-9+/=]{16,}$/, 'not a webhook signing secret (whsec_...)'),
    /** Off by default. When on, an admin can press "Send reply" to email the customer. */
    sendReplyEmail: flag,
    /** The From address for reply emails, on a domain verified in Resend. Required when sending is on. */
    replyFrom: z.email('not an email address').optional(),
    /** Inbound emails accepted per minute, per server instance. */
    inboundPerMinute: z.coerce.number().int().min(1).max(600).default(30),
    /** Inbound emails accepted per sender address per hour, per server instance. */
    inboundPerSenderPerHour: z.coerce.number().int().min(1).max(100).default(5),
  })
  .refine((value) => !value.sendReplyEmail || value.replyFrom, {
    path: ['replyFrom'],
    message: 'required when TILL_SEND_REPLY_EMAIL is true',
  });

export type Config = z.infer<typeof schema>;

/** The environment variable behind each setting. */
const ENV_NAMES: Record<keyof Config, string> = {
  adminSlackIds: 'TILL_ADMIN_SLACK_IDS',
  slackConnector: 'TILL_SLACK_CONNECTOR',
  airwallexConnector: 'TILL_AIRWALLEX_CONNECTOR',
  airwallexAccountId: 'TILL_AIRWALLEX_ACCOUNT_ID',
  allowLiveAirwallex: 'TILL_ALLOW_LIVE_AIRWALLEX',
  companyName: 'TILL_COMPANY_NAME',
  model: 'TILL_MODEL',
  modelReasoningEffort: 'TILL_MODEL_REASONING_EFFORT',
  linkExpiryDays: 'TILL_LINK_EXPIRY_DAYS',
  maxAmount: 'TILL_MAX_AMOUNT',
  resendApiKey: 'RESEND_API_KEY',
  resendWebhookSecret: 'RESEND_WEBHOOK_SECRET',
  sendReplyEmail: 'TILL_SEND_REPLY_EMAIL',
  replyFrom: 'TILL_REPLY_FROM',
  inboundPerMinute: 'TILL_INBOUND_PER_MINUTE',
  inboundPerSenderPerHour: 'TILL_INBOUND_PER_SENDER_PER_HOUR',
};

/** Reads config from an environment object. Throws with every problem listed, never with a value. */
export function readConfig(env: Record<string, string | undefined>): Config {
  // An empty variable counts as unset, so its default applies.
  const raw = Object.fromEntries(Object.entries(ENV_NAMES).map(([key, name]) => [key, env[name]?.trim() || undefined]));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${ENV_NAMES[issue.path[0] as keyof Config] ?? issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid Till Inbox configuration: ${problems}`);
  }
  return parsed.data;
}

let cached: Config | undefined;

/** The validated config for this process. Read on first use; instrumentation.ts reads it at boot. */
export function config(): Config {
  cached ??= readConfig(process.env);
  return cached;
}

export const isAdmin = (slackUserId: string): boolean => config().adminSlackIds.includes(slackUserId);
