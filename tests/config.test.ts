import { describe, expect, it } from 'vitest';
import { readConfig } from '../lib/config';
import { TEST_SECRET } from './fixtures';

// Placeholder values in the right shape. None of them is a real key or id.
const minimal = {
  TILL_ADMIN_SLACK_IDS: 'UADMIN0001, UADMIN0002',
  RESEND_API_KEY: 're_placeholder_not_real',
  RESEND_WEBHOOK_SECRET: TEST_SECRET,
};

describe('config', () => {
  it('reads the required settings and applies safe defaults', () => {
    const config = readConfig(minimal);
    expect(config.adminSlackIds).toEqual(['UADMIN0001', 'UADMIN0002']);
    expect(config).toMatchObject({
      slackConnector: 'slack/till-inbox',
      airwallexConnector: 'airwallex/till-sandbox',
      allowLiveAirwallex: false,
      sendReplyEmail: false,
      linkExpiryDays: 7,
      maxAmount: 10_000,
    });
  });

  it('names every missing variable, and never prints a value', () => {
    expect(() => readConfig({})).toThrow(/TILL_ADMIN_SLACK_IDS: required.*RESEND_API_KEY: required.*RESEND_WEBHOOK_SECRET: required/);
    expect(() => readConfig({ ...minimal, RESEND_API_KEY: 'sk_live_wrong_kind' })).toThrow(/RESEND_API_KEY: not a Resend API key/);
    try {
      readConfig({ ...minimal, RESEND_API_KEY: 'sk_live_wrong_kind' });
    } catch (error) {
      expect(String(error)).not.toContain('sk_live_wrong_kind');
    }
  });

  it('refuses bad admin ids, too many admins and bad numbers', () => {
    expect(() => readConfig({ ...minimal, TILL_ADMIN_SLACK_IDS: 'alex' })).toThrow('TILL_ADMIN_SLACK_IDS: not a Slack user id');
    expect(() => readConfig({ ...minimal, TILL_ADMIN_SLACK_IDS: 'UA0001,UA0002,UA0003,UA0004,UA0005,UA0006' })).toThrow('at most 5');
    expect(() => readConfig({ ...minimal, TILL_LINK_EXPIRY_DAYS: '0' })).toThrow('TILL_LINK_EXPIRY_DAYS');
    expect(() => readConfig({ ...minimal, TILL_AIRWALLEX_ACCOUNT_ID: 'Company account' })).toThrow('TILL_AIRWALLEX_ACCOUNT_ID');
    expect(() => readConfig({ ...minimal, TILL_SEND_REPLY_EMAIL: 'yes' })).toThrow('TILL_SEND_REPLY_EMAIL');
  });

  it('requires a From address only when sending replies is turned on', () => {
    expect(() => readConfig({ ...minimal, TILL_SEND_REPLY_EMAIL: 'true' })).toThrow(
      'TILL_REPLY_FROM: required when TILL_SEND_REPLY_EMAIL is true',
    );
    expect(readConfig({ ...minimal, TILL_SEND_REPLY_EMAIL: 'true', TILL_REPLY_FROM: 'orders@example.com' }).sendReplyEmail).toBe(true);
  });

  it('treats an empty variable as unset', () => {
    expect(readConfig({ ...minimal, TILL_COMPANY_NAME: '  ' }).companyName).toBe('our team');
  });
});
