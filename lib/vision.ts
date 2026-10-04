/**
 * OCR wrapper — server-only. Speaks to one of two Google providers:
 *
 * - Gemini API (Google AI Studio) — the recommended default: a free tier that
 *   needs no credit card, and strong handwriting recognition. Auth: `GEMINI_API_KEY`.
 * - Google Cloud Vision — the original provider. Auth: `GOOGLE_VISION_API_KEY`.
 *   Vision has a free monthly tier, but Google requires a Cloud Billing
 *   account on the project, so it is the heavier setup of the two.
 *
 * `import "server-only"` makes the build fail loudly if any client component
 * ever imports this file, which keeps the API keys on the server.
 *
 * This module is intentionally the only place that knows either provider's wire
 * format. The provider is chosen from the environment — Cloud Vision wins when
 * both keys are set, so existing deployments keep behaving exactly as before —
 * or forced per call with `options.provider`.
 */

import "server-only";

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Transient upstream failures (Gemini's "high demand" 503s, timeouts, 5xx) are
 * retried a couple of times before we surface them. Google's free tier sheds
 * load this way regularly, and a retry usually succeeds within a second or two.
 *
 * 429 is deliberately excluded: on the free tier it means the daily quota is
 * spent, and retrying immediately would only burn time. It is still reported as
 * retryable so the route answers 429 + `Retry-After` rather than a vague 502.
 */
const RETRYABLE_UPSTREAM_STATUSES = new Set([408, 425, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 400;

/**
 * How long to pause before the next request when a 429 can't be classified.
 *
 * Deliberately short. An ambiguous 429 might be a brief throttle, and guessing
 * "a minute" would stall a working demo; guessing "all day" would take the demo
 * down over a transient blip. A short shared cooldown is the conservative choice
 * in both directions — the shared store means every instance backs off together
 * rather than each discovering the limit on its own.
 */
const DEFAULT_THROTTLE_COOLDOWN_SECONDS = 15;

/** Provider states surfaced by `/api/status` and the UI. */
export type ProviderState =
  | "ready"
  | "daily_quota_exhausted"
  | "temporarily_throttled"
  | "unknown";

function isRetryableUpstreamStatus(status: number): boolean {
  return RETRYABLE_UPSTREAM_STATUSES.has(status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const VISION_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate";

/**
 * DOCUMENT_TEXT_DETECTION is Vision's dense/handwriting-oriented OCR mode: it
 * returns a full document layout instead of loose word boxes.
 */
const DOCUMENT_TEXT_DETECTION = "DOCUMENT_TEXT_DETECTION" as const;

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

/** Current Flash model at the time of writing; override with `GEMINI_MODEL`. */
const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

/** Reply the model is told to give when the photo holds no readable text. */
const NO_TEXT_SENTINEL = "NO_TEXT_DETECTED";

/** No API key is configured for the selected OCR provider. */
export class MissingCredentialsError extends Error {
  constructor(message = "No OCR API key is set") {
    super(message);
    this.name = "MissingCredentialsError";
  }
}

/** The provider rejected the key (revoked key, wrong project, disabled API). */
export class InvalidCredentialsError extends Error {
  constructor(message = "The OCR provider rejected the API key") {
    super(message);
    this.name = "InvalidCredentialsError";
  }
}

/** The key is fine, but its project has the OCR API disabled. */
export class ApiNotEnabledError extends Error {
  constructor(message = "The OCR API is not enabled on this key's project") {
    super(message);
    this.name = "ApiNotEnabledError";
  }
}

/** The key is fine, but its project has a billing problem. */
export class BillingNotEnabledError extends Error {
  constructor(message = "The project behind this API key has a billing problem") {
    super(message);
    this.name = "BillingNotEnabledError";
  }
}

/** Anything else that went wrong while talking to the provider. */
/**
 * A transient rate limit. Carries the provider's own wait (or the short default
 * cooldown) so the UI can say "busy — retrying is fine in ~Ns" instead of
 * implying the day is over.
 */
export class ThrottledProviderError extends Error {
  readonly retryAfterSeconds: number;
  readonly evidence: string;

  constructor(retryAfterSeconds: number, evidence: string) {
    super(`The OCR provider is rate limiting this project; retry in ${retryAfterSeconds}s.`);
    this.name = "ThrottledProviderError";
    this.retryAfterSeconds = retryAfterSeconds;
    this.evidence = evidence;
  }
}

/**
 * The provider confirmed its per-project daily quota is spent.
 *
 * Distinct from a throttled 429 because this one lasts until the Pacific reset,
 * not a second or two. The route records it in the shared store so later
 * visitors are turned away immediately instead of each spending a request to
 * rediscover the same wall.
 */
export class ProviderQuotaExceededError extends Error {
  readonly provider: string;
  readonly detail: string;

  constructor(detail: string, provider = "gemini") {
    super(detail || "The OCR provider's daily quota is exhausted.");
    this.name = "ProviderQuotaExceededError";
    this.provider = provider;
    this.detail = detail;
  }
}

/**
 * A provider failure that is worth retrying (Google shedding load, a transient
 * 5xx). The route turns this into a 503 with `Retry-After` so clients can back
 * off, instead of the opaque 502 that made a temporary spike look like a bug.
 */
export class RetryableProviderError extends Error {
  readonly status: number;

  constructor(message: string, status = 503) {
    super(message);
    this.name = "RetryableProviderError";
    this.status = status;
  }
}

export class VisionRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "VisionRequestError";
    this.status = status;
  }
}

/** The provider answered, but found no text at all. */
export class NoTextDetectedError extends Error {
  constructor(message = "No text detected in the image") {
    super(message);
    this.name = "NoTextDetectedError";
  }
}

export type OcrProvider = "google-vision" | "gemini";

export interface TranscribeImageOptions {
  /** Force a provider. Defaults to whichever API key is configured in the environment. */
  provider?: OcrProvider;
  /** Key for the selected provider. Defaults to that provider's environment variable. */
  apiKey?: string;
  /**
   * Image MIME type. Only Gemini needs it (for inline data); when omitted it is
   * sniffed from the file's magic bytes, falling back to `image/jpeg`.
   */
  mimeType?: string;
  /** Gemini model override. Defaults to `GEMINI_MODEL` or a current Flash model. */
  model?: string;
  /**
   * Optional language hints, e.g. ["en"]. Cloud Vision receives them as
   * `languageHints`; Gemini gets them as one extra sentence in the prompt.
   */
  languageHints?: string[];
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface TranscribeImageResult {
  /** Literal text from the provider. Only surrounding whitespace is trimmed. */
  text: string;
}

interface AnnotateResponse {
  responses?: Array<{
    fullTextAnnotation?: { text?: string };
    textAnnotations?: Array<{ description?: string }>;
    error?: { code?: number; message?: string };
  }>;
}

interface InteractionResponse {
  steps?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
}

/**
 * Shape of the error envelope Google returns. Only the fields this app acts on
 * are modelled; everything else is left untyped so a provider addition can't
 * silently change behaviour.
 */
interface ProviderErrorEnvelope {
  error?: {
    code?: number | string;
    message?: string;
    status?: string;
    /** Structured, machine-readable reasons. Preferred over message matching. */
    details?: Array<{
      "@type"?: string;
      reason?: string;
      /** e.g. "GenerateRequestsPerDay" — a per-day metric means a day-long lock. */
      quotaMetric?: string;
      quotaId?: string;
      retryDelay?: string;
    }>;
  };
}

/**
 * Quota metric fragments that mean the limit resets on a daily boundary.
 *
 * Google's metric names read like `GenerateRequestsPerDay` / `PerDay`, so a
 * case-insensitive `perday` match is the reliable signal. Anything not matching
 * (per-minute, per-token, generic "quota exceeded") is deliberately NOT treated
 * as daily — misreading it would lock the app out for a day over a throttle.
 */
const DAILY_METRIC_PATTERN = /perday|per_day|daily/i;

/**
 * Message patterns that unambiguously mean the daily allowance is gone.
 *
 * Kept narrow on purpose. Each one requires an explicit per-day/exhausted phrase;
 * a bare "quota exceeded" is NOT enough, because Google also uses that wording
 * for short-lived throttling. An unrecognised 429 falls through to a short
 * cooldown rather than a day-long breaker — being wrong in that direction costs
 * seconds, while being wrong the other way costs visitors a full day.
 */
const DAILY_MESSAGE_PATTERNS: readonly RegExp[] = [
  /exceeded your current quota.*per (day|daily)/i,
  /quota exceeded for quota metric:.*per ?day/i,
  /requests per day.*(exceeded|exhausted)/i,
  /daily (quota|limit|request).*(exceeded|exhausted)/i,
  /(exceeded|exhausted).*daily (quota|limit|request)/i,
];

/** `RetryInfo` delays are only trusted within this bound. */
const MAX_TRUSTED_RETRY_DELAY_SECONDS = 300;

/**
 * Classifies a 429 from the provider, most-trustworthy signal first.
 *
 * Order matters and is the whole point of this function:
 *
 * 1. **Structured details** — a `quotaMetric` naming a per-day limit is
 *    machine-readable evidence, not a guess.
 * 2. **Narrow message patterns** — only phrases that explicitly say "per day".
 * 3. **A valid `RetryInfo` / `Retry-After`** — the provider told us when to come
 *    back, so use exactly that wait.
 * 4. **Otherwise: transient**, with a bounded shared cooldown. Never a day-long
 *    lock, and never an invented 60s wait.
 */
export type ProviderLimitVerdict =
  | { kind: "daily_quota_exhausted"; evidence: string }
  | { kind: "temporarily_throttled"; retryAfterSeconds: number; evidence: string };

export function classifyRateLimit(
  payload: unknown,
  retryAfterHeader: string | null,
): ProviderLimitVerdict {
  const envelope = safeJson<ProviderErrorEnvelope>(JSON.stringify(payload ?? null)) as
    | ProviderErrorEnvelope
    | undefined;
  const details = envelope?.error?.details ?? [];
  const message = envelope?.error?.message ?? "";

  // 1. Structured details.
  for (const detail of details) {
    const metric = detail?.quotaMetric;
    if (metric && DAILY_METRIC_PATTERN.test(metric)) {
      return {
        kind: "daily_quota_exhausted",
        evidence: `quotaMetric=${metric}${detail.quotaId ? ` quotaId=${detail.quotaId}` : ""}`,
      };
    }
    if (detail?.reason && DAILY_METRIC_PATTERN.test(detail.reason)) {
      return { kind: "daily_quota_exhausted", evidence: `reason=${detail.reason}` };
    }
  }

  // 2. Narrow, explicitly-per-day message patterns.
  for (const pattern of DAILY_MESSAGE_PATTERNS) {
    if (pattern.test(message)) {
      return { kind: "daily_quota_exhausted", evidence: `message matches ${pattern}` };
    }
  }

  // 3. A provider-supplied, sane retry delay.
  const retryAfter = parseRetryAfter(retryAfterHeader);
  const retryDelay = details.find((detail) => detail?.retryDelay)?.retryDelay;
  const structuredDelay = retryDelay ? parseRetryDelay(retryDelay) : null;
  const wait = retryAfter ?? structuredDelay;

  if (wait !== null && wait > 0) {
    return {
      kind: "temporarily_throttled",
      retryAfterSeconds: Math.min(wait, MAX_TRUSTED_RETRY_DELAY_SECONDS),
      evidence: wait === retryAfter ? "Retry-After header" : "error.details.retryDelay",
    };
  }

  // 4. Unclassifiable: transient, with a short bounded cooldown.
  return {
    kind: "temporarily_throttled",
    retryAfterSeconds: DEFAULT_THROTTLE_COOLDOWN_SECONDS,
    evidence: message ? "unclassified 429, defaulting to a short cooldown" : "unclassified 429",
  };
}

/** Parses a `Retry-After` header in seconds; ignores dates and nonsense. */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number.parseInt(header.trim(), 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** Parses a protobuf duration such as `"37s"` or `"1.5s"`. */
function parseRetryDelay(delay: string): number | null {
  const match = /^(\d+(?:\.\d+)?)s$/.exec(delay.trim());
  if (!match) return null;
  const seconds = Number.parseFloat(match[1] ?? "");
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * Runs OCR over an image buffer and returns the raw text.
 *
 * The text is never rewritten, spell-checked or "cleaned" — lower layers must
 * hand back exactly what the provider read.
 */
export async function transcribeImage(
  image: Uint8Array,
  options: TranscribeImageOptions = {},
): Promise<TranscribeImageResult> {
  const provider = resolveProvider(options);
  return provider === "gemini"
    ? transcribeWithGemini(image, options)
    : transcribeWithCloudVision(image, options);
}

function resolveProvider(options: TranscribeImageOptions): OcrProvider {
  if (options.provider) {
    return options.provider;
  }

  // Cloud Vision wins when both keys are configured: it was the original
  // provider, so a deployment that already had a key doesn't change engine.
  if (usableKey(process.env.GOOGLE_VISION_API_KEY)) {
    return "google-vision";
  }
  if (usableKey(process.env.GEMINI_API_KEY)) {
    return "gemini";
  }

  throw new MissingCredentialsError(
    "No OCR API key is set — expected GEMINI_API_KEY (Google AI Studio) or GOOGLE_VISION_API_KEY (Cloud Vision)",
  );
}

/** A key that is present, non-blank and not the .env.example placeholder. */
function usableKey(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "" && !value.startsWith("your-");
}

/**
 * Gemini API (Google AI Studio) via the Interactions endpoint. Multimodal,
 * so the OCR "engine" is the model itself, instructed to transcribe verbatim.
 */
async function transcribeWithGemini(
  image: Uint8Array,
  options: TranscribeImageOptions,
): Promise<TranscribeImageResult> {
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
  if (!usableKey(apiKey)) {
    throw new MissingCredentialsError("GEMINI_API_KEY is not set");
  }

  const model = options.model ?? process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
  const mimeType = options.mimeType ?? detectMimeType(image);
  const fetchImpl = options.fetchImpl ?? fetch;

  const body = JSON.stringify({
    model,
    // One-shot reading: don't have Google retain the interaction server-side.
    store: false,
    input: [
      { type: "text", text: geminiInstructions(options.languageHints) },
      { type: "image", mime_type: mimeType, data: toBase64(image) },
    ],
  });

  const rawText = await requestWithRetry(fetchImpl, body, apiKey);
  const payload = safeJson<InteractionResponse>(rawText);

  if (payload === undefined) {
    throw new VisionRequestError(
      "The OCR provider sent a response we could not read.",
      502,
    );
  }

  const text = stripCodeFence(extractInteractionText(payload)).trim();

  if (text === "" || isNoTextReply(text)) {
    throw new NoTextDetectedError();
  }

  return { text };
}

/**
 * POSTs one interaction to Gemini, retrying transient load-shedding responses.
 *
 * Returns the raw response body on success. Non-retryable failures (bad key,
 * disabled API, billing) are mapped immediately by `mapUpstreamError` so the
 * route can still report the actionable cause. Once the attempts are exhausted
 * a still-retryable failure becomes a `RetryableProviderError`, which the route
 * answers with 503 + `Retry-After`.
 */
async function requestWithRetry(
  fetchImpl: typeof fetch,
  body: string,
  apiKey: string,
): Promise<string> {
  let lastDetail = "";
  let lastStatus = 503;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(GEMINI_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "network error";
      // A timeout or dropped connection is transient too, but only retry while
      // attempts remain; otherwise report it as an upstream failure.
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      throw new VisionRequestError(`Could not reach the Gemini API: ${reason}`, 0);
    }

    const rawText = await response.text();

    if (response.ok) {
      return rawText;
    }

    const payload = safeJson<InteractionResponse>(rawText);
    const detail = extractErrorMessage(payload) ?? rawText;
    lastDetail = detail;
    lastStatus = response.status;

    if (!isRetryableUpstreamStatus(response.status)) {
      if (response.status === 429) {
        const verdict = classifyRateLimit(payload, response.headers.get("retry-after"));

        // Log the provider's own fields so a 429 is diagnosable later. Vercel
        // retains only a short window of logs, and without this the next
        // occurrence is just another anonymous 429.
        console.warn("[notesnap] provider returned 429", {
          provider: "gemini",
          verdict: verdict.kind,
          evidence: verdict.evidence,
          ...(verdict.kind === "temporarily_throttled"
            ? { retryAfterSeconds: verdict.retryAfterSeconds }
            : {}),
          details: (payload as ProviderErrorEnvelope | undefined)?.error?.details ?? [],
          message: (payload as ProviderErrorEnvelope | undefined)?.error?.message ?? "",
        });

        if (verdict.kind === "daily_quota_exhausted") {
          throw new ProviderQuotaExceededError(detail, "gemini");
        }

        // Transient: carry the provider's own wait through to the client so the
        // message can tell the visitor when retrying is worthwhile.
        throw new ThrottledProviderError(verdict.retryAfterSeconds, verdict.evidence);
      }
      // Bad key, disabled API or missing billing: surface that cause at once.
      throw mapUpstreamError(response.status, detail);
    }

    if (attempt === MAX_ATTEMPTS) {
      break;
    }

    await sleep(RETRY_BASE_DELAY_MS * attempt);
  }

  throw new RetryableProviderError(
    lastDetail || `The OCR provider returned HTTP ${lastStatus}.`,
    lastStatus,
  );
}

/**
 * Runs DOCUMENT_TEXT_DETECTION (Vision's handwriting-oriented OCR mode) over an
 * image buffer and returns the raw text.
 */
async function transcribeWithCloudVision(
  image: Uint8Array,
  options: TranscribeImageOptions,
): Promise<TranscribeImageResult> {
  const apiKey = options.apiKey ?? process.env.GOOGLE_VISION_API_KEY;
  if (!usableKey(apiKey)) {
    throw new MissingCredentialsError("GOOGLE_VISION_API_KEY is not set");
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
  const payload = safeJson<AnnotateResponse>(rawText);

  if (!response.ok) {
    throw mapUpstreamError(response.status, extractErrorMessage(payload) ?? rawText);
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

/** The instruction that keeps Gemini acting like an OCR engine, not a chatbot. */
function geminiInstructions(languageHints?: string[]): string {
  const lines = [
    "Transcribe all handwritten text in this image exactly as written.",
    "Keep the original spelling, punctuation, casing and line breaks — including mistakes.",
    "Do not translate, correct, summarize or explain anything, and never add commentary.",
    "Reply with the transcription only.",
    `If the image contains no readable text, reply with exactly ${NO_TEXT_SENTINEL} and nothing else.`,
  ];

  if (languageHints?.length) {
    lines.push(`The handwriting is expected to be in one of these languages: ${languageHints.join(", ")}.`);
  }

  return lines.join(" ");
}

/**
 * Gemini replies with an `interactions` envelope; the transcription lives in
 * the last `model_output` step (earlier steps may be internal "thoughts").
 */
function extractInteractionText(payload: InteractionResponse | null): string {
  const steps = payload?.steps ?? [];
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step?.type !== "model_output") {
      continue;
    }
    return (step.content ?? [])
      .filter((part): part is { type: string; text: string } => (
        part.type === "text" && typeof part.text === "string"
      ))
      .map((part) => part.text)
      .join("");
  }
  return "";
}

/** Models sometimes wrap their answer in a code fence; that fence isn't text on the page. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:\w+)?\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  return match?.[1] !== undefined ? match[1] : trimmed;
}

/** True when the model used the "nothing readable here" sentinel reply. */
function isNoTextReply(text: string): boolean {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return /^["'`]*NO_TEXT_DETECTED\b/i.test(firstLine);
}

function mapUpstreamError(status: number, detail: string): Error {
  if (/api key not valid|api_key_invalid/i.test(detail)) {
    return new InvalidCredentialsError(detail || undefined);
  }

  // A valid key on a project that isn't set up yet. These are the two most common
  // deployment mistakes, so they get their own actionable errors instead of a
  // generic upstream failure that reads like an outage.
  if (/billing/i.test(detail)) {
    return new BillingNotEnabledError(detail || undefined);
  }
  if (/has not been used in project|service_disabled|it is disabled/i.test(detail)) {
    return new ApiNotEnabledError(detail || undefined);
  }

  if (status === 400 || status === 401 || status === 403) {
    if (/permission denied|not authorized/i.test(detail)) {
      return new InvalidCredentialsError(detail || undefined);
    }
  }
  if (status === 429) {
    return new VisionRequestError("The OCR provider is rate limiting this project.", 429);
  }
  return new VisionRequestError(detail || `OCR request failed with HTTP ${status}`, status);
}

function extractErrorMessage(payload: unknown): string | undefined {
  const message = (payload as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === "string" ? message : undefined;
}

function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Base64 of the image bytes — the encoding both providers expect inline. */
function toBase64(image: Uint8Array): string {
  return Buffer.from(image).toString("base64");
}

/** Magic-byte sniffing, used only when the caller can't supply a MIME type. */
function detectMimeType(image: Uint8Array): string {
  if (matchesAt(image, 0, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (matchesAt(image, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (matchesAt(image, 0, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (matchesAt(image, 0, [0x52, 0x49, 0x46, 0x46]) && matchesAt(image, 8, [0x57, 0x45, 0x42, 0x50])) {
    return "image/webp";
  }
  // ISO base media files carry an "ftyp" box at offset 4; the brand names HEIC/HEIF.
  if (matchesAt(image, 4, [0x66, 0x74, 0x79, 0x70])) {
    const brand = asciiAt(image, 8, 4);
    if (/^(heic|heix|hevc|hevx)$/.test(brand)) return "image/heic";
    if (/^(mif1|msf1)$/.test(brand)) return "image/heif";
  }
  return "image/jpeg";
}

function matchesAt(bytes: Uint8Array, offset: number, signature: number[]): boolean {
  if (bytes.length < offset + signature.length) {
    return false;
  }
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let index = offset; index < offset + length && index < bytes.length; index += 1) {
    out += String.fromCharCode(bytes[index] ?? 0);
  }
  return out;
}
