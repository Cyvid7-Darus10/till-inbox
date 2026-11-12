import { describe, expect, it } from 'vitest';
import { htmlToText, parseAddress } from '../lib/email/provider';
import { amountAtQuote, MAX_AMOUNT_TEXT_CHARS, MAX_AMOUNT_TOKENS } from '../lib/requests/amount';
import { cleanField } from '../lib/requests/clean';
import { looksLikeInstructions } from '../lib/requests/understand';

/**
 * Email text is attacker-controlled. Every parser that reads it must finish quickly whatever it is
 * fed. The budget is generous so CI is not flaky, but far below what a backtracking blow-up takes.
 */
const BUDGET_MS = 750;

function timed<T>(work: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = work();
  return { result, ms: performance.now() - start };
}

const repeat = (text: string, times: number): string => text.repeat(times);

describe('reading an amount from hostile text', () => {
  const cases: [label: string, text: string, quote: string][] = [
    ['50,000 digits', repeat('1', 50_000), '1'],
    ['digits and letters under the cap', repeat('1x', 3_999), '1x1'],
    ['5,000 tokens', repeat('1, ', 5_000), '1, 1'],
    ['tokens under the cap', repeat('1, ', 2_600), '1, 1'],
    ['a long chain of "1 to"', repeat('AUD 1 to ', 880), 'AUD 1 to'],
    ['long runs without spaces', repeat(`${repeat('9', 30)}x${repeat('-', 30)} to `, 120), 'to'],
    ['only dashes and digits', repeat('9-', 3_999), '9-9'],
    ['every currency code in a row', repeat('AUD USD EUR GBP ', 499), 'AUD'],
  ];

  it.each(cases)('finishes quickly with no amount: %s', (_label, text, quote) => {
    const { result, ms } = timed(() => amountAtQuote(quote, text));
    expect(result).toBeNull();
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('reads no amount from text longer than the cap, or with too many tokens', () => {
    expect(amountAtQuote('AUD 950', `${repeat('x', MAX_AMOUNT_TEXT_CHARS)} AUD 950`)).toBeNull();
    expect(amountAtQuote('AUD 950', `${repeat('AUD 1, ', MAX_AMOUNT_TOKENS)}AUD 950`)).toBeNull();
    expect(amountAtQuote('AUD 950', `${repeat('AUD 1, ', MAX_AMOUNT_TOKENS - 2)}AUD 950`)).toMatchObject({ value: 950 });
  });
});

describe('other parsers of email text', () => {
  const huge = 200_000;
  const cases: [label: string, work: () => unknown][] = [
    ['cleaning a run with no spaces', () => cleanField(repeat('a', huge), 160)],
    ['cleaning many at signs', () => cleanField(repeat('a@', huge / 2), 160)],
    ['cleaning a long dotted name', () => cleanField(repeat('a.', huge / 2), 160)],
    ['html with unclosed script tags', () => htmlToText(repeat('<script>', huge / 8))],
    ['html with many closed script tags', () => htmlToText(repeat('<script>x</script>', huge / 18))],
    ['html with unclosed brackets', () => htmlToText(repeat('<', huge))],
    ['html with blank lines', () => htmlToText(`\n${repeat(' ', huge)}x`)],
    ['a From header with many at signs', () => parseAddress(`${repeat('a@', huge / 2)} b`)],
    ['a From header with a long name', () => parseAddress(`"${repeat('a', huge)} <a@example.com>`)],
    ['spotting injected instructions', () => looksLikeInstructions(repeat('ignore previous ', huge / 16))],
  ];

  it.each(cases)('finishes quickly: %s', (_label, work) => {
    expect(timed(work).ms).toBeLessThan(BUDGET_MS);
  });
});
