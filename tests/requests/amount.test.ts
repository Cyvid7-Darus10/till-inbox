import { describe, expect, it } from 'vitest';
import { amountAtQuote, amountsIn, normalizeForAmounts } from '../../lib/requests/amount';
import { checkAmount, WARNINGS } from '../../lib/requests/understand';
import { loadFixture } from '../fixtures';

const { reading } = loadFixture('opening-order');
const settings = { maxAmount: 10_000 };

/** What the code keeps when the model read `amount currency` from `quote` in `text`. */
const kept = (text: string, amount: number, currency: string, quote: string) =>
  checkAmount({ ...reading, amount, currency, amountQuote: quote }, text, settings);

type Row = [label: string, text: string, amount: number, currency: string, quote: string];

const DASHES = ['-', '‐', '‑', '‒', '–', '—', '―', '﹘', '﹣', '－', '−'];

describe('amounts the email states clearly', () => {
  const clear: Row[] = [
    ['code before', 'So AUD 950. Thanks!', 950, 'AUD', 'AUD 950'],
    ['code after', 'That is 950 AUD, thanks.', 950, 'AUD', '950 AUD'],
    ['no space', 'Total AUD950 today.', 950, 'AUD', 'AUD950'],
    ['in brackets', 'The total (AUD 950) is due.', 950, 'AUD', 'AUD 950'],
    ['two decimals', 'That is AUD 950.75, thanks.', 950.75, 'AUD', 'AUD 950.75'],
    ['thousands', 'Total AUD 1,250.00 today.', 1250, 'AUD', 'AUD 1,250.00'],
    ['A$', 'Pay A$950 today.', 950, 'AUD', 'A$950'],
    ['US$', 'Pay US$950 today.', 950, 'USD', 'US$950'],
    ['euro', 'Pay €950 today.', 950, 'EUR', '€950'],
    ['quoted in another case', 'The total is AUD 950.', 950, 'AUD', 'aud 950'],
    ['a date nearby', 'Due 2026-11-20, AUD 950 in total.', 950, 'AUD', 'AUD 950 in total'],
    ['a unit price elsewhere', 'At AUD 38 a kilo, so AUD 950 in total.', 950, 'AUD', 'AUD 950 in total'],
    ['no-break space', 'Total AUD 950 today.', 950, 'AUD', 'AUD 950'],
    ['line break in the quote', 'Total AUD\n950 today.', 950, 'AUD', 'AUD 950'],
    ['a currency without decimals', 'Total JPY 9500 today.', 9500, 'JPY', 'JPY 9500'],
  ];
  it.each(clear)('keeps it: %s', (_label, text, amount, currency, quote) => {
    expect(kept(text, amount, currency, quote)).toEqual({ amount, currency, warnings: [] });
  });

  it('keeps the café fixture as recorded from the real model', () => {
    const { email } = loadFixture('opening-order');
    expect(checkAmount(reading, email.text, settings)).toEqual({ amount: 950, currency: 'AUD', warnings: [] });
  });
});

