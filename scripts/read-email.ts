// Runs the real model (through Vercel AI Gateway) on one fixture email and prints what it read and
// what the code kept. Needs `vercel env pull .env.local` for the OIDC token. Sends nothing anywhere.
// Usage: npm run read-email -- fixtures/emails/single-amount.json
import { readFile } from 'node:fs/promises';
import { modelExtractor } from '../lib/agent/extract';
import { toInboundEmail } from '../lib/email/resend';
import { understand } from '../lib/requests/understand';

const path = process.argv[2];
if (!path) throw new Error('usage: npm run read-email -- <fixture.json>');
const fixture = JSON.parse(await readFile(path, 'utf8'));
const email = toInboundEmail(fixture.email);
const extract = modelExtractor({
  model: process.env.TILL_MODEL ?? 'openai/gpt-5',
  reasoningEffort: 'low',
  companyName: process.env.TILL_COMPANY_NAME ?? 'Kopi Lane Roasters',
});
const reading = await extract(email);
console.info(JSON.stringify({ fixture: path, model: process.env.TILL_MODEL ?? 'openai/gpt-5', reading }, null, 2));
console.info(JSON.stringify({ kept: understand(email, reading, { maxAmount: 10_000 }) }, null, 2));
