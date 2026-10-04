import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wiring tests for the real Upstash integration.
 *
 * `@upstash/ratelimit` and `@upstash/redis` are mocked so no network or
 * credentials are needed; what's verified is that this app configures them
 * correctly and that the route reports which limiter answered.
 */

const upstashMocks: {
  limit: ReturnType<typeof vi.fn>;
  slidingWindow: ReturnType<typeof vi.fn>;
  fromEnv: ReturnType<typeof vi.fn>;
  constructorOptions: unknown;
} = {
  limit: vi.fn(),
  slidingWindow: vi.fn(),
  fromEnv: vi.fn(),
  constructorOptions: null,
};

vi.mock("@upstash/ratelimit", () => ({
  Ratelimit: class {
    static slidingWindow(limit: number, window: string) {
      upstashMocks.slidingWindow(limit, window);
      return { kind: "sliding-window", limit, window };
    }
    constructor(options: unknown) {
      upstashMocks.constructorOptions = options;
    }
    limit(key: string) {
      return upstashMocks.limit(key);
    }
  },
}));

vi.mock("@upstash/redis", () => ({
  Redis: {
    fromEnv: () => {
      upstashMocks.fromEnv();
      return { kind: "redis-client" };
    },
  },
}));

vi.mock("@/lib/vision", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/vision")>();
  return { ...actual, transcribeImage: vi.fn(async () => ({ text: "text" })) };
});

const { POST } = await import("@/app/api/transcribe/route");
const { checkRateLimit, resetRateLimitStore } = await import("@/lib/rate-limit");
const { transcribeImage } = await import("@/lib/vision");

const mockedTranscribe = vi.mocked(transcribeImage);

beforeEach(() => {
  resetRateLimitStore();
  upstashMocks.limit.mockReset();
  upstashMocks.slidingWindow.mockReset();
  upstashMocks.fromEnv.mockReset();
  upstashMocks.limit.mockResolvedValue({ success: true, limit: 7, remaining: 6, reset: Date.now() + 60_000 });
  process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.RATE_LIMIT_MAX;
  delete process.env.RATE_LIMIT_WINDOW_MS;
});

describe("Upstash wiring", () => {
  it("builds the limiter from env with a sliding window in milliseconds", async () => {
    await checkRateLimit("1.2.3.4", { config: { limit: 12, windowMs: 45_000 } });

    expect(upstashMocks.fromEnv).toHaveBeenCalledTimes(1);
    expect(upstashMocks.slidingWindow).toHaveBeenCalledWith(12, "45000 ms");
    expect(upstashMocks.limit).toHaveBeenCalledWith("1.2.3.4");
  });

  it("reuses the limiter across calls instead of rebuilding it", async () => {
    await checkRateLimit("a", { config: { limit: 5, windowMs: 1_000 } });
    await checkRateLimit("b", { config: { limit: 5, windowMs: 1_000 } });

    expect(upstashMocks.fromEnv).toHaveBeenCalledTimes(1);
  });

  it("returns shared-mode results from the Upstash limiter", async () => {
    upstashMocks.limit.mockResolvedValue({
      success: false,
      limit: 7,
      remaining: 0,
      reset: Date.now() + 30_000,
    });

    const result = await checkRateLimit("1.2.3.4", { config: { limit: 7, windowMs: 60_000 } });

    expect(result.ok).toBe(false);
    expect(result.mode).toBe("shared");
    if (result.ok) return;
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe("POST /api/transcribe with a shared limiter", () => {
  it("reports shared mode on success", async () => {
    mockedTranscribe.mockResolvedValue({ text: "hello" });

    const form = new FormData();
    form.append("image", new File([new Uint8Array([1, 2, 3])], "note.jpg", { type: "image/jpeg" }));
    const response = await POST(
      new Request("http://localhost/api/transcribe", {
        method: "POST",
        body: form,
        headers: { "x-forwarded-for": "203.0.113.50" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratelimit-mode")).toBe("shared");
    expect(response.headers.get("x-ratelimit-limit")).toBe("7");
    expect(response.headers.get("x-ratelimit-remaining")).toBe("6");
  });

  it("returns 429 and never calls Vision when the shared limiter says no", async () => {
    process.env.RATE_LIMIT_MAX = "1";
    upstashMocks.limit.mockResolvedValue({
      success: false,
      limit: 1,
      remaining: 0,
      reset: Date.now() + 45_000,
    });
    mockedTranscribe.mockClear();

    const form = new FormData();
    form.append("image", new File([new Uint8Array([1, 2, 3])], "note.jpg", { type: "image/jpeg" }));
    const response = await POST(
      new Request("http://localhost/api/transcribe", {
        method: "POST",
        body: form,
        headers: { "x-forwarded-for": "203.0.113.51" },
      }),
    );

    expect(response.status).toBe(429);
    const payload = (await response.json()) as { error?: { code?: string } };
    expect(payload.error?.code).toBe("rate_limited");
    expect(response.headers.get("x-ratelimit-mode")).toBe("shared");
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(mockedTranscribe).not.toHaveBeenCalled();
  });

  it("degrades to instance mode (and still serves) when Redis fails", async () => {
    upstashMocks.limit.mockRejectedValue(new Error("redis down"));
    mockedTranscribe.mockResolvedValue({ text: "still here" });

    const form = new FormData();
    form.append("image", new File([new Uint8Array([1, 2, 3])], "note.jpg", { type: "image/jpeg" }));
    const response = await POST(
      new Request("http://localhost/api/transcribe", {
        method: "POST",
        body: form,
        headers: { "x-forwarded-for": "203.0.113.52" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratelimit-mode")).toBe("instance");
    expect(console.error).toHaveBeenCalled();
  });
});