describe('anything else is no clear amount, never a best guess', () => {
  const unclear: Row[] = [
    // A quote that cuts a number short, wherever it ends.
    ['decimals cut', 'A link for AUD 950.75 in total.', 950, 'AUD', 'AUD 950'],
    ['ends at a dot', 'A link for AUD 950.75 in total.', 950, 'AUD', 'AUD 950.'],
    ['digit cut', 'A link for AUD 9500 in total.', 950, 'AUD', 'AUD 950'],
    ['ends at a comma', 'The total is AUD 9,500 for the lot.', 9, 'AUD', 'AUD 9,'],
    ['starts inside', 'The total is AUD 1,950 for the lot.', 950, 'AUD', '950 for the lot'],
    ['space as thousands', 'The total is AUD 1 000 for the lot.', 1, 'AUD', 'AUD 1'],
    ['narrow space as thousands', 'The total is AUD 1 250 for the lot.', 1, 'AUD', 'AUD 1'],
    // Other ways of writing numbers.
    ['decimal comma', 'Total AUD 12,50 today.', 12.5, 'AUD', 'AUD 12,50'],
    ['dots and comma', 'Total AUD 1.250,00 today.', 1250, 'AUD', 'AUD 1.250,00'],
    ['apostrophe', "Total AUD 1'250 today.", 1250, 'AUD', "AUD 1'250"],
    ['right single quote', 'Total AUD 1’250 today.', 1250, 'AUD', 'AUD 1’250'],
    ['underscore', 'Total AUD 1_250 today.', 1250, 'AUD', 'AUD 1_250'],
    ['three decimals', 'Total AUD 950.505 today.', 950.5, 'AUD', 'AUD 950.505'],
    ['leading zero', 'Total AUD 0950 today.', 950, 'AUD', 'AUD 0950'],
    ['zero', 'A charge of AUD 0.00 please.', 0, 'AUD', 'AUD 0.00'],
    ['rounds to zero', 'A test charge of AUD 0.004 please.', 0.004, 'AUD', 'AUD 0.004'],
    ['decimals on a currency without', 'Total JPY 950.50 today.', 950.5, 'JPY', 'JPY 950.50'],
    // Digits that are not ASCII.
    ['full-width digits', 'Total ＡＵＤ ９５０ today.', 950, 'AUD', 'ＡＵＤ ９５０'],
    ['Arabic-Indic digits', 'Total AUD ٩٥٠ today.', 950, 'AUD', 'AUD ٩٥٠'],
    ['Arabic-Indic elsewhere', 'Order ٣ of AUD 950 today.', 950, 'AUD', 'AUD 950'],
    // Letters, ids, dates and phone numbers.
    ['letter after', 'Total AUD 950kg today.', 950, 'AUD', 'AUD 950kg'],
    ['letter before', 'Total AUDx950 today.', 950, 'AUD', 'AUDx950'],
    ['invoice number', 'For invoice #950 we owe AUD 120.', 950, 'AUD', 'invoice #950 we owe AUD 120'],
    ['hyphenated id', 'For invoice 1042-950 we owe AUD 120.', 950, 'AUD', 'invoice 1042-950'],
    ['phone number', 'Call our AUD desk on +61 2 9999 0950.', 950, 'AUD', '+61 2 9999 0950'],
    ['a date', 'Order of 2026-09-50, please.', 50, 'AUD', '2026-09-50'],
    ['per month', 'Total AUD 950/month from now.', 950, 'AUD', 'AUD 950/month'],
    ['percent', 'A discount of AUD 15% applies.', 15, 'AUD', 'AUD 15%'],
    // Ranges, alternatives and several amounts.
    ['range', 'Somewhere between AUD 950-1,200 in total.', 950, 'AUD', 'AUD 950'],
    ['range with spaces', 'Somewhere between AUD 950 - 1,200 in total.', 950, 'AUD', 'AUD 950'],
    ['range in words', 'Somewhere from AUD 950 to 1,200 in total.', 950, 'AUD', 'AUD 950'],
    ['alternatives', 'Either AUD 950 or AUD 990, your call.', 950, 'AUD', 'AUD 950'],
    ['two amounts in the quote', 'Pay AUD 950 now and AUD 1,200 later.', 950, 'AUD', 'AUD 950 now and AUD 1,200'],
    ['a credit', 'A credit of AUD -950 applies.', 950, 'AUD', 'AUD -950'],
    ['a credit, spaced', 'A credit of AUD - 950 applies.', 950, 'AUD', '950 applies'],
    // Currencies.
    ['bare dollar', 'Please send a link for $950 in total.', 950, 'USD', '$950 in total'],
    ['no currency at the amount', 'AUD is what we use. The total is 950.', 950, 'AUD', 'The total is 950'],
    ['currency inside a word', 'Our AUDIT 950 is done.', 950, 'AUD', 'AUDIT 950'],
    ['lower-case code', 'total aud 950. Prices are in EUR.', 950, 'AUD', 'aud 950'],
    ['another currency at the amount', 'The total is AUD 950. We normally pay you in EUR.', 950, 'EUR', 'AUD 950'],
    ['two currencies on one amount', 'The total is AUD 950 USD.', 950, 'AUD', 'AUD 950 USD'],
    ['US$ is not S$', 'Pay US$950 today.', 950, 'SGD', 'US$950'],
    ['CA$ is not A$', 'Pay CA$950 today.', 950, 'AUD', 'CA$950'],
    // The quote is not in the email, or the number differs.
    ['quote not in the email', 'So AUD 950 in total.', 950, 'AUD', 'AUD 950 due now'],
    ['model read another number', 'So AUD 950 in total.', 905, 'AUD', 'AUD 950'],
  ];
  it.each(unclear)('asks a person: %s', (_label, text, amount, currency, quote) => {
    expect(kept(text, amount, currency, quote).amount).toBeNull();
  });

  it.each(DASHES.map((dash) => [`U+${dash.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0')}`, dash]))(
    'asks a person for a credit or a range written with %s',
    (_label, dash) => {
      expect(kept(`A credit of AUD ${dash}950 applies.`, 950, 'AUD', `AUD ${dash}950`).amount).toBeNull();
      expect(kept(`A credit of AUD ${dash}950 applies.`, 950, 'AUD', '950 applies').amount).toBeNull();
      expect(kept(`Between AUD 950${dash}1,200 in total.`, 950, 'AUD', 'AUD 950').amount).toBeNull();
    },
  );

  it('says which part was unclear', () => {
    expect(kept('Please send a link for $950 in total.', 950, 'USD', '$950').warnings).toEqual([WARNINGS.currencyNotStated]);
    expect(kept('A link for AUD 950.75.', 950, 'AUD', 'AUD 950').warnings).toEqual([WARNINGS.amountNotInEmail]);
    expect(kept('So AUD 950,000 in total.', 950000, 'AUD', 'AUD 950,000').warnings).toEqual([WARNINGS.amountOverLimit]);
  });
});

