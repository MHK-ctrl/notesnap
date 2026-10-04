/**
 * Shared quota accounting for the public demo — server-only.
 *
 * The problem this solves: the Gemini free tier's requests-per-day quota belongs
 * to the *project*, not the key, and resets at midnight Pacific. On a publicly
 * reachable deployment that means any visitor can spend the maintainer's daily
 * budget, and once it is gone every visitor gets an error until the reset. A
 * per-instance memory limiter cannot prevent this — each serverless instance
 * keeps its own counter, so the real ceiling is "instances x limit" and nobody
 * can see the day's true spend.
 *
 * Everything here therefore lives in Upstash Redis, which every instance shares:
 *
 * 1. `burst`       — per-IP sliding window (RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS).
 * 2. `perIpDaily`  — per-IP daily cap (PER_IP_DAILY_MAX), keyed by Pacific date.
 * 3. `globalDaily` — one counter for the whole demo (DEMO_DAILY_MAX), incremented
 *                    atomically so concurrent requests cannot overshoot.
 * 4. `breaker`     — a flag set when the provider confirms its daily quota is
 *                    gone, so we stop spending requests discovering that.
 *
 * Two deliberate design choices:
 *
 * - **Fail closed.** If Redis is unreachable the demo refuses rather than
 *   silently serving from per-instance memory. An unmetered fallback would let a
 *   Redis blip hand visitors an unlimited budget and burn the project's quota;
 *   the honest answer is to say the demo is unavailable and point people at their
 *   own key.
 *
 * - **Budget is checked before the provider call, and never refunded.** Refunding
 *   on provider failure would let a retrying client spend quota it never used.
 *   Bring-your-own-key requests bypass these counters entirely because they spend
 *   the visitor's own provider quota, not the maintainer's.
 */

import "server-only";

import { Redis } from "@upstash/redis";

import { nextPacificMidnight, pacificDateKey, secondsUntil } from "./pacific-time";

/** Namespace for every key this module writes, so it can share a database safely. */
const PREFIX = "notesnap:quota";

/** Defaults chosen to sit well under a typical free-tier daily cap. */
export const DEFAULT_PER_IP_DAILY_MAX = 10;
export const DEFAULT_GLOBAL_DAILY_MAX = 100;

/** How long the breaker flag lives. Pacific days are 23–25h; this is a safe upper bound. */
const BREAKER_TTL_SECONDS = 26 * 60 * 60;

/** The Redis operations this module needs, so tests can supply a fake. */
export interface SharedStore {
  /** Atomically increments `key`, returning the value *after* the increment. */
  increment(key: string): Promise<number>;
  /** Sets `key` with a TTL in seconds. */
  setExpiring(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Reads a string value, or null when the key is absent or expired. */
  get(key: string): Promise<string | null>;
  /** Sets a TTL in seconds on an existing key. `INCR` does not create one. */
  expire(key: string, ttlSeconds: number): Promise<void>;
  /** Clears a key. Used by tests and by the demo-budget reset helper. */
  del(key: string): Promise<void>;
}

/** Builds the Redis-backed store from env, or null when Upstash isn't configured. */
export function getSharedStore(): SharedStore | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return null;

  const redis = Redis.fromEnv();
  return {
    increment: async (key) => redis.incr(key),
    setExpiring: async (key, value, ttlSeconds) => {
      await redis.set(key, value, { ex: ttlSeconds });
    },
    get: async (key) => {
      const value = await redis.get<string>(key);
      return value ?? null;
    },
    expire: async (key, ttlSeconds) => {
      await redis.expire(key, ttlSeconds);
    },
    del: async (key) => {
      await redis.del(key);
    },
  };
}

export function isSharedStoreConfigured(): boolean {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL?.trim() &&
      process.env.UPSTASH_REDIS_REST_TOKEN?.trim(),
  );
}

/** Per-IP daily cap from env, defaulting to {@link DEFAULT_PER_IP_DAILY_MAX}. */
export function getPerIpDailyMax(): number {
  return readPositiveInt(process.env.PER_IP_DAILY_MAX, DEFAULT_PER_IP_DAILY_MAX);
}

