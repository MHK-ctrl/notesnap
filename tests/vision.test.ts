import { describe, expect, it } from "vitest";

import {
  ApiNotEnabledError,
  BillingNotEnabledError,
  InvalidCredentialsError,
  MissingCredentialsError,
  NoTextDetectedError,
  VisionRequestError,
  transcribeImage,
} from "@/lib/vision";

const IMAGE = new Uint8Array([1, 2, 3, 4, 5]);

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

describe("transcribeImage", () => {
  it("throws MissingCredentialsError when no key is available", async () => {
    const previous = process.env.GOOGLE_VISION_API_KEY;
    delete process.env.GOOGLE_VISION_API_KEY;

    await expect(transcribeImage(IMAGE)).rejects.toBeInstanceOf(MissingCredentialsError);

    if (previous !== undefined) process.env.GOOGLE_VISION_API_KEY = previous;
  });

  it("treats the .env.example placeholder as missing credentials", async () => {
    await expect(
      transcribeImage(IMAGE, { apiKey: "your-google-cloud-vision-api-key-here" }),
    ).rejects.toBeInstanceOf(MissingCredentialsError);
  });

  it("requests DOCUMENT_TEXT_DETECTION with base64 image content", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      jsonResponse({ responses: [{ fullTextAnnotation: { text: "hi" } }] }),
    );

    await transcribeImage(IMAGE, { apiKey: "test-key", fetchImpl });

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

    await expect(transcribeImage(IMAGE, { apiKey: "k", fetchImpl })).resolves.toEqual({
      text: "Grocery list\nmilk\neggs",
    });
  });

  it("falls back to textAnnotations when there is no full document annotation", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({ responses: [{ textAnnotations: [{ description: "sticky note" }] }] }),
    );

    await expect(transcribeImage(IMAGE, { apiKey: "k", fetchImpl })).resolves.toEqual({
      text: "sticky note",
    });
  });

  it("hands back literal text, mistakes and all", async () => {
    const raw = "teh quikc brownn fox\n\njupmps";
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({ responses: [{ fullTextAnnotation: { text: raw } }] }),
    );

    const result = await transcribeImage(IMAGE, { apiKey: "k", fetchImpl });
    expect(result.text).toBe(raw);
  });

  it("only trims the padding Vision adds around the response", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({ responses: [{ fullTextAnnotation: { text: "  indented line\n\n" } }] }),
    );

    const result = await transcribeImage(IMAGE, { apiKey: "k", fetchImpl });
    expect(result.text).toBe("indented line");
  });

  it("throws NoTextDetectedError for an empty page", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ responses: [{}] }));

    await expect(transcribeImage(IMAGE, { apiKey: "k", fetchImpl })).rejects.toBeInstanceOf(
      NoTextDetectedError,
    );
  });

  it("maps an invalid API key to InvalidCredentialsError", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({ error: { message: "API key not valid. Please pass a valid API key." } }, 400),
    );

    await expect(transcribeImage(IMAGE, { apiKey: "bad", fetchImpl })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it("maps a 403 permission error to InvalidCredentialsError", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({ error: { message: "Permission denied on resource project." } }, 403),
    );

    await expect(transcribeImage(IMAGE, { apiKey: "k", fetchImpl })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
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

    await expect(transcribeImage(IMAGE, { apiKey: "k", fetchImpl })).rejects.toBeInstanceOf(
      ApiNotEnabledError,
    );
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

    await expect(transcribeImage(IMAGE, { apiKey: "k", fetchImpl })).rejects.toBeInstanceOf(
      BillingNotEnabledError,
    );
  });

  it("maps upstream rate limiting to a VisionRequestError with status 429", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ error: { message: "Quota" } }, 429));

    const error = await transcribeImage(IMAGE, { apiKey: "k", fetchImpl }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VisionRequestError);
    expect((error as VisionRequestError).status).toBe(429);
  });

  it("wraps network failures with status 0", async () => {
    const { fetchImpl } = stubFetch(() => {
      throw new Error("socket hang up");
    });

    const error = await transcribeImage(IMAGE, { apiKey: "k", fetchImpl }).catch((e: unknown) => e);
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

    await expect(transcribeImage(IMAGE, { apiKey: "k", fetchImpl })).rejects.toThrow(
      "Bad image data.",
    );
  });

  it("handles a non-JSON error body without crashing", async () => {
    const { fetchImpl } = stubFetch(() => new Response("<html>gateway</html>", { status: 502 }));

    await expect(transcribeImage(IMAGE, { apiKey: "k", fetchImpl })).rejects.toBeInstanceOf(
      VisionRequestError,
    );
  });

  it("sends language hints only when provided", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      jsonResponse({ responses: [{ fullTextAnnotation: { text: "bonjour" } }] }),
    );

    await transcribeImage(IMAGE, { apiKey: "k", fetchImpl, languageHints: ["fr"] });
    const withHints = JSON.parse(String(calls[0]?.init.body)) as {
      requests: Array<{ imageContext?: { languageHints?: string[] } }>;
    };
    expect(withHints.requests[0]?.imageContext?.languageHints).toEqual(["fr"]);

    calls.length = 0;
    await transcribeImage(IMAGE, { apiKey: "k", fetchImpl });
    const withoutHints = JSON.parse(String(calls[0]?.init.body)) as {
      requests: Array<{ imageContext?: unknown }>;
    };
    expect(withoutHints.requests[0]?.imageContext).toBeUndefined();
  });
});
