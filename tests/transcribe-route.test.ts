import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route imports the OCR wrapper; swap in a mock and keep the real error
// classes so the route's error mapping is exercised for real.
vi.mock("@/lib/vision", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/vision")>();
  return { ...actual, transcribeImage: vi.fn() };
});

import { POST } from "@/app/api/transcribe/route";
import { DEFAULT_RATE_LIMIT, resetRateLimitStore } from "@/lib/rate-limit";
import { MAX_FILE_BYTES } from "@/lib/validation";
import {
  ApiNotEnabledError,
  BillingNotEnabledError,
  InvalidCredentialsError,
  MissingCredentialsError,
  NoTextDetectedError,
  RetryableProviderError,
  VisionRequestError,
  transcribeImage,
} from "@/lib/vision";

const mockedTranscribe = vi.mocked(transcribeImage);
const URL_UNDER_TEST = "http://localhost/api/transcribe";

/** Distinct IP per test so the shared rate-limit store never leaks between them. */
let ipCounter = 0;
let ip: string;

beforeEach(() => {
  resetRateLimitStore();
  mockedTranscribe.mockReset();
  ip = `203.0.113.${(ipCounter += 1) % 250}`;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.RATE_LIMIT_MAX;
  delete process.env.RATE_LIMIT_WINDOW_MS;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

function makeRequest(options: { file?: File; withField?: boolean; clientIp?: string } = {}) {
  const { file = imageFile(), withField = true, clientIp = ip } = options;
  const form = new FormData();
  if (withField) form.append("image", file, file.name);
  return new Request(URL_UNDER_TEST, {
    method: "POST",
    body: form,
    headers: { "x-forwarded-for": clientIp },
  });
}

function imageFile(name = "notes.jpg", type = "image/jpeg", bytes = new Uint8Array([1, 2, 3])) {
  return new File([bytes], name, { type });
}

async function readJson(response: Response): Promise<{
  text?: string;
  error?: { code?: string; message?: string };
}> {
  return (await response.json()) as {
    text?: string;
    error?: { code?: string; message?: string };
  };
}

describe("POST /api/transcribe", () => {
  it("transcribes an uploaded photo", async () => {
    mockedTranscribe.mockResolvedValue({ text: "Milk\nEggs\nBread" });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ text: "Milk\nEggs\nBread" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("reports which limiter answered", async () => {
    mockedTranscribe.mockResolvedValue({ text: "ok" });

    const response = await POST(makeRequest());

    // Without Upstash configured this build falls back to per-instance limiting;
    // the header makes that visible instead of implied.
    expect(response.headers.get("x-ratelimit-mode")).toBe("instance");
    expect(response.headers.get("x-ratelimit-limit")).toBe(String(DEFAULT_RATE_LIMIT.limit));
    expect(Number(response.headers.get("x-ratelimit-remaining"))).toBeGreaterThanOrEqual(0);
  });

  it("passes the raw image bytes and declared MIME type to the OCR wrapper", async () => {
    mockedTranscribe.mockResolvedValue({ text: "ok" });
    const bytes = new Uint8Array([9, 8, 7, 6]);

    await POST(makeRequest({ file: imageFile("page.png", "image/png", bytes) }));

    expect(mockedTranscribe).toHaveBeenCalledTimes(1);
    const [received, options] = mockedTranscribe.mock.calls[0] ?? [];
    expect(received).toBeInstanceOf(Uint8Array);
    expect(Array.from(received ?? [])).toEqual([9, 8, 7, 6]);
    expect(options?.mimeType).toBe("image/png");
  });

  it("returns literal text without rewriting it", async () => {
    const literal = "teh cat sat onn the mat\n\n  second line";
    mockedTranscribe.mockResolvedValue({ text: literal });

    const response = await POST(makeRequest());

    expect((await readJson(response)).text).toBe(literal);
  });

  it("rejects a request with no image field", async () => {
    const response = await POST(makeRequest({ withField: false }));

    expect(response.status).toBe(400);
    const payload = await readJson(response);
    expect(payload.error?.code).toBe("invalid_request");
    expect(mockedTranscribe).not.toHaveBeenCalled();
  });

  it("rejects a non-image upload on the server", async () => {
    const response = await POST(
      makeRequest({ file: new File(["not an image"], "notes.pdf", { type: "application/pdf" }) }),
    );

    expect(response.status).toBe(400);
    expect((await readJson(response)).error?.code).toBe("unsupported_type");
    expect(mockedTranscribe).not.toHaveBeenCalled();
  });

  it("rejects an oversized upload with 413", async () => {
    const oversized = imageFile("huge.jpg", "image/jpeg", new Uint8Array(MAX_FILE_BYTES + 1));

    const response = await POST(makeRequest({ file: oversized }));

    expect(response.status).toBe(413);
    expect((await readJson(response)).error?.code).toBe("too_large");
    expect(mockedTranscribe).not.toHaveBeenCalled();
  });

  it("rejects an oversized body before parsing it", async () => {
    // Node's Request does not compute content-length (the runtime adds it at the
    // wire level), so set it explicitly to simulate a real inbound request.
    const response = await POST(
      new Request(URL_UNDER_TEST, {
        method: "POST",
        body: new Uint8Array(1024),
        headers: {
          "content-type": "multipart/form-data; boundary=----x",
          "content-length": String(MAX_FILE_BYTES + 600 * 1024),
          "x-forwarded-for": ip,
        },
      }),
    );

    expect(response.status).toBe(413);
    expect((await readJson(response)).error?.code).toBe("too_large");
    expect(mockedTranscribe).not.toHaveBeenCalled();
  });

  it("rejects a body that is not multipart", async () => {
    const response = await POST(
      new Request(URL_UNDER_TEST, {
        method: "POST",
        body: "hello",
        headers: { "content-type": "text/plain", "x-forwarded-for": ip },
      }),
    );

    expect(response.status).toBe(400);
    expect((await readJson(response)).error?.code).toBe("invalid_request");
  });

  it("explains how to fix a deployment with no OCR key, naming both providers", async () => {
    mockedTranscribe.mockRejectedValue(new MissingCredentialsError());

    const response = await POST(makeRequest());

    expect(response.status).toBe(500);
    const payload = await readJson(response);
    expect(payload.error?.code).toBe("missing_credentials");
    expect(payload.error?.message).toContain("GEMINI_API_KEY");
    expect(payload.error?.message).toContain("GOOGLE_VISION_API_KEY");
    // Failures still report which limiter handled the request.
    expect(response.headers.get("x-ratelimit-mode")).toBe("instance");
  });

  it("reports an invalid API key distinctly", async () => {
    mockedTranscribe.mockRejectedValue(new InvalidCredentialsError());

    const response = await POST(makeRequest());

    expect(response.status).toBe(500);
    expect((await readJson(response)).error?.code).toBe("invalid_credentials");
  });

  it("tells the deployer when the OCR API isn't enabled on their project", async () => {
    mockedTranscribe.mockRejectedValue(new ApiNotEnabledError());

    const response = await POST(makeRequest());

    expect(response.status).toBe(500);
    const payload = await readJson(response);
    expect(payload.error?.code).toBe("api_not_enabled");
    expect(payload.error?.message).toContain("vision.googleapis.com");
    expect(payload.error?.message).toContain("Generative Language API");
  });

  it("tells the deployer when the project has no billing account", async () => {
    mockedTranscribe.mockRejectedValue(new BillingNotEnabledError());

    const response = await POST(makeRequest());

    expect(response.status).toBe(500);
    const payload = await readJson(response);
    expect(payload.error?.code).toBe("billing_not_enabled");
    expect(payload.error?.message).toContain("billing");
  });

  it("returns 422 when the photo has no handwriting", async () => {
    mockedTranscribe.mockRejectedValue(new NoTextDetectedError());

    const response = await POST(makeRequest());

    expect(response.status).toBe(422);
    const payload = await readJson(response);
    expect(payload.error?.code).toBe("no_text");
    expect(payload.error?.message).toContain("handwriting");
  });

  it("returns 502 when Vision fails", async () => {
    mockedTranscribe.mockRejectedValue(new VisionRequestError("boom", 502));

    const response = await POST(makeRequest());

    expect(response.status).toBe(502);
    expect((await readJson(response)).error?.code).toBe("ocr_failed");
  });

  it("returns 503 with Retry-After when the provider is only temporarily busy", async () => {
    mockedTranscribe.mockRejectedValue(new RetryableProviderError("high demand", 503));

    const response = await POST(makeRequest());
    const body = await readJson(response);

    expect(response.status).toBe(503);
    expect(body.error?.code).toBe("provider_busy");
    expect(response.headers.get("Retry-After")).toBe("5");
  });

  it("returns 429 with Retry-After when the provider's quota is spent", async () => {
    mockedTranscribe.mockRejectedValue(new RetryableProviderError("quota exceeded", 429));

    const response = await POST(makeRequest());
    const body = await readJson(response);

    expect(response.status).toBe(429);
    expect(body.error?.code).toBe("provider_busy");
    expect(response.headers.get("Retry-After")).toBe("5");
  });

  it("returns 500 for unexpected errors without leaking details", async () => {
    mockedTranscribe.mockRejectedValue(new Error("secret internal detail"));

    const response = await POST(makeRequest());

    expect(response.status).toBe(500);
    const payload = await readJson(response);
    expect(payload.error?.code).toBe("unexpected_error");
    expect(payload.error?.message).not.toContain("secret internal detail");
  });

  it("rate limits a client that keeps retrying", async () => {
    process.env.RATE_LIMIT_MAX = "2";
    process.env.RATE_LIMIT_WINDOW_MS = "60000";
    mockedTranscribe.mockResolvedValue({ text: "ok" });

    const first = await POST(makeRequest());
    const second = await POST(makeRequest());
    const third = await POST(makeRequest());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(third.headers.get("x-ratelimit-mode")).toBe("instance");
    expect(third.headers.get("x-ratelimit-remaining")).toBe("0");
    expect((await readJson(third)).error?.code).toBe("rate_limited");
    expect(mockedTranscribe).toHaveBeenCalledTimes(2);
  });

  it("rate limits per client, not globally", async () => {
    process.env.RATE_LIMIT_MAX = "1";
    mockedTranscribe.mockResolvedValue({ text: "ok" });

    expect((await POST(makeRequest({ clientIp: "198.51.100.1" }))).status).toBe(200);
    expect((await POST(makeRequest({ clientIp: "198.51.100.1" }))).status).toBe(429);
    expect((await POST(makeRequest({ clientIp: "198.51.100.2" }))).status).toBe(200);
  });
});
