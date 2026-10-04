import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_RATE_LIMIT,
  checkRateLimit,
  getClientKey,
  getRateLimitConfig,
  isSharedRateLimitConfigured,
  resetRateLimitStore,
  type SharedLimiter,
} from "@/lib/rate-limit";

const config = { limit: 3, windowMs: 60_000 };

/** A stand-in for the Upstash-backed limiter. */
function fakeSharedLimiter(
  responses: Array<{ success: boolean; limit: number; remaining: number; reset: number }>,
): SharedLimiter & { limit: ReturnType<typeof vi.fn> } {
  let call = 0;
  const limit = vi.fn(async () => {
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (!response) throw new Error("no response configured");
    return response;
  });
  return { limit } as SharedLimiter & { limit: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  resetRateLimitStore();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

describe("checkRateLimit — per-instance fallback", () => {
  it("allows requests up to the limit and reports what's left", async () => {
    const first = await checkRateLimit("1.2.3.4", { now: 1_000, config });
    const second = await checkRateLimit("1.2.3.4", { now: 1_001, config });

    expect(first).toMatchObject({ ok: true, mode: "instance", limit: 3, remaining: 2 });
    expect(second).toMatchObject({ ok: true, mode: "instance", remaining: 1 });
  });

  it("blocks the request after the limit is reached", async () => {
    await checkRateLimit("1.2.3.4", { now: 1_000, config });
    await checkRateLimit("1.2.3.4", { now: 1_001, config });
    await checkRateLimit("1.2.3.4", { now: 1_002, config });

    const blocked = await checkRateLimit("1.2.3.4", { now: 1_003, config });

    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.mode).toBe("instance");
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("counts each key separately", async () => {
    await checkRateLimit("1.2.3.4", { now: 1_000, config });
    await checkRateLimit("1.2.3.4", { now: 1_000, config });
    await checkRateLimit("1.2.3.4", { now: 1_000, config });

    expect(await checkRateLimit("5.6.7.8", { now: 1_000, config })).toMatchObject({
      ok: true,
      remaining: 2,
    });
  });

  it("starts a fresh window once the old one expires", async () => {
    await checkRateLimit("1.2.3.4", { now: 0, config });
    await checkRateLimit("1.2.3.4", { now: 0, config });
    await checkRateLimit("1.2.3.4", { now: 0, config });
    expect((await checkRateLimit("1.2.3.4", { now: 1_000, config })).ok).toBe(false);

    const afterWindow = await checkRateLimit("1.2.3.4", { now: 60_000, config });
    expect(afterWindow).toMatchObject({ ok: true, remaining: 2 });
  });

  it("reports retryAfterSeconds rounded up to the window end", async () => {
    await checkRateLimit("1.2.3.4", { now: 0, config: { limit: 1, windowMs: 30_000 } });
    const blocked = await checkRateLimit("1.2.3.4", {
      now: 1,
      config: { limit: 1, windowMs: 30_000 },
    });

    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.retryAfterSeconds).toBe(30);
  });

  it("forces instance mode when the shared limiter is explicitly null", async () => {
    const result = await checkRateLimit("1.2.3.4", { now: 0, config, sharedLimiter: null });
    expect(result).toMatchObject({ ok: true, mode: "instance" });
  });

  it("falls back to instance mode when the shared store throws", async () => {
    const exploding: SharedLimiter = {
      limit: async () => {
        throw new Error("redis unreachable");
      },
    };

    const result = await checkRateLimit("1.2.3.4", { now: 0, config, sharedLimiter: exploding });

    expect(result).toMatchObject({ ok: true, mode: "instance", limit: 3, remaining: 2 });
    expect(console.error).toHaveBeenCalled();
  });
});

describe("checkRateLimit — shared (Upstash) mode", () => {
  it("uses the shared limiter and tags the result as shared", async () => {
    const limiter = fakeSharedLimiter([
      { success: true, limit: 10, remaining: 4, reset: 61_000 },
    ]);

    const result = await checkRateLimit("1.2.3.4", { now: 1_000, config, sharedLimiter: limiter });

    expect(result).toEqual({
      ok: true,
      mode: "shared",
      limit: 10,
      remaining: 4,
      resetAt: 61_000,
    });
    expect(limiter.limit).toHaveBeenCalledWith("1.2.3.4");
  });

  it("blocks with the shared window's reset time", async () => {
    const limiter = fakeSharedLimiter([
      { success: false, limit: 10, remaining: 0, reset: 61_000 },
    ]);

    const result = await checkRateLimit("1.2.3.4", { now: 1_000, config, sharedLimiter: limiter });

    expect(result).toEqual({
      ok: false,
      mode: "shared",
      limit: 10,
      remaining: 0,
      resetAt: 61_000,
      retryAfterSeconds: 60,
    });
  });

  it("never reports negative remaining counts", async () => {
    const limiter = fakeSharedLimiter([{ success: true, limit: 5, remaining: -1, reset: 5_000 }]);

    const result = await checkRateLimit("k", { now: 0, config, sharedLimiter: limiter });
    expect(result.ok && result.remaining).toBe(0);
  });

  it("does not touch the instance store while the shared store works", async () => {
    const limiter = fakeSharedLimiter([
      { success: true, limit: 10, remaining: 9, reset: 10_000 },
    ]);

    await checkRateLimit("key", { now: 0, config, sharedLimiter: limiter });
    await checkRateLimit("key", { now: 0, config, sharedLimiter: limiter });

    // Both calls delegated; the local counter never incremented.
    expect(limiter.limit).toHaveBeenCalledTimes(2);
  });
});

describe("isSharedRateLimitConfigured", () => {
  it("is false without Upstash env vars", () => {
    expect(isSharedRateLimitConfigured()).toBe(false);
  });

  it("is true when both URL and token are present", () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token-value";
    expect(isSharedRateLimitConfigured()).toBe(true);
  });

  it("is false when only one of the two is present", () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    expect(isSharedRateLimitConfigured()).toBe(false);
  });

  it("is false for blank values", () => {
    process.env.UPSTASH_REDIS_REST_URL = "   ";
    process.env.UPSTASH_REDIS_REST_TOKEN = "   ";
    expect(isSharedRateLimitConfigured()).toBe(false);
  });
});

describe("getRateLimitConfig", () => {
  it("falls back to safe defaults when env values are absent or invalid", () => {
    expect(getRateLimitConfig()).toEqual(DEFAULT_RATE_LIMIT);
  });

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
