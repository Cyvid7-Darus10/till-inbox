import { describe, expect, it } from 'vitest';
import { amountAtQuote, amountsIn, MAX_AMOUNT_TOKENS, normalizeForAmounts } from '../../lib/requests/amount';
import { checkAmount, WARNINGS } from '../../lib/requests/understand';
import { loadFixture } from '../fixtures';

const { reading } = loadFixture('opening-order');
const settings = { maxAmount: 10_000 };

/** What the code keeps when the model read `amount currency` from `quote` in `text`. */
const kept = (text: string, amount: number, currency: string, quote: string) =>
  checkAmount({ ...reading, amount, currency, amountQuote: quote }, text, settings);

type Row = [label: string, text: string, amount: number, currency: string, quote: string];

const DASHES = ['-', '‐', '‑', '‒', '–', '—', '―', '﹘', '﹣', '－', '−'];

describe('one-click amounts', () => {
  const clear: Row[] = [
    ['a single plain amount', 'Please send a link for AUD 950. Thanks!', 950, 'AUD', 'AUD 950'],
    ['code after', 'That is 950 AUD, thanks.', 950, 'AUD', '950 AUD'],
    ['no space', 'Total AUD950 today.', 950, 'AUD', 'AUD950'],
    ['in brackets', 'The total (AUD 950) is due.', 950, 'AUD', 'AUD 950'],
    ['two decimals', 'That is AUD 950.75, thanks.', 950.75, 'AUD', 'AUD 950.75'],
    ['thousands', 'Total AUD 1,250.00 today.', 1250, 'AUD', 'AUD 1,250.00'],
    ['A$', 'Pay A$950 today.', 950, 'AUD', 'A$950'],
    ['US$', 'Pay US$950 today.', 950, 'USD', 'US$950'],
    ['euro', 'Pay €950 today.', 950, 'EUR', '€950'],
    ['quoted in another case', 'The total is AUD 950.', 950, 'AUD', 'aud 950'],
    ['no-break space', 'Total AUD 950 today.', 950, 'AUD', 'AUD 950'],
    ['line break in the quote', 'Total AUD\n950 today.', 950, 'AUD', 'AUD 950'],
    ['a currency without decimals', 'Total JPY 9500 today.', 9500, 'JPY', 'JPY 9500'],
    ['the same amount twice', 'Pay AUD 950 now please. Last month was AUD 950 too.', 950, 'AUD', 'AUD 950'],
    ['another number far away', 'Pay AUD 950 in total please. Or call us on 990 if not.', 950, 'AUD', 'AUD 950'],
    [
      'a labelled total with line items',
      '2 bags at AUD 38 each and 3 bags at AUD 50 each. The total due is AUD 226.',
      226,
      'AUD',
      'AUD 226',
    ],
  ];
  it.each(clear)('keeps it: %s', (_label, text, amount, currency, quote) => {
    expect(kept(text, amount, currency, quote)).toEqual({ amount, currency, warnings: [] });
  });

  it('keeps the café fixture as recorded from the real model (a unit price and a labelled total)', () => {
    const { email } = loadFixture('opening-order');
    expect(email.text).toContain('25 kg of the Lane House Blend at AUD 38 a kilo');
    expect(checkAmount(reading, email.text, settings)).toEqual({ amount: 950, currency: 'AUD', warnings: [] });
  });
});

