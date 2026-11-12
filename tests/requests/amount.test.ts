import { describe, expect, it } from 'vitest';
import { moneyMentioned, normalizeForAmounts, numbersIn, readAmount } from '../../lib/requests/amount';
import { checkAmount, WARNINGS } from '../../lib/requests/understand';
import { loadFixture } from '../fixtures';

const { reading } = loadFixture('single-amount');
const settings = { maxAmount: 10_000 };

/** What the code keeps when the model read `amount currency` from `quote` in `text`. */
const kept = (text: string, amount: number, currency: string, quote: string) =>
  checkAmount({ ...reading, amount, currency, amountQuote: quote }, text, settings);

type Row = [label: string, text: string, amount: number, currency: string, quote: string];

const DASHES = ['-', '‐', '‑', '‒', '–', '—', '―', '﹘', '﹣', '－', '−'];

describe('one-click: an email with a single, plain amount', () => {
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
    // Numbers that are plainly not amounts, recognised strictly, do not count.
    ['an ISO date', 'Please pay AUD 950 by 2026-11-20. Thanks.', 950, 'AUD', 'AUD 950'],
    ['a day and month', 'Please pay AUD 950 by 20 Nov. Thanks.', 950, 'AUD', 'AUD 950'],
    ['a month and day', 'Please pay AUD 950 before November 20th, 2026.', 950, 'AUD', 'AUD 950'],
    ['a d/m/y date', 'Please pay AUD 950 by 20/11/2026.', 950, 'AUD', 'AUD 950'],
    ['a time', 'Please pay AUD 950 before 9:30 am today.', 950, 'AUD', 'AUD 950'],
    ['an international phone number', 'Questions: +61 2 9999 0000. Please pay AUD 950 here.', 950, 'AUD', 'AUD 950'],
    ['a date right next to it', 'Due 2026-11-20, AUD 950 in total.', 950, 'AUD', 'AUD 950 in total'],
  ];
  it.each(clear)('keeps it: %s', (_label, text, amount, currency, quote) => {
    expect(kept(text, amount, currency, quote)).toEqual({ amount, currency, warnings: [] });
  });

  it('keeps the single-amount fixture as recorded from the real model', () => {
    const { email } = loadFixture('single-amount');
    expect(checkAmount(reading, email.text, settings)).toEqual({ amount: 640, currency: 'AUD', warnings: [] });
  });
});

