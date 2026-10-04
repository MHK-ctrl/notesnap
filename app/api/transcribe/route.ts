/**
 * POST /api/transcribe — the only place the app touches Google Cloud Vision.
 *
 * The image arrives as multipart/form-data, is validated again here (the client
 * checks are for UX, not security), and is forwarded to Vision in memory. Nothing
 * is written to disk, cached or logged: process, respond, forget.
 *
 * The API key is read from `process.env` inside `lib/vision.ts` and never leaves
 * the server. This file must stay a server module.
 */

import { NextResponse } from "next/server";

import { checkRateLimit, getClientKey } from "@/lib/rate-limit";
import { MAX_FILE_BYTES, validateImageFile } from "@/lib/validation";
import {
  InvalidCredentialsError,
  MissingCredentialsError,
  NoTextDetectedError,
  transcribeImage,
  VisionRequestError,
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

  const rateLimit = checkRateLimit(getClientKey(request.headers));
  if (!rateLimit.ok) {
    return errorResponse(
      429,
      "rate_limited",
      `Too many transcriptions from this device. Try again in ${rateLimit.retryAfterSeconds}s.`,
      { "Retry-After": String(rateLimit.retryAfterSeconds) },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(
      400,
      "invalid_request",
      "We couldn't read that upload. Please try again.",
    );
  }

  const entry = form.get(IMAGE_FIELD);
  if (!isFileLike(entry)) {
    return errorResponse(
      400,
      "invalid_request",
      'No image was included in the request (expected a "image" form field).',
    );
  }

  const validation = validateImageFile({
    name: entry.name,
    type: entry.type,
    size: entry.size,
  });
  if (!validation.ok) {
    return errorResponse(validation.code === "too_large" ? 413 : 400, validation.code, validation.message);
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await entry.arrayBuffer());
  } catch {
    return errorResponse(400, "invalid_request", "We couldn't read that image. Please try again.");
  }

  if (bytes.byteLength === 0) {
    return errorResponse(400, "empty_file", "That file is empty. Pick a photo and try again.");
  }

  try {
    // Literal transcription only — no autocorrect, no rewriting.
    const { text } = await transcribeImage(bytes);
    return NextResponse.json({ text }, { headers: NO_STORE });
  } catch (error) {
    return mapError(error);
  }
}

function mapError(error: unknown): NextResponse {
  if (error instanceof MissingCredentialsError) {
    return errorResponse(
      500,
      "missing_credentials",
      "This NoteSnap instance has no Google Cloud Vision key configured. Deployers: set GOOGLE_VISION_API_KEY in your environment and redeploy.",
    );
  }

  if (error instanceof InvalidCredentialsError) {
    return errorResponse(
      500,
      "invalid_credentials",
      "Google Cloud Vision rejected the configured API key. Deployers: check that the key is valid and that the Cloud Vision API is enabled for its project.",
    );
  }

  if (error instanceof NoTextDetectedError) {
    return errorResponse(
      422,
      "no_text",
      "We couldn't find any handwriting in that photo. Try again with more light, less glare, and the page filling the frame.",
    );
  }

  if (error instanceof VisionRequestError) {
    console.error("[notesnap] vision request failed", {
      status: error.status,
      message: error.message,
    });
    return errorResponse(
      502,
      "ocr_failed",
      "The transcription service didn't answer correctly. Please try again in a moment.",
    );
  }

  console.error("[notesnap] unexpected transcription error", error);
  return errorResponse(
    500,
    "unexpected_error",
    "Something went wrong while transcribing. Please try again.",
  );
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

function errorResponse(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status, headers: { ...headers, ...NO_STORE } });
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
