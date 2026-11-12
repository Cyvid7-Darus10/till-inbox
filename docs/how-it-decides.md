# How Till Inbox decides

This page explains how an email becomes an approval card, when one-click Approve is offered, and what
the code protects against. The short version is in the [README](../README.md#how-it-works).

## Nothing is created before approval

An email only ever produces an approval card. The link is created after an admin presses Approve,
with that admin's own Airwallex login. The first time, the admin gets a sign-in button instead. The
sign-in page creates nothing: the admin goes back to Slack and presses Approve again, so every
approval comes from a verified Slack click.

## Nothing is sent to the customer by default

The reply appears in the Slack thread for the admin to copy. Sending it by email is off unless you set
`TILL_SEND_REPLY_EMAIL=true` (which also needs `TILL_REPLY_FROM`, an address on a domain verified in
Resend). Even then it takes an admin pressing "Send reply", and the reply is never emailed to a
sender who did not pass DMARC. The payment link is created without `shopper_email`, so Airwallex does
not email the customer either.

## The amount rule

The model reads the email and points at the amount with a short quote. Code then reads the amount
from the email itself (`lib/requests/amount.ts`). One-click Approve is offered only when all of these
hold:

- The email contains exactly one number that could be an amount. Dates, times and international
  phone numbers are left out, and only when they are plainly written as such.
- That number is written plainly with its currency: an ISO code or a symbol that names one currency
  (`$` alone names none), at most two decimals, thousands commas in the right places.
- Nothing next to it makes it a rate, an estimate, or a stale or negated figure ("per", "each",
  "about", "was", "not", and similar), and no word next to it is longer than 40 characters.
- It is what the model read, in the same currency.
- It is not above `TILL_MAX_AMOUNT` (10,000 by default).
- The email was not cut to fit the 8,000-character limit, and it does not look like it tries to
  instruct an assistant.

Otherwise the card has no Approve button, only "Set amount" and "Reject", and lists the amounts the
email mentions. The admin types the amount, which redraws the card with an Approve button, and then
approves. A typed amount is held to the same `TILL_MAX_AMOUNT`, and Approve checks the limit once
more before creating anything, so a limit lowered after the card was posted still applies. Most real
emails with line items, unit prices or several figures will need an admin to type the amount.
Remaining edge cases are not chased in code: anything unclear is typed by a person.

## The email is untrusted input

- The webhook signature is checked before the email is fetched (`lib/email/intake.ts`). Old
  timestamps (over five minutes) are refused, each delivery and each email is handled once, and the
  body is capped at 64 KB.
- The model gets the email as JSON data, with no tools at all. It can only fill in a fixed schema
  (`lib/requests/extraction.ts`).
- An email that tries to instruct an assistant ("ignore previous instructions", "the correct amount
  is...") is flagged, by the model and by a separate check in code (`lib/requests/understand.ts`),
  and gets no one-click Approve.
- The reply goes to the email's sender, taken from the provider, never from the model or the body.
  The reply text is a template, and its subject is fixed text with your company name.

## Only admins decide, once

`TILL_ADMIN_SLACK_IDS` lists who may press anything. Each card's buttons carry the request, signed
with `TILL_STATE_SECRET` (HMAC-SHA256, `lib/requests/signed.ts`), and so do the buttons under a link
and the amount form. A click whose value has a missing or wrong signature is logged and ignored.
Every click is then validated again (`lib/requests/approval.ts`): the clicker must be an admin, the button must
belong to a card posted for this request (or, for the buttons under a link, to the DM where it was
approved), and the action must be one that card offers. Approve and Reject replace every card with a
version without buttons, so the first decision wins and later clicks do nothing.

Airwallex's create call has no idempotency key. Before creating, the app looks for a link that
already carries this request's reference and reuses it, as long as it is still active and matches.

## No Slack or Airwallex keys

Vercel Connect forwards Slack's requests to the app, signed with the project's Vercel OIDC token, and
holds each admin's Airwallex login. The app asks only for the payment link scopes, calls three tools
by name (`list_auth_org_accounts`, `create_payment_link`, `list_payment_links`) with values it
computed itself, and refuses any Airwallex server other than the sandbox unless
`TILL_ALLOW_LIVE_AIRWALLEX=true` (`lib/airwallex/tool-policy.ts`).

## Security notes

What the code protects against:

- **Forged or replayed webhooks.** No valid signature, no work. Requests that fail the signature
  check count against the sender's address only, so a flood of them can't use up the limit that
  real deliveries share. Only verified deliveries count against the global limit.
- **Spoofed senders.** A sender counts as verified only when the email passed DMARC, because SPF and
  DKIM can pass for a different domain than the visible From address. Every card shows a "Sender
  check" line, and an unverified sender reads "NOT VERIFIED". Resend results other than pass, fail
  and none (for example "gray") count as not verified.
- **Links and markup planted in an email.** Every field taken from an email (name, company, what it
  is for, the subject, the model's note) is cleaned before it reaches Slack, Airwallex or the reply
  (`lib/requests/clean.ts`). Text is normalized first (full-width letters, look-alike dots,
  zero-width and direction characters). Then anything that looks like a URL, an email address or a
  hostname with any top-level domain, punycode included, is removed, and only letters, digits,
  spaces and common punctuation are kept. So no link, mention or Slack formatting gets through.
- **Emails built to stall the parsers.** Every parser of email text has a hard cap and linear-time
  patterns: the webhook body is capped at 64 KB, HTML at 200,000 characters, the text the model and
  the amount check read at 8,000, a From header at 400 and each cleaned field at 1,000. A longer
  field is dropped rather than cut, and a cut email gets no one-click Approve.
  `tests/pathological-input.test.ts` feeds each parser hostile input and checks it finishes quickly.
- **Header injection.** The reply's subject is fixed text, the recipient is a validated address, and
  the original Message-ID is used for threading only if it is a single well-formed line.
- **Personal data in logs.** Logs carry ids, counts and fixed codes. Fields whose names suggest
  personal data are redacted, and errors from the AI SDK, which can quote the model's output, are
  logged by name only.
- **Wrong or unexpected links.** A link is shown only if Airwallex returned it on an https
  airwallex.com address with the approved amount and currency.

What stays your responsibility as the deployer:

- Who can change the Vercel project. Anyone who can edit its settings can change the admin list or
  the state secret. The Slack route accepts any Vercel OIDC token for the project, so someone who
  holds such a token and also knows `TILL_STATE_SECRET` could still forge a click as an admin. Mark
  the secret as Sensitive and use a different value in each environment.
- A shared store and a firewall rule for heavier use: the replay cache, rate limits and click lock
  are per server instance (see [Limits](../README.md#limits)). Add a Vercel Firewall rate limit rule
  on `/api/webhooks/email`.
- Keeping `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` and `TILL_STATE_SECRET` secret, and rotating
  them if they leak. Rotating `TILL_STATE_SECRET` makes the buttons on cards already posted stop
  working; those requests need a new email.
- Reading the card. A wrong amount that the email itself states, or a lookalike company name, still
  needs a person to notice.

## Smaller limits

The main limits are in the [README](../README.md#limits). These are smaller ones:

- The amount quote may come from anywhere in the email, including an older message quoted below the
  new one. The card shows the amount; check it against the latest message.
- The check for an existing link reads at most 200 links created since shortly before the email
  arrived.
- The email is read after the webhook answers. If that fails, the error is logged and the provider
  does not retry.
- If two admins edit the amount at the same moment, the last one wins.
- A failed "Send reply" removes the button anyway; copy the reply from the thread instead.

To report a security problem, see [SECURITY.md](../SECURITY.md).
