# Security

## Reporting a problem

Report security problems privately through GitHub: open the repository's Security tab and choose
"Report a vulnerability". Please don't open a public issue for them.

Include what you found, how to reproduce it, and what an attacker could do with it.

## What Till Inbox is designed to prevent

- An unsigned, altered or replayed webhook starting anything. The signature is checked before the
  body is read, and timestamps older than five minutes are refused.
- An email changing the amount, the recipient of the reply, or what gets created. The model has no
  tools, the reply goes to the sender of the email, the reply text is written by code, and an email
  that tries to instruct an assistant gets no one-click Approve.
- An amount the email never stated. The model must quote the words, and code checks the quote.
- Anyone who is not a listed admin approving, rejecting, setting an amount, checking a status or
  sending a reply.
- A button being reused on another message, or an Approve smuggled onto a card with no amount.
- Two payment links for one email, from a double click, a Slack retry or two admins at once.
- Anything going to the customer without an admin pressing a button, and anything at all while
  `TILL_SEND_REPLY_EMAIL` is off.
- The app talking to a live Airwallex server by accident (only the sandbox is allowed by default).

## What it does not prevent

- A spoofed sender. Till Inbox shows the SPF, DKIM and DMARC results and warns when they fail, but
  an admin still decides.
- An amount that is wrong but stated in the email. Read the email and the card before approving.
- Replays and rate limits across server instances: the caches live in memory, per instance.
- The admin lists itself: anyone who can change the Vercel project's settings can change who approves.
