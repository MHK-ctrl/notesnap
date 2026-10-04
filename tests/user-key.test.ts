import { describe, expect, it } from "vitest";

import {
  isPlausibleApiKey,
  readUserSuppliedKey,
  redactSecret,
  REDACTED,
  USER_KEY_HEADER,
} from "@/lib/user-key";

/** Shaped like a real Google API key so it passes validation in tests. */
const VALID_KEY = `AIza${"a".repeat(35)}`;

function headersWith(value: string | null): Headers {
  const headers = new Headers();
  if (value !== null) headers.set(USER_KEY_HEADER, value);
  return headers;
}

describe("isPlausibleApiKey", () => {
  it("accepts the Google API key shape", () => {
    expect(isPlausibleApiKey(VALID_KEY)).toBe(true);
  });

  it("rejects keys of the wrong length", () => {
    expect(isPlausibleApiKey("AIzaShort")).toBe(false);
    expect(isPlausibleApiKey(`AIza${"a".repeat(40)}`)).toBe(false);
  });

  it("rejects values that are not Google keys at all", () => {
    expect(isPlausibleApiKey("Bearer sk-live-secret")).toBe(false);
    expect(isPlausibleApiKey("")).toBe(false);
    expect(isPlausibleApiKey("   ")).toBe(false);
  });
});

describe("readUserSuppliedKey", () => {
  it("returns a well-formed key from the header", () => {
    expect(readUserSuppliedKey(headersWith(VALID_KEY))).toBe(VALID_KEY);
  });

  it("tolerates surrounding whitespace from copy/paste", () => {
    expect(readUserSuppliedKey(headersWith(`  ${VALID_KEY}\n`))).toBe(VALID_KEY);
  });

  it("returns null when no header is present", () => {
    expect(readUserSuppliedKey(headersWith(null))).toBeNull();
  });

  it("ignores a malformed header instead of forwarding it", () => {
    // A header is attacker-controlled; forwarding arbitrary strings to Google
    // would be a needless way to turn this endpoint into a request relay.
    expect(readUserSuppliedKey(headersWith("not-a-key"))).toBeNull();
  });
});

describe("redactSecret", () => {
  it("removes a known secret wherever it appears", () => {
    const message = `Request failed for key ${VALID_KEY} (retrying with ${VALID_KEY})`;
    const result = redactSecret(message, VALID_KEY);

    expect(result).not.toContain(VALID_KEY);
    expect(result).toContain(REDACTED);
  });

  it("scrubs key-shaped strings even when the secret is unknown", () => {
    // Covers the case where some other path leaked a key this call never saw.
    const message = `provider echoed AIza${"b".repeat(35)} in its error`;
    const result = redactSecret(message, null);

    expect(result).not.toContain("b".repeat(35));
    expect(result).toContain(REDACTED);
  });

  it("leaves clean text untouched", () => {
    expect(redactSecret("service is busy", VALID_KEY)).toBe("service is busy");
  });

  it("handles an empty message", () => {
    expect(redactSecret("", VALID_KEY)).toBe("");
  });
});