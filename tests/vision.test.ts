import { describe, expect, it } from "vitest";

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

const IMAGE = new Uint8Array([1, 2, 3, 4, 5]);
// A PNG signature, enough for the adapter's magic-byte sniffing.
const PNG_IMAGE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** Minimal fetch stub that records calls. */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const requestInit = init ?? {};
    calls.push({ url, init: requestInit });
    return handler(url, requestInit);
  };
  return { fetchImpl: impl as unknown as typeof fetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Runs `fn` with the given env vars set (deleted when undefined), then restores them. */
async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<unknown>,
): Promise<void> {
  const saved = Object.keys(vars).map((key) => [key, process.env[key]] as const);
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** A Gemini Interactions reply whose final step carries `text`. */
function geminiReply(text: string) {
  return jsonResponse({
    steps: [{ type: "model_output", content: [{ type: "text", text }] }],
  });
}

describe("transcribeImage — provider selection", () => {
  it("throws MissingCredentialsError naming both providers when nothing is configured", async () => {
    await withEnv({ GEMINI_API_KEY: undefined, GOOGLE_VISION_API_KEY: undefined }, async () => {
      const error = await transcribeImage(IMAGE).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MissingCredentialsError);
      expect((error as Error).message).toContain("GEMINI_API_KEY");
      expect((error as Error).message).toContain("GOOGLE_VISION_API_KEY");
    });
  });

  it("uses Cloud Vision when only GOOGLE_VISION_API_KEY is set", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      jsonResponse({ responses: [{ fullTextAnnotation: { text: "hi" } }] }),
    );

    await withEnv({ GEMINI_API_KEY: undefined, GOOGLE_VISION_API_KEY: "vision-key" }, async () => {
      await transcribeImage(IMAGE, { fetchImpl });
    });

    expect(calls[0]?.url).toContain("vision.googleapis.com");
  });

  it("uses Gemini when only GEMINI_API_KEY is set", async () => {
    const { fetchImpl, calls } = stubFetch(() => geminiReply("hi"));

    await withEnv({ GEMINI_API_KEY: "gemini-key", GOOGLE_VISION_API_KEY: undefined }, async () => {
      await transcribeImage(IMAGE, { fetchImpl });
    });

    expect(calls[0]?.url).toContain("generativelanguage.googleapis.com");
  });

  it("keeps using Cloud Vision when both keys are set, so existing deployments don't switch engines", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      jsonResponse({ responses: [{ fullTextAnnotation: { text: "hi" } }] }),
    );

    await withEnv({ GEMINI_API_KEY: "gemini-key", GOOGLE_VISION_API_KEY: "vision-key" }, async () => {
      await transcribeImage(IMAGE, { fetchImpl });
    });

    expect(calls[0]?.url).toContain("vision.googleapis.com");
  });

  it("lets an explicit provider override the environment", async () => {
    const { fetchImpl, calls } = stubFetch(() => geminiReply("hi"));

    await withEnv({ GOOGLE_VISION_API_KEY: "vision-key", GEMINI_API_KEY: undefined }, async () => {
      await transcribeImage(IMAGE, { provider: "gemini", apiKey: "k", fetchImpl });
    });

    expect(calls[0]?.url).toContain("generativelanguage.googleapis.com");
  });

  it("treats the .env.example placeholder as unconfigured", async () => {
    const { fetchImpl, calls } = stubFetch(() => geminiReply("hi"));

    await withEnv(
      { GOOGLE_VISION_API_KEY: "your-google-cloud-vision-api-key-here", GEMINI_API_KEY: "real-key" },
      async () => {
        await transcribeImage(IMAGE, { fetchImpl });
      },
    );

    expect(calls[0]?.url).toContain("generativelanguage.googleapis.com");
  });
});

