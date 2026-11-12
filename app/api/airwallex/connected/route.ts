import { COPY } from '@/lib/copy';

// The Airwallex sign-in returns here. Nothing is created from this page: the admin goes back to
// Slack and presses Approve again, so every approval comes from a verified Slack click.

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
};

/** A minimal page. The message is always one of Till Inbox's own strings, never user input. */
export function GET(): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Till Inbox</title>
<body style="font:16px system-ui;background:#F7F5EF;color:#0F5132;display:grid;place-items:center;min-height:90vh;margin:0 16px">
<p>${COPY.page.connected}</p></body>`;
  return new Response(html, { status: 200, headers: PAGE_HEADERS });
}
