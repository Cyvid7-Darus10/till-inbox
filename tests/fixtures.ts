import { readFileSync } from 'node:fs';
import { toInboundEmail } from '../lib/email/resend';
import type { Extraction } from '../lib/requests/extraction';

/** The four fixture emails, with the model readings recorded from a real run. */
export type FixtureName = 'single-amount' | 'opening-order' | 'no-amount' | 'injection';

export function loadFixture(name: FixtureName) {
  const raw = JSON.parse(readFileSync(new URL(`../fixtures/emails/${name}.json`, import.meta.url), 'utf8'));
  return { raw, email: toInboundEmail(raw.email), reading: raw.modelReading as Extraction };
}

export const ADMIN = 'UADMIN0001';
export const OTHER_ADMIN = 'UADMIN0002';
export const OUTSIDER = 'UOUTSIDE01';
/** Signs the state carried in Slack buttons in tests. Not a real secret. */
export const STATE_SECRET = 'a test state secret for slack buttons, not a real one';
export const TEST_SECRET = `whsec_${Buffer.from('a test signing secret, not a real one').toString('base64')}`;
