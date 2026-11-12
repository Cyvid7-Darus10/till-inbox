import { describe, expect, it } from 'vitest';
import { cleanField, cleanMessageId, normalizeText } from '../../lib/requests/clean';

const clean = (value: string) => cleanField(value, 160);

describe('cleaning text from an email', () => {
  it('keeps ordinary order text, names and companies', () => {
    expect(clean('25 kg of the Lane House Blend')).toBe('25 kg of the Lane House Blend');
    expect(clean('Harbour Lane Café Pty Ltd.')).toBe('Harbour Lane Café Pty Ltd.');
    expect(clean("this month's order: 30 kg (decaf) & 2 tins, #1042, 10%")).toBe("this month's order: 30 kg (decaf) & 2 tins, #1042, 10%");
    expect(clean('Zoë Ngô-Smith')).toBe('Zoë Ngô-Smith');
  });

  it('removes hostnames with any top-level domain, in any case', () => {
    for (const host of ['pay-update.zip', 'secure.click', 'evil.museum', 'EVIL.CoM', 'login.example.co.uk/path?x=1', 'a.b.c.dev']) {
      expect(clean(`pay at ${host} today`)).toBe('pay at today');
    }
  });

  it('removes URLs, schemes and email addresses', () => {
    expect(clean('see https://evil.example/x or HTTP://EVIL.EXAMPLE')).toBe('see or');
    expect(clean('write to billing@pay-update.example now')).toBe('write to now');
    expect(clean('javascript:alert(1) data:text/html,x')).toBeNull();
  });

  it('removes punycode hostnames', () => {
    expect(clean('go to xn--80ak6aa92e.com now')).toBe('go to now');
    expect(clean('go to paypal.xn--p1ai now')).toBe('go to now');
  });

  it('removes hostnames written with full-width or look-alike dots', () => {
    expect(clean('pay at evil．com now')).toBe('pay at now');
    expect(clean('pay at evil。com now')).toBe('pay at now');
    expect(clean('pay at evil｡com now')).toBe('pay at now');
    expect(clean('pay at ｅｖｉｌ.ｃｏｍ now')).toBe('pay at now');
    expect(clean('pay at evil․com now')).toBe('pay at now');
  });

  it('removes hostnames hidden with zero-width or direction characters', () => {
    expect(clean('pay at ev\u200Bil.c\u200Dom now')).toBe('pay at now');
    expect(clean('pay at evil.\u2060com now')).toBe('pay at now');
    expect(clean('pay \u202Emoc.live\u202C now')).toBe('pay now');
  });

  it('removes hostnames with look-alike letters from other scripts', () => {
    expect(clean('pay at pаypal.com now')).toBe('pay at now');
  });

  it('drops characters outside the allowlist, such as markup and Slack formatting', () => {
    expect(clean('<!channel> *bold* _x_ ~y~ `code` {a} [b] |c| \\d')).toBe('channel bold x y code a b c d');
  });

  it('keeps one line, caps the length and returns null when nothing is left', () => {
    expect(clean('line one\r\nSubject: injected')).toBe('line one Subject: injected');
    expect(cleanField('a'.repeat(50), 10)).toBe('a'.repeat(10));
    expect(clean('https://only.example')).toBeNull();
    expect(cleanField(null, 10)).toBeNull();
  });

  it('normalizes compatibility characters', () => {
    expect(normalizeText('ｆｕｌｌ ｗｉｄｔｈ')).toBe('full width');
  });
});

describe('message ids for threading a reply', () => {
  it('keeps a well-formed Message-ID and refuses anything that could inject a header', () => {
    expect(cleanMessageId('<abc.123@mail.example>')).toBe('<abc.123@mail.example>');
    expect(cleanMessageId('<abc@mail.example>\r\nBcc: victim@example.com')).toBeNull();
    expect(cleanMessageId('abc@mail.example')).toBeNull();
    expect(cleanMessageId(`<${'a'.repeat(250)}@x.example>`)).toBeNull();
    expect(cleanMessageId(null)).toBeNull();
  });
});
