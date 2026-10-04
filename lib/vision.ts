/**
 * Google Cloud Vision wrapper — server-only.
 *
 * `import "server-only"` makes the build fail loudly if any client component
 * ever imports this file, which keeps the API key on the server.
 *
 * This module is intentionally the only place that knows about Vision's wire
 * format. To swap in a different OCR engine later, reimplement
 * `transcribeImage` in terms of the same return shape.
 *
 * Auth: a Google Cloud API key (`GOOGLE_VISION_API_KEY`). Vision's REST API
 * accepts `?key=`, so no SDK or OAuth flow is needed. Prefer a service account
 * with a restricted IAM role for production — see README "Production notes".
 */

import "server-only";

const VISION_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate";
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * DOCUMENT_TEXT_DETECTION is Vision's dense/handwriting-oriented OCR mode: it
 * returns a full document layout instead of loose word boxes.
 */
const DOCUMENT_TEXT_DETECTION = "DOCUMENT_TEXT_DETECTION" as const;

/** No `GOOGLE_VISION_API_KEY` in the environment. */
export class MissingCredentialsError extends Error {
  constructor(message = "GOOGLE_VISION_API_KEY is not set") {
    super(message);
    this.name = "MissingCredentialsError";
  }
}

/** Google rejected the key (disabled API, wrong project, revoked key). */
export class InvalidCredentialsError extends Error {
  constructor(message = "Google Cloud Vision rejected the API key") {
    super(message);
    this.name = "InvalidCredentialsError";
  }
}

/** The key is fine, but the project that owns it has the Cloud Vision API disabled. */
export class ApiNotEnabledError extends Error {
  constructor(message = "The Cloud Vision API is not enabled on this Google Cloud project") {
    super(message);
    this.name = "ApiNotEnabledError";
  }
}

/** The key is fine, but the project that owns it has no billing account enabled. */
export class BillingNotEnabledError extends Error {
  constructor(message = "The Google Cloud project behind this key has no billing account enabled") {
    super(message);
    this.name = "BillingNotEnabledError";
  }
}

/** Anything else that went wrong while talking to Vision. */
export class VisionRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "VisionRequestError";
    this.status = status;
  }
}

/** Vision answered, but found no text at all. */
export class NoTextDetectedError extends Error {
  constructor(message = "No text detected in the image") {
    super(message);
    this.name = "NoTextDetectedError";
  }
}

export interface TranscribeImageOptions {
  /** Defaults to `process.env.GOOGLE_VISION_API_KEY`. */
  apiKey?: string;
  /** Optional OCR language hints, e.g. ["en"]. Leave undefined for auto-detect. */
  languageHints?: string[];
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface TranscribeImageResult {
  /** Literal text from Vision. Only surrounding whitespace is trimmed. */
  text: string;
}

interface AnnotateResponse {
  responses?: Array<{
    fullTextAnnotation?: { text?: string };
    textAnnotations?: Array<{ description?: string }>;
    error?: { code?: number; message?: string };
  }>;
}

/**
 * Runs DOCUMENT_TEXT_DETECTION (Vision's handwriting-oriented OCR mode) over an
 * image buffer and returns the raw text.
 *
 * The text is never rewritten, spell-checked or "cleaned" — lower layers must
 * hand back exactly what Vision read.
 */
export async function transcribeImage(
  image: Uint8Array,
  options: TranscribeImageOptions = {},
): Promise<TranscribeImageResult> {
  const apiKey = options.apiKey ?? process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey || apiKey.trim() === "" || apiKey.startsWith("your-")) {
    throw new MissingCredentialsError();
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const body = JSON.stringify({
    requests: [
      {
        image: { content: toBase64(image) },
        features: [{ type: DOCUMENT_TEXT_DETECTION }],
        ...(options.languageHints?.length
          ? { imageContext: { languageHints: options.languageHints } }
          : {}),
      },
    ],
  });

  let response: Response;
  try {
    response = await fetchImpl(`${VISION_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "network error";
    throw new VisionRequestError(`Could not reach Google Cloud Vision: ${reason}`, 0);
  }

  const rawText = await response.text();
  const payload = safeJson(rawText);

  if (!response.ok) {
    throw mapHttpError(response.status, extractErrorMessage(payload) ?? rawText);
  }

  const result = payload?.responses?.[0];
  const upstreamError = result?.error;
  if (upstreamError?.message) {
    throw new VisionRequestError(upstreamError.message, upstreamError.code ?? 502);
  }

  const text = result?.fullTextAnnotation?.text ?? result?.textAnnotations?.[0]?.description ?? "";
  // Only the padding is trimmed; characters, casing and line breaks are kept.
  const trimmed = text.trim();

  if (trimmed === "") {
    throw new NoTextDetectedError();
  }

  return { text: trimmed };
}

function mapHttpError(status: number, detail: string): Error {
  if (/api key not valid|api_key_invalid/i.test(detail)) {
    return new InvalidCredentialsError(detail || "Google Cloud Vision rejected the API key");
  }

  // A valid key on a project that isn't set up yet. These are the two most common
  // deployment mistakes, so they get their own actionable errors instead of a
  // generic upstream failure that reads like a Vision outage.
  if (/billing/i.test(detail)) {
    return new BillingNotEnabledError(detail || undefined);
  }
  if (/has not been used in project|service_disabled|it is disabled/i.test(detail)) {
    return new ApiNotEnabledError(detail || undefined);
  }

  if (status === 400 || status === 401 || status === 403) {
    if (/permission denied|not authorized/i.test(detail)) {
      return new InvalidCredentialsError(detail || "Google Cloud Vision rejected the API key");
    }
  }
  if (status === 429) {
    return new VisionRequestError("Google Cloud Vision is rate limiting this project.", 429);
  }
  return new VisionRequestError(detail || `Vision request failed with HTTP ${status}`, status);
}

function extractErrorMessage(payload: AnnotateResponse | null): string | undefined {
  const message = (payload as { error?: { message?: string } } | null)?.error?.message;
  return typeof message === "string" ? message : undefined;
}

function safeJson(raw: string): AnnotateResponse | null {
  try {
    return JSON.parse(raw) as AnnotateResponse;
  } catch {
    return null;
  }
}

/** Base64 of the image bytes — the encoding Vision expects for inline content. */
function toBase64(image: Uint8Array): string {
  return Buffer.from(image).toString("base64");
}
