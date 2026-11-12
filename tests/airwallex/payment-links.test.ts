import { describe, expect, it } from 'vitest';
import { chooseAccount, createOrReuse, findMismatches, linkStatus, toIso } from '../../lib/airwallex/payment-links';
import type { AirwallexCaller } from '../../lib/airwallex/session';
import { parseApiResponse } from '../../lib/airwallex/session';
import { ALLOWED_TOOLS, checkServerUrl, SCOPES, TOOL } from '../../lib/airwallex/tool-policy';
import { linkArgs } from '../../lib/requests/link-params';
import { pendingFixture } from '../requests/helpers';

// The shapes below are copied from the Airwallex sandbox's answers on 2026-11-12, with made-up ids.
const sandboxLink = (overrides = {}) => ({
  active: true,
  amount: 950.0,
  currency: 'AUD',
  supported_currencies: [],
  url: 'https://pay.sandbox.airwallex.com/abc123',
  id: '00000000-0000-4000-8000-000000000001',
  title: '25 kg of the Lane House Blend',
  reference: 'till-inbox-em_0001',
  reusable: false,
  status: 'UNPAID',
  expires_at: '2026-11-19T09:00:00+0000',
  created_at: '2026-11-12T09:00:00+0000',
  ...overrides,
});

function fakeCaller(answers: Record<string, unknown[]>): AirwallexCaller & { calls: { tool: string; args: Record<string, unknown> }[] } {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    call: async (tool, args) => {
      calls.push({ tool, args });
      const queue = answers[tool];
      if (!queue || queue.length === 0) throw new Error(`unexpected call to ${tool}`);
      return queue.shift();
    },
    close: async () => {},
  };
}

const args = linkArgs(pendingFixture(), 'acct_fakeaccount01', '2026-11-19T09:00:00Z');
const since = new Date('2026-11-12T08:30:00Z');

describe('creating a payment link', () => {
  it('creates the link when none exists for the request, with exactly the approved arguments', async () => {
    const airwallex = fakeCaller({ [TOOL.listLinks]: [{ items: [], has_more: false }], [TOOL.createLink]: [sandboxLink()] });
    const result = await createOrReuse(airwallex, args, since);
    expect(result).toMatchObject({ ok: true, reused: false, link: { url: 'https://pay.sandbox.airwallex.com/abc123' } });
    expect(airwallex.calls[0]).toEqual({
      tool: TOOL.listLinks,
      args: { account_id: 'acct_fakeaccount01', from_created_at: '2026-11-12T08:20:00Z', page_num: 0, page_size: 50 },
    });
    expect(airwallex.calls[1]).toEqual({ tool: TOOL.createLink, args });
  });

  it('reuses a link that already carries the request’s reference, across pages', async () => {
    const airwallex = fakeCaller({
      [TOOL.listLinks]: [
        { items: [sandboxLink({ id: 'other', reference: 'someone else' })], has_more: true },
        { items: [sandboxLink()], has_more: false },
      ],
    });
    expect(await createOrReuse(airwallex, args, since)).toMatchObject({ ok: true, reused: true });
    expect(airwallex.calls.map((call) => call.tool)).toEqual([TOOL.listLinks, TOOL.listLinks]);
  });

  it('refuses a link whose amount or currency differs from the approval', async () => {
    const airwallex = fakeCaller({ [TOOL.listLinks]: [{ items: [] }], [TOOL.createLink]: [sandboxLink({ amount: 9.5, currency: 'USD' })] });
    const result = await createOrReuse(airwallex, args, since);
    expect(result).toEqual({
      ok: false,
      problem:
        "The link Airwallex returned doesn't match the approval (currency is USD, approved AUD; amount is 9.5, approved 950). Don't send it.",
    });
  });

  it('flags a different reference and an address that is not an https Airwallex page', () => {
    for (const url of ['http://pay.sandbox.airwallex.com/x', 'https://pay.evil.example/x', 'https://airwallex.com.evil.example/x']) {
      const link = { ...sandboxLink({ reference: 'x' }), url };
      expect(findMismatches(link, args)).toEqual(['it carries another reference', 'its address is not an https Airwallex page']);
    }
  });

  it('refuses to reuse a link that is inactive, or that does not say its amount and currency', async () => {
    const inactive = fakeCaller({ [TOOL.listLinks]: [{ items: [sandboxLink({ active: false })] }] });
    expect(await createOrReuse(inactive, args, since)).toMatchObject({ ok: false, problem: expect.stringContaining('no longer active') });
    const bare = { ...sandboxLink() } as Record<string, unknown>;
    delete bare.amount;
    delete bare.currency;
    const missing = fakeCaller({ [TOOL.listLinks]: [{ items: [bare] }] });
    expect(await createOrReuse(missing, args, since)).toMatchObject({ ok: false, problem: expect.stringContaining('amount is missing') });
  });
});

