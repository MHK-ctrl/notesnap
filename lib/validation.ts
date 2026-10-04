/**
 * File type + size validation, shared by the browser and the server.
 *
 * The client uses these checks for instant feedback; the API route re-runs them
 * because anything coming from a browser is untrusted.
 */

/** Hard limit for a single upload: 10 MB. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Image types we accept. This is a whitelist: `image/svg+xml` is deliberately
 * absent, and any type not listed here is rejected.
 */
export const ACCEPTED_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/gif",
  "image/bmp",
  "image/tiff",
] as const;

/** Fallback for browsers that report an empty MIME type (common for HEIC). */
const ACCEPTED_EXTENSION = /\.(jpe?g|png|webp|heic|heif|gif|bmp|tiff?)$/i;

export type ValidationErrorCode = "empty_file" | "unsupported_type" | "too_large";

export type ValidationResult =
  | { ok: true }
  | { ok: false; code: ValidationErrorCode; message: string };

/** The subset of a `File` these checks need, so tests don't need a real `File`. */
export interface FileLike {
  name?: string;
  type?: string;
  size: number;
}

/** "1234567" -> "1.2 MB". Used in user-facing messages. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

/** Human-readable list of supported formats, derived from the whitelist. */
export const SUPPORTED_FORMATS_LABEL = "JPEG, PNG, WebP, HEIC, GIF, BMP or TIFF";

/**
 * Validates an uploaded file. Returns a discriminated union so callers can map
 * the failure code to an HTTP status without parsing strings.
 */
export function validateImageFile(file: FileLike): ValidationResult {
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return {
      ok: false,
      code: "empty_file",
      message: "That file is empty. Pick a photo of your notes and try again.",
    };
  }

  if (file.size > MAX_FILE_BYTES) {
    return {
      ok: false,
      code: "too_large",
      message: `That photo is ${formatBytes(file.size)}. The limit is ${formatBytes(
        MAX_FILE_BYTES,
      )} — try a smaller photo or lower your camera resolution.`,
    };
  }

  const mimeType = (file.type ?? "").toLowerCase().trim();
  const name = file.name ?? "";
  const mimeAllowed =
    mimeType !== "" && (ACCEPTED_MIME_TYPES as readonly string[]).includes(mimeType);
  const extensionAllowed = ACCEPTED_EXTENSION.test(name);

  if (!mimeAllowed && !extensionAllowed) {
    return {
      ok: false,
      code: "unsupported_type",
      message: `Unsupported file type${
        mimeType ? ` (${mimeType})` : ""
      }. Please upload ${SUPPORTED_FORMATS_LABEL}.`,
    };
  }

  return { ok: true };
}
