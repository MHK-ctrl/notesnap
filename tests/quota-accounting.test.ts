import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The status route builds its store from env, so the provider-state tests swap
 * `getSharedStore` for the in-memory fake. The pure accounting tests below use
 * the real functions untouched.
 */
const sharedStoreRef: { current: SharedStore | null } = { current: null };

vi.mock("@/lib/demo-quota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/demo-quota")>();
  return {
    ...actual,
    getSharedStore: () => sharedStoreRef.current,
  };
});

import { GET as STATUS_GET } from "@/app/api/status/route";
import {
  clearThrottle,
  consumeDemoBudget,
  DEFAULT_THROTTLE_COOLDOWN_SECONDS,
  isQuotaBreakerSet,
  MAX_THROTTLE_COOLDOWN_SECONDS,
  readThrottle,
  refundDemoBudget,
  setThrottle,
  type SharedStore,
} from "@/lib/demo-quota";
import {
  clearQuotaBreaker,
  readDemoBudgetStatus,
  setQuotaBreaker,
} from "@/lib/demo-quota";

/**
 * In-memory Redis stand-in. Counters and strings share one keyspace, and the
 * decrement floors at zero exactly like the Lua script in production.
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
    decrementFloorZero: async (key) => {
      const current = Number.parseInt(values.get(key) ?? "0", 10);
      const next = Math.max(0, current - 1);
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

const MIDDAY = new Date("2026-10-04T19:00:00Z");
const NEXT_MIDNIGHT = Date.parse("2026-10-05T07:00:00Z");

let restoreEnv = () => {};

function withEnv(vars: Record<string, string | undefined>): () => void {
  const snapshot = { ...process.env };
  const merged = { ...snapshot, ...vars } as Record<string, string>;
  for (const key of Object.keys(snapshot)) if (!(key in vars)) delete merged[key];
  Object.assign(process.env, merged);
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
  }
  return () => {
    process.env = snapshot;
  };
}

beforeEach(() => {
  restoreEnv = withEnv({ DEMO_DAILY_MAX: undefined, PER_IP_DAILY_MAX: undefined });
  sharedStoreRef.current = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  restoreEnv();
  sharedStoreRef.current = null;
  vi.restoreAllMocks();
});

describe("reserve on attempt, refund on confirmed failure", () => {
  it("returns the reservation keys it charged", async () => {
    restoreEnv();
    restoreEnv = withEnv({ DEMO_DAILY_MAX: "100", PER_IP_DAILY_MAX: "50" });
    const store = fakeStore();

    const decision = await consumeDemoBudget(store, "ip-1", MIDDAY);

    expect(decision.reservation).toBeDefined();
    expect(decision.reservation?.globalKey).toContain("global");
    expect(decision.reservation?.perIpKey).toContain("ipday");
  });

  it("refunds both counters when the provider clearly refused", async () => {
    restoreEnv();
    restoreEnv = withEnv({ DEMO_DAILY_MAX: "100", PER_IP_DAILY_MAX: "50" });
    const store = fakeStore();

    await consumeDemoBudget(store, "ip-1", MIDDAY);
    await consumeDemoBudget(store, "ip-1", MIDDAY);
    expect((await readDemoBudgetStatus(store, MIDDAY)).used).toBe(2);

    const reservation = (await consumeDemoBudget(store, "ip-1", MIDDAY)).reservation;
    await refundDemoBudget(store, reservation!);

    // Back to 2, not 3: a refused request never consumed provider quota.
    expect((await readDemoBudgetStatus(store, MIDDAY)).used).toBe(2);
  });

  it("never lets a refund drive a counter below zero", async () => {
    const store = fakeStore();
    const reservation = {
      globalKey: "notesnap:quota:global:2026-10-04",
      perIpKey: "notesnap:quota:ipday:2026-10-04:ghost",
    };

    await refundDemoBudget(store, reservation);

    expect(Number.parseInt(store.values.get(reservation.globalKey) ?? "0", 10)).toBe(0);
    expect(Number.parseInt(store.values.get(reservation.perIpKey) ?? "0", 10)).toBe(0);
  });

  it("keeps concurrent refunds from losing updates", async () => {
    restoreEnv();
    restoreEnv = withEnv({ DEMO_DAILY_MAX: "100", PER_IP_DAILY_MAX: "50" });
    const base = fakeStore();

    // Charge 10, then refund 10 concurrently. A read-then-write implementation
    // would lose some refunds and leave the counter above zero.
    const reservations = [];
    for (let i = 0; i < 10; i += 1) {
      reservations.push((await consumeDemoBudget(base, "ip-1", MIDDAY)).reservation);
    }
    expect((await readDemoBudgetStatus(base, MIDDAY)).used).toBe(10);

    const slowStore: SharedStore = {
      ...base,
      decrementFloorZero: async (key) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return base.decrementFloorZero(key);
      },
    };
    await Promise.all(reservations.map((r) => refundDemoBudget(slowStore, r!)));

    expect((await readDemoBudgetStatus(base, MIDDAY)).used).toBe(0);
  });

  it("reports a failed refund without throwing", async () => {
    const broken: SharedStore = {
      increment: async () => 1,
      decrementFloorZero: async () => {
        throw new Error("ECONNRESET");
      },
      setExpiring: async () => undefined,
      get: async () => null,
      expire: async () => undefined,
      del: async () => undefined,
    };

    const ok = await refundDemoBudget(broken, { globalKey: "g", perIpKey: "p" });

    // Losing a refund under-counts usage, which is the safe direction.
    expect(ok).toBe(false);
  });
});

describe("shared throttle (short cooldown, not a day lock)", () => {
  it("is inactive until set", async () => {
    const store = fakeStore();
    expect((await readThrottle(store, "gemini", "model", MIDDAY)).active).toBe(false);
  });

  it("reports the remaining wait after being set", async () => {
    const store = fakeStore();
    await setThrottle(store, "gemini", "model", 30);

    const state = await readThrottle(store, "gemini", "model", MIDDAY);
    expect(state.active).toBe(true);
    expect(state.retryAfterSeconds).toBe(30);
    expect(state.resetsAt).toBe(MIDDAY.getTime() + 30_000);
  });

  it("defaults to a short cooldown when given nonsense", async () => {
    const store = fakeStore();
    await setThrottle(store, "gemini", "model", Number.NaN);

    const state = await readThrottle(store, "gemini", "model", MIDDAY);
    expect(state.retryAfterSeconds).toBe(DEFAULT_THROTTLE_COOLDOWN_SECONDS);
  });

  it("clamps an absurd provider hint to the hard ceiling", async () => {
    const store = fakeStore();
    await setThrottle(store, "gemini", "model", 86_400);

    expect((await readThrottle(store, "gemini", "model", MIDDAY)).retryAfterSeconds).toBe(
      MAX_THROTTLE_COOLDOWN_SECONDS,
    );
  });

  it("is scoped per model, so one throttled model does not block another", async () => {
    const store = fakeStore();
    await setThrottle(store, "gemini", "model-a", 30);

    expect((await readThrottle(store, "gemini", "model-b", MIDDAY)).active).toBe(false);
  });

  it("can be cleared", async () => {
    const store = fakeStore();
    await setThrottle(store, "gemini", "model", 30);
    await clearThrottle(store, "gemini", "model");

    expect((await readThrottle(store, "gemini", "model", MIDDAY)).active).toBe(false);
  });

  it("reports no throttle when the store is unreachable", async () => {
    const broken = {
      increment: async () => 0,
      decrementFloorZero: async () => 0,
      setExpiring: async () => undefined,
      get: async () => {
        throw new Error("ECONNREFUSED");
      },
      expire: async () => undefined,
      del: async () => undefined,
    } satisfies SharedStore;

    const state = await readThrottle(broken, "gemini", "model", MIDDAY);

    // Must NOT present a Redis blip as a provider outage.
    expect(state.active).toBe(false);
  });
});

describe("provider state mapping in /api/status", () => {
  const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";

  it("reports ready when a store is present and nothing is set", async () => {
    sharedStoreRef.current = fakeStore();

    const payload = (await (await STATUS_GET()).json()) as {
      provider: { state: string; retryAfterSeconds: number };
      sharedStoreConfigured: boolean;
    };

    expect(payload.sharedStoreConfigured).toBe(true);
    expect(payload.provider.state).toBe("ready");
    expect(payload.provider.retryAfterSeconds).toBe(0);
  });

  it("reports unknown — not ready — when there is no shared store", async () => {
    sharedStoreRef.current = null;

    const payload = (await (await STATUS_GET()).json()) as {
      provider: { state: string };
      sharedStoreConfigured: boolean;
    };

    expect(payload.sharedStoreConfigured).toBe(false);
    expect(payload.provider.state).toBe("unknown");
  });

  it("distinguishes a temporary throttle from daily exhaustion", async () => {
    sharedStoreRef.current = fakeStore();
    await setThrottle(sharedStoreRef.current, "gemini", MODEL, 30);

    const payload = (await (await STATUS_GET()).json()) as {
      provider: { state: string; retryAfterSeconds: number; resetsAt: string | null };
      demo: { available: boolean };
    };

    expect(payload.provider.state).toBe("temporarily_throttled");
    expect(payload.provider.retryAfterSeconds).toBe(30);
    expect(payload.provider.resetsAt).toBeNull();
    // A throttle is a pause, not a closure.
    expect(payload.demo.available).toBe(true);
  });

  it("reports day-long state with a Pacific reset when the breaker is set", async () => {
    sharedStoreRef.current = fakeStore();
    await setQuotaBreaker(sharedStoreRef.current, "gemini", MODEL, new Date());

    const payload = (await (await STATUS_GET()).json()) as {
      provider: { state: string; resetsAt: string | null };
      quota: { exhausted: boolean };
      demo: { available: boolean };
    };

    expect(payload.provider.state).toBe("daily_quota_exhausted");
    expect(payload.provider.resetsAt).toBe(new Date(NEXT_MIDNIGHT).toISOString());
    expect(payload.quota.exhausted).toBe(true);
    // Must never report available=true while the day-long breaker is active.
    expect(payload.demo.available).toBe(false);
  });

  it("prefers the day-long state over a throttle when both are recorded", async () => {
    sharedStoreRef.current = fakeStore();
    await setQuotaBreaker(sharedStoreRef.current, "gemini", MODEL, new Date());
    await setThrottle(sharedStoreRef.current, "gemini", MODEL, 30);

    const payload = (await (await STATUS_GET()).json()) as { provider: { state: string } };

    expect(payload.provider.state).toBe("daily_quota_exhausted");
  });
});

describe("breaker and throttle are independent", () => {
  it("setting a throttle does not set the day-long breaker", async () => {
    const store = fakeStore();
    await setThrottle(store, "gemini", "model", 30);

    expect(await isQuotaBreakerSet(store, "gemini", "model", MIDDAY)).toBe(false);
  });

  it("clearing the breaker leaves no throttle behind", async () => {
    const store = fakeStore();
    await setQuotaBreaker(store, "gemini", "model", MIDDAY);
    await clearQuotaBreaker(store, "gemini", "model", MIDDAY);

    expect(await isQuotaBreakerSet(store, "gemini", "model", MIDDAY)).toBe(false);
    expect((await readThrottle(store, "gemini", "model", MIDDAY)).active).toBe(false);
  });
});