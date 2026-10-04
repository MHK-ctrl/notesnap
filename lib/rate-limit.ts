/**
 * Rate limiting for the OCR route.
 *
 * Two modes, chosen by environment:
 *
 * 1. `shared` — Upstash Redis through `@upstash/ratelimit`. Counters live in
 *    Redis, so every serverless instance sees the same numbers. This is the mode
 *    you want in production. Configure `UPSTASH_REDIS_REST_URL` and
 *    `UPSTASH_REDIS_REST_TOKEN` (see README).
 *
 * 2. `instance` — a fixed-window counter in module memory. Used when Upstash is
 *    not configured (local development) or when Redis errors out. This is a
 *    speed bump, not a quota: each serverless instance keeps its own counter, so
 *    a burst spread across instances can exceed the nominal limit.
 *
 * `/api/transcribe` reports which mode answered in the `X-RateLimit-Mode`
 * header, so a deployment's real behaviour is checkable from the outside
 * instead of assumed.
 */

import "server-only";

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export interface RateLimitConfig {
  /** Requests allowed per window, per key. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = { limit: 10, windowMs: 60_000 };

/** Upper bound on tracked keys before the in-memory store is pruned. */
const MAX_TRACKED_KEYS = 5_000;

export type RateLimitMode = "shared" | "instance";

export type RateLimitResult =
  | { ok: true; mode: RateLimitMode; limit: number; remaining: number; resetAt: number }
  | {
      ok: false;
      mode: RateLimitMode;
      limit: number;
      remaining: 0;
      resetAt: number;
      retryAfterSeconds: number;
    };

/** The part of an Upstash limiter this app uses, so tests can fake it. */
export interface SharedLimiter {
  limit(key: string): Promise<{
    success: boolean;
    limit: number;
    remaining: number;
    /** Epoch milliseconds when the window resets, as Upstash returns it. */
    reset: number;
  }>;
}

export interface CheckRateLimitOptions {
  /** Injectable clock; defaults to `Date.now()`. */
  now?: number;
  config?: RateLimitConfig;
  /**
   * Injectable for tests. `undefined` means "use Upstash when configured";
   * `null` forces the in-memory limiter.
   */
  sharedLimiter?: SharedLimiter | null;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

let cachedLimiter: { cacheKey: string; limiter: SharedLimiter } | null = null;
let warnedAboutFallback = false;

/** Reads rate-limit knobs from env at request time, falling back to defaults. */
export function getRateLimitConfig(): RateLimitConfig {
  const limit = Number.parseInt(process.env.RATE_LIMIT_MAX ?? "", 10);
  const windowMs = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "", 10);
  return {
    limit: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_RATE_LIMIT.limit,
    windowMs:
      Number.isFinite(windowMs) && windowMs > 0 ? windowMs : DEFAULT_RATE_LIMIT.windowMs,
  };
}

/** True when a shared Upstash store is configured. */
export function isSharedRateLimitConfigured(): boolean {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL?.trim() &&
      process.env.UPSTASH_REDIS_REST_TOKEN?.trim(),
  );
}

/** The Upstash-backed limiter, or null when it isn't configured. */
function getSharedLimiter(config: RateLimitConfig): SharedLimiter | null {
  if (!isSharedRateLimitConfigured()) return null;

  const cacheKey = `${config.limit}:${config.windowMs}`;
  if (cachedLimiter?.cacheKey === cacheKey) return cachedLimiter.limiter;

  const ratelimit = new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(config.limit, `${config.windowMs} ms`),
    prefix: "notesnap:transcribe",
    analytics: false,
  });

  const limiter: SharedLimiter = {
    limit: async (key) => {
      const { success, limit, remaining, reset } = await ratelimit.limit(key);
      return { success, limit, remaining, reset };
    },
  };

  cachedLimiter = { cacheKey, limiter };
  return limiter;
}

/**
 * Records one request for `key` and reports whether it is allowed.
 *
 * Never throws: if the shared store is unreachable the request falls back to
 * per-instance limiting (logged), rather than taking the whole app down.
 */
export async function checkRateLimit(
  key: string,
  options: CheckRateLimitOptions = {},
): Promise<RateLimitResult> {
  const config = options.config ?? getRateLimitConfig();
  const now = options.now ?? Date.now();
  const limiter =
    options.sharedLimiter !== undefined ? options.sharedLimiter : getSharedLimiter(config);

  if (limiter) {
    try {
      const result = await limiter.limit(key);
      const retryAfterSeconds = Math.max(1, Math.ceil((result.reset - now) / 1000));
      const remaining = Math.max(0, Math.floor(result.remaining));

      return result.success
        ? { ok: true, mode: "shared", limit: result.limit, remaining, resetAt: result.reset }
        : {
            ok: false,
            mode: "shared",
            limit: result.limit,
            remaining: 0,
            resetAt: result.reset,
            retryAfterSeconds,
          };
    } catch (error) {
      console.error(
        "[notesnap] shared rate limiter unavailable — falling back to per-instance limiting",
        error,
      );
    }
  } else if (process.env.NODE_ENV === "production" && !warnedAboutFallback) {
    warnedAboutFallback = true;
    console.warn(
      "[notesnap] UPSTASH_REDIS_REST_URL/TOKEN are not set: rate limiting is per-instance only and can be exceeded by traffic spread across serverless instances. See README > Deploy.",
    );
  }

  return checkInstanceRateLimit(key, now, config);
}

/** Per-instance fixed-window counter. */
function checkInstanceRateLimit(
  key: string,
  now: number,
  config: RateLimitConfig,
): RateLimitResult {
  if (buckets.size > MAX_TRACKED_KEYS) pruneExpired(now);

  const bucket = buckets.get(key);
  const freshBucket: Bucket = { count: 1, resetAt: now + config.windowMs };

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, freshBucket);
    return {
      ok: true,
      mode: "instance",
      limit: config.limit,
      remaining: Math.max(0, config.limit - 1),
      resetAt: freshBucket.resetAt,
    };
  }

  if (bucket.count >= config.limit) {
    return {
      ok: false,
      mode: "instance",
      limit: config.limit,
      remaining: 0,
      resetAt: bucket.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  bucket.count += 1;
  return {
    ok: true,
    mode: "instance",
    limit: config.limit,
    remaining: Math.max(0, config.limit - bucket.count),
    resetAt: bucket.resetAt,
  };
}

/** Drops stored counters and the cached limiter. Used by tests. */
export function resetRateLimitStore(): void {
  buckets.clear();
  cachedLimiter = null;
  warnedAboutFallback = false;
}

function pruneExpired(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Best-effort client identity for rate limiting.
 *
 * `x-forwarded-for` is client-controllable when a proxy doesn't overwrite it,
 * so this is a quota guard, not an authentication boundary.
 */
export function getClientKey(headers: Headers): string {
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
}
