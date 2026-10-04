import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_RATE_LIMIT,
  checkRateLimit,
  getClientKey,
  getRateLimitConfig,
  resetRateLimitStore,
} from "@/lib/rate-limit";

const config = { limit: 3, windowMs: 60_000 };

beforeEach(() => {
  resetRateLimitStore();
});

describe("checkRateLimit", () => {
  it("allows requests up to the limit and reports what's left", () => {
    const first = checkRateLimit("1.2.3.4", 1_000, config);
    const second = checkRateLimit("1.2.3.4", 1_001, config);

    expect(first).toMatchObject({ ok: true, limit: 3, remaining: 2 });
    expect(second).toMatchObject({ ok: true, remaining: 1 });
  });

  it("blocks the request after the limit is reached", () => {
    checkRateLimit("1.2.3.4", 1_000, config);
    checkRateLimit("1.2.3.4", 1_001, config);
    checkRateLimit("1.2.3.4", 1_002, config);

    const blocked = checkRateLimit("1.2.3.4", 1_003, config);

    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("counts each key separately", () => {
    checkRateLimit("1.2.3.4", 1_000, config);
    checkRateLimit("1.2.3.4", 1_000, config);
    checkRateLimit("1.2.3.4", 1_000, config);

    expect(checkRateLimit("5.6.7.8", 1_000, config)).toMatchObject({ ok: true, remaining: 2 });
  });

  it("starts a fresh window once the old one expires", () => {
    checkRateLimit("1.2.3.4", 0, config);
    checkRateLimit("1.2.3.4", 0, config);
    checkRateLimit("1.2.3.4", 0, config);
    expect(checkRateLimit("1.2.3.4", 1_000, config).ok).toBe(false);

    const afterWindow = checkRateLimit("1.2.3.4", 60_000, config);
    expect(afterWindow).toMatchObject({ ok: true, remaining: 2 });
  });

  it("reports retryAfterSeconds rounded up to the window end", () => {
    checkRateLimit("1.2.3.4", 0, { limit: 1, windowMs: 30_000 });
    const blocked = checkRateLimit("1.2.3.4", 1, { limit: 1, windowMs: 30_000 });

    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.retryAfterSeconds).toBe(30);
  });

  it("falls back to safe defaults when env values are absent or invalid", () => {
    expect(getRateLimitConfig()).toEqual(DEFAULT_RATE_LIMIT);
  });
});

describe("getRateLimitConfig", () => {
  const original = { max: process.env.RATE_LIMIT_MAX, window: process.env.RATE_LIMIT_WINDOW_MS };

  afterEach(() => {
    restoreEnv("RATE_LIMIT_MAX", original.max);
    restoreEnv("RATE_LIMIT_WINDOW_MS", original.window);
  });

  it("reads limits from the environment", () => {
    process.env.RATE_LIMIT_MAX = "25";
    process.env.RATE_LIMIT_WINDOW_MS = "30000";
    expect(getRateLimitConfig()).toEqual({ limit: 25, windowMs: 30_000 });
  });

  it("ignores garbage values", () => {
    process.env.RATE_LIMIT_MAX = "lots";
    process.env.RATE_LIMIT_WINDOW_MS = "-5";
    expect(getRateLimitConfig()).toEqual(DEFAULT_RATE_LIMIT);
  });
});

describe("getClientKey", () => {
  it("uses the first hop in x-forwarded-for", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.9, 70.41.3.18, 150.172.238.178" });
    expect(getClientKey(headers)).toBe("203.0.113.9");
  });

  it("falls back to x-real-ip", () => {
    expect(getClientKey(new Headers({ "x-real-ip": "203.0.113.10" }))).toBe("203.0.113.10");
  });

  it("returns a stable placeholder when no IP header is present", () => {
    expect(getClientKey(new Headers())).toBe("unknown");
  });
});

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
