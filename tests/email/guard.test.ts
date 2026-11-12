import { describe, expect, it } from 'vitest';
import { clipText, MAX_EMAIL_TEXT_CHARS, RateLimiter, ReplayCache } from '../../lib/email/guard';

describe('replay cache', () => {
  it('reports a key the second time it is seen', () => {
    const cache = new ReplayCache(1000);
    expect(cache.seen('msg_1', 0)).toBe(false);
    expect(cache.seen('msg_1', 10)).toBe(true);
    expect(cache.seen('msg_2', 10)).toBe(false);
  });

  it('forgets a key once its time is up', () => {
    const cache = new ReplayCache(1000);
    cache.seen('msg_1', 0);
    expect(cache.seen('msg_1', 1001)).toBe(false);
  });

  it('stays within its size limit by dropping the oldest key', () => {
    const cache = new ReplayCache(10_000, 2);
    cache.seen('a', 0);
    cache.seen('b', 1);
    cache.seen('c', 2);
    expect(cache.seen('a', 3)).toBe(false);
    expect(cache.seen('c', 3)).toBe(true);
  });
});

describe('rate limiter', () => {
  it('allows up to the limit in a window, then refuses until the next window', () => {
    const limiter = new RateLimiter(2, 1000);
    expect([limiter.allow('k', 0), limiter.allow('k', 1), limiter.allow('k', 2)]).toEqual([true, true, false]);
    expect(limiter.allow('k', 1000)).toBe(true);
  });

  it('counts each key on its own', () => {
    const limiter = new RateLimiter(1, 1000);
    expect(limiter.allow('a', 0)).toBe(true);
    expect(limiter.allow('b', 0)).toBe(true);
    expect(limiter.allow('a', 1)).toBe(false);
  });

  it('starts over when it holds too many keys', () => {
    const limiter = new RateLimiter(1, 1000, 1);
    limiter.allow('a', 0);
    limiter.allow('b', 0);
    expect(limiter.allow('a', 1)).toBe(true);
  });
});

describe('clipText', () => {
  it('keeps short text and cuts long text, saying so', () => {
    expect(clipText('hello')).toEqual({ text: 'hello', clipped: false });
    const long = clipText('x'.repeat(MAX_EMAIL_TEXT_CHARS + 5));
    expect(long.text).toHaveLength(MAX_EMAIL_TEXT_CHARS);
    expect(long.clipped).toBe(true);
  });
});