describe('every limit fails closed', () => {
  const long = (length: number) => 'x'.repeat(length);

  it.each([
    ['a long word between the connector and the other number', `Somewhere from AUD 950 to ${long(25)} 1,200 in total.`],
    ['several words between the connector and the other number', 'Somewhere from AUD 950 to perhaps a bit more like 1,200 in total.'],
    ['through, till and until', 'From AUD 950 through to 1,200. '],
    ['between ... and', 'Somewhere between AUD 950 and maybe 1,200 in total.'],
    ['either ... or', 'Either AUD 950 or, if you prefer, 990.'],
    ['a standalone dash', 'Pay AUD 950 - or 990.'],
    ['a standalone slash', 'Pay AUD 950 / 990 per box.'],
    ['an ampersand', 'Pay AUD 950 & 990 later.'],
    ['a connector glued to the number', 'Pay AUD 950 to1,200 in total.'],
    ['a connector before the amount', 'Somewhere from 900 to AUD 950 in total.'],
    ['a connector across a line break', 'Pay AUD 950\nor 990 tomorrow'],
  ])('a range or a choice is not clear: %s', (_label, text) => {
    expect(kept(text, 950, 'AUD', 'AUD 950').amount).toBeNull();
  });

  it('keeps the amount when the other number is in another sentence', () => {
    expect(kept('Pay AUD 950 in total. Or call us on 990 if not.', 950, 'AUD', 'AUD 950').amount).toBe(950);
    expect(kept('Pay AUD 950 in total; and 3 boxes ship Friday.', 950, 'AUD', 'AUD 950').amount).toBe(950);
    expect(kept('Pay AUD 950 in total\n\nOr call 990 if not', 950, 'AUD', 'AUD 950').amount).toBe(950);
  });

  it('a 10,000-character run between the connector and the other number is not clear', () => {
    expect(kept(`Pay AUD 950 to ${long(10_000)} 1,200.`, 950, 'AUD', 'AUD 950').amount).toBeNull();
    // Under the text cap as well: the word is too long, and the sentence runs past the limit.
    expect(kept(`Pay AUD 950 to ${long(5_000)} 1,200.`, 950, 'AUD', 'AUD 950').amount).toBeNull();
    expect(kept(`Pay AUD 950 to ${'word '.repeat(80)}1,200.`, 950, 'AUD', 'AUD 950').amount).toBeNull();
  });

  it('a sentence that runs past the limit on either side is not clear', () => {
    const words = 'more words here '.repeat(20);
    expect(kept(`${words}AUD 950 in total.`, 950, 'AUD', 'AUD 950').amount).toBeNull();
    expect(kept(`Pay AUD 950 ${words}`, 950, 'AUD', 'AUD 950').amount).toBeNull();
    expect(kept(`Short. Pay AUD 950 in total. ${words}`, 950, 'AUD', 'AUD 950').amount).toBe(950);
  });

  it('a word longer than the limit near the amount is not clear', () => {
    expect(kept(`Pay AUD 950 for ${long(41)} today.`, 950, 'AUD', 'AUD 950').amount).toBeNull();
    expect(kept(`Pay AUD 950 for ${long(40)} today.`, 950, 'AUD', 'AUD 950').amount).toBe(950);
  });

  it('text over the length cap, or too many numbers, is not clear', () => {
    expect(kept(`Pay AUD 950. ${long(8_000)}`, 950, 'AUD', 'AUD 950').amount).toBeNull();
    expect(kept(`${'AUD 1. '.repeat(200)}Pay AUD 950.`, 950, 'AUD', 'AUD 950').amount).toBeNull();
    expect(kept(`${'AUD 1. '.repeat(198)}Pay AUD 950.`, 950, 'AUD', 'AUD 950').amount).toBe(950);
  });

  it('the same quote pointing at two different amounts anywhere in the email is not clear', () => {
    expect(kept('Pay AUD 950 now. Your last invoice: AUD 950.75 paid.', 950, 'AUD', 'AUD 950').amount).toBeNull();
    expect(kept('Pay AUD 950 now. Last month was AUD 950 too.', 950, 'AUD', 'AUD 950').amount).toBe(950);
    expect(kept('Pay AUD 950 now. Or maybe AUD 950 to 1,000.', 950, 'AUD', 'AUD 950').amount).toBeNull();
  });
});

