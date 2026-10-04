import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearQuotaBreaker,
  consumeDemoBudget,
  DEFAULT_GLOBAL_DAILY_MAX,
  DEFAULT_PER_IP_DAILY_MAX,
  getGlobalDailyMax,
  getPerIpDailyMax,
  isQuotaBreakerSet,
  readDemoBudgetStatus,
  setQuotaBreaker,
  type SharedStore,
} from "@/lib/demo-quota";

/**
 * In-memory stand-in for Redis.
 *
 * Counters and strings share one keyspace, as they do in Redis, so a counter
 * written by `increment` is readable by `get` — which is exactly the property
 * `readDemoBudgetStatus` depends on.
 */
function fakeStore(): SharedStore & { values: Map<string, string> } {
  const values = new Map<string, string>();

  return {
    values,
    increment: async (key) => {
      const next = Number.parseInt(values.get(key) ?? "0", 10) + 1;
      values.set(key, String(next));
      return next;
    },
    setExpiring: async (key, value) => {
      values.set(key, value);
    },
    get: async (key) => values.get(key) ?? null,
    expire: async () => undefined,
    del: async (key) => {
      values.delete(key);
    },
  };
}

/**
 * Applies env overrides and returns a restore function.
 *
 * The snapshot is taken when this is called, and restore puts the *whole*
 * environment back — so a test may call this more than once and the last
 * restore still returns to the original process state.
 */
function withEnv(vars: Record<string, string | undefined>): () => void {
  const snapshot = { ...process.env };
  const merged = { ...snapshot, ...vars } as Record<string, string>;

  for (const key of Object.keys(snapshot)) {
    if (!(key in vars)) delete merged[key];
  }

  Object.assign(process.env, merged);
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
  }

  return () => {
    process.env = snapshot;
  };
}

let restoreEnv = withEnv({});

beforeEach(() => {
  restoreEnv = withEnv({ DEMO_DAILY_MAX: undefined, PER_IP_DAILY_MAX: undefined });
});

afterEach(() => {
  restoreEnv();
  vi.restoreAllMocks();
});

/** A fixed instant mid-morning Pacific, away from any day or DST boundary. */
const MIDDAY = new Date("2026-10-04T19:00:00Z");

describe("cap configuration", () => {
  it("falls back to safe defaults when unset", () => {
    expect(getGlobalDailyMax()).toBe(DEFAULT_GLOBAL_DAILY_MAX);
    expect(getPerIpDailyMax()).toBe(DEFAULT_PER_IP_DAILY_MAX);
  });

  it("reads operator overrides from env", () => {
    restoreEnv();
    restoreEnv = withEnv({ DEMO_DAILY_MAX: "250", PER_IP_DAILY_MAX: "3" });
    expect(getGlobalDailyMax()).toBe(250);
    expect(getPerIpDailyMax()).toBe(3);
  });

  it("ignores nonsense values rather than opening the floodgates", () => {
    restoreEnv();
    restoreEnv = withEnv({ DEMO_DAILY_MAX: "-5", PER_IP_DAILY_MAX: "not-a-number" });
    expect(getGlobalDailyMax()).toBe(DEFAULT_GLOBAL_DAILY_MAX);
    expect(getPerIpDailyMax()).toBe(DEFAULT_PER_IP_DAILY_MAX);
  });
});

