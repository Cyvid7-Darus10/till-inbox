import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_WEBHOOK_BYTES } from '../lib/email/guard';
import { ADMIN, STATE_SECRET, TEST_SECRET } from './fixtures';

// Placeholder settings so the routes can load their config. None is a real key or id.
const ENV = {
  TILL_ADMIN_SLACK_IDS: ADMIN,
  RESEND_API_KEY: 're_placeholder_not_real',
  RESEND_WEBHOOK_SECRET: TEST_SECRET,
  TILL_STATE_SECRET: STATE_SECRET,
};

beforeAll(() => {
  for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const slackClick = (headers: Record<string, string> = {}) =>
  new Request('https://till-inbox.example/api/webhooks/slack', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: `payload=${encodeURIComponent(JSON.stringify({ type: 'block_actions', user: { id: ADMIN }, actions: [] }))}`,
  });

describe('the Slack route', () => {
  it('refuses a click with no Vercel OIDC bearer token', async () => {
    const { POST } = await import('../app/api/webhooks/slack/route');
    const response = await POST(slackClick());
    expect(response.status).toBe(401);
  });

  it('refuses a click with a bearer token that is not a valid OIDC token', async () => {
    const { POST } = await import('../app/api/webhooks/slack/route');
    const response = await POST(slackClick({ authorization: 'Bearer not-a-real-token' }));
    expect(response.status).toBe(401);
  });
});

describe('the email route', () => {
  it('refuses a body declared larger than the cap before reading it', async () => {
    const { POST } = await import('../app/api/webhooks/email/route');
    const request = new Request('https://till-inbox.example/api/webhooks/email', {
      method: 'POST',
      headers: { 'content-length': String(MAX_WEBHOOK_BYTES + 1) },
      body: '{}',
    });
    const response = await POST(request);
    expect(response.status).toBe(413);
  });

  it('refuses an unsigned delivery', async () => {
    const { POST } = await import('../app/api/webhooks/email/route');
    const request = new Request('https://till-inbox.example/api/webhooks/email', { method: 'POST', body: '{"type":"email.received"}' });
    expect((await POST(request)).status).toBe(401);
  });
});