describe('no one-click: anything else is typed by a person', () => {
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
    // Round 2: other ways of writing numbers, ids and phone numbers.
    ['decimal comma', 'Total AUD 12,50 today.', 12.5, 'AUD', 'AUD 12,50'],
    ['dots and comma', 'Total AUD 1.250,00 today.', 1250, 'AUD', 'AUD 1.250,00'],
    ['three decimals', 'Total AUD 950.505 today.', 950.5, 'AUD', 'AUD 950.505'],
    ['leading zero', 'Total AUD 0950 today.', 950, 'AUD', 'AUD 0950'],
    ['zero', 'A charge of AUD 0.00 please.', 0, 'AUD', 'AUD 0.00'],
    ['rounds to zero', 'A test charge of AUD 0.004 please.', 0.004, 'AUD', 'AUD 0.004'],
    ['decimals on a currency without', 'Total JPY 950.50 today.', 950.5, 'JPY', 'JPY 950.50'],
    ['invoice number', 'For invoice #950 we owe AUD 120.', 950, 'AUD', 'invoice #950 we owe AUD 120'],
    ['invoice number, the other one', 'For invoice #950 we owe AUD 120.', 120, 'AUD', 'AUD 120'],
    ['hyphenated id', 'For invoice 1042-950 we owe AUD 120.', 950, 'AUD', 'invoice 1042-950'],
    ['phone number', 'Call our AUD desk on +61 2 9999 0950.', 950, 'AUD', '+61 2 9999 0950'],
    ['a date-shaped number', 'Order of 2026-09-50, please.', 50, 'AUD', '2026-09-50'],
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
    // Rounds 4 and 5: ranges and choices.
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
    // Round 6: abbreviations, other connectors, corrections, rates and parts.
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
    ['two amounts far apart', 'We owe AUD 950 for coffee. We also owe you AUD 120 for cups.', 950, 'AUD', 'AUD 950'],
    ['the same amount twice', 'Pay AUD 950 now please. Last month was AUD 950 too.', 950, 'AUD', 'AUD 950'],
    ['another number far away', 'Pay AUD 950 in total please. Or call us on 990 if not.', 950, 'AUD', 'AUD 950'],
    [
      'a labelled total with line items',
      '2 bags at AUD 38 each and 3 bags at AUD 50 each. The total due is AUD 226.',
      226,
      'AUD',
      'AUD 226',
    ],
    // Round 7: bare second numbers, other cases, negated or stale totals.
    ['a bare second number', 'AUD 950 or 1200', 950, 'AUD', 'AUD 950'],
    ['maybe another', '950 AUD, maybe 1,100', 950, 'AUD', '950 AUD'],
    ['the other one in lower case', 'aud 950 and Aud 1,200', 950, 'AUD', 'aud 950'],
    ['a rate first', 'AUD 38 per kg, AUD 950', 950, 'AUD', 'AUD 950'],
    ['not the total', 'This is not the total of AUD 950.', 950, 'AUD', 'AUD 950'],
    ['an old total', 'Our old total was AUD 950.', 950, 'AUD', 'AUD 950'],
    ['last month', "AUD 950 was last month's total.", 950, 'AUD', 'AUD 950'],
    ['about', 'It comes to about AUD 950.', 950, 'AUD', 'AUD 950'],
    ['approx', 'It comes to approx. AUD 950.', 950, 'AUD', 'AUD 950'],
    ['up to', 'Please charge up to AUD 950.', 950, 'AUD', 'AUD 950'],
    ['at least', 'It will be at least AUD 950.', 950, 'AUD', 'AUD 950'],
    ['or so', 'It will be AUD 950 or so.', 950, 'AUD', 'AUD 950'],
    ['instead of', 'Please charge instead of AUD 950 next time.', 950, 'AUD', 'AUD 950'],
    ['no longer', 'The price is no longer AUD 950.', 950, 'AUD', 'AUD 950'],
    ['monthly', 'The plan is AUD 950 monthly.', 950, 'AUD', 'AUD 950'],
    ['roughly', 'Roughly AUD 950, I think.', 950, 'AUD', 'AUD 950'],
    // Limits.
    ['text over the cap', `Pay AUD 950 to ${'x'.repeat(10_000)} soon.`, 950, 'AUD', 'AUD 950'],
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

  it('the café email, with a unit price and a total, goes to a person', () => {
    const { email, reading: café } = loadFixture('opening-order');
    expect(checkAmount(café, email.text, settings)).toEqual({ amount: null, currency: null, warnings: [WARNINGS.severalNumbers] });
  });

  it('says which part was unclear', () => {
    expect(kept('Please send a link for $950 in total.', 950, 'USD', '$950').warnings).toEqual([WARNINGS.currencyNotStated]);
    expect(kept('A link for AUD 950.75.', 950, 'AUD', 'AUD 950').warnings).toEqual([WARNINGS.amountNotInEmail]);
    expect(kept('So AUD 950,000 in total.', 950000, 'AUD', 'AUD 950,000').warnings).toEqual([WARNINGS.amountOverLimit]);
    expect(kept('AUD 950 or 1200', 950, 'AUD', 'AUD 950').warnings).toEqual([WARNINGS.severalNumbers]);
    expect(kept('It comes to about AUD 950.', 950, 'AUD', 'AUD 950').warnings).toEqual([WARNINGS.amountNotPlain]);
  });
});