describe("transcribeImage — Cloud Vision provider", () => {
  it("throws MissingCredentialsError when GOOGLE_VISION_API_KEY is not available", async () => {
    await withEnv({ GOOGLE_VISION_API_KEY: undefined }, async () => {
      const error = await transcribeImage(IMAGE, { provider: "google-vision" }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(MissingCredentialsError);
      expect((error as Error).message).toContain("GOOGLE_VISION_API_KEY");
    });
  });

  it("treats the .env.example placeholder as missing credentials", async () => {
    await expect(
      transcribeImage(IMAGE, {
        provider: "google-vision",
        apiKey: "your-google-cloud-vision-api-key-here",
      }),
    ).rejects.toBeInstanceOf(MissingCredentialsError);
  });

  it("requests DOCUMENT_TEXT_DETECTION with base64 image content", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      jsonResponse({ responses: [{ fullTextAnnotation: { text: "hi" } }] }),
    );

    await transcribeImage(IMAGE, { provider: "google-vision", apiKey: "test-key", fetchImpl });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toContain("https://vision.googleapis.com/v1/images:annotate");
    expect(call?.url).toContain("key=test-key");
    expect(call?.init.method).toBe("POST");

    const body = JSON.parse(String(call?.init.body)) as {
      requests: Array<{
        image: { content: string };
        features: Array<{ type: string }>;
      }>;
    };
    expect(body.requests[0]?.features[0]?.type).toBe("DOCUMENT_TEXT_DETECTION");
    expect(Buffer.from(body.requests[0]?.image.content ?? "", "base64")).toEqual(
      Buffer.from(IMAGE),
    );
  });

  it("returns fullTextAnnotation text", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({ responses: [{ fullTextAnnotation: { text: "Grocery list\nmilk\neggs" } }] }),
    );

    await expect(
      transcribeImage(IMAGE, { provider: "google-vision", apiKey: "k", fetchImpl }),
    ).resolves.toEqual({
      text: "Grocery list\nmilk\neggs",
    });
  });

  it("falls back to textAnnotations when there is no full document annotation", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({ responses: [{ textAnnotations: [{ description: "sticky note" }] }] }),
    );

    await expect(
      transcribeImage(IMAGE, { provider: "google-vision", apiKey: "k", fetchImpl }),
    ).resolves.toEqual({
      text: "sticky note",
    });
  });

  it("hands back literal text, mistakes and all", async () => {
    const raw = "teh quikc brownn fox\n\njupmps";
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({ responses: [{ fullTextAnnotation: { text: raw } }] }),
    );

    const result = await transcribeImage(IMAGE, {
      provider: "google-vision",
      apiKey: "k",
      fetchImpl,
    });
    expect(result.text).toBe(raw);
  });

  it("only trims the padding Vision adds around the response", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({ responses: [{ fullTextAnnotation: { text: "  indented line\n\n" } }] }),
    );

    const result = await transcribeImage(IMAGE, {
      provider: "google-vision",
      apiKey: "k",
      fetchImpl,
    });
    expect(result.text).toBe("indented line");
  });

  it("throws NoTextDetectedError for an empty page", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ responses: [{}] }));

    await expect(
      transcribeImage(IMAGE, { provider: "google-vision", apiKey: "k", fetchImpl }),
    ).rejects.toBeInstanceOf(NoTextDetectedError);
  });

  it("maps an invalid API key to InvalidCredentialsError", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({ error: { message: "API key not valid. Please pass a valid API key." } }, 400),
    );

    await expect(
      transcribeImage(IMAGE, { provider: "google-vision", apiKey: "bad", fetchImpl }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it("maps a 403 permission error to InvalidCredentialsError", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({ error: { message: "Permission denied on resource project." } }, 403),
    );

    await expect(
      transcribeImage(IMAGE, { provider: "google-vision", apiKey: "k", fetchImpl }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it("maps a disabled API to ApiNotEnabledError", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse(
        {
          error: {
            code: 403,
            message:
              "Cloud Vision API has not been used in project 510607 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/vision.googleapis.com/overview?project=510607 then retry.",
            status: "PERMISSION_DENIED",
          },
        },
        403,
      ),
    );

    await expect(
      transcribeImage(IMAGE, { provider: "google-vision", apiKey: "k", fetchImpl }),
    ).rejects.toBeInstanceOf(ApiNotEnabledError);
  });

  it("maps a project without billing to BillingNotEnabledError", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse(
        {
          error: {
            code: 403,
            message:
              "This API method requires billing to be enabled. Please enable billing on project #510607 by visiting https://console.developers.google.com/billing/enable?project=510607 then retry.",
          },
        },
        403,
      ),
    );

    await expect(
      transcribeImage(IMAGE, { provider: "google-vision", apiKey: "k", fetchImpl }),
    ).rejects.toBeInstanceOf(BillingNotEnabledError);
  });

  it("maps upstream rate limiting to a VisionRequestError with status 429", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ error: { message: "Quota" } }, 429));

    const error = await transcribeImage(IMAGE, {
      provider: "google-vision",
      apiKey: "k",
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VisionRequestError);
    expect((error as VisionRequestError).status).toBe(429);
  });

  it("wraps network failures with status 0", async () => {
    const { fetchImpl } = stubFetch(() => {
      throw new Error("socket hang up");
    });

    const error = await transcribeImage(IMAGE, {
      provider: "google-vision",
      apiKey: "k",
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VisionRequestError);
    expect((error as VisionRequestError).status).toBe(0);
    expect((error as VisionRequestError).message).toContain("socket hang up");
  });

  it("surfaces a per-response Vision error", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({
        responses: [{ error: { code: 3, message: "Bad image data." } }],
      }),
    );

    await expect(
      transcribeImage(IMAGE, { provider: "google-vision", apiKey: "k", fetchImpl }),
    ).rejects.toThrow("Bad image data.");
  });

  it("handles a non-JSON error body without crashing", async () => {
    const { fetchImpl } = stubFetch(() => new Response("<html>gateway</html>", { status: 502 }));

    await expect(
      transcribeImage(IMAGE, { provider: "google-vision", apiKey: "k", fetchImpl }),
    ).rejects.toBeInstanceOf(VisionRequestError);
  });

  it("sends language hints only when provided", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      jsonResponse({ responses: [{ fullTextAnnotation: { text: "bonjour" } }] }),
    );

    await transcribeImage(IMAGE, {
      provider: "google-vision",
      apiKey: "k",
      fetchImpl,
      languageHints: ["fr"],
    });
    const withHints = JSON.parse(String(calls[0]?.init.body)) as {
      requests: Array<{ imageContext?: { languageHints?: string[] } }>;
    };
    expect(withHints.requests[0]?.imageContext?.languageHints).toEqual(["fr"]);

    calls.length = 0;
    await transcribeImage(IMAGE, { provider: "google-vision", apiKey: "k", fetchImpl });
    const withoutHints = JSON.parse(String(calls[0]?.init.body)) as {
      requests: Array<{ imageContext?: unknown }>;
    };
    expect(withoutHints.requests[0]?.imageContext).toBeUndefined();
  });
});

