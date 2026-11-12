import { afterEach, describe, expect, it, vi } from 'vitest';
import { COPY, WARNING_TEXT } from '../lib/copy';
import { formatLine, log } from '../lib/log';
import { WARNINGS } from '../lib/requests/understand';
import { hasButton, hasButtons } from '../lib/slack/card-state';
import { duplicateReason } from '../lib/slack/events';
import { plainText, safeLink } from '../lib/slack/text';

describe('structured logs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes one JSON line with timestamp, level, request_id and message', () => {
    const line = JSON.parse(
      formatLine('info', 'link created', { requestId: 'till-inbox-1', reused: false }, new Date('2026-11-12T09:00:00Z')),
    );
    expect(line).toEqual({
      timestamp: '2026-11-12T09:00:00.000Z',
      level: 'info',
      request_id: 'till-inbox-1',
      message: 'link created',
      reused: false,
    });
  });

  it('redacts fields that could hold personal data or secrets, whatever a caller passes', () => {
    const line = JSON.parse(formatLine('warn', 'x', { email: 'mia@example.com', amount: 950, customerName: 'Mia', token: 't', body: 'b' }));
    expect(line).toMatchObject({
      request_id: null,
      email: '[redacted]',
      amount: '[redacted]',
      customerName: '[redacted]',
      token: '[redacted]',
      body: '[redacted]',
    });
  });

  it('describes errors by name and message, with their cause', () => {
    const line = JSON.parse(formatLine('error', 'x', { error: new Error('outer', { cause: new Error('inner') }) }));
    expect(line.error).toEqual({ name: 'Error', message: 'outer', cause: { name: 'Error', message: 'inner' } });
  });

  it('sends errors to stderr and the rest to stdout', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    log.info('a');
    log.warn('b');
    log.error('c');
    expect(info).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe('slack helpers', () => {
  it('keeps text from acting as Slack markup', () => {
    expect(plainText('<!channel> <@U1> <https://x|Approve>')).toBe('‹!channel› ‹@U1› ‹https://x|Approve›');
    expect(safeLink('https://pay.sandbox.airwallex.com/x')).toBe('https://pay.sandbox.airwallex.com/x');
    expect(safeLink('javascript:alert(1)')).toBe('');
    expect(safeLink('not a url')).toBe('');
  });

  it('tells an open card from a decided one', () => {
    const open = { blocks: [{ type: 'section' }, { type: 'actions', elements: [{ action_id: 'till_inbox_send_reply' }] }] };
    expect(hasButtons(open)).toBe(true);
    expect(hasButton(open, 'till_inbox_send_reply')).toBe(true);
    expect(hasButton(open, 'till_inbox_approve')).toBe(false);
    expect(hasButtons({ blocks: [{ type: 'section' }] })).toBe(false);
    expect(hasButtons('garbage')).toBe(false);
    expect(hasButton('garbage', 'x')).toBe(false);
  });

  it('drops Slack retries', () => {
    expect(duplicateReason(new Request('https://x', { headers: { 'x-slack-retry-num': '1' } }))).toBe('slack retry');
    expect(duplicateReason(new Request('https://x'))).toBeNull();
  });
});

describe('copy', () => {
  it('has a sentence for every warning', () => {
    for (const warning of Object.values(WARNINGS)) expect(WARNING_TEXT[warning]).toBeTruthy();
  });

  it('describes link status plainly', () => {
    expect(COPY.thread.status('UNPAID', true, '2026-11-19T09:00:00+0000')).toBe(
      'Not paid yet. It expires 2026-11-19. (checked in Airwallex just now)',
    );
    expect(COPY.thread.status('PAID', true, '2026-11-19')).toBe('Paid. (checked in Airwallex just now)');
    expect(COPY.thread.status('ODD', false, null)).toBe('Status: ODD. The link is no longer active. (checked in Airwallex just now)');
  });

  it('escapes names in sentences', () => {
    expect(COPY.outcome.rejected('<!here>')).toBe('Rejected by ‹!here›. Nothing was created.');
    expect(COPY.thread.created('AUD 1.00', true)).toContain('already had');
  });
});