describe('random emails with two numbers', () => {
  // Deterministic, so a failure always reproduces: mulberry32.
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(next: () => number, items: readonly T[]): T => items[Math.floor(next() * items.length)];
  const AMOUNTS = ['AUD 950', 'AUD 1,200', '€590', 'A$2,000', 'AUD 38', '1,200 AUD', 'US$75.50', 'AUD 120', 'aud 640', 'AUD 950'];
  const NUMBERS = ['1200', '38', '2,000', '3', '12', '950', '0.5'];
  const WORDS = [
    'or',
    'and',
    'and/or',
    'to',
    'vs',
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
    'total',
    'in total',
    'amount due',
    '=',
    'deposit',
    'balance',
    '(',
    ')',
    'then',
    'maybe',
    'later.',
    'Thanks.',
    'please',
    'pay',
    ';',
    ',',
    '\n',
  ];
  const amountOf = (written: string) => Number(written.replace(/[^0-9.]/g, ''));
  const currencyOf = (written: string) => (written.includes('€') ? 'EUR' : written.includes('US$') ? 'USD' : 'AUD');
  const words = (next: () => number, max: number) =>
    Array.from({ length: Math.floor(next() * (max + 1)) }, () => pick(next, WORDS)).join(' ');

  it('are never one-click, whatever the words around and between them', () => {
    const next = random(13);
    for (let run = 0; run < 4_000; run += 1) {
      const quoted = pick(next, AMOUNTS);
      const other = next() < 0.5 ? pick(next, AMOUNTS) : pick(next, NUMBERS);
      const [first, second] = next() < 0.5 ? [quoted, other] : [other, quoted];
      const text = `${words(next, 6)} ${first} ${words(next, 20)} ${second} ${words(next, 6)}`;
      const result = kept(text, amountOf(quoted), currencyOf(quoted), quoted);
      if (result.amount !== null) throw new Error(`one-click on ${JSON.stringify(text)} for ${quoted}`);
    }
  });

  it('are never one-click when a non-amount is wrapped in random text', () => {
    const next = random(20261113);
    const junk = [...'abcxyzAUDEUR .,;:!?()[]"\'’#_+/%$€£\n\t', ...DASHES, '​', '‮', ' ', '٣'];
    const cores: [string, number][] = [
      ['AUD -950', 950],
      ['AUD #950', 950],
      ["AUD 1'250", 1250],
      ['AUD 12,50', 12.5],
      ['AUD 950x', 950],
      ['AUD 1_250', 1250],
      ['AUD ٩٥٠', 950],
      ['AUD 1.250,00', 1250],
    ];
    const around = () => Array.from({ length: Math.floor(next() * 8) }, () => pick(next, junk)).join('');
    for (let run = 0; run < 2_000; run += 1) {
      const [core, amount] = cores[run % cores.length];
      const text = `${around()}${core}${around()}`;
      if (kept(text, amount, 'AUD', core).amount !== null) throw new Error(`one-click on ${JSON.stringify(text)}`);
    }
  });
});

describe('the parts of the rule', () => {
  it('normalizes dashes, spaces and invisible characters once', () => {
    expect(normalizeForAmounts('AUD 950–​1,200 \n\tnow')).toBe('AUD 950-1,200 now');
  });

  it('counts every number except strictly recognised dates, times and international phone numbers', () => {
    const count = (text: string) => numbersIn(normalizeForAmounts(text)).length;
    expect(count('AUD 950 on 2026-11-20 at 9:30 am, call +61 2 9999 0000')).toBe(1);
    expect(count('AUD 950 on 20 Nov or Nov 20th, 2026, 5pm')).toBe(1);
    expect(count('AUD 950, and 50 may be fine')).toBe(2);
    expect(count('AUD 950 ref 2026')).toBe(2);
    expect(count('AUD 950 call 9999 0000')).toBe(3);
  });

  it('lists the amounts written as money, for the card', () => {
    expect(moneyMentioned(loadFixture('opening-order').email.text)).toEqual(['AUD 38', 'AUD 950']);
    expect(moneyMentioned('AUD 950, then AUD 950, then €5 and 7 boxes')).toEqual(['AUD 950', '€5']);
    expect(moneyMentioned('٣ and AUD 950')).toEqual([]);
  });

  it('needs a quote that is in the email', () => {
    expect(readAmount(null, 'AUD 950')).toEqual({ kind: 'unclear', reason: 'not-found' });
    expect(readAmount('   ', 'AUD 950')).toEqual({ kind: 'unclear', reason: 'not-found' });
    expect(readAmount('AUD 950', 'Please pay AUD 950 today.')).toEqual({ kind: 'clear', value: 950, currency: 'AUD' });
  });
});