/** Whole-demo daily cap from env, defaulting to {@link DEFAULT_GLOBAL_DAILY_MAX}. */
export function getGlobalDailyMax(): number {
  return readPositiveInt(process.env.DEMO_DAILY_MAX, DEFAULT_GLOBAL_DAILY_MAX);
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface DemoBudgetStatus {
  /** False when the shared store is missing or the provider quota is gone. */
  available: boolean;
  /** Demo transcriptions spent today, or null when it can't be read. */
  used: number | null;
  /** The whole-demo daily cap. */
  limit: number;
  /** Epoch ms of the next Pacific midnight, or null when unknown. */
  resetsAt: number | null;
}

export interface BudgetDecision {
  ok: boolean;
  /** Present when `ok` is false. */
  reason?: "per_ip_daily" | "global_daily" | "store_unavailable" | "quota_exhausted";
  /** Epoch ms the budget frees up. */
  resetsAt?: number;
  /** Remaining demo transcriptions after this request, when known. */
  remaining?: number;
}

/** True when the provider already told us its daily quota is spent for today. */
export async function isQuotaBreakerSet(
  store: SharedStore,
  provider: string,
  model: string,
  now: Date = new Date(),
): Promise<boolean> {
  return (await store.get(breakerKey(provider, model, now))) !== null;
}

/**
 * Records that the provider confirmed its daily quota is exhausted.
 *
 * The flag is namespaced by provider *and* model because Google's limits are
 * per project per model: a spent quota on one model says nothing about another.
 * It expires on its own at the Pacific day boundary, so this is a cache of a
 * fact that is true for the rest of the day rather than permanent state.
 */
export async function setQuotaBreaker(
  store: SharedStore,
  provider: string,
  model: string,
  now: Date = new Date(),
): Promise<void> {
  await store.setExpiring(
    breakerKey(provider, model, now),
    now.toISOString(),
    BREAKER_TTL_SECONDS,
  );
}

/** Clears the breaker. Exposed for tests and for an operator resetting state. */
export async function clearQuotaBreaker(
  store: SharedStore,
  provider: string,
  model: string,
  now: Date = new Date(),
): Promise<void> {
  await store.del(breakerKey(provider, model, now));
}

/**
 * Charges one demo request against the per-IP and global daily budgets.
 *
 * The global counter is incremented before deciding, so concurrent requests
 * cannot all read "99" and each allow itself as the 100th+ request. The cost of
 * that choice: a request rejected by the *per-IP* check has already incremented
 * the global counter. That is intentional — the request did happen, and the
 * provider budget is spent by attempts, not by successes.
 */
export async function consumeDemoBudget(
  store: SharedStore,
  clientKey: string,
  now: Date = new Date(),
): Promise<BudgetDecision> {
  const dateKey = pacificDateKey(now);
  const resetsAt = nextPacificMidnight(now);
  const globalLimit = getGlobalDailyMax();
  const perIpLimit = getPerIpDailyMax();

  let perIpUsed: number;
  let globalUsed: number;
  try {
    perIpUsed = await store.increment(`${PREFIX}:ipday:${dateKey}:${clientKey}`);
    globalUsed = await store.increment(`${PREFIX}:global:${dateKey}`);
  } catch (error) {
    // Fail closed: without a shared counter we cannot know today's spend, and
    // serving anyway is exactly how a quota gets spent invisibly.
    console.error("[notesnap] shared quota store unavailable — demo is closed", error);
    return { ok: false, reason: "store_unavailable" };
  }

  const ttl = Math.max(60, Math.ceil((resetsAt - now.getTime()) / 1000));
  await Promise.all([
    expireAtReset(store, `${PREFIX}:ipday:${dateKey}:${clientKey}`, ttl),
    expireAtReset(store, `${PREFIX}:global:${dateKey}`, ttl),
  ]).catch((error) => {
    // A missing TTL would let counters outlive the Pacific day; log loudly
    // rather than throw, since the request is already accounted for.
    console.error("[notesnap] could not set quota counter expiry", error);
  });

  if (globalUsed > globalLimit) {
    return { ok: false, reason: "global_daily", resetsAt, remaining: 0 };
  }

  if (perIpUsed > perIpLimit) {
    return { ok: false, reason: "per_ip_daily", resetsAt, remaining: 0 };
  }

  return { ok: true, remaining: Math.max(0, globalLimit - globalUsed), resetsAt };
}

/**
 * Binds a counter's life to the rest of the Pacific day.
 *
 * `INCR` creates keys without a TTL, so this has to run on every request rather
 * than only the first. It stays correct because the TTL passed in is the time
 * left until the reset, which only shrinks — re-applying it can never let a
 * counter outlive the day it belongs to.
 */
async function expireAtReset(
  store: SharedStore,
  key: string,
  ttlSeconds: number,
): Promise<void> {
  await store.expire(key, ttlSeconds);
}

/** Reads today's demo spend for `/api/status`. Never throws. */
export async function readDemoBudgetStatus(
  store: SharedStore | null,
  now: Date = new Date(),
): Promise<DemoBudgetStatus> {
  const limit = getGlobalDailyMax();
  const resetsAt = nextPacificMidnight(now);

  if (!store) {
    // Without the shared store we genuinely do not know today's spend, so
    // report null rather than a fabricated zero.
    return { available: false, used: null, limit, resetsAt };
  }

  try {
    const used = Number.parseInt(
      (await store.get(`${PREFIX}:global:${pacificDateKey(now)}`)) ?? "0",
      10,
    );
    const count = Number.isFinite(used) ? used : 0;
    return { available: true, used: count, limit, resetsAt };
  } catch (error) {
    console.error("[notesnap] could not read demo budget status", error);
    return { available: false, used: null, limit, resetsAt };
  }
}

function breakerKey(provider: string, model: string, now: Date): string {
  return `${PREFIX}:breaker:${provider}:${model}:${pacificDateKey(now)}`;
}

export { secondsUntil };