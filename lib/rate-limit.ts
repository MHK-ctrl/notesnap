/**
 * Best-effort in-memory rate limiting for the OCR route.
 *
 * A public demo shouldn't be able to burn through a deployer's Vision quota, so
 * each client IP gets a fixed window of requests.
 *
 * Caveat (documented in the README): the counter lives in the memory of a
 * single serverless instance. On Vercel, concurrent instances each keep their
 * own counter, so the real limit is `limit x instances` for a burst. That is
 * fine as a speed bump; swap in Upstash Ratelimit (or similar) if you need a
 * hard global limit.
 */

export interface RateLimitConfig {
  /** Requests allowed per window, per key. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = { limit: 10, windowMs: 60_000 };

/** Upper bound on tracked keys before we prune expired entries. */
const MAX_TRACKED_KEYS = 5_000;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

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

export type RateLimitResult =
  | { ok: true; limit: number; remaining: number; resetAt: number }
  | { ok: false; limit: number; remaining: 0; resetAt: number; retryAfterSeconds: number };

/**
 * Records one request for `key` and reports whether it is allowed.
 * `now` is injectable so tests don't need fake timers.
 */
export function checkRateLimit(
  key: string,
  now: number = Date.now(),
  config: RateLimitConfig = getRateLimitConfig(),
): RateLimitResult {
  if (buckets.size > MAX_TRACKED_KEYS) pruneExpired(now);

  const bucket = buckets.get(key);
  const freshBucket: Bucket = { count: 1, resetAt: now + config.windowMs };

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, freshBucket);
    return {
      ok: true,
      limit: config.limit,
      remaining: Math.max(0, config.limit - 1),
      resetAt: freshBucket.resetAt,
    };
  }

  if (bucket.count >= config.limit) {
    return {
      ok: false,
      limit: config.limit,
      remaining: 0,
      resetAt: bucket.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  bucket.count += 1;
  return {
    ok: true,
    limit: config.limit,
    remaining: Math.max(0, config.limit - bucket.count),
    resetAt: bucket.resetAt,
  };
}

/** Drops every stored counter. Used by tests. */
export function resetRateLimitStore(): void {
  buckets.clear();
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