describe("transcribeImage — Gemini provider", () => {
  it("throws MissingCredentialsError when GEMINI_API_KEY is not available", async () => {
    await withEnv({ GEMINI_API_KEY: undefined }, async () => {
      const error = await transcribeImage(IMAGE, { provider: "gemini" }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MissingCredentialsError);
      expect((error as Error).message).toContain("GEMINI_API_KEY");
    });
  });

  it("treats the .env.example placeholder as missing credentials", async () => {
    await expect(
      transcribeImage(IMAGE, {
        provider: "gemini",
        apiKey: "your-gemini-api-key-here",
      }),
    ).rejects.toBeInstanceOf(MissingCredentialsError);
  });

  it("posts the prompt and inline image to the interactions endpoint", async () => {
    const { fetchImpl, calls } = stubFetch(() => geminiReply("hi"));

    await withEnv({ GEMINI_MODEL: undefined }, async () => {
      await transcribeImage(IMAGE, {
        provider: "gemini",
        apiKey: "test-gemini-key",
        fetchImpl,
      });
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(call?.init.method).toBe("POST");
    expect(new Headers(call?.init.headers).get("x-goog-api-key")).toBe("test-gemini-key");

    const body = JSON.parse(String(call?.init.body)) as {
      model: string;
      store: boolean;
      input: Array<Record<string, unknown>>;
    };
    expect(body.model).toBe("gemini-3.8-flash");
    expect(body.store).toBe(false);

    const textPart = body.input[0] as { type: string; text: string };
    expect(textPart.type).toBe("text");
    expect(textPart.text).toContain("exactly as written");
    expect(textPart.text).toContain("NO_TEXT_DETECTED");

    const imagePart = body.input[1] as { type: string; mime_type: string; data: string };
    expect(imagePart.type).toBe("image");
    expect(imagePart.mime_type).toBe("image/jpeg");
    expect(Buffer.from(imagePart.data, "base64")).toEqual(Buffer.from(IMAGE));
  });

  it("uses the caller's MIME type when given", async () => {
    const { fetchImpl, calls } = stubFetch(() => geminiReply("hi"));

    await transcribeImage(IMAGE, {
      provider: "gemini",
      apiKey: "k",
      mimeType: "image/png",
      fetchImpl,
    });

    const body = JSON.parse(String(calls[0]?.init.body)) as {
      input: Array<{ mime_type?: string }>;
    };
    expect(body.input[1]?.mime_type).toBe("image/png");
  });

  it("sniffs the MIME type from the bytes when none is given", async () => {
    const { fetchImpl, calls } = stubFetch(() => geminiReply("hi"));

    await transcribeImage(PNG_IMAGE, { provider: "gemini", apiKey: "k", fetchImpl });

    const body = JSON.parse(String(calls[0]?.init.body)) as {
      input: Array<{ mime_type?: string }>;
    };
    expect(body.input[1]?.mime_type).toBe("image/png");
  });

  it("allows the model to be overridden per call and via GEMINI_MODEL", async () => {
    const { fetchImpl, calls } = stubFetch(() => geminiReply("hi"));

    await transcribeImage(IMAGE, {
      provider: "gemini",
      apiKey: "k",
      model: "gemini-test-model",
      fetchImpl,
    });
    expect((JSON.parse(String(calls[0]?.init.body)) as { model?: string }).model).toBe(
      "gemini-test-model",
    );

    calls.length = 0;
    await withEnv({ GEMINI_MODEL: "gemini-env-model" }, async () => {
      await transcribeImage(IMAGE, { provider: "gemini", apiKey: "k", fetchImpl });
    });
    expect((JSON.parse(String(calls[0]?.init.body)) as { model?: string }).model).toBe(
      "gemini-env-model",
    );
  });

  it("returns the text of the last model_output step, skipping thoughts", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({
        status: "completed",
        steps: [
          { type: "thought", signature: "EvEFCu4..." },
          {
            type: "model_output",
            content: [
              { type: "text", text: "Grocery list\n" },
              { type: "text", text: "milk\neggs" },
            ],
          },
        ],
      }),
    );

    await expect(
      transcribeImage(IMAGE, { provider: "gemini", apiKey: "k", fetchImpl }),
    ).resolves.toEqual({ text: "Grocery list\nmilk\neggs" });
  });

  it("hands back literal text, mistakes and all", async () => {
    const raw = "teh quikc brownn fox\n\njupmps";
    const { fetchImpl } = stubFetch(() => geminiReply(raw));

    const result = await transcribeImage(IMAGE, { provider: "gemini", apiKey: "k", fetchImpl });
    expect(result.text).toBe(raw);
  });

  it("removes a code fence the model added around the transcription", async () => {
    const { fetchImpl } = stubFetch(() => geminiReply("```\nBuy milk\nCall mum\n```"));

    const result = await transcribeImage(IMAGE, { provider: "gemini", apiKey: "k", fetchImpl });
    expect(result.text).toBe("Buy milk\nCall mum");
  });

  it("maps the NO_TEXT_DETECTED sentinel to NoTextDetectedError", async () => {
    for (const reply of ["NO_TEXT_DETECTED", "NO_TEXT_DETECTED.", '"NO_TEXT_DETECTED"']) {
      const { fetchImpl } = stubFetch(() => geminiReply(reply));
      await expect(
        transcribeImage(IMAGE, { provider: "gemini", apiKey: "k", fetchImpl }),
      ).rejects.toBeInstanceOf(NoTextDetectedError);
    }
  });

  it("treats an empty or missing model_output as no text", async () => {
    for (const payload of [
      { steps: [{ type: "thought", signature: "abc" }] },
      { steps: [{ type: "model_output", content: [] }] },
      { steps: [{ type: "model_output", content: [{ type: "text", text: "   " }] }] },
    ]) {
      const { fetchImpl } = stubFetch(() => jsonResponse(payload));
      await expect(
        transcribeImage(IMAGE, { provider: "gemini", apiKey: "k", fetchImpl }),
      ).rejects.toBeInstanceOf(NoTextDetectedError);
    }
  });

  it("maps an invalid API key to InvalidCredentialsError", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse(
        {
          error: {
            code: 400,
            message: "API key not valid. Please pass a valid API key.",
            status: "INVALID_ARGUMENT",
          },
        },
        400,
      ),
    );

    await expect(
      transcribeImage(IMAGE, { provider: "gemini", apiKey: "bad", fetchImpl }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it("maps a 403 permission error to InvalidCredentialsError", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({ error: { code: 403, message: "Permission denied on resource project." } }, 403),
    );

    await expect(
      transcribeImage(IMAGE, { provider: "gemini", apiKey: "k", fetchImpl }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it("maps a disabled Generative Language API to ApiNotEnabledError", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse(
        {
          error: {
            code: 403,
            message:
              "Generative Language API has not been used in project 510607 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/generativelanguage.googleapis.com/overview?project=510607 then retry.",
            status: "PERMISSION_DENIED",
          },
        },
        403,
      ),
    );

    await expect(
      transcribeImage(IMAGE, { provider: "gemini", apiKey: "k", fetchImpl }),
    ).rejects.toBeInstanceOf(ApiNotEnabledError);
  });

  it("maps upstream rate limiting to a RetryableProviderError with status 429", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({ error: { code: 429, message: "Quota exceeded." } }, 429),
    );

    const error = await transcribeImage(IMAGE, { provider: "gemini", apiKey: "k", fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RetryableProviderError);
    expect((error as RetryableProviderError).status).toBe(429);
  });

  it("does not retry a 429 — the quota is spent, not shedding load", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      jsonResponse({ error: { code: 429, message: "Quota exceeded." } }, 429),
    );

    await expect(
      transcribeImage(IMAGE, { provider: "gemini", apiKey: "k", fetchImpl }),
    ).rejects.toBeInstanceOf(RetryableProviderError);
    expect(calls).toHaveLength(1);
  });

  it("retries a 503 and succeeds when the provider recovers", async () => {
    const { fetchImpl, calls } = stubFetch((_url, init) => {
      const attempt = calls.length; // stubFetch records before calling the handler
      void init;
      if (attempt < 3) {
        return jsonResponse({ error: { code: 503, message: "high demand" } }, 503);
      }
      return geminiReply("recovered");
    });

    const result = await transcribeImage(IMAGE, {
      provider: "gemini",
      apiKey: "k",
      fetchImpl,
    });

    expect(result.text).toBe("recovered");
    expect(calls.length).toBeGreaterThan(1);
  });

  it("gives up on a persistent 503 with a retryable error", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      jsonResponse({ error: { code: 503, message: "high demand" } }, 503),
    );

    const error = await transcribeImage(IMAGE, { provider: "gemini", apiKey: "k", fetchImpl }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(calls).toHaveLength(3);
  });

  it("wraps network failures with status 0", async () => {
    const { fetchImpl } = stubFetch(() => {
      throw new Error("socket hang up");
    });

    const error = await transcribeImage(IMAGE, { provider: "gemini", apiKey: "k", fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(VisionRequestError);
    expect((error as VisionRequestError).status).toBe(0);
    expect((error as VisionRequestError).message).toContain("socket hang up");
  });

  it("handles a non-JSON error body without crashing", async () => {
    const { fetchImpl } = stubFetch(() => new Response("<html>gateway</html>", { status: 502 }));

    // 502 is retryable, so it exhausts the attempts and reports as retryable
    // rather than crashing on the unparseable body.
    await expect(
      transcribeImage(IMAGE, { provider: "gemini", apiKey: "k", fetchImpl }),
    ).rejects.toBeInstanceOf(RetryableProviderError);
  });

  it("mentions the requested languages in the prompt when hinted", async () => {
    const { fetchImpl, calls } = stubFetch(() => geminiReply("bonjour"));

    await transcribeImage(IMAGE, {
      provider: "gemini",
      apiKey: "k",
      fetchImpl,
      languageHints: ["fr"],
    });

    const body = JSON.parse(String(calls[0]?.init.body)) as {
      input: Array<{ text?: string }>;
    };
    expect(body.input[0]?.text).toContain("fr");
  });
});