describe('no clear amount, never a best guess', () => {
  const unclear: Row[] = [
    // Round 1: a quote that cuts a number short, wherever it ends.
    ['decimals cut', 'A link for AUD 950.75 in total.', 950, 'AUD', 'AUD 950'],
    ['ends at a dot', 'A link for AUD 950.75 in total.', 950, 'AUD', 'AUD 950.'],
    ['digit cut', 'A link for AUD 9500 in total.', 950, 'AUD', 'AUD 950'],
    ['ends at a comma', 'The total is AUD 9,500 for the lot.', 9, 'AUD', 'AUD 9,'],
    ['starts inside', 'The total is AUD 1,950 for the lot.', 950, 'AUD', '950 for the lot'],
    ['space as thousands', 'The total is AUD 1 000 for the lot.', 1, 'AUD', 'AUD 1'],
    ['narrow space as thousands', 'The total is AUD 1 250 for the lot.', 1, 'AUD', 'AUD 1'],
    ['a credit', 'A credit of AUD -950 applies.', 950, 'AUD', 'AUD -950'],
    ['a credit, spaced', 'A credit of AUD - 950 applies.', 950, 'AUD', '950 applies'],
    ['a currency elsewhere', 'The total is AUD 950. We normally pay you in EUR.', 950, 'EUR', 'AUD 950'],
    ['all is not a currency', 'We all pay 950 together.', 950, 'ALL', '950 together'],
    // Round 2: other ways of writing numbers, ids, dates and phone numbers.
    ['decimal comma', 'Total AUD 12,50 today.', 12.5, 'AUD', 'AUD 12,50'],
    ['dots and comma', 'Total AUD 1.250,00 today.', 1250, 'AUD', 'AUD 1.250,00'],
    ['three decimals', 'Total AUD 950.505 today.', 950.5, 'AUD', 'AUD 950.505'],
    ['leading zero', 'Total AUD 0950 today.', 950, 'AUD', 'AUD 0950'],
    ['zero', 'A charge of AUD 0.00 please.', 0, 'AUD', 'AUD 0.00'],
    ['rounds to zero', 'A test charge of AUD 0.004 please.', 0.004, 'AUD', 'AUD 0.004'],
    ['decimals on a currency without', 'Total JPY 950.50 today.', 950.5, 'JPY', 'JPY 950.50'],
    ['invoice number', 'For invoice #950 we owe AUD 120.', 950, 'AUD', 'invoice #950 we owe AUD 120'],
    ['hyphenated id', 'For invoice 1042-950 we owe AUD 120.', 950, 'AUD', 'invoice 1042-950'],
    ['phone number', 'Call our AUD desk on +61 2 9999 0950.', 950, 'AUD', '+61 2 9999 0950'],
    ['a date', 'Order of 2026-09-50, please.', 50, 'AUD', '2026-09-50'],
    ['a date right next to it', 'Due 2026-11-20, AUD 950 in total.', 950, 'AUD', 'AUD 950 in total'],
    ['currency in another case in the email', 'total aud 950. Prices are in EUR.', 950, 'AUD', 'AUD 950'],
    // Round 3: other scripts, separators and letters.
    ['full-width digits', 'Total ＡＵＤ ９５０ today.', 950, 'AUD', 'ＡＵＤ ９５０'],
    ['Arabic-Indic digits', 'Total AUD ٩٥٠ today.', 950, 'AUD', 'AUD ٩٥٠'],
    ['Arabic-Indic elsewhere', 'Order ٣ of AUD 950 today.', 950, 'AUD', 'AUD 950'],
    ['apostrophe', "Total AUD 1'250 today.", 1250, 'AUD', "AUD 1'250"],
    ['right single quote', 'Total AUD 1’250 today.', 1250, 'AUD', 'AUD 1’250'],
    ['underscore', 'Total AUD 1_250 today.', 1250, 'AUD', 'AUD 1_250'],
    ['letter after', 'Total AUD 950kg today.', 950, 'AUD', 'AUD 950kg'],
    ['letter before', 'Total AUDx950 today.', 950, 'AUD', 'AUDx950'],
    ['currency inside a word', 'Our AUDIT 950 is done.', 950, 'AUD', 'AUDIT 950'],
    ['currency far from the amount', 'AUD is what we use. The total is 950.', 950, 'AUD', 'The total is 950'],
    ['bare dollar', 'Please send a link for $950 in total.', 950, 'USD', '$950 in total'],
    ['two currencies on one amount', 'The total is AUD 950 USD.', 950, 'AUD', 'AUD 950 USD'],
    ['US$ is not S$', 'Pay US$950 today.', 950, 'SGD', 'US$950'],
    ['CA$ is not A$', 'Pay CA$950 today.', 950, 'AUD', 'CA$950'],
    ['per month glued', 'Total AUD 950/month from now.', 950, 'AUD', 'AUD 950/month'],
    ['percent', 'A discount of AUD 15% applies.', 15, 'AUD', 'AUD 15%'],
    // Rounds 4 and 5: ranges and choices, however long the words between.
    ['range', 'Somewhere between AUD 950-1,200 in total.', 950, 'AUD', 'AUD 950'],
    ['range with spaces', 'Somewhere between AUD 950 - 1,200 in total.', 950, 'AUD', 'AUD 950'],
    ['range in words', 'Somewhere from AUD 950 to 1,200 in total.', 950, 'AUD', 'AUD 950'],
    ['alternatives', 'Either AUD 950 or AUD 990, your call.', 950, 'AUD', 'AUD 950'],
    ['two amounts in the quote', 'Pay AUD 950 now and AUD 1,200 later.', 950, 'AUD', 'AUD 950 now and AUD 1,200'],
    ['a long word before the other number', `Somewhere from AUD 950 to ${'x'.repeat(25)} 1,200 in total.`, 950, 'AUD', 'AUD 950'],
    ['many words before the other money', 'From AUD 950 to perhaps a bit more like AUD 1,200 in total.', 950, 'AUD', 'AUD 950'],
    ['a connector glued to the number', 'Pay AUD 950 to1,200 in total.', 950, 'AUD', 'AUD 950'],
    ['a wrapped line', 'Pay AUD 950\nor 990 tomorrow', 950, 'AUD', 'AUD 950'],
    ['a word over the limit next to it', `Pay AUD 950 for ${'x'.repeat(41)} today.`, 950, 'AUD', 'AUD 950'],
    ['the same quote at two amounts', 'Pay AUD 950 now. Your last invoice: AUD 950.75 paid.', 950, 'AUD', 'AUD 950'],
    // Round 6: abbreviations, compound and other connectors, corrections, rates and parts.
    ['an abbreviation after', 'AUD 950 or approx. 1,200', 950, 'AUD', 'AUD 950'],
    ['an abbreviation before', '900 approx. to AUD 950', 950, 'AUD', 'AUD 950'],
    ['and/or', 'AUD 950 and/or 1,200', 950, 'AUD', 'AUD 950'],
    ['vs', 'AUD 950 vs 1,200', 950, 'AUD', 'AUD 950'],
    ['tilde', 'AUD 950 ~ 1,200', 950, 'AUD', 'AUD 950'],
    ['arrow', 'AUD 950 → 1,200', 950, 'AUD', 'AUD 950'],
    ['a correction', 'AUD 950 (was AUD 1,200)', 950, 'AUD', 'AUD 950'],
    ['not this but that', 'not AUD 950 but AUD 590', 950, 'AUD', 'AUD 950'],
    ['not this but that, the other one', 'not AUD 950 but AUD 590', 590, 'AUD', 'AUD 590'],
    ['each for a count', 'AUD 950 each for 3', 950, 'AUD', 'AUD 950'],
    ['per month for months', 'AUD 950 per month for 12 months', 950, 'AUD', 'AUD 950'],
    ['a rate alone', 'Our fee is AUD 950 a month.', 950, 'AUD', 'AUD 950'],
    ['deposit and balance', 'deposit AUD 950, balance AUD 2,000', 950, 'AUD', 'AUD 950'],
    ['deposit and balance, the other one', 'deposit AUD 950, balance AUD 2,000', 2000, 'AUD', 'AUD 2,000'],
    ['two amounts far apart, no total', 'We owe AUD 950 for coffee. We also owe you AUD 120 for cups.', 950, 'AUD', 'AUD 950'],
    ['a total that is not the largest', 'Total AUD 950. The full order was AUD 1,200 before credit.', 950, 'AUD', 'AUD 950'],
    [
      'a total that does not match the unit price',
      '25 kg of the Lane House Blend at AUD 38 a kilo for our opening, so AUD 990 in total.',
      990,
      'AUD',
      'AUD 990',
    ],
    ['a unit price with no quantity', 'Blend at AUD 38 a kilo for our big opening day, so AUD 950 in total.', 950, 'AUD', 'AUD 950'],
    // Limits.
    ['text over the cap', `Pay AUD 950 to ${'x'.repeat(10_000)} 1,200.`, 950, 'AUD', 'AUD 950'],
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
      expect(kept(`Between AUD 950${dash}1,200 in total.`, 950, 'AUD', 'AUD 950').amount).toBeNull();
      expect(kept(`Between AUD 950 ${dash} 1,200 in total.`, 950, 'AUD', 'AUD 950').amount).toBeNull();
    },
  );

  it('says which part was unclear', () => {
    expect(kept('Please send a link for $950 in total.', 950, 'USD', '$950').warnings).toEqual([WARNINGS.currencyNotStated]);
    expect(kept('A link for AUD 950.75.', 950, 'AUD', 'AUD 950').warnings).toEqual([WARNINGS.amountNotInEmail]);
    expect(kept('So AUD 950,000 in total.', 950000, 'AUD', 'AUD 950,000').warnings).toEqual([WARNINGS.amountOverLimit]);
  });

  it('reads no amount once the email holds more numbers than the cap', () => {
    const boxes = (count: number) => 'Box 7 shipped today. '.repeat(count);
    expect(kept(`${boxes(MAX_AMOUNT_TOKENS - 1)}Please pay the amount of AUD 950 now.`, 950, 'AUD', 'AUD 950').amount).toBe(950);
    expect(kept(`${boxes(MAX_AMOUNT_TOKENS)}Please pay the amount of AUD 950 now.`, 950, 'AUD', 'AUD 950').amount).toBeNull();
  });
});