describe('random text around a non-amount never makes it an amount', () => {
  // Deterministic, so a failure always reproduces: mulberry32.
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // No ASCII digits, so the junk itself can never be an amount. (A bare "$950" is left to the table:
  // junk can prefix it to "A$950", which really does state AUD 950.)
  const JUNK = [...'abcxyzAUDEUR .,;:!?()[]"\'’#_+/%$€£\n\t', ...DASHES, '​', '‮', ' ', '٣'];
  const NOT_AMOUNTS: [string, number][] = [
    ['AUD -950', 950],
    ['AUD #950', 950],
    ['AUD 950-1,200', 950],
    ["AUD 1'250", 1250],
    ['AUD 12,50', 12.5],
    ['AUD 950x', 950],
    ['AUD 1_250', 1250],
    ['AUD ٩٥٠', 950],
    ['AUD 1.250,00', 1250],
    ['AUD 950 or AUD 990', 950],
    ['AUD 950 to 1,200', 950],
  ];

  it('holds for 2,000 random surroundings', () => {
    const next = random(20261113);
    const junk = () => Array.from({ length: Math.floor(next() * 8) }, () => JUNK[Math.floor(next() * JUNK.length)]).join('');
    for (let run = 0; run < 2000; run += 1) {
      const [core, amount] = NOT_AMOUNTS[run % NOT_AMOUNTS.length];
      const text = `${junk()}${core}${junk()}`;
      const result = kept(text, amount, 'AUD', core);
      if (result.amount !== null) throw new Error(`accepted ${JSON.stringify(text)}`);
    }
  });
});

describe('the grammar itself', () => {
  it('normalizes dashes, spaces and invisible characters once', () => {
    expect(normalizeForAmounts('AUD\u00A0950\u2013\u200B1,200 \n\tnow  ok\n\n\nnext')).toBe('AUD 950-1,200\nnow ok\n\nnext');
  });

  it('finds each token with its currency, and marks a range or a choice as not clear', () => {
    const text = 'At AUD 38 a kilo, so A$950 in total, or 950 to 990.';
    expect(amountsIn(text).map(({ value, currency }) => [value, currency])).toEqual([
      [38, 'AUD'],
      [null, 'AUD'],
      [null, null],
      [null, null],
    ]);
  });

  it('needs a quote to point at exactly one token', () => {
    expect(amountAtQuote(null, 'AUD 950')).toBeNull();
    expect(amountAtQuote('   ', 'AUD 950')).toBeNull();
    expect(amountAtQuote('AUD 38 a kilo, so AUD 950', 'AUD 38 a kilo, so AUD 950')).toBeNull();
    expect(amountAtQuote('AUD 950', 'AUD 38 a kilo, so AUD 950')).toMatchObject({ value: 950, currency: 'AUD' });
  });
});