describe('choosing the account', () => {
  const accounts = {
    items: [
      { account_id: 'acct_aaaaaaaa', name: 'Company account' },
      { account_id: 'acct_bbbbbbbb', name: 'Main account' },
    ],
  };

  it('uses the configured account when the login can reach it', async () => {
    expect(await chooseAccount(fakeCaller({ [TOOL.listAccounts]: [accounts] }), 'acct_bbbbbbbb')).toEqual({
      ok: true,
      accountId: 'acct_bbbbbbbb',
    });
    expect((await chooseAccount(fakeCaller({ [TOOL.listAccounts]: [accounts] }), 'acct_cccccccc')).ok).toBe(false);
  });

  it('uses the only account, and asks for the setting when there are several', async () => {
    const one = { items: [accounts.items[0]] };
    expect(await chooseAccount(fakeCaller({ [TOOL.listAccounts]: [one] }), undefined)).toEqual({ ok: true, accountId: 'acct_aaaaaaaa' });
    const several = await chooseAccount(fakeCaller({ [TOOL.listAccounts]: [accounts] }), undefined);
    expect(several).toEqual({ ok: false, problem: expect.stringContaining('Set TILL_AIRWALLEX_ACCOUNT_ID') });
  });
});

describe('link status', () => {
  it('finds the link by id and reports paid, active and expiry', async () => {
    const airwallex = fakeCaller({ [TOOL.listLinks]: [{ items: [sandboxLink({ status: 'PAID' })], has_more: false }] });
    expect(await linkStatus(airwallex, 'acct_fakeaccount01', sandboxLink().id, '2026-11-12T09:00:00+0000')).toEqual({
      status: 'PAID',
      active: true,
      expiresAt: '2026-11-19T09:00:00+0000',
    });
    expect(airwallex.calls[0].args.from_created_at).toBe('2026-11-12T08:50:00Z');
  });

  it('returns null when Airwallex no longer lists it, and stops after a few pages', async () => {
    const page = { items: [sandboxLink({ id: 'other' })], has_more: true };
    const airwallex = fakeCaller({ [TOOL.listLinks]: [page, page, page, page, page] });
    expect(await linkStatus(airwallex, 'acct_fakeaccount01', 'missing', '2026-11-12T09:00:00Z')).toBeNull();
    expect(airwallex.calls).toHaveLength(4);
  });

  it('reads Airwallex timestamps', () => {
    expect(toIso('2026-11-12T09:00:00+0000')).toBe('2026-11-12T09:00:00Z');
    expect(() => toIso('soon')).toThrow('timestamp');
  });
});

describe('tool policy', () => {
  it('asks for payment link scopes only, and calls three tools by name', () => {
    expect(SCOPES).toEqual(['r:awx_action:payment_links_view', 'w:awx_action:payment_links_edit']);
    expect(ALLOWED_TOOLS).toEqual(['list_auth_org_accounts', 'create_payment_link', 'list_payment_links']);
  });

  it('refuses any server other than the sandbox unless live use is turned on', () => {
    expect(() => checkServerUrl('https://mcp.sandbox.airwallex.com/developer', false)).not.toThrow();
    expect(() => checkServerUrl('https://mcp.airwallex.com/mcp', false)).toThrow('not the sandbox');
    expect(() => checkServerUrl('https://mcp.airwallex.com/mcp', true)).not.toThrow();
    expect(() => checkServerUrl('not a url', true)).toThrow('invalid server url');
  });
});

describe('reading an MCP tool result', () => {
  it('pulls the JSON out of the api_response tags', () => {
    const result = {
      content: [
        { type: 'text', text: 'note' },
        { type: 'text', text: '<api_response_ab12>\n{"items":[]}\n</api_response_ab12>' },
      ],
    };
    expect(parseApiResponse('list_payment_links', result)).toEqual({ items: [] });
  });

  it('keeps the response text out of errors', () => {
    expect(() => parseApiResponse('x', { isError: true, content: [{ type: 'text', text: 'secret customer' }] })).toThrow(
      /^Airwallex x failed$/,
    );
    expect(() => parseApiResponse('x', { content: [] })).toThrow('no api response');
    expect(() => parseApiResponse('x', { content: [{ type: 'text', text: '<api_response_ab>{bad</api_response_ab>' }] })).toThrow(
      'unreadable',
    );
  });
});