describe('random emails with two different amounts', () => {
  // Deterministic, so a failure always reproduces: mulberry32.
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(next: () => number, items: readonly T[]): T => items[Math.floor(next() * items.length)];
  const AMOUNTS = ['AUD 950', 'AUD 1,200', '€590', 'A$2,000', 'AUD 38', '1,200 AUD', 'US$75.50', 'AUD 120'];
  const JOINERS = [
    'or',
    'and',
    'and/or',
    'to',
    'vs',
    'versus',
    '~',
    '→',
    '-',
    '/',
    'approx.',
    'was',
    'not',
    'but',
    'each',
    'per',
    'month',
    'deposit',
    'balance',
    '(',
    ')',
    'then',
    'maybe',
    'later.',
    'Thanks.',
    'up',
    'from',
    'between',
    'instead',
    'of',
    'roughly',
    ';',
    ',',
  ];
  const CUES = ['total', 'in total', 'total due', 'amount due', 'comes to', 'all in', '='];
  const amountOf = (written: string) => Number(written.replace(/[^0-9.]/g, ''));
  const currencyOf = (written: string) => (written.includes('€') ? 'EUR' : written.includes('US$') ? 'USD' : 'AUD');
  const words = (next: () => number, vocabulary: readonly string[], min: number, max: number) =>
    Array.from({ length: min + Math.floor(next() * (max - min + 1)) }, () => pick(next, vocabulary)).join(' ');

  function pair(next: () => number): [string, string] {
    const first = pick(next, AMOUNTS);
    let second = pick(next, AMOUNTS);
    while (amountOf(second) === amountOf(first)) second = pick(next, AMOUNTS);
    return [first, second];
  }

  it('are never one-click when at most two words join them, whatever the words', () => {
    const next = random(13);
    for (let run = 0; run < 2_000; run += 1) {
      const [first, second] = pair(next);
      const text = `${first} ${words(next, [...JOINERS, 'total', '='], 0, 2)} ${second}`;
      const quoted = next() < 0.5 ? first : second;
      const result = kept(text, amountOf(quoted), currencyOf(quoted), quoted);
      if (result.amount !== null) throw new Error(`one-click on ${JSON.stringify(text)} for ${quoted}`);
    }
  });

  it('are never one-click without a total cue, however far apart', () => {
    const next = random(2026);
    for (let run = 0; run < 2_000; run += 1) {
      const [first, second] = pair(next);
      const text = `${words(next, JOINERS, 0, 6)} ${first} ${words(next, JOINERS, 0, 12)} ${second} ${words(next, JOINERS, 0, 6)}`;
      const quoted = next() < 0.5 ? first : second;
      const result = kept(text, amountOf(quoted), currencyOf(quoted), quoted);
      if (result.amount !== null) throw new Error(`one-click on ${JSON.stringify(text)} for ${quoted}`);
    }
  });

  it('are one-click only for the larger amount, marked as the total and standing apart', () => {
    const next = random(1113);
    let oneClicks = 0;
    for (let run = 0; run < 3_000; run += 1) {
      const [first, second] = pair(next);
      const cue = pick(next, CUES);
      const text = `${first} ${words(next, JOINERS, 4, 10)} ${next() < 0.5 ? `${cue} ${second}` : `${second} ${cue}`} ${words(next, JOINERS, 0, 6)}`;
      const quoted = next() < 0.5 ? first : second;
      const result = kept(text, amountOf(quoted), currencyOf(quoted), quoted);
      if (result.amount === null) continue;
      oneClicks += 1;
      expect(quoted).toBe(second);
      expect(amountOf(second)).toBeGreaterThan(amountOf(first));
    }
    // The rule must still let a clearly marked total through sometimes.
    expect(oneClicks).toBeGreaterThan(0);
  });
});

describe('the grammar itself', () => {
  it('normalizes dashes, spaces and invisible characters once', () => {
    expect(normalizeForAmounts('AUD 950–​1,200 \n\tnow')).toBe('AUD 950-1,200 now');
  });

  it('finds each token, its currency, and whether it is written as money', () => {
    const text = 'At AUD 38 a kilo, 25 kg, so A$950 in total, or $990.';
    expect(amountsIn(text).map(({ value, currency, money }) => [value, currency, money])).toEqual([
      [38, 'AUD', true],
      [25, null, false],
      [950, 'AUD', true],
      [990, null, true],
    ]);
  });

  it('needs every place the quote appears to point at exactly one token', () => {
    expect(amountAtQuote(null, 'AUD 950')).toBeNull();
    expect(amountAtQuote('   ', 'AUD 950')).toBeNull();
    expect(amountAtQuote('AUD 38 a kilo, so AUD 950', 'AUD 38 a kilo, so AUD 950')).toBeNull();
    expect(amountAtQuote('AUD 950', 'Please pay AUD 950 today.')).toMatchObject({ value: 950, currency: 'AUD' });
  });
});
