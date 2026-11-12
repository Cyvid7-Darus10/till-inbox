# First real run

Till Inbox was run for real end to end on 13 November 2026, on the Airwallex sandbox, by the author,
with a production deployment, a real Resend inbox and a real Slack workspace. Checks were made on 12
and 13 November 2026. This page records what was run and how to repeat it on your own accounts.

## What was run

- The four example emails in `fixtures/emails/` were sent to the Resend receiving address. Each
  became an approval card in the admin's Slack DM about 10 to 16 seconds later.
- One plain amount (`single-amount.json`, AUD 640): one-click Approve. The first Approve asked the
  admin to connect their Airwallex sandbox. After that, Approve created one payment link in 5 to 10
  seconds, the reply with the link appeared in the thread, and "Has it been paid?" read the status
  back as not paid. The link was checked in the Airwallex web app and by its reference.
- Several numbers (`opening-order.json`, AUD 38 a kilo, AUD 950 in total): no Approve button. The
  admin typed AUD 950 in the "Set amount" form, then approved, and one link was created.
- No amount (`no-amount.json`): "Set amount" and "Reject" only.
- Injection attempt (`injection.json`): flagged, no one-click Approve, the amount left for a person.
  The test emails were sent from a domain that passes DMARC, so the "NOT VERIFIED" sender line was
  not seen live. The tests cover it.
- Duplicates: Approve pressed in two Slack windows at the same moment created one link (the second
  click was refused as busy). A double click sent Slack only one request. A webhook delivery
  replayed from Resend was ignored as a duplicate. Slack does not retry button clicks, so a Slack
  retry was not tested live.
- Reject closed the card with "Nothing was created".
- The webhook route refused unsigned requests (401) on production and on a preview.
- One fix came out of this run: the model sometimes flagged an honest "could you send me a link" as
  an instruction to it. Its instructions now say that a customer's request to the business is not
  one.

## What was not run

Sending the reply by email (`TILL_SEND_REPLY_EMAIL`, off by default), more than one admin, a live
Airwallex account, and real customers.

## Repeat it

1. Create the Resend account and receiving address, the webhook and the API key (step 4 of
   [Set it up](../README.md#set-it-up)).
2. Create and install the `slack/till-inbox` connector and attach it with triggers (step 2).
3. Set `TILL_ADMIN_SLACK_IDS`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `TILL_STATE_SECRET` and, for a sandbox with
   several accounts, `TILL_AIRWALLEX_ACCOUNT_ID`. Then deploy to production. The Airwallex sign-in
   returns to the production URL, which must be public.
4. Email the receiving address the text of `fixtures/emails/single-amount.json`.
5. In Slack: check the card, press Approve, connect the sandbox, press Approve again, and check that
   one link appears in Airwallex under Payments > Payment links. Press "Has it been paid?".
6. Try `fixtures/emails/opening-order.json` (several numbers) and `fixtures/emails/no-amount.json`
   with "Set amount", which also exercises the Slack form.
