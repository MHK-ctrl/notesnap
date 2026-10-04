/**
 * POST /api/transcribe — the app's only OCR endpoint.
 *
 * The image arrives as multipart/form-data, is validated again here (the client
 * checks are for UX, not security), and is forwarded in memory to the OCR
 * provider chosen in `lib/vision.ts` (Gemini free tier or Cloud Vision).
 * Nothing is written to disk, cached or logged: process, respond, forget.
 *
 * The API key is read from `process.env` inside `lib/vision.ts` and never leaves
 * the server. This file must stay a server module.
 */

import { NextResponse } from "next/server";

import { checkRateLimit, getClientKey, type RateLimitResult } from "@/lib/rate-limit";
import { MAX_FILE_BYTES, validateImageFile } from "@/lib/validation";
import {
  ApiNotEnabledError,
  BillingNotEnabledError,
  InvalidCredentialsError,
  MissingCredentialsError,
  NoTextDetectedError,
  transcribeImage,
  VisionRequestError,
  RetryableProviderError,
} from "@/lib/vision";

// Buffer/File handling and env access need the Node runtime, not Edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Form field that carries the image. */
const IMAGE_FIELD = "image";

/** Reject oversized bodies before parsing them (multipart adds a little overhead). */
const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 512 * 1024;

export async function POST(request: Request): Promise<NextResponse> {
  const contentLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return errorResponse(
      413,
      "too_large",
      "That upload is too large. The limit is 10 MB — try a smaller photo.",
    );
  }

  const rateLimit = await checkRateLimit(getClientKey(request.headers));
  if (!rateLimit.ok) {
    return errorResponse(
      429,
      "rate_limited",
      `Too many transcriptions from this device. Try again in ${rateLimit.retryAfterSeconds}s.`,
      {
        "Retry-After": String(rateLimit.retryAfterSeconds),
        ...rateLimitHeaders(rateLimit),
      },
    );
  }

  // Present on every answer after the limit check, so the limiter that handled
  // a request is observable even when the request itself fails.
  const rateHeaders = rateLimitHeaders(rateLimit);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(
      400,
      "invalid_request",
      "We couldn't read that upload. Please try again.",
      rateHeaders,
    );
  }

  const entry = form.get(IMAGE_FIELD);
  if (!isFileLike(entry)) {
    return errorResponse(
      400,
      "invalid_request",
      'No image was included in the request (expected a "image" form field).',
      rateHeaders,
    );
  }

  const validation = validateImageFile({
    name: entry.name,
    type: entry.type,
    size: entry.size,
  });
  if (!validation.ok) {
    return errorResponse(
      validation.code === "too_large" ? 413 : 400,
      validation.code,
      validation.message,
      rateHeaders,
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await entry.arrayBuffer());
  } catch {
    return errorResponse(
      400,
      "invalid_request",
      "We couldn't read that image. Please try again.",
      rateHeaders,
    );
  }

  if (bytes.byteLength === 0) {
    return errorResponse(
      400,
      "empty_file",
      "That file is empty. Pick a photo and try again.",
      rateHeaders,
    );
  }

  try {
    // Literal transcription only — no autocorrect, no rewriting. The declared
    // MIME type matters to Gemini's inline image data; the adapter sniffs the
    // bytes when the upload arrives without one.
    const { text } = await transcribeImage(bytes, { mimeType: entry.type || undefined });
    return NextResponse.json({ text }, { headers: { ...NO_STORE, ...rateHeaders } });
  } catch (error) {
    return mapError(error, rateHeaders);
  }
}

function mapError(error: unknown, headers: Record<string, string>): NextResponse {
  if (error instanceof MissingCredentialsError) {
    return errorResponse(
      500,
      "missing_credentials",
      "This NoteSnap instance has no OCR key configured. Deployers: set GEMINI_API_KEY (Google AI Studio — free, no credit card) or GOOGLE_VISION_API_KEY (Cloud Vision) in your environment, then redeploy.",
      headers,
    );
  }

  if (error instanceof InvalidCredentialsError) {
    return errorResponse(
      500,
      "invalid_credentials",
      "The OCR provider rejected the configured API key. Deployers: check that the key is valid — and, for Cloud Vision, that the Cloud Vision API is enabled on the key's project.",
      headers,
    );
  }

  if (error instanceof ApiNotEnabledError) {
    return errorResponse(
      500,
      "api_not_enabled",
      "Google rejected the request because the OCR API isn't enabled on the project behind this API key. Cloud Vision: enable it at https://console.cloud.google.com/apis/library/vision.googleapis.com with the key's project selected. Gemini: enable the Generative Language API on that project, or create a fresh AI Studio key.",
      headers,
    );
  }

  if (error instanceof BillingNotEnabledError) {
    return errorResponse(
      500,
      "billing_not_enabled",
      "Google rejected the request because the project behind this API key has a billing problem. Cloud Vision needs a billing account even though it has a free monthly tier; the Gemini free tier does not — switching to GEMINI_API_KEY may be the fastest fix.",
      headers,
    );
  }

  if (error instanceof NoTextDetectedError) {
    return errorResponse(
      422,
      "no_text",
      "We couldn't find any handwriting in that photo. Try again with more light, less glare, and the page filling the frame.",
      headers,
    );
  }

  if (error instanceof RetryableProviderError) {
    // The provider is shedding load (Google's "high demand" 503s) or the
    // project's free-tier quota is spent. Either way the request is fine — it
    // just can't be served right now — so report that, not a broken server.
    console.warn("[notesnap] ocr provider unavailable, giving up", {
      status: error.status,
      message: error.message,
    });
    const isQuota = error.status === 429;
    return errorResponse(
      isQuota ? 429 : 503,
      "provider_busy",
      isQuota
        ? "The free OCR quota for this deployment is used up for today. Try again after it resets, or bring your own key."
        : "The transcription service is busy right now. Wait a few seconds and try again — your photo wasn't the problem.",
      headers,
      { "Retry-After": String(RETRY_AFTER_SECONDS) },
    );
  }

  if (error instanceof VisionRequestError) {
    console.error("[notesnap] ocr request failed", {
      status: error.status,
      message: error.message,
    });
    return errorResponse(
      502,
      "ocr_failed",
      "The transcription service didn't answer correctly. Please try again in a moment.",
      headers,
    );
  }

  console.error("[notesnap] unexpected transcription error", error);
  return errorResponse(
    500,
    "unexpected_error",
    "Something went wrong while transcribing. Please try again.",
    headers,
  );
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** How long to tell clients to wait after a temporary provider failure. */
const RETRY_AFTER_SECONDS = 5;

/**
 * Exposes which limiter answered (`shared` = Upstash Redis, `instance` = this
 * process's memory) so a deployment's real protection is observable rather
 * than assumed.
 */
function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Mode": result.mode,
  };
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
  extraHeaders: Record<string, string> = {},
): NextResponse {
  return NextResponse.json(
    { error: { code, message } },
    { status, headers: { ...headers, ...extraHeaders, ...NO_STORE } },
  );
}

/** Structural check so the route works with any `File`-like implementation. */
function isFileLike(value: FormDataEntryValue | null): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as File).arrayBuffer === "function" &&
    typeof (value as File).size === "number"
  );
}
