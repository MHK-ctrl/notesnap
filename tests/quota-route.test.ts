import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route imports the OCR wrapper and the shared quota store; swap in fakes but
// keep the real error classes so the route's error mapping is exercised for real.
vi.mock("@/lib/vision", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/vision")>();
  return { ...actual, transcribeImage: vi.fn() };
});

vi.mock("@/lib/demo-quota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/demo-quota")>();
  return {
    ...actual,
    getSharedStore: vi.fn(() => null),
    consumeDemoBudget: vi.fn(),
    isQuotaBreakerSet: vi.fn(async () => false),
    setQuotaBreaker: vi.fn(async () => undefined),
    readDemoBudgetStatus: vi.fn(),
  };
});

import { GET as STATUS_GET } from "@/app/api/status/route";
import { POST } from "@/app/api/transcribe/route";
import {
  consumeDemoBudget,
  getSharedStore,
  isQuotaBreakerSet,
  readDemoBudgetStatus,
  setQuotaBreaker,
  type BudgetDecision,
} from "@/lib/demo-quota";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { USER_KEY_HEADER } from "@/lib/user-key";
import { ProviderQuotaExceededError, transcribeImage } from "@/lib/vision";

const mockedTranscribe = vi.mocked(transcribeImage);
const mockedStore = vi.mocked(getSharedStore);
const mockedConsume = vi.mocked(consumeDemoBudget);
const mockedBreaker = vi.mocked(isQuotaBreakerSet);
const mockedSetBreaker = vi.mocked(setQuotaBreaker);
const mockedStatus = vi.mocked(readDemoBudgetStatus);

const URL_UNDER_TEST = "http://localhost/api/transcribe";
const VALID_USER_KEY = `AIza${"c".repeat(35)}`;

let ipCounter = 0;
let ip: string;

