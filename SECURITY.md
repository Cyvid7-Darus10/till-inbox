# Security

Till Inbox is an open-source sample built on Airwallex. It is not an official Airwallex product and
is not supported by Airwallex. It is provided as is, without warranty, under the Apache License 2.0.
It handles untrusted email and creates payment links, so anyone who deploys it is responsible for
their own review, security, compliance and testing. See the README section "Disclaimer".

## Reporting a problem

Report security problems privately through GitHub: open the repository's Security tab and choose
"Report a vulnerability". Please don't open a public issue for them.

Include what you found, how to reproduce it, and what an attacker could do with it.

## What Till Inbox is designed to prevent

- An unsigned, altered or replayed webhook starting anything. The signature is checked before the
  email is fetched or anything else is done, and timestamps older than five minutes are refused.
- A flood of unsigned requests blocking real deliveries: failures count per source address, and
  only verified deliveries count against the global limit.
- An email changing the amount, the recipient of the reply, or what gets created. The model has no
  tools, the reply goes to the sender of the email, the reply text is written by code, and an email
  that tries to instruct an assistant gets no one-click Approve.
- A one-click Approve for an amount the email does not state plainly. The model only points;
  code reads the amount, and offers one-click Approve only when the email has a single, plain
  amount with its currency. Any other email goes to an admin to type the amount.
- Anyone who is not a listed admin approving, rejecting, setting an amount, checking a status or
  sending a reply.
- A button being reused on another message, or an Approve smuggled onto a card with no amount.
- Two payment links for one email, from a double click, a Slack retry, or a second admin. Within one
  server instance this is locked; across instances it relies on the cards closing first and on the
  reference lookup, which can miss in a narrow race (see "What it does not prevent").
- A link, mention or Slack formatting from the email reaching a card, the payment link or the reply.
- Header injection in a reply email, and replies emailed to a sender that did not pass DMARC.
- Anything going to the customer without an admin pressing a button, and anything at all while
  `TILL_SEND_REPLY_EMAIL` is off.
- The app talking to a live Airwallex server by accident (only the sandbox is allowed by default).

## What it does not prevent

- A spoofed sender that passes DMARC with a look-alike domain. The card shows the address and the
  DMARC result, but an admin still decides.
- An amount that is wrong but stated in the email. Read the email and the card before approving.
- Replays, rate limits and the click lock across server instances: they live in memory, per
  instance. Two approvals on different instances in the same second could both create a link.
- Forged Slack clicks by someone who can pull the project's environment: Vercel Connect forwards
  Slack's requests signed with the project's OIDC token, which `vercel env pull` also hands out.
- The admin lists itself: anyone who can change the Vercel project's settings can change who approves.
