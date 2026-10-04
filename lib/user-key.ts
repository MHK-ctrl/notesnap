/**
 * Bring-your-own-key handling — server-only.
 *
 * A visitor can paste their own Gemini key so their transcriptions are billed to
 * their own free-tier quota instead of the maintainer's. That is the only way to
 * keep a free public demo useful once its own daily quota is spent, without
 * creating extra Google projects to farm quota (which Google's APIs ToS forbids).
 *
 * What this module is careful about:
 *
 * - **The key is never persisted.** It is read from a request header, held in a
 *   local variable for the duration of that one request, and dropped. It is not
 *   written to Redis, not logged, and not returned in any response.
 * - **Errors are redacted.** Provider errors routinely echo request details back,
 *   so any error text is scrubbed of the key before it can reach a log or a
 *   client. {@link redactSecret} is applied on every error path in the route.
 * - **Shape is validated.** A header is attacker-controlled, so the value must
 *   look like a Google API key before it is used; otherwise we would forward
 *   arbitrary strings to Google.
 */

/** Header a visitor's own key is sent in. Prefixed to avoid colliding with anything else. */
export const USER_KEY_HEADER = "x-notesnap-user-key";

/**
 * Google API keys are `AIza` followed by 35 URL-safe base64 characters. Matching
 * that shape means a malformed or hostile header is rejected before it reaches
 * the provider.
 */
const GOOGLE_API_KEY_PATTERN = /^AIza[0-9A-Za-z_-]{35}$/;

/** Returned instead of the key when something must be reported. */
export const REDACTED = "[redacted]";

/** True when the value has the shape of a Google API key. */
export function isPlausibleApiKey(value: string): boolean {
  return GOOGLE_API_KEY_PATTERN.test(value.trim());
}

/**
 * Reads a visitor-supplied key from the request headers.
 *
 * Returns null when absent or malformed, so a bad header behaves like no header
 * at all rather than producing a confusing upstream error.
 */
export function readUserSuppliedKey(headers: Headers): string | null {
  const raw = headers.get(USER_KEY_HEADER);
  if (!raw) return null;

  const trimmed = raw.trim();
  if (!isPlausibleApiKey(trimmed)) {
    console.warn("[notesnap] ignoring a user-supplied key that is not a valid API key shape");
    return null;
  }

  return trimmed;
}

/**
 * Removes a secret from arbitrary text.
 *
 * Provider error bodies can echo request contents, and the route logs upstream
 * messages, so a key that reached an error message would otherwise be written to
 * logs. Every key-looking substring is replaced, not just an exact match, because
 * providers sometimes quote it with surrounding punctuation.
 */
export function redactSecret(text: string, secret: string | null | undefined): string {
  if (!text) return text;
  const value = secret?.trim();

  if (!value) {
    // No secret to match on: still scrub anything key-shaped, so an unknown key
    // leaking through some other path cannot reach a log.
    return text.replace(/AIza[0-9A-Za-z_-]{35}/g, REDACTED);
  }

  return text
    .split(value)
    .join(REDACTED)
    .replace(/AIza[0-9A-Za-z_-]{35}/g, REDACTED);
}