beforeEach(() => {
  resetRateLimitStore();
  mockedTranscribe.mockReset();
  mockedTranscribe.mockResolvedValue({ text: "hello" });
  mockedStore.mockReturnValue(null);
  mockedConsume.mockReset();
  mockedBreaker.mockReset();
  mockedBreaker.mockResolvedValue(false);
  mockedSetBreaker.mockReset();
  mockedStatus.mockReset();
  ip = `198.51.100.${(ipCounter += 1) % 250}`;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function imageFile(name = "notes.jpg", type = "image/jpeg") {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

function makeRequest(
  options: { file?: File; clientIp?: string; userKey?: string | null; withField?: boolean } = {},
) {
  const { file = imageFile(), clientIp = ip, userKey = null, withField = true } = options;
  const form = new FormData();
  if (withField) form.append("image", file, file.name);

  const headers: Record<string, string> = { "x-forwarded-for": clientIp };
  if (userKey) headers[USER_KEY_HEADER] = userKey;

  return new Request(URL_UNDER_TEST, { method: "POST", body: form, headers });
}

function allowBudget(remaining = 10): void {
  mockedConsume.mockResolvedValue({
    ok: true,
    remaining,
    resetsAt: Date.parse("2026-10-05T07:00:00Z"),
  } as BudgetDecision);
}

function blockBudget(reason: "per_ip_daily" | "global_daily" | "store_unavailable"): void {
  mockedConsume.mockResolvedValue({
    ok: false,
    reason,
    resetsAt: reason === "store_unavailable" ? undefined : Date.parse("2026-10-05T07:00:00Z"),
  } as BudgetDecision);
}

/** A store object is only used for its identity in the route, so a stub suffices. */
function stubStore() {
  return {
    increment: async () => 0,
    decrementFloorZero: async () => 0,
    setExpiring: async () => undefined,
    get: async () => null,
    expire: async () => undefined,
    del: async () => undefined,
  };
}

async function body(response: Response) {
  return (await response.json()) as {
    text?: string;
    error?: { code?: string; message?: string };
    demo?: { available?: boolean; used?: number | null; limit?: number };
    quota?: { exhausted?: boolean };
  };
}

describe("POST /api/transcribe — demo budget", () => {
  it("transcribes normally when no shared store is configured", async () => {
    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect((await body(response)).text).toBe("hello");
  });

  it("charges the demo budget when a shared store exists", async () => {
    mockedStore.mockReturnValue(stubStore());
    allowBudget(7);

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockedConsume).toHaveBeenCalledTimes(1);
    expect(response.headers.get("X-Demo-Remaining")).toBe("7");
  });

  it("returns 429 demo_budget_exhausted when the per-IP daily cap is spent", async () => {
    mockedStore.mockReturnValue(stubStore());
    blockBudget("per_ip_daily");

    const response = await POST(makeRequest());
    const payload = await body(response);

    expect(response.status).toBe(429);
    expect(payload.error?.code).toBe("demo_budget_exhausted");
    expect(response.headers.get("Retry-After")).toBeTruthy();
    expect(payload.error?.message).toContain("midnight Pacific");
  });

  it("returns 429 demo_budget_exhausted when the whole demo budget is spent", async () => {
    mockedStore.mockReturnValue(stubStore());
    blockBudget("global_daily");

    const response = await POST(makeRequest());
    const payload = await body(response);

    expect(response.status).toBe(429);
    expect(payload.error?.code).toBe("demo_budget_exhausted");
  });

  it("returns 503 demo_unavailable and fails closed when the store is down", async () => {
    mockedStore.mockReturnValue(stubStore());
    blockBudget("store_unavailable");

    const response = await POST(makeRequest());
    const payload = await body(response);

    // The important part: it must NOT fall through to an unmetered transcribe.
    expect(response.status).toBe(503);
    expect(payload.error?.code).toBe("demo_unavailable");
    expect(mockedTranscribe).not.toHaveBeenCalled();
  });

  it("points people at their own key when the demo budget is gone", async () => {
    mockedStore.mockReturnValue(stubStore());
    blockBudget("global_daily");

    const payload = await body(await POST(makeRequest()));
    expect(payload.error?.message).toContain("aistudio.google.com");
  });
});

describe("POST /api/transcribe — quota circuit breaker", () => {
  it("skips the upstream call while the breaker is set", async () => {
    mockedStore.mockReturnValue(stubStore());
    mockedBreaker.mockResolvedValue(true);

    const response = await POST(makeRequest());
    const payload = await body(response);

    expect(response.status).toBe(429);
    expect(payload.error?.code).toBe("provider_quota_exhausted");
    // The whole point: don't spend a provider request rediscovering the wall.
    expect(mockedTranscribe).not.toHaveBeenCalled();
  });

  it("records the breaker the first time the provider confirms quota exhaustion", async () => {
    mockedStore.mockReturnValue(stubStore());
    allowBudget();
    mockedTranscribe.mockRejectedValue(new ProviderQuotaExceededError("quota exceeded", "gemini"));

    const response = await POST(makeRequest());

    expect(response.status).toBe(429);
    expect(mockedSetBreaker).toHaveBeenCalledTimes(1);
  });

  it("does not record the breaker for a visitor's own key", async () => {
    mockedStore.mockReturnValue(stubStore());
    allowBudget();
    mockedTranscribe.mockRejectedValue(new ProviderQuotaExceededError("quota exceeded", "gemini"));

    await POST(makeRequest({ userKey: VALID_USER_KEY }));

    expect(mockedSetBreaker).not.toHaveBeenCalled();
  });
});

describe("POST /api/transcribe — bring your own key", () => {
  it("bypasses the demo budget and breaker", async () => {
    mockedStore.mockReturnValue(stubStore());
    mockedBreaker.mockResolvedValue(true);

    const response = await POST(makeRequest({ userKey: VALID_USER_KEY }));

    expect(response.status).toBe(200);
    expect(mockedConsume).not.toHaveBeenCalled();
    expect(mockedTranscribe).toHaveBeenCalledTimes(1);
  });

  it("passes the visitor's key to the provider for that one request", async () => {
    await POST(makeRequest({ userKey: VALID_USER_KEY }));

    expect(mockedTranscribe).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ apiKey: VALID_USER_KEY }),
    );
  });

  it("falls back to the server key when no key is supplied", async () => {
    await POST(makeRequest());

    const options = mockedTranscribe.mock.calls[0]?.[1];
    expect(options?.apiKey).toBeUndefined();
  });

  it("ignores a malformed key header and uses the demo budget", async () => {
    mockedStore.mockReturnValue(stubStore());
    allowBudget();

    await POST(makeRequest({ userKey: "garbage-not-a-key" }));

    expect(mockedConsume).toHaveBeenCalledTimes(1);
  });

  it("never returns the key in an error response", async () => {
    mockedStore.mockReturnValue(stubStore());
    allowBudget();
    mockedTranscribe.mockRejectedValue(
      new ProviderQuotaExceededError(`key ${VALID_USER_KEY} out of quota`, "gemini"),
    );

    const response = await POST(makeRequest({ userKey: VALID_USER_KEY }));
    const text = JSON.stringify(await body(response));

    expect(text).not.toContain(VALID_USER_KEY);
  });

  it("redacts the key from upstream error text before logging", async () => {
    mockedStore.mockReturnValue(stubStore());
    allowBudget();
    const logged: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });

    // A generic provider error whose message quotes the request.
    const { VisionRequestError } = await import("@/lib/vision");
    mockedTranscribe.mockRejectedValue(
      new VisionRequestError(`upstream rejected ${VALID_USER_KEY}`, 502),
    );

    await POST(makeRequest({ userKey: VALID_USER_KEY }));

    expect(JSON.stringify(logged)).not.toContain(VALID_USER_KEY);
  });
});

describe("GET /api/status", () => {
  it("reports budget state without any secrets", async () => {
    mockedStatus.mockResolvedValue({
      available: true,
      used: 4,
      limit: 100,
      resetsAt: Date.parse("2026-10-05T07:00:00Z"),
    });
    mockedStore.mockReturnValue(stubStore());

    const response = await STATUS_GET();
    const payload = await body(response);
    const serialized = JSON.stringify(payload);

    expect(response.status).toBe(200);
    expect(payload.demo?.available).toBe(true);
    expect(payload.demo?.used).toBe(4);
    expect(serialized).not.toMatch(/AIza/);
    expect(serialized).not.toContain("UPSTASH_REDIS_REST_TOKEN");
  });

  it("reports the demo as unavailable when the store is unreachable", async () => {
    mockedStatus.mockResolvedValue({
      available: false,
      used: null,
      limit: 100,
      resetsAt: Date.parse("2026-10-05T07:00:00Z"),
    });

    const payload = await body(await STATUS_GET());

    expect(payload.demo?.available).toBe(false);
    expect(payload.demo?.used).toBeNull();
  });

  it("marks quota exhausted when the breaker is set", async () => {
    mockedStatus.mockResolvedValue({
      available: true,
      used: 10,
      limit: 100,
      resetsAt: Date.parse("2026-10-05T07:00:00Z"),
    });
    mockedStore.mockReturnValue(stubStore());
    mockedBreaker.mockResolvedValue(true);

    const payload = await body(await STATUS_GET());

    expect(payload.quota?.exhausted).toBe(true);
    expect(payload.demo?.available).toBe(false);
  });
});