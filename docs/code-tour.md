# Code tour

```
app/api/webhooks/email/       Inbound email: size cap, rate limit, signature, replay check
app/api/webhooks/slack/       Slack button clicks and the amount form, verified by Vercel Connect
app/api/airwallex/connected/  The page the Airwallex sign-in returns to

lib/email/        The email provider
  provider.ts       The interface and the email DTO; another provider is one file
  resend.ts         Resend: read the webhook, fetch the email, send a reply
  signature.ts      Webhook signature check (the Svix scheme Resend uses)
  intake.ts         The order of checks on each webhook request
  guard.ts          Replay cache, rate limits, size caps

lib/agent/        The model
  extract.ts        Reads one email into the schema, with no tools
  instructions.ts   What it is told

lib/requests/     The payment request
  extraction.ts     What the model may report
  understand.ts     Checks the model: injection, sender checks, the amount
  amount.ts         Reads the amount and currency from the email with one strict grammar
  pending.ts        A request waiting for approval, carried in the buttons
  created.ts        A created link, carried in the buttons under it
  modal-context.ts  What the amount form carries between opening and submitting
  signed.ts         Signs and checks everything the buttons and the form carry
  fits.ts           Whether a request fits in Slack's limits everywhere it travels
  approval.ts       The approval state machine and who may press what
  reply.ts          The reply to the customer, written by code
  link-params.ts    The exact create_payment_link arguments
  clean.ts          Strips links and markup from email text

lib/airwallex/    Access to Airwallex
  tool-policy.ts    Scopes, the three tools, sandbox only
  session.ts        Opens the MCP server as one admin through Vercel Connect
  payment-links.ts  Create or reuse a link, read its status
  payments.ts       Puts those together for the flow

lib/flow/         The steps, independent of Slack
  inbound.ts        Email in: read, check, send approval cards
  decisions.ts      Approve, reject, set amount, has it been paid, send reply
  ports.ts          What the flow needs from Slack, Airwallex, the model and email
  fakes.ts          In-memory stand-ins for those, for tests and the simulation

lib/slack/        Slack, through the Chat SDK
  bot.ts            Wires the flow to Slack and the buttons to the flow
  cards.tsx         Approval cards, the amount form, the link message
  card-state.ts     Tells whether a card still shows its buttons
  events.ts         Drops Slack's retries
  text.ts           Keeps names and email text from acting as Slack markup

lib/config.ts     Every setting, validated at startup
lib/copy.ts       Every sentence the app says
lib/log.ts        One JSON line per log entry, with personal data redacted

scripts/          simulate.ts, read-email.ts and live-link.ts
fixtures/emails/  The four example emails, with the model readings recorded from real runs
docs/             The demo recording and these notes
```

Till Inbox keeps no database. A pending request travels inside the Slack buttons, signed with
`TILL_STATE_SECRET`, and its signature and contents are checked again every time it comes back.

## Adapt it

- **Another email provider.** Implement `EmailProvider` in `lib/email/provider.ts` (read and verify
  the webhook, fetch the email, send a reply) in one new file, and use it in
  `app/api/webhooks/email/route.ts` and `lib/slack/bot.ts`. Postmark and Mailgun both post inbound
  email as JSON; check how each one signs its webhook.
- **Invoices instead of payment links.** Replace `lib/requests/link-params.ts` and
  `lib/airwallex/payment-links.ts` with invoice calls, and add the billing scopes to
  `lib/airwallex/tool-policy.ts`. [Till in DMs](https://github.com/Cyvid7-Darus10/till-dm) shows the
  invoice calls and how it checks the invoice it created.
- **Another chat tool.** The flow talks to `ApprovalChat` in `lib/flow/ports.ts`. The Chat SDK has
  adapters for Teams, Google Chat and others; `lib/slack/bot.ts` is the part to rewrite.