describe("consumeDemoBudget", () => {
  it("allows requests up to the global cap, then blocks", async () => {
    restoreEnv();
    restoreEnv = withEnv({ DEMO_DAILY_MAX: "3", PER_IP_DAILY_MAX: "50" });
    const store = fakeStore();

    for (let i = 0; i < 3; i += 1) {
      const decision = await consumeDemoBudget(store, `ip-${i}`, MIDDAY);
      expect(decision.ok).toBe(true);
    }

    const blocked = await consumeDemoBudget(store, "ip-over", MIDDAY);
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe("global_daily");
  });

  it("enforces the per-IP daily cap independently of the global one", async () => {
    restoreEnv();
    restoreEnv = withEnv({ DEMO_DAILY_MAX: "100", PER_IP_DAILY_MAX: "2" });
    const store = fakeStore();

    expect((await consumeDemoBudget(store, "same-ip", MIDDAY)).ok).toBe(true);
    expect((await consumeDemoBudget(store, "same-ip", MIDDAY)).ok).toBe(true);

    const third = await consumeDemoBudget(store, "same-ip", MIDDAY);
    expect(third.ok).toBe(false);
    expect(third.reason).toBe("per_ip_daily");

    // A different visitor is unaffected by one IP's spending.
    expect((await consumeDemoBudget(store, "other-ip", MIDDAY)).ok).toBe(true);
  });

  it("reports remaining demo budget as the global cap is spent", async () => {
    restoreEnv();
    restoreEnv = withEnv({ DEMO_DAILY_MAX: "5", PER_IP_DAILY_MAX: "50" });
    const store = fakeStore();

    expect((await consumeDemoBudget(store, "a", MIDDAY)).remaining).toBe(4);
    expect((await consumeDemoBudget(store, "b", MIDDAY)).remaining).toBe(3);
  });

  it("keys counters by the Pacific day, so the budget renews at Pacific midnight", async () => {
    restoreEnv();
    restoreEnv = withEnv({ DEMO_DAILY_MAX: "1", PER_IP_DAILY_MAX: "50" });
    const store = fakeStore();

    const latePacific = new Date("2026-10-04T23:00:00Z"); // 16:00 Pacific Oct 4
    const afterPacificMidnight = new Date("2026-10-05T08:00:00Z"); // 01:00 Pacific Oct 5

    expect((await consumeDemoBudget(store, "ip", latePacific)).ok).toBe(true);
    expect((await consumeDemoBudget(store, "ip", latePacific)).ok).toBe(false);

    // Same visitor, minutes later in real time but a new Pacific day: allowed.
    const nextDay = await consumeDemoBudget(store, "ip", afterPacificMidnight);
    expect(nextDay.ok).toBe(true);
  });

  it("reports the Pacific reset time, not a UTC one", async () => {
    restoreEnv();
    restoreEnv = withEnv({ DEMO_DAILY_MAX: "1", PER_IP_DAILY_MAX: "1" });
    const store = fakeStore();

    const decision = await consumeDemoBudget(store, "ip", MIDDAY);
    expect(decision.resetsAt).toBe(Date.parse("2026-10-05T07:00:00Z"));
  });

  it("sets a TTL so counters cannot outlive the Pacific day", async () => {
    restoreEnv();
    restoreEnv = withEnv({ DEMO_DAILY_MAX: "100", PER_IP_DAILY_MAX: "100" });
    const ttls: number[] = [];
    const expire = vi.fn(async (_key: string, ttlSeconds: number) => {
      ttls.push(ttlSeconds);
    });
    const store: SharedStore = { ...fakeStore(), expire };

    await consumeDemoBudget(store, "ip", MIDDAY);

    expect(expire).toHaveBeenCalledTimes(2); // per-IP day + global day
    for (const ttl of ttls) {
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(24 * 60 * 60);
    }
  });

  it("counts concurrent requests atomically so the cap is never overshot", async () => {
    restoreEnv();
    restoreEnv = withEnv({ DEMO_DAILY_MAX: "5", PER_IP_DAILY_MAX: "100" });

    // A deliberately slow store, so an implementation that read-then-wrote would
    // interleave and let more than the cap through.
    const base = fakeStore();
    const store: SharedStore = {
      ...base,
      increment: async (key) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return base.increment(key);
      },
    };

    const decisions = await Promise.all(
      Array.from({ length: 20 }, (_, i) => consumeDemoBudget(store, `ip-${i}`, MIDDAY)),
    );

    expect(decisions.filter((d) => d.ok)).toHaveLength(5);
    expect(decisions.filter((d) => !d.ok && d.reason === "global_daily")).toHaveLength(15);
  });

  it("fails closed when the shared store is unreachable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store: SharedStore = {
      increment: async () => {
        throw new Error("ECONNREFUSED");
      },
      setExpiring: async () => undefined,
      get: async () => null,
      expire: async () => undefined,
      del: async () => undefined,
    };

    const decision = await consumeDemoBudget(store, "ip", MIDDAY);

    // Crucially NOT ok: an unmetered request here would let a Redis blip spend
    // the project's quota invisibly.
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("store_unavailable");
  });
});

describe("quota circuit breaker", () => {
  it("is unset until the provider confirms exhaustion", async () => {
    const store = fakeStore();
    expect(await isQuotaBreakerSet(store, "gemini", "gemini-3.8-flash", MIDDAY)).toBe(false);
  });

  it("trips once the daily quota is confirmed spent", async () => {
    const store = fakeStore();
    await setQuotaBreaker(store, "gemini", "gemini-3.8-flash", MIDDAY);

    expect(await isQuotaBreakerSet(store, "gemini", "gemini-3.8-flash", MIDDAY)).toBe(true);
  });

  it("is scoped per model, because Google's limits are per project per model", async () => {
    const store = fakeStore();
    await setQuotaBreaker(store, "gemini", "gemini-3.8-flash", MIDDAY);

    // A spent quota on one model says nothing about another.
    expect(await isQuotaBreakerSet(store, "gemini", "gemini-3.5-flash-lite", MIDDAY)).toBe(false);
  });

  it("does not carry across the Pacific day boundary", async () => {
    const store = fakeStore();
    await setQuotaBreaker(store, "gemini", "model", MIDDAY);

    const nextPacificDay = new Date("2026-10-05T09:00:00Z");
    expect(await isQuotaBreakerSet(store, "gemini", "model", nextPacificDay)).toBe(false);
  });

  it("can be cleared by an operator", async () => {
    const store = fakeStore();
    await setQuotaBreaker(store, "gemini", "model", MIDDAY);
    await clearQuotaBreaker(store, "gemini", "model", MIDDAY);

    expect(await isQuotaBreakerSet(store, "gemini", "model", MIDDAY)).toBe(false);
  });
});

describe("readDemoBudgetStatus", () => {
  it("reports used and remaining for the status endpoint", async () => {
    restoreEnv();
    restoreEnv = withEnv({ DEMO_DAILY_MAX: "10", PER_IP_DAILY_MAX: "50" });
    const store = fakeStore();

    await consumeDemoBudget(store, "a", MIDDAY);
    await consumeDemoBudget(store, "b", MIDDAY);

    const status = await readDemoBudgetStatus(store, MIDDAY);
    expect(status.available).toBe(true);
    expect(status.used).toBe(2);
    expect(status.limit).toBe(10);
    expect(status.resetsAt).toBe(Date.parse("2026-10-05T07:00:00Z"));
  });

  it("reports unknown usage rather than zero when no store is configured", async () => {
    const status = await readDemoBudgetStatus(null, MIDDAY);

    // A fabricated 0 would read as "plenty of budget left", which is the one
    // wrong answer this endpoint could give.
    expect(status.available).toBe(false);
    expect(status.used).toBeNull();
  });
});