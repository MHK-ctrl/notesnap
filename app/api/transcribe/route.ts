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

import {
  consumeDemoBudget,
  getSharedStore,
  isQuotaBreakerSet,
  setQuotaBreaker,
} from "@/lib/demo-quota";
import { nextPacificMidnight, secondsUntil } from "@/lib/pacific-time";
import { checkRateLimit, getClientKey, type RateLimitResult } from "@/lib/rate-limit";
import { readUserSuppliedKey, redactSecret } from "@/lib/user-key";
import { MAX_FILE_BYTES, validateImageFile } from "@/lib/validation";
import {
  ApiNotEnabledError,
  BillingNotEnabledError,
  InvalidCredentialsError,
  MissingCredentialsError,
  NoTextDetectedError,
  ProviderQuotaExceededError,
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

/**
 * Provider + model the shared circuit breaker is keyed by. Google's limits are
 * per project *and* per model, so this pair identifies which budget is spent.
 * Defaults mirror `lib/vision.ts`; the model is overridable for operators.
 */
const DEMO_PROVIDER = "gemini";
const DEMO_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";

/** Points visitors at the free key that keeps working when the demo is closed. */
const BRING_YOUR_OWN_KEY_HINT =
  "Get a free Gemini key at https://aistudio.google.com/app/apikey and paste it into the key field — your transcriptions then use your own quota.";

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
  // Present on every answer after the limit check, so the limiter that handled
  // a request is observable even when the request itself fails.
  const rateHeaders = rateLimitHeaders(rateLimit);

  // A visitor's own key spends their own provider quota, so it bypasses the demo
  // budget and the circuit breaker entirely — but not the per-IP burst window,
  // which still protects this deployment from being used as a free proxy.
  const userKey = readUserSuppliedKey(request.headers);
  const store = getSharedStore();

  if (!userKey && store) {
    const breaker = await isQuotaBreakerSet(store, DEMO_PROVIDER, DEMO_MODEL);
    if (breaker) {
      return quotaExhaustedResponse(rateHeaders);
    }

    const budget = await consumeDemoBudget(store, getClientKey(request.headers));
    if (!budget.ok) {
      return budgetResponse(budget, rateHeaders);
    }
    if (typeof budget.remaining === "number") {
      rateHeaders["X-Demo-Remaining"] = String(budget.remaining);
    }
  }

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
    const { text } = await transcribeImage(bytes, {
      mimeType: entry.type || undefined,
      // The visitor's key is used for this call only and then falls out of scope.
      apiKey: userKey ?? undefined,
    });
    return NextResponse.json({ text }, { headers: { ...NO_STORE, ...rateHeaders } });
  } catch (error) {
    if (error instanceof ProviderQuotaExceededError && store && !userKey) {
      // Remember it so the next visitor is turned away without spending a request
      // to rediscover the same wall. The TTL expires at the Pacific reset.
      await setQuotaBreaker(store, error.provider, DEMO_MODEL).catch((storeError) => {
        console.error("[notesnap] could not record the provider quota state", storeError);
      });
      return quotaExhaustedResponse(rateHeaders);
    }
    return mapError(error, rateHeaders, userKey);
  }
}

/** 429 once the provider confirms its daily quota is spent for this project. */
function quotaExhaustedResponse(headers: Record<string, string>): NextResponse {
  const resetsAt = nextPacificMidnight();
  return errorResponse(
    429,
    "provider_quota_exhausted",
    `The demo's free OCR quota is used up for today and resets at midnight Pacific. ${BRING_YOUR_OWN_KEY_HINT}`,
    headers,
    { "Retry-After": String(secondsUntil(Date.now(), resetsAt)) },
  );
}

/** 429 when the demo's own daily budget — per-IP or global — is spent. */
function budgetResponse(
  budget: { reason?: string; resetsAt?: number },
  headers: Record<string, string>,
): NextResponse {
  if (budget.reason === "store_unavailable") {
    // Fail closed: we cannot know today's spend, so we do not hand out an
    // unmetered request and risk burning the project's quota invisibly.
    return errorResponse(
      503,
      "demo_unavailable",
      `The demo can't verify its remaining quota right now, so it isn't accepting requests. ${BRING_YOUR_OWN_KEY_HINT}`,
      headers,
      { "Retry-After": "30" },
    );
  }

  const resetsAt = budget.resetsAt ?? nextPacificMidnight();
  const which =
    budget.reason === "global_daily"
      ? "Everyone's demo quota is used up for today"
      : "You've used today's demo allowance";

  return errorResponse(
    429,
    "demo_budget_exhausted",
    `${which}. It resets at midnight Pacific. ${BRING_YOUR_OWN_KEY_HINT}`,
    headers,
    { "Retry-After": String(secondsUntil(Date.now(), resetsAt)) },
  );
}

function mapError(
  error: unknown,
  headers: Record<string, string>,
  userKey: string | null = null,
): NextResponse {
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
    // Redacted because upstream error bodies can echo request details, and this
    // message is written to logs.
    console.error("[notesnap] ocr request failed", {
      status: error.status,
      message: redactSecret(error.message, userKey),
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
