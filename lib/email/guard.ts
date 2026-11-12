/**
 * Limits on the inbound webhook, kept in memory for one server instance: a replay cache (each
 * delivery id and email id is handled once) and fixed-window rate limits. Pure apart from the
 * clock, which callers pass in.
 *
 * Memory only covers one instance. The signature's five-minute window bounds what a replay could
 * do across instances, and the README explains how to add a shared store or a Vercel Firewall rule.
 */

/** Largest webhook body accepted. Resend sends metadata only, so real ones are a few kilobytes. */
export const MAX_WEBHOOK_BYTES = 64 * 1024;

/** Longest email text passed to the model. Longer emails are cut, and the card says so. */
export const MAX_EMAIL_TEXT_CHARS = 8_000;

/** Remembers keys for a while. `seen` reports whether a key was already there, then records it. */
export class ReplayCache {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 10_000,
  ) {}

  seen(key: string, nowMs: number): boolean {
    this.prune(nowMs);
    const expiry = this.entries.get(key);
    if (expiry !== undefined && expiry > nowMs) return true;
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, nowMs + this.ttlMs);
    return false;
  }

  private prune(nowMs: number): void {
    for (const [key, expiry] of this.entries) {
      if (expiry > nowMs) break;
      this.entries.delete(key);
    }
  }
}

/** A fixed-window counter per key. `allow` returns false once a key used up its window. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** True when this key has used up its current window. Does not count as a use. */
  exhausted(key: string, nowMs: number): boolean {
    const current = this.windows.get(key);
    return current !== undefined && nowMs - current.start < this.windowMs && current.count >= this.limit;
  }

  allow(key: string, nowMs: number): boolean {
    const current = this.windows.get(key);
    if (!current || nowMs - current.start >= this.windowMs) {
      if (!current && this.windows.size >= this.maxKeys) this.windows.clear();
      this.windows.set(key, { start: nowMs, count: 1 });
      return true;
    }
    if (current.count >= this.limit) return false;
    this.windows.set(key, { start: current.start, count: current.count + 1 });
    return true;
  }
}

/** Cuts email text to the model's limit and says whether it was cut. */
export function clipText(text: string, max = MAX_EMAIL_TEXT_CHARS): { text: string; clipped: boolean } {
  return text.length <= max ? { text, clipped: false } : { text: text.slice(0, max), clipped: true };
}
